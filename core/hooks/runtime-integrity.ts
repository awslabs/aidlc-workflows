// Defense in depth for harness-owned runtime records and hooks, not a sandbox.
// Hooks and tool calls run as the same user, so an agent with unrestricted
// execution can always find a path around a lexical check. The outer boundary
// is the harness's permission model and the person's review of what the agent
// runs. This check runs before fence decisions; no Guard Policy word, lowered
// fence, or presence bypass turns it off.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ClaudeCodeHookInput } from "../tools/aidlc-lib.ts";
import { resolveHarnessRoot, runtimeHarnessDir } from "../tools/aidlc-runtime-paths.ts";
import {
  shellCommandInvocationDetails,
  shellWriteTargets,
  writeTargets,
} from "./review-freeze-command.ts";

const RUNTIME_RECORD_PATH = /(?:^|[\\/])\.(?:aidlc-sessions|aidlc-plan-approval)(?:[\\/]|$)/;
const RUNTIME_RECORD_MENTION = /(?:^|[\\/'"`\s])\.(?:aidlc-sessions|aidlc-plan-approval)(?=[\\/'"`\s]|$)/;
const HOOK_FILE = /(?:^|[\\/])hooks[\\/]aidlc-[a-z-]+\.ts$|(?:^|[\\/])aidlc-(?:kiro|codex|copilot|cursor)-adapter\.ts$/;
const HOOK_MODULE = /(?:^|[\\/])(?:hooks[\\/]aidlc-[a-z-]+|aidlc-(?:record-human-turn|guard-switch))(?:\.ts)?$/;
const HARNESS_CONTROL_ASSIGNMENT = /\b(?:AIDLC_SESSION_OVERRIDE|AIDLC_SESSION_OVERRIDE_SOURCE|AIDLC_SKIP_HUMAN_PRESENCE_GUARD|AIDLC_UNATTENDED|AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS|AIDLC_STATE_TRANSITION_OWNER)=/;
const SCRIPT_EXTENSION = /\.(?:ts|js|mjs|cjs|sh|py)$/;
const PROSE_EXTENSION = /\.(?:md|markdown|mdown|txt|rst|adoc|asciidoc)$/i;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_EXECUTION_DEPTH = 32;
const MODULE_OPTION = /^(?:--(?:require|import|preload|loader|experimental-loader)(?:=(.*))?|-r(.*))$/;
const DATA_OPTION = /^(?:--cwd|--config|--conditions|--env-file)$/;

interface SourceToken {
  kind: "word" | "string" | "group" | "symbol" | "regexp";
  text: string;
  start: number;
  end: number;
  value?: string;
  children?: SourceToken[];
}

function decodeLiteral(raw: string): string {
  return raw.replace(/\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (escaped) => {
    if (escaped[1] === "\n" || escaped[1] === "\r") return "";
    const hex = escaped.startsWith("\\u{") ? escaped.slice(3, -1)
      : /^[\\][ux]/.test(escaped) ? escaped.slice(2) : null;
    if (hex !== null) {
      const point = Number.parseInt(hex, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : escaped;
    }
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[escaped[1]] ?? escaped[1];
  });
}

// This is a lexer for the recognized execution sites, not a JS/Python runtime.
// Comments, regex bodies and strings are opaque. Template interpolations are
// code; literal values are opened only by import/require or an execution sink.
// Groups use an explicit stack so large nested data fixtures need no recursion.
function sourceTokens(source: string, python: boolean): SourceToken[] {
  let index = 0;
  const read = (stop = ""): SourceToken[] => {
    const root: SourceToken[] = [];
    const frames: SourceToken[][] = [root];
    const groups: SourceToken[] = [];
    while (index < source.length) {
      const tokens = frames[frames.length - 1];
      const start = index;
      const ch = source[index];
      if (/\s/.test(ch)) { index++; continue; }
      if ((!python && source.startsWith("//", index)) ||
        (ch === "#" && (python || groups.length === 0 &&
          /^\s*$/.test(source.slice(source.lastIndexOf("\n", index - 1) + 1, index))))) {
        const end = /[\r\n\u2028\u2029]/.exec(source.slice(index));
        index = end ? index + end.index : source.length;
        continue;
      }
      if (!python && source.startsWith("/*", index)) {
        const end = source.indexOf("*/", index + 2);
        index = end < 0 ? source.length : end + 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        const delimiter = python && source.startsWith(ch.repeat(3), index) ? ch.repeat(3) : ch;
        index += delimiter.length;
        let raw = "";
        let dynamic = false;
        const children: SourceToken[] = [];
        while (index < source.length && !source.startsWith(delimiter, index)) {
          if (source[index] === "\\") {
            raw += source.slice(index, index + 2);
            index += 2;
          } else if (ch === "`" && source.startsWith("${", index)) {
            dynamic = true;
            index += 2;
            children.push(...read("}"));
          } else {
            raw += source[index++];
          }
        }
        index = Math.min(source.length, index + delimiter.length);
        tokens.push({ kind: "string", text: source.slice(start, index), start, end: index,
          ...(dynamic ? {} : { value: decodeLiteral(raw) }), ...(children.length ? { children } : {}) });
        continue;
      }
      if ("([{".includes(ch)) {
        const children: SourceToken[] = [];
        const group: SourceToken = { kind: "group", text: ch, start, end: source.length, children };
        tokens.push(group);
        groups.push(group);
        frames.push(children);
        index++;
        continue;
      }
      if (")]}".includes(ch)) {
        index++;
        if (frames.length === 1 && ch === stop) return root;
        const group = groups[groups.length - 1];
        if (group && ")]}"["([{".indexOf(group.text)] === ch) {
          group.end = index;
          groups.pop();
          frames.pop();
        } else tokens.push({ kind: "symbol", text: ch, start, end: index });
        continue;
      }
      const previous = tokens[tokens.length - 1];
      if (!python && ch === "/" && (!previous ||
        previous.kind === "symbol" && "=,:;!?&|+-*".includes(previous.text) ||
        previous.kind === "word" && /^(?:return|throw|case|yield|await)$/.test(previous.text))) {
        index++;
        let bracket = false;
        while (index < source.length) {
          const current = source[index++];
          if (current === "\\") { index++; continue; }
          if (current === "[") bracket = true;
          if (current === "]") bracket = false;
          if (current === "/" && !bracket) break;
          if (/[\r\n\u2028\u2029]/.test(current)) break;
        }
        while (/[a-z]/i.test(source[index] ?? "") && index < source.length) index++;
        tokens.push({ kind: "regexp", text: source.slice(start, index), start, end: index });
        continue;
      }
      const word = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(source.slice(index));
      index += word?.[0].length ?? 1;
      tokens.push({ kind: word ? "word" : "symbol", text: source.slice(start, index), start, end: index });
    }
    return root;
  };
  return read();
}

function argumentParts(tokens: SourceToken[]): SourceToken[][] {
  const parts: SourceToken[][] = [[]];
  for (const token of tokens) {
    if (token.text === "," && token.kind === "symbol") parts.push([]);
    else parts[parts.length - 1].push(token);
  }
  return parts;
}

type SourceBindings = ReadonlyMap<string, SourceToken[]>;

function boundValue(tokens: SourceToken[], bindings?: SourceBindings): SourceToken[] {
  const seen = new Set<string>();
  while (tokens.length === 1) {
    const token = tokens[0];
    if (token.text === "(") tokens = token.children ?? [];
    else if (token.kind === "word" && bindings?.has(token.text) && !seen.has(token.text)) {
      seen.add(token.text);
      tokens = bindings.get(token.text) ?? [];
    } else break;
  }
  return tokens;
}

function literal(tokens: SourceToken[], bindings?: SourceBindings): string | undefined {
  tokens = boundValue(tokens, bindings);
  if (tokens.map((token) => token.text).join("") === "process.execPath") return "bun";
  if (tokens.length !== 1) return undefined;
  return tokens[0].kind === "string" ? tokens[0].value : undefined;
}

function arrayLiteral(tokens: SourceToken[], bindings?: SourceBindings): Array<string | undefined> | undefined {
  // Python subprocess also accepts args=[...].
  if (tokens[0]?.text === "args" && tokens[1]?.text === "=") tokens = tokens.slice(2);
  tokens = boundValue(tokens, bindings);
  return tokens.length === 1 && tokens[0].text === "["
    ? argumentParts(tokens[0].children ?? []).filter((part) => part.length > 0).map((part) => literal(part, bindings))
    : undefined;
}

function objectField(tokens: SourceToken[], name: string, bindings?: SourceBindings): SourceToken[] {
  tokens = boundValue(tokens, bindings);
  if (tokens.length !== 1 || tokens[0].text !== "{") return [];
  return argumentParts(tokens[0].children ?? [])
    .find((part) => (part[0]?.value ?? part[0]?.text) === name && part[1]?.text === ":")
    ?.slice(2) ?? [];
}

function executableName(path: string): string {
  return (path.replaceAll("\\", "/").split("/").pop() ?? "").replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
}

function interpreter(name: string): "shell" | "python" | "javascript" | null {
  return /^(?:sh|bash|zsh)$/.test(name) ? "shell"
    : /^python(?:\d+(?:\.\d+)*)?$/.test(name) ? "python"
      : /^(?:bun|node|tsx|deno)$/.test(name) ? "javascript" : null;
}

function protectedInvocation(
  executable: string,
  args: Array<string | undefined>,
  cwd: string,
  depth: number,
): boolean {
  if (depth > MAX_EXECUTION_DEPTH) return false;
  if (HOOK_FILE.test(executable)) return true;
  const name = executableName(executable);
  if (/^aidlc(?:\.ts)?$/.test(name)) {
    return args[0] === "engine" && args[1] === "hook" ||
      args.includes("--internal-aidlc-record-human-turn");
  }
  const kind = interpreter(name);
  if (!kind) return false;
  let inlineMode = false;
  let checkMode = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) return false;
    const inline = kind === "javascript"
      ? /^(?:--(?:eval|print)(?:=(.*))?|-i*(?:pe|ep|e|p)(.*))$/.exec(arg)
      : /^(?:-c(.*)|-[a-z]*c)$/.exec(arg);
    if (inline) {
      const source = arg.startsWith("--") && arg.includes("=")
        ? inline[1] ?? "" : inline[1] || inline[2] || args[++index];
      if (source === undefined) return false;
      if (RUNTIME_RECORD_MENTION.test(source) || (kind === "shell"
        ? protectedShell(source, cwd, depth + 1)
        : protectedContent(source, cwd, depth + 1, kind === "python"))) return true;
      inlineMode = true;
      continue;
    }
    if (kind === "javascript" && name !== "deno" && /^(?:--check|-c)$/.test(arg)) {
      checkMode = true;
      continue;
    }
    const moduleOption = MODULE_OPTION.exec(arg);
    if (moduleOption) {
      const module = moduleOption[1] ?? (moduleOption[2] || args[++index]);
      if (module && (HOOK_MODULE.test(module) || protectedScriptFile(module, cwd, depth + 1, "javascript"))) return true;
      continue;
    }
    if (DATA_OPTION.test(arg)) { index++; continue; }
    if (arg === "run" && /^(?:bun|deno|tsx)$/.test(name)) continue;
    if (arg === "--") {
      if (inlineMode || checkMode) return false;
      const file = args[index + 1];
      return file !== undefined && (protectedInvocation(file, args.slice(index + 2), cwd, depth + 1) ||
        protectedScriptFile(file, cwd, depth + 1, kind));
    }
    if (arg.startsWith("-")) continue;
    if (inlineMode || checkMode) return false;
    return protectedInvocation(arg, args.slice(index + 1), cwd, depth + 1) ||
      protectedScriptFile(arg, cwd, depth + 1, kind);
  }
  return false;
}

function protectedContent(value: unknown, cwd: string, depth = 0, python = false): boolean {
  if (typeof value !== "string" || depth > MAX_EXECUTION_DEPTH) return false;
  const pending = [{ tokens: sourceTokens(value, python), bindings: new Map<string, SourceToken[]>() }];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    const { tokens, bindings } = current;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.children) pending.push({ tokens: token.children, bindings: new Map(bindings) });
      const next = tokens[index + 1];
      // Resolve simple literal variables when an execution sink consumes them,
      // not when they are stored as examples. Do not guess computed expressions.
      if (token.kind === "word" && next?.text === "=") {
        const rhs = tokens[index + 2];
        const after = tokens[index + 3];
        bindings.delete(token.text);
        if (rhs && (!after || after.text === ";" || after.text === "," ||
          /[\r\n\u2028\u2029]/.test(value.slice(rhs.end, after.start)))) {
          bindings.set(token.text, boundValue([rhs], bindings));
        }
      }
      let name = token.kind === "word" ? token.text.split(".").pop()
        : token.text === "[" ? literal(token.children ?? [])
          : token.text === "(" ? token.children?.at(-1)?.text : undefined;
      if (name === "import" || name === "require" || name === "from") {
        const module = next?.text === "(" ? literal(argumentParts(next.children ?? [])[0], bindings)
          : literal([next].filter(Boolean), bindings);
        if (module && HOOK_MODULE.test(module)) return true;
      }
      if (next?.text === "(" && name) {
        let parts = argumentParts(next.children ?? []);
        if (token.kind === "word" && /^(?:eval|Function|AsyncFunction|GeneratorFunction)\.(?:call|apply|bind)$/.test(token.text)) {
          name = token.text.split(".")[0];
          parts = token.text.endsWith(".apply") && parts[1]?.[0]?.text === "["
            ? argumentParts(parts[1][0].children ?? []) : parts.slice(1);
        }
        if (/^(?:eval|exec|Function|AsyncFunction|GeneratorFunction|runInThisContext|runInNewContext|runInContext|Script)$/.test(name)) {
          const body = literal(/Function$/.test(name) ? parts[parts.length - 1] : parts[0], bindings);
          if (body !== undefined && protectedContent(body, cwd, depth + 1, python)) return true;
        }
        if (/^(?:exec|execSync|system)$/.test(name) &&
          !(name === "exec" && (python || tokens[index - 2]?.kind === "regexp"))) {
          const command = literal(parts[0], bindings);
          if (command !== undefined && protectedShell(command, cwd, depth + 1)) return true;
        }
        if (/^(?:spawn|spawnSync|execFile|execFileSync|Popen|check_call|check_output|Command)$/.test(name) ||
          /^(?:subprocess\.(?:run|call)|Deno\.run)$/.test(token.text)) {
          const argv = arrayLiteral(parts[0], bindings) ?? arrayLiteral(objectField(parts[0], "cmd", bindings), bindings);
          if (argv?.[0] !== undefined && protectedInvocation(argv[0], argv.slice(1), cwd, depth + 1)) return true;
          const executable = literal(parts[0], bindings);
          const args = arrayLiteral(parts[1] ?? [], bindings) ??
            arrayLiteral(objectField(parts[1] ?? [], "args", bindings), bindings) ?? [];
          if (executable !== undefined && protectedInvocation(executable, args, cwd, depth + 1)) return true;
        }
      }
      // Recognize shell commands in shell wrappers without interpreting a JS
      // string/template as shell source. Tokens inside either remain opaque.
      if (token.kind === "word" && (interpreter(token.text) || token.text === "aidlc") &&
        next?.text !== "(") {
        let end = token.end;
        for (const following of tokens.slice(index + 1)) {
          if (following.text === ";" || /[\r\n\u2028\u2029]/.test(value.slice(end, following.start))) break;
          end = following.end;
        }
        if (protectedShell(value.slice(token.start, end), cwd, depth + 1)) return true;
      }
    }
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellSubstitutionEnd(source: string, open: number): number {
  let nesting = 1;
  let quote = "";
  for (let index = open + 1; index < source.length; index++) {
    const ch = source[index];
    if (ch === "\\" && quote !== "'") { index++; continue; }
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") nesting++;
    else if (ch === ")" && --nesting === 0) return index;
  }
  return source.length;
}

