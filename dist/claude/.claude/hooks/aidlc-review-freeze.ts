// PreToolUse hook: deterministic enforcement of the §12a terminal-receipt
// ordering - the write-freeze between a terminal review receipt and the gate.
//
// The engine's completion precondition (aidlc-state.ts, via the shared
// freshReviewReceipts scan in aidlc-lib.ts) invalidates a REVIEW_COMPLETED
// receipt when a declared produces[] artifact is written after it - a
// deliberate fail-closed floor (a receipt must cover the final artifact
// bytes). Field traces showed prose losing the ordering contest: a conductor
// applied reviewer suggestions AFTER recording the terminal receipt, voided
// its own receipt, re-reviewed, re-edited, and oscillated until the live
// session wedged at the gate. Per the framework layering (determinism belongs
// in tools and hooks, knowledge in agents, judgement with humans), this hook
// is the ordering's deterministic twin: it refuses the produces[] write that
// would void a fresh terminal receipt, BEFORE the invalidation happens, with a
// reason that names the sanctioned paths (quote suggestions at the gate; or
// reject at the gate, which lifts the freeze for a revision).
//
// Freeze window - all facts read from the audit ledger and compiled graph:
//   - the target file matches a declared produces[]/optional_produces[]
//     artifact of a reviewer-bearing stage (same suffix matcher the engine
//     uses), AND
//   - that stage is not yet completed in the state file (an [x] stage's
//     artifacts are its permanent record; later stages may legitimately
//     append - e.g. a reviewer's `## Review` on a redo is a fresh attempt
//     whose floor already reset), AND
//   - a FRESH TERMINAL receipt covers the write target (stage receipt for
//     stage-level artifacts; that unit's receipt for a per-unit write).
// Everything the freeze must release on releases it automatically because
// the scan is shared with the engine: GATE_REJECTED, STAGE_JUMPED, and
// WORKFLOW_STARTED reset the floor (so post-rejection revisions are never
// frozen), a below-cap adversarial NOT-READY remains nonterminal so its repair
// loop can edit, and non-produces writes (diary, questions, contributions)
// never match. Terminal NOT-READY under the effective class freezes just like
// READY because no further review pass follows it.
//
// The block contract is the harness-native PreToolUse refuse: print a reason
// to stderr and exit 2; exit 0 allows. Fail-open everywhere: malformed stdin,
// no audit ledger, unreadable state or graph, an unknown tool, or any throw
// allows the call. The deterministic off-switch
// AIDLC_DISABLE_REVIEW_FREEZE_HOOK=1 disables enforcement entirely (the
// documented escape hatch for false-positive storms, mirroring the
// reviewer-scope hook's off-switch). Every genuine block emits a
// REVIEW_FREEZE_BLOCKED audit event; audit failures never change the decision.
//
// Bash is inspected before execution too. Shell writes do not pass through the
// Write/Edit PostToolUse audit feed, so allowing one after a terminal receipt
// would leave it fresh over different bytes. The matcher extracts output
// redirections and operands of common mutation commands; read-only shell calls
// do not produce targets and remain untouched.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  auditFilePath,
  type ClaudeCodeHookInput,
  errorMessage,
  freshReviewReceipts,
  getField,
  hooksHealthDir,
  intentRepos,
  isClaudeCodeHookInput,
  isoTimestamp,
  loadStageGraph,
  parseCheckboxes,
  producesArtifactUnit,
  readAllAuditShards,
  readStateFile,
  recordHookDrop,
  releaseAuditLock,
  resolveReviewClass,
  resolveProjectDirFromHook,
  type StageEntry,
} from "../tools/aidlc-lib.ts";

const HOOK_NAME = "review-freeze";

// The file-writing tools whose targets the freeze inspects. Read-only tools
// never invalidate a receipt.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (word.length > 0) words.push(word);
    word = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ";|&()<>".includes(ch)) {
      push();
      continue;
    }
    word += ch;
  }
  push();
  return words;
}

function shellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
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
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== ";" && ch !== "\n" && ch !== "|" && ch !== "&") continue;
    segments.push(command.slice(start, i));
    if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
    start = i + 1;
  }
  segments.push(command.slice(start));
  return segments;
}

export interface ShellInvocation {
  name: string;
  args: string[];
}

