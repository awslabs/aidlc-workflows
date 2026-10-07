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
// refuse the tool call, exit 0 to allow. The refusal is scoped tightly to
// code-generation: developer-agent dispatch and workspace mutation are both
// blocked until the same approval evidence is current. Writes inside the
// selected code-generation record dir remain available to create the plan,
// instructions, questions, and diary that make approval possible. So does the
// composer's grid proposal file, which a composition requested mid-stage writes.
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
// Fail-open outside code-generation: a missing or unreadable state file, an
// active directive/current stage other than code-generation, malformed stdin,
// an unknown/read-only tool, a non-developer subagent target, or any throw
// allows the call. Once a code-generation generation path is identified,
// missing or ambiguous target evidence blocks. The deterministic
// off-switch AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1 disables enforcement (the
// documented escape hatch for false-positive storms, mirroring the
// reviewer-scope guard's off-switch) but is no longer silent: while a workflow
// exists it appends one GUARD_DISABLED audit row per streak of disabled calls.
// Every genuine block emits a PLAN_APPROVAL_BLOCKED audit event so the run's
// record shows when the ordering bit; audit failures never change the decision.

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import { commandPath, readActiveExecutable } from "../tools/aidlc-install-paths.ts";
import {
  guardOperationMatchesRemedy,
  isGuardRecoveryEngineInvocation,
  parseGuardRestartContinuationCommand,
  sameGuardOperation,
} from "../tools/aidlc-guard-operation.ts";
import {
  hookOutsideGate,
  enterHookWorkflow,
  acquireAuditLock,
  type ActiveDirectiveMarker,
  assertNoSymlinkInChainOrThrow,
  auditBlockField,
  auditFilePath,
  type ClaudeCodeHookInput,
  composerProposalPath,
  docsRoot,
  ANSWER_TEXT_DIR,
  errorMessage,
  getField,
  GUARD_RECOVERY_ASK_TYPE,
  guardRecoveryAnswerAdmits,
  guardRecoveryRecordWorkOpen,
  PLAN_APPROVAL_ASK_TYPE,
  guardStandAsideSpeaks,
  guardStoodAsideLine,
  harnessDir,
  normalizeDriveLetter,
  recordGuardStoodAside,
  hooksHealthDir,
  writeHookStatusFile,
  isClaudeCodeHookInput,
  isoTimestamp,
  loadScopeMapping,
  loadStageGraph,
  parseCheckboxes,
  parseStateStageSuffixes,
  personAskedSinceGate,
  personCheckSwitchAllowed,
  personSpokeSinceGate,
  readActiveDirectiveMarker,
  readAuditShardEvents,
  REVIEW_RECORDS_DIR,
  reviewerDispatchPath,
  spacesRoot,
  activeDirectiveOutOfDateReason,
  recordHookDrop,
  releaseAuditLock,
  resolveBoltDag,
  resolveProjectFlag,
  resolveProjectDirFromHook,
  resolveWorkflowSelection,
  SKELETON_STANCES,
  stateFilePath,
  writeGuardStoodAside,
} from "../tools/aidlc-lib.ts";
import type { planApprovalAskState } from "../tools/aidlc-plan-approval-ask.ts";
import { aidlcToolInvocation, quoteCommandArgument } from "../tools/aidlc-runtime-paths.ts";
import { RECORDABLE_PROJECT_BYPASSES } from "../tools/aidlc-settings.ts";
import {
  AS_ITS_OWN_COMMAND,
  beginCodeGeneration,
  beginCodeGenerationBatch,
  codeGenerationExecutionAllowed,
  type CodeGenerationIssuance,
  codeGenerationIssuance,
  codeGenerationPlanApprovalFence,
  codeGenerationRecordDir,
  codeGenerationRulesArrivingReason,
  type CodeGenerationTarget,
  evaluateCodeGenerationApproval,
  planReviewAppendix,
  promptTestingContractMarkers,
} from "../tools/aidlc-testing-posture.ts";
import { refuseRuntimeIntegrityViolation } from "./runtime-integrity.ts";

export {
  questionsFileApproved,
  questionsFileHasPendingPlanApproval,
} from "../tools/aidlc-testing-posture.ts";

const HOOK_NAME = "plan-approval-guard";

// The one stage this hook guards and the one dispatch target it inspects.
const GUARDED_STAGE = "code-generation";
const GUARDED_AGENT = "aidlc-developer-agent";
const STAGE_TARGET = "stage-level";
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
// PowerShell cmdlets that read and never write, whatever their parameters.
// Out-File, Set-Content, Add-Content and Tee-Object write files and are not
// here. They count only where the command is PowerShell (see ShellDialect).
const READ_ONLY_POWERSHELL_CMDLETS = new Set([
  "convertfrom-json",
  "format-custom",
  "format-hex",
  "format-list",
  "format-table",
  "format-wide",
  "get-childitem",
  "get-content",
  "get-item",
  "measure-object",
  "out-string",
  "resolve-path",
  "select-object",
  "select-string",
  "test-path",
  "write-output",
]);
const POWERSHELL_SET_LOCATION = new Set(["chdir", "set-location", "sl"]);

// The subagent-dispatch tool names across harness payload shapes. Claude Code
// delivers Task; the adapters translate their native dispatch tools (Kiro's
// subagent stages, opencode's task, Codex's spawn_agent) into this shape.
const DISPATCH_TOOLS = new Set(["Task", "Agent"]);
// A gate transition moves the state past the issued directive; `next`
// re-issues it. Both fence decisions name that remedy.
// The engine's Plan Approval question is the active directive.
const PLAN_APPROVAL_ASK_OPEN = "the engine is asking the person to approve the plan";
const NO_CURRENT_DIRECTIVE =
  "the current state has no matching v2 code-generation active directive";
// The engine asked the person how to recover and is waiting for the answer.
const ENGINE_QUESTION_OPEN =
  "the engine is waiting for the person's answer to its recovery question";

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
  /** What is wrong with the handoff itself, when that (not the approval) refuses it. */
  handoff?: HandoffDefect;
}

/**
 * A developer handoff that names no target or several, names one this
 * workflow does not build, or carries the wrong contract line for an
 * approved plan.
 */
export type HandoffDefect = "targets" | "unknown-target" | "contract";

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
 * The plan-approval dispatch decision. Pure: no I/O, no environment.
 *
 * Blocks when the dispatch targets the developer agent for code-generation
 * unless the prompt carries exactly one target marker (`AIDLC-UNIT` or the
 * stage-level `AIDLC-STAGE: code-generation`), that marker identifies a known
 * approval target, and that target has approved plan evidence.
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

  const markedUnits = promptUnitMarkers(promptText);
  const markedStages = promptStageMarkers(promptText);
  const mentioned = [
    ...markedUnits,
    ...markedStages.map((stage) => `stage:${stage}`),
  ];
  if (markedUnits.length + markedStages.length !== 1) {
    return { block: true, mentioned, handoff: "targets" };
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
  const approved = approvalEvidenceIsCurrent(target);
  const contractMatches = contractMarkers.length === 1 && contractMarkers[0] === target?.contractHash;
  const handoff: HandoffDefect | undefined = target === undefined
    ? "unknown-target"
    : approved && !contractMatches ? "contract" : undefined;
  return {
    block: target === undefined || !approved || !contractMatches || appendixInBrief,
    mentioned,
    ...(appendixInBrief ? { appendixInBrief: true } : {}),
    ...(handoff ? { handoff } : {}),
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

// Every command a refusal names is spelled the way this install runs it, so
// the agent can run it as printed (the native `aidlc engine ...`, or the
// source tree's `bun <harness-dir>/tools/...`), and `next` is always named
// with how to run it so this guard reads it as that command.
function nextOnItsOwn(): string {
  return `\`${aidlcToolInvocation("orchestrate")} next\` ${AS_ITS_OWN_COMMAND}`;
}

/** The Code Generation targets the current step builds (null: the zero-Unit stage-level work). */
export type BriefTargets = Array<string | null>;

function issuanceTargets(issued: CodeGenerationIssuance): BriefTargets {
  return issued.kind === "invoke-swarm" ? issued.units : [issued.unit?.trim() || null];
}

// The `brief` that hands the developer one target and its contract, for the
// targets the current step builds, else for the one target the handoff names.
// Never a placeholder: a refusal names only commands that run as printed.
function briefCommand(mentioned: string[], targets: BriefTargets | null = null): string {
  const tool = aidlcToolInvocation("testing-posture");
  const named = targets && targets.length > 0
    ? targets
    : mentioned.length === 1
      ? [mentioned[0] === `stage:${GUARDED_STAGE}` ? null : mentioned[0]]
      : null;
  if (named === null) {
    return `\`${tool} brief\` for the target the current step names (\`--unit\` and its Unit, or ` +
      "`--stage-level` for zero-Unit work)";
  }
  return named
    .map((unit) => `\`${tool} brief ${unit === null ? "--stage-level" : `--unit ${quoteCommandArgument(unit)}`}\``)
    .join(" or ");
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
    `unit-test instructions only: run ${briefCommand(mentioned)} and ` +
    "pass its output verbatim, then retry the handoff."
  );
}

// The block reason handed back to the conductor through the harness's
// PreToolUse error channel. Self-explaining and redirecting: it names the
// missing evidence and the exact stage steps that produce it, so the
// conductor self-corrects instead of retrying the same call.
export function blockReason(
  mentioned: string[],
  detail: string | null = null,
  targets: BriefTargets | null = null,
): string {
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
    `not approved yet.${detail ? ` Reason: ${detail}.` : ""} Finish code-generation-plan.md and ` +
    `unit-test-instructions.md, then run ${nextOnItsOwn()}: the engine asks the person to ` +
    `approve the plan, and the \`next\` after their answer hands over the build. Then hand the ` +
    `developer the output of ${briefCommand(mentioned, targets)} first, as printed: it names the one ` +
    "target and its Testing Contract."
  );
}

