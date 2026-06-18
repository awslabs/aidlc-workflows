import { createHash } from "node:crypto";
import { accessSync, appendFileSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Type-only import for the lazy-loaded aidlc-graph.ts dependency. The
// runtime require() below avoids the circular import (aidlc-graph.ts
// imports loadScopeMapping/loadStageGraph from this file). Type-only
// imports are erased at runtime so they don't create the cycle.
import type { subgraphForScope as SubgraphForScope } from "./aidlc-graph.ts";

// --- Types ---

export interface StageEntry {
  slug: string;
  number: string;
  name: string;
  phase: string;
  execution: "ALWAYS" | "CONDITIONAL";
  lead_agent: string;
  support_agents: string[];
  mode: string;
  // Optional fields populated by aidlc-graph compile from YAML sources.
  // Existing callers read only the 8 required fields above; optional
  // additions are source-compatible. Library code that needs these
  // fields uses the GraphStage type in aidlc-graph.ts (required there).
  condition?: string;
  produces?: string[];
  consumes?: Array<{ artifact: string; required: boolean; conditional_on?: string }>;
  requires_stage?: string[];
  scopes?: string[];
  inputs?: string;
  outputs?: string;
  for_each?: string;
}

export interface ScopeDefinition {
  depth: string;
  stages: Record<string, "EXECUTE" | "SKIP">;
  // Optional fields from scope-mapping.json. `testStrategy` is on
  // workshop; `keywords` drives NL scope inference (see
  // aidlc-utility.ts inferScopeFromText); `description` is a one-line
  // scope summary rendered into HELP_TEXT.
  testStrategy?: string;
  keywords?: string[];
  description?: string;
}

export type CheckboxState = "pending" | "in-progress" | "awaiting-approval" | "revising" | "completed" | "skipped";

export const CHECKBOX_MAP: Record<CheckboxState, string> = {
  pending: "[ ]",
  "in-progress": "[-]",
  "awaiting-approval": "[?]",
  revising: "[R]",
  completed: "[x]",
  skipped: "[S]",
};

export const CHECKBOX_REVERSE: Record<string, CheckboxState> = {
  "[ ]": "pending",
  "[-]": "in-progress",
  "[?]": "awaiting-approval",
  "[R]": "revising",
  "[x]": "completed",
  "[S]": "skipped",
};

export const PHASES = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

export type Phase = (typeof PHASES)[number];

export const PHASE_NUMBERS: Record<string, Phase> = {
  "0": "initialization",
  "1": "ideation",
  "2": "inception",
  "3": "construction",
  "4": "operation",
};

// --- Harness dir resolution (.claude vs .kiro vs .codex) ---

// The deterministic core ships in multiple harness trees: Claude Code reads
// it from <project>/.claude/, Kiro CLI from <project>/.kiro/, Codex CLI from
// <project>/.codex/, and ANY future harness from <project>/<its-dir>/. Every
// runtime path that names the harness directory flows through harnessDir() so
// the SAME tool sources work in every tree. Resolution order mirrors
// resolveProjectDir: env seam (tests/fixtures) → script-path derivation (this
// module ships at <project>/<harness>/tools/aidlc-lib.ts, so the harness dir is
// simply the directory two levels up — derived OPEN-SET, not matched against a
// fixed list, so harness #N needs no edit here) → CWD probe → ".claude"
// fallback.
//
// KNOWN_HARNESS_DIRS is NOT the source of truth for which harnesses exist — the
// script-path derivation handles any dir. It is only a probe-ORDER hint for the
// dev-repo CWD rung, where more than one harness dir can coexist and the Claude
// tree is canonical (".claude" must win). A real single-harness install never
// reaches the probe; it resolves by script path.
const KNOWN_HARNESS_DIRS = [".claude", ".kiro", ".codex"] as const;

// True for a plausible harness dir name: a dot-prefixed segment, e.g. ".claude"
// / ".kiro" / ".gemini". Guards the script-path derivation so an unexpected
// layout (lib copied loose in a test, a non-dotted parent) falls through to the
// CWD probe instead of returning a bogus harness dir.
function isHarnessDirName(name: string): boolean {
  return /^\.[a-z0-9][a-z0-9._-]*$/i.test(name);
}

function deriveHarnessDir(): string {
  // Script-path derivation (open-set): the module ships at
  // <project>/<harness>/tools/aidlc-lib.ts, so the harness dir is the basename
  // of the grandparent of this file — whatever it is named.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  if (basename(scriptDir) === "tools") {
    const candidate = basename(dirname(scriptDir));
    if (isHarnessDirName(candidate)) return candidate;
  }
  // CWD probe (dev repo, multiple trees coexist): known dirs in canonical order.
  const cwd = process.cwd();
  for (const h of KNOWN_HARNESS_DIRS) {
    if (existsSync(join(cwd, h))) return h;
  }
  return ".claude";
}

let _harnessDir: string | null = null;

export function harnessDir(): string {
  // Env read at call time (not cached) so tests can flip it between bun
  // invocations — same pattern as stageGraphPath() below.
  if (process.env.AIDLC_HARNESS_DIR) return process.env.AIDLC_HARNESS_DIR;
  if (_harnessDir === null) _harnessDir = deriveHarnessDir();
  return _harnessDir;
}

// The AIDLC markdown rule layers (aidlc-org/team/project/phase .md) live under
// a per-harness subdirectory of the harness dir: `.claude/rules/`,
// `.kiro/steering/` (Kiro reads steering files as its native rule surface),
// `.codex/aidlc-rules/` (Codex's native `.codex/rules/` is Starlark permission
// rules — D-10). The packager renames the SHIPPED directory and the prose/JSON
// that names it (transform()/applyRulesRename + renameRulesInCompiledData), but
// the .ts tools are byte-copied across all trees, so any runtime path a tool
// builds to a rule file MUST go through rulesSubdir() — a hardcoded "rules"
// segment targets a directory that does not exist on a rename-rules harness.
//
// The rename is a fact only the harness MANIFEST knows, so the packager emits
// it per-tree into tools/data/harness.json ({"rulesSubdir": "..."}) — the
// open-set source of truth: a new harness ships its own harness.json and needs
// no edit here. Resolution: AIDLC_RULES_SUBDIR env seam (fixtures) →
// AIDLC_HARNESS_DIR test-seam map (so "pretend to be .kiro" yields "steering"
// without a .kiro tree on disk) → the shipped harness.json (the real-install
// rung) → KNOWN_RULES_SUBDIR dev-fallback map → "rules". Returns the LAST path
// segment only (e.g. "steering"); callers join it under harnessDir().
const KNOWN_RULES_SUBDIR: Record<string, string> = {
  ".claude": "rules",
  ".kiro": "steering",
  ".codex": "aidlc-rules",
};

function shippedRulesSubdir(): string | null {
  // tools/data/harness.json sits beside the compiled stage-graph.json in the
  // shipped tree (DATA_DIR). Absent in a dev checkout's core/ (authored source
  // carries no compiled data) → null, and the caller falls through.
  try {
    const raw = readFileSync(join(DATA_DIR, "harness.json"), "utf-8");
    const parsed = JSON.parse(raw) as { rulesSubdir?: unknown };
    if (typeof parsed.rulesSubdir === "string" && parsed.rulesSubdir.length > 0) {
      return parsed.rulesSubdir;
    }
  } catch {
    // no harness.json (dev core/, or a tree built before this landed) → fall through
  }
  return null;
}

export function rulesSubdir(): string {
  if (process.env.AIDLC_RULES_SUBDIR) return process.env.AIDLC_RULES_SUBDIR;
  // Test seam: AIDLC_HARNESS_DIR pins the harness without a tree on disk, so it
  // must out-rank the physically-shipped harness.json (which reflects THIS lib
  // copy's tree). Real installs don't set it and fall to the shipped value.
  if (process.env.AIDLC_HARNESS_DIR) {
    return KNOWN_RULES_SUBDIR[process.env.AIDLC_HARNESS_DIR] ?? "rules";
  }
  return shippedRulesSubdir() ?? KNOWN_RULES_SUBDIR[harnessDir()] ?? "rules";
}

// --- Project dir resolution ---

export function resolveProjectDir(explicitDir?: string): string {
  // 1. Explicit --project-dir argument
  if (explicitDir) return explicitDir;

  // 2. CLAUDE_PROJECT_DIR env var
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;

  // 3. Script path derivation (open-set): this module ships at
  //    <project>/<harness>/tools/, so strip "<harness>/tools" for ANY harness
  //    dir name — the project root is the dir two levels up.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fromScript = stripHarnessLeaf(scriptDir, "tools");
  if (fromScript) return fromScript;

  // 4. CWD has a known harness directory (dev repo).
  const cwd = process.cwd();
  for (const h of KNOWN_HARNESS_DIRS) {
    if (existsSync(join(cwd, h))) {
      return cwd;
    }
  }

  // Fallback to CWD
  return cwd;
}

// If `dir` is "<root>/<harness>/<leaf>" with <harness> a harness-dir name and
// <leaf> the given segment (tools | hooks), return <root>; else null. Open-set:
// the harness segment is validated by SHAPE (isHarnessDirName), not membership
// in a fixed list, so a new harness needs no edit here.
function stripHarnessLeaf(dir: string, leaf: string): string | null {
  if (basename(dir) !== leaf) return null;
  const harnessDirPath = dirname(dir);
  if (!isHarnessDirName(basename(harnessDirPath))) return null;
  return dirname(harnessDirPath);
}

// --- Hook project dir resolution ---

