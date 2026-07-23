// PreToolUse hook: deterministic enforcement of the per-unit reviewer
// read-scope bound (stage-protocol 12a).
//
// The prose bound says a reviewer dispatched for one unit must not read other
// units' construction/<other-unit>/ content through any tool - not by opening
// files, and not via grep, glob, or shell patterns that span sibling unit
// paths. Field transcripts showed prose losing that contest: a diligent
// reviewer swept siblings through recursive greps with cross-unit globs, and
// per-unit review cost grew superlinearly with unit count. Per the framework
// layering (determinism belongs in tools and hooks, knowledge in agents,
// judgement with humans), this hook is the bound's deterministic twin.
//
// This is one of the framework's flow-altering hooks. Its contract is the
// harness-native PreToolUse block: print a reason
// to stderr and exit 2 to refuse the tool call, exit 0 to allow. The refusal
// is scoped tightly - one agent, one dispatch window, sibling-unit targets
// only - and the reason text redirects the reviewer to the contract paths it
// was already passed, so a blocked call is a recoverable nudge, not a halt.
//
// How the hook knows a review is in flight: the conductor writes a dispatch
// record (reviewerDispatchPath, `<record>/.aidlc-reviewer-dispatch.json`) at
// 12a step 1 before invoking a per-unit reviewer, and deletes it at step 3
// when the verdict is read. The record carries {reviewer, stage, unit,
// exempt[]} - the facts no harness payload delivers. Identity comes from the
// harness: Claude Code and Codex put the active subagent's name in the
// payload's agent_type (absent on main-session calls; probe-verified on
// both), and the Kiro CLI adapter asserts scoped registration instead (it
// wires this hook inside the reviewer agents' own JSON configs, so every
// call arriving through that registration IS the reviewer's). Kiro IDE
// ships no registration: its hook payloads carry no tool inputs, so a
// pre-tool matcher has nothing to inspect there.
//
// Fail-open everywhere: no record, a stale record (mtime beyond
// REVIEWER_DISPATCH_TTL_MS - janitored like the compose marker), malformed
// stdin or record JSON, an unknown tool, a non-reviewer agent, or any throw
// allows the call. The deterministic off-switch
// AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1 disables enforcement entirely (the
// documented escape hatch for false-positive storms, mirroring the
// human-presence guard's off-switch). Every genuine block emits a
// REVIEWER_SCOPE_BLOCKED audit event so the run's record shows when the
// bound bit; audit failures never change the decision.

import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  auditFilePath,
  type ClaudeCodeHookInput,
  errorMessage,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  recordHookDrop,
  releaseAuditLock,
  resolveProjectDirFromHook,
  REVIEWER_DISPATCH_TTL_MS,
  reviewerDispatchPath,
  toPosix,
} from "../tools/aidlc-lib.ts";

const HOOK_NAME = "reviewer-scope";

// --- The pure matcher --------------------------------------------------------
//
// Everything below up to the main section is side-effect free and exported so
// the decision table is unit-testable without a live session. The hook body
// only wires stdin, the dispatch record, and the exit code around it.

/** The conductor-written dispatch record (12a step 1). */
export interface ReviewerDispatch {
  /** Agent name of the dispatched reviewer, e.g. aidlc-architecture-reviewer-agent. */
  reviewer: string;
  /** Stage slug the review belongs to, e.g. nfr-requirements. */
  stage: string;
  /** The unit under review - the one construction/<unit>/ subtree in scope. */
  unit: string;
  /** Resolved paths the reviewer may touch beyond the current unit: the
   *  directive.consumes contracts, the stage file, the Q&A file, and (when the
   *  current unit's design explicitly names an integration point) that one
   *  owning file. Only entries containing a construction/ component matter to
   *  the matcher - everything outside construction/ is never blocked. */
  exempt: string[];
}

/** The matcher's verdict. `target` names the offending path or token. */
export interface ScopeVerdict {
  block: boolean;
  target?: string;
}

/** Optional path context for the pure matcher. The live hook supplies both:
 *  recordRoot is the directory beside `.aidlc-reviewer-dispatch.json`, and cwd
 *  is the harness tool cwd. Tests can omit it to exercise the lexical fallback. */
export interface ScopeContext {
  recordRoot?: string;
  cwd?: string;
}