function consumeWrapperOptions(
  words: string[],
  index: number,
  shortValueOptions = new Set<string>(),
  longValueOptions = new Set<string>(),
): number {
  while (index < words.length) {
    const option = words[index];
    if (option === "--") return index + 1;
    if (option === "-" || !option.startsWith("-")) return index;
    if (option.startsWith("--")) {
      const equals = option.indexOf("=");
      const name = equals === -1 ? option : option.slice(0, equals);
      index++;
      if (equals === -1 && longValueOptions.has(name)) index++;
      continue;
    }
    const name = option.slice(0, 2);
    index++;
    if (shortValueOptions.has(name) && option.length === 2) index++;
  }
  return index;
}

function shellInvocation(words: string[], depth = 0): ShellInvocation | null {
  if (depth > 8) return null;
  let index = 0;
  const skipAssignments = () => {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;
  };
  skipAssignments();

  while (index < words.length) {
    const wrapper = basename(words[index]);
    if (["}", "fi", "done", "esac"].includes(wrapper)) return null;
    if (["{", "then", "else", "do", "!"].includes(wrapper)) {
      index++;
      skipAssignments();
      continue;
    }
    if (["for", "select", "case"].includes(wrapper)) return null;
    if (["if", "elif", "while", "until"].includes(wrapper)) {
      index++;
      skipAssignments();
      continue;
    }
    if (wrapper === "command") {
      index++;
      while (index < words.length && words[index].startsWith("-")) {
        const option = words[index++];
        if (option === "--") break;
        // `command -v/-V` queries a name; it does not execute the following word.
        if (option.includes("v") || option.includes("V")) return null;
      }
      skipAssignments();
      continue;
    }
    if (wrapper === "env") {
      index++;
      let splitCommand: string[] = [];
      while (index < words.length) {
        const option = words[index];
        if (option === "--") {
          index++;
          break;
        }
        if (option === "-S" || option === "--split-string") {
          const value = words[index + 1];
          if (!value) return null;
          splitCommand = shellWords(value);
          index += 2;
          continue;
        }
        if (option.startsWith("--split-string=")) {
          splitCommand = shellWords(option.slice("--split-string=".length));
          index++;
          continue;
        }
        if (/^(?:-u|--unset|-C|--chdir)$/.test(option)) {
          index += 2;
          continue;
        }
        if (/^(?:--unset|--chdir)=/.test(option) || option === "-i") {
          index++;
          continue;
        }
        if (option.startsWith("-")) {
          index++;
          continue;
        }
        break;
      }
      skipAssignments();
      if (splitCommand.length > 0) {
        return shellInvocation([...splitCommand, ...words.slice(index)], depth + 1);
      }
      continue;
    }

    const simpleWrappers: Record<
      string,
      { shortValues?: string[]; longValues?: string[] }
    > = {
      exec: {},
      nohup: {},
      nice: { shortValues: ["-n"], longValues: ["--adjustment"] },
      ionice: {
        shortValues: ["-c", "-n", "-p", "-P", "-u"],
        longValues: ["--class", "--classdata", "--pid", "--pgid", "--uid"],
      },
      stdbuf: {
        shortValues: ["-i", "-o", "-e"],
        longValues: ["--input", "--output", "--error"],
      },
      setsid: {},
      sudo: {
        shortValues: ["-C", "-D", "-g", "-h", "-p", "-r", "-t", "-T", "-u"],
        longValues: [
          "--chdir",
          "--close-from",
          "--group",
          "--host",
          "--prompt",
          "--role",
          "--type",
          "--user",
        ],
      },
      doas: { shortValues: ["-C", "-u"] },
      xargs: {
        shortValues: ["-a", "-E", "-I", "-L", "-n", "-P", "-s"],
        longValues: [
          "--arg-file",
          "--eof",
          "--replace",
          "--max-lines",
          "--max-args",
          "--max-procs",
          "--max-chars",
        ],
      },
      time: {
        shortValues: ["-f", "-o"],
        longValues: ["--format", "--output"],
      },
      unbuffer: {},
    };
    const spec = simpleWrappers[wrapper];
    if (spec) {
      index = consumeWrapperOptions(
        words,
        index + 1,
        new Set(spec.shortValues ?? []),
        new Set(spec.longValues ?? []),
      );
      skipAssignments();
      continue;
    }

    if (wrapper === "timeout") {
      index = consumeWrapperOptions(
        words,
        index + 1,
        new Set(["-k", "-s"]),
        new Set(["--kill-after", "--signal"]),
      );
      if (index < words.length) index++; // duration
      skipAssignments();
      continue;
    }

    break;
  }

  const executable = words[index];
  if (!executable) return null;
  return {
    name: basename(executable),
    args: words.slice(index + 1),
  };
}

