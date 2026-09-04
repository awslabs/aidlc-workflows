// PreToolUse hook: deterministic enforcement of code-generation's
// plan-before-generation ordering (stage file Step 2-4) and of who authors
// the plan.
//
// The stage prose says generation never begins before the human answers
// "Approve Plan": the developer agent, dispatched for PLANNING, writes
// code-generation-plan.md and unit-test-instructions.md; the conductor
// presents the Plan Approval question through code-generation-questions.md;
// and only an explicit approval authorizes the developer-agent GENERATION
// dispatch. A field report showed prose losing that contest: a conductor
// generated the code first and backfilled the plan beside code-summary.md,
// making the plan an output instead of the input. The stage-completion
// artifact guard cannot catch this - it fires at completion time, when the
// backfilled plan already exists. Per the framework layering (determinism
// belongs in tools and hooks, knowledge in agents, judgement with humans),
// this hook is the ordering's deterministic twin.
//
// This is one of the framework's flow-altering hooks. Its contract is the
// harness-native PreToolUse block: print a reason to stderr and exit 2 to
// refuse the tool call, exit 0 to allow. The refusal is scoped tightly to
// code-generation: developer-agent generation dispatch and workspace mutation
// are both blocked until the same approval evidence is current. Writes inside
// the selected code-generation record dir remain available to create the
// questions file and diary that make approval possible.
//
// How the hook decides: the active directive is the approval authority. A
// directive with `unit` selects construction/<unit>/code-generation; a
// zero-Unit directive selects construction/code-generation. Step 4 dispatches
// carry that choice explicitly as `AIDLC-UNIT: <unit>` or
// `AIDLC-STAGE: code-generation`, plus the exact `AIDLC-TESTING-CONTRACT`
// marker. The selected target must have a non-empty plan and test instructions,
// a structured contract matching current memory/scope/strategy/type, an
// explicit "Approve Plan" answer, and a matching approval fingerprint over
// those exact bytes. Missing, conflicting, unknown, stale, and
// post-approval-modified evidence blocks instead of guessing.
//
// Two authorship rules sit beside the ordering rule:
//
// - A PLANNING dispatch (`AIDLC-PLANNING: <unit>`, or the stage-level form
//   `AIDLC-PLANNING: code-generation`, and no generation marker) is admitted
//   without approval evidence when it names a target the active directive
//   planned (its `unit`, or one of an `invoke-swarm` batch's `units`). It
//   never starts generation. Its admission writes the planning dispatch
//   record (`<record>/.aidlc-planning-dispatch.json`; the SubagentStop hook
//   removes it when the session's developer dispatch returns, and a record
//   older than PLANNING_DISPATCH_TTL_MS is an orphan). One planning dispatch
//   is live at a time: a second is refused until the first returns. While the
//   record is fresh, every mutation is confined to the ONE planned target's
//   code-generation record dir, so the planning worker can write the plan,
//   the instructions, and the diary and nothing in the workspace or in a
//   sibling target.
// - Once an `[Approval Fingerprint]` tag exists for a target, or while that
//   target's planning dispatch is live, writes to its code-generation-plan.md
//   and unit-test-instructions.md are refused unless the payload's
//   `agent_type` is the developer agent: main-session writes (no `agent_type`;
//   the conductor) and other agents' writes are refused. The conductor presents
//   and records the approval but does not author or revise what the human
//   approves; the developer agent's dispatched writes remain allowed (they ARE
//   the planning and its revision). A payload that declares
//   `agent_identity_unavailable: true` (Kiro IDE, whose payloads carry no
//   agent identity) cannot be judged and skips this refusal; the stage prose
//   carries the rule there.
//
// Fail-open outside code-generation: a missing or unreadable state file, an
// active directive/current stage other than code-generation, malformed stdin,
// an unknown/read-only tool, a non-developer subagent target, or any throw
// allows the call. Once a code-generation generation path is identified,
// missing or ambiguous target evidence blocks. The deterministic off-switch
// AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1 disables enforcement entirely (the
// documented escape hatch for false-positive storms, mirroring the
// reviewer-scope guard's off-switch). Every genuine block emits a
// PLAN_APPROVAL_BLOCKED audit event so the run's record shows when the ordering
// bit; audit failures never change the decision.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  admitPlanningDispatch,
  assertNoSymlinkInChainOrThrow,
  auditFilePath,
  type ClaudeCodeHookInput,
  docsRoot,
  errorMessage,
  getField,
  harnessDir,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  planningDispatchPath,
  type PlanningTarget,
  readActiveDirectiveMarker,
  readPlanningDispatchWindow,
  recordHookDrop,
  releaseAuditLock,
  resolveBoltDag,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";
import {
  beginCodeGeneration,
  codeGenerationRecordDir,
  type CodeGenerationTarget,
  evaluateCodeGenerationApproval,
  PlanApprovalSourceDriftError,
  planReviewAppendix,
  promptTestingContractMarkers,
  questionsFileApprovalFingerprint,
} from "../tools/aidlc-testing-posture.ts";

export {
  questionsFileApproved,
  questionsFileHasPendingPlanApproval,
} from "../tools/aidlc-testing-posture.ts";

const HOOK_NAME = "plan-approval-guard";