// Glob metacharacters. A sibling segment carrying any of these spans units
// (a `construction/*/` glob is a sibling read, not a search).
const WILDCARD_RE = /[*?[\]{}]/;

// Path-shaped tools contribute their path fields; Bash contributes the whole
// command string; Glob/Grep contribute their pattern/glob fields (which are
// path-shaped) plus their search-root path. Grep's `pattern` field is the
// CONTENT regex, deliberately not scanned: matching file content is not a
// file access, and scanning it would block a legitimate grep of the current
// unit for text that merely mentions a sibling path.
function candidateStrings(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): Array<{ text: string; kind: "path" | "command" | "glob" | "search-root" }> {
  const ti = toolInput ?? {};
  const out: Array<{ text: string; kind: "path" | "command" | "glob" | "search-root" }> = [];
  const push = (v: unknown, kind: "path" | "command" | "glob" | "search-root") => {
    if (typeof v === "string" && v.length > 0) out.push({ text: v, kind });
  };
  switch (toolName) {
    case "Bash":
      push(ti.command, "command");
      break;
    case "Read":
    case "NotebookRead":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      push(ti.file_path, "path");
      push(ti.notebook_path, "path");
      push(ti.path, "path");
      if (Array.isArray(ti.paths)) for (const p of ti.paths) push(p, "path");
      break;
    case "LS":
      push(ti.path, "search-root");
      break;
    case "Glob":
      push(ti.pattern, "glob");
      push(ti.path, "search-root");
      break;
    case "Grep":
      push(ti.glob, "glob");
      push(ti.path, "search-root");
      break;
    default:
      break;
  }
  return out;
}

// Split a path into components, dropping empty and "." segments and
// COLLAPSING ".." against its parent. Without the collapse,
// construction/U03/../U01/design.md would be judged on U03 (the first
// segment after construction/) and allowed even though the filesystem
// resolves it into sibling U01. A leading ".." with no parent to consume is
// kept as-is (it climbs above the visible string; the sweep/wildcard rules
// in judgeOccurrence apply to whatever remains).
function normalizedComps(p: string): string[] {
  const out: string[] = [];
  for (const c of toPosix(p).split("/")) {
    if (c.length === 0 || c === ".") continue;
    if (c === ".." && out.length > 0 && out[out.length - 1] !== "..") {
      out.pop();
      continue;
    }
    out.push(c);
  }
  return out;
}

function fold(s: string): string {
  return s.toLowerCase();
}

function normalizedCompsFolded(p: string): string[] {
  return normalizedComps(p).map(fold);
}

function globComponentMatchesConstruction(component: string): boolean {
  const c = fold(component);
  if (c === "construction") return true;
  if (!WILDCARD_RE.test(c)) return false;
  if (c.replace(/[*?[\]{}!,]/g, "").length === 0) return false;
  let re = "^";
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re).test("construction");
}

function constructionIndex(comps: string[], allowGlob = false): number {
  return comps.findIndex((c) =>
    fold(c) === "construction" || (allowGlob && globComponentMatchesConstruction(c))
  );
}

function canonicalSuffix(comps: string[]): string {
  return comps.map(fold).join("/");
}

// The construction/-suffix of an exempt entry, component-normalized, or null
// when the entry never enters construction/ (those entries are irrelevant to
// the matcher - non-construction paths are always allowed).
function exemptSuffixOf(entry: string): string | null {
  const comps = normalizedComps(entry);
  const i = constructionIndex(comps);
  if (i === -1) return null;
  return canonicalSuffix(comps.slice(i));
}

// Judge one construction/ occurrence: the first path segment after the
// construction component decides. Current unit -> allow; wildcard or missing
// (a sweep root) -> block; a concrete sibling -> allow only on an exact
// exempt-suffix match (the single owning file of a named integration point),
// else block. Exactness is deliberate: browsing an exempt file's parent
// directory is still a sibling browse.
function judgeOccurrence(
  suffixComps: string[],
  unit: string,
  exemptSuffixes: ReadonlySet<string>,
): boolean {
  const unitFolded = fold(unit);
  const seg = suffixComps[1];
  if (seg === undefined || seg.length === 0) return true; // bare construction/ sweep root
  if (WILDCARD_RE.test(seg)) return true; // a pattern spanning siblings
  if (fold(seg) === unitFolded) return false; // the dispatched unit
  return !exemptSuffixes.has(canonicalSuffix(suffixComps));
}

