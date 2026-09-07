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
  readActiveDirectiveMarker,
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
}

/** The decision's verdict. `mentioned` carries the explicit marker value(s). */
export interface PlanApprovalVerdict {
  block: boolean;
  mentioned: string[];
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
  return {
    block:
      target === undefined ||
      !approvalEvidenceIsCurrent(target) ||
      contractMarkers.length !== 1 ||
      contractMarkers[0] !== target.contractHash,
    mentioned,
  };
}

// The block reason handed back to the conductor through the harness's
// PreToolUse error channel. Self-explaining and redirecting: it names the
// missing evidence and the exact stage steps that produce it, so the
// conductor self-corrects instead of retrying the same call.
export function blockReason(mentioned: string[]): string {
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
    `not currently approved. Finish Steps 2-3 in code-generation: update ` +
    `code-generation-plan.md and unit-test-instructions.md, refresh the Testing Contract and ` +
    `approval fingerprint, present Plan Approval, end the turn, and wait for the human's ` +
    `"Approve Plan" answer. Then retry the developer handoff with ` +
    `"AIDLC-UNIT: <unit>" or "AIDLC-STAGE: code-generation", followed by ` +
    `"AIDLC-TESTING-CONTRACT: <contract hash>".`
  );
}

export function mutationBlockReason(
  target: string,
  unit: string | null,
  opaqueShell = false,
): string {
  const scope = unit === null ? "the zero-Unit stage-level implementation" : `unit ${unit}`;
  const action = opaqueShell
    ? `run mutation-capable ${target}`
    : `modify workspace path "${target}"`;
  return (
    `Code generation cannot ${action} for ${scope} because ` +
    `the plan, unit-test instructions, and current Testing Contract are fingerprinted and ` +
    `approved. Writes inside the selected code-generation record directory remain ` +
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

export function gatherUnitEvidence(projectDir: string, units: string[]): UnitEvidence[] {
  return units.map((unit) => {
    const approval = evaluateCodeGenerationApproval(projectDir, { unit });
    return {
      unit,
      planExists: approval.planExists,
      instructionsExist: approval.instructionsExist,
      approved: approval.approved,
      contractValid: approval.contractValid,
      fingerprintValid: approval.fingerprintValid,
      receiptValid: approval.receiptValid,
      contractHash: approval.contractHash,
    };
  });
}

export function gatherApprovalEvidence(projectDir: string, units: string[]): UnitEvidence[] {
  const stageApproval = evaluateCodeGenerationApproval(projectDir, { unit: null });
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

  let verdict: PlanApprovalVerdict;
  let units: UnitEvidence[] = [];
  let authorityFailure: string | null = null;
  let blockedMutation: {
    target: string;
    unit: string | null;
    opaqueShell: boolean;
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
      const recordDir = docsRoot(projectDir);
      units = gatherApprovalEvidence(projectDir, knownUnits(projectDir, recordDir));
      if (guardedDispatch) {
        verdict = evaluatePlanApprovalDispatch(toolName, subagentType, dispatchPrompt, {
          currentStage: activeDirective.stage,
          units,
        });
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
    try {
      if (guardedDispatch) {
        for (const mentioned of verdict.mentioned) {
          beginCodeGeneration(projectDir, {
            unit:
              mentioned === `stage:${GUARDED_STAGE}` ? null : mentioned,
          });
        }
      } else if (blockedMutation === null) {
        const state = readFileSync(stateFilePath(projectDir), "utf-8");
        const marker = readActiveDirectiveMarker(projectDir, state);
        if (marker?.version === 2 && marker.kind === "run-stage") {
          beginCodeGeneration(projectDir, {
            unit: marker.unit?.trim() || null,
          });
        }
      }
    } catch (e) {
      authorityFailure =
        `Code Generation could not start from its protected approval receipt: ${errorMessage(e)}`;
      verdict = { block: true, mentioned: verdict.mentioned };
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
      : blockedMutation
      ? mutationBlockReason(
          blockedMutation.target,
          blockedMutation.unit,
          blockedMutation.opaqueShell,
        )
      : blockReason(verdict.mentioned)}\n`,
  );
  return 2; // harness PreToolUse reject contract: exit 2 + stderr blocks
}

if (import.meta.main) {
  const input = process.stdin.isTTY ? "" : await Bun.stdin.text();
  process.exit(await run(input));
}
