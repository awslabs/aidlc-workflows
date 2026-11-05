// PreToolUse hook: deterministic enforcement of code-generation's
// plan-before-generation ordering (stage file Step 2-4).
//
// The stage prose says generation never begins before the human answers
// "Approve Plan": the conductor writes code-generation-plan.md, presents the
// Plan Approval question through code-generation-questions.md, and only an
// explicit approval authorizes the developer-agent dispatch. A field report
// showed prose losing that contest: a conductor generated the code first and
// backfilled the plan beside code-summary.md, making the plan an output
// instead of the input. The stage-completion artifact guard cannot catch
// this - it fires at completion time, when the backfilled plan already
// exists. Per the framework layering (determinism belongs in tools and
// hooks, knowledge in agents, judgement with humans), this hook is the
// ordering's deterministic twin.
//
// This is one of the framework's flow-altering hooks. Its contract is the
// harness-native PreToolUse block: print a reason to stderr and exit 2 to
// refuse the tool call, exit 0 to allow. The refusal is scoped tightly - one
// tool (the subagent dispatch), one target agent (aidlc-developer-agent),
// one stage (code-generation) - and the reason text redirects the conductor
// to the stage steps it skipped, so a blocked call is a recoverable nudge,
// not a halt.
//
// How the hook decides: Step 4 requires exact `AIDLC-UNIT` and
// `AIDLC-TESTING-CONTRACT` markers. The hook resolves the known units (compiled
// Bolt DAG plus on-disk construction dirs), then requires the target to have a
// non-empty plan and test instructions, a structured contract matching current
// memory/scope/strategy/type, an explicit "Approve Plan" answer, and a matching
// approval fingerprint over those exact bytes. Missing, conflicting, unknown,
// stale, and post-approval-modified evidence blocks instead of guessing.
//
// Fail-open outside the guarded dispatch: a missing or unreadable state file,
// an active directive/current stage other than code-generation, malformed
// stdin, an unknown tool, a non-developer subagent target, or any throw allows
// the call. Once a code-generation developer dispatch is identified, missing
// or ambiguous target evidence blocks. The deterministic off-switch
// AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1 disables enforcement entirely (the
// documented escape hatch for false-positive storms, mirroring the
// reviewer-scope guard's off-switch). Every genuine block emits a
// PLAN_APPROVAL_BLOCKED audit event so the run's record shows when the ordering
// bit; audit failures never change the decision.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  auditFilePath,
  type ClaudeCodeHookInput,
  docsRoot,
  errorMessage,
  getField,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  readActiveDirectiveMarker,
  recordHookDrop,
  releaseAuditLock,
  resolveBoltDag,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";
import {
  evaluateCodeGenerationApproval,
  promptTestingContractMarkers,
} from "../tools/aidlc-testing-posture.ts";

export {
  questionsFileApproved,
  questionsFileHasPendingPlanApproval,
} from "../tools/aidlc-testing-posture.ts";

const HOOK_NAME = "plan-approval-guard";

// The one stage this hook guards and the one dispatch target it inspects.
const GUARDED_STAGE = "code-generation";
const GUARDED_AGENT = "aidlc-developer-agent";

// The subagent-dispatch tool names across harness payload shapes. Claude Code
// delivers Task; the adapters translate their native dispatch tools (Kiro's
// subagent stages, opencode's task, Codex's spawn_agent) into this shape.
const DISPATCH_TOOLS = new Set(["Task", "Agent"]);

// --- The pure decision --------------------------------------------------------
//
// Everything below up to the main section is side-effect free and exported so
// the decision table is unit-testable without a live session. The hook body
// only wires stdin, the state file, and the exit code around it.

/** Per-unit evidence the main body gathers from disk. */
export interface UnitEvidence {
  /** Unit-of-work name, e.g. todo-core. */
  unit: string;
  /** construction/<unit>/code-generation/code-generation-plan.md exists and is non-empty. */
  planExists: boolean;
  /** unit-test-instructions.md exists and is non-empty. */
  instructionsExist: boolean;
  /** The unit's Plan Approval question records an explicit "Approve Plan" answer. */
  approved: boolean;
  /** The plan's structured Testing Contract matches the current effective posture. */
  contractValid: boolean;
  /** The recorded approval fingerprint matches the plan, instructions, and contract. */
  fingerprintValid: boolean;
  /** The current approved Testing Contract hash, used to bind the worker brief. */
  contractHash: string | null;
}