interface PreparedScope {
  unitFolded: string;
  exemptSuffixes: ReadonlySet<string>;
  exemptPaths: ReadonlySet<string>;
  recordRoot?: string;
  constructionRoot?: string;
  unitRoot?: string;
  bases: string[];
}

function normalizeForCompare(p: string): string {
  const posix = toPosix(p);
  const absolute = posix.startsWith("/");
  const body = normalizedCompsFolded(posix).join("/");
  return absolute ? `/${body}` : body;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.length > 0)));
}

function resolvePathStrings(text: string, bases: readonly string[]): string[] {
  if (isAbsolute(text)) return [resolve(text)];
  return bases.map((b) => resolve(b, text));
}

function normalizeResolved(text: string, bases: readonly string[]): string[] {
  return uniqueStrings(resolvePathStrings(text, bases).map(normalizeForCompare));
}

function containsPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isExactExempt(path: string, suffixComps: string[], scope: PreparedScope): boolean {
  return scope.exemptPaths.has(path) || scope.exemptSuffixes.has(canonicalSuffix(suffixComps));
}

function prepareScope(
  dispatch: Pick<ReviewerDispatch, "unit" | "exempt">,
  context: ScopeContext | undefined,
): PreparedScope {
  const exemptSuffixes = new Set<string>();
  const exemptPaths = new Set<string>();

  const recordRoot = context?.recordRoot ? resolve(context.recordRoot) : undefined;
  const constructionRoot = recordRoot ? resolve(recordRoot, "construction") : undefined;
  const unitRoot = constructionRoot ? resolve(constructionRoot, dispatch.unit) : undefined;
  const cwd = context?.cwd ? resolve(context.cwd) : undefined;
  const bases = uniqueStrings([cwd ?? "", recordRoot ?? "", unitRoot ?? ""]);

  for (const e of dispatch.exempt) {
    const s = exemptSuffixOf(e);
    if (s !== null) exemptSuffixes.add(s);
    for (const p of normalizeResolved(e, bases)) exemptPaths.add(p);
  }

  return {
    unitFolded: fold(dispatch.unit),
    exemptSuffixes,
    exemptPaths,
    recordRoot: recordRoot ? normalizeForCompare(recordRoot) : undefined,
    constructionRoot: constructionRoot ? normalizeForCompare(constructionRoot) : undefined,
    unitRoot: unitRoot ? normalizeForCompare(unitRoot) : undefined,
    bases,
  };
}

function verdict(target: string): ScopeVerdict {
  return { block: true, target };
}

function judgeLexicalPath(text: string, scope: PreparedScope): ScopeVerdict | null {
  const comps = normalizedComps(text);
  for (let i = 0; i < comps.length; i++) {
    if (constructionIndex([comps[i]], true) !== 0) continue;
    if (judgeOccurrence(comps.slice(i), scope.unitFolded, scope.exemptSuffixes)) {
      return verdict(text);
    }
  }
  return null;
}

function judgeResolvedPath(
  text: string,
  mode: "target" | "search-root",
  scope: PreparedScope,
  bases: readonly string[] = scope.bases,
): ScopeVerdict | null {
  if (scope.constructionRoot === undefined) return null;

  for (const path of normalizeResolved(text, bases)) {
    if (containsPath(scope.constructionRoot, path)) {
      const rest = path === scope.constructionRoot
        ? []
        : path.slice(scope.constructionRoot.length + 1).split("/");
      const suffixComps = ["construction", ...rest];
      if (isExactExempt(path, suffixComps, scope)) continue;
      if (judgeOccurrence(suffixComps, scope.unitFolded, scope.exemptSuffixes)) {
        return verdict(text);
      }
    }

    // Recursive/search roots above construction/ sweep every sibling unit even
    // when the command never spells `construction` (for example `rg X .`).
    if (mode === "search-root" && containsPath(path, scope.constructionRoot)) {
      return verdict(text);
    }
  }
  return null;
}

function judgePathAccess(
  text: string,
  mode: "target" | "search-root",
  scope: PreparedScope,
  bases: readonly string[] = scope.bases,
): ScopeVerdict | null {
  return judgeLexicalPath(text, scope) ?? judgeResolvedPath(text, mode, scope, bases);
}

