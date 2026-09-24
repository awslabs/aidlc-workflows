// Defense in depth for harness-owned runtime records and hooks, not a sandbox.
// Hooks and tool calls run as the same user, so an agent with unrestricted
// execution can always find a path around a lexical check. The outer boundary
// is the harness's permission model and the person's review of what the agent
// runs. This check runs before fence decisions; no Guard Policy word, lowered
// fence, or presence bypass turns it off.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ClaudeCodeHookInput } from "../tools/aidlc-lib.ts";
import { isCompiledModuleUrl, resolveHarnessRoot, runtimeHarnessDir } from "../tools/aidlc-runtime-paths.ts";
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
// These shipped entrypoints legitimately load hook helpers or perform runtime
// maintenance. Their paths are also protected from direct tool-call mutation.
// Other scripts do not gain trust from being placed in a harness directory.
const TRUSTED_RUNTIME_ENTRYPOINTS = new Set([
  "aidlc.ts",
  "aidlc-lib.ts",
  "aidlc-utility.ts",
  "aidlc-orchestrate.ts",
  "aidlc-plugin-validate.ts",
  "aidlc-init.ts",
  "aidlc-runtime.ts",
  "aidlc-update.ts",
]);

interface SourceToken {
  kind: "word" | "string" | "group" | "symbol" | "regexp" | "api";
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

function apiToken(name: string): SourceToken {
  return { kind: "api", text: name, start: 0, end: 0 };
}

function globalBindings(python: boolean): Map<string, SourceToken[]> {
  const globals: Record<string, string> = python
    ? { eval: "py:eval", exec: "py:exec", __import__: "py:__import__" }
    : { Bun: "bun", Deno: "deno", eval: "js:eval", Function: "js:Function",
      require: "js:require", process: "node:process", globalThis: "js:global", global: "js:global" };
  return new Map(Object.entries(globals).map(([name, api]) => [name, [apiToken(api)]]));
}

function moduleApi(name: string | undefined, python: boolean): string | undefined {
  if (!name) return undefined;
  if (python) return ["subprocess", "os", "builtins"].includes(name) ? `py:${name}` : undefined;
  const module = name.replace(/^node:/, "");
  return ["child_process", "vm", "process", "module"].includes(module) ? `node:${module}`
    : name === "bun" ? "bun" : undefined;
}

const API_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  bun: ["spawn", "spawnSync"],
  deno: ["run", "Command"],
  "node:child_process": ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"],
  "node:vm": ["runInThisContext", "runInNewContext", "runInContext", "Script", "compileFunction"],
  "node:process": ["execPath"],
  "node:module": ["createRequire"],
  "py:subprocess": ["run", "call", "Popen", "check_call", "check_output"],
  "py:os": ["system", "popen"],
};

function apiMember(api: string | undefined, member: string, bindings: SourceBindings): string | undefined {
  if (!api) return undefined;
  if (api === "js:global") {
    return bindings.has(`@global:${member}`) ? undefined
      : globalBindings(false).get(member)?.[0]?.text;
  }
  if (api === "py:builtins" && ["eval", "exec", "__import__"].includes(member)) return `py:${member}`;
  if (member === "default" && api.startsWith("node:")) return api;
  if (API_MEMBERS[api]?.includes(member)) {
    const method = `${api}.${member}`;
    return bindings.has(`@member:${method}`) ? undefined : method;
  }
  if (["call", "apply", "bind"].includes(member) &&
    (/^(?:js:(?:eval|Function|require)|py:(?:eval|exec|__import__))$/.test(api) ||
      Object.entries(API_MEMBERS).some(([module, members]) => members.some((name) => api === `${module}.${name}`)))) {
    return `${api}.${member}`;
  }
  return undefined;
}