function literalShellOutput(command: string): string | undefined {
  const calls = shellCommandInvocationDetails(command);
  if (calls.length !== 1) return undefined;
  const { name, args } = calls[0];
  if (name === "echo" && !args[0]?.startsWith("-")) return args.join(" ");
  if (name === "printf" && args[0] === "%s") return args.slice(1).join("");
  return undefined;
}

function interpreterReadsCode(name: string, args: string[]): boolean {
  const kind = interpreter(name);
  if (!kind) return false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (/^(?:--help|--version|-h|-v|-V)$/.test(arg)) return false;
    if (kind === "javascript"
      ? /^(?:--(?:eval|print|check)(?:=|$)|-i*(?:e|p|c))/.test(arg)
      : /^(?:-c|-[a-z]*c$)/.test(arg)) return false;
    const moduleOption = MODULE_OPTION.exec(arg);
    if (moduleOption) {
      if (moduleOption[1] === undefined && !moduleOption[2]) index++;
      continue;
    }
    if (DATA_OPTION.test(arg)) { index++; continue; }
    if (kind === "shell" && /^-[a-z]*s$/.test(arg)) return true;
    if (arg === "-" || /^\/(?:dev\/(?:stdin|fd\/0)|proc\/self\/fd\/0)$/.test(arg)) return true;
    if (arg === "--") return args[index + 1] === undefined || args[index + 1] === "-";
    if (arg === "run" && /^(?:bun|deno|tsx)$/.test(name)) continue;
    if (!arg.startsWith("-")) return false;
  }
  return true;
}

