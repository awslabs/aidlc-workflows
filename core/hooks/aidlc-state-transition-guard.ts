// PreToolUse hook: protect harness runtime records and lifecycle mutations.
//
// The orchestration engine owns stage pinning, evidence checks, idempotency,
// and transition selection. A conductor that calls state transition verbs
// directly bypasses that boundary. Read-only state queries and specialized
// recovery/configuration verbs remain available.

import {
  type ClaudeCodeHookInput,
  decideFence,
  guardStoodAsideLine,
  isClaudeCodeHookInput,
  fenceSwitchSentence,
  parseArgs,
  parseWorkspaceCommand,
  recordGuardStoodAside,
  resolveProjectDirFromHook,
  writeGuardStoodAside,
} from "../tools/aidlc-lib.ts";
import { shellWriteTargets } from "./review-freeze-command.ts";
import { refuseRuntimeIntegrityViolation } from "./runtime-integrity.ts";

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
  const nativeInvocation =
    /(?:^|&&|\|\||[;|(\n{])[ \t]*(?:(?:command|exec)\s+)?(?:env(?:\s+-[^\s]+)*\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s+)*(?:"[^"\n]*\/aidlc(?:\.exe)?"|'[^'\n]*\/aidlc(?:\.exe)?'|[^\s"';&|({]*aidlc(?:\.exe)?)[ \t]+engine[ \t]+state[ \t]+([a-z][a-z0-9-]*)\b/g;
  for (const match of executableShellText(command).matchAll(nativeInvocation)) {
    const verb = match[1];
    if (BLOCKED_STATE_TRANSITIONS.has(verb)) return verb;
  }
  const dispatcherTransition = delegatedLifecycleCommand(command)?.match(
    /\bengine state ([a-z][a-z0-9-]*)$/,
  )?.[1];
  if (
    dispatcherTransition &&
    BLOCKED_STATE_TRANSITIONS.has(dispatcherTransition)
  ) {
    return dispatcherTransition;
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
  const nativeInvocation =
    /(?:^|&&|\|\||[;|(\n{])[ \t]*(?:(?:command|exec)\s+)?(?:env(?:\s+-[^\s]+)*\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s+)*(?:"[^"\n]*\/aidlc(?:\.exe)?"|'[^'\n]*\/aidlc(?:\.exe)?'|[^\s"';&|({]*aidlc(?:\.exe)?)[ \t]+engine[ \t]+(orchestrate|state|jump)[ \t]+([a-z][a-z0-9-]*)\b/g;
  for (const match of executableShellText(command).matchAll(nativeInvocation)) {
    const tool = match[1];
    const verb = match[2];
    if (tool === "orchestrate" && (verb === "report" || verb === "park")) return true;
    if (tool === "state" && BLOCKED_STATE_TRANSITIONS.has(verb)) return true;
    if (tool === "jump" && verb === "execute") return true;
  }
  return false;
}

export function delegatedLifecycleCommand(command: string): string | null {
  return delegatedLifecycleCommandAtDepth(command, 0);
}

// Background agents keep ordinary shell work, judged per resolved command
// segment. Running an AIDLC entrypoint is limited to one direct literal
// read-only command. Interpreters and execution hosts get literal arguments
// that do not name AIDLC. A plain command's operands (cat, grep, git) may
// name anything. Programs read from files or stdin (helper scripts, test
// suites) are beyond a lexical check: this is defense in depth, not a sandbox.
export function backgroundLifecycleCommand(
  command: string,
  installedScript?: (path: string) => boolean,
): string | null {
  // Quoted substitution text can still run later (bash evaluates array
  // subscripts), so no substitution body may name AIDLC.
  for (const [body] of command.matchAll(/\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`/g)) {
    if (AIDLC_TARGET.test(body)) return "substitution naming AIDLC beyond background read policy";
  }
  return delegatedLifecycleCommandAtDepth(command, 0, { installedScript });
}

interface BackgroundInspection {
  installedScript?: (path: string) => boolean;
}

function backgroundAidlcInvocation(
  command: string,
  installedScript?: (path: string) => boolean,
): string | null {
  const argv = backgroundShellWords(command);
  if (typeof argv === "string") return argv;
  const executable = commandBasename(argv[0]);
  if (!backgroundProgramPath(argv[0] ?? "")) {
    return "execution host beyond background read policy";
  }
  if (/^aidlc(?:\.exe)?$/.test(executable)) {
    return backgroundReadDispatcher(argv.slice(1))
      ? null
      : "aidlc command beyond background read policy";
  }
  if (!/^bun(?:\.exe)?$/.test(executable)) {
    return "execution host beyond background read policy";
  }
  const invocation = bunScriptInvocation(argv, true);
  if (invocation?.kind === "dynamic") return "bun eval/print beyond guard inspection";
  if (invocation?.kind !== "script") return "bun script or runtime options beyond guard inspection";
  if (installedScript && !installedScript(invocation.path)) {
    return "script outside the installed harness tools";
  }
  const { script, args } = invocation;
  const tool = script.match(/^aidlc-(orchestrate|state|jump|utility)\.ts$/)?.[1];
  const readOnly = tool
    ? backgroundReadTool(tool, args)
    : script === "aidlc.ts" && backgroundReadDispatcher(args);
  return readOnly ? null : `${script} command beyond background read policy`;
}

// A background AIDLC command is an allowlist, never the foreground lifecycle
// denylist. Admit one direct literal invocation: do not resolve assignments,
// expand variables, unwrap execution hosts, or interpret shell programs.
function backgroundShellWords(command: string): string[] | string {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const finishWord = (): void => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "$" || ch === "`") return "dynamic shell argument beyond guard inspection";
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined || /[$`\r\n]/.test(next)) {
        return "shell expansion beyond guard inspection";
      }
      if (quote === null || /["\\]/.test(next)) {
        word += next;
        started = true;
        i++;
      } else {
        word += ch;
      }
      continue;
    }
    if (ch === '"' || (ch === "'" && quote === null)) {
      quote = quote === '"' ? null : ch;
      started = true;
      continue;
    }
    if (quote === null) {
      if (/[;|&<>(){}*?[\]~#\r\n]/.test(ch)) return "shell syntax beyond background read policy";
      if (/\s/.test(ch)) {
        finishWord();
        continue;
      }
    }
    word += ch;
    started = true;
  }
  if (quote !== null) return "incomplete shell command beyond guard inspection";
  finishWord();
  return words;
}


function backgroundProgramPath(program: string): boolean {
  return !/[\\/]/.test(program) ||
    /^\/(?:usr\/(?:local\/)?)?bin\/[^/]+$/.test(program);
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
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[cursor] ?? "")) {
        cursor++;
      }
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

type BunInvocation =
  | { kind: "script"; script: string; path: string; args: string[] }
  | { kind: "dynamic" }
  | { kind: "uninspectable" };

function bunScriptInvocation(argv: string[], strict = false): BunInvocation | null {
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
  let uninspectable = false;
  const skipOptions = (): boolean => {
    while ((argv[cursor] ?? "").startsWith("-")) {
      const option = argv[cursor];
      if (option === "--") {
        cursor++;
        return true;
      }
      if (
        evalOptions.has(option) ||
        /^--(?:eval|print)=/.test(option) ||
        /^-[ep].+/.test(option)
      ) {
        return false;
      }
      // Preloads execute before even a read-only script. Also refuse unknown
      // runtime options/configuration rather than guessing their arity/effects.
      if (
        strict &&
        option !== "--silent"
      ) {
        uninspectable = true;
        return false;
      }
      cursor += valueOptions.has(option) && !option.includes("=") ? 2 : 1;
    }
    return true;
  };
  if (!skipOptions()) return { kind: uninspectable ? "uninspectable" : "dynamic" };
  if (argv[cursor] === "run") {
    cursor++;
    if (!skipOptions()) return { kind: uninspectable ? "uninspectable" : "dynamic" };
  }
  // Only installed/authored AIDLC entrypoints are recognized, not arbitrary
  // helpers or package.json scripts that happen to share a tool's basename.
  if (
    strict &&
    !/^(?:.*\/)?(?:\.claude|\.cursor|\.codex|\.kiro|\.aidlc|core)\/tools\/aidlc(?:-[a-z-]+)?\.ts$/.test(argv[cursor] ?? "")
  ) return { kind: "uninspectable" };
  const script = commandBasename(argv[cursor]);
  return script
    ? { kind: "script", script, path: argv[cursor], args: argv.slice(cursor + 1) }
    : null;
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

function withoutOrchestrateGlobals(args: string[]): string[] {
  const out: string[] = [];
  let literalArgs = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      literalArgs = true;
      out.push(arg);
    } else if (
      !literalArgs &&
      (arg === "--project-dir" || arg === "--aidlc-attempt-id") &&
      i + 1 < args.length
    ) {
      i++;
    } else {
      out.push(arg);
    }
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
  if (workspace.kind === "archive" || workspace.kind === "unarchive") {
    return `${prefix} intent ${workspace.kind}`;
  }
  if (workspace.kind === "create") {
    return `${prefix} ${args[0] === "space-create" ? "space-create" : "space create"}`;
  }
  return null;
}

function delegatedDispatcherCommand(
  prefix: string,
  rawArgs: string[],
): string | null {
  const raw = withoutProjectDir(rawArgs);
  const namespace = raw[0] === "engine" || raw[0] === "system"
    ? raw[0]
    : null;
  const args = namespace ? raw.slice(1) : raw;
  const routePrefix = namespace ? `${prefix} ${namespace}` : prefix;
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
    return `${routePrefix} ${group}`;
  }
  if (group === "scope" && verb === "change") {
    return `${routePrefix} scope change`;
  }
  if (
    group === "orchestrate" &&
    ["next", "continue", "report", "park"].includes(verb)
  ) {
    return `${routePrefix} orchestrate ${verb}`;
  }
  if (group === "intent" && verb === "create") {
    return `${routePrefix} intent create`;
  }
  if (group === "state" && DELEGATED_STATE_MUTATIONS.has(verb)) {
    return `${routePrefix} state ${verb}`;
  }
  if (group === "jump" && verb === "execute") {
    return `${routePrefix} jump execute`;
  }
  if (group === "config" && verb === "set") {
    return `${routePrefix} config set`;
  }
  return workspaceMutation(routePrefix, args);
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

const BACKGROUND_READ_UTILITIES = new Set([
  "help", "version", "status", "config-get", "config-list", "codekb-path",
  "project-description", "document-input", "codekb-scope-diff", "detect",
  "resolve-env-scope", "scope-table", "stage-table", "plugin-list",
]);

function backgroundReadTool(tool: string, rawArgs: string[]): boolean {
  const args = withoutProjectDir(rawArgs);
  if (tool === "state") return ["get", "count", "lookup"].includes(args[0]);
  if (tool === "jump") return args[0] === "resolve";
  if (tool === "orchestrate") {
    return withoutOrchestrateGlobals(rawArgs).join(" ") === "--help";
  }
  if (tool !== "utility") return false;
  const { positional } = parseArgs(rawArgs);
  if (BACKGROUND_READ_UTILITIES.has(positional[0])) return true;
  const workspace = parseWorkspaceCommand(positional);
  return workspace.kind === "list" || workspace.kind === "help";
}

function backgroundReadDispatcher(rawArgs: string[]): boolean {
  let args = withoutProjectDir(rawArgs);
  if (args[0] === "engine" || args[0] === "system") args = args.slice(1);
  const [group, verb] = args;
  if (["help", "--help", "-h", "version", "--version", "status", "--status"].includes(group)) {
    return true;
  }
  if (["state", "jump", "orchestrate", "utility"].includes(group)) {
    return backgroundReadTool(group, args.slice(1));
  }
  if (group === "config") return verb === "get" || verb === "list";
  if (group === "scope") return verb === "resolve-env";
  if (group === "workspace") {
    return ["detect", "codekb-path", "project-description", "document-input", "codekb-scope-diff"].includes(verb);
  }
  const workspace = parseWorkspaceCommand(args);
  return workspace.kind === "list" || workspace.kind === "help";
}

const SCRIPT_RUNNER =
  /^(?:bun|node|deno|python(?:\d+(?:\.\d+)*)?|ruby|perl|php|(?:ba|da|a|k|z|fi|c|tc|mk)?sh|pwsh|powershell|[gmn]?awk)(?:\.exe)?$/i;
// Hosts that execute their arguments as a program, so those must be literal.
const EXECUTION_HOST =
  /^(?:eval|xargs|timeout|sudo|doas|su|runuser|stdbuf|setsid|watch|parallel|flock|ionice|taskset|chrt|unbuffer|script|strace|ltrace|hyperfine|busybox|npx|bunx|pnpx|cmd)(?:\.exe)?$/i;
// Hosts whose arguments are ordinarily computed (script flags, remote
// commands, key sequences); only a program that names AIDLC is refused.
const NAMING_HOST = /^(?:npm|pnpm|yarn|tmux|screen|ssh|docker|podman)(?:\.exe)?$/i;
const DISPATCHER_NAME = /^aidlc(?:-(?:darwin|linux|windows)-[a-z0-9]+(?:-musl)?)?(?:\.(?:exe|cmd|bat))?$/i;
const AIDLC_SCRIPT_NAME = /^aidlc(?:-[a-z0-9-]+)?\.ts$/i;
// The dispatcher or a tool (also partial or globbed), an installed harness
// tools/hooks directory, or the aidlc/ records tree.
const AIDLC_TARGET = new RegExp([
  String.raw`(?<![A-Za-z0-9_.-])aidlc(?:-(?:darwin|linux|windows)-[a-z0-9]+(?:-musl)?)?(?:\.(?:exe|cmd|bat))?(?![A-Za-z0-9_.-])`,
  String.raw`(?<![A-Za-z0-9_])aidlc(?:-[a-z0-9-]*)?(?:\.(?:ts|js)|[*?[])`,
  String.raw`\.(?:claude|cursor|codex|kiro|aidlc)[\\/]+(?:tools|hooks)(?![A-Za-z0-9_-])`,
  String.raw`\.aidlc-[a-z]|(?<![A-Za-z0-9_])aidlc-state\.md`,
].join("|"), "i");
// A path into the aidlc/ records tree or an installed harness directory:
// relative from the project root, or absolute. `feature/aidlc` is not one.
const TREE = String.raw`(?:aidlc|\.(?:claude|cursor|codex|kiro|aidlc))(?:[\\/]|$)`;
const PROTECTED_PATH = new RegExp(
  String.raw`^(?:\.{1,2}[\\/]+)*${TREE}|^(?:~|[A-Za-z]:)?[\\/].*[\\/]${TREE}`,
  "i",
);
const GIT_PATHSPEC_MUTATIONS = new Set(["checkout", "restore", "clean", "rm", "mv", "stash"]);
const GIT_TREE_MUTATIONS = new Set([
  ...GIT_PATHSPEC_MUTATIONS,
  "apply", "am", "reset", "merge", "pull", "rebase", "switch", "cherry-pick", "revert",
]);
const GIT_VALUE_OPTIONS = new Set([
  "-b", "-B", "--orphan", "-m", "--message", "-s", "--source", "-e", "--exclude",
  "-F", "--pathspec-from-file",
]);

function aidlcEntrypointInvocation(executable: string, argv: string[]): boolean {
  if (DISPATCHER_NAME.test(executable) || AIDLC_SCRIPT_NAME.test(executable)) return true;
  if (!SCRIPT_RUNNER.test(executable)) return false;
  const invocation = /^bun(?:\.exe)?$/i.test(executable) ? bunScriptInvocation(argv) : null;
  const script = invocation?.kind === "script"
    ? invocation.script
    : commandBasename(argv.slice(1).find((word) => !word.startsWith("-")));
  return AIDLC_SCRIPT_NAME.test(script);
}

// Words split on unquoted whitespace, quotes and escapes kept.
function rawWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === null && /\s/.test(ch)) {
      if (word) words.push(word);
      word = "";
      continue;
    }
    word += ch;
    if (ch === "\\" && quote !== "'") word += text[++i] ?? "";
    else if (ch === quote) quote = null;
    else if (quote === null && (ch === "'" || ch === '"')) quote = ch;
  }
  if (word) words.push(word);
  return words;
}

// The program a segment hands to a host: its words without assignment
// prefixes or output redirections, which configure rather than choose it.
function programWords(segment: string): string[] {
  const words = rawWords(segment);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (out.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (/^\d*(?:>>?|&>>?|>\||>&)/.test(word)) {
      if (/^\d*(?:>>?|&>>?|>\||>&)$/.test(word)) i++;
      continue;
    }
    out.push(word);
  }
  return out;
}

// Heredoc bodies grouped by delimiter, so a segment is judged only by its own.
function heredocBodiesByDelimiter(command: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  for (const line of command.split("\n")) {
    const active = pending[0];
    if (active) {
      const candidate = active.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === active.delimiter) pending.shift();
      else bodies.set(active.delimiter, `${bodies.get(active.delimiter) ?? ""}${line}\n`);
      continue;
    }
    for (const match of line.matchAll(/<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      const delimiter = match[2] ?? match[3] ?? match[4];
      if (delimiter) pending.push({ delimiter, stripTabs: match[1] === "-" });
    }
  }
  return bodies;
}

// Whether the shell itself expands anything: `$` or a backtick outside single
// quotes (masked substitutions read as `$`). `$'...'` and `$"..."` quote.
function shellExpands(text: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      return true;
    } else if (ch === "$") {
      if (text[i + 1] !== "'" && text[i + 1] !== '"') return true;
    } else if (ch === '"') {
      quote = quote === '"' ? null : '"';
    } else if (ch === "'" && quote === null) {
      quote = "'";
    }
  }
  return false;
}

// Interpreters and hosts run whatever they are given: arguments, a
// here-string, a heredoc, or (reading stdin) the rest of the pipeline.
function backgroundHostedProgram(
  command: string,
  executable: string,
  argv: string[],
  segment: string,
  heredocs: Map<string, string>,
): string | null {
  const interpreter = SCRIPT_RUNNER.test(executable);
  let program: string[];
  if (interpreter || EXECUTION_HOST.test(executable) || NAMING_HOST.test(executable)) {
    program = programWords(segment);
  } else if (executable === "find") {
    const words = programWords(segment);
    const exec = words.findIndex((word) => /^-(?:exec|execdir|ok|okdir)$/.test(word));
    if (exec < 0) return null;
    program = words.slice(exec + 1);
  } else {
    return null;
  }
  if (!NAMING_HOST.test(executable) && shellExpands(program.join(" "))) {
    return `${executable} arguments computed at runtime`;
  }
  if (/^bun(?:\.exe)?$/i.test(executable)) {
    const invocation = bunScriptInvocation(argv);
    if (invocation?.kind === "script" && /[*?[]/.test(invocation.path)) {
      return "bun script chosen by a glob at runtime";
    }
  }
  const delimiters = [...segment.matchAll(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const readsStdin = interpreter &&
    ["-", undefined].includes(argv.slice(1).find((word) => word === "-" || !word.startsWith("-")));
  const text = [
    segment,
    ...delimiters.map((delimiter) => heredocs.get(delimiter) ?? ""),
    ...(readsStdin ? [command] : []),
  ].join("\n");
  // awk names AIDLC only through system() or a command pipe.
  if (/^[gmn]?awk(?:\.exe)?$/i.test(executable) && !/system\s*\(|\|/.test(text)) return null;
  return AIDLC_TARGET.test(text) ? `${executable} arguments that name AIDLC` : null;
}

// Git runs AIDLC through aliases, -c hooks, rebase --exec, bisect run, and
// submodule foreach; it rewrites protected paths through pathspecs or -C.
// Tree-wide forms (git stash, git reset --hard) stay available: they are
// everyday recovery moves, and refusing them would strand ordinary work.
function backgroundGitCommand(argv: string[], insideProtectedTree: boolean): string | null {
  if (commandBasename(argv[0]) !== "git") return null;
  let protectedRoot = insideProtectedTree;
  let i = 1;
  while ((argv[i] ?? "").startsWith("-")) {
    const option = argv[i];
    const value = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)
      ? argv[++i] ?? ""
      : option.replace(/^--[a-z-]+=/, "");
    if (option === "-c" && AIDLC_TARGET.test(value)) return "git configuration that runs AIDLC";
    if (["-C", "--git-dir", "--work-tree"].includes(option) || /^--(?:git-dir|work-tree)=/.test(option)) {
      protectedRoot ||= PROTECTED_PATH.test(value);
    }
    i++;
  }
  const verb = argv[i] ?? "";
  const rest = argv.slice(i + 1);
  const runs = verb === "rebase"
    ? rest.filter((word, index) => ["-x", "--exec"].includes(rest[index - 1] ?? "") || /^--exec=/.test(word))
    : (verb === "bisect" && rest[0] === "run") || (verb === "submodule" && rest[0] === "foreach")
      ? rest.slice(1)
      : [];
  if (runs.some((word) => AIDLC_TARGET.test(word))) return `git ${verb} running AIDLC`;
  if (protectedRoot && GIT_TREE_MUTATIONS.has(verb)) {
    return "git working-tree change inside AIDLC's records or install";
  }
  if (!GIT_PATHSPEC_MUTATIONS.has(verb)) return null;
  const paths = rest.filter((word, index) =>
    !word.startsWith("-") && !GIT_VALUE_OPTIONS.has(rest[index - 1] ?? "")
  );
  return paths.some((path) => PROTECTED_PATH.test(path))
    ? "git working-tree change inside AIDLC's records or install"
    : null;
}

function writesFiles(segment: string): boolean {
  return shellWriteTargets(segment).some((target) =>
    !/^[\\/]dev[\\/](?:null|stdout|stderr|tty)$/.test(target)
  );
}

// Lexical cwd relative to the command's start: a component list, or null
// once it is unknown (absolute, home, or computed).
function nextCwd(cwd: string[] | null, target: string): string[] | null {
  if (PROTECTED_PATH.test(target) && /^(?:~|[A-Za-z]:)?[\\/]/.test(target)) return ["aidlc"];
  if (cwd === null || target === "" || /^(?:~|-|[A-Za-z]:)?[\\/]?$/.test(target) ||
    /^(?:~|[A-Za-z]:)?[\\/]/.test(target) || /[$`*?[]/.test(target)) {
    return null;
  }
  const next = [...cwd];
  for (const part of target.split(/[\\/]+/)) {
    if (part === "..") next.pop();
    else if (part !== "." && part !== "") next.push(part);
  }
  return next;
}

function delegatedLifecycleCommandAtDepth(
  command: string,
  depth: number,
  background?: BackgroundInspection,
): string | null {
  if (depth > 8) return "nested shell command beyond guard inspection limit";
  const heredocBodies = heredocSubstitutionBodies(command);
  const source = maskHeredocBodies(command);
  const substitutions = executableSubstitutions(source);
  const heredocs = background ? heredocBodiesByDelimiter(command) : new Map<string, string>();
  let cwd: string[] | null = [];
  const cwdStack: Array<string[] | null> = [];
  const insideProtectedTree = (): boolean =>
    cwd !== null && cwd.length > 0 && PROTECTED_PATH.test(`${cwd.join("/")}/`);
  for (const body of [...heredocBodies, ...substitutions.bodies]) {
    const nested = delegatedLifecycleCommandAtDepth(
      body,
      depth + 1,
      background,
    );
    if (nested !== null) return nested;
  }

  // Only standalone literal assignments survive into later command segments.
  // Resolve those values where possible; fail closed when a delegated
  // executable or shell command remains dynamically indeterminate.
  const assignments = new Map<string, string>();
  // The splitter cuts `>|`, `&>`, and `2>&1` at their `|` or `&`; background
  // inspection reads them as the plain redirections they are.
  const segmentSource = background
    ? substitutions.masked.replace(/\d*>&[\d-]/g, " ").replace(/&>>?|>>?\|/g, ">")
    : substitutions.masked;
  for (const segment of shellCommandSegments(segmentSource)) {
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
    if (background && insideProtectedTree() && writesFiles(segment)) {
      return "writes inside AIDLC's records or install; run them as a separate command";
    }
    if (argv.length === 0) continue;
    if (background) {
      if (aidlcEntrypointInvocation(executable, argv)) {
        // Never a segment of a larger or nested command whose cwd, input, or
        // expansion it would inherit.
        return depth === 0
          ? backgroundAidlcInvocation(command.trim(), background.installedScript)
          : "nested AIDLC command beyond background read policy";
      }
      const cwdArgv = executable === "builtin" ? argv.slice(1) : argv;
      const cwdCommand = commandBasename(cwdArgv[0]);
      if (["cd", "pushd", "chdir", "popd"].includes(cwdCommand)) {
        if (cwdCommand === "popd") {
          cwd = cwdStack.pop() ?? null;
          continue;
        }
        if (cwdCommand === "pushd") cwdStack.push(cwd);
        const target = cwdArgv.slice(1).find((word) => !word.startsWith("-")) ?? "";
        const variable = variableReference(target);
        cwd = nextCwd(cwd, variable === null ? target : assignments.get(variable) ?? target);
        continue;
      }
      // env -C and --chdir move the cwd for this segment only.
      const envDir = /(?:^|\s)env\s(?:.*\s)?(?:-C\s*|--chdir[=\s]\s*)["']?([^\s"']+)/.exec(segment)?.[1];
      const inside = insideProtectedTree() || (envDir !== undefined && PROTECTED_PATH.test(envDir));
      const git = backgroundGitCommand(argv, inside);
      if (git !== null) return git;
      const hosted = backgroundHostedProgram(command, executable, argv, segment, heredocs);
      if (inside && (
        SCRIPT_RUNNER.test(executable) || EXECUTION_HOST.test(executable) ||
        NAMING_HOST.test(executable) || argv.some((word) => /^-(?:exec|execdir|ok|okdir)$/.test(word)) ||
        ["patch", "mkdir", "ln", "chmod", "chown"].includes(executable) ||
        writesFiles(segment)
      )) {
        return "writes or programs inside AIDLC's records or install; run them as a separate command";
      }
      if (hosted !== null) return hosted;
    }
    if (executable === "eval") {
      const evalArgs = argv.slice(1);
      if (evalArgs[0] === "--") evalArgs.shift();
      const evalCommand = evalArgs.join(" ");
      const nested = delegatedLifecycleCommandAtDepth(
        evalCommand,
        depth + 1,
        background,
      );
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
          const nested = delegatedLifecycleCommandAtDepth(
            nestedCommand,
            depth + 1,
            background,
          );
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
      if (invocation.kind === "uninspectable") {
        return "bun script or runtime options beyond guard inspection";
      }
      if (invocation.kind === "dynamic") {
        continue;
      }
      script = invocation.script;
      args = invocation.args;
    }
    const authored = script.match(/^aidlc-(orchestrate|state|jump|utility)\.ts$/);
    if (authored) {
      const tool = authored[1];
      const positional = tool === "orchestrate"
        ? withoutOrchestrateGlobals(args)
        : withoutProjectDir(args);
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
  // This is the harness trust boundary, not a fence. Never consult policy,
  // memory, session presence, or a bypass before enforcing it.
  if (refuseRuntimeIntegrityViolation(parsed)) return 2;
  if (parsed.tool_name !== "Bash") return 0;
  // The fence is up only while nobody with authority asked for this. A human
  // message newer than the engine's last directive, or a lowered fence, lets
  // the command through with one line and one audit row instead of a refusal.
  const standAside = (detail: string): boolean => {
    let projectDir: string;
    try {
      projectDir = resolveProjectDirFromHook(import.meta.url);
    } catch {
      return false; // no workspace to read: the fence stays up
    }
    let gate: ReturnType<typeof decideFence>;
    try {
      gate = decideFence(projectDir, "state-transition", { hookInput: parsed });
    } catch {
      return false;
    }
    if (gate.decision !== "stand-aside") return false;
    writeGuardStoodAside(guardStoodAsideLine("state-transition", gate.source, detail));
    recordGuardStoodAside(projectDir, {
      fence: "state-transition",
      authority: gate.authority,
      tool: "Bash",
      details: detail,
    });
    return true;
  };
  const agentType = parsed.agent_type?.trim() ||
    (typeof parsed.tool_input?.subagent_type === "string"
      ? parsed.tool_input.subagent_type.trim() : "");
  const verb = directStateTransition(parsed.tool_input?.command ?? "");
  if (verb !== null) {
    if (standAside(`aidlc-state.ts ${verb}`)) return 0;
    const switchSentence = agentType.length === 0
      ? fenceSwitchSentence(resolveProjectDirFromHook(import.meta.url), "state-transition")
      : "";
    process.stderr.write(
      `Stage status cannot be changed with aidlc-state.ts ${verb} because that bypasses ` +
        "the workflow's completion and approval checks. Use aidlc-orchestrate.ts report " +
        "--stage <slug> --result " +
        "<awaiting-approval|approved|rejected|revised|completed|skipped>; use " +
        "aidlc-orchestrate.ts park to pause, and next/jump to move through the workflow. " +
        `${switchSentence}\n`,
    );
    return 2;
  }

  if (agentType.length === 0) return 0;
  const delegatedCommand = delegatedLifecycleCommand(
    parsed.tool_input?.command ?? "",
  );
  if (delegatedCommand === null) return 0;

  if (standAside(delegatedCommand)) return 0;
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