// Resolve only literal, statically bound API references. A familiar property
// name on an arbitrary receiver is not proof that it executes code.
function apiReference(tokens: SourceToken[], bindings: SourceBindings, python: boolean, depth = 0): string | undefined {
  if (depth > MAX_EXECUTION_DEPTH || tokens.length === 0) return undefined;
  let index = 0;
  const awaited = tokens[0].text === "await";
  if (awaited) index++;
  const first = tokens[index++];
  if (!first) return undefined;
  let api: string | undefined;
  let dynamicImport = false;
  if (first.kind === "api") api = first.text;
  else if (first.kind === "word") {
    if (awaited && first.text === "import" && !python) dynamicImport = true;
    else if (bindings.has(first.text)) api = apiReference(bindings.get(first.text) ?? [], bindings, python, depth + 1);
    else {
      const [root, ...members] = first.text.split(".");
      api = apiReference(bindings.get(root) ?? [], bindings, python, depth + 1);
      for (const member of members) api = apiMember(api, member, bindings);
    }
  } else if (first.text === "(") {
    const parts = argumentParts(first.children ?? []);
    api = apiReference(parts[parts.length - 1], bindings, python, depth + 1);
  }
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token.text === "." && tokens[index]?.kind === "word") {
      for (const member of tokens[index++].text.split(".")) api = apiMember(api, member, bindings);
    } else if (token.text === "[") {
      const member = literal(token.children ?? [], bindings);
      api = member === undefined ? undefined : apiMember(api, member, bindings);
    } else if (token.text === "(") {
      const parts = argumentParts(token.children ?? []);
      if (dynamicImport || api === "js:require" || api === "py:__import__") {
        api = moduleApi(literal(parts[0], bindings), api === "py:__import__");
        dynamicImport = false;
      } else if (api === "node:module.createRequire") api = "js:require";
      else if (api?.endsWith(".bind")) api = api.slice(0, -".bind".length);
      else return undefined;
    } else return undefined;
  }
  return api;
}

function referenceStart(tokens: SourceToken[], end: number): number {
  let start = end;
  while (start > 0) {
    if (tokens[start - 1].text === "." && start > 1) start -= 2;
    else if ((tokens[start].text === "(" || tokens[start].text === "[") &&
      (tokens[start - 1].kind === "word" || tokens[start - 1].kind === "group") &&
      !/^(?:return|throw|new|await|if|while|for|switch|catch|function)$/.test(tokens[start - 1].text)) start--;
    else break;
  }
  return start;
}

function statementEnd(tokens: SourceToken[], start: number, source: string): number {
  let end = start;
  while (end < tokens.length) {
    if (tokens[end].text === ";") break;
    if (end > start && /[\r\n\u2028\u2029]/.test(source.slice(tokens[end - 1].end, tokens[end].start))) break;
    end++;
  }
  return end;
}

function importStatementEnd(tokens: SourceToken[], start: number, source: string, python: boolean): number {
  if (python) return statementEnd(tokens, start, source);
  if (tokens[start + 1]?.kind === "string") return start + 2;
  for (let end = start + 1; end < tokens.length && tokens[end].text !== ";"; end++) {
    if (tokens[end].text === "from" && tokens[end + 1]?.kind === "string") return end + 2;
  }
  return statementEnd(tokens, start, source);
}

function typeOnlyImport(tokens: SourceToken[], start: number): boolean {
  return tokens[start + 1]?.text === "type" && !["from", ","].includes(tokens[start + 2]?.text ?? "");
}

function bindPattern(pattern: SourceToken[], value: SourceToken[], bindings: Map<string, SourceToken[]>, python: boolean): void {
  if (pattern.length !== 1) return;
  const name = pattern[0];
  const api = apiReference(value, bindings, python);
  if (name.kind === "word") bindings.set(name.text, api ? [apiToken(api)] : boundValue(value, bindings));
  else if (name.text === "{") {
    for (const part of argumentParts(name.children ?? [])) {
      const field = part[0]?.value ?? part[0]?.text;
      const alias = part[1]?.text === ":" ? part[2] : part[0];
      if (!field || alias?.kind !== "word") continue;
      const member = apiMember(api, field, bindings);
      bindings.set(alias.text, member ? [apiToken(member)] : []);
    }
  }
}