// Limit stdin consumers to this command and its downstream pipeline, excluding
// earlier/later independent commands. Redirection filenames are not script argv.
function heredocPipeline(header: string, herePosition: number): { raw: string; execution: string } {
  let quote = "";
  let start = 0;
  let end = header.length;
  const redirects: Array<[number, number]> = [];
  for (let index = 0; index < header.length; index++) {
    const ch = header[index];
    if (ch === "\\" && quote !== "'") { index++; continue; }
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    const redirect = /^(?:\d*)?(?:>>?|<|&>)(?:&)?[ \t]*/.exec(header.slice(index));
    if (redirect && (ch === "<" || ch === ">" || ch === "&" ||
      index === 0 || /\s|[;|&]/.test(header[index - 1]))) {
      const begin = index;
      index += redirect[0].length;
      let targetQuote = "";
      while (index < header.length) {
        const current = header[index];
        if (current === "\\" && targetQuote !== "'") { index += 2; continue; }
        if (targetQuote) {
          if (current === targetQuote) targetQuote = "";
        } else if (current === "'" || current === '"') targetQuote = current;
        else if (/\s|[;|&<>]/.test(current)) break;
        index++;
      }
      redirects.push([begin, index]);
      index--;
      continue;
    }
    if (!";|&\n".includes(ch)) continue;
    const pair = header.slice(index, index + 2);
    const width = ["&&", "||", "|&"].includes(pair) ? 2 : 1;
    if (index < herePosition) start = index + width;
    else if (ch !== "|" || pair === "||") { end = index; break; }
    index += width - 1;
  }
  const execution = header.split("");
  for (const [begin, after] of redirects) {
    for (let index = begin; index < after; index++) execution[index] = " ";
  }
  return { raw: header.slice(start, end), execution: execution.slice(start, end).join("") };
}