// A developer handoff refused for what is wrong with the handoff itself, so
// it never says the plan is unapproved when it is approved.
export function handoffBlockReason(
  mentioned: string[],
  cause: HandoffDefect,
  targets: BriefTargets | null = null,
): string {
  const what = cause === "targets"
    ? mentioned.length > 1
      ? `names several targets (${mentioned.join(", ")})`
      : "names no target"
    : cause === "unknown-target"
      ? `names ${mentioned[0]}, which is not a Code Generation target of this workflow`
      : "has an AIDLC-TESTING-CONTRACT line that is missing, repeated, or not the approved plan's";
  return (
    `Code generation cannot start: the developer handoff ${what}. Hand the developer the output of ` +
    `${briefCommand(mentioned, targets)} first, exactly as printed: it names the one target and its ` +
    "Testing Contract. Do not write AIDLC-UNIT, AIDLC-STAGE, or AIDLC-TESTING-CONTRACT lines yourself."
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

// The refused path or command can come from the workspace, so it stays out of
// the refusal: the agent knows what it tried, and the way on is the same.
export function mutationBlockReason(
  unit: string | null,
  opaqueShell = false,
  detail: string | null = null,
): string {
  const scope = unit === null ? "the zero-Unit stage-level implementation" : `unit ${unit}`;
  const action = opaqueShell
    ? "run mutation-capable shell commands"
    : "modify workspace paths";
  return (
    `Code generation cannot ${action} for ${scope} because ` +
    `the plan, unit-test instructions, and current Testing Contract do not have a current ` +
    `matching approval.${detail ? ` Reason: ${detail}.` : ""} Writes inside the selected code-generation record directory remain ` +
    `available for planning. When the plan is ready, run ${nextOnItsOwn()}: the engine asks ` +
    `the person to approve it before any code is written.`
  );
}

// What a person (and the conductor) needs while the engine's own question is
// open: what still works and the one move that ends the wait. No authority
// wording: nothing is stale, the engine is waiting for an answer.
function engineQuestionOpenReason(): string {
  return (
    "Code changes wait while AI-DLC's recovery question is open. Answer it first: " +
    `run ${nextOnItsOwn()} to show the question again, then carry out the choice the person makes. ` +
    "Reading, `next`, and the commands that carry out the choice they picked still work, " +
    "as do the record-folder edits a picked fix needs."
  );
}

/**
 * Where the person's approval stands for the target a stale or waiting
 * directive was building: they approved these files; they approved an earlier
 * version and a lowered fence lets the build go on with the changes; or plan
 * approval is off for this work, so nobody was asked.
 */
interface PlanStanding {
  scope: string;
  stands: "approved" | "earlier" | "off";
}

// What ends an authority refusal, said the same way under every Guard Policy:
// what is stale, where the person's approval stands when it does, and the fresh
// `next` that issues the current step again. The agent never asks the person
// again for a judgement they already gave.
function authorityRemedy(
  reason: string,
  standing: PlanStanding | null,
  asked: ReturnType<typeof planApprovalAskState> = null,
): string {
  if (reason === ENGINE_QUESTION_OPEN) return engineQuestionOpenReason();
  if (reason === PLAN_APPROVAL_ASK_OPEN) {
    // The question is still open, so only an approval of these exact files is
    // the person's approval; any other answer they gave is carried out by `next`.
    if (standing?.stands === "approved") {
      return `The person has approved the plan for ${standing.scope}. Run ${nextOnItsOwn()}, ` +
        "and follow the step it prints.";
    }
    if (asked === "answered") {
      return `The person has answered the plan question. Run ${nextOnItsOwn()}, and follow the step ` +
        "it prints: it carries out their choice. Do not show them the question again.";
    }
    if (asked === "editing") {
      return "The person is editing the plan files themselves: leave those files to them. When they say " +
        `they are done, run ${nextOnItsOwn()}, and follow the step it prints.`;
    }
    // Some hosts show this refusal to the person as written, so it is only their
    // sentence; the agent's steps for it are in the skill's refusal clause.
    return "Nothing is built or changed while the plan waits for your approval.";
  }
  const stands = standing === null
    ? ""
    : standing.stands === "earlier"
      ? `The person approved an earlier version of the plan for ${standing.scope}, and the Guard Policy ` +
        "lets the build go on with the changes: do not ask them to approve it again yourself. "
      : standing.stands === "off"
        ? `Plan approval is off for the plan for ${standing.scope}, so it needs no approval: ` +
          "do not ask the person to approve it. "
        : `The plan for ${standing.scope} is already approved: do not ask the person to approve it again yourself. `;
  return `${reason}. ${stands}Run ${nextOnItsOwn()}, and follow the step it prints.`;
}

function authorityBlockReason(
  reason: string,
  standing: PlanStanding | null = null,
  asked: ReturnType<typeof planApprovalAskState> = null,
): string {
  if (reason === ENGINE_QUESTION_OPEN || reason === PLAN_APPROVAL_ASK_OPEN) {
    return authorityRemedy(reason, standing, asked);
  }
  return (
    "Code generation cannot start because its Plan Approval authority is ambiguous or stale. " +
    authorityRemedy(reason, standing)
  );
}

// Where the person's approval stands for the target a stale or waiting
// directive was building, judged the way `next` judges it when it issues that
// directive again: receipt-backed approval of these exact files, or (with the
// fence lowered) an earlier approval the build may go on from. Null when
// neither holds, or when that cannot be told, so nothing is claimed.
function planStanding(projectDir: string, marker: ActiveDirectiveMarker | null): PlanStanding | null {
  if (marker?.version !== 2 || normalizeStageName(marker.stage) !== GUARDED_STAGE) return null;
  const issued = codeGenerationIssuance(marker, true);
  if (issued === null) return null;
  const targets = issuanceTargets(issued);
  const kinds = new Set<PlanStanding["stands"]>();
  try {
    for (const unit of targets) {
      const approval = evaluateCodeGenerationApproval(projectDir, { unit }, issued);
      // Plan approval off built this plan without asking: nobody approved it.
      if (approval.skipped) {
        kinds.add("off");
        continue;
      }
      if (approval.ok) {
        kinds.add("approved");
        continue;
      }
      if (!codeGenerationExecutionAllowed(projectDir, { unit }, approval, issued)) return null;
      kinds.add("earlier");
    }
  } catch {
    return null;
  }
  // Mixed standings across a group are said as the least the person gave.
  const stands = kinds.has("earlier") ? "earlier" : kinds.has("approved") ? "approved" : "off";
  return {
    scope: issued.kind === "invoke-swarm"
      ? `Units ${targets.join(", ")}`
      : targets[0] === null ? "the zero-Unit stage-level implementation" : `unit ${targets[0]}`,
    stands,
  };
}

// Why the step went out of date, when the write that did it was recorded (the
// chat compacted, the state moved): said as the refusal's reason, ahead of the
// way out. Empty when nothing was recorded.
function outOfDateClause(marker: ActiveDirectiveMarker): string {
  const why = activeDirectiveOutOfDateReason(marker);
  return why === null ? "" : `: ${why}`;
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

function sameDirectoryIdentity(left: string, right: string): boolean {
  try {
    const actual = lstatSync(left, { bigint: true });
    const expected = lstatSync(right, { bigint: true });
    return actual.isDirectory() && expected.isDirectory() &&
      actual.ino !== 0n && actual.ino === expected.ino && actual.dev === expected.dev;
  } catch {
    return false;
  }
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

// A write the person asks for while the plan waits, beside the build: a file
// in the project, outside AI-DLC's own folders and reached through no symlink,
// that the waiting plans do not name. A named folder covers what is under it,
// and a bare file name covers that name anywhere. When the plans name no path,
// only a document (Markdown or plain text) is beside the build.
const DOCUMENT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst", ".adoc"]);

function isPlanWaitSideWrite(projectDir: string, target: string, planPaths: string[] | null): boolean {
  try {
    const projectLexical = resolve(projectDir);
    const targetAbs = resolve(target);
    if (targetAbs === projectLexical || !isWithinDir(targetAbs, projectLexical)) return false;
    if (
      isWithinDir(targetAbs, resolve(dirname(spacesRoot(projectDir)))) ||
      isWithinDir(targetAbs, resolve(projectLexical, harnessDir()))
    ) return false;
    assertNoSymlinkInChainOrThrow(realpathSync(projectLexical), relative(projectLexical, targetAbs));
  } catch {
    return false;
  }
  if (planPaths === null || planPaths.length === 0) return DOCUMENT_EXTENSIONS.has(extname(target).toLowerCase());
  const fold = (path: string): string => process.platform === "win32" ? path.toLowerCase() : path;
  const rel = fold(relative(resolve(projectDir), resolve(target)).split(sep).join("/"));
  return !planPaths.some((named) => {
    const path = fold(named.replace(/\/+$/, ""));
    return rel === path || rel.startsWith(`${path}/`) || (!path.includes("/") && rel.split("/").at(-1) === path);
  });
}

// The files and folders the waiting plans name, loaded only while the engine's
// Plan Approval question is open, or one target's plan before it is asked.
// Null when that module cannot be read.
function planApprovalPlanNamedPaths(projectDir: string, unit?: string | null): string[] | null {
  try {
    const ask = require("../tools/aidlc-plan-approval-ask.ts") as typeof import("../tools/aidlc-plan-approval-ask.ts");
    return unit === undefined ? ask.planApprovalPlanNamedPaths(projectDir) : ask.codeGenerationPlanNamedPaths(projectDir, unit);
  } catch {
    return null;
  }
}

// The asked plans' own plan files the person's reply opened, loaded only while
// the engine's Plan Approval question is open. Nothing is open when that module
// cannot be read, so the write is refused as before.
function planApprovalReplyEditableFiles(projectDir: string): string[] {
  try {
    return (require("../tools/aidlc-plan-approval-ask.ts") as typeof import("../tools/aidlc-plan-approval-ask.ts"))
      .planApprovalReplyEditableFiles(projectDir);
  } catch {
    return [];
  }
}

// While the engine's Plan Approval question is open and the person has replied,
// a file-tool write of exactly one of the asked plans' own plan or test
// instructions (planApprovalReplyEditableFiles), reached through no symlink and
// not hard-linked to another file, carries out what they asked with their
// answer. The approval they give then covers the plan as it stands.
function isRepliedPlanFileTarget(projectDir: string, target: string, editable: string[]): boolean {
  try {
    const projectLexical = resolve(projectDir);
    const targetAbs = resolve(target);
    if (!editable.some((file) => normalizeDriveLetter(resolve(file)) === normalizeDriveLetter(targetAbs))) return false;
    assertNoSymlinkInChainOrThrow(realpathSync(projectLexical), relative(projectLexical, targetAbs));
    const existing = lstatSync(targetAbs, { throwIfNoEntry: false });
    return existing === undefined || (existing.isFile() && existing.nlink === 1);
  } catch {
    return false;
  }
}

// A review the person asked for while the plan waits writes only its open
// request's own review file (the Review File of a REVIEW_REQUESTED with no
// REVIEW_COMPLETED for its request id yet) and, while one is open, the reviewer
// dispatch record beside it. Nothing is open when the trail cannot be read.
function openReviewRequestFiles(projectDir: string): string[] {
  try {
    const record = docsRoot(projectDir);
    const open = new Map<string, string>();
    for (const row of readAuditShardEvents(projectDir)) {
      const id = auditBlockField(row.block, "Request Id");
      if (id === null) continue;
      if (row.event === "REVIEW_COMPLETED") open.delete(id);
      if (row.event !== "REVIEW_REQUESTED") continue;
      // Audit rows are project text: only a slot inside the record's reviews
      // folder, as `log review` writes it, counts.
      const file = auditBlockField(row.block, "Review File");
      const slot = file === null ? null : resolve(record, file);
      const reviews = resolve(record, REVIEW_RECORDS_DIR);
      if (slot !== null && !isAbsolute(file as string) && slot.startsWith(`${reviews}${sep}`)) open.set(id, slot);
    }
    return open.size === 0 ? [] : [...open.values(), resolve(reviewerDispatchPath(projectDir))];
  } catch {
    return [];
  }
}

// One of those files exactly, reached through no symlink and not hard-linked
// to another file.
function isOpenReviewTarget(projectDir: string, target: string, files: string[]): boolean {
  try {
    const projectLexical = resolve(projectDir);
    const targetAbs = resolve(target);
    if (!files.some((file) => normalizeDriveLetter(file) === normalizeDriveLetter(targetAbs))) return false;
    assertNoSymlinkInChainOrThrow(realpathSync(projectLexical), relative(projectLexical, targetAbs));
    const existing = lstatSync(targetAbs, { throwIfNoEntry: false });
    return existing === undefined || (existing.isFile() && existing.nlink === 1);
  } catch {
    return false;
  }
}

// The composer's grid proposal (composerProposalPath) is engine scratch that
// only validate-grid reads: not source, not a plan file, and nothing reads an
// approval from it. A composition requested while Code Generation is current
// writes it before its own approval gate. Exactly that file, reached through no
// symlink and not hard-linked to another file, is exempt.
// A stage's own record output inside AI-DLC's records (`aidlc/spaces`): reached
// through no symlink, not hard-linked to another file, and not the work's state,
// audit trail or engine control files, which only the engine writes.
function isStageRecordOutput(projectDir: string, target: string): boolean {
  try {
    const projectLexical = resolve(projectDir);
    const targetAbs = resolve(target);
    const inside = relative(resolve(spacesRoot(projectDir)), targetAbs);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return false;
    const segments = inside.split(/[\\/]/);
    if (
      basename(targetAbs) === "aidlc-state.md" || basename(targetAbs) === "intents.json" ||
      segments.includes(".aidlc-engine") || segments.includes("audit")
    ) return false;
    assertNoSymlinkInChainOrThrow(realpathSync(projectLexical), relative(projectLexical, targetAbs));
    const existing = lstatSync(targetAbs, { throwIfNoEntry: false });
    return existing === undefined || (existing.isFile() && existing.nlink === 1);
  } catch {
    return false;
  }
}

// The record folder where the agent writes a person's answer text for
// `log answer --details-file`: a plain file inside the work's own record,
// reached through no link. Writing it changes nothing and builds nothing.
function isAnswerTextTarget(projectDir: string, target: string): boolean {
  try {
    const record = docsRoot(projectDir);
    if (!record || !isTrustedRecordTarget(projectDir, target, join(record, ANSWER_TEXT_DIR))) return false;
    const existing = lstatSync(resolve(target), { throwIfNoEntry: false });
    return existing === undefined || (existing.isFile() && existing.nlink === 1);
  } catch {
    return false;
  }
}

function isComposerProposalTarget(projectDir: string, target: string): boolean {
  try {
    const projectLexical = resolve(projectDir);
    const targetAbs = resolve(target);
    if (normalizeDriveLetter(targetAbs) !== normalizeDriveLetter(resolve(composerProposalPath(projectDir)))) {
      return false;
    }
    assertNoSymlinkInChainOrThrow(realpathSync(projectLexical), relative(projectLexical, targetAbs));
    const existing = lstatSync(targetAbs, { throwIfNoEntry: false });
    return existing === undefined || (existing.isFile() && existing.nlink === 1);
  } catch {
    return false;
  }
}

interface MutationIntent {
  targets: string[];
  opaqueShell: boolean;
  shellCommand: string | null;
  swarmUnits?: string[];
  /** The command runs AI-DLC itself, or may (a dynamic command naming it). */
  runsAidlc?: boolean;
}

function normalizedCommandName(name: string): string {
  return basename(name).toLowerCase().replace(/\.exe$/, "");
}

function lastFlagValue(args: string[], flag: string): string | null {
  let value: string | null = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== flag) continue;
    const candidate = args[index + 1];
    if (!candidate || candidate.startsWith("--")) return null;
    value = candidate;
    index++;
  }
  return value;
}

// Diagnostics that change nothing a plan governs. Refusing them while a plan
// waits for approval left the person unable to ask what was wrong (#1383,
// #1418). A doctor export writes a bundle, so it keeps the normal verdict.
function isReadOnlyDiagnostic(args: readonly string[]): boolean {
  const [head = "", ...rest] = args;
  if (["status", "--status", "version", "--version", "help", "--help"].includes(head)) return true;
  // The engine's clock, for a time a document asks for.
  if (head === "engine" && rest.length === 1 && rest[0] === "now") return true;
  if (head !== "doctor" && head !== "--doctor") return false;
  return !rest.some((arg) =>
    arg === "--export" || arg === "--output" ||
    arg.startsWith("--export=") || arg.startsWith("--output="));
}

// A recorded switch turned off or back on, and nothing else: `config flags`
// with --bypass and --clear-bypass pairs, an optional layer, this project,
// and output options.
// Turning a check back on never waits for anything. Turning one off is the
// person's call, so while a plan waits it passes once a person has spoken since
// the last decision: the agent is running what they asked for, and the engine
// then tells them which check is off, what it is for, and that the way back is
// there. An unattended
// driver has no person behind it, so it never turns one off here.
// Options that only choose a layer, confirm, or shape the output.
const RECORDED_SWITCH_OPTIONS = new Set([
  "--local", "--project", "--global", "--yes", "--json", "--quiet", "--no-color", "--verbose",
]);

function recordedSwitchChangeAdmitted(projectDir: string, args: readonly string[]): boolean {
  if (args[0] !== "config" || args[1] !== "flags") return false;
  let changes = false;
  let lowers = false;
  for (let index = 2; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--bypass" || arg === "--clear-bypass") {
      const name = args[++index] ?? "";
      if (!(RECORDABLE_PROJECT_BYPASSES as readonly string[]).includes(name)) return false;
      changes = true;
      lowers ||= arg === "--bypass";
    } else if (arg === "--project-dir") {
      // The way back the engine prints names this project when it ran
      // elsewhere: the same folder by identity, however it is spelled.
      const dir = args[++index];
      if (dir === undefined || !sameDirectoryIdentity(resolve(dir), projectDir)) return false;
    } else if (!RECORDED_SWITCH_OPTIONS.has(arg)) {
      return false;
    }
  }
  return changes && (!lowers || personAskedSinceGate(projectDir));
}

// A check for this piece of work turned off or back on with `engine config set`,
// and nothing else. Turning one on, or raising Guard Policy, only adds a stop,
// so it never waits. Turning one off is the person's call, so while a plan
// waits it passes once they have asked in the chat since the last decision:
// the setter then records it with their words and says how to undo it. Plan
// approval itself is admitted beside the other plan-wait prerequisites.
function chatSwitchChangeAdmitted(projectDir: string, args: readonly string[]): boolean {
  if (args.length !== 5 || args[0] !== "engine" || args[1] !== "config" || args[2] !== "set") return false;
  if (args[3] === "plan-approval" || args[3] === "guard.plan-approval") return false;
  return personCheckSwitchAllowed(projectDir, args[3], args[4]);
}

// How a shell command line is read. Every harness keeps the POSIX reading
// unless its adapter says the command runs in PowerShell.
interface ShellDialect {
  // PowerShell's read-only cmdlets and Set-Location are real commands.
  powerShell: boolean;
  // Command words kept their backslashes. A path then names only the
  // installed engine: under the POSIX reading C:\x\cat.exe was never cat.
  pathsAsWritten: boolean;
  // aidlc.cmd and absolute paths to the installed launcher or active
  // executable name the engine, as they do on Windows.
  enginePaths: boolean;
}

const POSIX_DIALECT: ShellDialect = {
  powerShell: false,
  pathsAsWritten: false,
  enginePaths: false,
};

// A PowerShell stream redirect that writes no file: to $null, or into output.
const POWERSHELL_NULL_REDIRECT = /^(?:[1-6*]?>>?[ ]*\$null|[2-6*]>&1)(?=[ ;|]|$)/i;

// Reads a plain PowerShell command line: literal words, commands joined by ;
// or |, a leading & call operator, and redirects that write no file. Returns
// null for anything PowerShell would evaluate (variables, subexpressions,
// script blocks, splatting, comments) and for words Windows PowerShell 5.1
// hands a native program differently than written: it splits a bare -x.y at
// the dot, drops empty arguments, and does not escape embedded quotes or a
// trailing backslash. The rendering is the same commands as POSIX words.
// It is not the write-target reader: readPowerShell in
// review-freeze-command.ts reads every line for what it may write, while
// this reading admits only lines it can render exactly.
function plainPowerShell(
  command: string,
): { commands: string[][]; rendering: string } | null {
  // Controls, whitespace other than a space, and the typographic dashes and
  // quotes PowerShell reads as - and as quotes.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
  if (/[\x00-\x1f\x7f-\x9f\u2013-\u2015\u2018-\u201f]|[^\S ]/u.test(command)) return null;
  const commands: string[][] = [];
  const joins: string[] = [];
  let words: string[] = [];
  let call = false;
  const finish = (): boolean => {
    if (words.length === 0) return false;
    if (
      !READ_ONLY_POWERSHELL_CMDLETS.has(words[0].toLowerCase()) &&
      words.slice(1).some((word) => word === "" || word.includes('"') || word.endsWith("\\"))
    ) return false;
    commands.push(words);
    words = [];
    call = false;
    return true;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === " ") {
      i++;
      continue;
    }
    if (ch === ";" || ch === "|") {
      if (command[i + 1] === "|" || !finish()) return null;
      joins.push(ch);
      i++;
      continue;
    }
    const redirect = POWERSHELL_NULL_REDIRECT.exec(command.slice(i));
    if (redirect) {
      i += redirect[0].length;
      continue;
    }
    if (ch === "&") {
      if (call || words.length > 0 || command[i + 1] !== " ") return null;
      call = true;
      i++;
      continue;
    }
    const first = words.length === 0;
    let word: string;
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      // Without &, a quoted first word is an expression, not a command.
      if (close < 0 || (first && !call)) return null;
      word = command.slice(i + 1, close);
      if (ch === '"' && /[$`]/.test(word)) return null;
      i = close + 1;
    } else {
      word = /^[^ ;|&'"]+/.exec(command.slice(i))?.[0] ?? "";
      if (
        /[`$@(){}#<>,%^![\]]/.test(word) ||
        /\\(?![A-Za-z0-9._-])/.test(word) ||
        /^-[^-].*\./.test(word) ||
        (first && !call && !/^[A-Za-z][A-Za-z0-9._:\\/-]*$/.test(word))
      ) return null;
      i += word.length;
    }
    // A quote or & inside a word escapes or joins beyond this reading.
    if (i < command.length && !" ;|".includes(command[i])) return null;
    if (first && (word === "" || word.includes("="))) return null;
    words.push(word);
  }
  if (!finish()) return null;
  const posixWord = (word: string): string =>
    /^[A-Za-z0-9._/:+,@%-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
  return {
    commands,
    rendering: commands
      .map((command, index) =>
        `${index > 0 ? ` ${joins[index - 1]} ` : ""}${command.map(posixWord).join(" ")}`
      )
      .join(""),
  };
}

// The POSIX reading of a plain PowerShell command, where that reading runs
// the same commands with the same arguments. PowerShell runs each command's
// first word: a word the POSIX lexer reads as a wrapper, keyword or
// assignment would put a different program under review.
function powerShellReading(
  command: string,
  invocationsOf: (command: string) => Array<{
    args: string[]; executable?: string; launchers?: string[];
    dataDriven?: boolean; executableResolutionChanged?: boolean; ambiguous?: boolean;
  }>,
): string | null {
  const plain = plainPowerShell(command);
  if (!plain) return null;
  const invocations = invocationsOf(plain.rendering);
  const faithful = invocations.length === plain.commands.length &&
    invocations.every((invocation, index) => {
      const [executable, ...args] = plain.commands[index];
      return !invocation.ambiguous && !invocation.launchers && !invocation.dataDriven &&
        !invocation.executableResolutionChanged && invocation.executable === executable &&
        invocation.args.length === args.length &&
        invocation.args.every((arg, at) => arg === args[at]);
    });
  return faithful ? plain.rendering : null;
}

function sameFileIdentity(left: string, right: string): boolean {
  try {
    const actual = statSync(left, { bigint: true });
    const expected = statSync(right, { bigint: true });
    return actual.isFile() && expected.isFile() &&
      actual.ino !== 0n && actual.ino === expected.ino && actual.dev === expected.dev;
  } catch {
    return false;
  }
}

// The installed engine behind an absolute path: the aidlc command or the
// active executable, compared by file identity so short names, casing and
// links agree. Retained versions are not the engine `aidlc` runs.
function installedEngine(path: string): "launcher" | "executable" | null {
  if (!isAbsolute(path)) return null;
  try {
    const launcher = commandPath();
    if (sameFileIdentity(path, launcher)) {
      return launcher.toLowerCase().endsWith(".cmd") ? "launcher" : "executable";
    }
  } catch {
    // An unresolvable install root trusts no path.
  }
  try {
    const active = readActiveExecutable();
    if (active !== null && sameFileIdentity(path, active)) return "executable";
  } catch {
    // A damaged active pointer trusts no path.
  }
  return null;
}

// The dispatcher's top-level park runs `engine orchestrate park` and gets its
// verdict: the engine names that spelling for a typed park.
function asEngineRoute(args: string[]): string[] {
  return args[0] === "park" ? ["engine", "orchestrate", ...args] : args;
}

// The native engine, by name or (with enginePaths) by the installed launcher
// or executable path, running a command `admitted` accepts.
function isNativePlanApprovalPrerequisite(
  name: string,
  args: string[],
  admitted: (engineArgs: string[]) => boolean,
  enginePaths = false,
): boolean {
  const command = name.toLowerCase();
  if (command === "aidlc" || command === "aidlc.exe") {
    return admitted(asEngineRoute(args));
  }
  if (!enginePaths || !admitted(asEngineRoute(args))) return false;
  const engine = command === "aidlc.cmd" ? "launcher" : installedEngine(name);
  // cmd.exe parses a .cmd launcher's arguments again, where these characters
  // expand variables or start another command.
  return engine === "executable" ||
    (engine === "launcher" && args.every((arg) => arg !== "" && !/["%&<>^|!\r\n]/.test(arg)));
}

// The same diagnostics through their source tools (aidlc-doctor.ts,
// aidlc-utility.ts), which the unified entry point dispatches to.
function isReadOnlyToolDiagnostic(stem: string, args: readonly string[]): boolean {
  if (stem === "doctor") return args[0] === "doctor" && isReadOnlyDiagnostic(args);
  return stem === "utility" &&
    (args[0] === "status" || args[0] === "version" || (args[0] === "now" && args.length === 1));
}

// Construction entry choices the person makes before the first Unit's plan
// exists. On a scope whose first Construction stage is Code Generation
// (express, for one) they are recorded while this guard is already watching.
const CONSTRUCTION_ENTRY_SETTERS = new Set([
  "set-construction-checkpoints",
  "set-construction-execution",
  "set-construction-iteration",
  "set-construction-verification-command",
]);

// The durable state holds the Code Generation completion gate open: the stage
// is still current and its checkbox reads awaiting-approval.
function codeGenerationGateHeld(state: string): boolean {
  return normalizeStageName(getField(state, "Current Stage") ?? "") === GUARDED_STAGE &&
    parseCheckboxes(state).some(
      (entry) => entry.slug === GUARDED_STAGE && entry.state === "awaiting-approval",
    );
}

// What the engine names while a plan waits, other than building it: steps that
// change nothing a plan governs, admitted at any time, and moves a person asks
// for (`asked`), admitted once a person has spoken since the last decision.
// Each is matched on `engine <noun> <verb>`; `admits` checks what follows the
// noun. Code stays held for the approved plan either way.
interface EngineDirectedRoute {
  noun: string;
  verbs?: readonly string[];
  asked?: true;
  admits?: (afterNoun: readonly string[]) => boolean;
}

// Only these flags, each with its value.
function onlyFlags(args: readonly string[], allowed: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split("=", 2);
    if (!allowed.includes(flag)) return false;
    if (inline === undefined) i++;
  }
  return true;
}

// The settings a scope or setting change the person asked for may carry. Guard
// Policy, plan approval and the person's checks keep their own switch rules.
const PLAN_WAIT_SETTINGS = ["depth", "test-strategy", "review", "sensors", "learnings", "collaborators"] as const;
const PLAN_WAIT_SETTING_FLAGS = PLAN_WAIT_SETTINGS.map((setting) => `--${setting}`);

const ENGINE_DIRECTED_WHILE_PLAN_WAITS: readonly EngineDirectedRoute[] = [
  // The review brief and the stage's own question rows (a checkpoint row keeps
  // its own rule).
  { noun: "review-brief", verbs: ["review", "context", "summary"] },
  {
    noun: "log", verbs: ["decision", "answer"],
    admits: (afterNoun) =>
      lastFlagValue(afterNoun.slice(1), "--stage") === GUARDED_STAGE &&
      !afterNoun.some((arg) => arg === "--checkpoint" || arg.startsWith("--checkpoint=")),
  },
  // Status and help as the engine prints them.
  { noun: "status" },
  { noun: "orchestrate", verbs: ["help"] },
  // The resume menu's choice: it only names the move, which is judged itself.
  {
    noun: "orchestrate", verbs: ["report"],
    admits: (afterNoun) =>
      lastFlagValue(afterNoun.slice(1), "--result") === "resumed" && !afterNoun.includes("--stage"),
  },
  // Moves the person asked for: a jump, a skip or add, new work, what the
  // folder is, and the scan that follows it.
  { noun: "jump", verbs: ["execute", "reopen"], asked: true },
  { noun: "recompose", asked: true, admits: (afterNoun) => onlyFlags(afterNoun, ["--skip", "--add", "--reason"]) },
  // A scope or setting change, which keeps the plan's question open.
  {
    noun: "scope", verbs: ["change"], asked: true,
    admits: (afterNoun) => onlyFlags(afterNoun.slice(1), ["--scope", ...PLAN_WAIT_SETTING_FLAGS]),
  },
  {
    noun: "config", verbs: ["set"], asked: true,
    admits: (afterNoun) =>
      (PLAN_WAIT_SETTINGS as readonly string[]).includes(afterNoun[1] ?? "") && afterNoun[2] !== undefined &&
      onlyFlags(afterNoun.slice(3), PLAN_WAIT_SETTING_FLAGS),
  },
  { noun: "intent", verbs: ["create"], asked: true },
  { noun: "workspace", verbs: ["reclassify", "codekb-scope-diff"], asked: true },
  // A review the person asks for: its request and its verdict.
  { noun: "log", verbs: ["review"], asked: true },
];

function engineDirectedWhilePlanWaits(args: readonly string[], personAsked: () => boolean): boolean {
  if (args[0] !== "engine") return false;
  const [noun, verb] = [args[1], args[2]];
  return ENGINE_DIRECTED_WHILE_PLAN_WAITS.some((route) =>
    route.noun === noun &&
    (route.verbs === undefined || route.verbs.includes(verb ?? "")) &&
    (route.admits === undefined || route.admits(args.slice(2))) &&
    (route.asked !== true || personAsked()));
}

// The engine's last step is current and was delivered as issued, and it is not
// its recovery question, whose own picked remedy is the one move it carries out
// (guardRecoveryAnswerAdmits). A step gone stale or superseded since names
// nothing the person's earlier words still ask for: `next` names the step now.
// Parked work's last step is the park, which no issued step outlives: what the
// person types over it is theirs to make, and `next` names it.
function lastStepAdmitsPersonsMoves(projectDir: string): boolean {
  try {
    const state = readFileSync(stateFilePath(projectDir), "utf-8");
    if ((getField(state, "Parked") ?? "").trim().length > 0) return true;
    const marker = readActiveDirectiveMarker(projectDir, state);
    return marker !== null && marker.delivery !== "superseded" &&
      !(marker.kind === "ask" && marker.ask_type === GUARD_RECOVERY_ASK_TYPE);
  } catch {
    return false;
  }
}

// Everything admitted while a plan waits, in one place: the prerequisites
// below, the open question's own answers, read-only diagnostics, a recorded
// switch, and what the engine names.
function planWaitAdmits(
  projectDir: string,
  engineArgs: string[],
  gateHeld: boolean,
  askAdmits: (engineArgs: readonly string[]) => boolean,
): boolean {
  const personSpoke = () => personSpokeSinceGate(projectDir, { requests: true });
  return isPlanApprovalPrerequisite(engineArgs, gateHeld, personSpoke) ||
    askAdmits(engineArgs) || isReadOnlyDiagnostic(engineArgs) || recordedSwitchChangeAdmitted(projectDir, engineArgs) ||
    chatSwitchChangeAdmitted(projectDir, engineArgs) ||
    engineDirectedWhilePlanWaits(engineArgs, () => personSpoke() && lastStepAdmitsPersonsMoves(projectDir));
}

function isPlanApprovalPrerequisite(
  args: string[],
  gateHeld = false,
  personSpoke: () => boolean = () => false,
): boolean {
  if (args[0] !== "engine") return false;
  // Direct refusals can offer the abort or the fence switch without publishing
  // a selection marker. The strict drift ask in this hook prints
  // config set guard.plan-approval off. Preserve the trusted source-tool
  // recovery route in native installs:
  // conductor-prose-obtained consent remains the trust boundary for abort.
  // A mistaken abort --discard parks work for aidlc engine worktree restore
  // --slug <slug>; a mechanical selection receipt remains a future candidate.
  // isSelectedGuardRestartContinuation verifies the published restart choice.
  if (isGuardRecoveryEngineInvocation(args)) return true;

  const noun = args[1];
  const verb = args[2];
  // The conductor re-enters through next on each human turn, and continue
  // delivers the remaining stage rules. Requiring approval for that transport
  // traps installations before they can finish presenting or answering it.
  // Lifecycle reports and generation remain subject to the approval guard.
  if (noun === "orchestrate" && (verb === "next" || verb === "continue")) {
    return true;
  }
  // Stopping for now and coming back are the person's call at any point, and
  // the engine names both commands itself. They record the stop in the state
  // and audit only; after unpark the build still waits for the directive next
  // issues and the plan's recorded approval.
  if (noun === "orchestrate" && verb === "park") return true;
  if (noun === "state" && verb === "unpark") return true;
  // The open Code Generation gate belongs to the human. Opening it moved the
  // state past the issued directive, so no current directive can name a target
  // any more, and the human's answer is the only move left. The engine requires
  // that exact answer and generates nothing for it: approval completes the
  // stage, Request Changes retires the Plan Approval. Any other report, and any
  // workspace change while the gate is open, still needs a current directive.
  if (noun === "orchestrate" && verb === "report" && gateHeld) {
    const routeArgs = args.slice(3);
    return (
      lastFlagValue(routeArgs, "--stage") === GUARDED_STAGE &&
      ["approved", "rejected"].includes(lastFlagValue(routeArgs, "--result") ?? "")
    );
  }
  // reply only reads what the human-turn hook recorded; the conductor needs it
  // before approval on harnesses that never show the hook's notice. restore
  // writes back only the files the person approved, so their approval holds.
  if (
    noun === "testing-posture" &&
    ["resolve", "render", "fingerprint", "verify", "reply", "restore"].includes(verb)
  ) {
    return true;
  }
  // The runtime summary only reads runtime-graph.json and the state file.
  // Refusing it sent planning agents into retries before the plan existed.
  if (noun === "runtime" && verb === "summary") return true;
  // Both only read the audit trail. Refusing them before the plan exists
  // would send planning agents into retries, as with the runtime summary.
  if (noun === "log" && verb === "answers") return true;
  if (noun === "audit" && verb === "history") return true;
  // Checkpoint review owns its own audit/readiness/human authority. It must
  // remain reachable after the engine replaces invoke-swarm with its gate
  // successor, including when Request Changes retired the old Plan Approval.
  // Verification executes a supplied command and still requires approval.
  if (noun === "bolt" && (verb === "checkpoint" || verb === "swarm-checkpoint")) {
    const routeArgs = args.slice(3);
    const action = lastFlagValue(routeArgs, "--action");
    return action === null
      ? !routeArgs.includes("--action")
      : ["status", "ask", "approve", "reject"].includes(action);
  }
  // Unit lifecycle receipts and the Construction entry choices record what the
  // person decided and what the Unit did; none writes workspace source. The
  // protocol records `unit start` before the Unit's plan exists, so refusing it
  // here left the documented native form refused while the per-tool form
  // passed (#1387) and Units without the receipts the team gate needs (#1289).
  // Completing a Unit settles it, so before approval that is only the recovery
  // remedy the person picked (guardRecoveryAnswerAdmits).
  if (noun === "state" && verb === "unit") {
    return ["start", "pause", "resume"].includes(args[3] ?? "");
  }
  if (noun === "state" && CONSTRUCTION_ENTRY_SETTERS.has(verb)) return true;
  if (noun === "bolt" && verb === "set-autonomy") return true;
  // Plan approval on or off for this piece of work is the person's call, said
  // in their own words. On only adds the stop; off is carried out when a person
  // has spoken since the last decision, so the conductor runs what they asked.
  if (
    noun === "config" && verb === "set" && args.length === 5 &&
    ["plan-approval", "guard.plan-approval"].includes(args[3] ?? "") &&
    (args[4] === "on" || (args[4] === "off" && personSpoke()))
  ) {
    return true;
  }
  // Recording the remedy the person picked on the engine's recovery question
  // writes nothing in the workspace; the picked remedy is admitted after it.
  if (noun === "log" && verb === "answer" && lastFlagValue(args.slice(3), "--checkpoint") === "guard-recovery") {
    return true;
  }
  // The walking-skeleton stance is the same kind of entry choice, recorded
  // through report without a stage result.
  if (noun === "orchestrate" && verb === "report") {
    const routeArgs = args.slice(3);
    return (SKELETON_STANCES as readonly string[]).includes(lastFlagValue(routeArgs, "--skeleton-stance") ?? "") &&
      !routeArgs.includes("--result") && !routeArgs.includes("--stage");
  }
  // Generation start refuses itself without the human's receipt-backed
  // approval, so the owner answers with the precise reason.
  if (noun === "testing-posture" && verb === "begin") return true;
  if (noun !== "log" || (verb !== "decision" && verb !== "answer")) return false;

  const routeArgs = args.slice(3);
  return (
    lastFlagValue(routeArgs, "--stage") === GUARDED_STAGE &&
    lastFlagValue(routeArgs, "--checkpoint") === "plan-approval"
  );
}

function isSelectedGuardRestartContinuation(
  projectDir: string,
  cwd: string,
  command: string,
  state: string,
  marker: ActiveDirectiveMarker | null,
): boolean {
  const continuation = parseGuardRestartContinuationCommand(command, { harnessDir: harnessDir() });
  // The source spelling names a script: it must be the installed tool itself.
  const script = command.split(" ")[1] ?? "";
  if (
    continuation === null ||
    (command.startsWith("bun ") && !isTrustedToolFile(projectDir, cwd, script)) ||
    marker?.version !== 2 ||
    marker.kind !== "ask" ||
    marker.ask_type !== GUARD_RECOVERY_ASK_TYPE ||
    marker.state_present !== true ||
    marker.needs_rehydrate !== false ||
    // An issued ask becomes consumed only when its human selection is recorded.
    marker.delivery !== "consumed" ||
    marker.guard_recovery_response?.status !== "ready" ||
    marker.guard_recovery_response.feedback_sha256 !== undefined
  ) return false;

  const selected = marker.remedies?.filter(
    (remedy) => remedy.op === marker.guard_recovery_response?.selected_op,
  ) ?? [];
  if (
    selected.length !== 1 ||
    selected[0].interaction !== "command" ||
    !sameGuardOperation(selected[0].operation, continuation.operation) ||
    !guardOperationMatchesRemedy(
      continuation.operation, selected[0].op, marker.stage, marker.unit,
    ) ||
    continuation.scope !== getField(state, "Scope")
  ) return false;

  const scope = loadScopeMapping()[continuation.scope];
  if (!scope) return false;
  const graph = loadStageGraph();
  const target = continuation.operation.stage;
  const current = getField(state, "Current Stage");
  const targetIndex = graph.findIndex((stage) => stage.slug === target);
  const currentIndex = graph.findIndex((stage) => stage.slug === current);
  if (
    targetIndex < 0 || currentIndex < 0 || targetIndex > currentIndex ||
    graph[targetIndex].phase === "initialization"
  ) return false;
  const checkboxes = parseCheckboxes(state);
  if (
    checkboxes.filter((entry) => entry.slug === target).length !== 1 ||
    checkboxes.filter((entry) => entry.slug === current).length !== 1 ||
    (parseStateStageSuffixes(state).get(target) ?? scope.stages[target]) !== "EXECUTE"
  ) return false;

  // Match aidlc-jump resolve's graph-order calculation, not the caller's
  // claimed direction. A selection cannot turn a forward move into a reset.
  return continuation.direction === (targetIndex === currentIndex ? "redo" : "backward");
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
  executableResolutionChanged = false,
  dataDriven = false,
  wrapped = false,
  gateHeld = false,
  enginePaths = false,
  askAdmits: (engineArgs: readonly string[]) => boolean = () => false,
): boolean {
  const admitted = (engineArgs: string[]): boolean => planWaitAdmits(projectDir, engineArgs, gateHeld, askAdmits);
  if (isNativePlanApprovalPrerequisite(name, args, admitted, enginePaths)) {
    // A wrapper (env -C, sudo -D, xargs) can run it against another directory
    // than the one these admissions were judged for.
    return !executableResolutionChanged && !dataDriven && !wrapped;
  }
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
  const unifiedEntryPoint = basename(absolute) === "aidlc.ts";
  const toolStem = unifiedEntryPoint
    ? null
    : /^aidlc-([A-Za-z0-9._-]+)\.ts$/.exec(basename(absolute))?.[1] ?? null;
  if (
    relative(trustedToolsDir, dirname(absolute)) !== "" ||
    (!unifiedEntryPoint && toolStem === null)
  ) {
    return false;
  }
  // The installed Bun entry point dispatches both planning and mutation routes.
  // Give it the native planning exceptions only, after checking the interpreter
  // and arguments. Wrappers may change cwd after parsing, so require a direct
  // invocation. The same real-file/no-symlink boundary below still applies.
  const toolArgs = args.slice(scriptIndex + 1);
  if (
    unifiedEntryPoint &&
    (
      !["bun", "bun.exe"].includes(name.toLowerCase()) ||
      wrapped ||
      executableResolutionChanged ||
      dataDriven ||
      !(admitted(asEngineRoute(toolArgs)) || isReadOnlyDiagnostic(toolArgs))
    )
  ) {
    return false;
  }
  // A per-tool script gets the verdict of the engine route it implements:
  // `aidlc-<route>.ts <args>` is judged as `engine <route> <args>`, so one
  // operation is never refused in one spelling and allowed in the other (#1387).
  // It runs as a direct invocation of the installed Bun, by name or by the
  // same absolute path this hook runs under (the engine's own spelling), with
  // no wrapper, data-driven argument, or changed executable resolution.
  if (
    toolStem !== null &&
    (
      !(["bun", "bun.exe"].includes(name.toLowerCase()) || isThisBun(name)) ||
      wrapped ||
      executableResolutionChanged ||
      dataDriven ||
      (!admitted(["engine", toolStem, ...toolArgs]) && !isReadOnlyToolDiagnostic(toolStem, toolArgs))
    )
  ) {
    return false;
  }
  return isTrustedToolFile(projectDir, cwd, script);
}

// The Bun binary running this hook, named by absolute path. Compared by file
// identity, so Windows spellings of the same file agree: backslashes or
// forward slashes, drive-letter and other case, and `bun` for `bun.exe` (which
// Windows resolves the same way). Any other file, even another Bun, is not it.
function isThisBun(name: string): boolean {
  if (!isAbsolute(name)) return false;
  const candidates = process.platform === "win32" && !/\.exe$/i.test(name)
    ? [name, `${name}.exe`]
    : [name];
  return candidates.some((candidate) => {
    if (sameFileIdentity(candidate, process.execPath)) return true;
    try {
      const actual = realpathSync(candidate);
      const expected = realpathSync(process.execPath);
      return process.platform === "win32"
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected;
    } catch {
      return false;
    }
  });
}

// The script is a real file in this harness's installed tools directory, with
// no symlink anywhere in its path, so the installed tool is what runs.
function isTrustedToolFile(projectDir: string, cwd: string, script: string): boolean {
  if (!script) return false;
  const projectLexical = resolve(projectDir);
  const absolute = isAbsolute(script) ? resolve(script) : resolve(cwd, script);
  const trustedToolsDir = resolve(projectLexical, harnessDir(), "tools");
  if (relative(trustedToolsDir, dirname(absolute)) !== "") return false;
  try {
    const projectReal = realpathSync(projectLexical);
    assertNoSymlinkInChainOrThrow(
      projectReal,
      relative(projectLexical, absolute),
    );
    // Windows realpath can preserve caller casing. For a case-only spelling
    // difference, require the same directory identity as well: a distinct
    // case-sensitive directory must not inherit the installed tool's authority.
    if (dirname(absolute) !== trustedToolsDir &&
      !sameDirectoryIdentity(dirname(absolute), trustedToolsDir)) return false;
    return lstatSync(absolute).isFile() && !lstatSync(absolute).isSymbolicLink();
  } catch {
    return false;
  }
}

function shellInvocationNeedsApproval(
  projectDir: string,
  cwd: string,
  invocation: {
    name: string;
    args: string[];
    executable?: string;
    launchers?: string[];
    dataDriven?: boolean;
    executableResolutionChanged?: boolean;
  },
  hasConcreteTargets: boolean,
  rawCommand: string,
  gateHeld = false,
  dialect: ShellDialect = POSIX_DIALECT,
  askAdmits: (engineArgs: readonly string[]) => boolean = () => false,
): boolean {
  const name = normalizedCommandName(invocation.name);
  const executable = invocation.executable ?? invocation.name;
  const unwrapped = (invocation.launchers?.length ?? 0) === 0 &&
    !invocation.dataDriven && !invocation.executableResolutionChanged;
  const admitted = (engineArgs: string[]): boolean => planWaitAdmits(projectDir, engineArgs, gateHeld, askAdmits);
  if (
    dialect.pathsAsWritten && /[\\/]/.test(executable) &&
    !isNativePlanApprovalPrerequisite(executable, invocation.args, admitted, true)
  ) return true;
  if (name === "cd" || (dialect.powerShell && POWERSHELL_SET_LOCATION.has(name))) {
    // The shared lexer is intentionally not a full Bash parser. Do not grant
    // this exception where its whitespace/continuation decoding differs.
    if (/[^\S \t\n]/u.test(rawCommand) || rawCommand.includes("\\\n")) return true;
    // A literal, absolute return to the current directory changes no execution
    // context. Keep every actual cwd change, wrapper and dynamic operand opaque.
    const args = invocation.args[0] === "--" ||
        (dialect.powerShell && /^-(?:literal)?path$/i.test(invocation.args[0] ?? ""))
      ? invocation.args.slice(1)
      : invocation.args;
    const target = args[0];
    const direct = unwrapped && (dialect.powerShell
      ? ["cd", ...POWERSHELL_SET_LOCATION].includes(executable.toLowerCase())
      : executable === "cd");
    if (!direct || args.length !== 1 || !target || !isAbsolute(target) ||
      ["*", "?", "[", "]", "{", "}"].some((part) => target.includes(part)) ||
      target.split(/[\\/]+/).some((part) => part === "." || part === "..")) return true;
    const current = resolve(cwd);
    const destination = resolve(target);
    return relative(current, destination) !== "" ||
      !sameDirectoryIdentity(current, destination);
  }
  if (dialect.powerShell && READ_ONLY_POWERSHELL_CMDLETS.has(name)) {
    // A path, extension or wrapper would name some other program.
    return executable.toLowerCase() !== name || !unwrapped;
  }
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
  if (
    isFrameworkToolInvocation(
      projectDir,
      cwd,
      invocation.executable ?? invocation.name,
      invocation.args,
      invocation.executableResolutionChanged,
      invocation.dataDriven,
      (invocation.launchers?.length ?? 0) > 0,
      gateHeld,
      dialect.enginePaths,
      askAdmits,
    )
  ) {
    return false;
  }
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

function swarmCommandUnits(
  projectDir: string,
  cwd: string,
  command: string,
  invocations: Array<{
    name: string; args: string[]; executable?: string; launchers?: string[];
    dataDriven?: boolean; executableResolutionChanged?: boolean; ambiguous?: boolean;
  }>,
): string[] | null {
  // A direct literal invocation keeps its project and targets inspectable.
  // Assignments, wrappers and additional commands retain opaque-shell policy.
  if (invocations.length !== 1 ||
    !/^\s*(?:aidlc(?:\.exe)?|bun(?:\.exe)?)\s/i.test(command)) return null;
  const invocation = invocations[0];
  if (invocation.ambiguous || invocation.dataDriven || invocation.executableResolutionChanged ||
    invocation.launchers?.length) return null;
  const executable = (invocation.executable ?? invocation.name).toLowerCase();
  let args = invocation.args;
  if (executable === "bun" || executable === "bun.exe") {
    const scriptIndex = args[0] === "run" ? 1 : 0;
    const script = args[scriptIndex];
    if (!script || script.startsWith("-")) return null;
    const entry = resolve(cwd, script);
    if (basename(entry) !== "aidlc.ts" ||
      dirname(entry) !== resolve(projectDir, harnessDir(), "tools")) return null;
    try {
      assertNoSymlinkInChainOrThrow(realpathSync(projectDir), relative(resolve(projectDir), entry));
      if (!lstatSync(entry).isFile() || lstatSync(entry).isSymbolicLink()) return null;
    } catch {
      return null;
    }
    args = args.slice(scriptIndex + 1);
  } else if (executable !== "aidlc" && executable !== "aidlc.exe") {
    return null;
  }
  if (args[0] !== "engine" || args[1] !== "swarm") return null;
  const verb = args[2];
  if (verb !== "prepare" && verb !== "check" && verb !== "finalize") return null;
  const valueFlags = {
    prepare: ["--project-dir", "--intent", "--space", "--repo", "--batch", "--units",
      "--base", "--concurrency", "--degraded-from"],
    check: ["--project-dir", "--unit", "--check-cmd", "--test-file"],
    finalize: ["--project-dir", "--batch", "--units", "--claimed", "--check-cmd", "--test-file", "--reasons"],
  }[verb];
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 3; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const key = equal < 0 ? arg : arg.slice(0, equal);
    if (flags.has(key)) return [];
    if (verb === "prepare" && key === "--resume-existing") {
      if (equal >= 0 && arg.slice(equal + 1) !== "true") return [];
      flags.set(key, "true");
      continue;
    }
    if (!valueFlags.includes(key)) return [];
    const value = equal >= 0 ? arg.slice(equal + 1) : args[++index];
    if (value === undefined || value.startsWith("--") ||
      (value === "" && key !== "--claimed" && key !== "--reasons")) return [];
    flags.set(key, value);
  }
  try {
    const pathKey = (path: string): string => {
      const canonical = realpathSync(path).replaceAll("\\", "/");
      return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    };
    const selectedProject = flags.get("--project-dir") ??
      process.env.AIDLC_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? cwd;
    if (pathKey(resolve(cwd, selectedProject)) !== pathKey(projectDir)) return [];
    if (flags.has("--intent") || flags.has("--space")) {
      const active = resolveWorkflowSelection(projectDir);
      const selected = resolveWorkflowSelection(projectDir, {
        intent: flags.get("--intent"), space: flags.get("--space"),
      });
      if (active.intent !== selected.intent || active.space !== selected.space) return [];
    }
  } catch {
    return [];
  }
  const names = (value: string): string[] | null => {
    const units = value.split(",").map((unit) => unit.trim());
    return units.length > 0 && units.every(Boolean) && new Set(units).size === units.length ? units : null;
  };
  if (verb === "check") {
    if (positional.length > 1 || (positional.length > 0 && flags.has("--unit"))) return [];
    const unit = positional[0] ?? flags.get("--unit");
    return unit && !unit.includes(",") ? [unit] : [];
  }
  if (positional.length > (verb === "finalize" && !flags.has("--batch") ? 1 : 0)) return [];
  const units = names(flags.get("--units") ?? (verb === "finalize" ? flags.get("--claimed") ?? "" : ""));
  if (!units) return [];
  const claimedValue = flags.get("--claimed");
  if (verb === "finalize" && claimedValue !== undefined) {
    const claimed = claimedValue === "" ? [] : names(claimedValue);
    if (!claimed?.every((unit) => units.includes(unit))) return [];
  }
  return units;
}

async function mutationIntent(
  projectDir: string,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  cwd: string,
  state: string,
  activeDirective: ActiveDirectiveMarker | null,
  powerShellHint = false,
): Promise<MutationIntent> {
  let targets: string[] = [];
  let opaqueShell = false;
  let shellCommand: string | null = null;
  let swarmUnits: string[] | null = null;
  let runsAidlc = false;
  if (toolName === "Bash") {
    const command = toolInput?.command;
    if (typeof command !== "string") {
      return { targets: [], opaqueShell: false, shellCommand: null };
    }
    shellCommand = command;
    if (isSelectedGuardRestartContinuation(projectDir, cwd, command, state, activeDirective)) {
      return { targets: [], opaqueShell: false, shellCommand };
    }
    const {
      shellCommandAltersExecutableResolution,
      shellCommandInvocationDetails,
      shellWriteTargets,
    } = await import("./aidlc-review-freeze.ts");
    // A command the adapter ran in PowerShell is read as PowerShell when it is
    // plain. Anything else, and every unhinted command, keeps the POSIX
    // reading: Bash drops the backslashes a Windows path is written with.
    // An unhinted shell may not be PowerShell, so it never gets the cmdlets
    // or Set-Location.
    const powerShellCommand = powerShellHint
      ? powerShellReading(command, shellCommandInvocationDetails)
      : null;
    const analysed = powerShellCommand ?? command;
    const dialect: ShellDialect = {
      powerShell: powerShellCommand !== null,
      pathsAsWritten: powerShellCommand !== null,
      enginePaths: powerShellCommand !== null || process.platform === "win32",
    };
    targets = shellWriteTargets(analysed, cwd);
    const invocations = shellCommandInvocationDetails(analysed);
    const dynamic =
      shellUsesDynamicEvaluation(analysed) ||
      shellCommandAltersExecutableResolution(analysed);
    const gateHeld = codeGenerationGateHeld(state);
    // While the engine's recovery question is open, the commands that carry out
    // an answer it offers are that answer's transport, not work (#1317).
    const askAdmits = (engineArgs: readonly string[]): boolean =>
      guardRecoveryAnswerAdmits(activeDirective, engineArgs, projectDir);
    opaqueShell =
      dynamic ||
      invocations.some((invocation) =>
        shellInvocationNeedsApproval(
          projectDir, cwd, invocation, targets.length > 0, analysed, gateHeld, dialect, askAdmits,
        )
      );
    if (!dynamic && targets.length === 0) {
      swarmUnits = swarmCommandUnits(projectDir, cwd, analysed, invocations);
    }
    runsAidlc = invocations.some((invocation) =>
      normalizedCommandName(invocation.name).replace(/\.(?:cmd|ps1)$/, "") === "aidlc" ||
      invocation.args.some((arg) => /^aidlc(?:-[A-Za-z0-9._-]+)?\.ts$/.test(basename(arg)))) ||
      (dynamic && /\baidlc\b/i.test(analysed));
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
    ...(swarmUnits ? { swarmUnits } : {}),
    ...(runsAidlc ? { runsAidlc } : {}),
  };
}

// --- Main ---------------------------------------------------------------------

// The off-switch is deterministic but no longer silent: while a workflow exists,
// the first tool call that passes under it appends one GUARD_DISABLED row, and
// consecutive calls append nothing until some other row lands in the active
// shard. Every failure in this bookkeeping still allows the call.
function recordGuardDisabled(input: string): void {
  const projectDir = resolveProjectDirFromHook(import.meta.url);
  if (!existsSync(stateFilePath(projectDir))) return;
  let toolName = "";
  try {
    const raw: unknown = JSON.parse(input);
    if (isClaudeCodeHookInput(raw) && typeof raw.tool_name === "string") {
      toolName = raw.tool_name;
    }
  } catch {
    // The row still says the guard was off; the tool name is best-effort.
  }
  const shardPath = auditFilePath(projectDir);
  if (existsSync(shardPath)) {
    const blocks = readFileSync(shardPath, "utf-8")
      .replace(/\r\n/g, "\n")
      .split(/\n---\n/);
    for (let index = blocks.length - 1; index >= 0; index--) {
      const event = auditBlockField(blocks[index], "Event");
      if (event === null) continue;
      if (event === "GUARD_DISABLED" && auditBlockField(blocks[index], "Guard") === HOOK_NAME) {
        return;
      }
      break;
    }
  }
  if (!acquireAuditLock(projectDir, 5, 50)) return;
  try {
    appendAuditEntryUnlocked(
      "GUARD_DISABLED",
      { Guard: HOOK_NAME, Tool: toolName || "(unknown)" },
      projectDir,
    );
  } finally {
    releaseAuditLock(projectDir);
  }
}

export async function run(input: string): Promise<number> {
  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(input);
    if (!isClaudeCodeHookInput(raw)) return 0;
    parsed = raw;
  } catch {
    return 0; // malformed stdin - fail open
  }
  const workflow = enterHookWorkflow(resolveProjectDirFromHook(import.meta.url), parsed.session_id);
  try {
    return await evaluate(parsed, input, workflow);
  } finally {
    workflow.restore();
  }
}

async function evaluate(
  parsed: ClaudeCodeHookInput,
  input: string,
  workflow: ReturnType<typeof enterHookWorkflow>,
): Promise<number> {
  // Runtime integrity is not a fence and cannot be disabled with this hook.
  if (refuseRuntimeIntegrityViolation(parsed)) return 2;

  // A conversation that has not joined the selected workflow is not held to its
  // Plan Approval: its ordinary edits pass as in a workspace with no workflow.
  // Dispatching that workflow's developer is joining it without saying so, and
  // is refused until the conversation selects the intent.
  if (hookOutsideGate(workflow)) {
    const dispatchInput = parsed.tool_input ?? {};
    if (!DISPATCH_TOOLS.has(parsed.tool_name ?? "") || dispatchInput.subagent_type !== GUARDED_AGENT) return 0;
    // `next` asks which work this is, so the record's name stays out of the
    // refusal: a record from a clone is a teammate's, and its name can carry
    // words addressed to the agent.
    process.stderr.write(
      "AI-DLC: this conversation has not joined the selected workflow, so it cannot dispatch that " +
        `workflow's developer. Run ${nextOnItsOwn()}: it asks the person which piece of work this ` +
        "conversation is for. Dispatch again once it has joined.\n",
    );
    return 2;
  }

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  // The heartbeat says the host ran this hook, so it comes before the off
  // switch: a fence switched off never looks like a host running no hooks.
  try {
    const healthDir = hooksHealthDir(projectDir);
    writeHookStatusFile(healthDir, `${HOOK_NAME}.last`, isoTimestamp());
  } catch {
    // Heartbeat failure is non-fatal - never let it affect the decision.
  }

  // Deterministic off-switch: the Plan Approval fence is disabled, recorded once.
  if (resolveProjectFlag("AIDLC_DISABLE_PLAN_APPROVAL_GUARD") === "1") {
    try {
      recordGuardDisabled(input);
    } catch {
      // Fail-open: disabled fence bookkeeping does not refuse the call.
    }
    return 0;
  }

  // A TTY means no harness JSON is coming (test / debug contexts) - allow.
  if (process.stdin.isTTY) return 0;


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

  let state: string | null = null;
  let verdict: PlanApprovalVerdict;
  let units: UnitEvidence[] = [];
  let authorityFailure: string | null = null;
  // Where the person's approval stands while the directive naming its target
  // is stale or still the question: the refusal says so (see authorityRemedy).
  let standing: PlanStanding | null = null;
  // The targets the current step builds, so a refusal names their exact brief.
  let briefTargets: BriefTargets | null = null;
  // The person's answer to the open Plan Approval question, when one is recorded.
  let asked: ReturnType<typeof planApprovalAskState> = null;
  // What is wrong with the developer handoff itself, said only once the plan it
  // hands over may be built: before that, the `brief` it would name refuses too.
  let handoffDefect: HandoffDefect | null = null;
  let rulesArriving: string | null = null;
  // Plain sentences: some hosts (Codex) show a hook's refusal to the person as
  // it is written. A path or command the reason quotes stays on the one line.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing them is the point
  const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  const refuseProvenanceFailure = (reason: string): number => {
    recordHookDrop(projectDir, HOOK_NAME, reason);
    process.stderr.write(
      `Code Generation source provenance could not be committed. ${oneLine(reason)} Repair the source or runtime/audit write problem and retry; the plan-approval setting is unchanged.\n`,
    );
    return 2;
  };
  // `lead` false: the reason is already a whole refusal that says what cannot happen.
  // `settingNote` false: a question waiting on the person, where the setting is not in play.
  const refuseExecutionIneligible = (reason: string, lead = true, settingNote = true): number => {
    process.stderr.write(
      `${lead ? "Code Generation cannot start: " : ""}${oneLine(reason).trim().replace(/\.*$/, ".")}${
        settingNote ? " The plan-approval setting is unchanged." : ""
      }\n`,
    );
    return 2;
  };
  let blockedMutation: {
    target: string;
    unit: string | null;
    opaqueShell: boolean;
    detail: string | null;
  } | null = null;
  try {
    const statePath = stateFilePath(projectDir);
    if (!existsSync(statePath)) return 0; // no workflow - fail open
    state = readFileSync(statePath, "utf-8");
    const currentStage = getField(state, "Current Stage") ?? "";
    const activeDirective = readActiveDirectiveMarker(projectDir, state);
    const durableStage = normalizeStageName(currentStage);
    const directiveStage = normalizeStageName(activeDirective?.stage ?? "");
    const issuance = activeDirective?.version === 2 && directiveStage === GUARDED_STAGE
      ? codeGenerationIssuance(activeDirective)
      : null;
    if (issuance !== null) briefTargets = issuanceTargets(issuance);
    const dispatchPrompt = [toolInput.prompt, toolInput.description]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    const explicitPlanDispatch =
      promptUnitMarkers(dispatchPrompt).length > 0 ||
      promptStageMarkers(dispatchPrompt).length > 0 ||
      promptTestingContractMarkers(dispatchPrompt).length > 0;
    // A run of another stage on its own while Code Generation is current (the
    // Reverse Engineering a person asked for once the folder turned out to hold
    // existing code): its steps and its writes inside AI-DLC's own folder are
    // that stage's work; a write to the workspace source still waits for the
    // approved plan.
    const otherStageRunning = activeDirective?.version === 2 && activeDirective.kind === "run-stage" &&
      directiveStage !== "" && directiveStage !== GUARDED_STAGE;
    const codeGenerationRelevant =
      directiveStage === GUARDED_STAGE ||
      durableStage === GUARDED_STAGE ||
      (guardedDispatch && explicitPlanDispatch);
    if (!codeGenerationRelevant) return 0;
    const knownMutationTool =
      toolName === "Bash" || WRITE_TOOLS.has(toolName);
    const mutation: MutationIntent = guardedDispatch
      ? { targets: [], opaqueShell: false, shellCommand: null }
      : knownMutationTool
        ? await mutationIntent(
            projectDir, toolName, toolInput, cwd, state, activeDirective,
            // Set by the adapter that ran the tool, outside the agent's input.
            parsed.aidlc_shell === "powershell",
          )
        : {
            targets: [],
            opaqueShell: true,
            shellCommand: `unknown mutation-capable tool: ${toolName}`,
          };
    if (!guardedDispatch && mutation.targets.length === 0 && !mutation.opaqueShell) {
      return 0;
    }
    if (
      otherStageRunning && directiveStage !== GUARDED_STAGE && !guardedDispatch && knownMutationTool &&
      mutation.targets.every((candidate) => isStageRecordOutput(projectDir, candidate))
    ) {
      return 0;
    }
    // A file-tool write of the composer's proposal alone passes in every Plan
    // Approval state, before the directive checks, and never starts
    // generation. A shell write, or one that also names another file, is
    // judged below as before.
    if (
      WRITE_TOOLS.has(toolName) &&
      !mutation.opaqueShell &&
      mutation.targets.length > 0 &&
      mutation.targets.every((candidate) => isComposerProposalTarget(projectDir, candidate))
    ) {
      return 0;
    }
    // A file-tool write of a person's answer text, for the log to read with no
    // shell on the way, passes in every Plan Approval state too.
    if (
      WRITE_TOOLS.has(toolName) &&
      !mutation.opaqueShell &&
      mutation.targets.length > 0 &&
      mutation.targets.every((candidate) => isAnswerTextTarget(projectDir, candidate))
    ) {
      return 0;
    }

    rulesArriving = codeGenerationRulesArrivingReason(activeDirective);
    if (
      activeDirective?.version !== 2 ||
      directiveStage !== GUARDED_STAGE
    ) {
      authorityFailure = NO_CURRENT_DIRECTIVE;
      verdict = { block: true, mentioned: [] };
    } else if (rulesArriving !== null) {
      // The plan may be approved, but the run-stage that says how to build has
      // not reached the agent yet: nothing is built or dispatched before it.
      verdict = { block: true, mentioned: [] };
    } else {
      const recordDir = docsRoot(projectDir);
      units = gatherApprovalEvidence(projectDir, knownUnits(projectDir, recordDir));
      if (guardedDispatch) {
        verdict = evaluatePlanApprovalDispatch(toolName, subagentType, dispatchPrompt, {
          currentStage: activeDirective.stage,
          units,
        });
        // A directive that names no target (a step gone stale, a question, a
        // pause) carries no approval to a worker, so this is the same refusal
        // a write gets, with the fresh `next` that issues the build again.
        if (verdict.block && issuance === null) {
          authorityFailure =
            `the developer handoff cannot select one approval target from directive kind "${activeDirective.kind}"` +
            outOfDateClause(activeDirective);
          standing = planStanding(projectDir, activeDirective);
        } else if (
          verdict.handoff &&
          briefTargets?.every((unit) => codeGenerationExecutionAllowed(projectDir, { unit }))
        ) {
          handoffDefect = verdict.handoff;
        }
      } else if (mutation.swarmUnits) {
        const selected = mutation.swarmUnits;
        const foreign = selected.filter((unit) =>
          activeDirective.kind !== "invoke-swarm" || !activeDirective.units?.includes(unit));
        verdict = {
          block: selected.length === 0 || foreign.length > 0 || selected.some((unit) => {
            const evidence = units.find((entry) => entry.unit === unit);
            return !approvalEvidenceIsCurrent(evidence) || evidence?.reason !== undefined;
          }),
          mentioned: selected,
        };
        if (!selected.length) {
          authorityFailure = "swarm command has an ambiguous or foreign Unit/project selection";
        } else if (foreign.length) {
          authorityFailure = `swarm command names Units outside the emitted batch: ${foreign.join(", ")}`;
        }
      } else if (
        activeDirective.kind === "ask" &&
        activeDirective.ask_type === GUARD_RECOVERY_ASK_TYPE
      ) {
        // The engine asked the person how to recover and waits for the answer.
        // Once they pick a fix whose work happens while the question is open
        // (repairing a reviewed artifact, re-saving outputs, finishing a
        // revision), its writes inside the ask's own record folder go through.
        // Source changes wait until the engine routes work again.
        const askDir = resolve(
          codeGenerationRecordDir(projectDir, activeDirective.unit?.trim() || null),
        );
        const outsideRecord = mutation.targets.find(
          (candidate) => !isTrustedRecordTarget(projectDir, candidate, askDir),
        );
        if (
          guardRecoveryRecordWorkOpen(activeDirective) &&
          mutation.targets.length > 0 && !outsideRecord && !mutation.opaqueShell
        ) return 0;
        authorityFailure = ENGINE_QUESTION_OPEN;
        verdict = { block: true, mentioned: [] };
      } else if (
        activeDirective.kind === "ask" &&
        activeDirective.ask_type === PLAN_APPROVAL_ASK_TYPE
      ) {
        // The engine is asking the person to approve the plan. Nothing is
        // built or changed until they reply, so an answer the agent wrote can
        // never stand in for theirs. After their reply, the asked plan's own
        // plan and test instructions can change for what they asked; the
        // questions file, other plans, and code still wait.
        const editable = planApprovalReplyEditableFiles(projectDir);
        if (
          WRITE_TOOLS.has(toolName) && !mutation.opaqueShell && mutation.targets.length > 0 &&
          mutation.targets.every((candidate) => isRepliedPlanFileTarget(projectDir, candidate, editable))
        ) return 0;
        // A review the person asked for runs while the plan waits: its own
        // review file and dispatch record, and nothing else.
        const reviewing = openReviewRequestFiles(projectDir);
        if (
          reviewing.length > 0 && !mutation.opaqueShell && mutation.targets.length > 0 &&
          mutation.targets.every((candidate) => isOpenReviewTarget(projectDir, candidate, reviewing))
        ) return 0;
        // Only the build waits for the plan: the developer, the files the plan
        // names, AI-DLC's own records, and AI-DLC's own commands. What else the
        // person asks for runs now: a commit, an install, a test run, or a
        // write to a file the plan does not name, under every Guard Policy.
        if (knownMutationTool && !mutation.runsAidlc) {
          const planPaths = mutation.targets.length > 0 ? planApprovalPlanNamedPaths(projectDir) : null;
          if (mutation.targets.every((candidate) => isPlanWaitSideWrite(projectDir, candidate, planPaths))) return 0;
        }
        authorityFailure = PLAN_APPROVAL_ASK_OPEN;
        standing = planStanding(projectDir, activeDirective);
        // Loaded only here: the question's own record, read the way its owner
        // reads it, and kept off the path every other tool call takes.
        try {
          const { planApprovalAskState: askState } = await import("../tools/aidlc-plan-approval-ask.ts");
          asked = askState(projectDir);
        } catch {
          asked = null;
        }
        verdict = { block: true, mentioned: [] };
      } else if (
        activeDirective.kind === "invoke-swarm" &&
        !mutation.opaqueShell &&
        mutation.targets.every((candidate) =>
          (activeDirective.units ?? []).some((unit) =>
            isTrustedRecordTarget(projectDir, candidate, resolve(codeGenerationRecordDir(projectDir, unit)))))
      ) {
        // A swarm batch plans in the main workspace, one record directory per
        // listed Unit, before any worktree exists. Writes there are planning;
        // implementation still waits for the approved, prepared workers.
        return 0;
      } else if (activeDirective.kind !== "run-stage") {
        authorityFailure =
          `workspace mutation cannot select one approval target from directive kind "${activeDirective.kind}"` +
          outOfDateClause(activeDirective);
        standing = planStanding(projectDir, activeDirective);
        verdict = { block: true, mentioned: [] };
      } else {
        const unit = activeDirective.unit?.trim() || null;
        const target: CodeGenerationTarget = { unit };
        const approvalDir = resolve(codeGenerationRecordDir(projectDir, unit));
        const outsideRecord = mutation.targets.find(
          (candidate) =>
            !isTrustedRecordTarget(projectDir, candidate, approvalDir),
        );
        if (!outsideRecord && !mutation.opaqueShell) return 0;
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
        // While the plan is written and before the person has approved it,
        // only the build waits too: a file the plan on disk does not name,
        // written as the person asked, goes through (before any plan, only a
        // document). Once they approved, every write waits on that approval.
        if (
          !evidence.approved && knownMutationTool && !mutation.opaqueShell && !mutation.runsAidlc &&
          mutation.targets.length > 0 &&
          mutation.targets.every((candidate) =>
            isPlanWaitSideWrite(projectDir, candidate, planApprovalPlanNamedPaths(projectDir, unit)))
        ) return 0;
        verdict = {
          block: !approvalEvidenceIsCurrent(evidence),
          mentioned: [unit ?? `stage:${GUARDED_STAGE}`],
        };
        if (verdict.block) {
          blockedMutation = {
            target: outsideRecord ?? (mutation.shellCommand ?? "").trim().slice(0, 160),
            unit,
            opaqueShell: outsideRecord === undefined,
            detail: receiptDetail([evidence], verdict.mentioned),
          };
        }
      }
    }
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    authorityFailure =
      `Plan Approval authority evaluation failed closed: ${errorMessage(e)}`;
    verdict = { block: true, mentioned: [] };
  }
  // No refusal names a switch. `guard.plan-approval off` is plan approval off
  // for the whole piece of work, which only the person ever proposes; an edited
  // plan is asked about again by `next`, and the reason says so. The same words
  // refuse with the fence on and, where a lowered fence still refuses, with it
  // off; `detail` is then the evaluator's reason for the target it could not start.
  const refusalProse = (detail: string | null): string =>
    authorityFailure
      ? authorityBlockReason(authorityFailure, standing, asked)
      : blockedMutation
      ? mutationBlockReason(
          blockedMutation.unit,
          blockedMutation.opaqueShell,
          detail ?? blockedMutation.detail,
        )
      : verdict.appendixInBrief
      ? appendixBlockReason(verdict.mentioned)
      : handoffDefect
      ? handoffBlockReason(verdict.mentioned, handoffDefect, briefTargets)
      : blockReason(verdict.mentioned, detail ?? receiptDetail(units, verdict.mentioned), briefTargets);

  // The rules still arriving is about the delivery, not the plan, so it holds
  // under every Guard Policy and is said on its own: a lowered fence has
  // nothing to stand aside for, and no Plan Approval block is recorded.
  if (rulesArriving !== null) {
    process.stderr.write(`${rulesArriving}\n`);
    return 2;
  }
  if (!verdict.block) {
    // Under Change Control `relaxed`, generation start may accept source that
    // moved after approval: the ledger row is written there and the one human
    // line comes back to be printed on this hook's stdout.
    const changeNotices: string[] = [];
    try {
      if (guardedDispatch) {
        const targets = verdict.mentioned.map((mentioned) => ({
          unit: mentioned === `stage:${GUARDED_STAGE}` ? null : mentioned,
        }));
        changeNotices.push(...beginCodeGenerationBatch(projectDir, targets));
      } else if (blockedMutation === null) {
        const state = readFileSync(stateFilePath(projectDir), "utf-8");
        const marker = readActiveDirectiveMarker(projectDir, state);
        if (marker?.version === 2 && marker.kind === "run-stage") {
          changeNotices.push(...beginCodeGeneration(projectDir, { unit: marker.unit?.trim() || null }));
        }
      }
    } catch (e) {
      // Source that moved after approval never stops the build (it is one
      // notice line), so a start that throws is a provenance failure.
      return refuseProvenanceFailure(errorMessage(e));
    }
    if (!verdict.block) {
      for (const notice of changeNotices) process.stdout.write(`${notice}\n`);
    }
  }
  if (!verdict.block) return 0;

  // The fence stands aside when it is LOWERED for this piece of work, by the
  // guard policy word (relaxed and off both lower this one) or by the human's
  // own `guard.plan-approval off` switch. A human message, however recent, does
  // not lower it: see decideGuard in aidlc-lib.ts for why. Standing aside costs
  // one printed line and one audit row; the approval gate itself is untouched.
  // Otherwise the refusal below carries the switch, so the way past is in hand.
  {
    let gate: ReturnType<typeof codeGenerationPlanApprovalFence> | null = null;
    try {
      const marker = readActiveDirectiveMarker(projectDir, state ?? "");
      gate = codeGenerationPlanApprovalFence(
        projectDir,
        { unit: marker?.unit ?? marker?.units?.[0] ?? null },
        { hookInput: parsed },
      );
    } catch (e) {
      recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    }
    if (gate?.decision === "stand-aside") {
      // A lowered fence lets changed content through after an approval; it never
      // supplies a missing directive, target, or approval. Those refusals say
      // what they say with the fence on, so each names the step that ends it.
      if (authorityFailure) {
        // The plan question is open: the same words as with the fence on.
        const waiting = authorityFailure === PLAN_APPROVAL_ASK_OPEN;
        return refuseExecutionIneligible(authorityRemedy(authorityFailure, standing, asked), !waiting, !waiting);
      }
      if (verdict.mentioned.length === 0) {
        return refuseExecutionIneligible(refusalProse(null), false);
      }
      const selected = verdict.mentioned.map((mentioned) => {
        const target = { unit: mentioned === `stage:${GUARDED_STAGE}` ? null : mentioned };
        return { target, approval: evaluateCodeGenerationApproval(projectDir, target) };
      });
      // Lowering this fence permits changed content after initial approval.
      // It does not supply missing approval, artifacts, target or attempt
      // authority. Validate the whole selection before publishing any start.
      for (const { target, approval } of selected) {
        if (approval.executionFailure) return refuseProvenanceFailure(approval.executionFailure);
        if (!codeGenerationExecutionAllowed(projectDir, target, approval)) {
          return refuseExecutionIneligible(refusalProse(approval.reason || null), false);
        }
      }
      // A blocked path is written the way the write-audit hook writes one
      // (forward slashes, upper-case drive), so the ledger reads the same on
      // every platform. A shell command stays verbatim: its backslashes are text.
      const detail = guardedDispatch
        ? `dispatch of ${subagentType}`
        : blockedMutation
          ? blockedMutation.opaqueShell
            ? blockedMutation.target
            : normalizeDriveLetter(blockedMutation.target.replace(/\\/g, "/"))
          : toolName;
      // A lowered fence keeps its permission decision, but an existing genuine
      // approval still needs source provenance before execution. Reuse the
      // locked start transaction even when edited content made the verdict fail.
      // This hook emits its own stand-aside row below, so begin only reports drift.
      try {
        for (const notice of beginCodeGenerationBatch(
          projectDir, selected.map(({ target }) => target), { recordContinuation: false },
        )) {
          process.stdout.write(`${notice}\n`);
        }
      } catch (e) {
        return refuseProvenanceFailure(errorMessage(e));
      }
      // The row is written once the build has started (the start just held and
      // released the same lock), so it never claims a pass that did not happen.
      // It is this fence's account of what it let through, not approval
      // evidence: a ledger that cannot take it never refuses the person's
      // lowered fence. The line says it was not recorded, and the doctor lists it.
      const recorded = recordGuardStoodAside(projectDir, {
        fence: "plan-approval",
        authority: gate.authority,
        stage: GUARDED_STAGE,
        tool: toolName,
        details: detail,
      });
      if (!recorded) {
        recordHookDrop(projectDir, HOOK_NAME, `GUARD_STOOD_ASIDE row not recorded (audit ledger busy or not writable): ${detail}`);
      }
      if (guardStandAsideSpeaks(gate)) {
        writeGuardStoodAside(guardStoodAsideLine("plan-approval", gate.source, detail, recorded));
      }
      return 0;
    }
  }

  // Audit the refusal so the run's record shows when the ordering bit.
  // Best-effort: an audit failure never changes the block decision. The lock
  // acquisition deliberately keeps a short reporting budget (5 x 50ms):
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

  process.stderr.write(`${refusalProse(null)}\n`);
  return 2; // harness PreToolUse reject contract: exit 2 + stderr blocks
}

if (import.meta.main) {
  const input = process.stdin.isTTY ? "" : await Bun.stdin.text();
  process.exit(await run(input));
}
