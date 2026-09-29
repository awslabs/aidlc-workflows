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
// instructions, questions, and diary that make approval possible.
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
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import { commandPath, readActiveExecutable } from "../tools/aidlc-install-paths.ts";
import {
  guardOperationMatchesRemedy,
  isGuardRecoveryEngineInvocation,
  parseGuardRestartContinuationCommand,
  sameGuardOperation,
} from "../tools/aidlc-guard-operation.ts";
import {
  acquireAuditLock,
  type ActiveDirectiveMarker,
  assertNoSymlinkInChainOrThrow,
  auditBlockField,
  auditFilePath,
  type ClaudeCodeHookInput,
  docsRoot,
  errorMessage,
  getField,
  GUARD_RECOVERY_ASK_TYPE,
  guardRecoveryAnswerAdmits,
  guardRecoveryRecordWorkOpen,
  PLAN_APPROVAL_ASK_TYPE,
  guardStoodAsideLine,
  harnessDir,
  normalizeDriveLetter,
  recordGuardStoodAside,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  loadScopeMapping,
  loadStageGraph,
  parseCheckboxes,
  parseStateStageSuffixes,
  readActiveDirectiveMarker,
  recordHookDrop,
  releaseAuditLock,
  resolveBoltDag,
  resolveProjectFlag,
  resolveProjectDirFromHook,
  readSessionBinding,
  resolveWorkflowSelection,
  SKELETON_STANCES,
  stateFilePath,
  validSessionId,
  writeGuardStoodAside,
} from "../tools/aidlc-lib.ts";
import {
  beginCodeGeneration,
  beginCodeGenerationBatch,
  codeGenerationExecutionAllowed,
  codeGenerationPlanApprovalFence,
  codeGenerationRecordDir,
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
  "cd",
  "cmp",
  "cut",
  "diff",
  "dirname",
  "echo",
  "file",
  "grep",
  "head",
  "ls",
  "mkdir",
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
  // A brief with no target marker carries no approval question at all: the
  // defect is the handoff, not the approval, so the refusal says so instead of
  // claiming the plan is unapproved and pointing the conductor back at Steps
  // 2-3 it may already have finished.
  if (mentioned.length === 0) {
    return (
      "Code generation cannot start because the developer handoff carries no target marker. " +
      `The brief's first lines must name exactly one target with "AIDLC-UNIT: <unit>" or ` +
      `"AIDLC-STAGE: code-generation", followed by "AIDLC-TESTING-CONTRACT: <contract hash>" ` +
      "(run `aidlc-testing-posture.ts brief` for the target and pass its output verbatim). " +
      "If Plan Approval has already been recorded, do not re-present it; fix the handoff and retry."
    );
  }
  const scope =
    mentioned.length === 1
      ? mentioned[0] === `stage:${GUARDED_STAGE}`
        ? "the zero-Unit stage-level implementation"
        : `unit ${mentioned[0]}`
      : `one target, but the brief names several (${mentioned.join(", ")})`;
  return (
    `Code generation cannot start for ${scope} because its plan and test instructions are ` +
    `not approved yet.${detail ? ` Reason: ${detail}.` : ""} Finish code-generation-plan.md and ` +
    `unit-test-instructions.md, then run \`next\`: the engine asks the person to approve the plan, and ` +
    `the \`next\` after their answer hands over the build. Then retry the developer handoff with ` +
    `"AIDLC-UNIT: <unit>" or "AIDLC-STAGE: code-generation", followed by ` +
    `"AIDLC-TESTING-CONTRACT: <contract hash>".`
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
    `the plan, unit-test instructions, and current Testing Contract do not have a current ` +
    `matching approval.${detail ? ` Reason: ${detail}.` : ""} Writes inside the selected code-generation record directory remain ` +
    `available for planning. When the plan is ready, run \`next\`: the engine asks the person to approve ` +
    `it before any code is written.`
  );
}