function protectedHeredoc(body: string, header: string, herePosition: number, stdin: boolean, cwd: string, depth: number): boolean {
  const pipeline = heredocPipeline(header, herePosition);
  const kinds = new Set<"shell" | "python" | "javascript">();
  if (stdin) {
    for (const call of shellCommandInvocationDetails(pipeline.execution)) {
      const kind = interpreter(call.name);
      if (kind && interpreterReadsCode(call.name, call.args)) kinds.add(kind);
    }
  }
  for (const target of shellWriteTargets(pipeline.raw, cwd)) {
    if (PROSE_EXTENSION.test(target)) continue;
    let script = SCRIPT_EXTENSION.test(target);
    try {
      const info = statSync(resolve(cwd, target));
      script ||= info.isFile() && (info.mode & 0o111) !== 0;
    } catch { /* new target */ }
    if (script) kinds.add(target.endsWith(".sh") || /^#![^\n]*\b(?:sh|bash|zsh)\b/.test(body)
      ? "shell" : target.endsWith(".py") ? "python" : "javascript");
  }
  return [...kinds].some((kind) => kind === "shell" ? protectedShell(body, cwd, depth + 1)
    : protectedContent(body, cwd, depth + 1, kind === "python"));
}

// Shell quoting has different semantics from source strings: substitutions
// execute inside double quotes, and interpreter -c/-e arguments become code.
// Strip comments/heredoc bodies before asking the shared invocation parser
// about executable positions. Do not search arbitrary argv text for hook names.
function protectedShell(command: string, cwd: string, depth = 0, expansionsOnly = false): boolean {
  if (depth > MAX_EXECUTION_DEPTH) return false;
  let quote = "";
  let visible = "";
  for (let index = 0; index < command.length; index++) {
    const ch = command[index];
    if (ch === "\\" && quote !== "'") {
      visible += command.slice(index, index + 2);
      index++;
      continue;
    }
    if (quote === "'") {
      visible += ch;
      if (ch === "'") quote = "";
      continue;
    }
    if (!expansionsOnly && ch === "'" && !quote) { quote = ch; visible += ch; continue; }
    if (!expansionsOnly && ch === '"') { quote = quote ? "" : ch; visible += ch; continue; }
    if (!quote && !expansionsOnly && ch === "#" && (index === 0 || /\s|[;|&]/.test(command[index - 1]))) {
      const end = command.indexOf("\n", index);
      index = end < 0 ? command.length : end - 1;
      continue;
    }
    if (ch === "`" || ch === "$" && command[index + 1] === "(") {
      let end: number;
      const start = index + (ch === "`" ? 1 : 2);
      if (ch === "`") {
        end = start;
        while (end < command.length && command[end] !== "`") {
          if (command[end] === "\\") end++;
          end++;
        }
      } else end = shellSubstitutionEnd(command, index + 1);
      const body = command.slice(start, end);
      if (protectedShell(body, cwd, depth + 1)) return true;
      const output = literalShellOutput(body) ?? "__substitution__";
      visible += quote === '"' ? output.replace(/["\\]/g, "\\$&")
        : output.split(/\s+/).map(shellQuote).join(" ");
      index = end;
      continue;
    }
    if (!quote && !expansionsOnly && command.startsWith("<<", index) && command[index + 2] !== "<") {
      const here = /^<<(-)?[ \t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/.exec(command.slice(index));
      if (here) {
        const delimiter = here[2] ?? here[3] ?? here[4];
        const newline = command.indexOf("\n", index + here[0].length);
        if (newline >= 0) {
          let end = newline + 1;
          const bodyStart = end;
          while (end < command.length) {
            const nextLine = command.indexOf("\n", end);
            const lineEnd = nextLine < 0 ? command.length : nextLine;
            const line = command.slice(end, lineEnd).replace(/\r$/, "");
            if ((here[1] ? line.replace(/^\t+/, "") : line) === delimiter) break;
            end = nextLine < 0 ? command.length : nextLine + 1;
          }
          const body = command.slice(bodyStart, end);
          const descriptor = /(?:^|[ \t])(\d+)$/.exec(visible);
          const prefix = descriptor ? visible.slice(0, -descriptor[1].length) : visible;
          const header = prefix + command.slice(index + here[0].length, newline);
          if (protectedHeredoc(body, header, prefix.length, !descriptor || descriptor[1] === "0", cwd, depth) ||
            protectedShell(header, cwd, depth + 1) ||
            here[4] !== undefined && protectedShell(body, cwd, depth + 1, true)) return true;
          const after = command.indexOf("\n", end);
          visible = `${header}\n`;
          index = after < 0 ? command.length : after;
          continue;
        }
      }
    }
    visible += !quote && !expansionsOnly && "(){}".includes(ch) ? ";" : ch;
  }
  if (expansionsOnly) return false;
  if (HARNESS_CONTROL_ASSIGNMENT.test(visible) ||
    shellWriteTargets(visible, cwd).some((path) => protectedRuntimePath(path, cwd))) return true;
  for (const { name, args, executable } of shellCommandInvocationDetails(visible)) {
    if (name === "mkdir" && args.some((path) => protectedRuntimePath(path, cwd))) return true;
    if (name === "alias" && args.some((arg) => {
      const equals = arg.indexOf("=");
      return equals >= 0 && protectedShell(arg.slice(equals + 1), cwd, depth + 1);
    })) return true;
    if (name === "eval" && protectedShell(args.join(" "), cwd, depth + 1)) return true;
    if (executable && protectedInvocation(executable, args, cwd, depth + 1)) return true;
    if (executable && (executable.startsWith("./") || SCRIPT_EXTENSION.test(executable)) &&
      protectedScriptFile(executable, cwd, depth + 1)) return true;
  }
  return false;
}

export const RUNTIME_INTEGRITY_REFUSAL =
  "AIDLC runtime records and hooks belong to the harness: hooks write them when the person acts, and the engine reads them. " +
  "A tool call cannot invoke a hook, choose a session, set a bypass, or edit those records. Use the engine commands instead.";

function protectedRuntimePath(path: unknown, cwd: string): boolean {
  return typeof path === "string" && path.length > 0 && (
    RUNTIME_RECORD_PATH.test(path) || RUNTIME_RECORD_PATH.test(resolve(cwd, path))
  );
}

function pathWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function harnessInstallRoots(cwd: string): string[] {
  const conventional = [".claude", ".codex", ".kiro", ".cursor", ".aidlc"]
    .map((dir) => resolve(cwd, dir));
  try {
    const harnessDir = runtimeHarnessDir(cwd);
    return [...new Set([
      resolveHarnessRoot({ projectDir: cwd, harnessDir, mutable: true }),
      resolveHarnessRoot({ projectDir: cwd, harnessDir }),
      ...conventional,
    ])];
  } catch {
    return conventional;
  }
}

function protectedScriptFile(
  path: string,
  cwd: string,
  depth = 0,
  language?: "shell" | "python" | "javascript",
): boolean {
  if (depth > MAX_EXECUTION_DEPTH) return false;
  const absolute = resolve(cwd, path);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return false;
    // Shipped tools legitimately import hook helpers. Inspect model-authored
    // wrappers, not the runtime installation that those tools belong to.
    const canonical = canonicalExistingPath(absolute);
    if (harnessInstallRoots(cwd).some((root) =>
      pathWithin(canonical, canonicalExistingPath(root))
    )) return false;
    const source = readFileSync(absolute, "utf-8");
    const shell = language ? language === "shell" : path.endsWith(".sh") || !SCRIPT_EXTENSION.test(path) &&
      !/^#![^\n]*\b(?:bun|node|python[\d.]*)\b/.test(source);
    return shell ? protectedShell(source, cwd, depth + 1)
      : protectedContent(source, cwd, depth + 1, language ? language === "python" : path.endsWith(".py"));
  } catch {
    // An unreadable or missing script is outside this lexical check's reach.
    return false;
  }
}

function protectedContentWrite(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  cwd: string,
): boolean {
  const targets = writeTargets(toolName, toolInput, cwd);
  const contentTargets: string[] = [];
  const protectedWrite = (value: unknown, paths: string[]) => typeof value === "string" &&
    paths.some((path) => toolName !== "NotebookEdit" && PROSE_EXTENSION.test(path) ? false
      : path.endsWith(".sh") ? protectedShell(value, cwd)
        : protectedContent(value, cwd, 0, path.endsWith(".py")));
  if ([toolInput?.content, toolInput?.new_source].some((value) => protectedWrite(value, targets))) {
    contentTargets.push(...targets);
  }
  // A replacement fragment has no lexical context. Preview the complete file
  // when possible: inserting an example inside a comment is inert, while
  // deleting only comment delimiters can activate code already in the file.
  // MultiEdit replacements are applied in order, without writing anything.
  const projected = new Map<string, string>();
  const edits = Array.isArray(toolInput?.edits) ? toolInput.edits : [toolInput];
  for (const edit of edits) {
    if (typeof edit !== "object" || edit === null || typeof edit.new_string !== "string") continue;
    const editTargets = writeTargets(toolName, edit, cwd);
    for (const candidate of editTargets.length ? editTargets : targets) {
      const path = resolve(cwd, candidate);
      let current = projected.get(path);
      if (current === undefined && typeof edit.old_string === "string") {
        try {
          const info = statSync(path);
          if (info.isFile() && info.size <= MAX_SCRIPT_BYTES) current = readFileSync(path, "utf-8");
        } catch {
          // Missing/unreadable targets cannot supply context; inspect the fragment.
        }
      }
      if (current !== undefined && typeof edit.old_string === "string" &&
        (edit.old_string.length > 0 || current.length === 0) && current.includes(edit.old_string)) {
        projected.set(path, edit.replace_all === true
          ? current.split(edit.old_string).join(edit.new_string)
          : current.replace(edit.old_string, () => edit.new_string));
      } else if (protectedWrite(edit.new_string, [path])) contentTargets.push(path);
    }
  }
  for (const [path, content] of projected) {
    if (protectedWrite(content, [path])) contentTargets.push(path);
  }
  if (contentTargets.length === 0) return false;
  const exemptRoots = harnessInstallRoots(cwd);
  // The authored repository must be able to develop and document its hooks.
  if (existsSync(resolve(cwd, "scripts/package.ts"))) {
    for (const tree of ["core", "harness", "tests", "docs"]) exemptRoots.push(resolve(cwd, tree));
  }
  return contentTargets.some((path) => {
    const absolute = resolve(cwd, path);
    return !exemptRoots.some((root) => pathWithin(absolute, root));
  });
}

function runtimeIntegrityViolation(input: ClaudeCodeHookInput): "runtime" | "content" | null {
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (toolName === "Bash") {
    const command = toolInput?.command;
    if (typeof command !== "string") return null;
    return protectedShell(command, cwd) ? "runtime" : null;
  }
  if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) return null;
  if (writeTargets(toolName, toolInput, cwd).some((path) => protectedRuntimePath(path, cwd))) {
    return "runtime";
  }
  if (Array.isArray(toolInput?.edits) && toolInput.edits.some((edit: unknown) =>
    typeof edit === "object" && edit !== null && "file_path" in edit &&
    protectedRuntimePath(edit.file_path, cwd)
  )) return "runtime";
  return protectedContentWrite(toolName, toolInput, cwd) ? "content" : null;
}

export function violatesRuntimeIntegrity(input: ClaudeCodeHookInput): boolean {
  return runtimeIntegrityViolation(input) !== null;
}

/** Write the refusal for a violating tool call; true when the caller must exit 2. */
export function refuseRuntimeIntegrityViolation(input: ClaudeCodeHookInput): boolean {
  const violation = runtimeIntegrityViolation(input);
  if (violation === null) return false;
  const clause = violation === "content"
    ? " (Scripts the agent writes or runs may not import these hooks either.)"
    : "";
  process.stderr.write(`${RUNTIME_INTEGRITY_REFUSAL}${clause}\n`);
  return true;
}
