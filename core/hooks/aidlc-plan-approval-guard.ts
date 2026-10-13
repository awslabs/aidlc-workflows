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
// code-generation, and to the three doors to the person's code: the
// developer-agent dispatch, a file-tool or shell write to a path inside the
// project outside AI-DLC's own folders, and a shell command whose writes cannot
// be seen. All three wait until the same approval evidence is current.
// AI-DLC's own bookkeeping never meets this guard: a write whose every target is
// a stage's record output under aidlc/spaces (not the engine's own files there)
// passes, and so does a direct, unwrapped invocation of the installed engine,
// whose verbs the engine judges itself. Where no tool of the engine's owns the
// call, a condition stays here (engineCommandAdmitted): a recorded switch that
// turns a check off, four config settings that can take a check away, and a
// release fetched or applied, pass once a person has asked; a Code Generation
// completion (a report that opens or passes the gate, a Unit's completion
// receipt) waits while the plan does (the person's answer at the held gate and
// the recovery remedy they picked excepted); a jump waits for the person's
// move: the restart they picked at the recovery question, or one they asked
// for while the last step is current. While the person is editing the plan
// files themselves, those files are theirs (personIsEditingPlanFile). Three exact files
// outside the record pass too: the composer's grid proposal, a person's answer
// text and a person's request file, which the engine reads and nothing else.
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
import { CONFIG_SECTIONS } from "../tools/aidlc-command.ts";
import { commandPath, readActiveExecutable } from "../tools/aidlc-install-paths.ts";
import {
  guardOperationMatchesRemedy,
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
  REQUEST_TEXT_DIR,
  errorMessage,
  getField,
  GUARD_RECOVERY_ASK_TYPE,
  guardRecoveryAnswerAdmits,
  loadScopeMapping,
  loadStageGraph,
  parseCheckboxes,
  parseStateStageSuffixes,
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
  personAskedSinceGate,
  personSpokeSinceGate,
  readActiveDirectiveMarker,
  spacesRoot,
  activeDirectiveOutOfDateReason,
  recordHookDrop,
  releaseAuditLock,
  resolveBoltDag,
  resolveProjectFlag,
  resolveProjectDirFromHook,
  stateFilePath,
  worktreesDir,
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
  WORKER_BRIEF_SECTIONS,
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
// Shells and evaluators that run text the lexer does not read: what such a
// command writes is not visible, so it keeps the build's verdict.
const SHELL_INTERPRETERS = new Set([
  ".", "bash", "busybox", "cmd", "dash", "eval", "exec", "fish", "ksh", "powershell", "pwsh", "sh", "source", "zsh",
]);
// Language runtimes given a program on the command line (`bun -e`, `python -c`)
// are evaluators of text the lexer does not read either; a script file or a
// heredoc is a program the person can see.
const INLINE_CODE_RUNTIMES = new Set(["bun", "deno", "node", "perl", "php", "python", "python2", "python3", "ruby"]);
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "-E", "-p", "-r", "--eval", "--print", "eval"]);
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
 * workflow does not build, carries the wrong contract line for an approved
 * plan, or carries the marker lines without the brief they head.
 */