// The one stage this hook guards and the one dispatch target it inspects.
const GUARDED_STAGE = "code-generation";
const GUARDED_AGENT = "aidlc-developer-agent";
const STAGE_TARGET = "stage-level";
// The two files the developer agent authors and the human approves. Once a
// target's questions file records an Approval Fingerprint, or while a planning
// dispatch for it is live, a main-session write to either is refused.
const PLAN_AUTHORED_FILES = new Set(["code-generation-plan.md", "unit-test-instructions.md"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SAFE_READ_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "TaskOutput",
  "AskUserQuestion",
  "fs_read",
  "file_search",
  "grep_search",
  "thinking",
]);
const READ_ONLY_SHELL_COMMANDS = new Set([
  "[",
  "basename",
  "cat",
  "cmp",
  "cut",
  "diff",
  "dirname",
  "echo",
  "file",
  "grep",
  "head",
  "ls",
  "more",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sort",
  "stat",
  "tail",
  "test",
  "tr",
  "type",
  "uniq",
  "wc",
  "where",
  "which",
]);
const TRACKED_SHELL_MUTATORS = new Set([
  "cp",
  "dd",
  "install",
  "mv",
  "perl",
  "rm",
  "sed",
  "tee",
  "touch",
  "truncate",
  "unlink",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

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
  /** Unit-of-work name, or null for construction/code-generation stage-level work. */
  unit: string | null;
  /** The selected record dir's code-generation-plan.md exists and is non-empty. */
  planExists: boolean;
  /** unit-test-instructions.md exists and is non-empty. */
  instructionsExist: boolean;
  /** The unit's Plan Approval question records an explicit "Approve Plan" answer. */
  approved: boolean;
  /** The plan's structured Testing Contract matches the current effective posture. */
  contractValid: boolean;
  /** The recorded approval fingerprint matches the plan, instructions, and contract. */
  fingerprintValid: boolean;
  receiptValid: boolean;
  /** The current approved Testing Contract hash, used to bind the worker brief. */
  contractHash: string | null;
  /**
   * The evaluator's own sentence when the receipt is not valid. It names what
   * retired the approval (a moved workspace source, an ended stage attempt, a
   * changed plan) so the block text can carry the remedy instead of the generic
   * "present Plan Approval" steps alone.
   */
  reason?: string;
  /**
   * The plan's terminal `## Review` appendix, when a review recorded under the
   * earlier protocol left one. The fingerprint deliberately excludes it, so it
   * was never approved as work and must not appear in a developer handoff.
   */
  reviewAppendix?: string;
}

/** The decision's verdict. `mentioned` carries the explicit marker value(s). */
export interface PlanApprovalVerdict {
  block: boolean;
  mentioned: string[];
  /** The handoff carried the plan's review appendix, bytes the approval excludes. */
  appendixInBrief?: boolean;
  /**
   * The dispatch is a PLANNING dispatch (it carries an `AIDLC-PLANNING`
   * marker). When admitted it consulted no approval evidence and must not
   * start generation; `mentioned` names its one target.
   */
  planning?: boolean;
  /** The brief mixed a planning marker with generation markers. */
  mixedMarkers?: boolean;
}

function approvalEvidenceIsCurrent(evidence: UnitEvidence | undefined): boolean {
  return (
    evidence?.planExists === true &&
    evidence.instructionsExist &&
    evidence.approved &&
    evidence.contractValid &&
    evidence.fingerprintValid &&
    evidence.receiptValid &&
    evidence.contractHash !== null
  );
}

// Normalize a state-file stage value for comparison: the field usually holds
// the slug (code-generation) but a display-cased value (Code Generation) must
// compare equal rather than silently disable enforcement.
export function normalizeStageName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

const UNIT_MARKER_RE = /^[ \t]*AIDLC-UNIT[ \t]*:[ \t]*(.*?)[ \t]*$/;
const STAGE_MARKER_RE = /^[ \t]*AIDLC-STAGE[ \t]*:[ \t]*(.*?)[ \t]*$/;
const PLANNING_MARKER_RE = /^[ \t]*AIDLC-PLANNING[ \t]*:[ \t]*(.*?)[ \t]*$/;

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

export function promptStageMarkers(text: string): string[] {
  const stages = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(STAGE_MARKER_RE);
    const stage = marker?.[1].trim() ?? "";
    if (stage.length > 0) stages.add(normalizeStageName(stage));
  }
  return Array.from(stages);
}

/**
 * Return the distinct, non-empty planning markers in encounter order, in the
 * `mentioned` spelling: a Unit name as written, and the stage-level form
 * (`AIDLC-PLANNING: code-generation`) as `stage:code-generation`.
 */
export function promptPlanningMarkers(text: string): string[] {
  const targets = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(PLANNING_MARKER_RE);
    const value = marker?.[1].trim() ?? "";
    if (value.length === 0) continue;
    targets.add(
      normalizeStageName(value) === GUARDED_STAGE ? `stage:${GUARDED_STAGE}` : value,
    );
  }
  return Array.from(targets);
}

/** The `mentioned` spelling of a planning target, and back. */
export function mentionedTarget(target: PlanningTarget): string {
  return target === null ? `stage:${GUARDED_STAGE}` : target;
}

export function planningTargetOf(mentioned: string): PlanningTarget {
  return mentioned === `stage:${GUARDED_STAGE}` ? null : mentioned;
}

/**
 * The plan-approval dispatch decision. Pure: no I/O, no environment.
 *
 * A PLANNING dispatch (one `AIDLC-PLANNING` marker, no generation marker) is
 * admitted without approval evidence when its target is one the active
 * directive planned (`ctx.planningTargets`); it blocks when the marker is
 * ambiguous, names an unplanned target, or is mixed with generation markers.
 *
 * Every other developer dispatch for code-generation blocks unless the prompt
 * carries exactly one target marker (`AIDLC-UNIT` or the stage-level
 * `AIDLC-STAGE: code-generation`), that marker identifies a known approval
 * target, and that target has approved plan evidence.
 */