// What a person (and the conductor) needs while the engine's own question is
// open: what still works and the one move that ends the wait. No authority
// wording: nothing is stale, the engine is waiting for an answer.
function engineQuestionOpenReason(): string {
  return (
    "Code changes wait while AI-DLC's recovery question is open. Answer it first: " +
    "run `next` to show the question again, then carry out the choice the person makes. " +
    "Reading, `next`, and the commands that carry out the choice they picked still work, " +
    "as do the record-folder edits a picked fix needs."
  );
}

function authorityBlockReason(reason: string): string {
  if (reason === ENGINE_QUESTION_OPEN) return engineQuestionOpenReason();
  if (reason === PLAN_APPROVAL_ASK_OPEN) {
    return (
      "The plan is waiting for the person to approve it. Show them the question from the last `next`, end " +
      "the turn, and run `next` after they answer. Nothing is built or changed until then, and the plan " +
      "files stay as the person sees them."
    );
  }
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

interface MutationIntent {
  targets: string[];
  opaqueShell: boolean;
  shellCommand: string | null;
  swarmUnits?: string[];
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
  if (head !== "doctor" && head !== "--doctor") return false;
  return !rest.some((arg) =>
    arg === "--export" || arg === "--output" ||
    arg.startsWith("--export=") || arg.startsWith("--output="));
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
    return admitted(args);
  }
  if (!enginePaths || !admitted(args)) return false;
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
  return stem === "utility" && (args[0] === "status" || args[0] === "version");
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

function isPlanApprovalPrerequisite(args: string[], gateHeld = false): boolean {
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
  // before approval on harnesses that never show the hook's notice.
  if (
    noun === "testing-posture" &&
    ["resolve", "render", "fingerprint", "verify", "reply"].includes(verb)
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
  // Turning plan approval on only adds the stop, so the person can ask for it
  // while a plan waits. Turning it off stays the person's own typed turn.
  if (
    noun === "config" && verb === "set" && args.length === 5 &&
    ["plan-approval", "guard.plan-approval"].includes(args[3] ?? "") && args[4] === "on"
  ) {
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
  const admitted = (engineArgs: string[]): boolean =>
    isPlanApprovalPrerequisite(engineArgs, gateHeld) || askAdmits(engineArgs) ||
    isReadOnlyDiagnostic(engineArgs);
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
  // `bun -e '<code>'` and `bun --eval '<code>'` run inline JavaScript that
  // can write files (e.g. Bun.write), so they are NOT recognized as trusted
  // framework-tool invocations. The orchestrator should use `bun <script>`
  // (a framework tool file) for read-only checks instead of `bun -e`.
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
      !(admitted(toolArgs) || isReadOnlyDiagnostic(toolArgs))
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
  // `2>&1` and similar file-descriptor redirects are parsed by
  // shellCommandInvocations as a bare numeric invocation (e.g. `1`).
  // These are parsing artifacts, not real commands — treat them as
  // read-only so they don't make the shell opaque.
  if (/^\d+$/.test(name) && invocation.executable === undefined) return false;
  const executable = invocation.executable ?? invocation.name;
  const unwrapped = (invocation.launchers?.length ?? 0) === 0 &&
    !invocation.dataDriven && !invocation.executableResolutionChanged;
  const admitted = (engineArgs: string[]): boolean =>
    isPlanApprovalPrerequisite(engineArgs, gateHeld) || askAdmits(engineArgs) ||
    isReadOnlyDiagnostic(engineArgs);
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
  // `sed` without `-i`/`--in-place` is read-only (just prints to stdout).
  // `sed` with `-i` modifies files in-place, so it needs approval.
  if (name === "sed") {
    return invocation.args.some(
      (arg) => arg === "-i" || arg === "--in-place" || arg.startsWith("--in-place="),
    );
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

/**
 * Compute the workspace mutation intent for a tool call: the concrete write
 * targets, whether the shell command is opaque (dynamic evaluation or a
 * mutation-capable invocation), and the raw shell command.
 *
 * `git add` and `git commit` are carved out as non-mutations: they checkpoint
 * already-completed inception work (scope, codekb, intents, memory), not
 * code-generation writes. The guard's purpose is to prevent code-generation
 * before Plan Approval, not to prevent git checkpointing of inception
 * artifacts. `git add`/`git commit` return an empty-target, non-opaque intent
 * and take the early-exit path. This carve-out is scoped to the
 * plan-approval-guard only — review-freeze is unaffected.
 */
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
      shellCommandInvocations,
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
    // `git add` and `git commit` of inception-phase artifacts (scope, codekb,
    // intents, memory) are not code-generation writes. The guard's purpose is
    // to prevent code-generation before Plan Approval, not to prevent git
    // checkpointing of already-completed inception work. Treat `git add` and
    // `git commit` as non-opaque (allow the early-exit) — the mutation-target
    // detection already determines whether the command touches concrete files,
    // and `git add`/`git commit` do not produce write targets via
    // `shellWriteTargets`. The block happens in `shellInvocationNeedsApproval`,
    // which returns true for `git add`/`git commit` because they are not in
    // `READ_ONLY_GIT_SUBCOMMANDS`. This carve-out overrides that for the
    // plan-approval-guard only — review-freeze is unaffected.
    const gitInvocations = shellCommandInvocations(analysed);
    const isGitAddOrCommit = gitInvocations.length > 0 && gitInvocations.every(
      (inv) =>
        normalizedCommandName(inv.name) === "git" &&
        ["add", "commit"].includes(gitSubcommand(inv.args) ?? ""),
    );
    if (isGitAddOrCommit && targets.length === 0 && !dynamic) {
      return { targets: [], opaqueShell: false, shellCommand };
    }
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

// The payload names the session that made this tool call. Every workflow lookup
// below resolves through resolveInvokingSessionId, so pin that to the payload for
// this evaluation, as hookChildEnv does for hook children. Without it the guard
// follows process ancestry or the shared cursor, which can name another
// session's intent: its state decides the call and its record gets the writes.
// Only a session with a binding is pinned. Worker-scoped ids (a Copilot CLI
// toolu_* call, an OpenCode child session) have none; pinning them would
// replace an ancestry that names the owning session with the shared cursor.
function pinPayloadSession(parsed: ClaudeCodeHookInput, projectDir: string): () => void {
  const sessionId =
    typeof parsed.session_id === "string" ? validSessionId(parsed.session_id) : null;
  if (!sessionId || readSessionBinding(projectDir, sessionId) === null) return () => {};
  const previous = {
    AIDLC_SESSION_OVERRIDE: process.env.AIDLC_SESSION_OVERRIDE,
    AIDLC_SESSION_OVERRIDE_SOURCE: process.env.AIDLC_SESSION_OVERRIDE_SOURCE,
  };
  process.env.AIDLC_SESSION_OVERRIDE = sessionId;
  process.env.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
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
  const restore = pinPayloadSession(parsed, resolveProjectDirFromHook(import.meta.url));
  try {
    return await evaluate(parsed, input);
  } finally {
    restore();
  }
}

async function evaluate(parsed: ClaudeCodeHookInput, input: string): Promise<number> {
  // Runtime integrity is not a fence and cannot be disabled with this hook.
  if (refuseRuntimeIntegrityViolation(parsed)) return 2;

  // Deterministic off-switch: the Plan Approval fence is disabled, recorded once.
  if (resolveProjectFlag("AIDLC_DISABLE_PLAN_APPROVAL_GUARD") === "1") {
    try {
      recordGuardDisabled(input);
    } catch {
      // Fail-open: disabled fence bookkeeping does not refuse the call.
    }
    return 0;
  }

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
  const refuseProvenanceFailure = (reason: string): number => {
    recordHookDrop(projectDir, HOOK_NAME, reason);
    process.stderr.write(`${JSON.stringify({
      error: `Code Generation source provenance could not be committed. ${reason} Repair the source or runtime/audit write problem and retry; the plan-approval setting is unchanged.`,
      code: "CODE_GENERATION_PROVENANCE_UNAVAILABLE",
    })}\n`);
    return 2;
  };
  const refuseExecutionIneligible = (reason: string): number => {
    process.stderr.write(`${JSON.stringify({
      error: `Code Generation cannot start: ${reason.trim().replace(/\.*$/, ".")} The plan-approval setting is unchanged.`,
      code: "CODE_GENERATION_EXECUTION_INELIGIBLE",
    })}\n`);
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
            projectDir, toolName, toolInput, cwd, state, activeDirective,
            // Set by the adapter that ran the tool, outside the agent's input.
            parsed.aidlc_shell === "powershell",
          )
        : {
            targets: [],
            opaqueShell: true,
            shellCommand: `unknown mutation-capable tool: ${toolName}`,
          };
    // Shell redirects to pseudo-devices (2>/dev/null, 2>&1, 1>/dev/null) produce
    // write targets that defeat the framework-tool exemption: the guard sees
    // targets.length > 0, skips the early-exit, and falls through to the
    // directive check, which blocks bare framework-tool `next` commands
    // run with any redirect. Pseudo-device redirects are semantically
    // no-ops (they discard or pass through output), so exclude them from the
    // mutation-target count for the early-exit path. Real file redirects are
    // still tracked.
    const PSEUDO_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
    const realTargets = mutation.targets.filter(
      (t) => !PSEUDO_DEVICES.has(resolve(t)),
    );
    // `2>&1` and similar redirects take the opaque-shell path (the parser
    // reports an extra command). For framework-tool invocations, the exemption
    // already trusts the command; an opaque shell wrapper around a trusted
    // command should not trap it. Re-resolve the invocation to check. The
    // dynamic import is lazy: only needed when an opaque shell is detected,
    // so a stubbed review-freeze (tests) does not crash the guard at module
    // load time.
    let isFrameworkBash = false;
    if (mutation.opaqueShell && toolName === "Bash" && typeof toolInput.command === "string") {
      try {
        const {
          shellCommandAltersExecutableResolution,
          shellCommandInvocationDetails,
        } = await import("./aidlc-review-freeze.ts");
        // Re-resolve under the same dialect the primary analysis used: a
        // hinted PowerShell command keeps its PowerShell reading, so `&`
        // call-operator paths and cmdlets are judged the same way here.
        const hintedReading = parsed.aidlc_shell === "powershell"
          ? powerShellReading(toolInput.command, shellCommandInvocationDetails)
          : null;
        const reanalysed = hintedReading ?? toolInput.command;
        const reDialect: ShellDialect = {
          powerShell: hintedReading !== null,
          pathsAsWritten: hintedReading !== null,
          enginePaths: hintedReading !== null || process.platform === "win32",
        };
        const gateHeld = codeGenerationGateHeld(state);
        const invocations = shellCommandInvocationDetails(reanalysed);
        isFrameworkBash =
          !shellUsesDynamicEvaluation(reanalysed) &&
          !shellCommandAltersExecutableResolution(reanalysed) &&
          invocations.length > 0 &&
          invocations.every((invocation) =>
            !shellInvocationNeedsApproval(
              projectDir, cwd, invocation, mutation.targets.length > 0,
              reanalysed, gateHeld, reDialect,
              (engineArgs: readonly string[]) =>
                guardRecoveryAnswerAdmits(activeDirective, engineArgs, projectDir),
            )
          );
      } catch {
        isFrameworkBash = false;
      }
    }
    if (
      !guardedDispatch &&
      realTargets.length === 0 &&
      (!mutation.opaqueShell || isFrameworkBash)
    ) {
      return 0;
    }

    if (
      activeDirective?.version !== 2 ||
      directiveStage !== GUARDED_STAGE
    ) {
      authorityFailure = NO_CURRENT_DIRECTIVE;
      verdict = { block: true, mentioned: [] };
    } else {
      const recordDir = docsRoot(projectDir);
      units = gatherApprovalEvidence(projectDir, knownUnits(projectDir, recordDir));
      if (guardedDispatch) {
        verdict = evaluatePlanApprovalDispatch(toolName, subagentType, dispatchPrompt, {
          currentStage: activeDirective.stage,
          units,
        });
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
        // built or changed until they answer, including the plan files, so an
        // answer the agent wrote can never stand in for theirs.
        authorityFailure = PLAN_APPROVAL_ASK_OPEN;
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
          `workspace mutation cannot select one approval target from directive kind "${activeDirective.kind}"`;
        verdict = { block: true, mentioned: [] };
      } else {
        const unit = activeDirective.unit?.trim() || null;
        const target: CodeGenerationTarget = { unit };
        const approvalDir = resolve(codeGenerationRecordDir(projectDir, unit));
        const outsideRecord = mutation.targets.find(
          (candidate) =>
            !isTrustedRecordTarget(projectDir, candidate, approvalDir),
        );
        // Same isFrameworkBash exemption as the first early-exit above: an
        // opaque shell wrapper (2>&1, "; echo", etc.) around a trusted
        // framework-tool invocation should not trap a command whose write
        // targets are all inside the record dir. Without this, the
        // orchestrator cannot run `aidlc-testing-posture.ts render > file`
        // (with shell artifacts) to create the plan — the guard blocks the
        // very commands Steps 2-3 require.
        if (!outsideRecord && (!mutation.opaqueShell || isFrameworkBash)) return 0;
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
          mentioned: [unit ?? `stage:${GUARDED_STAGE}`],
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
      if (authorityFailure) {
        return refuseExecutionIneligible(
          authorityFailure === NO_CURRENT_DIRECTIVE
            ? `${authorityFailure}. Run a fresh \`aidlc-orchestrate.ts next\` and use that exact directive.`
            : authorityFailure === ENGINE_QUESTION_OPEN
              ? engineQuestionOpenReason()
            : authorityFailure === PLAN_APPROVAL_ASK_OPEN
              ? authorityBlockReason(authorityFailure)
              : authorityFailure,
        );
      }
      if (verdict.mentioned.length === 0) {
        return refuseExecutionIneligible("No valid execution target was identified. Run a fresh next and use the current worker brief.");
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
          return refuseExecutionIneligible(approval.reason || "An approved, executable plan is required for every selected target.");
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
      const guardAuthority = gate.authority;
      let recorded: boolean | undefined;
      const recordContinuation = (): boolean => {
        recorded ??= recordGuardStoodAside(projectDir, {
          fence: "plan-approval",
          authority: guardAuthority,
          stage: GUARDED_STAGE,
          tool: toolName,
          details: detail,
        });
        return recorded;
      };
      // A lowered fence keeps its permission decision, but an existing genuine
      // approval still needs source provenance before execution. Reuse the
      // locked start transaction even when edited content made the verdict fail.
      // This hook emits its own stand-aside row below, so begin only reports drift.
      if (!recordContinuation()) {
        return refuseProvenanceFailure("The lowered-fence continuation could not be recorded in the audit ledger.");
      }
      try {
        for (const notice of beginCodeGenerationBatch(
          projectDir, selected.map(({ target }) => target), { recordContinuation: false },
        )) {
          process.stdout.write(`${notice}\n`);
        }
      } catch (e) {
        return refuseProvenanceFailure(errorMessage(e));
      }
      recordContinuation();
      writeGuardStoodAside(guardStoodAsideLine("plan-approval", gate.source, detail));
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

  // No refusal names a switch. `guard.plan-approval off` is plan approval off
  // for the whole piece of work, which only the person ever proposes; an edited
  // plan is asked about again by `next`, and the reason below says so.
  const prose =
    `${authorityFailure
      ? authorityBlockReason(authorityFailure)
      : blockedMutation
      ? mutationBlockReason(
          blockedMutation.target,
          blockedMutation.unit,
          blockedMutation.opaqueShell,
          blockedMutation.detail,
        )
      : verdict.appendixInBrief
      ? appendixBlockReason(verdict.mentioned)
      : blockReason(verdict.mentioned, receiptDetail(units, verdict.mentioned))}`;
  process.stderr.write(`${prose}\n`);
  return 2; // harness PreToolUse reject contract: exit 2 + stderr blocks
}

if (import.meta.main) {
  const input = process.stdin.isTTY ? "" : await Bun.stdin.text();
  process.exit(await run(input));
}