export function resolveProjectDirFromHook(importMetaUrl: string): string {
  // 1. CLAUDE_PROJECT_DIR env var
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;

  // 2. Script path derivation (open-set): hooks ship at
  //    <project>/<harness>/hooks/, so strip "<harness>/hooks" for ANY harness.
  const scriptDir = dirname(fileURLToPath(importMetaUrl));
  const fromScript = stripHarnessLeaf(scriptDir, "hooks");
  if (fromScript) return fromScript;

  // 3. CWD has a known harness directory (dev repo).
  const cwd = process.cwd();
  for (const h of KNOWN_HARNESS_DIRS) {
    if (existsSync(join(cwd, h))) {
      return cwd;
    }
  }

  return cwd;
}

// --- File paths ---

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export function stateFilePath(projectDir: string): string {
  return join(projectDir, "aidlc-docs", "aidlc-state.md");
}

export function auditFilePath(projectDir: string): string {
  return join(projectDir, "aidlc-docs", "audit.md");
}

export function worktreePath(projectDir: string, boltSlug: string): string {
  return join(projectDir, ".aidlc", "worktrees", `bolt-${boltSlug}`);
}

// Bolt slug shape: lowercase letter, then lowercase letters / digits / hyphens.
// Centralised here (previously duplicated as SLUG_RE in aidlc-worktree.ts and
// SLUG_REGEX in aidlc-audit.ts) so a future tightening lands once. Stage and
// artifact slugs in stage-schema.ts are a separate domain and keep their own
// regex.
export const BOLT_SLUG_REGEX = /^[a-z][a-z0-9-]*$/;
export const BOLT_SLUG_MAX_LENGTH = 64;

// --- Error helpers (catch-block discipline) ---
//
// TypeScript 4.4+ types `catch (e)` as `unknown` under --useUnknownInCatchVariables.
// These two helpers replace the old `e as Error` pattern in throw-sites and
// log-sites uniformly. Use:
//
//   try { ... } catch (e) {
//     throw new Error(`failed: ${errorMessage(e)}`);
//   }
//
// Both helpers are total (never throw) and stable on any thrown value
// — string throws, plain objects, Error instances, primitives.

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  // TS 4.9+ narrows `e.message` to `unknown` after the `in` check — no cast needed.
  if (typeof e === "object" && e !== null && "message" in e) {
    const msg: unknown = e.message;
    return typeof msg === "string" ? msg : String(msg);
  }
  return String(e);
}

export function errorStack(e: unknown): string | undefined {
  if (e instanceof Error) {
    return e.stack;
  }
  if (typeof e === "object" && e !== null && "stack" in e) {
    const stack: unknown = e.stack;
    return typeof stack === "string" ? stack : undefined;
  }
  return undefined;
}

// --- JSON.parse type guards ---
//
// JSON.parse returns `any` (TypeScript design choice). These guards narrow
// `unknown` to a concrete shape so consumers don't need property-access
// casts. Each guard is structural and total — it returns false for malformed
// input rather than throwing, so callers can decide how to fail.

/**
 * Generic "is plain object" predicate. After this guard, the value is typed
 * `Record<string, unknown>` so caller can do `if ("x" in v) { v.x ... }`
 * with TS narrowing carrying through.
 */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Minimal package.json shape. Only fields the framework reads are listed —
 * the type-coverage layer needs declared shapes for JSON.parse outputs to
 * count as typed.
 */
export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  main?: string;
  module?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Type guard for package.json. Permissive — accepts any plain object. */
export function isPackageJson(x: unknown): x is PackageJson {
  return isPlainObject(x);
}

/**
 * Claude Code hook event payload. Hooks receive JSON on stdin with a
 * shape that varies by event type. Fields below are the union of what
 * the framework's hooks actually read — see
 * https://docs.anthropic.com/en/docs/claude-code/hooks for the canonical
 * reference. All fields are optional because the hook code defensively
 * coalesces with `?? ""`.
 */
export interface ClaudeCodeHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
    status?: string;
    activeForm?: string;
    [key: string]: unknown;
  };
  reason?: string;
  source?: string;
  prompt?: string;
  agent_type?: string;
  agent_id?: string;
  last_assistant_message?: string;
  [key: string]: unknown;
}

/** Type guard for Claude Code hook input JSON. */
export function isClaudeCodeHookInput(x: unknown): x is ClaudeCodeHookInput {
  return isPlainObject(x);
}

// --- Map / collection access helpers ---
//
// Replace Map.get(k)! / Array.pop()! / Array.shift()! patterns where the
// caller has algorithmic certainty the value exists. Throws on nullish
// instead of leaving a runtime undefined to leak silently — strictly
// safer than the bang assertion.

/** Get a Map value that the algorithm guarantees is set. Throws if absent. */
export function mustGet<K, V>(m: Map<K, V>, k: K, ctx: string): V {
  const v = m.get(k);
  if (v === undefined) {
    throw new Error(`Internal: mustGet(${ctx}) returned undefined; map invariant violated`);
  }
  return v;
}

/** Pop from an array the caller guarantees is non-empty. Throws if empty. */
export function mustPop<T>(arr: T[], ctx: string): T {
  const v = arr.pop();
  if (v === undefined) {
    throw new Error(`Internal: mustPop(${ctx}) on empty array`);
  }
  return v;
}

/** Shift from an array the caller guarantees is non-empty. Throws if empty. */
export function mustShift<T>(arr: T[], ctx: string): T {
  const v = arr.shift();
  if (v === undefined) {
    throw new Error(`Internal: mustShift(${ctx}) on empty array`);
  }
  return v;
}

// Validate a Bolt slug against shape + length. Returns null on success or a
// human-readable error string on failure. Pure — callers route through their
// preferred error mechanism (jsonError, throw, etc.).
export function validateBoltSlug(slug: string): string | null {
  if (!slug) {
    return "Bolt slug is empty";
  }
  if (slug.length > BOLT_SLUG_MAX_LENGTH) {
    return `Bolt slug "${slug.slice(0, 32)}..." is ${slug.length} chars; max is ${BOLT_SLUG_MAX_LENGTH}`;
  }
  if (!BOLT_SLUG_REGEX.test(slug)) {
    return `Invalid Bolt slug "${slug}" — must match ${BOLT_SLUG_REGEX} (lowercase letter, then lowercase letters/digits/hyphens)`;
  }
  return null;
}

// --- State file I/O ---