export function evaluatePlanApprovalDispatch(
  toolName: string,
  subagentType: string,
  promptText: string,
  ctx: {
    currentStage: string;
    units: UnitEvidence[];
    /** Targets the active directive planned; absent means no planning dispatch is admissible. */
    planningTargets?: PlanningTarget[];
  },
): PlanApprovalVerdict {
  const allow: PlanApprovalVerdict = { block: false, mentioned: [] };
  if (!DISPATCH_TOOLS.has(toolName)) return allow;
  if (subagentType !== GUARDED_AGENT) return allow;
  if (normalizeStageName(ctx.currentStage) !== GUARDED_STAGE) return allow;

  const markedUnits = promptUnitMarkers(promptText);
  const markedStages = promptStageMarkers(promptText);
  const mentioned = [
    ...markedUnits,
    ...markedStages.map((stage) => `stage:${stage}`),
  ];
  const planningMarkers = promptPlanningMarkers(promptText);
  if (planningMarkers.length > 0) {
    const generationMarkers =
      mentioned.length + promptTestingContractMarkers(promptText).length;
    if (generationMarkers > 0) {
      return {
        block: true,
        mentioned: [...planningMarkers, ...mentioned],
        planning: true,
        mixedMarkers: true,
      };
    }
    if (planningMarkers.length !== 1) {
      return { block: true, mentioned: planningMarkers, planning: true };
    }
    const target = planningTargetOf(planningMarkers[0]);
    const planned = (ctx.planningTargets ?? []).some((candidate) => candidate === target);
    return { block: !planned, mentioned: planningMarkers, planning: true };
  }
  if (markedUnits.length + markedStages.length !== 1) {
    return { block: true, mentioned };
  }
  const target =
    markedUnits.length === 1
      ? ctx.units.find((u) => u.unit === markedUnits[0])
      : markedStages[0] === GUARDED_STAGE
        ? ctx.units.find((u) => u.unit === null)
        : undefined;
  const contractMarkers = promptTestingContractMarkers(promptText);
  // The approval excludes a terminal review appendix from the plan, so a brief
  // that carries those bytes hands the developer work nobody approved. The
  // `brief` command produces the body-only handoff; a prompt that quotes the
  // appendix is refused whether the approval is otherwise current or not.
  const appendixInBrief =
    target !== undefined && promptCarriesReviewAppendix(promptText, target.reviewAppendix);
  return {
    block:
      target === undefined ||
      !approvalEvidenceIsCurrent(target) ||
      contractMarkers.length !== 1 ||
      contractMarkers[0] !== target.contractHash ||
      appendixInBrief,
    mentioned,
    ...(appendixInBrief ? { appendixInBrief: true } : {}),
  };
}