function patternLimitsToCurrentUnit(text: string, scope: PreparedScope): boolean {
  const comps = normalizedComps(text);
  let sawConstruction = false;
  for (let i = 0; i < comps.length; i++) {
    if (constructionIndex([comps[i]], true) !== 0) continue;
    sawConstruction = true;
    const suffix = comps.slice(i);
    const seg = suffix[1];
    if (seg === undefined || WILDCARD_RE.test(seg)) return false;
    if (fold(seg) !== scope.unitFolded && !scope.exemptSuffixes.has(canonicalSuffix(suffix))) {
      return false;
    }
  }
  return sawConstruction;
}

interface ShellWord {
  text: string;
  quoted: boolean;
}

type ShellToken = ShellWord | { sep: true };

function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let text = "";
  let quoted = false;
  const pushWord = () => {
    if (text.length > 0) tokens.push({ text, quoted });
    text = "";
    quoted = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoted = true;
      const quote = ch;
      i++;
      while (i < command.length && command[i] !== quote) {
        if (quote === '"' && command[i] === "\\" && i + 1 < command.length) i++;
        text += command[i];
        i++;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < command.length) {
        i++;
        text += command[i];
      }
      continue;
    }
    if (";|&()".includes(ch)) {
      pushWord();
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      tokens.push({ sep: true });
      continue;
    }
    text += ch;
  }
  pushWord();
  return tokens;
}

function shellSegments(command: string): ShellWord[][] {
  const segments: ShellWord[][] = [];
  let current: ShellWord[] = [];
  for (const token of shellTokens(command)) {
    if ("sep" in token) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function commandBasename(command: string): string {
  const comps = normalizedComps(command);
  return fold(comps[comps.length - 1] ?? command);
}

function isOption(word: string): boolean {
  return word.length > 1 && word.startsWith("-");
}

function firstOperand(words: ShellWord[]): number {
  for (let i = 1; i < words.length; i++) {
    if (!isOption(words[i].text)) return i;
  }
  return -1;
}

function judgeGrepLike(
  words: ShellWord[],
  scope: PreparedScope,
  bases: readonly string[],
): ScopeVerdict | null {
  let patternSeen = false;
  let rootSeen = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i].text;
    if (w === "-e" || w === "--regexp") {
      i++; // content pattern
      patternSeen = true;
      continue;
    }
    if (w === "-f" || w === "--file") {
      i++; // pattern file, not a searched construction artifact
      continue;
    }
    if (isOption(w)) continue;
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    rootSeen = true;
    const v = judgePathAccess(w, "search-root", scope, bases);
    if (v !== null) return v;
  }
  if (!rootSeen) return judgePathAccess(".", "search-root", scope, bases);
  return null;
}

function judgeRipgrep(
  words: ShellWord[],
  scope: PreparedScope,
  bases: readonly string[],
): ScopeVerdict | null {
  let patternSeen = false;
  let rootSeen = false;
  let constrainedToCurrent = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i].text;
    if (w === "-g" || w === "--glob") {
      const glob = words[++i]?.text ?? "";
      if (glob.length > 0) {
        const v = judgePathAccess(glob, "target", scope, bases);
        if (v !== null) return v;
        constrainedToCurrent ||= patternLimitsToCurrentUnit(glob, scope);
      }
      continue;
    }
    if (w.startsWith("--glob=")) {
      const glob = w.slice("--glob=".length);
      const v = judgePathAccess(glob, "target", scope, bases);
      if (v !== null) return v;
      constrainedToCurrent ||= patternLimitsToCurrentUnit(glob, scope);
      continue;
    }
    if (isOption(w)) continue;
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    rootSeen = true;
    const v = judgePathAccess(w, "search-root", scope, bases);
    if (v !== null) return v;
  }
  if (!rootSeen && !constrainedToCurrent) return judgePathAccess(".", "search-root", scope, bases);
  return null;
}

function judgeFind(
  words: ShellWord[],
  scope: PreparedScope,
  bases: readonly string[],
): ScopeVerdict | null {
  let rootSeen = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i].text;
    if (isOption(w) || w === "!" || w === "(" || w === ")") break;
    rootSeen = true;
    const v = judgePathAccess(w, "search-root", scope, bases);
    if (v !== null) return v;
  }
  if (!rootSeen) return judgePathAccess(".", "search-root", scope, bases);
  return null;
}