export function readStateFile(projectDir: string): string {
  const path = stateFilePath(projectDir);
  if (!existsSync(path)) {
    throw new Error(`State file not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

export function writeStateFile(projectDir: string, content: string): void {
  const path = stateFilePath(projectDir);
  // A read-only aidlc-state.md is a deliberate write barrier the state tool
  // must honour (a corrupt/locked workspace must fail loud, not silently
  // advance — see the t47/t77/t137 read-only-state failure-injection tests).
  // writeFileAtomic uses tmp+rename, and POSIX rename overwrites a read-only
  // TARGET (it only needs directory-write permission), so it would bypass that
  // barrier. Preserve the bare-writeFileSync EACCES semantics by refusing up
  // front when the target exists but is not writable.
  if (existsSync(path)) accessSync(path, fsConstants.W_OK);
  // Atomic write (tmp + rename) so a crash mid-write can never leave a
  // half-written state file a concurrent reader would see torn. Lost-update
  // safety for the read-modify-write handlers (withAuditLock wrapping) is a
  // separate, larger change tracked as a follow-up; this reroute is the
  // torn-write half and benefits every caller unconditionally.
  writeFileAtomic(path, content);
}

// --- Field reading/writing ---

export function getField(content: string, field: string): string | null {
  // Match: - **Field Name**: value
  // Use [ \t]* instead of \s* so a field with an empty value returns "" (not
  // the next bullet line — \s matches \n in JS regex, which would let the
  // pattern cross into the next line).
  const regex = new RegExp(
    `^- \\*\\*${escapeRegex(field)}\\*\\*:[ \\t]*(.*)$`,
    "m"
  );
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}

export function setField(content: string, field: string, value: string): string {
  // [ \t]* instead of \s* so an empty value doesn't let the regex eat the
  // following line. .* with the m flag does not cross lines on its own, but
  // \s* preceding it would consume the trailing \n.
  const regex = new RegExp(
    `^(- \\*\\*${escapeRegex(field)}\\*\\*:)[ \\t]*.*$`,
    "m"
  );
  if (regex.test(content)) {
    return content.replace(regex, `$1 ${value}`);
  }
  return content;
}

// setFieldStrict: like setField but throws when the field is absent. Use this
// in state-machine transitions where a silent no-op would cause undetected
// drift (e.g., bolt set-autonomy updating Construction Autonomy Mode — if the
// field is missing, we want to know immediately, not ship a lie to the caller).
export function setFieldStrict(content: string, field: string, value: string): string {
  // [ \t]* instead of \s* — see setField comment for the line-crossing rationale.
  const regex = new RegExp(
    `^(- \\*\\*${escapeRegex(field)}\\*\\*:)[ \\t]*.*$`,
    "m"
  );
  if (!regex.test(content)) {
    throw new Error(
      `Field not found in state file: "${field}". Cannot update — refusing to silently no-op.`
    );
  }
  return content.replace(regex, `$1 ${value}`);
}

// setOrInsertField: update field if present; otherwise insert a new
// `- **Field**: value` bullet at the end of the named `## Heading` section.
// Intended for optional fields that don't ship in the current state-template
// but may be added at runtime (e.g., the `Merge-Held` per-Bolt marker —
// added only when a multi-failure halt-and-ask sequence opens).
export function setOrInsertField(
  content: string,
  heading: string,
  field: string,
  value: string,
): string {
  const regex = new RegExp(
    `^(- \\*\\*${escapeRegex(field)}\\*\\*:)[ \\t]*.*$`,
    "m"
  );
  if (regex.test(content)) {
    return content.replace(regex, `$1 ${value}`);
  }
  return appendUnderHeading(content, heading, `- **${field}**: ${value}\n`);
}

// --- Refs-list field operations (Bolt Refs in v7 state template) ---
//
// `Bolt Refs` is a list-shaped single-line value with a literal `[empty list]`
// placeholder when empty (state-template.md:11) — `aidlc-utility.ts`'s init
// emitter at line 1391 also produces a bare-empty shape (no value after the
// colon). Both are tolerated on parse; emit always produces `[empty list]`
// when empty for round-trip determinism.
export function parseRefsList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "[empty list]") return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function emitRefsList(slugs: string[]): string {
  if (slugs.length === 0) return "[empty list]";
  const sorted = [...slugs].sort();
  return `[${sorted.join(", ")}]`;
}

export function appendSlug(currentValue: string, slug: string): string {
  const list = parseRefsList(currentValue);
  if (list.includes(slug)) {
    throw new Error(`slug already present in refs list: "${slug}"`);
  }
  list.push(slug);
  return emitRefsList(list);
}

export function removeSlug(currentValue: string, slug: string): string {
  const list = parseRefsList(currentValue);
  if (!list.includes(slug)) {
    throw new Error(`slug not present in refs list: "${slug}"`);
  }
  return emitRefsList(list.filter((s) => s !== slug));
}

// --- Checkbox operations ---

export interface CheckboxLine {
  slug: string;
  state: CheckboxState;
  suffix: string; // e.g., "EXECUTE" or "SKIP: reason"
}

export function parseCheckboxes(content: string): CheckboxLine[] {
  const results: CheckboxLine[] = [];
  const regex = /^- \[([ xSR?-])\] (\S+)\s*—\s*(.*)$/gm;
  let match: RegExpExecArray | null = regex.exec(content);
  while (match !== null) {
    const marker = match[1];
    let state: CheckboxState;
    switch (marker) {
      case " ":
        state = "pending";
        break;
      case "-":
        state = "in-progress";
        break;
      case "?":
        state = "awaiting-approval";
        break;
      case "R":
        state = "revising";
        break;
      case "x":
        state = "completed";
        break;
      case "S":
        state = "skipped";
        break;
      default:
        state = "pending";
    }
    results.push({ slug: match[2], state, suffix: match[3].trim() });
    match = regex.exec(content);
  }
  return results;
}

export function setCheckbox(
  content: string,
  slug: string,
  newState: CheckboxState
): string {
  const marker = CHECKBOX_MAP[newState];
  // Match any checkbox state for this slug
  const regex = new RegExp(
    `^(- )\\[[ xSR?-]\\]( ${escapeRegex(slug)} —)`,
    "m"
  );
  return content.replace(regex, `$1${marker}$2`);
}

export function countCheckboxes(
  content: string,
  state: CheckboxState
): number {
  const checkboxes = parseCheckboxes(content);
  return checkboxes.filter((c) => c.state === state).length;
}

// --- Audit locking ---

export function auditLockDir(projectDir: string): string {
  const hash = createHash("md5").update(projectDir).digest("hex").slice(0, 8);
  return join(tmpdir(), `.aidlc-audit-${hash}.lock`);
}

export function acquireAuditLock(
  projectDir: string,
  maxRetries = 50,
  retryMs = 100
): boolean {
  const lockDir = auditLockDir(projectDir);
  for (let i = 0; i <= maxRetries; i++) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      if (i < maxRetries) {
        Bun.sleepSync(retryMs);
      }
    }
  }
  return false;
}

export function releaseAuditLock(projectDir: string): void {
  const lockDir = auditLockDir(projectDir);
  try {
    rmdirSync(lockDir);
  } catch {
    // Lock dir may already be removed
  }
  const handler = AUDIT_LOCK_EXIT_HANDLERS.get(projectDir);
  if (handler) {
    process.off("exit", handler);
    AUDIT_LOCK_EXIT_HANDLERS.delete(projectDir);
  }
}

// Tracks per-project exit handlers that release the audit lock if a caller
// process.exit()s while still holding it. Bun's process.exit skips `finally`
// blocks, so a tool that wraps locked work in try/finally and then calls
// errorWithSlug → emitError → process.exit will leak the lock dir without
// this safety net. Lock acquire registers a handler; release deregisters.
const AUDIT_LOCK_EXIT_HANDLERS = new Map<string, () => void>();

// Per-pd reentrancy depth. Same-process nested withAuditLock calls for the
// same projectDir would otherwise self-deadlock — the inner mkdir hits
// EEXIST against the lock the outer caller already holds, and burns the
// retry budget (50 × 100ms = 5s) before throwing. A future caller that
// composes locked operations (e.g., a tool that wraps state mutation in
// withAuditLock and that mutation later wraps another withAuditLock) would
// trip this footgun silently. The depth counter makes the primitive
// reentrant: the outer call performs the OS-level lock acquire/release;
// inner calls just bump depth and return. Cross-process locking is
// unaffected — different processes still serialise via mkdir EEXIST.
const AUDIT_LOCK_DEPTH = new Map<string, number>();

// writeFileAtomic — non-corrupting variant of writeFileSync. Writes to a
// sibling `<path>.tmp` then POSIX-renames into place atomically. Readers
// of <path> see either the previous version or the new one — never a
// half-written file. Pair with withAuditLock when concurrent writers
// must serialise (rename alone defeats half-writes but not lost updates).
//
// Sibling temp keeps the rename on the same filesystem so it's a true
// atomic rename (cross-fs renames degrade to copy-then-unlink). Cleans
// up the temp file on write failure.
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp may already be gone */ }
    throw err;
  }
}

// withAuditLock — atomic locked-section helper. Acquires the audit lock,
// installs an exit-handler safety net (so a process.exit inside `fn` still
// releases the lock dir), runs `fn`, releases the lock. Use this when you
// need to hold the lock across multiple reads/writes (e.g., audit-first
// state mutations that emit audit + write state atomically).
//
// Reentrant within a single process for the same projectDir: nested calls
// just bump depth and run `fn`; only the outermost call performs OS-level
// acquire/release. Cross-process locking is unchanged.
//
// SYNC ONLY. The return type excludes Promise so a caller can't pass an
// async function that releases the lock before its work settles. Today's
// callers are all sync (compile, state.ts fork/merge); future async-locked
// transactions need a separate `withAuditLockAsync` that awaits before
// release. The compile-time guard catches the footgun at the call site.
export function withAuditLock<T>(
  projectDir: string,
  fn: () => T extends Promise<unknown> ? never : T,
): T extends Promise<unknown> ? never : T {
  const currentDepth = AUDIT_LOCK_DEPTH.get(projectDir) ?? 0;
  if (currentDepth === 0) {
    if (!acquireAuditLock(projectDir)) {
      throw new Error(`Failed to acquire audit lock for ${projectDir} after retries`);
    }
    // Safety net: if the body calls process.exit (Bun skips `finally` in that
    // case), the on-exit handler releases the lock dir so the project isn't
    // poisoned for ~5s on the next invocation.
    const onExit = () => {
      const lockDir = auditLockDir(projectDir);
      try { rmdirSync(lockDir); } catch { /* already removed */ }
    };
    AUDIT_LOCK_EXIT_HANDLERS.set(projectDir, onExit);
    process.on("exit", onExit);
  }
  AUDIT_LOCK_DEPTH.set(projectDir, currentDepth + 1);
  try {
    return fn();
  } finally {
    const depth = AUDIT_LOCK_DEPTH.get(projectDir) ?? 0;
    if (depth <= 1) {
      AUDIT_LOCK_DEPTH.delete(projectDir);
      releaseAuditLock(projectDir);
    } else {
      AUDIT_LOCK_DEPTH.set(projectDir, depth - 1);
    }
  }
}

// True iff THIS process currently holds the audit lock for `projectDir` via an
// outer withAuditLock (or a bare acquireAuditLock paired with the exit-handler
// install). The lock-acquire path registers a per-pd exit handler and the
// release path removes it (see AUDIT_LOCK_EXIT_HANDLERS), so the handler's
// presence is the in-lock signal. emitError (below) already branches on this
// to pick appendAuditEntryUnlocked vs appendAuditEntry; the state tool's
// emitAudit helper uses it for the same reason — an audit emit issued from
// inside a held lock MUST use the unlocked variant or it self-deadlocks against
// the lock it is already holding (appendAuditEntry calls acquireAuditLock,
// which is NOT reentrant — only withAuditLock's depth counter is — so it would
// burn the full 50×100ms retry budget and then throw).
export function holdsAuditLock(projectDir: string): boolean {
  return AUDIT_LOCK_EXIT_HANDLERS.has(projectDir);
}

// --- Audit event correlation ---
//
// Doctor (and future sensors / observers) need to walk audit blocks and
// correlate ERROR_LOGGED rows back to the operation that emitted them.
// The three regexes below match the slug-bearing tags shipped by the
// worktree primitive (`[slug=...]`), the audit fork/merge subcommands
// (`[fork-emitted:<ts>]`), and post-merge cleanup (`[merge-succeeded:<sha>]`).
// Promoted from inline literals so consumers reuse one definition.

export const SLUG_TAG_REGEX = /\[slug=([a-z0-9-]+)\]/;
export const FORK_EMITTED_TAG_REGEX = /\[fork-emitted:([^\]]+)\]/;
export const MERGE_SUCCEEDED_TAG_REGEX = /\[merge-succeeded:([^\]]+)\]/;

