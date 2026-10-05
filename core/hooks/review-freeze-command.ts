import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
// The file-writing tools whose targets the freeze inspects. Read-only tools
// never invalidate a receipt.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (wordStarted) words.push(word);
    word = "";
    wordStarted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      word += ch;
      wordStarted = true;
      escaped = false;
      continue;
    }
    if (
      ch === "\\" &&
      quote === '"' &&
      !'$`"\\\n'.includes(command[i + 1] ?? "")
    ) {
      word += ch;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      wordStarted = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStarted = true;
      continue;
    }
    if (ch === "<" || ch === ">" || (!wordStarted && /\d/.test(ch))) {
      const descriptorRedirect =
        /^\d*[<>]&[ \t]*(?:\d+|-)(?=$|[ \t\n;|&()<>])/.exec(command.slice(i));
      if (descriptorRedirect) {
        // Shell descriptors are syntax, not argv. In particular, keeping a
        // trailing "2" or "1" would change a mutator's apparent destination.
        push();
        i += descriptorRedirect[0].length - 1;
        continue;
      }
    }
    if (/\s/.test(ch) || ";|&()<>".includes(ch)) {
      push();
      continue;
    }
    word += ch;
    wordStarted = true;
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
    if (
      ch === "\\" &&
      quote === '"' &&
      !'$`"\\\n'.includes(command[i + 1] ?? "")
    ) {
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
    // Descriptor duplication/closure is one redirection operator, not a
    // background separator followed by a command named "1" or "-". Only shell
    // blanks/newlines delimit it: Unicode whitespace can be part of a filename.
    if (ch === ">" || ch === "<") {
      const descriptorRedirect =
        /^[<>]&[ \t]*(?:\d+|-)(?=$|[ \t\n;|&()<>])/.exec(command.slice(i));
      if (descriptorRedirect) {
        i += descriptorRedirect[0].length - 1;
        continue;
      }
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
  ambiguous?: boolean;
}

export interface ShellInvocationDetails extends ShellInvocation {
  executable?: string;
  launchers?: string[];
  dataDriven?: boolean;
  dataDrivenMutation?: boolean;
  executableResolutionChanged?: boolean;
}

function shellExecutableName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const leaf = normalized.slice(normalized.lastIndexOf("/") + 1);
  return leaf.replace(/\.(?:exe|com|cmd|bat)$/i, "").toLowerCase();
}

interface WrapperOptionSpec {
  shortValues?: readonly string[];
  longValues?: readonly string[];
  shortOptionalValues?: readonly string[];
  longOptionalValues?: readonly string[];
  shortFlags?: readonly string[];
  longFlags?: readonly string[];
  numericShortValue?: boolean;
}

interface ShellInvocationParseState {
  executableResolutionChanged: boolean;
}

function changesExecutableResolution(name: string): boolean {
  return /^(?:PATH|PATHEXT)$/i.test(name);
}

function consumeWrapperOptions(
  words: string[],
  index: number,
  spec: WrapperOptionSpec,
): { index: number; ambiguous: boolean } {
  const shortValues = new Set(spec.shortValues ?? []);
  const longValues = new Set(spec.longValues ?? []);
  const shortOptionalValues = new Set(spec.shortOptionalValues ?? []);
  const longOptionalValues = new Set(spec.longOptionalValues ?? []);
  const shortFlags = new Set(spec.shortFlags ?? []);
  const longFlags = new Set(spec.longFlags ?? []);
  while (index < words.length) {
    const option = words[index];
    if (option === "--") return { index: index + 1, ambiguous: false };
    if (option === "-" || !option.startsWith("-")) return { index, ambiguous: false };
    if (option.startsWith("--")) {
      const equals = option.indexOf("=");
      const name = equals === -1 ? option : option.slice(0, equals);
      if (longValues.has(name)) {
        if (equals !== -1) {
          index++;
        } else if (words[index + 1] !== undefined) {
          index += 2;
        } else {
          return { index, ambiguous: true };
        }
        continue;
      }
      if (longOptionalValues.has(name) || longFlags.has(name)) {
        index++;
        continue;
      }
      return { index, ambiguous: true };
    }
    if (spec.numericShortValue && /^-\d+$/.test(option)) {
      index++;
      continue;
    }
    const name = option.slice(0, 2);
    if (shortValues.has(name)) {
      if (option.length > 2) {
        index++;
      } else if (words[index + 1] !== undefined) {
        index += 2;
      } else {
        return { index, ambiguous: true };
      }
      continue;
    }
    if (shortOptionalValues.has(name)) {
      index++;
      continue;
    }
    if (
      option.length > 1 &&
      [...option.slice(1)].every((flag) => shortFlags.has(`-${flag}`))
    ) {
      index++;
      continue;
    }
    return { index, ambiguous: true };
  }
  return { index, ambiguous: false };
}