function isPathish(word: string): boolean {
  return (
    word === "." ||
    word === ".." ||
    word.includes("/") ||
    WILDCARD_RE.test(word) ||
    fold(word) === "construction" ||
    globComponentMatchesConstruction(word)
  );
}

function judgeSimpleFileCommand(
  words: ShellWord[],
  mode: "target" | "search-root",
  scope: PreparedScope,
  bases: readonly string[],
): ScopeVerdict | null {
  let sawOperand = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i].text;
    if (isOption(w)) continue;
    sawOperand = true;
    const v = judgePathAccess(w, mode, scope, bases);
    if (v !== null) return v;
  }
  if (!sawOperand && mode === "search-root") return judgePathAccess(".", "search-root", scope, bases);
  return null;
}

function judgeGenericCommand(
  words: ShellWord[],
  scope: PreparedScope,
  bases: readonly string[],
): ScopeVerdict | null {
  for (let i = 1; i < words.length; i++) {
    const w = words[i].text;
    if (isOption(w) || !isPathish(w)) continue;
    const v = judgePathAccess(w, "target", scope, bases);
    if (v !== null) return v;
  }
  return null;
}

function judgeCommandText(text: string, scope: PreparedScope): ScopeVerdict | null {
  let bases = scope.bases;
  for (const segment of shellSegments(text)) {
    if (segment.length === 0) continue;
    const cmd = commandBasename(segment[0].text);
    if (cmd === "cd") {
      const idx = firstOperand(segment);
      if (idx === -1 || segment[idx].text === "-") continue;
      const next = segment[idx].text;
      const v = judgePathAccess(next, "search-root", scope, bases);
      if (v !== null) return v;
      bases = uniqueStrings(resolvePathStrings(next, bases));
      continue;
    }

    const v =
      cmd === "grep" || cmd === "egrep" || cmd === "fgrep"
        ? judgeGrepLike(segment, scope, bases)
        : cmd === "rg" || cmd === "ripgrep"
          ? judgeRipgrep(segment, scope, bases)
          : cmd === "find"
            ? judgeFind(segment, scope, bases)
            : cmd === "ls"
              ? judgeSimpleFileCommand(segment, "search-root", scope, bases)
              : cmd === "cat" || cmd === "less" || cmd === "more" || cmd === "head" || cmd === "tail"
                ? judgeSimpleFileCommand(segment, "target", scope, bases)
                : judgeGenericCommand(segment, scope, bases);
    if (v !== null) return v;
  }
  return null;
}

/**
 * The reviewer read-scope decision. Pure: no I/O, no environment.
 * Returns block=true with the offending target when the tool call reaches
 * into a sibling unit's construction/ subtree (or spans siblings via a
 * wildcard) and the target is not on the exempt list.
 */
export function evaluateReviewerScope(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  dispatch: Pick<ReviewerDispatch, "unit" | "exempt">,
  context?: ScopeContext,
): ScopeVerdict {
  const scope = prepareScope(dispatch, context);
  let globConstrainedToCurrent = false;
  let sawGlob = false;
  let sawSearchRoot = false;

  for (const { text, kind } of candidateStrings(toolName, toolInput)) {
    if (kind === "path") {
      const v = judgePathAccess(text, "target", scope);
      if (v !== null) return v;
    } else if (kind === "search-root") {
      sawSearchRoot = true;
      const v = judgePathAccess(text, "search-root", scope);
      if (v !== null) return v;
    } else if (kind === "glob") {
      sawGlob = true;
      const v = judgePathAccess(text, "target", scope);
      if (v !== null) return v;
      globConstrainedToCurrent ||= patternLimitsToCurrentUnit(text, scope);
    } else {
      const v = judgeCommandText(text, scope);
      if (v !== null) return v;
    }
  }

  // Pathless Grep recurses from cwd. Pathless Glob does too unless the pattern
  // itself explicitly constrains the search to the current unit/exempt file.
  if (toolName === "Grep" && !sawSearchRoot && !globConstrainedToCurrent) {
    const v = judgePathAccess(".", "search-root", scope);
    if (v !== null) return v;
  }
  if (toolName === "Glob" && !sawSearchRoot && sawGlob && !globConstrainedToCurrent) {
    const v = judgePathAccess(".", "search-root", scope);
    if (v !== null) return v;
  }
  return { block: false };
}