// findAllEvents — multi-match analogue of findLatestEvent (which lives
// tool-local in aidlc-worktree.ts and returns at most one match). Optional
// slug filter mirrors findLatestEvent's signature. Walks audit blocks from
// start; collects every block where **Event**: <event> matches (and
// **Bolt slug**: <slug> if slug provided). Returns [] on no match.
//
// Block separator is the same `\n---\n` aidlc-audit.ts uses on emit.
// Normalises CRLF → LF before splitting so audits authored or edited on
// Windows (Bun's PRE_REQ env per dist/claude/.claude/CLAUDE.md) parse
// the same as Unix audits. Without this, `\r\n---\r\n` doesn't match the
// `\n---\n` separator and every block past the first looks merged into one
// — silently masking every drift class.
export function findAllEvents(
  audit: string,
  event: string,
  slug?: string,
): { timestamp: string; block: string }[] {
  const results: { timestamp: string; block: string }[] = [];
  const blocks = audit.replace(/\r\n/g, "\n").split(/\n---\n/);
  const eventRegex = new RegExp(`^\\*\\*Event\\*\\*:\\s*${escapeRegex(event)}\\s*$`, "m");
  const slugRegex = slug
    ? new RegExp(`^\\*\\*Bolt slug\\*\\*:\\s*${escapeRegex(slug)}\\s*$`, "m")
    : null;
  const tsRegex = /^\*\*Timestamp\*\*:\s*(\S+)/m;
  for (const block of blocks) {
    if (!eventRegex.test(block)) continue;
    if (slugRegex && !slugRegex.test(block)) continue;
    const tsMatch = block.match(tsRegex);
    if (!tsMatch) continue;
    results.push({ timestamp: tsMatch[1], block });
  }
  return results;
}

// --- Data loaders ---

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

let _stageGraph: StageEntry[] | null = null;
let _scopeMapping: Record<string, ScopeDefinition> | null = null;

// Override paths for fixture injection in tests. Read at call time (not
// module load) so tests can mutate env vars between bun invocations
// while still sharing a process in rare cases. AIDLC_STAGE_GRAPH pattern
// matches AIDLC_PROJECT_DIR in resolveProjectDir() above.
function stageGraphPath(): string {
  return process.env.AIDLC_STAGE_GRAPH ?? join(DATA_DIR, "stage-graph.json");
}

function scopeGridPath(): string {
  return process.env.AIDLC_SCOPE_GRID ?? join(DATA_DIR, "scope-grid.json");
}

// scope-mapping.json is retired. It survives ONLY as a test
// fixture seam: when AIDLC_SCOPE_MAPPING is set, loadScopeMapping() reads
// that JSON file verbatim (preserving fixture-injection tests + the
// designer-export env-seam). With the var unset there is no JSON on disk —
// the mapping is derived from the compiled scope-grid.json (the EXECUTE/SKIP
// transpose) + the .claude/scopes/*.md frontmatter (depth/keywords/etc.).
function scopeMappingPath(): string | null {
  return process.env.AIDLC_SCOPE_MAPPING ?? null;
}

// .claude/scopes/ holds one aidlc-<name>.md per scope. AIDLC_SCOPES_DIR
// env-var seam mirrors AIDLC_SENSORS_DIR / AIDLC_RULES_DIR so fixture tests
// can point the scope-metadata loader at an isolated tree. Evaluated at call
// time so tests that set/unset mid-process see the change.
function scopesDir(): string {
  return process.env.AIDLC_SCOPES_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "scopes");
}

export function loadStageGraph(): StageEntry[] {
  if (_stageGraph !== null) return _stageGraph;
  const p = stageGraphPath();
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch (err) {
    const hint = process.env.AIDLC_STAGE_GRAPH
      ? `AIDLC_STAGE_GRAPH points to ${p}; unset it to use the default.`
      : "Reinstall the framework or re-run setup to restore the data file.";
    throw new Error(
      `Stage graph not readable at ${p}: ${errorMessage(err)}. ${hint}`
    );
  }
  let parsed: StageEntry[];
  try {
    // JSON.parse returns `any`; we trust the on-disk schema (project-controlled
    // data file written by the framework, not user input). Phase E will
    // replace this trust boundary with an isStageEntryArray() type guard.
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Stage graph at ${p} is not valid JSON: ${errorMessage(err)}`
    );
  }
  _stageGraph = parsed;
  return parsed;
}

// Per-scope prose metadata read from each .claude/scopes/aidlc-<name>.md
// frontmatter: name/depth/keywords/description (+ optional testStrategy).
// This is the depth/keywords/description half of a ScopeDefinition; the
// EXECUTE/SKIP `.stages` half comes from the compiled grid. Cached.
interface ScopeMetadata {
  name: string;
  depth: string;
  description: string;
  keywords: string[];
  testStrategy?: string;
}

let _scopeMetadata: Record<string, ScopeMetadata> | null = null;

type ScopeGridForMapping = Record<string, { stages: Record<string, "EXECUTE" | "SKIP"> }>;

function transposeScopeGridForMapping(stages: StageEntry[]): ScopeGridForMapping {
  const scopeNames = new Set<string>();
  for (const stage of stages) {
    for (const name of stage.scopes ?? []) scopeNames.add(name);
  }
  const grid: ScopeGridForMapping = {};
  for (const scope of [...scopeNames].sort()) {
    const stagesMap: Record<string, "EXECUTE" | "SKIP"> = {};
    for (const stage of stages) {
      stagesMap[stage.slug] = (stage.scopes ?? []).includes(scope) ? "EXECUTE" : "SKIP";
    }
    grid[scope] = { stages: stagesMap };
  }
  return grid;
}

function loadScopeGridForMapping(): ScopeGridForMapping {
  const p = scopeGridPath();
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ScopeGridForMapping;
  } catch {
    return transposeScopeGridForMapping(loadStageGraph());
  }
}

export function loadScopeMetadata(): Record<string, ScopeMetadata> {
  if (_scopeMetadata !== null) return _scopeMetadata;
  const dir = scopesDir();
  const out: Record<string, ScopeMetadata> = {};
  let files: string[];
  try {
    // Sort so readdirSync order is platform-independent — the derived
    // scope set + the designer-export `scopes` key order stay deterministic
    // across machines (same discipline as loadAgents()).
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf-8");
    const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) throw new Error(`Scope file missing frontmatter: ${join(dir, f)}`);
    const fm = m[1];
    const name = scalarField(fm, "name");
    if (!name) throw new Error(`Scope file ${join(dir, f)} missing required frontmatter: name`);
    const meta: ScopeMetadata = {
      name,
      depth: scalarField(fm, "depth"),
      description: scalarField(fm, "description"),
      keywords: listField(fm, "keywords"),
    };
    const ts = scalarField(fm, "testStrategy");
    if (ts) meta.testStrategy = ts;
    out[name] = meta;
  }
  _scopeMetadata = out;
  return out;
}

// loadScopeMapping reconstructs the legacy `Record<scope, ScopeDefinition>`
// shape so every existing consumer (the EXECUTE/SKIP `.stages` map, the
// keyword/depth/description reads) keeps working unchanged after the JSON
// source-of-truth is retired. Two sources:
//   - AIDLC_SCOPE_MAPPING set  → read that JSON file verbatim (test seam).
//   - unset (the shipped path) → merge the compiled scope-grid.json
//     (.stages) with the .claude/scopes/*.md frontmatter (depth/keywords/
//     description/testStrategy). Scope set = the .md files present.
export function loadScopeMapping(): Record<string, ScopeDefinition> {
  if (_scopeMapping !== null) return _scopeMapping;

  const jsonPath = scopeMappingPath();
  if (jsonPath !== null) {
    // Test-seam path: an injected scope-mapping.json fixture.
    let raw: string;
    try {
      raw = readFileSync(jsonPath, "utf-8");
    } catch (err) {
      throw new Error(
        `Scope mapping not readable at ${jsonPath}: ${errorMessage(err)}. ` +
          `AIDLC_SCOPE_MAPPING points to ${jsonPath}; unset it to derive from .claude/scopes/.`
      );
    }
    let parsed: Record<string, ScopeDefinition>;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Scope mapping at ${jsonPath} is not valid JSON: ${errorMessage(err)}`);
    }
    _scopeMapping = parsed;
    return parsed;
  }

  // Shipped path: derive from the compiled grid + per-scope .md metadata.
  // Keep the grid read local to avoid a circular aidlc-lib -> aidlc-graph
  // require while aidlc-graph's CLI is still initialising under native Windows
  // Bun.
  const grid = loadScopeGridForMapping();
  const metadata = loadScopeMetadata();

  const out: Record<string, ScopeDefinition> = {};
  for (const name of Object.keys(metadata)) {
    const meta = metadata[name];
    const def: ScopeDefinition = {
      depth: meta.depth,
      stages: grid[name]?.stages ?? {},
      keywords: meta.keywords,
      description: meta.description,
    };
    if (meta.testStrategy !== undefined) def.testStrategy = meta.testStrategy;
    out[name] = def;
  }
  _scopeMapping = out;
  return out;
}

// Reset caches so fixture-swapping tests can reload from a different
// AIDLC_SCOPE_MAPPING / AIDLC_STAGE_GRAPH path within the same bun
// process. Mirrors the precedent set by aidlc-graph.ts __resetGraphCache.
export function _resetScopeMappingForTests(): void {
  _scopeMapping = null;
  _scopeMetadata = null;
  _validScopes = null;
}

export function _resetStageGraphForTests(): void {
  _stageGraph = null;
}