/** Whitespace-insensitive containment of a non-trivial appendix in the prompt. */
function promptCarriesReviewAppendix(
  promptText: string,
  appendix: string | undefined,
): boolean {
  if (!appendix) return false;
  const fold = (text: string): string => text.replace(/\s+/g, " ").trim();
  // The heading alone is not evidence: a brief may legitimately mention that a
  // review exists. The appendix's content lines are.
  const content = fold(appendix.replace(/^\s*##[ \t]*Review\b[^\n]*/i, ""));
  if (content.length === 0) return false;
  return fold(promptText).includes(content);
}

export function appendixBlockReason(mentioned: string[]): string {
  const scope =
    mentioned[0] === `stage:${GUARDED_STAGE}`
      ? "the zero-Unit stage-level implementation"
      : `unit ${mentioned[0]}`;
  return (
    `Code generation cannot start for ${scope} because the developer handoff carries the ` +
    "plan's terminal `## Review` appendix. That appendix is excluded from the approval " +
    "fingerprint, so nobody approved it as work. Hand the developer the plan BODY and the " +
    "unit-test instructions only: run `aidlc-testing-posture.ts brief` for this target and " +
    "pass its output verbatim, then retry the handoff."
  );
}

// The block reason handed back to the conductor through the harness's
// PreToolUse error channel. Self-explaining and redirecting: it names the
// missing evidence and the exact stage steps that produce it, so the
// conductor self-corrects instead of retrying the same call.
export function blockReason(mentioned: string[], detail: string | null = null): string {
  const scope =
    mentioned.length === 1
      ? mentioned[0] === `stage:${GUARDED_STAGE}`
        ? "the zero-Unit stage-level implementation"
        : `unit ${mentioned[0]}`
      : mentioned.length > 1
        ? `one target, but the brief names several (${mentioned.join(", ")})`
        : "one target, but the brief does not name it";
  return (
    `Code generation cannot start for ${scope} because its plan and test instructions are ` +
    `not currently approved.${detail ? ` Reason: ${detail}.` : ""} Finish Steps 2-3 in code-generation: dispatch the ` +
    `developer agent for planning ("AIDLC-PLANNING: <unit>" or "AIDLC-PLANNING: code-generation") so ` +
    `code-generation-plan.md and unit-test-instructions.md are current, refresh the Testing Contract and ` +
    `approval fingerprint, present Plan Approval, end the turn, and wait for the human's ` +
    `"Approve Plan" answer. Then retry the developer handoff with ` +
    `"AIDLC-UNIT: <unit>" or "AIDLC-STAGE: code-generation", followed by ` +
    `"AIDLC-TESTING-CONTRACT: <contract hash>".`
  );
}

/**
 * Why a planning dispatch was refused: mixed markers, an ambiguous marker, or
 * a target the active directive did not plan.
 */
export function planningBlockReason(
  verdict: PlanApprovalVerdict,
  planningTargets: PlanningTarget[],
): string {
  if (verdict.mixedMarkers) {
    return (
      "A planning dispatch cannot carry generation markers. The brief mixes " +
      `"AIDLC-PLANNING" with "AIDLC-UNIT", "AIDLC-STAGE", or "AIDLC-TESTING-CONTRACT" ` +
      `(${verdict.mentioned.join(", ")}). For planning, hand the developer agent ` +
      `"AIDLC-PLANNING: <unit>" (or "AIDLC-PLANNING: code-generation" for zero-Unit work) and ` +
      "nothing from the approved-generation brief. For generation, after the human's " +
      "\"Approve Plan\" answer, pass the `aidlc-testing-posture.ts brief` output verbatim instead."
    );
  }
  if (verdict.mentioned.length !== 1) {
    return (
      "Planning cannot start because the brief names " +
      `${verdict.mentioned.length === 0 ? "no planning target" : `several planning targets (${verdict.mentioned.join(", ")})`}. ` +
      `Carry exactly one "AIDLC-PLANNING: <unit>" line (or "AIDLC-PLANNING: code-generation").`
    );
  }
  const planned = planningTargets.map(mentionedTarget);
  return (
    `Planning cannot start for ${describeMentioned(verdict.mentioned[0])} because the active ` +
    `directive does not plan that target${planned.length > 0 ? ` (it plans ${planned.join(", ")})` : ""}. ` +
    "Plan the target the directive named, or run a fresh `aidlc-orchestrate.ts next` and use that exact directive."
  );
}

function describeMentioned(mentioned: string): string {
  return mentioned === `stage:${GUARDED_STAGE}`
    ? "the zero-Unit stage-level implementation"
    : `unit ${mentioned}`;
}

/** A second planning dispatch while one is live. */
export function planningBusyReason(liveTarget: PlanningTarget, recordPath: string): string {
  return (
    `Planning cannot start because a planning dispatch for ${describeMentioned(mentionedTarget(liveTarget))} ` +
    "is still running: one planning dispatch runs at a time so each plan has one author. Wait for it " +
    `to return, then dispatch the next target. (If no planning dispatch is running, the record at ` +
    `${recordPath} is an orphan; it expires on its own, or delete it.)`
  );
}

/** A mutation outside the planned target's record dir while planning is live. */
export function planningConfinementReason(
  target: string,
  liveTarget: PlanningTarget,
  opaqueShell: boolean,
  recordDir: string,
): string {
  const action = opaqueShell
    ? `run mutation-capable ${target}`
    : `modify "${target}"`;
  return (
    `Planning for ${describeMentioned(mentionedTarget(liveTarget))} cannot ${action}: while the ` +
    "developer agent plans, writes are confined to that target's code-generation record " +
    `directory (${recordDir}) for code-generation-plan.md, unit-test-instructions.md, and ` +
    "memory.md. Application code, sibling targets, and other files wait for the human's " +
    "\"Approve Plan\" answer and the generation dispatch. Return an open question to the " +
    "conductor instead of working around this."
  );
}

/** A main-session write to the plan or instructions once the plan has an author. */
export function planAuthorshipReason(
  target: string,
  unit: string | null,
  reason: "fingerprinted" | "planning-live",
): string {
  const scope = unit === null ? "the zero-Unit stage-level implementation" : `unit ${unit}`;
  const why =
    reason === "fingerprinted"
      ? "an Approval Fingerprint has been recorded for it"
      : "the developer agent's planning dispatch for it is still running";
  return (
    `The conductor cannot edit "${target}" for ${scope} because ${why}. ` +
    "The developer agent authors and revises code-generation-plan.md and " +
    "unit-test-instructions.md: to change either, dispatch aidlc-developer-agent with " +
    `"AIDLC-PLANNING: <unit>" (or "AIDLC-PLANNING: code-generation") and the human's feedback, ` +
    "then refresh the fingerprint and re-present Plan Approval. The questions file, the " +
    "fingerprint tags, the answer, and the diary remain yours."
  );
}

/**
 * The evaluator's reason for the first mentioned target whose receipt is not
 * valid, or null when every mentioned target is approved or unknown.
 */
export function receiptDetail(
  evidence: UnitEvidence[],
  mentioned: string[],
): string | null {
  for (const name of mentioned) {
    const unit = name === `stage:${GUARDED_STAGE}` ? null : name;
    const match = evidence.find((entry) => entry.unit === unit);
    if (match && !match.receiptValid && match.reason) return match.reason;
  }
  return null;
}

export function mutationBlockReason(
  target: string,
  unit: string | null,
  opaqueShell = false,
  detail: string | null = null,
): string {
  const scope = unit === null ? "the zero-Unit stage-level implementation" : `unit ${unit}`;
  const action = opaqueShell
    ? `run mutation-capable ${target}`
    : `modify workspace path "${target}"`;
  return (
    `Code generation cannot ${action} for ${scope} because ` +
    `the plan, unit-test instructions, and current Testing Contract are fingerprinted and ` +
    `approved.${detail ? ` Reason: ${detail}.` : ""} Writes inside the selected code-generation record directory remain ` +
    `available for Steps 2-3. Record the human's explicit "Approve Plan" answer before beginning ` +
    `Step 4 generation.`
  );
}

function authorityBlockReason(reason: string): string {
  return (
    "Code generation cannot start because its Plan Approval authority is ambiguous or stale. " +
    `${reason}. Run a fresh \`aidlc-orchestrate.ts next\` and use that exact directive; ` +
    "no stage-level fallback is permitted."
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
        if (entry.isDirectory() && entry.name !== GUARDED_STAGE) units.add(entry.name);
      }
    }
  } catch {
    // Unreadable construction dir - the DAG set (possibly empty) stands.
  }
  return Array.from(units);
}