export function shellCommandInvocations(command: string): ShellInvocation[] {
  const invocations: ShellInvocation[] = [];
  for (const segment of shellCommandSegments(command)) {
    const invocation = shellInvocation(shellWords(segment));
    if (invocation) invocations.push(invocation);
  }
  return invocations;
}

function shellWordAt(command: string, start: number): { word: string; end: number } | null {
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let i = start;
  for (; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || ";|&()<>".includes(ch)) break;
    word += ch;
  }
  return quote === null && word.length > 0 ? { word, end: i } : null;
}

function normalizeShellTarget(target: string, cwd: string): string {
  const bracedPwd = "$" + "{PWD}";
  let cleaned = target
    .replace(/^of=/, "")
    .replace(/^[,:[\]{}()]+|[,:[\]{}()]+$/g, "");
  if (cleaned === "$PWD" || cleaned === bracedPwd) {
    cleaned = cwd;
  } else if (cleaned.startsWith("$PWD/")) {
    cleaned = join(cwd, cleaned.slice("$PWD/".length));
  } else if (cleaned.startsWith(`${bracedPwd}/`)) {
    cleaned = join(cwd, cleaned.slice(`${bracedPwd}/`.length));
  }
  if (cleaned.length === 0 || /[$`*?]/.test(cleaned)) return "";
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

interface ParsedShellArgs {
  operands: string[];
  options: Set<string>;
  optionValues: Map<string, string[]>;
}

function parseShellArgs(
  args: string[],
  shortValueOptions = new Set<string>(),
  longValueOptions = new Set<string>(),
): ParsedShellArgs {
  const operands: string[] = [];
  const options = new Set<string>();
  const optionValues = new Map<string, string[]>();
  let optionsEnded = false;
  const record = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    const values = optionValues.get(name) ?? [];
    values.push(value);
    optionValues.set(name, values);
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      options.add(name);
      if (!longValueOptions.has(name)) continue;
      if (equals !== -1) record(name, arg.slice(equals + 1));
      else record(name, args[++i]);
      continue;
    }

    // Short options may be clustered. A value-taking option consumes the
    // cluster remainder (`-t/tmp`) or the next word (`-t /tmp`).
    for (let j = 1; j < arg.length; j++) {
      const name = `-${arg[j]}`;
      options.add(name);
      if (!shortValueOptions.has(name)) continue;
      const attached = arg.slice(j + 1);
      record(name, attached.length > 0 ? attached : args[++i]);
      break;
    }
  }

  return { operands, options, optionValues };
}

/** Concrete filesystem targets of a mutation-capable shell command. */
export function shellWriteTargets(command: string, cwd = process.cwd()): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const target = normalizeShellTarget(raw, cwd);
    if (target) out.push(target);
  };
  const isDirectory = (raw: string | undefined): boolean => {
    if (!raw) return false;
    const target = normalizeShellTarget(raw, cwd);
    if (!target) return false;
    try {
      return statSync(target).isDirectory();
    } catch {
      return false;
    }
  };
  const addDestination = (
    rawDestination: string | undefined,
    rawSources: string[],
    directoryDestination: boolean,
  ) => {
    add(rawDestination);
    if (!rawDestination || !directoryDestination) return;
    const destination = normalizeShellTarget(rawDestination, cwd);
    if (!destination) return;
    // cp/install/mv accept a directory destination. Add each concrete child
    // candidate as well as the destination itself without consulting the
    // pre-command filesystem, which may not contain the directory yet.
    for (const rawSource of rawSources) {
      const source = normalizeShellTarget(rawSource, cwd);
      if (source) add(join(destination, basename(source)));
    }
  };

  // Scan output redirections outside quotes. This catches compact forms such
  // as `printf x>>file` as well as quoted targets and $PWD-relative paths.
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
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== ">") continue;

    let targetStart = i + 1;
    if (command[targetStart] === ">" || command[targetStart] === "|") targetStart++;
    while (/\s/.test(command[targetStart] ?? "")) targetStart++;
    // `2>&1` and `2>&-` duplicate/close descriptors; `>&file` writes a file.
    if (command[targetStart] === "&") {
      const fd = shellWordAt(command, targetStart + 1);
      if (!fd || /^\d+$|^-$/.test(fd.word)) continue;
      add(fd.word);
      i = fd.end - 1;
      continue;
    }
    const parsed = shellWordAt(command, targetStart);
    if (!parsed) continue;
    add(parsed.word);
    i = parsed.end - 1;
  }

  // Parse each command segment independently so a mutator never claims a
  // later read-only command's operands. Only destination/in-place operands are
  // candidates for commands that also have read-only source operands.
  for (const { name: commandName, args } of shellCommandInvocations(command)) {
    if (commandName === "dd") {
      for (const arg of args) if (arg.startsWith("of=")) add(arg);
      continue;
    }

    const basic = parseShellArgs(args);
    const { operands } = basic;
    if (operands.length === 0) continue;

    if (commandName === "cp") {
      const parsed = parseShellArgs(
        args,
        new Set(["-S", "-t"]),
        new Set(["--suffix", "--target-directory"]),
      );
      const targetDirectory = [
        ...(parsed.optionValues.get("-t") ?? []),
        ...(parsed.optionValues.get("--target-directory") ?? []),
      ].at(-1);
      const destination = targetDirectory ?? parsed.operands.at(-1);
      const hasTargetDirectory = targetDirectory !== undefined;
      const sources = hasTargetDirectory ? parsed.operands : parsed.operands.slice(0, -1);
      addDestination(
        destination,
        sources,
        hasTargetDirectory || sources.length > 1 || isDirectory(destination),
      );
    } else if (commandName === "install") {
      const parsed = parseShellArgs(
        args,
        new Set(["-g", "-m", "-o", "-S", "-t"]),
        new Set(["--group", "--mode", "--owner", "--suffix", "--target-directory"]),
      );
      const targetDirectory = [
        ...(parsed.optionValues.get("-t") ?? []),
        ...(parsed.optionValues.get("--target-directory") ?? []),
      ].at(-1);
      if (parsed.options.has("-d") || parsed.options.has("--directory")) {
        for (const operand of parsed.operands) add(operand);
      } else {
        const destination = targetDirectory ?? parsed.operands.at(-1);
        const hasTargetDirectory = targetDirectory !== undefined;
        const sources = hasTargetDirectory ? parsed.operands : parsed.operands.slice(0, -1);
        addDestination(
          destination,
          sources,
          hasTargetDirectory || sources.length > 1 || isDirectory(destination),
        );
      }
    } else if (commandName === "mv") {
      const parsed = parseShellArgs(
        args,
        new Set(["-S", "-t"]),
        new Set(["--suffix", "--target-directory"]),
      );
      const targetDirectory = [
        ...(parsed.optionValues.get("-t") ?? []),
        ...(parsed.optionValues.get("--target-directory") ?? []),
      ].at(-1);
      const destination = targetDirectory ?? parsed.operands.at(-1);
      const hasTargetDirectory = targetDirectory !== undefined;
      const sources = hasTargetDirectory ? parsed.operands : parsed.operands.slice(0, -1);
      for (const source of sources) add(source);
      addDestination(
        destination,
        sources,
        hasTargetDirectory || sources.length > 1 || isDirectory(destination),
      );
    } else if (["rm", "tee", "touch", "truncate", "unlink"].includes(commandName)) {
      const parsed =
        commandName === "touch"
          ? parseShellArgs(
              args,
              new Set(["-d", "-r", "-t"]),
              new Set(["--date", "--reference", "--time"]),
            )
          : commandName === "truncate"
            ? parseShellArgs(
                args,
                new Set(["-r", "-s"]),
                new Set(["--reference", "--size"]),
              )
            : basic;
      for (const operand of parsed.operands) add(operand);
    } else if (commandName === "sed") {
      const parsed = parseShellArgs(
        args,
        new Set(["-e", "-f", "-l"]),
        new Set(["--expression", "--file", "--line-length"]),
      );
      if (!parsed.options.has("-i") && !parsed.options.has("--in-place")) continue;
      const programFromOption =
        parsed.optionValues.has("-e") ||
        parsed.optionValues.has("-f") ||
        parsed.optionValues.has("--expression") ||
        parsed.optionValues.has("--file");
      for (const operand of parsed.operands.slice(programFromOption ? 0 : 1)) add(operand);
    } else if (commandName === "perl") {
      const parsed = parseShellArgs(
        args,
        new Set(["-E", "-F", "-I", "-M", "-e", "-m"]),
      );
      if (!parsed.options.has("-i") && !parsed.options.has("--in-place")) continue;
      const programFromOption = parsed.optionValues.has("-e") || parsed.optionValues.has("-E");
      for (const operand of parsed.operands.slice(programFromOption ? 0 : 1)) add(operand);
    }
  }

  return [...new Set(out)];
}

/** Target paths of a write-tool call. */
export function writeTargets(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  cwd = process.cwd(),
): string[] {
  if (toolName === "Bash") {
    const command = toolInput?.command;
    return typeof command === "string" ? shellWriteTargets(command, cwd) : [];
  }
  if (!WRITE_TOOLS.has(toolName)) return [];
  const ti = toolInput ?? {};
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) out.push(v);
  };
  push(ti.file_path);
  push(ti.notebook_path);
  push(ti.path);
  if (Array.isArray(ti.paths)) for (const p of ti.paths) push(p);
  return out;
}

export interface FreezeVerdict {
  block: boolean;
  /** The offending path (block=true). */
  target?: string;
  /** The stage whose receipt the write would void. */
  stage?: string;
  /** The per-unit target, when the write is unit-scoped. */
  unit?: string;
}

/** The freeze decision for one write target against one stage. Pure over the
 *  supplied receipts; exported so the decision table is unit-testable. */
export function judgeFreeze(
  stage: Pick<
    StageEntry,
    "slug" | "for_each" | "reviewer" | "produces" | "optional_produces"
  >,
  file: string,
  recordedRepos: ReadonlySet<string>,
  receipts: { stageVerdict: string | null; unitVerdicts: Map<string, string> },
): FreezeVerdict {
  const targetUnit = producesArtifactUnit(stage, file, recordedRepos);
  if (targetUnit === undefined) return { block: false }; // not this stage's artifact
  if (stage.for_each === "unit-of-work") {
    if (targetUnit !== null) {
      // A unit-scoped write voids that unit's receipt only.
      if (receipts.unitVerdicts.has(targetUnit)) {
        return { block: true, target: file, stage: stage.slug, unit: targetUnit };
      }
      return { block: false };
    }
    // Ambiguous per-unit path: the engine fails closed by clearing EVERY unit
    // receipt, so freeze if any unit currently holds a terminal receipt.
    for (const [unit, verdict] of receipts.unitVerdicts) {
      if (verdict === "READY" || verdict === "NOT-READY") {
        return { block: true, target: file, stage: stage.slug, unit };
      }
    }
    return { block: false };
  }
  if (receipts.stageVerdict !== null) {
    return { block: true, target: file, stage: stage.slug };
  }
  return { block: false };
}

// The block reason handed back through the harness's PreToolUse error
// channel. Self-explaining and redirecting: it names the invariant, the
// sanctioned route for suggestions, and the route that legitimately reopens
// the artifact, so a blocked call is a recoverable nudge, not a halt.
export function blockReason(v: FreezeVerdict): string {
  const scope = v.unit ? `stage "${v.stage}" unit "${v.unit}"` : `stage "${v.stage}"`;
  return (
    `review-freeze: "${v.target}" is a declared produces[] artifact of ${scope}, ` +
    `which holds a fresh terminal review receipt. Writing it now would invalidate ` +
    `that receipt and the engine would refuse the gate (stage-protocol-reviewer.md §12a: the ` +
    `terminal receipt ends artifact work). Present the gate instead - quote any ` +
    `reviewer suggestions there verbatim for the human to weigh. If the artifact ` +
    `genuinely needs changes, reject at the gate (or have the human request ` +
    `changes); the recorded rejection lifts this freeze and the revision then ` +
    `re-runs the stage-protocol-reviewer.md §12a reviewer for a fresh receipt.`
  );
}

// --- Main ---------------------------------------------------------------------

export async function run(input: string): Promise<number> {
  // Deterministic off-switch: enforcement disabled entirely.
  if (process.env.AIDLC_DISABLE_REVIEW_FREEZE_HOOK === "1") return 0;

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, `${HOOK_NAME}.last`), isoTimestamp(), "utf-8");
  } catch {
    // Heartbeat failure is non-fatal - never let it affect the decision.
  }

  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(input);
    if (!isClaudeCodeHookInput(raw)) return 0;
    parsed = raw;
  } catch {
    return 0; // malformed stdin - fail open
  }

  const toolName = parsed.tool_name ?? "";
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : projectDir;
  const targets = writeTargets(toolName, parsed.tool_input, cwd);
  if (targets.length === 0) return 0;

  // No audit ledger means no receipts to protect - the common non-AIDLC case,
  // decided before any state/graph read so the hook stays near-free outside a
  // workflow.
  try {
    if (readAllAuditShards(projectDir).length === 0) return 0;
  } catch {
    return 0;
  }

  let verdict: FreezeVerdict = { block: false };
  try {
    const content = readStateFile(projectDir);
    // Only NOT-completed reviewer-bearing stages can hold a receipt the gate
    // still depends on. Completed ([x]) and skipped stages are excluded: their
    // artifacts are permanent record, and a redo re-opens them via jump or
    // reject - both of which reset the shared scan's floor anyway.
    const openSlugs = new Set(
      parseCheckboxes(content)
        .filter((c) => c.state !== "completed" && c.state !== "skipped")
        .map((c) => c.slug),
    );
    const recordedRepos = new Set(intentRepos(projectDir));
    for (const stage of loadStageGraph()) {
      if (!stage.reviewer || !openSlugs.has(stage.slug)) continue;
      // Cheap suffix pre-check via producesArtifactUnit happens inside
      // judgeFreeze; the receipt scan only runs for a stage that actually
      // matched a target (freshReviewReceipts walks the whole ledger).
      let receipts: ReturnType<typeof freshReviewReceipts> | null = null;
      for (const file of targets) {
        const probe = producesArtifactUnit(stage, file, recordedRepos);
        if (probe === undefined) continue;
        const reviewClass = resolveReviewClass(
          stage.review_class ?? "adversarial",
          getField(content, "Scope") ?? "",
          content,
        );
        receipts ??= freshReviewReceipts(projectDir, content, stage, {
          reviewClass,
        });
        verdict = judgeFreeze(stage, file, recordedRepos, receipts);
        if (verdict.block) break;
      }
      if (verdict.block) break;
    }
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    return 0; // state/graph unreadable or matcher failure - fail open
  }
  if (!verdict.block) return 0;

  // Audit the refusal so the run's record shows when the freeze bit.
  // Best-effort: an audit failure never changes the block decision. The lock
  // acquisition is TIME-BOUNDED well below the standard 5s budget (5 x 50ms):
  // the block decision is already made, and a lock-starved fan-out must not
  // stretch a fast refuse into a laggy one - a dropped advisory row is
  // preferable to a slow block.
  try {
    if (existsSync(auditFilePath(projectDir))) {
      if (acquireAuditLock(projectDir, 5, 50)) {
        try {
          appendAuditEntryUnlocked(
            "REVIEW_FREEZE_BLOCKED",
            {
              Tool: toolName,
              Target: verdict.target ?? "",
              Stage: verdict.stage ?? "",
              ...(verdict.unit ? { Unit: verdict.unit } : {}),
            },
            projectDir,
          );
        } finally {
          releaseAuditLock(projectDir);
        }
      } else {
        recordHookDrop(projectDir, HOOK_NAME, "audit lock contended; REVIEW_FREEZE_BLOCKED row dropped (block still enforced)");
      }
    }
  } catch {
    // Advisory emission only.
  }

  process.stderr.write(`${blockReason(verdict)}\n`);
  return 2; // harness PreToolUse reject contract: exit 2 + stderr blocks
}

if (import.meta.main) {
  const input = process.stdin.isTTY ? "" : await Bun.stdin.text();
  process.exit(await run(input));
}