// Canonical scope names derived from .claude/scopes/*.md presence (via
// loadScopeMapping's metadata source). Dropping a new aidlc-<name>.md file
// automatically flows through every tool that validates scope arguments —
// no code change. Sorted alphabetically so error-message enumeration is
// deterministic regardless of file-read order. (Under the AIDLC_SCOPE_MAPPING
// test seam the names come from the injected JSON keys instead.)
let _validScopes: ReadonlySet<string> | null = null;

export function validScopes(): ReadonlySet<string> {
  if (!_validScopes) {
    _validScopes = new Set(Object.keys(loadScopeMapping()).sort());
  }
  return _validScopes;
}

// Agent metadata derived from `.claude/agents/*.md` frontmatter. Adding a
// new agent means dropping in an `.md` file with the required fields; the
// loader discovers it at next invocation. Sorted alphabetically by slug
// so readdirSync order is platform-independent.

export interface AgentMetadata {
  slug: string;
  display_name: string;
  examples: string[];
}

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

let _agents: AgentMetadata[] | null = null;

export function loadAgents(): AgentMetadata[] {
  if (!_agents) {
    const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
    _agents = files
      .map((f) => parseAgentFrontmatter(join(AGENTS_DIR, f)))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }
  return _agents;
}

function parseAgentFrontmatter(path: string): AgentMetadata {
  const body = readFileSync(path, "utf-8");
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`Agent file missing frontmatter: ${path}`);
  const fm = m[1];

  const slug = scalarField(fm, "name");
  const display_name = scalarField(fm, "display_name");
  const examples = listField(fm, "examples");

  const missing: string[] = [];
  if (!slug) missing.push("name");
  if (!display_name) missing.push("display_name");
  if (missing.length > 0) {
    throw new Error(
      `Agent file ${path} missing required frontmatter: ${missing.join(", ")}`
    );
  }
  return { slug, display_name, examples };
}

// Scalar field parser. Rejects YAML folded/literal block markers
// (`>`, `|`) so `description: >` on the next line can't be silently
// captured as the value. Strips surrounding quotes so
// `display_name: "Foo"` renders as `Foo` in user-facing output.
//
// Exported so aidlc-rule-schema.ts can reuse the zero-dep YAML primitive
// (rule frontmatter has the same scalar/list shape as agent frontmatter).
export function scalarField(fm: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
  const m = fm.match(re);
  if (!m) return "";
  const raw = m[1].trim();
  if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") return "";
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

// List field parser. Bounds list items strictly to indented `- ` lines so
// a following `description: >` folded block cannot leak its continuation
// lines into this list. Requires at least one space after the dash — YAML
// syntax demands it, and accepting `-foo` silently as `foo` masks user
// error when adding new agents.
//
// Exported so aidlc-rule-schema.ts can reuse the zero-dep YAML primitive
// (rule frontmatter's `paths:` is a YAML list of strings).
export function listField(fm: string, key: string): string[] {
  const re = new RegExp(
    `^${key}:\\s*\\n((?:[ \\t]+-[ \\t]+[^\\r\\n]+\\r?\\n?)+)`,
    "m"
  );
  const m = fm.match(re);
  if (!m) return [];
  return m[1]
    .split(/\r?\n/)
    .map((l) => {
      const match = l.match(/^\s*-[ \t]+(.+?)\s*$/);
      return match ? match[1].replace(/^["']|["']$/g, "") : "";
    })
    .filter(Boolean);
}

// --- Stage frontmatter parse / emit ---

// parseStageFrontmatter reads a stage `.md` file body and extracts the
// YAML frontmatter block into a plain object shaped like the
// StageFrontmatter interface in stage-schema.ts. Pure — no I/O, no
// validation. Callers wanting schema checks pipe the result through
// validateStageFrontmatter() from stage-schema.ts.
//
// Extends the hand-rolled zero-dep parser pattern from loadAgents()
// above: scalarField for scalars, listField for string lists, and the
// new objectListField below for the consumes[] nested-object shape.
export function parseStageFrontmatter(
  raw: string
): Record<string, unknown> {
  if (typeof raw !== "string") {
    throw new Error(
      `parseStageFrontmatter expected string, got ${typeof raw}`
    );
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    throw new Error("Stage file missing YAML frontmatter (---...---)");
  }
  const fm = m[1];

  const obj: Record<string, unknown> = {};

  // Discover every top-level key in the frontmatter block. Passing
  // unknown keys through (rather than silently dropping them) is what
  // lets stage-schema.ts's validator reject reserved names like
  // `when:` / `on_failure:` with target-release messages. Scalar keys
  // parse via scalarField, list keys via listField, and `consumes:`
  // goes through objectListField.
  const topLevelKeys = new Set<string>();
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([a-z_][a-z0-9_]*)\s*:/);
    if (m) topLevelKeys.add(m[1]);
  }

  const ARRAY_KEYS = new Set([
    "support_agents",
    "produces",
    "requires_stage",
    "sensors",
    "scopes",
  ]);
  const CONSUMES_KEY = "consumes";

  for (const key of topLevelKeys) {
    if (key === CONSUMES_KEY) continue;
    if (ARRAY_KEYS.has(key)) continue;
    // The key was discovered at the start of some line, so it IS
    // present. scalarField returns "" for both absent AND empty-quoted
    // ("") — since we know it's present, assign the result
    // unconditionally. An empty-string value reaches the validator
    // (which will flag condition: "" as an invalid required-field
    // value if the field should be non-empty — that's a schema
    // concern, not a parser concern).
    obj[key] = scalarField(fm, key);
  }

  // Required string-array fields must be PRESENT in the object even
  // when empty — stage-schema.ts rejects absent required fields with
  // "missing required field". listField returns [] when its block
  // regex doesn't match, so unconditional assignment is safe.
  for (const key of ARRAY_KEYS) {
    obj[key] = listField(fm, key);
  }

  obj.consumes = objectListField(fm, CONSUMES_KEY);

  // reviewer_max_iterations is the one numeric scalar field. The generic
  // scalar loop above captured it as a string ("2"); coerce it to a real
  // number when the raw value is an integer literal so the type is correct
  // end-to-end — the schema validator, the directive contract, and the
  // conductor's `iterations < max` comparison all want a number, not "2".
  // A non-integer-literal value (e.g. "two", "2.5") is left as the string so
  // validateStageFrontmatter rejects it loudly rather than the parser
  // silently coercing to NaN. `reviewer` stays a string (handled by the loop).
  if (typeof obj.reviewer_max_iterations === "string") {
    const raw = obj.reviewer_max_iterations;
    if (/^-?\d+$/.test(raw)) {
      obj.reviewer_max_iterations = Number(raw);
    }
  }

  return obj;
}

// parseMemoryHeadings counts entries under each of the four canonical
// §13 H2 headings in a memory.md file and returns the per-heading
// breakdown plus the total. Pure function — no I/O, no validation.
// Single source of truth for runtime-graph compile, gate-ritual
// candidate surfacing, and memory.md lifecycle.
//
// Canonical headings (case-sensitive, exact match, no leading
// whitespace): "## Interpretations", "## Deviations", "## Tradeoffs",
// "## Open questions". Pinned by tests/smoke/t86-stage-protocol-section-13.sh.
//
// Counting rule: a non-blank, non-excluded line under a canonical
// heading counts as one entry. Bullets, prose paragraphs, and
// ISO-timestamped lines all count one each.
//
// Excluded (do NOT count): blank/whitespace-only lines, blockquote-only
// lines (`>` with no other content), HTML-comment-only lines
// (`<!-- ... -->`), code-fence delimiters (```), the canonical heading
// lines themselves, and any line inside a fenced code block.
//
// Section termination: any non-canonical H2 (`## X` not in the four
// anchors) below a canonical heading stops counting for the prior
// section; lines beneath it are ignored entirely.
//
// Missing canonical heading returns 0 for that key — never throws.
// Silent-skip detection is the consumer's concern; failing the parse
// because the orchestrator wrote three of four headings under context
// pressure would be the wrong move.
export function parseMemoryHeadings(raw: string): {
  interpretations: number;
  deviations: number;
  tradeoffs: number;
  open_questions: number;
  total: number;
} {
  if (typeof raw !== "string") {
    throw new Error(
      `parseMemoryHeadings expected string, got ${typeof raw}`
    );
  }

  const counts = {
    interpretations: 0,
    deviations: 0,
    tradeoffs: 0,
    open_questions: 0,
  };

  const HEADING_TO_KEY: Record<string, keyof typeof counts> = {
    "## Interpretations": "interpretations",
    "## Deviations": "deviations",
    "## Tradeoffs": "tradeoffs",
    "## Open questions": "open_questions",
  };

  const normalized = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let current: keyof typeof counts | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (line in HEADING_TO_KEY) {
      current = HEADING_TO_KEY[line];
      continue;
    }
    if (/^## /.test(line)) {
      current = null;
      continue;
    }

    if (current === null) continue;

    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^>/.test(trimmed)) continue;
    if (/^<!--.*-->\s*$/.test(trimmed)) continue;

    counts[current]++;
  }

  const total =
    counts.interpretations +
    counts.deviations +
    counts.tradeoffs +
    counts.open_questions;
  return { ...counts, total };
}

