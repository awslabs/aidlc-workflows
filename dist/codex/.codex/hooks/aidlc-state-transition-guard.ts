// PreToolUse hook: refuse direct lifecycle mutations through aidlc-state.ts.
//
// The orchestration engine owns stage pinning, evidence checks, idempotency,
// and transition selection. A conductor that calls state transition verbs
// directly bypasses that boundary. Read-only state queries and specialized
// recovery/configuration verbs remain available.

import {
  type ClaudeCodeHookInput,
  isClaudeCodeHookInput,
  parseArgs,
  parseWorkspaceCommand,
} from "../tools/aidlc-lib.ts";

export const BLOCKED_STATE_TRANSITIONS = new Set([
  "set",
  "checkbox",
  "advance",
  "finalize",
  "complete-workflow",
  "gate-start",
  "approve",
  "reject",
  "revise",
  "skip",
  "park",
  "refresh-unit-progress",
  "fold-unit-merge",
]);

export const DELEGATED_STATE_MUTATIONS = new Set([
  ...BLOCKED_STATE_TRANSITIONS,
  "set-skeleton-stance",
  "set-construction-iteration",
  "set-unit-ownership",
  "set-unit-gate-rhythm",
  "acknowledge-compaction",
  "reuse-artifact",
  "practices-event",
  "practices-promote",
  "fork",
  "merge",
  "unpark",
]);

function maskQuotedCommandSeparators(command: string): string {
  const chars = [...command];
  for (let i = 0; i < chars.length; i++) {
    const quote = chars[i];
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;
    let end = i + 1;
    let escaped = false;
    for (; end < chars.length; end++) {
      const ch = chars[end];
      if (quote !== "'" && !escaped && ch === "\\") {
        escaped = true;
        continue;
      }
      if (!escaped && ch === quote) break;
      escaped = false;
    }
    if (end >= chars.length) end = chars.length - 1;
    const multiline = chars.slice(i, end + 1).includes("\n");
    let commandSubDepth = 0;
    for (let j = i; j <= end; j++) {
      const startsCommandSub =
        quote === '"' &&
        chars[j] === "$" &&
        chars[j + 1] === "(" &&
        (j === 0 || chars[j - 1] !== "\\");
      if (startsCommandSub) {
        commandSubDepth++;
        j++;
        continue;
      }
      if (
        quote === '"' &&
        commandSubDepth > 0 &&
        chars[j] === ")" &&
        (j === 0 || chars[j - 1] !== "\\")
      ) {
        commandSubDepth--;
        continue;
      }
      if (commandSubDepth > 0) {
        // Double-quoted $(...) content is executable shell, not prose. Preserve
        // its opening `(` anchor and body so lifecycle calls inside it remain
        // visible to the command-position detector.
        continue;
      }
      if (multiline) {
        if (chars[j] !== "\n") chars[j] = " ";
      } else if (/[&|;({]/.test(chars[j])) {
        // Keep ordinary quoted path/text characters so real invocations with a
        // quoted script path still match, but quoted shell separators must
        // never create a synthetic command-position anchor.
        chars[j] = " ";
      }
    }
    i = end;
  }
  return chars.join("");
}

function maskHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (pending.length > 0) {
      const active = pending[0];
      const candidate = active.stripTabs
        ? lines[i].replace(/^\t+/, "")
        : lines[i];
      lines[i] = " ".repeat(lines[i].length);
      if (candidate === active.delimiter) pending.shift();
      continue;
    }
    const heredoc = /<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;
    for (const match of lines[i].matchAll(heredoc)) {
      const delimiter = match[2] ?? match[3] ?? match[4];
      if (delimiter) {
        pending.push({ delimiter, stripTabs: match[1] === "-" });
      }
    }
  }
  return lines.join("\n");
}

