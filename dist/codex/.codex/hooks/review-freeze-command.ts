import { statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
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

const STATIC_CONTENT_COMMANDS = new Set([
  "set-item",
  "new-item",
  "set-content",
  "add-content",
  "clear-content",
  "out-file",
]);

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
    const match = arg.match(/^-{1,2}([^:=]+)[:=](.+)$/);
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
    STATIC_CONTENT_COMMANDS.has(commandName)
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
    if (commandName === "dd") {
      for (const arg of args) if (arg.startsWith("of=")) add(arg);
      continue;
    }

    const basic = parseShellArgs(args);
    const { operands } = basic;
    const attachedPaths = attachedPathOptionValues(args);
    if (
      operands.length === 0 &&
      attachedPaths.length === 0 &&
      commandName !== "find"
    ) {
      continue;
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
      STATIC_MOVE_COMMANDS.has(commandName) ||
      STATIC_CONTENT_COMMANDS.has(commandName)
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