// parseMemoryEntries — the per-entry companion to parseMemoryHeadings (used
// by the learning-gate surface step, which needs each entry's ts /
// summary / context, not just counts). It reuses parseMemoryHeadings' exact
// skip logic (in-fence toggle, four canonical-heading anchors, non-canonical
// H2 section termination, blockquote/comment/blank skip) so the invariant
// `parseMemoryEntries(raw).length === parseMemoryHeadings(raw).total` holds
// for ANY input — ONE entry per counted line, NO multi-line merging. A
// wrapped/continuation line that does not match the canonical
// `- <ISO> — <summary>; <context>` shape degrades into its own degenerate
// entry (summary = the raw line, ts/context empty) rather than merging into
// the preceding entry, preserving the count invariant.
export function parseMemoryEntries(raw: string): Array<{
  heading: "Interpretations" | "Deviations" | "Tradeoffs" | "Open questions";
  ts: string;
  summary: string;
  context: string;
  raw: string;
}> {
  if (typeof raw !== "string") {
    throw new Error(`parseMemoryEntries expected string, got ${typeof raw}`);
  }

  const HEADING_TO_DISPLAY: Record<
    string,
    "Interpretations" | "Deviations" | "Tradeoffs" | "Open questions"
  > = {
    "## Interpretations": "Interpretations",
    "## Deviations": "Deviations",
    "## Tradeoffs": "Tradeoffs",
    "## Open questions": "Open questions",
  };

  const normalized = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const entries: Array<{
    heading: "Interpretations" | "Deviations" | "Tradeoffs" | "Open questions";
    ts: string;
    summary: string;
    context: string;
    raw: string;
  }> = [];

  let current:
    | "Interpretations"
    | "Deviations"
    | "Tradeoffs"
    | "Open questions"
    | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (line in HEADING_TO_DISPLAY) {
      current = HEADING_TO_DISPLAY[line];
      continue;
    }
    if (/^## /.test(line)) {
      current = null;
      continue;
    }

    if (current === null) continue;

    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^>/.test(trimmed)) continue;
    if (/^<!--.*-->\s*$/.test(trimmed)) continue;

    // Counted line → one entry. Parse the canonical bullet shape; degrade to
    // raw on any deviation (never throw).
    const { ts, summary, context } = parseMemoryEntryLine(trimmed);
    entries.push({ heading: current, ts, summary, context, raw: trimmed });
  }

  return entries;
}

// Split a single counted memory line into ts / summary / context. The
// canonical shape is `- <ISO> — <summary>; <context>` (stage-protocol.md
// :876-879). Tolerates a missing `;` (tail → summary, context empty) and a
// missing ts/em-dash (degrade to summary = the whole line, ts empty).
function parseMemoryEntryLine(trimmed: string): {
  ts: string;
  summary: string;
  context: string;
} {
  // Strip a leading list bullet ("- " or "* ").
  const body = trimmed.replace(/^[-*]\s+/, "");
  // Pull an ISO-8601 timestamp prefix followed by an em-dash separator.
  const tsMatch = body.match(/^(\S+)\s+—\s+(.*)$/);
  if (!tsMatch) {
    return { ts: "", summary: body, context: "" };
  }
  const ts = tsMatch[1];
  const rest = tsMatch[2];
  const semi = rest.indexOf(";");
  if (semi === -1) {
    return { ts, summary: rest.trim(), context: "" };
  }
  return {
    ts,
    summary: rest.slice(0, semi).trim(),
    context: rest.slice(semi + 1).trim(),
  };
}

// emitStageFrontmatter is the inverse — turns a StageFrontmatter-shaped
// object back into YAML bytes. Symmetric with parseStageFrontmatter:
// parse → emit → parse yields the same object. Field order is pinned
// to stage-definition.md:84-110's worked example so diffs stay stable.
export function emitStageFrontmatter(obj: Record<string, unknown>): string {
  const needsQuote = (v: string): boolean => /[:#]|^\s|\s$/.test(v);
  const emitScalar = (v: string): string =>
    needsQuote(v) ? `"${v.replace(/"/g, '\\"')}"` : v;

  const FIELD_ORDER = [
    "slug",
    "phase",
    "execution",
    "condition",
    "lead_agent",
    "support_agents",
    "mode",
    "reviewer",
    "reviewer_max_iterations",
    "for_each",
    "produces",
    "consumes",
    "requires_stage",
    "sensors",
    "scopes",
    "inputs",
    "outputs",
  ] as const;

  const lines: string[] = ["---"];

  for (const key of FIELD_ORDER) {
    const v: unknown = obj[key];
    if (v === undefined) continue;

    if (key === "consumes") {
      if (!Array.isArray(v)) continue;
      const consumes: unknown[] = v;
      if (consumes.length === 0) {
        lines.push("consumes: []");
      } else {
        lines.push("consumes:");
        for (const entry of consumes) {
          if (!isPlainObject(entry)) continue;
          const e = entry;
          if (typeof e.artifact === "string") {
            lines.push(`  - artifact: ${emitScalar(e.artifact)}`);
          }
          if (typeof e.required === "boolean") {
            lines.push(`    required: ${e.required}`);
          }
          if (typeof e.conditional_on === "string") {
            lines.push(`    conditional_on: ${emitScalar(e.conditional_on)}`);
          }
        }
      }
    } else if (Array.isArray(v)) {
      const arr: unknown[] = v;
      if (arr.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of arr) {
          lines.push(`  - ${typeof item === "string" ? emitScalar(item) : String(item)}`);
        }
      }
    } else if (typeof v === "string") {
      lines.push(`${key}: ${emitScalar(v)}`);
    } else if (typeof v === "number") {
      // reviewer_max_iterations round-trips as an unquoted number, matching
      // how stages author it on disk (`reviewer_max_iterations: 2`). Without
      // this branch the numeric value the parser now returns (V1) would be
      // dropped on emit, breaking the parse -> emit -> parse contract (t65).
      lines.push(`${key}: ${v}`);
    }
  }

  lines.push("---");
  return `${lines.join("\n")}\n`;
}

// Nested-object list parser. Matches the specific shape stage-definition.md
// uses for consumes[]:
//
//   consumes:
//     - artifact: intent-statement
//       required: true
//     - artifact: feasibility-assessment
//       required: false
//       conditional_on: brownfield
//
// Each `- ` item starts a new object; indented `k: v` lines add fields
// to the current object. Booleans coerce from "true"/"false"; quoted
// strings have their quotes stripped. Rejects deeper nesting, anchors,
// and block scalars — same strictness philosophy as listField above.
//
// The trailing alternation `(?:\r?\n|$)` is required because the
// enclosing frontmatter extractor strips the newline before the
// closing `---`, so the last line of a consumes[] block often has no
// trailing `\n` at match time. Without `|$` the regex silently drops
// it.
function objectListField(
  fm: string,
  key: string
): Array<Record<string, unknown>> {
  const blockRe = new RegExp(
    `^${key}:\\s*\\n((?:[ \\t]+-[ \\t]+[^\\n]+(?:\\r?\\n|$)(?:[ \\t]+[^- \\t\\n][^\\n]*(?:\\r?\\n|$))*)+)`,
    "m"
  );
  const m = fm.match(blockRe);
  if (!m) return [];

  // Detect blank lines inside the block — the outer regex stops at the
  // first blank line, so a blank between items would silently drop the
  // second item. Rather than skip quietly, look ahead past the captured
  // block: if the next lines are still indented with `- ` items, the
  // author wrote a blank separator — reject it.
  const blockEnd = (m.index ?? 0) + m[0].length;
  const rest = fm.slice(blockEnd).split(/\r?\n/);
  for (const line of rest) {
    if (line === "" || /^[ \t]+$/.test(line)) continue;
    if (/^[ \t]+-[ \t]/.test(line)) {
      throw new Error(
        `Blank line not allowed inside ${key}[] block — list items must be consecutive`
      );
    }
    break;
  }

  const lines = m[1].split(/\r?\n/).filter((l) => l.trim() !== "");
  const items: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;

  for (const line of lines) {
    const itemMatch = line.match(/^\s*-\s+([a-z_]+):\s*(.+?)\s*$/);
    const subMatch = line.match(/^\s+([a-z_]+):\s*(.+?)\s*$/);

    if (itemMatch) {
      if (current) items.push(current);
      current = {};
      current[itemMatch[1]] = coerceScalar(itemMatch[2]);
    } else if (subMatch && current) {
      current[subMatch[1]] = coerceScalar(subMatch[2]);
    } else {
      throw new Error(
        `Malformed ${key}[] entry in frontmatter: ${line.trim()}`
      );
    }
  }
  if (current) items.push(current);
  return items;
}

// Scalar coercion for objectListField values. Quoted scalars always
// return as strings (the quote-strip happens AFTER the boolean check),
// so unquoted `true` → boolean, quoted `"true"` → string "true".
// Matches scalarField's quote-stripping rules.
function coerceScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

// --- Stage graph queries ---

export function findStageBySlug(slug: string): StageEntry | undefined {
  return loadStageGraph().find((s) => s.slug === slug);
}

export function findStageByNumber(num: string): StageEntry | undefined {
  return loadStageGraph().find((s) => s.number === num);
}

export function resolveStage(slugOrNumber: string): StageEntry | undefined {
  return findStageBySlug(slugOrNumber) || findStageByNumber(slugOrNumber);
}

export function stageIndex(slug: string): number {
  return loadStageGraph().findIndex((s) => s.slug === slug);
}