/** Parse + validate a dispatch record's JSON. Null on any shape miss. */
export function parseDispatchRecord(raw: string): ReviewerDispatch | null {
  try {
    const o: unknown = JSON.parse(raw);
    if (o === null || typeof o !== "object") return null;
    const r = o as Record<string, unknown>;
    if (typeof r.reviewer !== "string" || r.reviewer.length === 0) return null;
    if (typeof r.unit !== "string" || r.unit.length === 0) return null;
    if (typeof r.stage !== "string") return null;
    if (!Array.isArray(r.exempt) || !r.exempt.every((e) => typeof e === "string")) return null;
    return { reviewer: r.reviewer, stage: r.stage, unit: r.unit, exempt: r.exempt as string[] };
  } catch {
    return null;
  }
}

// The block reason handed back to the reviewer through the harness's
// PreToolUse error channel. Self-explaining and redirecting: it names the
// scope, the offending target, and the sanctioned alternative, so the
// reviewer self-corrects without retrying the same call.
export function blockReason(target: string, dispatch: ReviewerDispatch): string {
  return (
    `reviewer read-scope: "${target}" reaches into sibling units' construction/ paths. ` +
    `This review is scoped to unit ${dispatch.unit} plus the contract paths you were passed ` +
    `(the stage file, the Q&A file, and the resolved consumes paths - the shared inception ` +
    `contracts). Verify cross-unit claims against those passed contracts instead of reading ` +
    `sibling units. If this unit's design explicitly names an integration point in a sibling ` +
    `file, report that in your findings rather than opening it; only a file the conductor ` +
    `put on the dispatch exempt list is readable here. (If you meant to access the CURRENT ` +
    `unit, write the literal unit name - shell variables in the path cannot be verified and ` +
    `are refused; search commands must be scoped to the current unit path.)`
  );
}

// The two shipped review-only agents. Used ONLY for the advisory
// missing-record drop below (when one of these is active with no dispatch
// record and touches construction/ paths, the conductor likely forgot the 12a
// step-1 write); the dispatch record's reviewer field is the authoritative
// identity during enforcement.
const REVIEW_AGENT_RE = /^aidlc-(architecture-reviewer|product-lead)-agent$/;

// --- Main ---------------------------------------------------------------------