function importedBindings(tokens: SourceToken[], start: number, source: string, bindings: Map<string, SourceToken[]>, python: boolean): number {
  const end = importStatementEnd(tokens, start, source, python);
  const statement = tokens.slice(start, end);
  if (python && tokens[start].text === "import") {
    for (const part of argumentParts(statement.slice(1))) {
      const module = moduleApi(part[0]?.text, true);
      const alias = part[1]?.text === "as" ? part[2]?.text : part[0]?.text;
      if (alias) bindings.set(alias, module ? [apiToken(module)] : []);
    }
    return end;
  }
  const from = statement.findIndex((token) => token.text === (python ? "import" : "from"));
  if (from < 0) return start;
  const module = moduleApi(python ? statement[1]?.text : literal(statement.slice(from + 1)), python);
  let names = python ? statement.slice(from + 1) : statement.slice(1, from);
  if (!python && typeOnlyImport(tokens, start)) {
    // Type-only imports neither execute the module nor shadow runtime globals.
    return end;
  }
  if (names[0]?.kind === "word" && !python) {
    bindings.set(names[0].text, module ? [apiToken(module)] : []);
    names = names.slice(names[1]?.text === "," ? 2 : 1);
  }
  if (names[0]?.text === "*" && names[1]?.text === "as" && names[2]) {
    bindings.set(names[2].text, module ? [apiToken(module)] : []);
  } else {
    if (names.length === 1 && (names[0].text === "{" || names[0].text === "(")) names = names[0].children ?? [];
    for (const part of argumentParts(names)) {
      const imported = part[0]?.text;
      const alias = part[1]?.text === "as" ? part[2]?.text : imported;
      if (!alias) continue;
      const member = imported === "default" ? module : apiMember(module, imported, bindings);
      bindings.set(alias, member ? [apiToken(member)] : []);
    }
  }
  return end;
}

function localDeclarations(tokens: SourceToken[], bindings: Map<string, SourceToken[]>): void {
  for (let index = 0; index < tokens.length; index++) {
    if (/^(?:const|let|var|function|class|def)$/.test(tokens[index].text)) {
      let pattern = tokens[index + 1];
      if (pattern?.text === "*") pattern = tokens[index + 2];
      if (pattern?.kind === "word") bindings.set(pattern.text, []);
      else if (pattern?.text === "{") bindPattern([pattern], [], bindings, false);
    }
  }
}

function parameterBindings(tokens: SourceToken[], bindings: Map<string, SourceToken[]>): void {
  for (const part of argumentParts(tokens)) {
    const parameter = part.find((token) => token.kind === "word" || token.text === "{");
    if (parameter) bindPattern([parameter], [], bindings, false);
  }
}

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
  if (tokens.length === 1 && tokens[0].kind === "string") return tokens[0].value;
  return bindings && apiReference(tokens, bindings, false) === "node:process.execPath" ? "bun" : undefined;
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

function functionScopes(tokens: SourceToken[]): Map<number, { end: number; parameters: SourceToken[]; body: SourceToken[]; loop?: boolean }> {
  const scopes = new Map<number, { end: number; parameters: SourceToken[]; body: SourceToken[]; loop?: boolean }>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.text === "(" && tokens[index + 1]?.text === "{" &&
      !/^(?:if|while|switch|with)$/.test(tokens[index - 1]?.text ?? "")) {
      scopes.set(index + 1, { end: index + 2, parameters: token.children ?? [],
        body: tokens[index + 1].children ?? [], loop: tokens[index - 1]?.text === "for" });
    }
    if (token.text === "=" && tokens[index + 1]?.text === ">" && tokens[index - 1]) {
      const argument = tokens[index - 1];
      const parameters = argument.text === "(" ? argument.children ?? [] : [argument];
      const start = index + 2;
      if (tokens[start]?.text === "{") {
        scopes.set(start, { end: start + 1, parameters, body: tokens[start].children ?? [] });
      } else {
        let end = start;
        while (end < tokens.length && tokens[end].text !== ";" && tokens[end].text !== ",") end++;
        scopes.set(start, { end, parameters, body: tokens.slice(start, end) });
      }
    }
  }
  return scopes;
}