// When stateContent is provided, the state file's per-stage EXECUTE/SKIP
// suffix and checkbox state override the scope-mapping.json defaults. This
// matters for Greenfield bugfix flows where handleInit stamps
// reverse-engineering SKIP (even though scope-mapping.json maps it EXECUTE)
// and for jumps that skipped stages via `[S]`. Without the override the
// state tool would try to activate a stage the state file said was done.
export function nextInScopeStage(
  afterSlug: string,
  scope: string,
  stateContent?: string
): StageEntry | null {
  const mapping = loadScopeMapping()[scope];
  if (!mapping) return null;

  const stateOverrides = stateContent
    ? parseStateStageSuffixes(stateContent)
    : null;
  const checkboxStates = stateContent ? parseCheckboxes(stateContent) : [];

  // Walk the full graph forward from afterSlug, applying the same action-
  // resolution rule the pre-rewire implementation used: state overrides
  // take precedence over scope-mapping. The common case (no overrides,
  // or only SKIP overrides) produces byte-identical output to
  // subgraphForScope-based iteration — proven by t66 walk parity across
  // all 9 scopes. The uncommon case (a hand-edited state file promoting
  // a scope-SKIP stage to EXECUTE) is the power-user escape hatch
  // aidlc-state.ts:276-284's explicit-advance path also honours; keeping
  // both callers consistent on the same input.
  const graph = loadStageGraph();
  const currentIdx = graph.findIndex((s) => s.slug === afterSlug);
  if (currentIdx === -1) return null;

  for (let i = currentIdx + 1; i < graph.length; i++) {
    const slug = graph[i].slug;

    // Already completed or skipped via jump — keep walking.
    const cb = checkboxStates.find((c) => c.slug === slug);
    if (cb && (cb.state === "completed" || cb.state === "skipped")) continue;

    // State override wins over scope-mapping. A SKIP override drops an
    // EXECUTE stage; an EXECUTE override promotes a SKIP stage.
    const effectiveAction = stateOverrides?.get(slug) ?? mapping.stages[slug];
    if (effectiveAction === "EXECUTE") return graph[i];
  }
  return null;
}

// Parse the "- [x] slug — EXECUTE" / "— SKIP" suffix from Stage Progress. The
// suffix is set by `aidlc-utility init` per scope + Greenfield/Brownfield
// overrides, then preserved across stage transitions — it represents the
// plan, not the current run-state (checkbox letters are separate).
export function parseStateStageSuffixes(
  content: string
): Map<string, "EXECUTE" | "SKIP"> {
  const out = new Map<string, "EXECUTE" | "SKIP">();
  const regex = /^- \[[ xSR?-]\] (\S+)\s*—\s*(EXECUTE|SKIP)\b/gm;
  let m: RegExpExecArray | null = regex.exec(content);
  while (m !== null) {
    // The regex's second capture group only matches "EXECUTE" or "SKIP";
    // narrow via predicate so the Map.set call is fully typed.
    const action = m[2];
    if (action === "EXECUTE" || action === "SKIP") {
      out.set(m[1], action);
    }
    m = regex.exec(content);
  }
  return out;
}

export function firstInScopeStageOfPhase(
  phase: string,
  scope: string
): StageEntry | null {
  const mapping = loadScopeMapping()[scope];
  if (!mapping) return null;

  // Lazy require to avoid circular import (aidlc-graph imports from us).
  // Type-only import at top of file pins the signature.
  const { subgraphForScope } = require("./aidlc-graph.ts") as {
    subgraphForScope: typeof SubgraphForScope;
  };
  const path = subgraphForScope(scope);

  const phaseLower = phase.toLowerCase();
  for (const stage of path) {
    if (stage.phase === phaseLower) return stage;
  }
  return null;
}

export function stagesInScope(
  scope: string
): Array<{ slug: string; phase: string; action: "EXECUTE" | "SKIP" }> {
  const graph = loadStageGraph();
  if (!loadScopeMapping()[scope]) return [];

  // Lazy require to avoid circular import (aidlc-graph imports from us).
  const { subgraphForScope } = require("./aidlc-graph.ts") as {
    subgraphForScope: typeof SubgraphForScope;
  };
  const onPath = new Set(
    subgraphForScope(scope).map((s) => s.slug)
  );

  return graph.map((s) => ({
    slug: s.slug,
    phase: s.phase,
    action: onPath.has(s.slug) ? ("EXECUTE" as const) : ("SKIP" as const),
  }));
}

// --- Timestamp ---

export function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- Hook drop counter ---
//
// Hooks swallow audit emission errors to avoid breaking the user's tool call,
// but silent failure was the whole point of the state-machine refactor.
// Record drops to a per-hook counter file so `--doctor` can surface them.
// File format: one ISO timestamp per line, most recent drop last.

export function recordHookDrop(
  projectDir: string,
  hookName: string,
  reason: string
): void {
  try {
    const healthDir = join(projectDir, "aidlc-docs", ".aidlc-hooks-health");
    mkdirSync(healthDir, { recursive: true });
    const dropFile = join(healthDir, `${hookName}.drops`);
    const line = `${isoTimestamp()}\t${reason.replace(/\r?\n/g, " ")}\n`;
    appendFileSync(dropFile, line, "utf-8");
  } catch {
    // Drop-log failure is truly non-fatal — we're already in a failure path.
  }
}

// Recursion guard: if emitError is entered while emitting ERROR_LOGGED fails,
// do not re-enter. The guard is process-local (one flag) — tools exit after
// one error(), so nested error() calls inside a single process are bugs.
let _errorEmitInProgress = false;

// Centralised error-exit used by all tool CLIs. Emits ERROR_LOGGED (best-
// effort, no-op if no workflow in cwd, swallows any audit failure), prints
// JSON error to stderr, exits 1.
//
// `tool`    — tool name (e.g. "aidlc-state", "aidlc-jump")
// `command` — the failing subcommand + args (typically process.argv.slice(2).join(" "))
// `msg`     — human-readable error shown to the caller and recorded in audit
//
// Uses appendAuditEntry (the canonical audit emitter) so the drift test's
// forward/reverse check sees ERROR_LOGGED as a standard emission call site.
// Type-only import for the lazy-loaded aidlc-audit.ts dependency. Same
// pattern as aidlc-graph.ts above — the runtime cycle is broken by
// require() below; type erases at compile time.
import type {
  appendAuditEntry as AppendAuditEntry,
  appendAuditEntryUnlocked as AppendAuditEntryUnlocked,
} from "./aidlc-audit.ts";

// Failures are swallowed — we're already exiting, the caller gets the JSON
// error on stderr regardless.
export function emitError(
  projectDir: string,
  tool: string,
  command: string,
  msg: string
): never {
  if (!_errorEmitInProgress) {
    _errorEmitInProgress = true;
    try {
      if (existsSync(stateFilePath(projectDir))) {
        // Lazy import to break the lib.ts ↔ aidlc-audit.ts cycle at load time.
        // aidlc-audit.ts imports from lib.ts, and importing it at top of lib.ts
        // would create a circular dependency. Dynamic import is synchronous via
        // require under Bun and keeps the dependency one-way at module-init time.
        const audit = require("./aidlc-audit.ts") as {
          appendAuditEntry: typeof AppendAuditEntry;
          appendAuditEntryUnlocked: typeof AppendAuditEntryUnlocked;
        };
        // If we're inside a withAuditLock-held critical section (e.g., the
        // caller is aidlc-state.ts fork/merge mid-transaction), the audit
        // lock is already held by us. Use the unlocked variant directly so
        // the ERROR_LOGGED row lands without the 5s acquire timeout. The
        // exit-handler safety net releases the lock dir on process.exit.
        if (AUDIT_LOCK_EXIT_HANDLERS.has(projectDir)) {
          audit.appendAuditEntryUnlocked("ERROR_LOGGED", {
            Tool: tool,
            Command: command,
            Error: msg,
          }, projectDir);
        } else {
          audit.appendAuditEntry("ERROR_LOGGED", {
            Tool: tool,
            Command: command,
            Error: msg,
          }, projectDir);
        }
      }
    } catch {
      // Audit write failed — we're already in an error path, swallow.
    }
  }
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

// --- Helpers ---

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- CLI argument parsing ---

export function parseArgs(args: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i += 2;
      } else {
        flags[key] = "true";
        i++;
      }
    } else {
      positional.push(args[i]);
      i++;
    }
  }
  return { positional, flags };
}

// --- Repeated field collection for --field key=value ---

export function parseFieldArgs(args: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--field" && i + 1 < args.length) {
      const eqIdx = args[i + 1].indexOf("=");
      if (eqIdx > 0) {
        fields[args[i + 1].slice(0, eqIdx)] = args[i + 1].slice(eqIdx + 1);
      }
      i++;
    }
  }
  return fields;
}

// --- Markdown section helpers ---
// Used by practices-discovery affirmation (copy under ## Mandated /
// ## Forbidden) and the orchestrator (reads aidlc-team.md sections for
// stance lookup). Pure string operations against well-formed markdown.
// Caller is responsible for code-fence-free input — rules/aidlc-*.md
// never contain fenced ## lines per spec.
//
// Heading-match rules:
//   - Pass the full marker form ("## Walking Skeleton") as `heading`.
//   - Trailing whitespace on the actual heading line is tolerated.
//   - Sub-headings (`### Walking Skeleton`) never match `## Walking Skeleton`.
//   - On multiple matches of the same heading, the first wins.
//   - When the heading is absent, extract returns "" and append throws.

export function extractMarkdownSection(content: string, heading: string): string {
  // Returns the prose between `heading` (e.g. "## Walking Skeleton") and the
  // next `## ` heading at the same level (or end of file). The heading line
  // itself is not included in the output. Returns "" if heading is absent.
  // Headings inside fenced code blocks (```) are skipped — a teaching example
  // that contains `## Walking Skeleton` should not be mistaken for the actual
  // section.
  const stripped = stripFencedCodeBlocks(content);
  const headingRegex = new RegExp(
    `^${escapeRegex(heading)}[ \\t]*$`,
    "m",
  );
  const startMatch = headingRegex.exec(stripped);
  if (!startMatch) return "";
  const afterHeading = startMatch.index + startMatch[0].length;
  // Skip the newline immediately after the heading line, if any.
  const bodyStart = stripped[afterHeading] === "\n" ? afterHeading + 1 : afterHeading;
  // Find the next `## ` heading at the same level (not `### ` or deeper).
  const nextHeading = /^## [^\n]*$/m;
  nextHeading.lastIndex = bodyStart;
  const remainder = stripped.slice(bodyStart);
  const nextMatch = nextHeading.exec(remainder);
  const bodyEnd = nextMatch ? bodyStart + nextMatch.index : stripped.length;
  return stripped.slice(bodyStart, bodyEnd);
}