function maskFunctionDefinitions(command: string): string {
  // No brace, no function body to mask. Heredoc/quote masking has already
  // blanked embedded documents, so this bail covers the common large-write
  // command whose only real shell text is the first line.
  if (!command.includes("{")) return command;
  const chars = [...command];
  const source = () => chars.join("");
  // [ \t]* (not \s*) after the anchor: \s* spans newlines, so on a command
  // whose masked heredoc body is thousands of blank-ish lines every anchor
  // rescans the remaining whitespace run — quadratic, and slow enough to trip
  // harness hook timeouts. Same-line whitespace keeps identical coverage (a
  // definition preceded by blank lines anchors at the nearest newline).
  const definition =
    /(?:^|[;\n])[ \t]*(?:(?:function[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\)|function[ \t]+[A-Za-z_][A-Za-z0-9_]*)[ \t\n]*\{/g;
  let match = definition.exec(source());
  while (match !== null) {
    const open = match.index + match[0].lastIndexOf("{");
    let depth = 0;
    let quote = "";
    let escaped = false;
    let end = open;
    for (; end < chars.length; end++) {
      const ch = chars[end];
      if (quote) {
        if (quote !== "'" && !escaped && ch === "\\") {
          escaped = true;
          continue;
        }
        if (!escaped && ch === quote) quote = "";
        escaped = false;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    const start = match.index +
      (match[0].startsWith(";") || match[0].startsWith("\n") ? 1 : 0);
    for (let i = start; i <= end; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
    definition.lastIndex = end + 1;
    match = definition.exec(source());
  }
  return chars.join("");
}

function executableShellText(command: string): string {
  return maskFunctionDefinitions(
    maskHeredocBodies(maskQuotedCommandSeparators(command)),
  );
}

export function directStateTransition(command: string): string | null {
  // Only inspect shell command positions: start-of-input or immediately after
  // a command separator. Matching arbitrary whitespace would mistake
  // `echo bun ... aidlc-state.ts approve` and similar search strings for an
  // invocation. The state CLI repeats this ownership check as the hard floor.
  // [ \t]* after the anchor, not \s*: \n is already in the anchor class, and a
  // cross-line \s* rescans masked heredoc whitespace quadratically (see
  // maskFunctionDefinitions). The path-prefix class likewise excludes the
  // anchor characters { and ( : a long run of either is a run of anchor
  // positions, and a prefix class that can consume the run makes every anchor
  // rescan the remainder - the same quadratic through a different door.
  // Unquoted { and ( are shell metacharacters, not path text, so coverage is
  // unchanged.
  const invocation =
    /(?:^|&&|\|\||[;|(\n{])[ \t]*(?:(?:command|exec)\s+)?(?:env(?:\s+-[^\s]+)*\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s+)*(?:[^\s"';&|({]+\/)?bun(?:\.exe)?(?:\s+run)?\s+(?:"[^"\n]*aidlc-state\.ts"|'[^'\n]*aidlc-state\.ts'|[^\s;&|]*aidlc-state\.ts)\s+([a-z][a-z0-9-]*)\b/g;
  for (const match of executableShellText(command).matchAll(invocation)) {
    const verb = match[1];
    if (BLOCKED_STATE_TRANSITIONS.has(verb)) return verb;
  }
  return null;
}

// True only for an executable command that can cross a stage/workflow lifecycle
// boundary. Unlike isEngineToolCall(), this parser deliberately ignores command
// text passed to echo/rg, heredoc bodies, multiline strings, and function
// definitions: flushing subagent holdback is destructive if the apparent
// lifecycle command is only prose.
export function isLifecycleBoundaryCommand(command: string): boolean {
  const invocation =
    /(?:^|&&|\|\||[;|(\n{])[ \t]*(?:(?:command|exec)\s+)?(?:env(?:\s+-[^\s]+)*\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s+)*(?:[^\s"';&|({]+\/)?bun(?:\.exe)?(?:\s+run)?\s+(?:"[^"\n]*aidlc-(orchestrate|state|jump)\.ts"|'[^'\n]*aidlc-(orchestrate|state|jump)\.ts'|[^\s;&|]*aidlc-(orchestrate|state|jump)\.ts)\s+([a-z][a-z0-9-]*)\b/g;
  for (const match of executableShellText(command).matchAll(invocation)) {
    const tool = match[1] ?? match[2] ?? match[3];
    const verb = match[4];
    if (tool === "orchestrate" && verb === "report") return true;
    if (tool === "state" && BLOCKED_STATE_TRANSITIONS.has(verb)) return true;
    if (tool === "jump" && verb === "execute") return true;
  }
  return false;
}

export function delegatedLifecycleCommand(command: string): string | null {
  return delegatedLifecycleCommandAtDepth(command, 0);
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && input[i + 1] === "\n") {
      i++;
      continue;
    }
    if (escaped) {
      word += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
      started = true;
      continue;
    }
    if (ch === "$" && (input[i + 1] === "'" || input[i + 1] === '"')) {
      quote = input[++i] as "'" | '"';
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += ch;
      started = true;
    }
  }
  if (escaped) word += "\\";
  if (started) words.push(word);
  return words;
}

function maskRange(chars: string[], start: number, end: number): void {
  for (let i = start; i <= end; i++) {
    if (chars[i] !== "\n") chars[i] = " ";
  }
}

function commandSubstitutionEnd(source: string, open: number): number {
  let depth = 1;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = open + 1; i < source.length; i++) {
    const ch = source[i];
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
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

function executableSubstitutions(command: string): {
  masked: string;
  bodies: string[];
} {
  const chars = [...command];
  const bodies: string[] = [];
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
    if (ch === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (ch === "`") {
      let end = i + 1;
      let innerEscaped = false;
      for (; end < command.length; end++) {
        if (innerEscaped) {
          innerEscaped = false;
          continue;
        }
        if (command[end] === "\\") {
          innerEscaped = true;
          continue;
        }
        if (command[end] === "`") break;
      }
      if (end >= command.length) continue;
      bodies.push(command.slice(i + 1, end));
      maskRange(chars, i, end);
      chars[i] = "$";
      i = end;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      const end = commandSubstitutionEnd(command, i + 1);
      if (end < 0) continue;
      bodies.push(command.slice(i + 2, end));
      maskRange(chars, i, end);
      chars[i] = "$";
      i = end;
    }
  }
  return { masked: chars.join(""), bodies };
}

function heredocSubstitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  const pending: Array<{
    delimiter: string;
    stripTabs: boolean;
    executable: boolean;
    lines: string[];
  }> = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      const active = pending[0];
      const candidate = active.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === active.delimiter) {
        if (active.executable) {
          bodies.push(...executableSubstitutions(active.lines.join("\n")).bodies);
        }
        pending.shift();
      } else {
        active.lines.push(line);
      }
      continue;
    }
    const heredoc = /<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;
    for (const match of line.matchAll(heredoc)) {
      const delimiter = match[2] ?? match[3] ?? match[4];
      if (delimiter) {
        pending.push({
          delimiter,
          stripTabs: match[1] === "-",
          executable: match[4] !== undefined,
          lines: [],
        });
      }
    }
  }
  return bodies;
}

function shellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let parameterExpansionDepth = 0;
  let escaped = false;
  const push = (end: number): void => {
    const segment = command.slice(start, end).trim();
    if (segment) segments.push(segment);
  };
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
    if (ch === "$" && command[i + 1] === "{") {
      parameterExpansionDepth++;
      i++;
      continue;
    }
    if (parameterExpansionDepth > 0) {
      if (ch === "}") parameterExpansionDepth--;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|(){}]/.test(command[i - 1]))) {
      push(i);
      const newline = command.indexOf("\n", i + 1);
      if (newline < 0) {
        start = command.length;
        break;
      }
      i = newline;
      start = newline + 1;
      continue;
    }
    if (
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === "\n" ||
      ch === "(" ||
      ch === ")" ||
      ch === "{" ||
      ch === "}"
    ) {
      push(i);
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      start = i + 1;
    }
  }
  push(command.length);
  return segments;
}

function commandBasename(command: string | undefined): string {
  return (command ?? "").replace(/\\/g, "/").split("/").at(-1) ?? "";
}

const UNINSPECTABLE_EXECUTION_WRAPPER = "__aidlc_uninspectable_execution_wrapper__";

function executableArgv(segment: string): string[] {
  let words = shellWords(segment);
  let cursor = 0;
  const skipRedirections = (): void => {
    while (/^\d*(?:<<<|<<-?|<>|>>?|<|>\||<&|>&)/.test(words[cursor] ?? "")) {
      const redirection = words[cursor++];
      if (/^\d*(?:<<<|<<-?|<>|>>?|<|>\||<&|>&)$/.test(redirection)) cursor++;
    }
  };
  const skipPrefixes = (): void => {
    let previous = -1;
    while (cursor !== previous) {
      previous = cursor;
      while (
        ["if", "then", "while", "until", "do", "else", "elif", "!"].includes(
          words[cursor] ?? "",
        )
      ) {
        cursor++;
      }
      skipRedirections();
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[cursor] ?? "")) cursor++;
    }
  };

  let allowShellPrefixes = true;
  while (cursor < words.length) {
    if (allowShellPrefixes) skipPrefixes();
    else skipRedirections();
    allowShellPrefixes = false;
    const wrapper = commandBasename(words[cursor]);

    if (wrapper === "time") {
      cursor++;
      while ((words[cursor] ?? "").startsWith("-")) {
        const option = words[cursor++];
        if (["-f", "--format", "-o", "--output"].includes(option)) {
          skipRedirections();
          if (cursor >= words.length) return [];
          cursor++;
        }
      }
      allowShellPrefixes = true;
      continue;
    }

    if (wrapper === "command" || wrapper === "exec") {
      cursor++;
      while (cursor < words.length) {
        skipRedirections();
        const option = words[cursor] ?? "";
        if (option === "--") {
          cursor++;
          break;
        }
        if (!option.startsWith("-")) break;
        if (wrapper === "command") {
          if (/[vV]/.test(option.replace(/^-+/, ""))) return [];
          if (!/^-p+$/.test(option)) return [];
          cursor++;
          continue;
        }
        if (option === "-a") {
          cursor++;
          skipRedirections();
          if (cursor >= words.length) return [];
          cursor++;
          continue;
        }
        if (!/^-[cl]+$/.test(option)) return [];
        cursor++;
      }
      allowShellPrefixes = true;
      continue;
    }

    if (wrapper === "env") {
      cursor++;
      while (cursor < words.length) {
        skipRedirections();
        if (cursor >= words.length) break;
        const word = words[cursor];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
          cursor++;
          continue;
        }
        if (word === "--") {
          cursor++;
          break;
        }
        const splitOptionIndex = cursor;
        let split: string | null = null;
        let splitRestIndex = cursor + 1;
        if (word.startsWith("-S") && word.length > 2) {
          split = word.slice(2);
        } else if (word.startsWith("--split-string=")) {
          split = word.slice("--split-string=".length);
        } else if (word === "-S" || word === "--split-string") {
          cursor++;
          skipRedirections();
          split = words[cursor] ?? "";
          splitRestIndex = cursor + 1;
        }
        if (split !== null) {
          if (/[\\$`#]/.test(split)) return [UNINSPECTABLE_EXECUTION_WRAPPER];
          words = [
            ...words.slice(0, splitOptionIndex),
            ...shellWords(split),
            ...words.slice(splitRestIndex),
          ];
          cursor = splitOptionIndex;
          continue;
        }
        if (["-u", "--unset", "-C", "--chdir", "-P"].includes(word)) {
          cursor++;
          skipRedirections();
          if (cursor >= words.length) return [];
          cursor++;
          continue;
        }
        if (
          /^-(?:u|C).+/.test(word) ||
          /^(?:--unset|--chdir)=.+/.test(word) ||
          /^-[iv]+$/.test(word) ||
          word === "-" ||
          ["--ignore-environment", "--debug", "--list-signal-handling"].includes(word) ||
          /^--(?:block|default|ignore)-signal(?:=.*)?$/.test(word)
        ) {
          cursor++;
          continue;
        }
        if (word === "-0" || word === "--null") return [];
        if (word === "--help" || word === "--version") return [];
        if (word.startsWith("-")) return [UNINSPECTABLE_EXECUTION_WRAPPER];
        break;
      }
      continue;
    }

    if (wrapper === "nice") {
      cursor++;
      while (cursor < words.length) {
        skipRedirections();
        if (cursor >= words.length) break;
        const word = words[cursor];
        if (word === "--") {
          cursor++;
          break;
        }
        if (word === "--help" || word === "--version") return [];
        if (word === "-n" || word === "--adjustment") {
          cursor++;
          skipRedirections();
          if (!/^[+-]?\d+$/.test(words[cursor] ?? "")) return [];
          cursor++;
          continue;
        }
        if (
          /^-n[+-]?\d+$/.test(word) ||
          /^--adjustment=[+-]?\d+$/.test(word) ||
          /^--?\d+$/.test(word)
        ) {
          cursor++;
          continue;
        }
        if (word.startsWith("-")) return [];
        break;
      }
      continue;
    }

    if (wrapper === "nohup") {
      cursor++;
      const word = words[cursor] ?? "";
      if (word === "--help" || word === "--version") return [];
      if (word === "--") {
        cursor++;
      } else if (word.startsWith("-")) {
        return [];
      }
      continue;
    }

    break;
  }

  return words.slice(cursor);
}

function bunScriptInvocation(argv: string[]): {
  script: string;
  args: string[];
} | null {
  const valueOptions = new Set([
    "-C",
    "--cwd",
    "-r",
    "--preload",
    "--define",
    "--loader",
    "--conditions",
    "--env-file",
    "--config",
  ]);
  const evalOptions = new Set(["-e", "--eval", "-p", "--print"]);
  let cursor = 1;
  const skipOptions = (): boolean => {
    while ((argv[cursor] ?? "").startsWith("-")) {
      const option = argv[cursor];
      if (option === "--") {
        cursor++;
        return true;
      }
      if (evalOptions.has(option)) return false;
      cursor += valueOptions.has(option) && !option.includes("=") ? 2 : 1;
    }
    return true;
  };
  if (!skipOptions()) return null;
  if (argv[cursor] === "run") {
    cursor++;
    if (!skipOptions()) return null;
  }
  const script = commandBasename(argv[cursor]);
  return script ? { script, args: argv.slice(cursor + 1) } : null;
}

function withoutProjectDir(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-dir") {
      i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function workspaceMutation(prefix: string, args: string[]): string | null {
  if (args[1] === "--help") return null;
  const workspace = parseWorkspaceCommand(args);
  if (workspace.kind === "switch") {
    return `${prefix} ${workspace.noun} ${workspace.explicit ? "switch" : workspace.name}`;
  }
  if (workspace.kind === "create-intent") return `${prefix} intent create`;
  if (workspace.kind === "create") {
    return `${prefix} ${args[0] === "space-create" ? "space-create" : "space create"}`;
  }
  return null;
}

function delegatedDispatcherCommand(
  prefix: string,
  rawArgs: string[],
): string | null {
  const args = withoutProjectDir(rawArgs);
  const group = args[0] ?? "";
  const verb = args[1] ?? "";
  if (
    [
      "next",
      "continue",
      "report",
      "park",
      "--resume",
      "--scope",
      "scope-change",
      "config-change",
      "compose",
      "recompose",
      "init",
    ].includes(group)
  ) {
    return `${prefix} ${group}`;
  }
  if (group === "scope" && verb === "change") {
    return `${prefix} scope change`;
  }
  if (group === "state" && DELEGATED_STATE_MUTATIONS.has(verb)) {
    return `${prefix} state ${verb}`;
  }
  if (group === "jump" && verb === "execute") {
    return `${prefix} jump execute`;
  }
  if (group === "config" && verb === "set") {
    return `${prefix} config set`;
  }
  return workspaceMutation(prefix, args);
}

function delegatedUtilityCommand(
  prefix: string,
  rawArgs: string[],
): string | null {
  const { positional } = parseArgs(rawArgs);
  const verb = positional[0] ?? "";
  if (
    ["scope-change", "config-change", "recompose", "intent-create", "state-init", "space-create"]
      .includes(verb)
  ) {
    return `${prefix} ${verb}`;
  }
  return workspaceMutation(prefix, positional);
}

function assignment(word: string): { name: string; value: string } | null {
  const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
  return match ? { name: match[1], value: match[2] } : null;
}

function variableReference(word: string): string | null {
  return word.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ??
    word.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] ??
    null;
}

function delegatedLifecycleCommandAtDepth(command: string, depth: number): string | null {
  if (depth > 8) return "nested shell command beyond guard inspection limit";
  const heredocBodies = heredocSubstitutionBodies(command);
  const source = maskHeredocBodies(command);
  const substitutions = executableSubstitutions(source);
  for (const body of [...heredocBodies, ...substitutions.bodies]) {
    const nested = delegatedLifecycleCommandAtDepth(body, depth + 1);
    if (nested !== null) return nested;
  }

  // Only standalone literal assignments survive into later command segments.
  // Resolve those values where possible; fail closed when a delegated
  // executable or shell command remains dynamically indeterminate.
  const assignments = new Map<string, string>();
  for (const segment of shellCommandSegments(substitutions.masked)) {
    const segmentWords = shellWords(segment);
    const segmentAssignments = segmentWords.map(assignment);
    if (
      segmentAssignments.length > 0 &&
      segmentAssignments.every((candidate) => candidate !== null)
    ) {
      for (const candidate of segmentAssignments) {
        if (candidate) assignments.set(candidate.name, candidate.value);
      }
      continue;
    }

    let argv = executableArgv(segment);
    const executableVariable = variableReference(argv[0] ?? "");
    if (executableVariable !== null) {
      const value = assignments.get(executableVariable);
      const resolved = value === undefined ? [] : shellWords(value);
      if (resolved.length !== 1) {
        return "dynamic executable beyond guard inspection";
      }
      argv = [resolved[0], ...argv.slice(1)];
    }
    if ((argv[0] ?? "").includes("$")) {
      return "dynamic executable beyond guard inspection";
    }
    const executable = commandBasename(argv[0]);
    if (executable === UNINSPECTABLE_EXECUTION_WRAPPER) {
      return "execution wrapper beyond guard inspection";
    }
    if (executable === "eval") {
      const evalArgs = argv.slice(1);
      if (evalArgs[0] === "--") evalArgs.shift();
      const evalCommand = evalArgs.join(" ");
      const nested = delegatedLifecycleCommandAtDepth(evalCommand, depth + 1);
      if (
        nested === "dynamic executable beyond guard inspection" ||
        nested === "dynamic shell command beyond guard inspection"
      ) {
        return "dynamic eval shell command beyond guard inspection";
      }
      if (nested !== null) return nested;
      if (/[$`\\]/.test(segment)) {
        return "dynamic eval shell command beyond guard inspection";
      }
      continue;
    }
    if (/^(?:ba|da|a|k|z)?sh(?:\.exe)?$/.test(executable)) {
      for (let i = 1; i < argv.length; i++) {
        const option = argv[i];
        if (["-O", "+O", "-o", "+o", "--rcfile", "--init-file"].includes(option)) {
          i++;
          continue;
        }
        if (option === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(option)) {
          let commandIndex = i + 1;
          if (argv[commandIndex] === "--") commandIndex++;
          let nestedCommand = argv[commandIndex] ?? "";
          const commandVariable = variableReference(nestedCommand);
          if (commandVariable !== null) {
            const value = assignments.get(commandVariable);
            if (value === undefined) {
              return "dynamic shell command beyond guard inspection";
            }
            nestedCommand = value;
          }
          if (nestedCommand.includes("$")) {
            return "dynamic shell command beyond guard inspection";
          }
          const nested = delegatedLifecycleCommandAtDepth(nestedCommand, depth + 1);
          if (nested !== null) return nested;
          break;
        }
        if (!option.startsWith("-")) break;
      }
      continue;
    }

    let args = argv.slice(1);
    let script = executable;
    if (/^bun(?:\.exe)?$/.test(executable)) {
      const invocation = bunScriptInvocation(argv);
      if (!invocation) continue;
      script = invocation.script;
      args = invocation.args;
    }
    const authored = script.match(/^aidlc-(orchestrate|state|jump|utility)\.ts$/);
    if (authored) {
      const tool = authored[1];
      const positional = withoutProjectDir(args);
      const verb = positional[0] ?? "";
      if (
        (tool === "orchestrate" && ["next", "continue", "report", "park"].includes(verb)) ||
        (tool === "state" && DELEGATED_STATE_MUTATIONS.has(verb)) ||
        (tool === "jump" && verb === "execute")
      ) {
        return `aidlc-${tool}.ts ${verb}`;
      }
      if (tool === "utility") {
        const utility = delegatedUtilityCommand("aidlc-utility.ts", args);
        if (utility !== null) return utility;
      }
      continue;
    }
    if (script === "aidlc.ts") {
      const delegated = delegatedDispatcherCommand("aidlc.ts", args);
      if (delegated !== null) return delegated;
      continue;
    }
    if (/^aidlc(?:\.exe)?$/.test(script)) {
      const delegated = delegatedDispatcherCommand("aidlc", args);
      if (delegated !== null) return delegated;
    }
  }
  return null;
}

export async function run(input: string): Promise<number> {
  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(input);
    if (!isClaudeCodeHookInput(raw)) return 0;
    parsed = raw;
  } catch {
    return 0;
  }
  if (parsed.tool_name !== "Bash") return 0;
  const verb = directStateTransition(parsed.tool_input?.command ?? "");
  if (verb !== null) {
    process.stderr.write(
      `Stage status cannot be changed with aidlc-state.ts ${verb} because that bypasses ` +
        "the workflow's completion and approval checks. Use aidlc-orchestrate.ts report " +
        "--stage <slug> --result " +
        "<awaiting-approval|approved|rejected|revised|completed|skipped>; use " +
        "aidlc-orchestrate.ts park to pause, and next/jump to move through the workflow.\n",
    );
    return 2;
  }

  const agentType = parsed.agent_type?.trim() ?? "";
  if (agentType.length === 0) return 0;
  const delegatedCommand = delegatedLifecycleCommand(
    parsed.tool_input?.command ?? "",
  );
  if (delegatedCommand === null) return 0;

  process.stderr.write(
    `Delegated agent "${agentType}" cannot run ${delegatedCommand} because only the main ` +
      "workflow session can change stage status or routing. Return the artifact, contribution, " +
      "or review verdict to the main session without parking, resuming, reporting, routing, " +
      "or presenting an approval question.\n",
  );
  return 2;
}

if (import.meta.main) {
  if (process.stdin.isTTY) process.exit(0);
  process.exit(await run(await Bun.stdin.text()));
}