/** The plan's terminal review appendix for a target, or undefined when it has none. */
function planAppendixFor(projectDir: string, unit: string | null): string | undefined {
  try {
    const plan = readFileSync(
      join(codeGenerationRecordDir(projectDir, unit), "code-generation-plan.md"),
      "utf-8",
    );
    const appendix = planReviewAppendix(plan);
    return appendix.trim().length > 0 ? appendix : undefined;
  } catch {
    return undefined;
  }
}

export function gatherUnitEvidence(projectDir: string, units: string[]): UnitEvidence[] {
  return units.map((unit) => {
    const approval = evaluateCodeGenerationApproval(projectDir, { unit });
    const reviewAppendix = planAppendixFor(projectDir, unit);
    return {
      unit,
      planExists: approval.planExists,
      instructionsExist: approval.instructionsExist,
      approved: approval.approved,
      contractValid: approval.contractValid,
      fingerprintValid: approval.fingerprintValid,
      receiptValid: approval.receiptValid,
      contractHash: approval.contractHash,
      ...(approval.ok ? {} : { reason: approval.reason }),
      ...(reviewAppendix === undefined ? {} : { reviewAppendix }),
    };
  });
}

export function gatherApprovalEvidence(projectDir: string, units: string[]): UnitEvidence[] {
  const stageApproval = evaluateCodeGenerationApproval(projectDir, { unit: null });
  const reviewAppendix = planAppendixFor(projectDir, null);
  return [
    {
      unit: null,
      planExists: stageApproval.planExists,
      instructionsExist: stageApproval.instructionsExist,
      approved: stageApproval.approved,
      contractValid: stageApproval.contractValid,
      fingerprintValid: stageApproval.fingerprintValid,
      receiptValid: stageApproval.receiptValid,
      contractHash: stageApproval.contractHash,
      ...(stageApproval.ok ? {} : { reason: stageApproval.reason }),
      ...(reviewAppendix === undefined ? {} : { reviewAppendix }),
    },
    ...gatherUnitEvidence(projectDir, units),
  ];
}