// Replace the contents of fenced code blocks (```...```) with blank lines of
// the same count, preserving line numbers and byte offsets up to a few chars
// per line. Headings inside fenced code blocks are no longer matched by
// regex scans against the returned string. Used by extractMarkdownSection to
// keep teaching-example `## Heading` lines from masquerading as real headings.
function stripFencedCodeBlocks(content: string): string {
  const lines = content.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      inFence = !inFence;
      lines[i] = "";
      continue;
    }
    if (inFence) lines[i] = "";
  }
  return lines.join("\n");
}

export function appendUnderHeading(
  content: string,
  heading: string,
  newContent: string,
): string {
  // Inserts `newContent` immediately before the next `## ` heading after
  // `heading` (or at end-of-file when `heading` is the last `## ` section).
  // Throws if `heading` is not present in `content`.
  const headingRegex = new RegExp(
    `^${escapeRegex(heading)}[ \\t]*$`,
    "m",
  );
  const startMatch = headingRegex.exec(content);
  if (!startMatch) {
    throw new Error(`appendUnderHeading: heading not found: ${heading}`);
  }
  const afterHeading = startMatch.index + startMatch[0].length;
  const bodyStart = content[afterHeading] === "\n" ? afterHeading + 1 : afterHeading;
  const nextHeading = /^## [^\n]*$/m;
  const remainder = content.slice(bodyStart);
  const nextMatch = nextHeading.exec(remainder);
  const insertAt = nextMatch ? bodyStart + nextMatch.index : content.length;
  return content.slice(0, insertAt) + newContent + content.slice(insertAt);
}

export function replaceSection(
  content: string,
  heading: string,
  newContent: string,
): string {
  // Replaces the prose between `heading` and the next `## ` heading (or EOF)
  // with `newContent`. The heading line itself is preserved. Throws if
  // `heading` is not present. Used by practices-discovery affirmation:
  // re-runs overwrite aidlc-team.md sections rather than accumulating duplicates.
  const headingRegex = new RegExp(
    `^${escapeRegex(heading)}[ \\t]*$`,
    "m",
  );
  const startMatch = headingRegex.exec(content);
  if (!startMatch) {
    throw new Error(`replaceSection: heading not found: ${heading}`);
  }
  const afterHeading = startMatch.index + startMatch[0].length;
  const bodyStart = content[afterHeading] === "\n" ? afterHeading + 1 : afterHeading;
  const nextHeading = /^## [^\n]*$/m;
  const remainder = content.slice(bodyStart);
  const nextMatch = nextHeading.exec(remainder);
  const bodyEnd = nextMatch ? bodyStart + nextMatch.index : content.length;
  return content.slice(0, bodyStart) + newContent + content.slice(bodyEnd);
}

// --- Bolt/unit dependency DAG (units-generation 2.7 → runtime compile) ---

export interface UnitDependencyEdge {
  name: string;
  depends_on: string[];
}

// Discriminated result so the two consumers — the required-sections sensor
// (gate-time validation) and aidlc-runtime compile (DAG emission) — branch on
// one single source of truth:
//   - absent    : no fenced ```yaml units: block in the body
//   - malformed : block present but structurally invalid (duplicate name,
//                 dangling dependency, self-dependency, non-list value, no units)
//   - cyclic    : structurally valid edges that contain a dependency cycle
//   - ok        : units + batches (topological levels; each level sorted
//                 lexicographically; units with satisfied, non-mutual deps
//                 share a batch)
export type BoltDagParse =
  | { ok: true; units: UnitDependencyEdge[]; batches: string[][] }
  | { ok: false; reason: "absent" | "malformed" | "cyclic"; detail: string };

// Locate the first fenced ```yaml block whose body declares a top-level
// `units:` key. Returns the inner block text, or null when no such fence
// exists. Other fenced blocks (mermaid diagrams, prose examples) are skipped.
function extractYamlUnitsBlock(body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^```ya?ml\s*$/.test(lines[i].trim())) {
      const inner: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^```\s*$/.test(lines[j].trim())) break;
        inner.push(lines[j]);
      }
      const block = inner.join("\n");
      if (/^\s*units\s*:/m.test(block)) {
        return block;
      }
      i = j; // not the units block — resume scanning past its close fence
    }
  }
  return null;
}

function unquoteScalar(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineDepsList(raw: string): string[] {
  const t = raw.trim();
  if (t === "" || t === "[]") return [];
  if (t.startsWith("[") && t.endsWith("]")) {
    return t
      .slice(1, -1)
      .split(",")
      .map((s) => unquoteScalar(s))
      .filter((s) => s !== "");
  }
  // Bare scalar (rare) — treat as a one-item list.
  return [unquoteScalar(t)];
}

// Hand-rolled zero-dep scanner for the `units:` block list. Mirrors the
// scalarField / listField primitives above (the framework ships no YAML
// dependency). Throws on a structurally unparseable block; the caller maps
// the throw to a `malformed` result.
function parseUnitsBlock(block: string): UnitDependencyEdge[] {
  const lines = block.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^\s*units\s*:/.test(lines[i])) {
      const after = lines[i].replace(/^\s*units\s*:/, "").trim();
      if (after !== "") {
        throw new Error("units: must be a block list, not an inline value");
      }
      break;
    }
  }
  if (i >= lines.length) throw new Error("missing units: key");
  i++; // step past the `units:` line

  const edges: UnitDependencyEdge[] = [];
  let current: UnitDependencyEdge | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const nameMatch = line.match(/^\s*-\s+name\s*:\s*(.+?)\s*$/);
    if (nameMatch) {
      if (current) edges.push(current);
      current = { name: unquoteScalar(nameMatch[1]), depends_on: [] };
      continue;
    }

    const depMatch = line.match(/^\s*depends_on\s*:\s*(.*)$/);
    if (depMatch) {
      if (!current) throw new Error("depends_on: before any - name: entry");
      current.depends_on = parseInlineDepsList(depMatch[1]);
      continue;
    }

    // Block-form dependency item (a bare `- dep` under `depends_on:`).
    const itemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (itemMatch && current) {
      current.depends_on.push(unquoteScalar(itemMatch[1]));
      continue;
    }

    throw new Error(`unrecognised line in units block: ${line.trim()}`);
  }
  if (current) edges.push(current);

  for (const e of edges) {
    // Reject empty AND whitespace-only names — a quoted `"   "` survives
    // unquoteScalar with literal spaces and would otherwise become a
    // meaningless valid unit (and dependency target).
    if (!e.name.trim()) throw new Error("unit with empty name");
  }
  return edges;
}

// Kahn's algorithm by level. Each level is a batch — the units whose
// dependencies are all already placed (satisfied, non-mutual). Levels are
// sorted lexicographically before emission so the output is deterministic
// regardless of input order or Set iteration order. Returns null when a
// cycle remains (no unit has all dependencies satisfied).
function computeBatches(edges: UnitDependencyEdge[]): string[][] | null {
  const deps = new Map<string, string[]>();
  for (const e of edges) deps.set(e.name, e.depends_on);
  const remaining = new Set(edges.map((e) => e.name));
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const level: string[] = [];
    for (const name of remaining) {
      const satisfied = deps.get(name)!.every((dep) => !remaining.has(dep));
      if (satisfied) level.push(name);
    }
    if (level.length === 0) return null; // cycle
    level.sort();
    for (const name of level) remaining.delete(name);
    batches.push(level);
  }
  return batches;
}

// Parse the required fenced ```yaml edge block out of a
// unit-of-work-dependency.md body and compute the topological batch DAG.
//
// The block shape — authored once at the 2.7 gate (knowledge work by the
// LLM, behind a human approval gate):
//
//   ```yaml
//   units:
//     - name: auth
//       depends_on: []
//     - name: api
//       depends_on: [auth]
//   ```
//
// Pure data — no model call, no NLP. A given body always parses to the same
// result, so a hook-fired re-compile of runtime-graph.json stays
// byte-identical (no model in the path; the determinism invariant holds).
export function parseBoltDag(body: string): BoltDagParse {
  const block = extractYamlUnitsBlock(body);
  if (block === null) {
    return {
      ok: false,
      reason: "absent",
      detail: "no fenced ```yaml units: block found",
    };
  }

  let edges: UnitDependencyEdge[];
  try {
    edges = parseUnitsBlock(block);
  } catch (e) {
    return { ok: false, reason: "malformed", detail: errorMessage(e) };
  }

  if (edges.length === 0) {
    return { ok: false, reason: "malformed", detail: "units: block has no entries" };
  }

  const names = new Set<string>();
  for (const u of edges) {
    if (names.has(u.name)) {
      return { ok: false, reason: "malformed", detail: `duplicate unit name: ${u.name}` };
    }
    names.add(u.name);
  }
  for (const u of edges) {
    for (const dep of u.depends_on) {
      if (dep === u.name) {
        return { ok: false, reason: "malformed", detail: `unit "${u.name}" depends on itself` };
      }
      if (!names.has(dep)) {
        return {
          ok: false,
          reason: "malformed",
          detail: `unit "${u.name}" depends on unknown unit "${dep}"`,
        };
      }
    }
  }

  const batches = computeBatches(edges);
  if (batches === null) {
    return { ok: false, reason: "cyclic", detail: "dependency cycle detected" };
  }
  return { ok: true, units: edges, batches };
}