export type HandoffDefect = "targets" | "unknown-target" | "contract" | "brief";

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
  // The marker lines head the brief; alone they hand the developer none of the
  // plan or instructions the approval covers. The brief's own sections, as the
  // brief command prints them, say the brief is there.
  const briefCarried = promptCarriesBriefSections(promptText);
  const handoff: HandoffDefect | undefined = target === undefined
    ? "unknown-target"
    : approved && !contractMatches ? "contract" : approved && !briefCarried ? "brief" : undefined;
  return {
    block: target === undefined || !approved || !contractMatches || appendixInBrief || !briefCarried,
    mentioned,
    ...(appendixInBrief ? { appendixInBrief: true } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

/** One line of each of the brief's section families, whitespace-folded: the
 *  plan and instructions headings in their fence-on or fence-off wording. */
export function promptCarriesBriefSections(promptText: string): boolean {
  const fold = (text: string): string => text.replace(/\s+/g, " ").trim();
  const folded = fold(promptText);
  return WORKER_BRIEF_SECTIONS.every((family) => family.some((heading) => folded.includes(fold(heading))));
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

// The last clause of a refusal that waits on the plan: what `next` does with
// it. With plan approval on, next asks the person. With it off for this work,
// next starts the build without asking anyone, so the clause says that and
// tells the agent not to ask for an approval nobody wants. The agent repeats
// these words to the person, so the clause names no engine part and no
// switch: the command it follows is already named once, and "it" is enough.
function nextAfterPlanClause(planApprovalOff: boolean, handsOver: boolean): string {
  if (planApprovalOff) {
    return "plan approval is off for this work, so it starts the build without asking anyone; " +
      "do not ask the person to approve the plan.";
  }
  return handsOver
    ? "the engine asks the person to approve the plan, and the `next` after their answer hands over the build."
    : "the engine asks the person to approve it before any code is written.";
}

// The block reason handed back to the conductor through the harness's
// PreToolUse error channel. Self-explaining and redirecting: it names the
// missing evidence and the exact stage steps that produce it, so the
// conductor self-corrects instead of retrying the same call.
export function blockReason(
  mentioned: string[],
  detail: string | null = null,
  targets: BriefTargets | null = null,
  planApprovalOff = false,
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
    `not approved yet.${detail ? ` Reason: ${detail.replace(/\.+$/, "")}.` : ""} Finish code-generation-plan.md and ` +
    `unit-test-instructions.md, then run ${nextOnItsOwn()}: ${nextAfterPlanClause(planApprovalOff, true)} Then hand the ` +
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
      : cause === "brief"
        ? "carries the marker lines without the brief they head"
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
  planApprovalOff = false,
): string {
  const scope = unit === null ? "the zero-Unit stage-level implementation" : `unit ${unit}`;
  const action = opaqueShell
    ? "run mutation-capable shell commands"
    : "modify workspace paths";
  return (
    `Code generation cannot ${action} for ${scope} because ` +
    `the plan, unit-test instructions, and current Testing Contract do not have a current ` +
    `matching approval.${detail ? ` Reason: ${detail.replace(/\.+$/, "")}.` : ""} Writes inside the selected code-generation record directory remain ` +
    `available for planning. When the plan is ready, run ${nextOnItsOwn()}: ${nextAfterPlanClause(planApprovalOff, false)}`
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
  editingReply: string | null = null,
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
    // Once they reply while editing, the ask tool's step records it (editingReply).
    if (asked === "editing") {
      return editingReply
        ? `The person is editing the plan files themselves and has replied since: ${editingReply}. Then run ` +
          `${nextOnItsOwn()}, and follow the step it prints.`
        : "The person is editing the plan files themselves: leave those files to them. When they say " +
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
  editingReply: string | null = null,
): string {
  if (reason === ENGINE_QUESTION_OPEN || reason === PLAN_APPROVAL_ASK_OPEN) {
    return authorityRemedy(reason, standing, asked, editingReply);
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

// A write outside the project is never the plan's business: the path as
// written lies outside the project, and so does the real path of its deepest
// existing ancestor, so a link from outside into the project counts as inside
// (a dangling link resolves to nothing and counts as inside too).
function isOutsideProject(projectDir: string, target: string): boolean {
  try {
    const projectLexical = resolve(projectDir);
    const projectReal = realpathSync(projectLexical);
    const targetAbs = resolve(target);
    if (isWithinDir(targetAbs, projectLexical) || isWithinDir(targetAbs, projectReal)) return false;
    const suffix: string[] = [];
    let cursor = targetAbs;
    while (lstatSync(cursor, { throwIfNoEntry: false }) === undefined) {
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
    const real = join(realpathSync(cursor), ...suffix);
    return !isWithinDir(real, projectLexical) && !isWithinDir(real, projectReal);
  } catch {
    return false;
  }
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

// The listed Unit `prepare` bound a Bolt worktree to: `folder` is a folder
// directly under `.aidlc/worktrees/`, reached through no symlink, whose own
// delegated approval (written by `prepare`) lets that Unit build. The judgement
// is the one the worker's own hook makes inside the worktree, so a lowered
// fence counts here exactly as it counts there, and a plan changed since
// approval refuses here as it does there. Null for any other folder, or one
// bound to no listed Unit.
function worktreeBoundUnit(projectDir: string, folder: string, units: readonly string[]): string | null {
  try {
    const projectLexical = resolve(projectDir);
    const root = resolve(worktreesDir(projectDir));
    const folderAbs = resolve(folder);
    const inside = relative(root, folderAbs);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside) || /[\\/]/.test(inside)) return null;
    assertNoSymlinkInChainOrThrow(realpathSync(projectLexical), relative(projectLexical, folderAbs));
    if (!lstatSync(folderAbs, { throwIfNoEntry: false })?.isDirectory()) return null;
    return units.find((unit) => codeGenerationExecutionAllowed(folderAbs, { unit })) ?? null;
  } catch {
    return null;
  }
}

// The one prepared Bolt worktree every target lies in, named as the listed
// Unit the engine bound it to (worktreeBoundUnit). Null when a target lies
// elsewhere, names the folder itself, or when two worktrees are named.
function preparedBoltWorktreeUnit(projectDir: string, targets: string[], units: readonly string[]): string | null {
  try {
    const projectLexical = resolve(projectDir);
    const projectReal = realpathSync(projectLexical);
    const root = resolve(worktreesDir(projectDir));
    let worktree: string | null = null;
    for (const target of targets) {
      const targetAbs = resolve(target);
      const inside = relative(root, targetAbs);
      if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
      const folder = resolve(root, inside.split(/[\\/]/)[0]);
      if (folder === targetAbs || (worktree !== null && worktree !== folder)) return null;
      worktree = folder;
      assertNoSymlinkInChainOrThrow(projectReal, relative(projectLexical, targetAbs));
    }
    return worktree === null ? null : worktreeBoundUnit(projectDir, worktree, units);
  } catch {
    return null;
  }
}

// The composer's grid proposal (composerProposalPath) is engine scratch that
// only validate-grid reads: not source, not a plan file, and nothing reads an
// approval from it. A composition requested while Code Generation is current
// writes it before its own approval gate. Exactly that file, reached through no
// symlink and not hard-linked to another file, is exempt.
// A stage's own record output inside AI-DLC's records (`aidlc/spaces`): reached
// through no symlink, not hard-linked to another file, and not the work's state,
// audit trail, receipts or engine control files, which only the engine writes.
function isStageRecordOutput(projectDir: string, target: string): boolean {
  try {
    const projectLexical = resolve(projectDir);
    const targetAbs = resolve(target);
    const inside = relative(resolve(spacesRoot(projectDir)), targetAbs);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return false;
    const segments = inside.split(/[\\/]/);
    if (
      basename(targetAbs) === "aidlc-state.md" || basename(targetAbs) === "intents.json" ||
      segments.includes("audit") || segments.includes(".aidlc-plan-approval")
    ) return false;
    // Inside the engine's control folder only the reviewer's own records are
    // the agent's to write: a review file and the reviewer dispatch record.
    const engine = segments.indexOf(".aidlc-engine");
    if (engine >= 0) {
      const within = segments.slice(engine + 1);
      const reviewerRecord = (within[0] === "reviews" && within.length > 1) ||
        (within.length === 1 && within[0] === "reviewer-dispatch.json");
      if (!reviewerRecord) return false;
    }
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

// The project folder where the agent writes a person's request for `next
// --request-file` (REQUEST_TEXT_DIR): a plain file directly inside it, the only
// place the engine reads it, reached through no link. Writing it changes
// nothing and builds nothing; the engine reads the file and removes it.
function isRequestTextTarget(projectDir: string, target: string): boolean {
  try {
    const folder = join(projectDir, REQUEST_TEXT_DIR);
    if (normalizeDriveLetter(dirname(resolve(target))) !== normalizeDriveLetter(resolve(folder))) return false;
    if (!isTrustedRecordTarget(projectDir, target, folder)) return false;
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
  /** False when the lexer could not read the whole command: a variable or
   *  substitution, whitespace or an operator it does not decode, a shell or
   *  evaluator (a shell script, inline code) that runs text it cannot see, a
   *  write through an option, or a PowerShell command not read as plain. */
  readable?: boolean;
  /** AI-DLC's own command that this guard still refuses: a recorded switch that lowers a check with nobody asking. */
  engineRefused?: boolean;
}

function normalizedCommandName(name: string): string {
  return basename(name).toLowerCase().replace(/\.exe$/, "");
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

// A file a command writes through an option or a second operand, which the
// lexer does not place among the write targets: it is a write all the same.
function writesThroughOption(name: string, args: readonly string[]): boolean {
  if (name === "sort" || name === "git") {
    return args.some((arg) => (name === "sort" && arg === "-o") || arg === "--output" || arg.startsWith("--output="));
  }
  if (name === "uniq") return args.filter((arg) => !arg.startsWith("-")).length >= 2;
  return false;
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

// The native engine by name (`aidlc`, `aidlc.exe`) or, where the shell keeps
// Windows paths as written, by the installed launcher or active executable
// path. cmd.exe parses a .cmd launcher's arguments again, where these
// characters expand variables or start another command.
function isNativeEngine(name: string, args: readonly string[], enginePaths: boolean): boolean {
  const command = name.toLowerCase();
  if (command === "aidlc" || command === "aidlc.exe") return true;
  if (!enginePaths) return false;
  const engine = command === "aidlc.cmd" ? "launcher" : installedEngine(name);
  return engine === "executable" ||
    (engine === "launcher" && args.every((arg) => arg !== "" && !/["%&<>^|!\r\n]/.test(arg)));
}

// The engine's own arguments when a shell invocation runs AI-DLC as installed:
// the native engine, or Bun running `aidlc.ts` or an `aidlc-<route>.ts` that is
// a real file under this harness's tools directory (no symlink, no wrapper, no
// data-driven argument, no changed executable resolution, no preloaded code).
// A per-tool script is read as its engine route (`aidlc-<route>.ts <args>` is
// `engine <route> <args>`), so one verb is never two commands. Null for any
// other program, which the shell reading judges as before.
function installedEngineArgs(
  projectDir: string,
  cwd: string,
  name: string,
  args: string[],
  unwrapped: boolean,
  enginePaths: boolean,
): string[] | null {
  if (!unwrapped) return null;
  if (isNativeEngine(name, args, enginePaths)) return args;
  if (!["bun", "bun.exe"].includes(name.toLowerCase()) && !isThisBun(name)) return null;
  if (
    args.some((arg) =>
      arg === "-r" || arg === "--require" || arg === "--preload" ||
      arg.startsWith("--require=") || arg.startsWith("--preload="))
  ) return null;
  const scriptIndex = args[0] === "run" ? 1 : 0;
  const script = args[scriptIndex];
  if (!script || script.startsWith("-") || !isTrustedToolFile(projectDir, cwd, script)) return null;
  const stem = basename(isAbsolute(script) ? resolve(script) : resolve(cwd, script));
  const toolArgs = args.slice(scriptIndex + 1);
  if (stem === "aidlc.ts") return toolArgs;
  const route = /^aidlc-([A-Za-z0-9._-]+)\.ts$/.exec(stem)?.[1];
  return route ? ["engine", route, ...toolArgs] : null;
}

// The durable state holds the Code Generation completion gate open: the stage
// is still current and its checkbox reads awaiting-approval.
function codeGenerationGateHeld(state: string): boolean {
  return normalizeStageName(getField(state, "Current Stage") ?? "") === GUARDED_STAGE &&
    parseCheckboxes(state).some(
      (entry) => entry.slug === GUARDED_STAGE && entry.state === "awaiting-approval",
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

// What AI-DLC's own command still waits on in the step and the state at hand:
// the Code Generation completion gate held open (the person's answer to it
// passes), and whether a jump is the person's move (jumpIsPersonsMove).
interface EngineCommandContext {
  gateHeld: boolean;
  marker: ActiveDirectiveMarker | null;
  jumpAdmitted: () => boolean;
}

const NO_ENGINE_CONTEXT: EngineCommandContext = { gateHeld: false, marker: null, jumpAdmitted: () => false };

// The engine's last step is current and was delivered as issued, and it is not
// its recovery question, whose own picked restart is the one jump it carries out
// (isSelectedGuardRestartContinuation). A step gone stale or superseded since
// names nothing the person's earlier words still ask for: `next` names the step
// now. Parked work's last step is the park, which no issued step outlives.
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

// A jump is the person's move: the restart they picked at the engine's recovery
// question, or one they asked for since the last decision while the last step
// is current. The jump tool checks neither.
function jumpIsPersonsMove(
  projectDir: string,
  cwd: string,
  command: unknown,
  state: string,
  marker: ActiveDirectiveMarker | null,
): boolean {
  return (typeof command === "string" && isSelectedGuardRestartContinuation(projectDir, cwd, command, state, marker)) ||
    (personSpokeSinceGate(projectDir, { requests: true }) && lastStepAdmitsPersonsMoves(projectDir));
}

// The results that open the Code Generation gate or complete the stage.
const CODE_GENERATION_COMPLETIONS = new Set(["awaiting-approval", "approved", "completed", "revised"]);

// The last value given for a flag, as `--flag value` or `--flag=value`.
function lastFlag(args: readonly string[], name: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) value = args[index + 1];
    else if (args[index].startsWith(`${name}=`)) value = args[index].slice(name.length + 1);
  }
  return value;
}

// The config setup tool's own arguments (its section first), in either spelling
// that runs it: `config ...` or its script, `aidlc-init.ts`, which drops a
// leading `config` or `init` itself. Null for every other command, and for
// `config set|get|list`, the per-work setter's verbs.
const CONFIG_SETTER_VERBS = new Set(["set", "get", "list"]);

function configToolArgs(engineArgs: readonly string[]): readonly string[] | null {
  const rest = engineArgs[0] === "config"
    ? engineArgs.slice(1)
    : engineArgs[0] === "engine" && engineArgs[1] === "init"
      ? (engineArgs[2] === "config" || engineArgs[2] === "init" ? engineArgs.slice(3) : engineArgs.slice(2))
      : null;
  return rest === null || CONFIG_SETTER_VERBS.has(rest[0] ?? "") ? null : rest;
}

// Two config forms keep a condition, because the config tool has no other owner
// for them. A release fetched or applied replaces the engine itself: `--download`,
// `--release-base-url`, `--ca-bundle`, `--from` outside `config models`, or a
// setup run with no section (other than `--help` and `--statusline`). Kiro's
// Workflows on, the sensor timeout, which plugins are on and `config project
// --reset` can take a check away or change the stations. Each passes once a
// person has asked since the last decision (their "update AI-DLC" is that), and
// never on an unattended run.
const RELEASE_FLAGS = new Set(["--download", "--release-base-url", "--ca-bundle"]);

function configToolAdmitted(projectDir: string, rest: readonly string[]): boolean {
  const names = rest.map((arg) => (arg.startsWith("--") && arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg));
  const valueAt = (index: number): string | undefined =>
    rest[index].includes("=") ? rest[index].slice(rest[index].indexOf("=") + 1) : rest[index + 1];
  const section = rest[0] ?? "";
  const sectioned = (CONFIG_SECTIONS as readonly string[]).includes(section);
  const release = (!sectioned && !names.includes("--help") && !names.includes("--statusline")) ||
    names.some((name) => RELEASE_FLAGS.has(name)) || (section !== "models" && names.includes("--from"));
  const lowers = release || names.some((name, index) => name === "--kiro-workflows" && valueAt(index) !== "off") ||
    names.includes("--sensor-timeout-ms") || names.includes("--plugins") ||
    (section === "project" && names.includes("--reset"));
  return !lowers || personAskedSinceGate(projectDir);
}

// What this guard still asks of AI-DLC's own command: a recorded switch that
// turns a check off (`--bypass <switch>`, in any spelling) passes only once a
// person has asked since the last decision, because its setter never refuses
// and the next tool call would pass under the switch. As `config flags` it is
// judged whole (recordedSwitchChangeAdmitted); the config tool's two forms above
// keep theirs. Two more have no other owner: a Code Generation completion (a
// report that opens the gate or completes the stage, a Unit's completion
// receipt; neither tool checks the plan's approval) waits while the plan does,
// the person's answer at the held gate and the remedy they picked at the
// recovery question excepted; and a jump (the jump tool checks no pick and no
// person) waits for the person's move (jumpIsPersonsMove). Every other engine
// command is the engine's to judge.
function engineCommandAdmitted(
  projectDir: string,
  engineArgs: readonly string[],
  context: EngineCommandContext = NO_ENGINE_CONTEXT,
): boolean {
  const configArgs = configToolArgs(engineArgs);
  if (configArgs !== null && !configToolAdmitted(projectDir, configArgs)) return false;
  const args = configArgs !== null ? ["config", ...configArgs] : engineArgs[0] === "engine" ? engineArgs.slice(1) : engineArgs;
  const stage = lastFlag(args, "--stage");
  const result = lastFlag(args, "--result") ?? "";
  const report = args[0] === "orchestrate" && args[1] === "report";
  if (
    (stage === undefined || stage === GUARDED_STAGE) &&
    ((report && CODE_GENERATION_COMPLETIONS.has(result)) ||
      (args[0] === "state" && args[1] === "unit" && args[2] === "complete")) &&
    !(report && context.gateHeld && stage === GUARDED_STAGE && result === "approved") &&
    !guardRecoveryAnswerAdmits(context.marker, engineArgs, projectDir)
  ) return false;
  if (args[0] === "jump" && (args[1] === "execute" || args[1] === "reopen") && !context.jumpAdmitted()) return false;
  if (!args.some((arg) => arg === "--bypass" || arg.startsWith("--bypass="))) return true;
  if (args[0] === "config" && args[1] === "flags") return recordedSwitchChangeAdmitted(projectDir, args);
  return personAskedSinceGate(projectDir);
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
  dialect: ShellDialect = POSIX_DIALECT,
  context: EngineCommandContext = NO_ENGINE_CONTEXT,
): boolean {
  const name = normalizedCommandName(invocation.name);
  const executable = invocation.executable ?? invocation.name;
  const unwrapped = (invocation.launchers?.length ?? 0) === 0 &&
    !invocation.dataDriven && !invocation.executableResolutionChanged;
  // A path to a program keeps its backslashes only under PowerShell; such a
  // path names the installed engine or nothing this guard reads.
  if (
    dialect.pathsAsWritten && /[\\/]/.test(executable) &&
    !(unwrapped && isNativeEngine(executable, invocation.args, true) &&
      engineCommandAdmitted(projectDir, invocation.args, context))
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
  if (name === "sort" || name === "uniq") return writesThroughOption(name, invocation.args);
  if (READ_ONLY_SHELL_COMMANDS.has(name)) return false;
  if (name === "git") {
    if (writesThroughOption(name, invocation.args)) return true;
    const subcommand = gitSubcommand(invocation.args);
    if (subcommand === "branch") {
      return !invocation.args.includes("--show-current");
    }
    return subcommand === null || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
  }
  // AI-DLC's own command, run as installed and unwrapped: the engine judges its
  // own verbs (generation start, a gate approval, a receipt), so this guard does
  // not, with one exception: a recorded switch that would turn a check off
  // passes only when a person has asked (engineCommandAdmitted).
  const engineArgs = installedEngineArgs(projectDir, cwd, executable, invocation.args, unwrapped, dialect.enginePaths);
  if (engineArgs !== null) return !engineCommandAdmitted(projectDir, engineArgs, context);
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
  powerShellHint = false,
  context: EngineCommandContext = NO_ENGINE_CONTEXT,
): Promise<MutationIntent> {
  let targets: string[] = [];
  let opaqueShell = false;
  let shellCommand: string | null = null;
  let readable = true;
  let engineRefused = false;
  if (toolName === "Bash") {
    const command = toolInput?.command;
    if (typeof command !== "string") {
      return { targets: [], opaqueShell: false, shellCommand: null };
    }
    shellCommand = command;
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
    opaqueShell =
      dynamic ||
      invocations.some((invocation) =>
        shellInvocationNeedsApproval(projectDir, cwd, invocation, targets.length > 0, analysed, dialect, context)
      );
    // A command that names AI-DLC and that the shell reading refused: an
    // untrusted spelling (a retained version, a copy of the tools outside the
    // trusted folder, a shim), a wrapper or a `cd` elsewhere, a second command
    // beside it, or the one recorded switch nobody asked for. The passes below
    // for a command that writes nothing never admit it: it lives or dies by
    // the shell reading, as every AI-DLC command did before.
    const looksLikeEngine = invocations.some((invocation) =>
      normalizedCommandName(invocation.executable ?? invocation.name).replace(/\.(?:cmd|ps1)$/, "") === "aidlc" ||
      invocation.args.some((arg) => /^aidlc(?:-[A-Za-z0-9._-]+)?\.ts$/.test(basename(arg)))) ||
      (dynamic && /\baidlc\b/i.test(analysed));
    engineRefused = looksLikeEngine && opaqueShell;
    // An escaped operator (`\>`, `\&`) is read as the lexer decodes it, which
    // is not trusted here; a variable, substitution or backtick (`dynamic`) can
    // hide a command or a write target, and a shell script run by name hides
    // commands the lexer never sees.
    readable = !dynamic && !/[^\S \t\n]/u.test(command) && !command.includes("\\\n") && !/\\[<>&|;]/.test(command) &&
      !(powerShellHint && powerShellCommand === null) &&
      !invocations.some((invocation) => {
        const program = normalizedCommandName(invocation.executable ?? invocation.name);
        return SHELL_INTERPRETERS.has(program) || writesThroughOption(program, invocation.args) ||
          /\.(?:ps1|sh|bash|zsh|ksh|cmd|bat)$/.test(program) ||
          (INLINE_CODE_RUNTIMES.has(program) && invocation.args.some((arg) => INLINE_CODE_FLAGS.has(arg)));
      });
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
    ...(readable ? {} : { readable }),
    ...(engineRefused ? { engineRefused } : {}),
  };
}

// The person is editing the plan files themselves (they answered the plan
// question with "I'll edit the files"), and the write names one of the asked
// plans' own plan or test-instruction files: those are theirs while they edit.
async function personIsEditingPlanFile(
  projectDir: string,
  activeDirective: ActiveDirectiveMarker | null,
  targets: string[],
): Promise<boolean> {
  if (
    activeDirective?.version !== 2 || activeDirective.kind !== "ask" ||
    activeDirective.ask_type !== PLAN_APPROVAL_ASK_TYPE
  ) return false;
  try {
    const { planApprovalAskState } = await import("../tools/aidlc-plan-approval-ask.ts");
    if (planApprovalAskState(projectDir) !== "editing") return false;
  } catch {
    return false;
  }
  // The asked plans' own files, from the ask's Unit(s): while the person edits,
  // the engine opens none of them to the agent, so the list is built here.
  const units = activeDirective.units ?? [activeDirective.unit?.trim() || null];
  const theirs = units.flatMap((unit) => {
    const dir = codeGenerationRecordDir(projectDir, unit);
    return [join(dir, "code-generation-plan.md"), join(dir, "unit-test-instructions.md")];
  });
  return targets.some((candidate) => isRepliedPlanFileTarget(projectDir, candidate, theirs));
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
  // How to record the person's reply while they edit the plan files, once they replied.
  let editingReply: string | null = null;
  // What is wrong with the developer handoff itself, said only once the plan it
  // hands over may be built: before that, the `brief` it would name refuses too.
  let handoffDefect: HandoffDefect | null = null;
  let rulesArriving: string | null = null;
  // A parallel batch is out and this write is not one of the three the batch
  // admits: the refusal stands with the fence on, and a lowered fence stands
  // aside for it as for any other write of an approved plan.
  let swarmBatchOut = false;
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
            projectDir, toolName, toolInput, cwd,
            // Set by the adapter that ran the tool, outside the agent's input.
            parsed.aidlc_shell === "powershell",
            {
              gateHeld: codeGenerationGateHeld(state),
              marker: activeDirective,
              jumpAdmitted: () =>
                toolName === "Bash" && jumpIsPersonsMove(projectDir, cwd, toolInput.command, state ?? "", activeDirective),
            },
          )
        : {
            targets: [],
            opaqueShell: true,
            shellCommand: `unknown mutation-capable tool: ${toolName}`,
          };
    if (!guardedDispatch && mutation.targets.length === 0 && !mutation.opaqueShell) {
      return 0;
    }
    // What the plan never governs, at any point of Code Generation and under
    // every Guard Policy: a command the lexer read whole that names no file it
    // writes and is not AI-DLC's own (a read, a scan, a test run), and a write
    // whose every target is outside the project. The build waits as before:
    // the developer, the plan's files and the code, AI-DLC's records and
    // AI-DLC's own commands, and a command whose writes cannot be seen.
    if (
      !guardedDispatch && knownMutationTool && mutation.readable !== false && !mutation.engineRefused &&
      mutation.targets.every((candidate) => isOutsideProject(projectDir, candidate))
    ) {
      return 0;
    }
    // AI-DLC's own records are not the person's code: a file-tool or shell
    // write whose every target is a stage's record output under aidlc/spaces
    // (not the state, the intents index, an engine control, receipt or audit
    // file; reached through no link) passes in every Plan Approval state. The
    // engine owns what those files mean: a plan edited after its approval is
    // asked about again by `next`, and an answer the agent writes has no
    // receipt. One exception: while the person is editing the plan files
    // themselves, the asked plans' own files are theirs, and a write to one is
    // refused below with that sentence (personIsEditingPlanFile).
    if (
      !guardedDispatch && knownMutationTool && !mutation.opaqueShell && mutation.targets.length > 0 &&
      mutation.targets.every((candidate) => isStageRecordOutput(projectDir, candidate)) &&
      !(await personIsEditingPlanFile(projectDir, activeDirective, mutation.targets))
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
    // shell on the way, passes in every Plan Approval state too, and so does
    // one of a person's request, for `next --request-file`.
    if (
      WRITE_TOOLS.has(toolName) &&
      !mutation.opaqueShell &&
      mutation.targets.length > 0 &&
      mutation.targets.every((candidate) =>
        isAnswerTextTarget(projectDir, candidate) || isRequestTextTarget(projectDir, candidate)
      )
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
      } else if (
        activeDirective.kind === "ask" &&
        activeDirective.ask_type === GUARD_RECOVERY_ASK_TYPE
      ) {
        // The engine asked the person how to recover and waits for the answer.
        // Its records passed above; source changes wait until the engine
        // routes work again.
        authorityFailure = ENGINE_QUESTION_OPEN;
        verdict = { block: true, mentioned: [] };
      } else if (
        activeDirective.kind === "ask" &&
        activeDirective.ask_type === PLAN_APPROVAL_ASK_TYPE
      ) {
        // The engine is asking the person to approve the plan. Nothing is
        // built until they reply: an answer the agent writes has no receipt,
        // and a plan changed under the question is asked about again by
        // `next`. The records passed above; code waits.
        // Only the build waits for the plan: the developer and the files the
        // plan names. What else the person asks for runs now: a commit, an
        // install, a test run, or a write to a file the plan does not name,
        // under every Guard Policy.
        if (knownMutationTool && !mutation.engineRefused) {
          const planPaths = mutation.targets.length > 0 ? planApprovalPlanNamedPaths(projectDir) : null;
          if (mutation.targets.every((candidate) => isPlanWaitSideWrite(projectDir, candidate, planPaths))) return 0;
        }
        authorityFailure = PLAN_APPROVAL_ASK_OPEN;
        standing = planStanding(projectDir, activeDirective);
        // Loaded only here: the question's own record, read the way its owner
        // reads it, and kept off the path every other tool call takes.
        try {
          const { planApprovalAskState: askState, planApprovalEditingReplyStep } = await import(
            "../tools/aidlc-plan-approval-ask.ts"
          );
          asked = askState(projectDir);
          editingReply = asked === "editing" ? planApprovalEditingReplyStep(projectDir) : null;
        } catch {
          asked = null;
        }
        verdict = { block: true, mentioned: [] };
      } else if (activeDirective.kind === "invoke-swarm") {
        // A swarm batch plans in the main workspace, one record directory per
        // listed Unit, before any worktree exists; each Unit's code is written
        // by its worker inside the worktree `prepare` created and bound to it,
        // judged as the worker's own hook judges it; its review is requested
        // and recorded against that worktree, and the reviewer writes its open
        // request's own file while the parent holds the dispatch record. The
        // worker and the reviewer are subagents of this session, so this hook,
        // with the parent as its project, is the one that sees their writes.
        // Everything else in the main checkout waits until the batch lands.
        const listed = activeDirective.units ?? [];
        // Each Unit's code is written inside the worktree `prepare` bound to it.
        if (
          !mutation.opaqueShell && mutation.targets.length > 0 &&
          preparedBoltWorktreeUnit(projectDir, mutation.targets, listed) !== null
        ) return 0;
        swarmBatchOut = true;
        authorityFailure =
          `workspace mutation cannot select one approval target from directive kind "${activeDirective.kind}"` +
          outOfDateClause(activeDirective);
        standing = planStanding(projectDir, activeDirective);
        verdict = { block: true, mentioned: listed };
        blockedMutation = {
          target: mutation.targets[0] ?? (mutation.shellCommand ?? "").trim().slice(0, 160),
          unit: null,
          opaqueShell: mutation.targets.length === 0,
          detail: null,
        };
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
          (candidate) => !isTrustedRecordTarget(projectDir, candidate, approvalDir),
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
          !evidence.approved && knownMutationTool && !mutation.opaqueShell && !mutation.engineRefused &&
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
  // The last clause says what `next` does with the plan: with plan approval off
  // for this work it starts the build without asking anyone, and a refusal that
  // says the person will be asked is a wrong line the agent repeats to them. The
  // setting is read only when refusing, off the path every other call takes; a
  // setting that cannot be read keeps the asking wording, which is the stop's own.
  let planApprovalOff = false;
  if (verdict.block && !authorityFailure) {
    try {
      const { resolvePlanApprovalSetting } = await import("../tools/aidlc-guard-switch.ts");
      planApprovalOff = resolvePlanApprovalSetting(projectDir, state).value === "off";
    } catch {
      planApprovalOff = false;
    }
  }
  const refusalProse = (detail: string | null): string =>
    authorityFailure
      ? authorityBlockReason(authorityFailure, standing, asked, editingReply)
      : blockedMutation
      ? mutationBlockReason(
          blockedMutation.unit,
          blockedMutation.opaqueShell,
          detail ?? blockedMutation.detail,
          planApprovalOff,
        )
      : verdict.appendixInBrief
      ? appendixBlockReason(verdict.mentioned)
      : handoffDefect
      ? handoffBlockReason(verdict.mentioned, handoffDefect, briefTargets)
      : blockReason(verdict.mentioned, detail ?? receiptDetail(units, verdict.mentioned), briefTargets, planApprovalOff);

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
      if (authorityFailure && !swarmBatchOut) {
        // The plan question is open: the same words as with the fence on.
        const waiting = authorityFailure === PLAN_APPROVAL_ASK_OPEN;
        return refuseExecutionIneligible(authorityRemedy(authorityFailure, standing, asked, editingReply), !waiting, !waiting);
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