/** The decision's verdict. `mentioned` carries the explicit marker value(s). */
export interface PlanApprovalVerdict {
  block: boolean;
  mentioned: string[];
}

// Normalize a state-file stage value for comparison: the field usually holds
// the slug (code-generation) but a display-cased value (Code Generation) must
// compare equal rather than silently disable enforcement.
export function normalizeStageName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

const UNIT_MARKER_RE = /^[ \t]*AIDLC-UNIT[ \t]*:[ \t]*(.*?)[ \t]*$/;

/**
 * Return the distinct, non-empty target markers in encounter order. Repeated
 * copies of the same marker are harmless (some harnesses carry both task and
 * prompt-template text); different values are ambiguous and block.
 */
export function promptUnitMarkers(text: string): string[] {
  const units = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(UNIT_MARKER_RE);
    const unit = marker?.[1].trim() ?? "";
    if (unit.length > 0) units.add(unit);
  }
  return Array.from(units);
}

/**
 * The plan-approval dispatch decision. Pure: no I/O, no environment.
 *
 * Blocks when the dispatch targets the developer agent for code-generation
 * unless the prompt carries exactly one distinct `AIDLC-UNIT` marker, that
 * marker identifies a known unit, and that unit has approved plan evidence.
 */
export function evaluatePlanApprovalDispatch(
  toolName: string,
  subagentType: string,
  promptText: string,
  ctx: {
    currentStage: string;
    units: UnitEvidence[];
  },
): PlanApprovalVerdict {
  const allow: PlanApprovalVerdict = { block: false, mentioned: [] };
  if (!DISPATCH_TOOLS.has(toolName)) return allow;
  if (subagentType !== GUARDED_AGENT) return allow;
  if (normalizeStageName(ctx.currentStage) !== GUARDED_STAGE) return allow;

  const approved = (u: UnitEvidence) =>
    u.planExists &&
    u.instructionsExist &&
    u.approved &&
    u.contractValid &&
    u.fingerprintValid &&
    u.contractHash !== null;
  const marked = promptUnitMarkers(promptText);
  if (marked.length !== 1) return { block: true, mentioned: marked };
  const target = ctx.units.find((u) => u.unit === marked[0]);
  const contractMarkers = promptTestingContractMarkers(promptText);
  return {
    block:
      target === undefined ||
      !approved(target) ||
      contractMarkers.length !== 1 ||
      contractMarkers[0] !== target.contractHash,
    mentioned: marked,
  };
}

// The block reason handed back to the conductor through the harness's
// PreToolUse error channel. Self-explaining and redirecting: it names the
// missing evidence and the exact stage steps that produce it, so the
// conductor self-corrects instead of retrying the same call.
export function blockReason(mentioned: string[]): string {
  const scope =
    mentioned.length === 1
      ? `unit ${mentioned[0]}`
      : mentioned.length > 1
        ? `one unit (conflicting AIDLC-UNIT markers: ${mentioned.join(", ")})`
        : "one unit (AIDLC-UNIT marker missing)";
  return (
    `plan-approval guard: code-generation must not dispatch ${GUARDED_AGENT} before the ` +
    `plan, unit-test instructions, and current Testing Contract are fingerprinted and approved ` +
    `for ${scope}. Follow the stage file's Steps 2-3 first: write the plan and instructions, ` +
    `embed the resolver's ## Testing Contract JSON, record its current [Approval Fingerprint], ` +
    `present the Plan Approval question, END the turn, and record the human's explicit ` +
    `"Approve Plan" answer. Only then dispatch generation (Step 4), starting the delegation ` +
    `prompt with "AIDLC-UNIT: <unit>" and "AIDLC-TESTING-CONTRACT: <contract hash>". ` +
    `code-generation-plan.md is the INPUT to generation, never a retroactive summary.`
  );
}

// --- Evidence gathering ---------------------------------------------------------

