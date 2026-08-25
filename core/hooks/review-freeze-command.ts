import { statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

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

function shellInvocation(
  words: string[],
  depth = 0,
): ShellInvocation | null {
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
        return shellInvocation(
          [...splitCommand, ...words.slice(index)],
          depth + 1,
        );
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
      if (index < words.length) index++;
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

function shellWordAt(
  command: string,
  start: number,
): { word: string; end: number } | null {
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

export function shellWriteTargets(
  command: string,
  cwd = process.cwd(),
): string[] {
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
    for (const rawSource of rawSources) {
      const source = normalizeShellTarget(rawSource, cwd);
      if (source) add(join(destination, basename(source)));
    }
  };

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
    if (command[targetStart] === ">" || command[targetStart] === "|") {
      targetStart++;
    }
    while (/\s/.test(command[targetStart] ?? "")) targetStart++;
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
      const sources = hasTargetDirectory
        ? parsed.operands
        : parsed.operands.slice(0, -1);
      addDestination(
        destination,
        sources,
        hasTargetDirectory || sources.length > 1 || isDirectory(destination),
      );
    } else if (commandName === "install") {
      const parsed = parseShellArgs(
        args,
        new Set(["-g", "-m", "-o", "-S", "-t"]),
        new Set([
          "--group",
          "--mode",
          "--owner",
          "--suffix",
          "--target-directory",
        ]),
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
        const sources = hasTargetDirectory
          ? parsed.operands
          : parsed.operands.slice(0, -1);
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
      const sources = hasTargetDirectory
        ? parsed.operands
        : parsed.operands.slice(0, -1);
      for (const source of sources) add(source);
      addDestination(
        destination,
        sources,
        hasTargetDirectory || sources.length > 1 || isDirectory(destination),
      );
    } else if (
      ["rm", "tee", "touch", "truncate", "unlink"].includes(commandName)
    ) {
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
      if (!parsed.options.has("-i") && !parsed.options.has("--in-place")) {
        continue;
      }
      const programFromOption =
        parsed.optionValues.has("-e") ||
        parsed.optionValues.has("-f") ||
        parsed.optionValues.has("--expression") ||
        parsed.optionValues.has("--file");
      for (const operand of parsed.operands.slice(programFromOption ? 0 : 1)) {
        add(operand);
      }
    } else if (commandName === "perl") {
      const parsed = parseShellArgs(
        args,
        new Set(["-E", "-F", "-I", "-M", "-e", "-m"]),
      );
      if (!parsed.options.has("-i") && !parsed.options.has("--in-place")) {
        continue;
      }
      const programFromOption =
        parsed.optionValues.has("-e") || parsed.optionValues.has("-E");
      for (const operand of parsed.operands.slice(programFromOption ? 0 : 1)) {
        add(operand);
      }
    }
  }

  return [...new Set(out)];
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

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
  const push = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) out.push(value);
  };
  push(ti.file_path);
  push(ti.notebook_path);
  push(ti.path);
  if (Array.isArray(ti.paths)) for (const path of ti.paths) push(path);
  return out;
}