function pythonSuiteEnd(tokens: SourceToken[], start: number, header: SourceToken, source: string): number {
  const lineStart = source.lastIndexOf("\n", header.start - 1) + 1;
  const headerIndent = source.slice(lineStart, header.start).length;
  const headerEnd = source.indexOf("\n", header.start);
  const sameLine = tokens[start]?.start < (headerEnd < 0 ? source.length : headerEnd);
  let end = start;
  while (end < tokens.length) {
    const position = tokens[end].start;
    if (sameLine) {
      if (headerEnd >= 0 && position > headerEnd) break;
    } else {
      const prefix = source.slice(source.lastIndexOf("\n", position - 1) + 1, position);
      if (/^[ \t]*$/.test(prefix) && prefix.length <= headerIndent) break;
    }
    end++;
  }
  return end;
}

function protectedContent(
  value: unknown,
  cwd: string,
  depth = 0,
  python = false,
  inherited?: SourceBindings,
): boolean {
  if (typeof value !== "string" || depth > MAX_EXECUTION_DEPTH) return false;
  const pending = [{ tokens: sourceTokens(value, python), bindings: new Map(inherited ?? globalBindings(python)), localPython: false }];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    const { tokens, bindings } = current;
    if (!python || current.localPython) localDeclarations(tokens, bindings);
    if (current.localPython) {
      for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].kind === "word" && !tokens[index].text.includes(".") && tokens[index + 1]?.text === "=") {
          bindings.set(tokens[index].text, []);
        }
        if (tokens[index].text === "import" || tokens[index].text === "from") {
          const imported = new Map<string, SourceToken[]>();
          importedBindings(tokens, index, value, imported, true);
          for (const name of imported.keys()) bindings.set(name, []);
        }
      }
    }
    // ESM imports are hoisted; require/Python imports bind at their statement.
    if (!python) {
      for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].text === "import" && tokens[index + 1]?.text !== "(") {
          importedBindings(tokens, index, value, bindings, false);
        }
      }
    }
    const scopes = python ? new Map() : functionScopes(tokens);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const next = tokens[index + 1];
      const scope = scopes.get(index);
      if (scope) {
        const child = new Map(bindings);
        if (scope.loop) localDeclarations(scope.parameters, child);
        else parameterBindings(scope.parameters, child);
        pending.push({ tokens: scope.body, bindings: child, localPython: false });
        index = scope.end - 1;
        continue;
      }
      if (python && (token.text === "def" || token.text === "class")) {
        if (next?.kind === "word") bindings.set(next.text, []);
        let colon = index + 2;
        while (colon < tokens.length && tokens[colon].text !== ":") colon++;
        if (colon < tokens.length) {
          const child = new Map(bindings);
          if (token.text === "def" && tokens[index + 2]?.text === "(") {
            parameterBindings(tokens[index + 2].children ?? [], child);
          }
          const end = pythonSuiteEnd(tokens, colon + 1, token, value);
          pending.push({ tokens: tokens.slice(colon + 1, end), bindings: child, localPython: token.text === "def" });
          index = end - 1;
          continue;
        }
      }
      if (python && (token.text === "import" || token.text === "from")) {
        index = Math.max(index, importedBindings(tokens, index, value, bindings, true) - 1);
        continue;
      }
      if (!python && (token.text === "import" || token.text === "export") && next?.text !== "(") {
        const end = importStatementEnd(tokens, index, value, false);
        const statement = tokens.slice(index, end);
        const from = statement.findIndex((part) => part.text === "from");
        if (token.text === "import" || from >= 0) {
          const module = literal(from >= 0 ? statement.slice(from + 1) : statement.slice(1), bindings);
          if (module && HOOK_MODULE.test(module) && !typeOnlyImport(tokens, index)) return true;
          index = Math.max(index, end - 1);
          continue;
        }
      }
      if (token.children) pending.push({ tokens: token.children, bindings: new Map(bindings), localPython: false });
      // Resolve simple literal variables when an execution sink consumes them,
      // not when they are stored as examples. Do not guess computed expressions.
      if ((token.kind === "word" || token.text === "{") && next?.text === "=" && tokens[index + 2]?.text !== ">") {
        let end = statementEnd(tokens, index + 2, value);
        const comma = tokens.slice(index + 2, end).findIndex((part) => part.text === ",");
        if (comma >= 0) end = index + 2 + comma;
        const previous = apiReference([token], bindings, python);
        if (token.kind === "word" && token.text.includes(".") && previous) {
          bindings.set(`@member:${previous}`, []);
          if (/^(?:globalThis|global)\./.test(token.text)) {
            const property = token.text.split(".")[1];
            bindings.set(`@global:${property}`, []);
            bindings.set(property, []);
          }
        }
        bindPattern([token], tokens.slice(index + 2, end), bindings, python);
      }
      if (next?.text === "(") {
        const expression = tokens.slice(referenceStart(tokens, index), index + 1);
        let api = apiReference(expression, bindings, python);
        let parts = argumentParts(next.children ?? []);
        const indirect = api?.endsWith(".call") || api?.endsWith(".apply") || api?.endsWith(".bind");
        if (indirect && api) {
          parts = api.endsWith(".apply") && parts[1]?.[0]?.text === "["
            ? argumentParts(parts[1][0].children ?? []) : parts.slice(1);
          api = api.replace(/\.(?:call|apply|bind)$/, "");
        }
        if (token.text === "import" && !python || api === "js:require" || api === "py:__import__") {
          const module = literal(parts[0] ?? [], bindings);
          if (module && HOOK_MODULE.test(module)) return true;
        }
        if (api && /^(?:js:(?:eval|Function)|py:(?:eval|exec)|node:vm\.(?:runInThisContext|runInNewContext|runInContext|Script|compileFunction))$/.test(api)) {
          const functionConstructor = api === "js:Function";
          const body = literal((functionConstructor ? parts[parts.length - 1] : parts[0]) ?? [], bindings);
          const context = new Map(api.startsWith("py:") || api === "js:eval" && !indirect && token.text === "eval"
            ? bindings : globalBindings(false));
          if (functionConstructor) {
            for (const parameter of parts.slice(0, -1)) {
              const text = literal(parameter, bindings);
              if (text) parameterBindings(sourceTokens(text, false), context);
            }
          }
          if (body !== undefined && protectedContent(body, cwd, depth + 1, api.startsWith("py:"), context)) return true;
        }
        if (api && /^(?:node:child_process\.(?:exec|execSync)|py:os\.(?:system|popen))$/.test(api)) {
          const command = literal(parts[0] ?? [], bindings);
          if (command !== undefined && protectedShell(command, cwd, depth + 1)) return true;
        }
        if (api && /^(?:bun\.(?:spawn|spawnSync)|deno\.(?:run|Command)|node:child_process\.(?:spawn|spawnSync|execFile|execFileSync)|py:subprocess\.(?:run|call|Popen|check_call|check_output))$/.test(api)) {
          const argv = arrayLiteral(parts[0] ?? [], bindings) ?? arrayLiteral(objectField(parts[0] ?? [], "cmd", bindings), bindings);
          if (argv?.[0] !== undefined && protectedInvocation(argv[0], argv.slice(1), cwd, depth + 1)) return true;
          const executable = literal(parts[0] ?? [], bindings);
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
    shellWriteTargets(visible, cwd).some((path) => protectedRuntimePath(path, cwd) || protectedInstalledPath(path, cwd))) return true;
  for (const { name, args, executable } of shellCommandInvocationDetails(visible)) {
    if (name === "mkdir" && args.some((path) => protectedRuntimePath(path, cwd))) return true;
    if (["rm", "mv", "rmdir"].includes(name) &&
      shellWriteTargets([name, ...args].map(shellQuote).join(" "), cwd)
        .some((path) => protectedInstalledPath(path, cwd, true))) return true;
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
  "A tool call cannot invoke a hook, choose a session, set a bypass, edit those records, or replace installed enforcement files. " +
  "Use the engine commands for workflow work. For intentional installed-file maintenance, use the official updater or an external terminal outside the running agent workflow.";

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
  const absolute = resolve(path);
  let existing = absolute;
  const suffix: string[] = [];
  // Resolve an existing parent too, so creating/replacing a file through a
  // directory symlink has the same target classification as its real path.
  while (true) {
    try {
      return resolve(realpathSync(existing), ...suffix);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      suffix.unshift(basename(existing));
      existing = parent;
    }
  }
}

function authoredRuntimeRoot(root: string): boolean {
  return basename(root) === "core" && existsSync(resolve(root, "../scripts/package.ts"));
}

function installedRoots(cwd: string): string[] {
  return harnessInstallRoots(cwd).filter((root) => !authoredRuntimeRoot(root));
}

function installedRelativeProtected(path: string, root: string, harnessName = basename(root)): boolean {
  const rel = relative(root, path).replaceAll("\\", "/");
  if (!pathWithin(path, root)) return false;
  if (rel === "" || rel === "hooks" || rel.startsWith("hooks/") || rel === "tools") return true;
  if (/^tools\/aidlc(?:-[a-z0-9-]+)?(?:\.ts|\.exe)?$/.test(rel)) return true;
  if (/^bin\/aidlc(?:\.exe)?$/.test(rel) || rel === "bin") return true;
  if (rel === "hooks.json") return true;
  if (harnessName === ".claude" && rel === "settings.json") return true;
  return harnessName === ".kiro" && (rel === "agents" || /^agents\/aidlc(?:-[a-z-]+)?\.json$/.test(rel));
}

function protectedInstalledPath(path: unknown, cwd: string, ancestors = false): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  const absolute = resolve(cwd, path);
  const canonical = canonicalExistingPath(absolute);
  for (const root of installedRoots(cwd)) {
    const realRoot = canonicalExistingPath(root);
    if (ancestors && (pathWithin(root, absolute) || pathWithin(realRoot, canonical)) ||
      installedRelativeProtected(absolute, root) || installedRelativeProtected(canonical, realRoot, basename(root))) return true;
  }
  // These native hook entrypoints live beside the shared .aidlc engine.
  const entrypoints = [
    resolve(cwd, ".opencode/plugin/aidlc-opencode-adapter.ts"),
    resolve(cwd, ".github/hooks/aidlc.json"),
    ...(isCompiledModuleUrl(import.meta.url) ? [process.execPath] : []),
  ];
  return entrypoints.some((entry) => absolute === entry || canonical === canonicalExistingPath(entry) ||
    ancestors && (pathWithin(entry, absolute) || pathWithin(canonicalExistingPath(entry), canonical)));
}