// The workflow's known units: the compiled bolt DAG when one resolves, plus
// every existing construction/<unit>/ dir (incremental scopes skip
// units-generation, so a conductor-chosen unit dir is the only register
// there). A malformed DAG contributes nothing - the dir listing still stands.
export function knownUnits(projectDir: string, recordDir: string): string[] {
  const units = new Set<string>();
  try {
    const dag = resolveBoltDag(projectDir);
    if (dag.state === "ok") for (const u of dag.units) units.add(u);
  } catch {
    // DAG resolution is best-effort here.
  }
  try {
    const constructionDir = join(recordDir, "construction");
    if (existsSync(constructionDir)) {
      for (const entry of readdirSync(constructionDir, { withFileTypes: true })) {
        if (entry.isDirectory()) units.add(entry.name);
      }
    }
  } catch {
    // Unreadable construction dir - the DAG set (possibly empty) stands.
  }
  return Array.from(units);
}

export function gatherUnitEvidence(projectDir: string, units: string[]): UnitEvidence[] {
  return units.map((unit) => {
    const approval = evaluateCodeGenerationApproval(projectDir, unit);
    return {
      unit,
      planExists: approval.planExists,
      instructionsExist: approval.instructionsExist,
      approved: approval.approved,
      contractValid: approval.contractValid,
      fingerprintValid: approval.fingerprintValid,
      contractHash: approval.contractHash,
    };
  });
}

// --- Main ---------------------------------------------------------------------

export async function run(input: string): Promise<number> {
  // Deterministic off-switch: enforcement disabled entirely.
  if (process.env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD === "1") return 0;

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, `${HOOK_NAME}.last`), isoTimestamp(), "utf-8");
  } catch {
    // Heartbeat failure is non-fatal - never let it affect the decision.
  }

  // A TTY means no harness JSON is coming (test / debug contexts) - allow.
  if (process.stdin.isTTY) return 0;

  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(input);
    if (!isClaudeCodeHookInput(raw)) return 0;
    parsed = raw;
  } catch {
    return 0; // malformed stdin - fail open
  }

  const toolName = parsed.tool_name ?? "";
  if (!DISPATCH_TOOLS.has(toolName)) return 0;
  const toolInput = parsed.tool_input ?? {};
  const subagentType =
    typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : "";
  if (subagentType !== GUARDED_AGENT) return 0;

  let verdict: PlanApprovalVerdict;
  let units: UnitEvidence[] = [];
  try {
    const statePath = stateFilePath(projectDir);
    if (!existsSync(statePath)) return 0; // no workflow - fail open
    const state = readFileSync(statePath, "utf-8");
    const currentStage = getField(state, "Current Stage") ?? "";
    const activeStage = readActiveDirectiveMarker(projectDir, state)?.stage ?? currentStage;
    if (normalizeStageName(activeStage) !== GUARDED_STAGE) return 0;

    const recordDir = docsRoot(projectDir);
    units = gatherUnitEvidence(projectDir, knownUnits(projectDir, recordDir));
    const promptText = [toolInput.prompt, toolInput.description]
      .filter((v): v is string => typeof v === "string")
      .join("\n");
    verdict = evaluatePlanApprovalDispatch(toolName, subagentType, promptText, {
      currentStage: activeStage,
      units,
    });
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    return 0; // evidence gathering failed - fail open
  }
  if (!verdict.block) return 0;

  // Audit the refusal so the run's record shows when the ordering bit.
  // Best-effort: an audit failure never changes the block decision. The lock
  // acquisition is TIME-BOUNDED well below the standard 5s budget (5 x 50ms):
  // the block decision is already made, and a dropped advisory row is
  // preferable to a slow block.
  try {
    if (existsSync(auditFilePath(projectDir))) {
      if (acquireAuditLock(projectDir, 5, 50)) {
        try {
          appendAuditEntryUnlocked(
            "PLAN_APPROVAL_BLOCKED",
            {
              Tool: toolName,
              Target: subagentType,
              Stage: GUARDED_STAGE,
              Unit: verdict.mentioned.join(", ") || "(missing marker)",
            },
            projectDir,
          );
        } finally {
          releaseAuditLock(projectDir);
        }
      } else {
        recordHookDrop(
          projectDir,
          HOOK_NAME,
          "audit lock contended; PLAN_APPROVAL_BLOCKED row dropped (block still enforced)",
        );
      }
    }
  } catch {
    // Advisory emission only.
  }

  process.stderr.write(`${blockReason(verdict.mentioned)}\n`);
  return 2; // harness PreToolUse reject contract: exit 2 + stderr blocks
}

if (import.meta.main) {
  const input = process.stdin.isTTY ? "" : await Bun.stdin.text();
  process.exit(await run(input));
}