function isWithinDir(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isTrustedRecordTarget(
  projectDir: string,
  target: string,
  recordDir: string,
): boolean {
  try {
    const projectLexical = resolve(projectDir);
    const projectReal = realpathSync(projectLexical);
    const targetAbs = resolve(target);
    const recordAbs = resolve(recordDir);
    assertNoSymlinkInChainOrThrow(
      projectReal,
      relative(projectLexical, recordAbs),
    );
    assertNoSymlinkInChainOrThrow(
      projectReal,
      relative(projectLexical, targetAbs),
    );
    return isWithinDir(targetAbs, recordAbs);
  } catch {
    return false;
  }
}

interface MutationIntent {
  targets: string[];
  opaqueShell: boolean;
  shellCommand: string | null;
}

function normalizedCommandName(name: string): string {
  return basename(name).toLowerCase().replace(/\.exe$/, "");
}

function gitSubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
      i++;
      continue;
    }
    if (
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=") ||
      arg.startsWith("--namespace=")
    ) {
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function isFrameworkToolInvocation(
  projectDir: string,
  cwd: string,
  name: string,
  args: string[],
): boolean {
  if (normalizedCommandName(name) !== "bun") return false;
  if (
    args.some((arg) =>
      arg === "-r" ||
      arg === "--require" ||
      arg === "--preload" ||
      arg.startsWith("--require=") ||
      arg.startsWith("--preload=")
    )
  ) {
    return false;
  }
  let scriptIndex = 0;
  if (args[0] === "run") scriptIndex = 1;
  const script = args[scriptIndex];
  if (!script || script.startsWith("-")) return false;
  const projectLexical = resolve(projectDir);
  const absolute = isAbsolute(script) ? resolve(script) : resolve(cwd, script);
  const trustedToolsDir = resolve(projectLexical, harnessDir(), "tools");
  if (
    dirname(absolute) !== trustedToolsDir ||
    !/^aidlc-[A-Za-z0-9._-]+\.ts$/.test(basename(absolute))
  ) {
    return false;
  }
  try {
    const projectReal = realpathSync(projectLexical);
    assertNoSymlinkInChainOrThrow(
      projectReal,
      relative(projectLexical, absolute),
    );
    return lstatSync(absolute).isFile() && !lstatSync(absolute).isSymbolicLink();
  } catch {
    return false;
  }
}

function shellInvocationNeedsApproval(
  projectDir: string,
  cwd: string,
  invocation: { name: string; args: string[] },
  hasConcreteTargets: boolean,
): boolean {
  const name = normalizedCommandName(invocation.name);
  if (name === "sort") {
    return invocation.args.some(
      (arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="),
    );
  }
  if (name === "uniq") {
    const operands = invocation.args.filter((arg) => !arg.startsWith("-"));
    return operands.length >= 2;
  }
  if (READ_ONLY_SHELL_COMMANDS.has(name)) return false;
  if (name === "git") {
    if (
      invocation.args.some(
        (arg) => arg === "--output" || arg.startsWith("--output="),
      )
    ) {
      return true;
    }
    const subcommand = gitSubcommand(invocation.args);
    if (subcommand === "branch") {
      return !invocation.args.includes("--show-current");
    }
    return subcommand === null || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
  }
  if (isFrameworkToolInvocation(projectDir, cwd, name, invocation.args)) return false;
  if (
    TRACKED_SHELL_MUTATORS.has(name) &&
    hasConcreteTargets &&
    !invocation.args.some((arg) => /[$`*?]/.test(arg))
  ) {
    return false;
  }
  return true;
}

function shellUsesDynamicEvaluation(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (ch === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (ch === "`" || ch === "$") return true;
    if ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") {
      return true;
    }
  }
  return false;
}

async function mutationIntent(
  projectDir: string,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  cwd: string,
): Promise<MutationIntent> {
  let targets: string[] = [];
  let opaqueShell = false;
  let shellCommand: string | null = null;
  if (toolName === "Bash") {
    const command = toolInput?.command;
    if (typeof command !== "string") {
      return { targets: [], opaqueShell: false, shellCommand: null };
    }
    shellCommand = command;
    const { shellCommandInvocations, shellWriteTargets } = await import(
      "./aidlc-review-freeze.ts"
    );
    targets = shellWriteTargets(command, cwd);
    opaqueShell =
      shellUsesDynamicEvaluation(command) ||
      shellCommandInvocations(command).some((invocation) =>
        shellInvocationNeedsApproval(projectDir, cwd, invocation, targets.length > 0)
      );
  } else if (WRITE_TOOLS.has(toolName)) {
    const input = toolInput ?? {};
    const add = (value: unknown) => {
      if (typeof value === "string" && value.length > 0) targets.push(value);
    };
    add(input.file_path);
    add(input.notebook_path);
    add(input.path);
    if (Array.isArray(input.paths)) for (const path of input.paths) add(path);
  }
  return {
    targets: targets.map((target) =>
      isAbsolute(target) ? resolve(target) : resolve(cwd, target)
    ),
    opaqueShell,
    shellCommand,
  };
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
  const toolInput = parsed.tool_input ?? {};
  const subagentType =
    typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : "";
  const guardedDispatch =
    DISPATCH_TOOLS.has(toolName) && subagentType === GUARDED_AGENT;
  if (SAFE_READ_TOOLS.has(toolName)) return 0;
  const mutationCapable =
    toolName === "Bash" ||
    WRITE_TOOLS.has(toolName) ||
    (!DISPATCH_TOOLS.has(toolName) && toolName.length > 0);
  if (!guardedDispatch && !mutationCapable) return 0;
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : projectDir;
  // Identity: Claude Code and Codex deliver the active subagent's name as
  // agent_type (absent on main-session calls); the Kiro CLI adapter forwards
  // the registering agent's name; Cursor, opencode, and Copilot correlate it
  // from their ledgers. Kiro IDE payloads carry no identity at all and say so.
  // Only the developer agent authors the two plan files; a payload whose
  // identity is unknowable cannot be judged and passes the authorship rule.
  const agentType = typeof parsed.agent_type === "string" ? parsed.agent_type : "";
  const planAuthor =
    agentType === GUARDED_AGENT || parsed.agent_identity_unavailable === true;

  let verdict: PlanApprovalVerdict;
  let units: UnitEvidence[] = [];
  let authorityFailure: string | null = null;
  // A fully worded refusal (planning admission, planning confinement, plan
  // authorship) that supersedes the ordering reasons below.
  let refusal: string | null = null;
  let blockedMutation: {
    target: string;
    unit: string | null;
    opaqueShell: boolean;
    detail: string | null;
  } | null = null;
  try {
    const statePath = stateFilePath(projectDir);
    if (!existsSync(statePath)) return 0; // no workflow - fail open
    const state = readFileSync(statePath, "utf-8");
    const currentStage = getField(state, "Current Stage") ?? "";
    const activeDirective = readActiveDirectiveMarker(projectDir, state);
    const durableStage = normalizeStageName(currentStage);
    const directiveStage = normalizeStageName(activeDirective?.stage ?? "");
    const dispatchPrompt = [toolInput.prompt, toolInput.description]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    const planningDispatch =
      guardedDispatch && promptPlanningMarkers(dispatchPrompt).length > 0;
    const explicitPlanDispatch =
      planningDispatch ||
      promptUnitMarkers(dispatchPrompt).length > 0 ||
      promptStageMarkers(dispatchPrompt).length > 0 ||
      promptTestingContractMarkers(dispatchPrompt).length > 0;
    const codeGenerationRelevant =
      directiveStage === GUARDED_STAGE ||
      durableStage === GUARDED_STAGE ||
      (guardedDispatch && explicitPlanDispatch);
    if (!codeGenerationRelevant) return 0;
    const knownMutationTool =
      toolName === "Bash" || WRITE_TOOLS.has(toolName);
    const mutation = guardedDispatch
      ? { targets: [], opaqueShell: false, shellCommand: null }
      : knownMutationTool
        ? await mutationIntent(projectDir, toolName, toolInput, cwd)
        : {
            targets: [],
            opaqueShell: true,
            shellCommand: `unknown mutation-capable tool: ${toolName}`,
          };
    if (!guardedDispatch && mutation.targets.length === 0 && !mutation.opaqueShell) {
      return 0;
    }

    if (
      activeDirective?.version !== 2 ||
      directiveStage !== GUARDED_STAGE
    ) {
      authorityFailure =
        "the current state has no matching v2 code-generation active directive";
      verdict = { block: true, mentioned: [] };
    } else {
      const planningTargets = directivePlanningTargets(activeDirective);
      if (guardedDispatch) {
        // A planning dispatch consults no approval evidence, so the per-unit
        // evaluation is only gathered for a generation dispatch.
        units = planningDispatch
          ? []
          : gatherApprovalEvidence(projectDir, knownUnits(projectDir, docsRoot(projectDir)));
        verdict = evaluatePlanApprovalDispatch(toolName, subagentType, dispatchPrompt, {
          currentStage: activeDirective.stage,
          units,
          planningTargets,
        });
        if (verdict.planning) {
          if (verdict.block) {
            refusal = planningBlockReason(verdict, planningTargets);
          } else {
            // Admission opens the confinement window. A throw (malformed
            // record) lands in the catch below and refuses: an unreadable
            // window is not an open one.
            const admission = admitPlanningDispatch(
              projectDir,
              planningTargetOf(verdict.mentioned[0]),
              parsed.session_id,
            );
            if (!admission.admitted) {
              verdict = { ...verdict, block: true };
              refusal = planningBusyReason(
                admission.live.target,
                planningDispatchPath(projectDir),
              );
            }
          }
        } else if (!verdict.block) {
          // Generation waits for a live planning dispatch to return: the plan
          // it would execute may still be changing under the planner's hands.
          const window = readPlanningDispatchWindow(projectDir);
          if (window.malformed) {
            authorityFailure =
              `the planning dispatch record at ${planningDispatchPath(projectDir)} is malformed; remove it`;
            verdict = { ...verdict, block: true };
          } else if (window.record !== null) {
            verdict = { ...verdict, block: true };
            refusal = planningBusyReason(
              window.record.target,
              planningDispatchPath(projectDir),
            );
          }
        }
      } else {
        const window = readPlanningDispatchWindow(projectDir);
        if (window.malformed) {
          authorityFailure =
            `the planning dispatch record at ${planningDispatchPath(projectDir)} is malformed; remove it`;
          verdict = { block: true, mentioned: [] };
        } else if (window.record !== null) {
          // A planning dispatch is live: every mutation is confined to the ONE
          // planned target's record dir (nothing in the workspace, nothing in a
          // sibling target), and inside it the two plan files take only the
          // developer agent's writes. The conductor waits for the worker and
          // keeps the questions file and diary; the worker plans and returns.
          const liveTarget = window.record.target;
          const liveDir = resolve(codeGenerationRecordDir(projectDir, liveTarget));
          const outside = mutation.targets.find(
            (candidate) => !isTrustedRecordTarget(projectDir, candidate, liveDir),
          );
          verdict = { block: false, mentioned: [mentionedTarget(liveTarget)] };
          if (outside !== undefined || mutation.opaqueShell) {
            verdict.block = true;
            const target =
              outside ??
              `shell command: ${(mutation.shellCommand ?? "").trim().slice(0, 160)}`;
            blockedMutation = {
              target,
              unit: liveTarget,
              opaqueShell: outside === undefined,
              detail: null,
            };
            refusal = planningConfinementReason(
              target,
              liveTarget,
              outside === undefined,
              liveDir,
            );
          } else {
            const authored = planAuthor ? null : planFileWrite(mutation.targets, liveDir);
            if (authored !== null) {
              verdict.block = true;
              blockedMutation = {
                target: authored,
                unit: liveTarget,
                opaqueShell: false,
                detail: null,
              };
              refusal = planAuthorshipReason(authored, liveTarget, "planning-live");
            } else {
              return 0;
            }
          }
        } else if (activeDirective.kind === "run-stage") {
          const unit = activeDirective.unit?.trim() || null;
          const target: CodeGenerationTarget = { unit };
          const approvalDir = resolve(codeGenerationRecordDir(projectDir, unit));
          const outsideRecord = mutation.targets.find(
            (candidate) =>
              !isTrustedRecordTarget(projectDir, candidate, approvalDir),
          );
          if (!outsideRecord && !mutation.opaqueShell) {
            // A record-dir write. Once the plan is fingerprinted, the conductor
            // no longer edits the two files the human approves.
            const authored = planAuthor ? null : planFileWrite(mutation.targets, approvalDir);
            if (authored === null || !approvalFingerprintRecorded(projectDir, unit)) return 0;
            verdict = { block: true, mentioned: [mentionedTarget(unit)] };
            blockedMutation = { target: authored, unit, opaqueShell: false, detail: null };
            refusal = planAuthorshipReason(authored, unit, "fingerprinted");
          } else {
            const approval = evaluateCodeGenerationApproval(projectDir, target);
            const evidence: UnitEvidence = {
              unit,
              planExists: approval.planExists,
              instructionsExist: approval.instructionsExist,
              approved: approval.approved,
              contractValid: approval.contractValid,
              fingerprintValid: approval.fingerprintValid,
              receiptValid: approval.receiptValid,
              contractHash: approval.contractHash,
              ...(approval.ok ? {} : { reason: approval.reason }),
            };
            verdict = {
              block: !approvalEvidenceIsCurrent(evidence),
              mentioned: [mentionedTarget(unit)],
            };
            if (verdict.block) {
              blockedMutation = {
                target:
                  outsideRecord ??
                  `shell command: ${(mutation.shellCommand ?? "").trim().slice(0, 160)}`,
                unit,
                opaqueShell: outsideRecord === undefined,
                detail: receiptDetail([evidence], verdict.mentioned),
              };
            }
          }
        } else if (activeDirective.kind === "invoke-swarm" && planningTargets.length > 0) {
          // Autonomous planning turns: the batch's record dirs stay writable
          // for the questions files and diaries (the same carve-out the
          // run-stage path grants its one target); every other mutation waits
          // for `aidlc-swarm.ts prepare`, which owns the worktrees.
          const dirs = planningTargets.map((planned) => ({
            unit: planned,
            dir: resolve(codeGenerationRecordDir(projectDir, planned)),
          }));
          const insideBatch =
            !mutation.opaqueShell &&
            mutation.targets.every((candidate) =>
              dirs.some((entry) => isTrustedRecordTarget(projectDir, candidate, entry.dir)),
            );
          if (!insideBatch) {
            authorityFailure =
              `workspace mutation cannot select one approval target from directive kind "${activeDirective.kind}"`;
            verdict = { block: true, mentioned: [] };
          } else {
            const authoredEntry = planAuthor
              ? undefined
              : dirs
                  .map((entry) => ({ entry, path: planFileWrite(mutation.targets, entry.dir) }))
                  .find((hit) => hit.path !== null);
            if (
              authoredEntry === undefined ||
              !approvalFingerprintRecorded(projectDir, authoredEntry.entry.unit)
            ) {
              return 0;
            }
            verdict = { block: true, mentioned: [mentionedTarget(authoredEntry.entry.unit)] };
            blockedMutation = {
              target: authoredEntry.path ?? "",
              unit: authoredEntry.entry.unit,
              opaqueShell: false,
              detail: null,
            };
            refusal = planAuthorshipReason(
              authoredEntry.path ?? "",
              authoredEntry.entry.unit,
              "fingerprinted",
            );
          }
        } else {
          authorityFailure =
            `workspace mutation cannot select one approval target from directive kind "${activeDirective.kind}"`;
          verdict = { block: true, mentioned: [] };
        }
      }
    }
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    authorityFailure =
      `Plan Approval authority evaluation failed closed: ${errorMessage(e)}`;
    verdict = { block: true, mentioned: [] };
  }
  if (!verdict.block) {
    // Under Change Control `relaxed`, generation start may accept source that
    // moved after approval: the ledger row is written there and the one human
    // line comes back to be printed on this hook's stdout. A planning
    // dispatch never starts generation, so it never reaches `begin`.
    const changeNotices: string[] = [];
    try {
      if (guardedDispatch && verdict.planning !== true) {
        for (const mentioned of verdict.mentioned) {
          changeNotices.push(
            ...beginCodeGeneration(projectDir, {
              unit: planningTargetOf(mentioned),
            }),
          );
        }
      } else if (!guardedDispatch && blockedMutation === null) {
        const state = readFileSync(stateFilePath(projectDir), "utf-8");
        const marker = readActiveDirectiveMarker(projectDir, state);
        if (marker?.version === 2 && marker.kind === "run-stage") {
          changeNotices.push(
            ...beginCodeGeneration(projectDir, {
              unit: marker.unit?.trim() || null,
            }),
          );
        }
      }
    } catch (e) {
      authorityFailure =
        `Code Generation could not start from its protected approval receipt: ${errorMessage(e)}` +
        (e instanceof PlanApprovalSourceDriftError ? ` ${e.remedy}` : "");
      verdict = { block: true, mentioned: verdict.mentioned };
    }
    if (!verdict.block) {
      for (const notice of changeNotices) process.stdout.write(`${notice}\n`);
    }
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
              Target: guardedDispatch ? subagentType : blockedMutation?.target ?? "",
              Stage: GUARDED_STAGE,
              Unit:
                blockedMutation?.unit ??
                (verdict.mentioned[0] === `stage:${GUARDED_STAGE}`
                  ? STAGE_TARGET
                  : verdict.mentioned.join(", ") || "(missing marker)"),
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

  process.stderr.write(
    `${authorityFailure
      ? authorityBlockReason(authorityFailure)
      : refusal
      ? refusal
      : blockedMutation
      ? mutationBlockReason(
          blockedMutation.target,
          blockedMutation.unit,
          blockedMutation.opaqueShell,
          blockedMutation.detail,
        )
      : verdict.appendixInBrief
      ? appendixBlockReason(verdict.mentioned)
      : blockReason(verdict.mentioned, receiptDetail(units, verdict.mentioned))}\n`,
  );
  return 2; // harness PreToolUse reject contract: exit 2 + stderr blocks
}

/** The targets the active directive plans: its unit (or stage-level), or a swarm batch's units. */
function directivePlanningTargets(
  marker: { kind?: string; unit?: string; units?: string[] },
): PlanningTarget[] {
  if (marker.kind === "run-stage") return [marker.unit?.trim() || null];
  if (marker.kind === "invoke-swarm") {
    return (marker.units ?? [])
      .map((unit) => unit.trim())
      .filter((unit) => unit.length > 0);
  }
  return [];
}

/**
 * The first mutation target that is one of the two authored plan files inside
 * `recordDir`, or null. Paths are already resolved absolute.
 */
function planFileWrite(targets: string[], recordDir: string): string | null {
  return (
    targets.find(
      (candidate) =>
        dirname(candidate) === recordDir && PLAN_AUTHORED_FILES.has(basename(candidate)),
    ) ?? null
  );
}

/** True once the target's questions file records a non-blank `[Approval Fingerprint]` tag. */
function approvalFingerprintRecorded(projectDir: string, unit: PlanningTarget): boolean {
  try {
    const questions = readFileSync(
      join(codeGenerationRecordDir(projectDir, unit), "code-generation-questions.md"),
      "utf-8",
    );
    return questionsFileApprovalFingerprint(questions) !== null;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const input = process.stdin.isTTY ? "" : await Bun.stdin.text();
  process.exit(await run(input));
}