function shellInvocation(
  words: string[],
  depth = 0,
  dataDriven = false,
  launchers: string[] = [],
  state: ShellInvocationParseState = {
    executableResolutionChanged: false,
  },
): ShellInvocationDetails | null {
  if (depth > 8) return null;
  let index = 0;
  const skipAssignments = () => {
    while (index < words.length) {
      const match = words[index].match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
      if (!match) break;
      if (changesExecutableResolution(match[1])) {
        state.executableResolutionChanged = true;
      }
      index++;
    }
  };
  skipAssignments();

  while (index < words.length) {
    const wrapper = shellExecutableName(words[index]);
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
      launchers.push(words[index]);
      index++;
      while (index < words.length && words[index].startsWith("-")) {
        const option = words[index++];
        if (option === "--") break;
        // `command -v/-V` queries a name; it does not execute the following word.
        if (option.includes("v") || option.includes("V")) return null;
        if (![...option.slice(1)].every((flag) => flag === "p")) {
          return { name: "", args: [], ambiguous: true };
        }
      }
      skipAssignments();
      continue;
    }
    if (wrapper === "builtin") {
      launchers.push(words[index]);
      index++;
      if (words[index] === "--") index++;
      else if ((words[index] ?? "").startsWith("-")) {
        return { name: "", args: [], ambiguous: true };
      }
      skipAssignments();
      continue;
    }
    if (wrapper === "env") {
      launchers.push(words[index]);
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
        if (option.startsWith("-S") && option.length > 2) {
          splitCommand = shellWords(option.slice(2));
          index++;
          continue;
        }
        if (/^-(?:u|C|a).+/.test(option)) {
          if (
            option.startsWith("-u") &&
            changesExecutableResolution(option.slice(2))
          ) {
            state.executableResolutionChanged = true;
          }
          index++;
          continue;
        }
        if (/^(?:-u|--unset|-C|--chdir|-a|--argv0)$/.test(option)) {
          if (
            (option === "-u" || option === "--unset") &&
            changesExecutableResolution(words[index + 1] ?? "")
          ) {
            state.executableResolutionChanged = true;
          }
          index += 2;
          continue;
        }
        if (option.startsWith("--unset=")) {
          if (changesExecutableResolution(option.slice("--unset=".length))) {
            state.executableResolutionChanged = true;
          }
          index++;
          continue;
        }
        if (
          /^(?:--chdir|--argv0)=/.test(option) ||
          option === "-" ||
          option === "-i" ||
          option === "--ignore-environment" ||
          option === "-0" ||
          option === "--null"
        ) {
          if (
            option === "-" ||
            option === "-i" ||
            option === "--ignore-environment"
          ) {
            state.executableResolutionChanged = true;
          }
          index++;
          continue;
        }
        if (/^-[i0v]+$/.test(option)) {
          if (option.includes("i")) state.executableResolutionChanged = true;
          index++;
          continue;
        }
        if (
          option === "-v" ||
          option === "--debug" ||
          option === "--list-signal-handling" ||
          option === "--help" ||
          option === "--version" ||
          /^(?:--default-signal|--ignore-signal|--block-signal)(?:=.*)?$/.test(option)
        ) {
          index++;
          continue;
        }
        if (option.startsWith("-")) return { name: "", args: [], ambiguous: true };
        break;
      }
      skipAssignments();
      if (splitCommand.length > 0) {
        return shellInvocation(
          [...splitCommand, ...words.slice(index)],
          depth + 1,
          dataDriven,
          launchers,
          state,
        );
      }
      continue;
    }

    if (wrapper === "busybox" || wrapper === "toybox") {
      launchers.push(words[index]);
      index++;
      if (!words[index] || words[index].startsWith("-")) {
        return { name: "", args: [], ambiguous: true, launchers };
      }
      continue;
    }

    const simpleWrappers: Record<string, WrapperOptionSpec> = {
      exec: { shortValues: ["-a"], shortFlags: ["-c", "-l"] },
      nohup: { longFlags: ["--help", "--version"] },
      nice: {
        shortValues: ["-n"],
        longValues: ["--adjustment"],
        longFlags: ["--help", "--version"],
        numericShortValue: true,
      },
      ionice: {
        shortValues: ["-c", "-n", "-p", "-P", "-u"],
        longValues: ["--class", "--classdata", "--pid", "--pgid", "--uid"],
        shortFlags: ["-t"],
        longFlags: ["--ignore", "--help", "--version"],
      },
      stdbuf: {
        shortValues: ["-i", "-o", "-e"],
        longValues: ["--input", "--output", "--error"],
        longFlags: ["--help", "--version"],
      },
      setsid: {
        shortFlags: ["-c", "-f", "-w"],
        longFlags: ["--ctty", "--fork", "--wait", "--help", "--version"],
      },
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
        shortOptionalValues: ["-E"],
        longOptionalValues: ["--preserve-env"],
        shortFlags: ["-A", "-b", "-e", "-H", "-K", "-k", "-l", "-n", "-P", "-S", "-s", "-V", "-v"],
        longFlags: [
          "--askpass",
          "--background",
          "--edit",
          "--help",
          "--login",
          "--non-interactive",
          "--remove-timestamp",
          "--reset-timestamp",
          "--set-home",
          "--shell",
          "--stdin",
          "--validate",
          "--version",
        ],
      },
      doas: {
        shortValues: ["-C", "-u"],
        shortFlags: ["-L", "-n", "-s"],
      },
      xargs: {
        shortValues: ["-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-s"],
        longValues: [
          "--arg-file",
          "--delimiter",
          "--max-args",
          "--max-procs",
          "--max-chars",
          "--process-slot-var",
        ],
        shortOptionalValues: ["-e", "-i", "-l"],
        longOptionalValues: ["--eof", "--replace", "--max-lines"],
        shortFlags: ["-0", "-o", "-p", "-r", "-t", "-x"],
        longFlags: [
          "--null",
          "--open-tty",
          "--interactive",
          "--no-run-if-empty",
          "--show-limits",
          "--verbose",
          "--exit",
          "--help",
          "--version",
        ],
      },
      time: {
        shortValues: ["-f", "-o"],
        longValues: ["--format", "--output"],
        shortFlags: ["-a", "-p", "-v"],
        longFlags: ["--append", "--portability", "--verbose", "--help", "--version"],
      },
      unbuffer: { shortFlags: ["-p"] },
    };
    const spec = simpleWrappers[wrapper];
    if (spec) {
      launchers.push(words[index]);
      const consumed = consumeWrapperOptions(words, index + 1, spec);
      if (consumed.ambiguous) return { name: "", args: [], ambiguous: true };
      index = consumed.index;
      dataDriven ||= wrapper === "xargs";
      skipAssignments();
      continue;
    }

    if (wrapper === "timeout") {
      launchers.push(words[index]);
      const consumed = consumeWrapperOptions(words, index + 1, {
        shortValues: ["-k", "-s"],
        longValues: ["--kill-after", "--signal"],
        longFlags: [
          "--foreground",
          "--preserve-status",
          "--verbose",
          "--help",
          "--version",
        ],
      });
      if (consumed.ambiguous) return { name: "", args: [], ambiguous: true };
      index = consumed.index;
      if (index < words.length) index++; // duration
      skipAssignments();
      continue;
    }

    break;
  }

  const executable = words[index];
  if (!executable) return null;
  const name = shellExecutableName(executable);
  const args = words.slice(index + 1);
  return {
    name,
    args,
    executable,
    ...(launchers.length > 0 ? { launchers } : {}),
    ...(dataDriven ? { dataDriven: true } : {}),
    ...(dataDriven && invocationMayMutate(name, args)
      ? { dataDrivenMutation: true }
      : {}),
    ...(state.executableResolutionChanged
      ? { executableResolutionChanged: true }
      : {}),
  };
}

export function shellCommandInvocationDetails(
  command: string,
): ShellInvocationDetails[] {
  const invocations: ShellInvocationDetails[] = [];
  for (const segment of shellCommandSegments(command)) {
    const invocation = shellInvocation(shellWords(segment));
    if (invocation) invocations.push(invocation);
  }
  return invocations;
}

export function shellCommandAltersExecutableResolution(command: string): boolean {
  for (const segment of shellCommandSegments(command)) {
    const state: ShellInvocationParseState = {
      executableResolutionChanged: false,
    };
    shellInvocation(shellWords(segment), 0, false, [], state);
    if (state.executableResolutionChanged) return true;
  }
  return false;
}

