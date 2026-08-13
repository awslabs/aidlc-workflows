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
// How the hook decides: Step 4 requires the delegation prompt to carry one
// explicit `AIDLC-UNIT: <unit>` marker sourced from `directive.unit`. The hook
// resolves the workflow's known units (the compiled bolt DAG when one exists,
// plus the on-disk construction/<unit>/ dirs - incremental scopes skip
// units-generation, so the dirs are the only unit register there), resolves
// that exact marker, and requires the targeted unit to have BOTH a non-empty
// plan on disk AND an explicit "Approve Plan" answer on its Plan Approval
// question. Missing, conflicting, and unknown markers block instead of
// guessing from arbitrary prompt prose. Other answered questions and a
// "Request Changes" answer never count as approval.
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
  /** The unit's Plan Approval question records an explicit "Approve Plan" answer. */
  approved: boolean;
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

const MARKDOWN_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const ANSWER_TAG_RE = /^\[Answer\]:[ \t]*(.*)$/;
const APPROVE_PLAN_RE = /^(?:[A-Z][.)][ \t]*)?["']?Approve Plan["']?$/i;
const QUESTION_PREFIX_RE = /^(?:(?:q(?:uestion)?[ \t]*)?\d+[ \t]*[:.)-][ \t]*)/i;
const NUMBERED_QUESTION_HEADING_RE = /^(?:q(?:uestion)?[ \t]*)?\d+[ \t]*[.:)-]?[ \t]*$/i;
const UNIT_MARKER_RE = /^[ \t]*AIDLC-UNIT[ \t]*:[ \t]*(.*?)[ \t]*$/;

function isPlanApprovalLabel(value: string): boolean {
  let normalized = value.trim().replace(/[?:][ \t]*$/, "").trim();
  for (const marker of ["**", "__", "*", "_"]) {
    if (
      normalized.startsWith(marker) &&
      normalized.endsWith(marker) &&
      normalized.length > marker.length * 2
    ) {
      normalized = normalized.slice(marker.length, -marker.length).trim();
      break;
    }
  }
  return normalized.toLowerCase() === "plan approval";
}

// Approval evidence inside examples or scaffolding is not authoritative.
// Preserve visible line boundaries while removing fenced code and HTML
// comments so the section parser below cannot mistake either for a real
// persisted question.
function visibleMarkdownLines(body: string): string[] {
  const lines = body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const visible: string[] = [];
  let inComment = false;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const rawLine of lines) {
    if (fence) {
      const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(rawLine);
      if (
        closing &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      visible.push("");
      continue;
    }

    let line = "";
    let cursor = 0;
    while (cursor < rawLine.length) {
      if (inComment) {
        const end = rawLine.indexOf("-->", cursor);
        if (end < 0) {
          cursor = rawLine.length;
          break;
        }
        inComment = false;
        cursor = end + 3;
        continue;
      }

      const start = rawLine.indexOf("<!--", cursor);
      if (start < 0) {
        line += rawLine.slice(cursor);
        break;
      }
      line += rawLine.slice(cursor, start);
      inComment = true;
      cursor = start + 4;
    }

    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = {
        marker: opening[1][0] as "`" | "~",
        length: opening[1].length,
      };
      visible.push("");
      continue;
    }
    visible.push(line);
  }

  return visible;
}

// Resolve the latest visible Markdown section identified as "Plan Approval".
// The identifier may be in the heading (`Q1: Plan Approval`) or the first
// content line under a conventional numbered heading (`## Q1` followed by
// `Plan Approval`). Examples inside comments or code fences are already removed.
function latestPlanApprovalAnswer(body: string): {
  found: boolean;
  answer: string | null;
} {
  let inPlanApproval = false;
  let awaitingNumberedQuestionText = false;
  let foundPlanApproval = false;
  let latestAnswer: string | null = null;

  for (const line of visibleMarkdownLines(body)) {
    const heading = line.match(MARKDOWN_HEADING_RE);
    if (heading) {
      const headingText = heading[2].trim();
      inPlanApproval = isPlanApprovalLabel(headingText.replace(QUESTION_PREFIX_RE, ""));
      awaitingNumberedQuestionText =
        !inPlanApproval && NUMBERED_QUESTION_HEADING_RE.test(headingText);
      if (inPlanApproval) {
        foundPlanApproval = true;
        latestAnswer = null;
      }
      continue;
    }
    if (awaitingNumberedQuestionText && line.trim().length > 0) {
      awaitingNumberedQuestionText = false;
      inPlanApproval = isPlanApprovalLabel(line);
      if (inPlanApproval) {
        foundPlanApproval = true;
        latestAnswer = null;
      }
    }
    if (!inPlanApproval) continue;
    const answer = line.match(ANSWER_TAG_RE);
    if (answer) latestAnswer = answer[1].trim();
  }

  return { found: foundPlanApproval, answer: latestAnswer };
}

export function questionsFileApproved(body: string): boolean {
  const latest = latestPlanApprovalAnswer(body);
  return latest.found && latest.answer !== null && APPROVE_PLAN_RE.test(latest.answer);
}

/** True only when the latest visible Plan Approval section has a blank answer tag. */
export function questionsFileHasPendingPlanApproval(body: string): boolean {
  const latest = latestPlanApprovalAnswer(body);
  return latest.found && latest.answer !== null && /^_*$/.test(latest.answer);
}

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

  const approved = (u: UnitEvidence) => u.planExists && u.approved;
  const marked = promptUnitMarkers(promptText);
  if (marked.length !== 1) return { block: true, mentioned: marked };
  const target = ctx.units.find((u) => u.unit === marked[0]);
  return { block: target === undefined || !approved(target), mentioned: marked };
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
    `plan is written and approved for ${scope}. Follow the stage file's Steps 2-3 first: ` +
    `write <record>/construction/<unit>/code-generation/code-generation-plan.md, create ` +
    `code-generation-questions.md with a Plan Approval question and a blank [Answer]: tag, ` +
    `present that question, END the turn, and record the human's explicit "Approve Plan" ` +
    `answer in the tag. Only then dispatch generation (Step 4), starting the delegation ` +
    `prompt with the exact line "AIDLC-UNIT: <unit>". ` +
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

export function gatherUnitEvidence(recordDir: string, units: string[]): UnitEvidence[] {
  return units.map((unit) => {
    const stageDirPath = join(recordDir, "construction", unit, GUARDED_STAGE);
    let planExists = false;
    let approved = false;
    try {
      const planPath = join(stageDirPath, "code-generation-plan.md");
      if (existsSync(planPath)) {
        planExists = readFileSync(planPath, "utf-8").trim().length > 0;
      }
      const questionsPath = join(stageDirPath, "code-generation-questions.md");
      if (existsSync(questionsPath)) {
        approved = questionsFileApproved(readFileSync(questionsPath, "utf-8"));
      }
    } catch {
      // Unreadable evidence counts as missing for this unit.
    }
    return { unit, planExists, approved };
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
    units = gatherUnitEvidence(recordDir, knownUnits(projectDir, recordDir));
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