if (import.meta.main) {
  // Deterministic off-switch: enforcement disabled entirely.
  if (process.env.AIDLC_DISABLE_REVIEWER_SCOPE_HOOK === "1") process.exit(0);

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, `${HOOK_NAME}.last`), isoTimestamp(), "utf-8");
  } catch {
    // Heartbeat failure is non-fatal - never let it affect the decision.
  }

  // A TTY means no harness JSON is coming (test / debug contexts) - allow.
  if (process.stdin.isTTY) process.exit(0);

  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(await Bun.stdin.text());
    if (!isClaudeCodeHookInput(raw)) process.exit(0);
    parsed = raw;
  } catch {
    process.exit(0); // malformed stdin - fail open
  }

  const toolName = parsed.tool_name ?? "";
  const toolInput = parsed.tool_input;
  if (!["Read", "NotebookRead", "Edit", "MultiEdit", "Write", "NotebookEdit", "LS", "Glob", "Grep", "Bash"].includes(toolName)) {
    process.exit(0);
  }

  const recordPath = reviewerDispatchPath(projectDir);
  if (!existsSync(recordPath)) {
    // No review in flight. One advisory: a review-only agent touching
    // construction/ paths with no dispatch record suggests the conductor
    // skipped the 12a step-1 write - surfaced via the doctor's drop counters,
    // never a block (the record is the only source of unit + exempt, so there
    // is nothing sound to enforce without it). RATE-BOUNDED: a chatty reviewer
    // under a conductor that never writes the record would otherwise append
    // one drop line per tool call; a marker file in the health dir dedupes the
    // advisory to one line per 10 minutes.
    try {
      const agent = parsed.agent_type ?? "";
      if (REVIEW_AGENT_RE.test(agent)) {
        const touchesConstruction = candidateStrings(toolName, toolInput).some((c) =>
          toPosix(c.text).includes("construction/"),
        );
        if (touchesConstruction) {
          const marker = join(hooksHealthDir(projectDir), `${HOOK_NAME}.missing-record.last`);
          const fresh = existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 10 * 60 * 1000;
          if (!fresh) {
            writeFileSync(marker, isoTimestamp(), "utf-8");
            recordHookDrop(
              projectDir,
              HOOK_NAME,
              `${agent} touched construction/ paths with no reviewer dispatch record; enforcement skipped (write the 12a step-1 dispatch record before invoking a per-unit reviewer)`,
            );
          }
        }
      }
    } catch {
      // Advisory only.
    }
    process.exit(0);
  }

  let dispatch: ReviewerDispatch | null = null;
  try {
    const ageMs = Date.now() - statSync(recordPath).mtimeMs;
    if (ageMs > REVIEWER_DISPATCH_TTL_MS) {
      // Orphaned record (a session crashed between dispatch and verdict):
      // ignore it and best-effort janitor it so a stale window cannot keep
      // refusing sibling access indefinitely. Mirrors the compose marker.
      try {
        unlinkSync(recordPath);
      } catch {
        // Unlink failure is non-fatal - the staleness check already refused it.
      }
      recordHookDrop(
        projectDir,
        HOOK_NAME,
        "ignoring an orphaned reviewer dispatch record (older than the freshness window); cleaned it up",
      );
      process.exit(0);
    }
    dispatch = parseDispatchRecord(await Bun.file(recordPath).text());
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    process.exit(0); // unreadable record - fail open
  }
  if (dispatch === null) {
    recordHookDrop(projectDir, HOOK_NAME, "reviewer dispatch record is malformed; enforcement skipped");
    process.exit(0);
  }

  // Identity: enforce only for the dispatched reviewer. Claude Code and Codex
  // deliver the active subagent's name as agent_type (absent on main-session
  // calls). The Kiro CLI adapter instead asserts scoped_registration - it
  // registers this hook inside the reviewer agents' own JSON configs, so
  // every call arriving through that registration is the reviewer's. (Kiro
  // IDE ships no registration at all: its hook payloads carry no tool inputs,
  // so there is nothing to match on there.) Anything else - the conductor's
  // own calls, other subagents - passes through untouched.
  const agentType = parsed.agent_type ?? "";
  const scopedRegistration = parsed.scoped_registration === true;
  const isDispatchedReviewer =
    agentType.length > 0 ? agentType === dispatch.reviewer : scopedRegistration;
  if (!isDispatchedReviewer) process.exit(0);

  let verdict: ScopeVerdict;
  try {
    const cwdField = (parsed as { cwd?: unknown }).cwd;
    verdict = evaluateReviewerScope(toolName, toolInput, dispatch, {
      recordRoot: dirname(recordPath),
      cwd: typeof cwdField === "string" && cwdField.length > 0 ? cwdField : projectDir,
    });
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    process.exit(0); // matcher failure - fail open
  }
  if (!verdict.block) process.exit(0);

  // Audit the refusal so the run's record shows when the bound bit.
  // Best-effort: an audit failure never changes the block decision. The lock
  // acquisition is TIME-BOUNDED well below the standard 5s budget (5 x 50ms):
  // the block decision is already made, and a lock-starved Bolt fan-out must
  // not stretch a fast refuse into a laggy one - a dropped advisory row is
  // preferable to a slow block.
  try {
    if (existsSync(auditFilePath(projectDir))) {
      if (acquireAuditLock(projectDir, 5, 50)) {
        try {
          appendAuditEntryUnlocked(
            "REVIEWER_SCOPE_BLOCKED",
            {
              Tool: toolName,
              Target: verdict.target ?? "",
              Stage: dispatch.stage,
              Unit: dispatch.unit,
            },
            projectDir,
          );
        } finally {
          releaseAuditLock(projectDir);
        }
      } else {
        recordHookDrop(projectDir, HOOK_NAME, "audit lock contended; REVIEWER_SCOPE_BLOCKED row dropped (block still enforced)");
      }
    }
  } catch {
    // Advisory emission only.
  }

  process.stderr.write(`${blockReason(verdict.target ?? "", dispatch)}\n`);
  process.exit(2); // harness PreToolUse reject contract: exit 2 + stderr blocks
}