export function shellCommandInvocations(command: string): ShellInvocation[] {
  return shellCommandInvocationDetails(command).map(
    ({
      dataDriven: _dataDriven,
      dataDrivenMutation: _dataDrivenMutation,
      executable: _executable,
      executableResolutionChanged: _executableResolutionChanged,
      launchers: _launchers,
      ...invocation
    }) => invocation,
  );
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
    // Same double-quote rule as shellWords: inside "..." a backslash escapes
    // only $ ` " \ and newline, so a quoted Windows path keeps its separators.
    if (
      ch === "\\" &&
      quote === '"' &&
      !'$`"\\\n'.includes(command[i + 1] ?? "")
    ) {
      word += ch;
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

function findTraversalRoots(args: string[]): string[] {
  let index = 0;
  while (["-H", "-L", "-P"].includes(args[index] ?? "")) index++;
  while ((args[index] ?? "").startsWith("-D")) {
    if (args[index] === "-D") index += 2;
    else index++;
  }
  if (/^-O\d+$/.test(args[index] ?? "")) index++;

  const roots: string[] = [];
  for (; index < args.length; index++) {
    const arg = args[index];
    if (
      arg === "!" ||
      arg === "(" ||
      arg === ")" ||
      arg.startsWith("-") ||
      arg === ","
    ) {
      break;
    }
    roots.push(arg);
  }
  return roots.length > 0 ? roots : ["."];
}

const STATIC_REMOVE_COMMANDS = new Set([
  "rmdir",
  "rd",
  "del",
  "erase",
  "shred",
  "remove-item",
  "clear-item",
  "ri",
  "cli",
]);

const STATIC_MOVE_COMMANDS = new Set([
  "move",
  "rename",
  "move-item",
  "rename-item",
  "mi",
  "ren",
  "rni",
]);

// A PowerShell command argument: a parameter (`-Name`, or `-Name:value` with
// the value attached) or a value. A value written a,b is an array.
interface CmdletArg {
  parameter?: string;
  values: string[];
  attached?: boolean;
  // The word as written, for a parameter that may turn out to be a value.
  written?: string;
}

// How a cmdlet that writes file content binds its arguments.
interface CmdletWrite {
  // Positional slots in binding order. A slot is filled by its first name,
  // or by any later name bound explicitly (-LiteralPath fills -Path's slot).
  positional: string[][];
  // The parameters whose values are the paths written.
  paths: string[];
  // The parameter whose value names a child of each path (New-Item -Name).
  child?: string;
  // A parameter whose set writes no file (Tee-Object -Variable). Bound with
  // a value and no path named, the command writes nothing: with the quotes
  // known that settles it; a dequoted reading also needs no positional,
  // unknown, starved or -- word beside it (see cmdletWriteTargets).
  fileless?: string;
  // Other parameters that take a value.
  valued: string[];
  // Parameters that take no value.
  switches: string[];
  aliases: Record<string, string>;
  // The path can arrive from the pipeline (Get-Item a | Set-Content -Value x).
  pipelinePath: boolean;
}

const COMMON_VALUED_PARAMETERS = [
  "erroraction",
  "errorvariable",
  "informationaction",
  "informationvariable",
  "outbuffer",
  "outvariable",
  "pipelinevariable",
  "progressaction",
  "warningaction",
  "warningvariable",
];
const COMMON_SWITCH_PARAMETERS = ["confirm", "debug", "verbose", "whatif"];
const COMMON_PARAMETER_ALIASES: Record<string, string> = {
  cf: "confirm",
  db: "debug",
  ea: "erroraction",
  ev: "errorvariable",
  infa: "informationaction",
  iv: "informationvariable",
  ob: "outbuffer",
  ov: "outvariable",
  proga: "progressaction",
  pv: "pipelinevariable",
  vb: "verbose",
  wa: "warningaction",
  wi: "whatif",
  wv: "warningvariable",
};

const CONTENT_WRITE: CmdletWrite = {
  positional: [["path", "literalpath"], ["value"]],
  paths: ["path", "literalpath"],
  valued: ["value", "encoding", "filter", "include", "exclude", "credential", "stream"],
  switches: ["passthru", "force", "nonewline", "asbytestream"],
  aliases: { pspath: "literalpath", lp: "literalpath" },
  pipelinePath: true,
};

const CMDLET_WRITES: Record<string, CmdletWrite> = {
  "set-content": CONTENT_WRITE,
  "add-content": CONTENT_WRITE,
  "clear-content": {
    positional: [["path", "literalpath"]],
    paths: ["path", "literalpath"],
    valued: ["filter", "include", "exclude", "credential", "stream"],
    switches: ["force"],
    aliases: { pspath: "literalpath", lp: "literalpath" },
    pipelinePath: true,
  },
  "out-file": {
    positional: [["filepath", "literalpath"], ["encoding"]],
    paths: ["filepath", "literalpath"],
    valued: ["encoding", "inputobject", "width"],
    switches: ["append", "force", "noclobber", "nonewline"],
    aliases: { path: "filepath", pspath: "literalpath", lp: "literalpath", nooverwrite: "noclobber" },
    pipelinePath: false,
  },
  "tee-object": {
    positional: [["filepath", "literalpath"]],
    paths: ["filepath", "literalpath"],
    fileless: "variable",
    valued: ["encoding", "inputobject", "variable"],
    switches: ["append"],
    aliases: { path: "filepath", pspath: "literalpath", lp: "literalpath" },
    pipelinePath: false,
  },
  "new-item": {
    positional: [["path"]],
    paths: ["path"],
    child: "name",
    valued: ["name", "itemtype", "value", "credential"],
    switches: ["force"],
    aliases: { type: "itemtype", target: "value" },
    pipelinePath: true,
  },
  "set-item": {
    positional: [["path", "literalpath"], ["value"]],
    paths: ["path", "literalpath"],
    valued: ["value", "filter", "include", "exclude", "credential"],
    switches: ["force", "passthru"],
    aliases: { pspath: "literalpath", lp: "literalpath" },
    pipelinePath: true,
  },
};

// The paths a content cmdlet writes. Named parameters bind by name or
// unambiguous prefix, so a value passed by name (-Value x, -Encoding utf8) is
// not a target. Every positional value is: `a, b` read as two words, or a
// value read as a parameter, would otherwise move a path into the Value
// slot. Positional slots still decide whether a path was given, for a path
// bound from the pipeline. A parameter it does not know might be a switch,
// so its values count too.
//
// That reading needs the quotes: in `Set-Content -Value '-Value' <path>` the
// quoted word is a value. A POSIX reading has removed them, so it passes
// `exact: false` and every value counts, as well as the paths bound.
function cmdletWriteTargets(
  spec: CmdletWrite,
  args: CmdletArg[],
  exact: boolean,
): { targets: string[]; pathBound: boolean } {
  const valued = new Set([...spec.valued, ...spec.paths, ...COMMON_VALUED_PARAMETERS]);
  const switches = new Set([...spec.switches, ...COMMON_SWITCH_PARAMETERS]);
  const names = [...valued, ...switches];
  const aliases: Record<string, string> = { ...COMMON_PARAMETER_ALIASES, ...spec.aliases };
  const resolveName = (written: string): string | null => {
    const name = written.toLowerCase();
    if (valued.has(name) || switches.has(name)) return name;
    if (Object.hasOwn(aliases, name)) return aliases[name];
    const matches = names.filter((candidate) => candidate.startsWith(name));
    return matches.length === 1 ? matches[0] : null;
  };
  const bound = new Map<string, string[]>();
  const positionals: string[][] = [];
  const unknown: string[] = [];
  let unknownParameter = false;
  let endOfParameters = false;
  // Parameters that take a value but met a word that looks like a parameter
  // or nothing: in a dequoted reading each may have been a quoted value.
  const starved: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (endOfParameters || arg.parameter === undefined) {
      // A bare -- ends the parameters: every later word is a value.
      if (!endOfParameters && isEndOfParameters(arg)) {
        endOfParameters = true;
        continue;
      }
      // After --, a word that looked like a parameter is the value as written.
      positionals.push(
        arg.parameter === undefined ? arg.values : [arg.written ?? `-${arg.parameter}`, ...arg.values],
      );
      continue;
    }
    const name = resolveName(arg.parameter);
    if (name === null) {
      unknownParameter = true;
      unknown.push(...arg.values);
      continue;
    }
    if (switches.has(name)) {
      // `-Switch: value` gives the switch the next word, whatever it is.
      if (!arg.attached && arg.written?.endsWith(":") && index + 1 < args.length) {
        index++;
        if (!exact) starved.push(arg.written);
      }
      continue;
    }
    // Dequoted, '-Variable:x' may have been a quoted path on a drive named
    // -Variable, so an attached fileless value leaves the binding in doubt.
    if (!exact && arg.attached && name === spec.fileless) unknownParameter = true;
    let values = arg.values;
    if (!arg.attached) {
      const next = args[index + 1];
      values = next !== undefined && next.parameter === undefined ? next.values : [];
      if (next !== undefined && next.parameter === undefined) index++;
      else if (!exact) starved.push(arg.written ?? `-${arg.parameter}`);
    }
    bound.set(name, [...(bound.get(name) ?? []), ...values]);
  }
  const end = args.findIndex(isEndOfParameters);
  // A dequoted reading knows the binding is fileless only when nothing in it
  // is in doubt; with the quotes known, a bound -Variable settles it.
  if (
    spec.fileless !== undefined && (bound.get(spec.fileless)?.length ?? 0) > 0 &&
    !spec.paths.some((name) => bound.has(name)) &&
    (exact || (starved.length === 0 && !unknownParameter && positionals.length === 0 && end < 0))
  ) {
    return { targets: [], pathBound: false };
  }
  let next = 0;
  for (const slot of spec.positional) {
    if (slot.some((name) => bound.has(name))) continue;
    if (next >= positionals.length) break;
    bound.set(slot[0], positionals[next++]);
  }
  const pathBound = spec.paths.some((name) => bound.has(name));
  let targets = spec.paths.flatMap((name) => bound.get(name) ?? []);
  const children = spec.child === undefined ? undefined : bound.get(spec.child);
  if (children !== undefined) {
    const parents = targets.length > 0 ? targets : ["."];
    targets = parents.flatMap((parent) => children.map((child) => join(parent, child)));
  }
  targets.push(...positionals.flat());
  if (unknownParameter) targets.push(...unknown);
  if (!exact) {
    targets.push(...args.flatMap((arg) => arg.values), ...starved);
    // A -- the binding gave to a parameter still ends the parameters.
    if (end >= 0) {
      for (const arg of args.slice(end + 1)) {
        if (arg.parameter !== undefined) targets.push(arg.written ?? `-${arg.parameter}`);
      }
    }
  }
  return { targets, pathBound };
}

// A bare --: PowerShell reads every later word as a value.
function isEndOfParameters(arg: CmdletArg): boolean {
  return arg.parameter === undefined && arg.values.length === 1 && arg.values[0] === "--";
}

// POSIX shell words read as PowerShell arguments. A value is also read as
// each of its comma-separated parts, since `a,b` may be an array; a value
// written -Name=x or --Name:x also as x; and -Name.x, -Name(x), -Name[x] or
// -Name{x} also as what follows the name, where PowerShell ends it.
function cmdletArgs(words: string[]): CmdletArg[] {
  const parts = (value: string): string[] =>
    [...new Set([value, ...value.split(",")])].filter((part) => part !== "");
  return words.map((word) => {
    const match = /^-([A-Za-z_][\w-]*)(?::(.*))?$/s.exec(word);
    if (!match) {
      const attachedValue = ATTACHED_OPTION.exec(word)?.[2] ?? /^-[A-Za-z_][\w-]*([.([{].*)$/s.exec(word)?.[1];
      return { values: [...new Set([...parts(word), ...(attachedValue ? parts(attachedValue) : [])])] };
    }
    // `-Name: value` takes the next word, as `-Name value` does.
    return !match[2]
      ? { parameter: match[1], values: [], written: word }
      : { parameter: match[1], values: parts(match[2]), attached: true, written: word };
  });
}

// An option with its value attached: -name=value, --name:value.
const ATTACHED_OPTION = /^-{1,2}([^:=]+)[:=](.+)$/s;

function attachedPathOptionValues(
  args: string[],
  pathOptions = new Set([
    "path",
    "literalpath",
    "destination",
    "newname",
    "filepath",
  ]),
): string[] {
  const out: string[] = [];
  for (const arg of args) {
    const match = ATTACHED_OPTION.exec(arg);
    if (match && pathOptions.has(match[1].toLowerCase())) out.push(match[2]);
  }
  return out;
}

function invocationMayMutate(commandName: string, args: string[]): boolean {
  if (
    [
      "cp",
      "dd",
      "install",
      "mv",
      "rm",
      "rsync",
      "tee",
      "touch",
      "truncate",
      "unlink",
      "copy-item",
    ].includes(commandName) ||
    STATIC_REMOVE_COMMANDS.has(commandName) ||
    STATIC_MOVE_COMMANDS.has(commandName) ||
    Object.hasOwn(CMDLET_WRITES, commandName)
  ) {
    return true;
  }
  if (commandName === "sed") {
    const parsed = parseShellArgs(
      args,
      new Set(["-e", "-f", "-l"]),
      new Set(["--expression", "--file", "--line-length"]),
    );
    return parsed.options.has("-i") || parsed.options.has("--in-place");
  }
  if (commandName === "perl") {
    const parsed = parseShellArgs(
      args,
      new Set(["-E", "-F", "-I", "-M", "-e", "-m"]),
    );
    return parsed.options.has("-i") || parsed.options.has("--in-place");
  }
  return (
    commandName === "find" &&
    args.some((arg) =>
      ["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg)
    )
  );
}

// The shell a command line is written for. The adapter says when a command
// runs in PowerShell; every other command is read as POSIX shell.
export type CommandShell = "posix" | "powershell";

// PowerShell reads the typographic quotes and dashes as ' " and -.
const isPowerShellSingleQuote = (ch: string | undefined): boolean =>
  ch !== undefined && "'‘’‚‛".includes(ch);
const isPowerShellDoubleQuote = (ch: string | undefined): boolean =>
  ch !== undefined && '"“”„'.includes(ch);
const POWERSHELL_PARAMETER = /^[-–—―]([A-Za-z_][\w-]*)$/;
const POWERSHELL_TYPE_NAME = /\[[^\s;|&<>\]]*\]/y;
const isPowerShellBlank = (ch: string): boolean =>
  ch !== "\n" && ch !== "\r" && /\s/.test(ch);

// The index after a quoted string that opens at `start`, or the end of the
// command when it never closes. A doubled quote is one literal quote.
function powerShellQuoteEnd(command: string, start: number): number {
  const double = isPowerShellDoubleQuote(command[start]);
  const closes = double ? isPowerShellDoubleQuote : isPowerShellSingleQuote;
  for (let i = start + 1; i < command.length; i++) {
    const ch = command[i];
    if (double && ch === "`") {
      i++;
      continue;
    }
    if (double && ch === "$" && command[i + 1] === "(") {
      i = powerShellGroupEnd(command, i + 1) - 1;
      continue;
    }
    if (!closes(ch)) continue;
    if (closes(command[i + 1])) {
      i++;
      continue;
    }
    return i + 1;
  }
  return command.length;
}

// The index after the (...), {...} or [...] group that opens at `start`,
// quotes and inner groups included, or the end of an unclosed command.
function powerShellGroupEnd(command: string, start: number): number {
  const closers: string[] = [];
  for (let i = start; i < command.length; i++) {
    const ch = command[i];
    if (ch === "`") {
      i++;
    } else if (isPowerShellSingleQuote(ch) || isPowerShellDoubleQuote(ch)) {
      i = powerShellQuoteEnd(command, i) - 1;
    } else if (ch === "(") {
      closers.push(")");
    } else if (ch === "{") {
      closers.push("}");
    } else if (ch === "[") {
      closers.push("]");
    } else if (ch === closers.at(-1)) {
      closers.pop();
      if (closers.length === 0) return i + 1;
    }
  }
  return command.length;
}

interface PowerShellWord {
  arg: CmdletArg;
  // Written without quotes, variables or groups.
  bare: boolean;
  // Holds a variable or a group, so its value is computed.
  computed: boolean;
  // Holds a backtick escape, so it is never a parameter or `--%`.
  escaped?: boolean;
}

// One PowerShell argument-mode word from `start`. Backslashes are literal;
// a backtick escapes the next character; single quotes are literal and a
// doubled quote inside is one quote. Text inside (...), $(...), @(...) and
// {...} runs as commands of its own, so it is handed to `nested`; the word
// keeps the group as written.
function powerShellWord(
  command: string,
  start: number,
  nested: string[],
  // A redirect target is a value, whatever it looks like.
  asValue = false,
): { word: PowerShellWord; end: number } {
  const values: string[] = [];
  let value = "";
  let parameter: string | undefined;
  let attached = false;
  let bare = true;
  let computed = false;
  let quoted = false;
  // A backtick anywhere (`-Name, -`Name) makes the word a value.
  let escaped = asValue;
  let i = start;
  while (i < command.length) {
    const ch = command[i];
    if (isPowerShellBlank(ch) || ";|&<>\n\r".includes(ch)) break;
    if (ch === "`") {
      if (command[i + 1] === "\n" || command[i + 1] === "\r") break;
      escaped = true;
      value += command[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === ",") {
      // An array continues past blanks after its comma: a, b is one value.
      values.push(value);
      value = "";
      i++;
      for (;;) {
        if (i < command.length && (isPowerShellBlank(command[i]) || command[i] === "\n" || command[i] === "\r")) i++;
        else if (command[i] === "`" && command[i + 1] === "\n") i += 2;
        else if (command[i] === "`" && command[i + 1] === "\r") i += command[i + 2] === "\n" ? 3 : 2;
        else break;
      }
      continue;
    }
    if (isPowerShellSingleQuote(ch)) {
      let j = i + 1;
      for (; j < command.length; j++) {
        if (!isPowerShellSingleQuote(command[j])) {
          value += command[j];
        } else if (isPowerShellSingleQuote(command[j + 1])) {
          value += command[j++];
        } else {
          break;
        }
      }
      bare = false;
      quoted = true;
      i = j + 1;
      continue;
    }
    if (isPowerShellDoubleQuote(ch)) {
      let j = i + 1;
      for (; j < command.length; j++) {
        const inner = command[j];
        if (inner === "`") {
          value += command[++j] ?? "";
        } else if (inner === "$" && command[j + 1] === "(") {
          const groupEnd = powerShellGroupEnd(command, j + 1);
          nested.push(command.slice(j + 2, groupEnd - 1));
          value += command.slice(j, groupEnd);
          computed = true;
          j = groupEnd - 1;
        } else if (isPowerShellDoubleQuote(inner)) {
          if (!isPowerShellDoubleQuote(command[j + 1])) break;
          value += command[j++];
        } else {
          if (inner === "$") computed = true;
          value += inner;
        }
      }
      bare = false;
      quoted = true;
      i = j + 1;
      continue;
    }
    // A parameter name ends at ( { . or [: -Path(...) and -Path.x are -Path
    // and its value.
    if (
      "({.[".includes(ch) && parameter === undefined && bare && !escaped &&
      values.length === 0 && POWERSHELL_PARAMETER.test(value)
    ) {
      break;
    }
    const sigil = (ch === "$" || ch === "@") && "({".includes(command[i + 1] ?? "");
    // [Type] closes within the word; any other [ is an ordinary character.
    POWERSHELL_TYPE_NAME.lastIndex = i;
    const typeName = ch === "[" && value === "" && POWERSHELL_TYPE_NAME.test(command);
    if (sigil || ch === "(" || ch === "{" || typeName) {
      const open = sigil ? i + 1 : i;
      const end = powerShellGroupEnd(command, open);
      // ${name} is a variable and [Type] a type name: neither runs commands.
      if (!(ch === "$" && command[open] === "{") && ch !== "[") {
        nested.push(command.slice(open + 1, Math.max(open + 1, end - 1)));
      }
      // A group that holds one string literal is that string.
      const literal = (ch === "(" || (ch === "@" && command[open] === "(")) &&
        /^\(\s*(?:'([^']*)'|"([^"`$]*)")\s*\)$/.exec(command.slice(open, end));
      if (literal) {
        value += literal[1] ?? literal[2];
        bare = false;
        quoted = true;
        i = end;
        continue;
      }
      value += command.slice(i, end);
      bare = false;
      computed = true;
      i = end;
      continue;
    }
    // $name is a variable and @name splats one.
    if (ch === "$" || (ch === "@" && value === "" && /[\w?]/.test(command[i + 1] ?? ""))) {
      bare = false;
      computed = true;
    }
    if (ch === ":" && parameter === undefined && bare && !escaped && values.length === 0) {
      const match = POWERSHELL_PARAMETER.exec(value);
      if (match) {
        parameter = match[1];
        attached = true;
        value = "";
        i++;
        continue;
      }
    }
    value += ch;
    i++;
  }
  if (value !== "" || quoted || values.length > 0 || attached) values.push(value);
  if (parameter === undefined && bare && !escaped && values.length === 1) {
    const match = POWERSHELL_PARAMETER.exec(values[0]);
    if (match) {
      return {
        word: { arg: { parameter: match[1], values: [], written: command.slice(start, i) }, bare, computed },
        end: i,
      };
    }
  }
  // `-Name: value` attaches the next word.
  if (attached && values.length === 1 && values[0] === "" && !quoted) {
    return { word: { arg: { parameter, values: [], written: command.slice(start, i) }, bare, computed }, end: i };
  }
  return {
    word: {
      arg: attached
        ? { parameter, values, attached: true, written: command.slice(start, i) }
        : { values },
      bare,
      computed,
      escaped,
    },
    end: i,
  };
}

interface PowerShellCommand {
  // The command name, or null for an expression or a computed name.
  name: string | null;
  args: CmdletArg[];
  // Receives pipeline input.
  piped: boolean;
}

// This reader answers what a command line may write, so it reads every line
// and keeps the words it cannot place as candidates. It does not evaluate
// what PowerShell computes (variables, groups, splatting): those words are
// read as written. plainPowerShell in aidlc-plan-approval-guard.ts answers a
// different question: whether a line is plain enough to run unreviewed under
// its POSIX rendering, so it refuses every line it cannot render exactly.
// The two keep separate policies.
//
// The commands and redirect targets of a PowerShell command line. Statements
// end at ; && || a newline or a background &; a pipeline joins commands with
// |. Groups go to `nested` (see powerShellWord).
function readPowerShell(
  command: string,
  nested: string[],
): { commands: PowerShellCommand[]; redirects: string[] } {
  const commands: PowerShellCommand[] = [];
  const redirects: string[] = [];
  let words: PowerShellWord[] = [];
  let call = false;
  let piped = false;
  const finish = (pipeNext: boolean) => {
    // `$x = command ...` runs the command on the right: a variable target
    // ($x, $x.y, ${x}, $a[0], [type]$x) and operator (=, +=, ??=), glued or
    // spaced, through a chain of up to eight assignments.
    const rightOf = (text: string, rest: PowerShellWord[]): PowerShellWord[] =>
      text === ""
        ? rest
        : [{ arg: { values: [text] }, bare: !/^[$[]/.test(text), computed: /^[$[]/.test(text) }, ...rest];
    for (let chain = 0; chain < 8 && !call && words.length > 0; chain++) {
      const [first, second] = words;
      if (first.arg.parameter !== undefined || !first.computed) break;
      const text = first.arg.values.join(",");
      const glued = /^(?:\[[^\]]*\])*\$[^=\s]*?(?:[-+*/%]|\?\?)?=(.*)$/s.exec(text);
      const spaced = second !== undefined && second.arg.parameter === undefined
        ? /^(?:[-+*/%]|\?\?)?=(.*)$/s.exec(second.arg.values.join(","))
        : null;
      if (glued) words = rightOf(glued[1], words.slice(1));
      else if (spaced) words = rightOf(spaced[1], words.slice(2));
      else break;
    }
    if (words.length > 0) {
      const [first, ...rest] = words;
      const named = first.arg.parameter === undefined && first.arg.values.length === 1 &&
        (call ? !first.computed : first.bare && !/^[\d.]+$/.test(first.arg.values[0]));
      commands.push({
        name: named ? shellExecutableName(first.arg.values[0]) : null,
        args: named ? rest.map((word) => word.arg) : [],
        piped,
      });
    }
    words = [];
    call = false;
    piped = pipeNext;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (isPowerShellBlank(ch)) {
      i++;
      continue;
    }
    if (ch === "`" && (command[i + 1] === "\n" || command[i + 1] === "\r")) {
      i += command[i + 1] === "\r" && command[i + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";") {
      // A newline after | continues the pipeline on the next line.
      if (ch === ";" || !piped || words.length > 0) finish(false);
      i++;
      continue;
    }
    if (ch === "|") {
      const or = command[i + 1] === "|";
      finish(!or);
      i += or ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        finish(false);
        i += 2;
      } else if (words.length === 0 && !call) {
        call = true;
        i++;
      } else {
        finish(false);
        i++;
      }
      continue;
    }
    if (ch === "#") {
      while (i < command.length && command[i] !== "\n" && command[i] !== "\r") i++;
      continue;
    }
    if (ch === "<" && command[i + 1] === "#") {
      const close = command.indexOf("#>", i + 2);
      i = close < 0 ? command.length : close + 2;
      continue;
    }
    if (ch === "<") {
      i++;
      continue;
    }
    const redirect = /^[1-6*]?>>?(&[1-6])?/.exec(command.slice(i));
    if (redirect) {
      i += redirect[0].length;
      // n>&1 merges one stream into another; it writes no file.
      if (redirect[1] !== undefined) continue;
      while (i < command.length && isPowerShellBlank(command[i])) i++;
      const target = powerShellWord(command, i, nested, true);
      i = target.end;
      if (target.word.arg.values.length > 0) redirects.push(target.word.arg.values.join(","));
      continue;
    }
    const wordStart = i;
    const { word, end } = powerShellWord(command, i, nested);
    if (end === i) {
      // A character no word takes: skip it.
      i++;
      continue;
    }
    i = end;
    if (word.bare && !word.escaped && word.arg.parameter === undefined && word.arg.values[0] === "--%") {
      // The stop-parsing token hands the rest of the line over as written.
      let stop = i;
      while (stop < command.length && command[stop] !== "\n" && command[stop] !== "\r") stop++;
      for (const rest of command.slice(i, stop).split(/\s+/).filter(Boolean)) {
        words.push({ arg: { values: [rest] }, bare: true, computed: false });
      }
      i = stop;
      continue;
    }
    // `a ,b` and `a , b` continue the array that a began.
    const previous = words.length > 1 ? words[words.length - 1] : undefined;
    if (
      command[wordStart] === "," && previous !== undefined &&
      (previous.arg.parameter === undefined || previous.arg.attached)
    ) {
      previous.arg.values.push(...word.arg.values.slice(1));
      continue;
    }
    words.push(word);
  }
  finish(false);
  return { commands, redirects };
}

// PowerShell aliases of the commands shellWriteTargets reads. Aliases that
// share a name with a native program (cp, mv, rm, tee) keep the native
// reading unless the arguments are PowerShell's (see powerShellCommandName).
const POWERSHELL_ALIASES: Record<string, string> = {
  ac: "add-content",
  clc: "clear-content",
  copy: "copy-item",
  cpi: "copy-item",
  ni: "new-item",
  sc: "set-content",
  si: "set-item",
  tee: "tee-object",
};

function powerShellCommandName(name: string, args: CmdletArg[]): string {
  if (Object.hasOwn(POWERSHELL_ALIASES, name)) return POWERSHELL_ALIASES[name];
  // Copy-Item's -Destination is not cp's -t.
  if (
    name === "cp" &&
    args.some((arg) => arg.parameter !== undefined && arg.parameter.length > 1)
  ) {
    return "copy-item";
  }
  return name;
}

// The mutating cmdlets that take their path from the pipeline when none is
// written (Get-ChildItem aidlc | Remove-Item).
const POWERSHELL_PIPELINE_PATH_COMMANDS = new Set([
  "remove-item",
  "ri",
  "del",
  "erase",
  "rd",
  "rm",
  "rmdir",
  "clear-item",
  "cli",
  "move-item",
  "mi",
  "move",
  "mv",
  "rename-item",
  "rni",
  "ren",
  "copy-item",
]);

// Output sent to the null device is discarded, never written to a file.
function isNullDevice(raw: string): boolean {
  return raw === "/dev/null" || (process.platform === "win32" && /^nul$/i.test(raw));
}

// Commands that change the shell's working directory for the commands after them.
export const SHELL_DIRECTORY_CHANGES = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);
const MAX_SHELL_ROOTS = 64;

// The directories a bare `cd` or a leading `~` or $HOME names: HOME, else the
// OS home. PowerShell on Windows takes them from its user profile instead
// (USERPROFILE, or HOMEDRIVE and HOMEPATH), never from HOME.
function shellHomes(powerShell: boolean): string[] {
  if (!powerShell || process.platform !== "win32") return [resolve(process.env.HOME || homedir())];
  const homes = [process.env.USERPROFILE || homedir()];
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) homes.push(process.env.HOMEDRIVE + process.env.HOMEPATH);
  return [...new Set(homes.map((home) => resolve(home)))];
}

// A word's readings with a leading `~`, `$HOME` or `${HOME}` expanded to each
// of shellHomes, or none. The quoting is gone by the time a word gets here and
// a quoted `~` is not expanded, so callers keep the literal reading of a `~`
// word beside these; a `$HOME` word has no literal reading (a word with `$`
// resolves to none). A PowerShell word also takes `\` as a separator and its
// variable names in any case. No other variable is read from the hook's
// environment: an `$env:` word is a computed word, like `$X`.
function homeReadings(word: string, powerShell = false): string[] {
  const text = powerShell ? word.replaceAll("\\", "/") : word;
  const lead = (powerShell ? /^(?:~|\$HOME|\$\{HOME\})/i : /^(?:~|\$HOME|\$\{HOME\})/).exec(text);
  if (lead === null) return [];
  const rest = text.slice(lead[0].length);
  if (rest !== "" && !rest.startsWith("/")) return [];
  return shellHomes(powerShell).map((home) => resolve(join(home, rest)));
}

// A segment with its redirections removed, so `cd 2>/dev/null` is read as a
// bare `cd`. Quotes are respected: a `>` inside a quoted word is not one.
function withoutRedirections(segment: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote !== null) {
      out += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') out += segment[++i] ?? "";
      continue;
    }
    if (ch === "\\") {
      out += ch + (segment[++i] ?? "");
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch !== ">" && ch !== "<") {
      out += ch;
      continue;
    }
    // A descriptor number or `&` written against the operator belongs to it.
    out = out.replace(/(?:^|(?<=\s))(?:\d+|&)$/, "");
    while (">|&<".includes(segment[i + 1] ?? "x")) i++;
    while (segment[i + 1] === " " || segment[i + 1] === "\t") i++;
    // The operator's word, quotes and all.
    let wordQuote: "'" | '"' | null = null;
    while (i + 1 < segment.length) {
      const next = segment[i + 1];
      if (wordQuote === null && (/\s/.test(next) || ";|&<>".includes(next))) break;
      i++;
      if (wordQuote !== null) {
        if (next === wordQuote) wordQuote = null;
      } else if (next === "'" || next === '"') {
        wordQuote = next;
      } else if (next === "\\") {
        i++;
      }
    }
    out += " ";
  }
  return out;
}

/**
 * The directories the shell can be in when the command's writes run: `cwd`,
 * and each literal `cd`/`pushd`/`chdir`/`Set-Location` target resolved from
 * every directory collected anywhere in the command. A bare `cd` or `chdir`
 * (options and redirections aside) and a leading `~`, `$HOME` or `${HOME}`
 * name $HOME (see shellHomes). The order of the segments, loops, functions, subshells and
 * pipelines is not modelled, so a write can also be read from a directory it
 * never runs in. A computed target ($VAR, glob), `cd -`, `pushd`'s stack
 * operands (`+1`; bash's `cd +1` names a directory) and `pushd -n` add nothing. Past the cap the oldest collected directories are
 * dropped, never `cwd`, a home or the newest, so an absolute `cd` late in a
 * long command still counts. A command `shell` names as PowerShell is read
 * as PowerShell: `Set-Location` and `Push-Location` (and their aliases) by
 * their -Path, -LiteralPath or first positional value, a `\` as a separator,
 * and a bare Set-Location names its homes; `~`, `$HOME` and `${HOME}` there
 * take either separator (see homeReadings).
 */
export function shellDirectoryRoots(
  command: string,
  cwd = process.cwd(),
  shell: CommandShell = "posix",
): string[] {
  const homes = shellHomes(shell === "powershell");
  const roots = [resolve(cwd)];
  const pinned = new Set(roots);
  const add = (dir: string, pin = false) => {
    if (pin) pinned.add(dir);
    const at = roots.indexOf(dir);
    if (at === 0) return;
    if (at > 0) roots.splice(at, 1);
    roots.push(dir);
    while (roots.length - pinned.size > MAX_SHELL_ROOTS) {
      const oldest = roots.findIndex((root) => !pinned.has(root));
      if (oldest < 0) break;
      roots.splice(oldest, 1);
    }
  };
  // A literal operand is read from every directory collected so far.
  const change = (operand: string) => {
    const next = new Set<string>();
    for (const root of roots) {
      const dir = normalizeShellTarget(operand, root);
      if (dir) next.add(dir);
    }
    for (const reading of homeReadings(operand, shell === "powershell")) next.add(reading);
    for (const dir of next) add(dir, homes.includes(dir));
  };
  if (shell === "powershell") {
    for (const operand of powerShellLocationChanges(command, 0)) {
      if (operand === null) for (const home of homes) add(home, true);
      else change(operand);
    }
    return roots;
  }
  for (const move of shellDirectoryChanges(command)) {
    if (typeof move === "object") change(move.operand);
    else if (move === "home") for (const home of homes) add(home, true);
  }
  return roots;
}

/**
 * Where each directory change (a SHELL_DIRECTORY_CHANGES name) in a POSIX
 * command moves the shell, in the order written, read with its redirections
 * removed, so `cd 2>/dev/null dir` moves to `dir`. Runtime integrity's
 * audit-trail pass reads directory changes through this too.
 */
export function shellDirectoryChanges(command: string): DirectoryChange[] {
  const out: DirectoryChange[] = [];
  for (const segment of shellCommandSegments(command)) {
    const invocation = shellInvocation(shellWords(withoutRedirections(segment)));
    if (invocation && SHELL_DIRECTORY_CHANGES.has(invocation.name.toLowerCase())) {
      out.push(directoryChange(invocation.name, invocation.args));
    }
  }
  return out;
}

// Where a POSIX directory change (a SHELL_DIRECTORY_CHANGES name) moves the
// shell: to a literal operand, to $HOME (a bare `cd` or `chdir`), nowhere
// (`pushd -n`), or to a directory the command cannot see (`cd -`, pushd's
// stack, a bare `pushd`). A word after `--` is the operand, `-` aside, which
// is still $OLDPWD. Only pushd reads +N as a stack entry in bash, whose cd
// takes it as a directory (zsh's cd reads its stack: the directory reading
// then only adds a candidate).
export type DirectoryChange = { operand: string } | "home" | "stay" | "unknown";

function directoryChange(name: string, args: string[]): DirectoryChange {
  const command = name.toLowerCase();
  const end = args.indexOf("--");
  const options = end >= 0 ? args.slice(0, end) : args;
  const pushd = command === "pushd";
  if (pushd && options.includes("-n")) return "stay";
  const operand = end >= 0
    ? args[end + 1]
    : args.find((arg) => !arg.startsWith("-") && !(pushd && /^\+\d*$/.test(arg)));
  if (operand === "-") return "unknown";
  if (operand !== undefined) return { operand };
  const previous = options.some((arg) => /^[+-]\d*$/.test(arg));
  return !previous && (command === "cd" || command === "chdir") ? "home" : "unknown";
}

// How Set-Location and Push-Location bind the directory they move to.
const LOCATION_CHANGE: CmdletWrite = {
  positional: [["path", "literalpath"]],
  paths: ["path", "literalpath"],
  valued: ["stackname"],
  switches: ["passthru"],
  aliases: { pspath: "literalpath", lp: "literalpath" },
  pipelinePath: false,
};
const POWERSHELL_LOCATION_COMMANDS: Record<string, "set-location" | "push-location"> = {
  "set-location": "set-location",
  cd: "set-location",
  chdir: "set-location",
  sl: "set-location",
  "push-location": "push-location",
  pushd: "push-location",
};

// The directory operands of a PowerShell command line's location changes, in
// groups too, with `\` read as a separator; null for a bare Set-Location,
// read as each of shellHomes. `-` and `+` (the location history) add nothing.
function powerShellLocationChanges(command: string, depth: number): Array<string | null> {
  if (depth > 8) return [];
  const nested: string[] = [];
  const out: Array<string | null> = [];
  for (const { name, args } of readPowerShell(command, nested).commands) {
    const location = name === null || !Object.hasOwn(POWERSHELL_LOCATION_COMMANDS, name)
      ? null
      : POWERSHELL_LOCATION_COMMANDS[name];
    if (location === null) continue;
    // The binding lists a positional path twice (its slot, and every positional).
    const targets = new Set(cmdletWriteTargets(LOCATION_CHANGE, args, true).targets);
    if (targets.size === 0 && location === "set-location") out.push(null);
    for (const target of targets) {
      if (target !== "-" && target !== "+") out.push(target.replaceAll("\\", "/"));
    }
  }
  for (const inner of nested) out.push(...powerShellLocationChanges(inner, depth + 1));
  return out;
}

/**
 * Concrete filesystem targets of a mutation-capable shell command. A relative
 * target is resolved from each directory `shellDirectoryRoots` collects, so
 * `cd .kiro && echo x > hooks/y` names `.kiro/hooks/y`; the reading from `cwd`
 * stays among them. When `rawWords` is given it also
 * receives every target word as written, before resolution, including the
 * words resolution drops ($VAR, globs). A command `shell` names as
 * PowerShell is read as PowerShell (see readPowerShell).
 */
export function shellWriteTargets(
  command: string,
  cwd = process.cwd(),
  rawWords?: string[],
  shell: CommandShell = "posix",
): string[] {
  const out = new Set<string>();
  shellDirectoryRoots(command, cwd, shell).forEach((root, index) => {
    for (const target of shellWriteTargetsFrom(command, root, index === 0 ? rawWords : undefined, shell)) out.add(target);
  });
  return [...out];
}

function shellWriteTargetsFrom(
  command: string,
  cwd: string,
  rawWords: string[] | undefined,
  shell: CommandShell,
): string[] {
  const powerShell = shell === "powershell";
  // PowerShell's file system provider takes \ as a separator on every host.
  // PowerShell's variable names ignore case: $pwd is $PWD.
  const resolveTarget = (raw: string): string =>
    normalizeShellTarget(
      powerShell ? raw.replaceAll("\\", "/").replace(/^\$(?:\{pwd\}|pwd)(?=\/|$)/i, "$$PWD") : raw,
      cwd,
    );
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw || isNullDevice(raw) || (powerShell && /^\$null$/i.test(raw))) return;
    rawWords?.push(raw);
    const target = resolveTarget(raw);
    if (target) out.push(target);
    out.push(...homeReadings(raw, powerShell));
  };
  const isDirectory = (raw: string | undefined): boolean => {
    if (!raw) return false;
    const target = resolveTarget(raw);
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
    const destination = resolveTarget(rawDestination);
    if (!destination) return;
    // cp/install/mv accept a directory destination. Add each concrete child
    // candidate as well as the destination itself without consulting the
    // pre-command filesystem, which may not contain the directory yet.
    for (const rawSource of rawSources) {
      const source = resolveTarget(rawSource);
      if (source) add(join(destination, basename(source)));
    }
  };

  // The destination/in-place operands one command writes. Commands that also
  // have read-only source operands contribute only those.
  const invocationTargets = (commandName: string, args: string[]): void => {
    if (commandName === "dd") {
      for (const arg of args) if (arg.startsWith("of=")) add(arg);
      return;
    }
    if (Object.hasOwn(CMDLET_WRITES, commandName)) {
      for (const target of cmdletWriteTargets(CMDLET_WRITES[commandName], cmdletArgs(args), false).targets) {
        add(target);
      }
      return;
    }

  const basic = parseShellArgs(args);
  const { operands } = basic;
  const attachedPaths = attachedPathOptionValues(args);
  if (
    operands.length === 0 &&
    attachedPaths.length === 0 &&
    commandName !== "find"
  ) {
    return;
  }

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
    if (!parsed.options.has("-i") && !parsed.options.has("--in-place")) return;
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
    if (!parsed.options.has("-i") && !parsed.options.has("--in-place")) return;
    const programFromOption = parsed.optionValues.has("-e") || parsed.optionValues.has("-E");
    for (const operand of parsed.operands.slice(programFromOption ? 0 : 1)) add(operand);
  } else if (commandName === "find") {
    if (args.includes("-delete")) {
      for (const root of findTraversalRoots(args)) add(root);
    }
    for (let index = 0; index < args.length; index++) {
      if (["-fprint", "-fprint0", "-fls"].includes(args[index])) {
        add(args[++index]);
      } else if (args[index] === "-fprintf") {
        add(args[++index]);
        index++;
      }
    }
  } else if (
    STATIC_REMOVE_COMMANDS.has(commandName) ||
    STATIC_MOVE_COMMANDS.has(commandName)
  ) {
    for (const operand of operands) add(operand);
    for (const value of attachedPaths) add(value);
  } else if (commandName === "copy-item") {
    add(operands.at(-1));
    for (const value of attachedPathOptionValues(args, new Set(["destination"]))) {
      add(value);
    }
  } else if (commandName === "rsync") {
    const destination = operands.at(-1);
    add(destination);
    if (basic.options.has("--remove-source-files")) {
      for (const source of operands.slice(0, -1)) add(source);
    }
  }
  };

  if (powerShell) {
    const readTargets = (text: string, depth: number): void => {
      if (depth > 8) return;
      const nested: string[] = [];
      const { commands, redirects } = readPowerShell(text, nested);
      for (const target of redirects) add(target);
      for (const { name, args, piped } of commands) {
        if (name === null) continue;
        const commandName = powerShellCommandName(name, args);
        const cmdlet = Object.hasOwn(CMDLET_WRITES, commandName) ? CMDLET_WRITES[commandName] : null;
        if (cmdlet) {
          const { targets, pathBound } = cmdletWriteTargets(cmdlet, args, true);
          for (const target of targets) add(target);
          if (piped && !pathBound && cmdlet.pipelinePath) add(cwd);
          continue;
        }
        // An attached array (-Path:a,b) is one word per value.
        const words = args.flatMap((arg) =>
          arg.parameter === undefined
            ? arg.values
            : arg.attached
              ? arg.values.map((value) => `-${arg.parameter}:${value}`)
              : [`-${arg.parameter}`]
        );
        const before = out.length;
        invocationTargets(commandName, words);
        if (
          piped &&
          POWERSHELL_PIPELINE_PATH_COMMANDS.has(commandName) &&
          // Piped items are what Copy-Item reads: a destination it found is
          // the write. Elsewhere only a path named in full replaces the
          // pipeline's.
          (commandName === "copy-item"
            ? out.length === before
            : !args.some((arg) => arg.parameter !== undefined && /^(?:path|literalpath|pspath|lp)$/i.test(arg.parameter)))
        ) {
          add(cwd);
        }
      }
      for (const inner of nested) readTargets(inner, depth + 1);
    };
    readTargets(command, 0);
    return [...new Set(out)];
  }

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
  // later read-only command's operands.
  for (const {
    name: commandName,
    args,
    ambiguous,
    dataDriven,
  } of shellCommandInvocationDetails(command)) {
    if (ambiguous) {
      add(cwd);
      continue;
    }
    if (dataDriven && invocationMayMutate(commandName, args)) add(cwd);
    invocationTargets(commandName, args);
  }

  return [...new Set(out)];
}

/** Target paths of a write-tool call. */
export function writeTargets(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  cwd = process.cwd(),
  shell: CommandShell = "posix",
): string[] {
  if (toolName === "Bash") {
    const command = toolInput?.command;
    return typeof command === "string" ? shellWriteTargets(command, cwd, undefined, shell) : [];
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