function trustedInstalledScript(path: string, cwd: string): boolean {
  const canonical = canonicalExistingPath(path);
  if (isAuthoredDevelopmentPath(path, cwd)) {
    const rel = relative(resolve(cwd, "core/tools"), resolve(cwd, path)).replaceAll("\\", "/");
    if (TRUSTED_RUNTIME_ENTRYPOINTS.has(rel)) return true;
  }
  for (const root of installedRoots(cwd)) {
    const rel = relative(canonicalExistingPath(root), canonical).replaceAll("\\", "/");
    if (rel.startsWith("tools/") && TRUSTED_RUNTIME_ENTRYPOINTS.has(rel.slice("tools/".length))) return true;
  }
  return false;
}

function isAuthoredDevelopmentPath(path: string, cwd: string): boolean {
  if (!existsSync(resolve(cwd, "scripts/package.ts"))) return false;
  return ["core", "harness", "tests", "docs"].some((tree) => pathWithin(resolve(cwd, path), resolve(cwd, tree)));
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
    if (trustedInstalledScript(absolute, cwd)) return false;
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
  // The authored repository must be able to develop and document its hooks.
  return contentTargets.some((path) => !isAuthoredDevelopmentPath(path, cwd));
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
  if (writeTargets(toolName, toolInput, cwd).some((path) =>
    protectedRuntimePath(path, cwd) || protectedInstalledPath(path, cwd))) {
    return "runtime";
  }
  if (Array.isArray(toolInput?.edits) && toolInput.edits.some((edit: unknown) =>
    typeof edit === "object" && edit !== null &&
    writeTargets(toolName, edit as Record<string, unknown>, cwd)
      .some((path) => protectedRuntimePath(path, cwd) || protectedInstalledPath(path, cwd))
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
