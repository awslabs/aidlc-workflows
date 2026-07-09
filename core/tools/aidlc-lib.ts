import { createHash, randomUUID } from "node:crypto";
import { accessSync, appendFileSync, constants as fsConstants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
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
  // Artifacts the stage MAY write per unit; exempt from the per-unit
  // coverage check in aidlc-orchestrate.ts unitCovered. See GraphStage in
  // aidlc-graph.ts.
  optional_produces?: string[];
  // Per-kind applicability map: artifact name to the unit kinds it applies to.
  // An unlisted artifact applies to all kinds; a listed one is pruned out of a
  // unit whose kind is not in its list (both directive paths and coverage).
  // Absent map = full matrix (every produces entry applies to every unit).
  produces_kinds?: Record<string, string[]>;
  consumes?: Array<{ artifact: string; required: boolean; conditional_on?: string }>;
  requires_stage?: string[];
  scopes?: string[];
  inputs?: string;
  outputs?: string;
  for_each?: string;
  // True for stages that must write source code to the workspace root (not just
  // planning docs under the per-intent record dir). The stage-completion artifact
  // guard (aidlc-state.ts) uses this to require a non-doc workspace file before
  // approve/advance: a code-generation stage that wrote only its markdown
  // produces[] docs but no actual code must not pass (issue #366).
  workspace_requires?: boolean;
}

// The per-unit marker carried by the Construction stages that run once per
// Unit of Work. It lives on the stage's `for_each` field (stage frontmatter,
// compiled onto the GraphStage and into stage-graph.json). The canonical
// 5-stage set (nfr-requirements, nfr-design, functional-design,
// infrastructure-design, code-generation) is the defensive cross-check; the
// node's own `for_each` is the source of truth so a future per-unit stage is
// picked up without editing this file. Exported so both the runtime resolver
// (isPerUnit in aidlc-orchestrate.ts) and the cost summary (gridCostSummary
// below) resolve per-unit identically.
export const PER_UNIT_FOR_EACH = "unit-of-work";
export const KNOWN_PER_UNIT_STAGES: ReadonlySet<string> = new Set([
  "nfr-requirements",
  "nfr-design",
  "functional-design",
  "infrastructure-design",
  "code-generation",
]);

// True when a stage runs once per Unit of Work. Reads the node's own
// `for_each` marker (source of truth); the known-set membership is a defensive
// cross-check so a typo'd marker on one of the five canonical stages still
// resolves per-unit. Structural param so both a GraphStage and a bare
// {slug, for_each} record satisfy it.
export function isPerUnitStage(e: { slug: string; for_each?: string }): boolean {
  return e.for_each === PER_UNIT_FOR_EACH || KNOWN_PER_UNIT_STAGES.has(e.slug);
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

// --- Workspace selectors: space + intent ---------------------------------------
//
// The record (state · audit · artifacts · diary) re-roots per INTENT under a
// per-team SPACE: `aidlc/spaces/<space>/intents/<slug>-<id8>/…`. Two cursors
// pick the active space/intent, both GITIGNORED (per-user, not shared truth):
//   - `aidlc/active-space`                            → the active space
//   - `aidlc/spaces/<space>/intents/active-intent`    → that space's active intent
//
// Resolution precedence (vision §5):
//   space:  explicit arg > active-space pointer > "default" (NEVER errors).
//   intent: explicit arg > active-intent pointer > lone-intent > null.
//
// NULL RESOLUTION (P9 end state — no flat root). When NO intent record resolves
// (activeIntent() → null: a fresh SEED shell before auto-birth, or a flat project
// still awaiting migration), the absolute path helpers resolve to the bare SPACE
// record root (aidlc/spaces/<space>/intents/ — see spaceRecordRoot). No
// aidlc-state.md ever lives directly there, so existence-gated consumers
// (loadStateFileIfPresent) read "no workflow yet" and the orchestrator
// births/errors. The ONLY surviving flat `aidlc-docs` read is the one-time
// migration's SOURCE (flatStateSource/flatMigrationSource below).
// activeIntent() returning null IS that "no record yet" signal.

export const ACTIVE_SPACE_POINTER = "active-space";
export const ACTIVE_INTENT_POINTER = "active-intent";
export const DEFAULT_SPACE = "default";

// --- Terminal-command classification (the deterministic-dispatch seam) ---
//
// A small set of `/aidlc` commands are TERMINAL: they map 1:1 to an
// `aidlc-utility.ts` subcommand that runs a tool, prints its output, and stops —
// they carry NO workflow work and never advance an intent. The orchestration
// engine's `next` already routes these to a terminal `print` directive
// (handleNext Branch 1 + 1b). They are exported HERE so a pre-LLM harness seam
// (e.g. the Kiro userPromptSubmit hook) can dispatch them deterministically off
// the SAME classification the engine uses — never a divergent hardcoded list.
//
//   - read-only utility flags: matched ANYWHERE in the args (mirrors the engine's
//     parseNextFlags, which sets `readOnly` on any matching token). Each maps to
//     its subcommand by stripping the leading `--` (--status→status, …).
//   - workspace navigation verbs: matched ONLY as the LEADING token (i === 0), so
//     freeform prose merely containing "space"/"intent" stays intent text. The
//     optional <name> arg is args[1] when present and not itself a --flag.
export const READ_ONLY_FLAGS: ReadonlySet<string> = new Set([
  "--status",
  "--help",
  "--doctor",
  "--version",
]);
export const WORKSPACE_VERBS: ReadonlySet<string> = new Set([
  "space",
  "space-create",
  "intent",
]);
// Slugs a record (intent or space) may never take. "help" is grammar: the
// router treats `intent help` / `space help` as a help request, so a record
// with that slug would be unswitchable by name. Refusing it at the creation
// chokepoints (birthIntent, handleSpaceCreate) keeps the namespace and the
// grammar from ever colliding.
export const RESERVED_RECORD_NAMES: ReadonlySet<string> = new Set(["help"]);

// A classified terminal command: the aidlc-utility.ts subcommand to run, plus an
// optional positional arg (the <name> for a workspace verb). `source` records
// which family matched, for diagnostics.
export interface TerminalCommand {
  subcommand: string;
  arg?: string;
  source: "read-only-flag" | "workspace-verb";
}

// Classify the post-`/aidlc` argument tokens. Returns the terminal command to run
// deterministically, or null when the input is NOT a terminal command (freeform
// intent text, a --scope/--stage/--phase jump, a config/scope change, birth — all
// of which carry workflow work and MUST go through the engine + conductor). The
// matching rules are byte-for-byte the engine's parseNextFlags terminal branches
// (read-only flag anywhere; workspace verb only at index 0) so the seam and the
// engine can never disagree about what is terminal.
export function classifyTerminalCommand(args: string[]): TerminalCommand | null {
  // A SOLE bare `help` / `-h` token is a help REQUEST (terminal, read-only);
  // mirrors parseNextFlags in the engine. Without this the token reads as
  // freeform intent text and the funnel offers to birth an intent named
  // "help". Sole-token only: `help` inside a longer description stays freeform.
  if (args.length === 1 && (args[0] === "help" || args[0] === "-h")) {
    return { subcommand: "help", source: "read-only-flag" };
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (READ_ONLY_FLAGS.has(a)) {
      return { subcommand: a.replace(/^--/, ""), source: "read-only-flag" };
    }
    if (i === 0 && WORKSPACE_VERBS.has(a)) {
      const next = args[i + 1];
      const arg = next !== undefined && !next.startsWith("--") ? next : undefined;
      // `intent help`/`-h` / `space help`/`-h` is a help request, not a switch
      // to a record named "help" (no per-verb help exists; the failed switch's
      // error text steers the conductor into birthing an intent, and "help" is
      // a reserved record name - see RESERVED_RECORD_NAMES). Mirrors
      // parseNextFlags. space-create is excluded: its handler refuses a
      // help-shaped name itself rather than silently printing help (the
      // reserved-name guard alone would miss "-h", which slugifies to "h").
      if ((a === "intent" || a === "space") && (arg === "help" || arg === "-h")) {
        return { subcommand: "help", source: "read-only-flag" };
      }
      return arg !== undefined
        ? { subcommand: a, arg, source: "workspace-verb" }
        : { subcommand: a, source: "workspace-verb" };
    }
  }
  return null;
}

// `aidlc/` — the harness-neutral workspace roof (memory · codekb · knowledge ·
// intents live under spaces/<space>/ here; the engine stays in <harness>/).
function workspaceRoot(projectDir: string): string {
  return join(projectDir, "aidlc");
}

// The active space for this project. Reads the `aidlc/active-space` cursor;
// defaults to "default". NEVER throws — the default space is always valid even
// when nothing is on disk yet (the resolver tolerates an absent space dir).
export function activeSpace(projectDir: string): string {
  const ptr = join(workspaceRoot(projectDir), ACTIVE_SPACE_POINTER);
  try {
    const raw = readFileSync(ptr, "utf-8").trim();
    if (raw.length > 0) return raw;
  } catch {
    // no cursor → default
  }
  return DEFAULT_SPACE;
}

// `aidlc/spaces/<space>/intents` — the intent registry + record root.
export function intentsDir(projectDir: string, space?: string): string {
  const sp = space ?? activeSpace(projectDir);
  return join(workspaceRoot(projectDir), "spaces", sp, "intents");
}

// `aidlc/spaces/<space>/knowledge` — SPACE DOMAIN knowledge (durable, free-form,
// team-authored, empty at bootstrap). A space-level sibling of memory/codekb/
// intents (vision §"Spaces": "its own memory, codekb, knowledge, and intent
// record") — NOT per-intent: domain knowledge accumulates across every intent in
// the space, so it must not live inside one intent's record. Distinct from the
// engine's per-agent METHODOLOGY knowledge at <harness>/knowledge/ (shipped,
// untouched). Created lazily by ensure-exists, never by SEED.
export function knowledgeDir(projectDir: string, space?: string): string {
  const sp = space ?? activeSpace(projectDir);
  return join(workspaceRoot(projectDir), "spaces", sp, "knowledge");
}

// Enumerate the intent RECORD directories in a space (each `<slug>-<id8>/`
// holding an aidlc-state.md). Returns the bare directory names, sorted; [] when
// the space has no intents dir or no records yet. The intents.json registry is
// the canonical list for humans/ordering — this on-disk scan is the cheap
// "does any record exist?" signal the path resolver and migration detector need
// (it must not depend on the registry being present).
export function listIntentDirs(projectDir: string, space?: string): string[] {
  const dir = intentsDir(projectDir, space);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const records: string[] = [];
  for (const name of entries) {
    // A record dir holds aidlc-state.md; skip the active-intent cursor,
    // intents.json, and any stray files.
    if (existsSync(join(dir, name, "aidlc-state.md"))) records.push(name);
  }
  return records.sort();
}

// The active intent's RECORD directory NAME (`<slug>-<id8>`) for a space, or
// null when no record resolves (→ the path helpers resolve the bare space record
// root). Precedence: explicit > active-intent cursor (if it names a real record)
// > lone intent. Returns null rather than throwing on ambiguity so the path
// helpers stay total; the verb/handler layer (P4) owns the error/prompt for the
// >1-intent-no-cursor case.
export function activeIntent(
  projectDir: string,
  space?: string,
  explicit?: string,
): string | null {
  const sp = space ?? activeSpace(projectDir);
  const dir = intentsDir(projectDir, sp);
  if (explicit) return explicit;
  // Cursor: a real record the pointer names.
  try {
    const raw = readFileSync(join(dir, ACTIVE_INTENT_POINTER), "utf-8").trim();
    if (raw.length > 0 && existsSync(join(dir, raw, "aidlc-state.md"))) return raw;
  } catch {
    // no cursor → fall through to lone-intent
  }
  const records = listIntentDirs(projectDir, sp);
  if (records.length === 1) return records[0];
  // 0 records → null (bare space root); >1 with no cursor → null (the handler
  // layer prompts; a path helper cannot guess which intent the caller meant).
  return null;
}

// The absolute RECORD directory for an intent:
// `aidlc/spaces/<space>/intents/<slug>-<id8>/`. Returns null when no intent
// resolves, signalling the bare-space-root resolution in the path helpers.
export function recordDir(
  projectDir: string,
  intent?: string,
  space?: string,
): string | null {
  const sp = space ?? activeSpace(projectDir);
  const slug = activeIntent(projectDir, sp, intent);
  if (slug === null) return null;
  return join(intentsDir(projectDir, sp), slug);
}

// Relative record-dir prefix for the engine's agent-consumed artifact/diary
// paths: `aidlc/spaces/<space>/intents/<slug>-<id8>` with forward slashes
// regardless of host OS (portable across worktrees). Returns null → the engine
// resolvers resolve the bare space-relative record prefix
// (relativeSpaceRecordPrefix). The space + intent come from the active cursors
// unless passed explicitly; the engine threads the active intent's record-dir
// name in (it knows projectDir but the resolvers themselves take no projectDir —
// see aidlc-orchestrate.ts).
export function relativeRecordDir(
  projectDir: string,
  intent?: string,
  space?: string,
): string | null {
  const sp = space ?? activeSpace(projectDir);
  const slug = activeIntent(projectDir, sp, intent);
  if (slug === null) return null;
  return `aidlc/spaces/${sp}/intents/${slug}`;
}

// `aidlc/spaces/<space>/codekb/<repo>/` — the durable per-repo code
// knowledge base, a space-level sibling of memory/knowledge/intents (vision
// §Spaces; committed glob aidlc/spaces/*/codekb/**). NOT per-intent: it is keyed
// by repo and shared across every intent in the space, so it must NOT carry the
// intents/<slug> tail. Mirrors knowledgeDir's space-aware shape.
export function codekbDir(projectDir: string, repo: string, space?: string): string {
  const sp = space ?? activeSpace(projectDir);
  return join(workspaceRoot(projectDir), "spaces", sp, "codekb", repo);
}

// Relative analog of codekbDir (posix slashes), the engine-emitted form
// the conductor/subagent reads. Mirrors relativeRecordDir (takes projectDir so it
// can read the active-space cursor — NOT relativeSpaceRecordPrefix, which is
// pinned to the default space).
export function relativeCodekbDir(projectDir: string, repo: string, space?: string): string {
  const sp = space ?? activeSpace(projectDir);
  return `aidlc/spaces/${sp}/codekb/${repo}`;
}

// The deterministic repo NAME for codekb keying (NOT the intent slug):
//   1 recorded repo  -> that name
//   0 recorded repos (workspace root IS the repo) -> basename(projectDir)
//   >1 recorded      -> caller loops per repo (this returns basename as a safe
//                       default; callers that know the repo pass --repo explicitly).
// basename done here (lib has basename imported) so callers never inline it.
export function codekbRepoName(projectDir: string, space?: string): string {
  const repos = intentRepos(projectDir, undefined, space);
  return repos.length === 1 ? repos[0] : basename(projectDir);
}

// The bare SPACE record root: `aidlc/spaces/<space>/intents/`. The absolute path
// helpers resolve here when no intent record exists (activeIntent → null) — a
// fresh SEED shell before auto-birth, or a flat project still awaiting migration.
// No aidlc-state.md ever lives directly here, so existence-gated readers
// (loadStateFileIfPresent) see "no workflow yet" and the orchestrator
// births/errors. This is the P9 end state — there is no flat `aidlc-docs/` root.
function spaceRecordRoot(projectDir: string, space?: string): string {
  return intentsDir(projectDir, space);
}

// The bare space-RELATIVE record prefix (posix slashes) — the relative analog of
// spaceRecordRoot, used by the engine/worktree resolvers when no per-intent
// record prefix is threaded. The relative resolvers take no projectDir, so they
// cannot read the active-space cursor and default to `default` (the same
// single-string limitation the old flat relative prefix had — not a regression;
// a non-default space threads relativeRecordDir explicitly).
export function relativeSpaceRecordPrefix(space: string = DEFAULT_SPACE): string {
  return `aidlc/spaces/${space}/intents`;
}

// --- Intent identity: UUIDv7 + slugify ----------------------------------------
//
// The canonical intent id is a UUIDv7 (time-ordered, globally unique, merge-safe,
// stable across a slug rename). The dir name is `<slug>-<id8>` where id8 is the
// trailing 8 hex of the uuid (a derived disambiguator). A within-space clash
// resolves by the next-longer prefix of the SAME uuid (id8→id10→…), never a
// re-mint.

// Generate a UUIDv7: a 48-bit Unix-ms timestamp prefix + version 7 nibble +
// random/variant tail. Sorting by uuid string is creation order. Uses new Date()
// for the timestamp (permitted; isoTimestamp does the same) and randomUUID() for
// the random + variant bits (no Math.random): take the v4 uuid's 32 hex digits,
// overwrite the first 12 (the timestamp) and the 13th (the version nibble → 7),
// and keep digits 13..31 (which include the v4 variant nibble) cryptographically
// sourced.
export function uuidv7(): string {
  const hex = randomUUID().replace(/-/g, ""); // 32 hex chars, v4
  const ms = new Date().getTime();
  const tsHex = ms.toString(16).padStart(12, "0").slice(-12); // 48 bits = 12 hex
  const body = `${tsHex}7${hex.slice(13)}`; // ts(12) + version(1) + tail(19)
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}`;
}

// The id8 disambiguator: trailing 8 hex chars of the uuid (digits only, dashes
// stripped). Used in the `<slug>-<id8>` dir name.
export function idSuffix(uuid: string, length = 8): string {
  const hex = uuid.replace(/-/g, "");
  return hex.slice(-length);
}

// Deterministic free-text → SLUG_RE-valid kebab: lowercase; non-alphanumerics →
// hyphens; collapse + trim hyphens; cap length; ensure a leading letter. Pure +
// idempotent (slugify(slugify(x)) === slugify(x)). Falls back to "intent" when
// the input reduces to empty.
export function slugify(text: string, maxLength = 48): string {
  let s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  // Ensure a leading LETTER (SLUG_RE = /^[a-z][a-z0-9-]*$/).
  if (!/^[a-z]/.test(s)) s = `intent-${s}`.replace(/-+$/g, "");
  if (s.length === 0) s = "intent";
  return s;
}

// --- Intent record dir name: <YYMMDD>-<short-label> ---------------------------
//
// SPIKE (date-prefix). The record dir name leads with a compact UTC date so the
// records sort CHRONOLOGICALLY in any file browser / `ls` (the time token is a
// PREFIX, where lexicographic sort = creation order — a suffix would sort by the
// label). The label is a SHORT human slug (cap 24, vs the old 48) — the
// orchestrator is expected to pass a 2-3 word essence ("simple calc"), not the
// full request sentence. Uniqueness within the space is the caller's collision
// loop (a -N counter), NOT this name: the canonical, collision-proof id stays the
// UUIDv7 in the registry row, and the row now stores this dirName verbatim (so the
// readers never reconstruct it from slug+uuid).

// The human-readable LABEL for a record dir name, for display/orphan rows when
// no registry row supplies a slug. SPIKE (date-prefix): strip a leading `YYMMDD-`
// date prefix; else strip a legacy trailing `-<hex>` id8. Falls back to the whole
// name if neither shape matches.
export function displaySlugFromDirName(dirName: string): string {
  const dated = /^\d{6}-(.+)$/.exec(dirName);
  if (dated) return dated[1];
  return dirName.replace(/-[0-9a-f]+$/, "");
}

// Compact UTC date stamp YYMMDD. UTC (not local) so the stamp is reproducible
// regardless of the clone's timezone — matches isoTimestamp's UTC basis.
export function dateStamp(date: Date = new Date()): string {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// Build the BASE record dir name `<YYMMDD>-<short-label>` (pre-collision). The
// label is slugified with the tighter 24-char cap. Starts with a DIGIT — legal,
// since no SLUG_RE validates the intent dir name (those guard the bolt/stage/
// artifact slugs). The collision loop appends `-2`, `-3`, … to this base.
export function intentDirNameBase(label: string, date: Date = new Date()): string {
  return `${dateStamp(date)}-${slugify(label, 24)}`;
}

// Resolve a within-space dir clash by appending a numeric counter: `<base>`,
// `<base>-2`, `<base>-3`, … (the date prefix has no hex tail to extend, unlike the
// pre-spike scheme). Two intents born the same day with the same short label is
// the only collision case; the counter keeps the readable name AND uniqueness, and
// the canonical id is still the row's UUIDv7. Returns the first free name.
//
// Bounded by MAX_DIR_COLLISIONS: 998 same-day same-label intents is not a real
// workflow — it is a bug or a pathological caller (e.g. a script birthing in a
// loop with a constant label). Fail LOUD with a diagnostic rather than spin, so
// the cause surfaces. Safe to throw here: the caller holds the workspace lock via
// withAuditLock, which releases in its `finally` (and an on-exit net), so the
// throw unwinds without leaking the lock.
export function resolveUniqueIntentDir(intentsRoot: string, base: string): string {
  if (!existsSync(join(intentsRoot, base))) return base;
  const MAX_DIR_COLLISIONS = 1000;
  for (let n = 2; n < MAX_DIR_COLLISIONS; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(join(intentsRoot, candidate))) return candidate;
  }
  throw new Error(
    `Could not find a free intent record dir for "${base}" after ${MAX_DIR_COLLISIONS} attempts in ${intentsRoot}. ` +
      `This many same-day intents with the same label indicates a bug or a runaway caller — pass a distinct --label.`,
  );
}

// --- Flat-layout migration (one-time, lock-guarded, crash-safe) ---------------
//
// A pre-workspace project keeps its record at the flat `aidlc-docs/` root. This
// moves it ONCE into a per-intent record dir under spaces/default/. Two review
// blockers shaped the design (vision plan P1 migration box):
//
//  (1) DETECTION keys on a signal SEED does NOT ship: a flat `aidlc-docs/
//      aidlc-state.md` present AND no `aidlc/spaces/*/intents/*/aidlc-state.md`
//      record yet AND no `.migrated` marker. (SEED ships `aidlc/spaces/default/`,
//      so "no spaces dir" would never fire and would orphan the legacy tree.)
//  (2) IDEMPOTENCY keys on the `.migrated` marker ALONE (written LAST), never on
//      `aidlc/spaces/` existence — a crash after the parent mkdir but before the
//      move completes must re-detect and re-stage from the untouched original.
//
// MECHANISM (all inside withAuditLock on the WORKSPACE bucket): mint a UUIDv7;
// slug from existing state or "default"; (1) stage a COPY of the whole aidlc-docs/
// tree into a temp dir UNDER the workspace root (same filesystem — NOT tmpdir(),
// or a cross-device rename degrades to non-atomic); (2) mkdir the intent dir's
// PARENT chain; (3) ONE atomic rename of the staged tree into the leaf
// <slug>-<id8>/ (the leaf is created BY this rename); (4) append to intents.json
// + set active-intent; (5) write the `.migrated` marker LAST. The flat tree is
// git-rm'd post-move (the data MOVED, not deleted); the source is NEVER rmSync'd.
//
// THE ONE SURVIVING `aidlc-docs` READ. P9 removed the transitional dual-layout
// fallback — the record tree is now a SINGLE per-intent layout. The ONLY place
// the legacy flat `aidlc-docs/` root is still read is this one-time migration:
// needsFlatMigration() probes flatStateSource() and migrateFlatLayout() moves
// flatMigrationSource(). These two private helpers localise that read so the
// grep gate's `aidlc-docs` allowlist in core code is exactly this constant.
const FLAT_MIGRATION_ROOT = "aidlc-docs";

function flatMigrationSource(projectDir: string): string {
  return join(projectDir, FLAT_MIGRATION_ROOT);
}

function flatStateSource(projectDir: string): string {
  return join(flatMigrationSource(projectDir), "aidlc-state.md");
}

export const MIGRATED_MARKER = ".migrated";

// The marker path: `aidlc/.migrated` (workspace-level, committed, idempotency key).
export function migratedMarkerPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), MIGRATED_MARKER);
}

// Does this project need a flat→per-intent migration? Detection per blocker (1).
export function needsFlatMigration(projectDir: string): boolean {
  // Marker present → already migrated (idempotency key, blocker 2).
  if (existsSync(migratedMarkerPath(projectDir))) return false;
  // No flat state → nothing to migrate (a fresh SEED shell, or already moved).
  // This is the migration DETECTION trigger — the sole legitimate read of the
  // legacy flat state path (allowlisted in the grep gate).
  const flatState = flatStateSource(projectDir);
  if (!existsSync(flatState)) return false;
  // Any new-layout intent RECORD already present → migration ran (or a fresh
  // born intent exists); do not move a second tree on top of it.
  if (anyIntentRecordExists(projectDir)) return false;
  return true;
}

// True iff any space already holds an intent record (a `<dir>/aidlc-state.md`).
// Scans aidlc/spaces/*/intents/*/aidlc-state.md WITHOUT relying on the registry.
export function anyIntentRecordExists(projectDir: string): boolean {
  const spacesRoot = join(workspaceRoot(projectDir), "spaces");
  let spaces: string[];
  try {
    spaces = readdirSync(spacesRoot);
  } catch {
    return false;
  }
  for (const sp of spaces) {
    if (listIntentDirs(projectDir, sp).length > 0) return true;
  }
  return false;
}

// Append an intent to the space's intents.json registry (creating it if absent).
// MUST be called under the WORKSPACE lock bucket (invariant 2) — the registry is
// shared workspace-level truth. Each row: {uuid, slug, scope, repos, status}.
export interface IntentRegistryEntry {
  uuid: string;
  slug: string;
  // The on-disk record dir name. SPIKE (date-prefix): stored verbatim at birth so
  // readers join a row to its dir DIRECTLY, never reconstructing it from slug+uuid
  // (the date-prefixed name `<YYMMDD>-<label>` is not derivable from {slug,uuid}).
  // Optional for back-compat: pre-spike rows (and hand-written fixtures) omit it,
  // and recordDirMatches() falls back to the legacy `<slug>-<id8>` hex match.
  dirName?: string;
  scope?: string;
  repos?: string[];
  status: string;
}

// Does record dir `dirName` belong to registry row `entry`? The single shared
// join rule for every row→dir matcher (listIntents/updateIntentStatus/intentRepos).
// SPIKE (date-prefix): prefer the stored `entry.dirName` (exact match); fall back
// to the legacy `<slug>-<id8>` shape (slug prefix + trailing hex that is a prefix
// of the uuid's id-suffix) so pre-spike rows and fixtures still resolve.
export function recordDirMatches(entry: IntentRegistryEntry, dirName: string): boolean {
  if (entry.dirName) return entry.dirName === dirName;
  if (!dirName.startsWith(`${entry.slug}-`)) return false;
  const suffix = dirName.slice(entry.slug.length + 1);
  return /^[0-9a-f]+$/.test(suffix) && idSuffix(entry.uuid, suffix.length) === suffix;
}

export function intentsRegistryPath(projectDir: string, space?: string): string {
  return join(intentsDir(projectDir, space), "intents.json");
}

export function appendIntentToRegistry(
  projectDir: string,
  entry: IntentRegistryEntry,
  space?: string,
): void {
  const path = intentsRegistryPath(projectDir, space);
  let list: IntentRegistryEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(parsed)) list = parsed as IntentRegistryEntry[];
  } catch {
    // absent / malformed → start a fresh list
  }
  list.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(list, null, 2)}\n`);
}

// The `aidlc/spaces` root — the parent of every space dir. Sole helper so the
// "what spaces exist?" scan and the intent-record scan agree on one location.
export function spacesRoot(projectDir: string): string {
  return join(workspaceRoot(projectDir), "spaces");
}

// Read a space's intents.json registry as a typed list. Returns [] when the
// file is absent or malformed (same tolerance as appendIntentToRegistry). The
// canonical "what intents exist" record for humans/ordering/status — the cheap
// on-disk listIntentDirs() scan is the path-resolver's record-presence signal,
// but the registry carries the uuid/status/scope/repos a human or the --json
// consumer needs.
export function readIntentRegistry(projectDir: string, space?: string): IntentRegistryEntry[] {
  const path = intentsRegistryPath(projectDir, space);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(parsed)) return parsed as IntentRegistryEntry[];
  } catch {
    // absent / malformed → empty
  }
  return [];
}

// --- The deterministic query layer: "what exists" (one source, two modes) ----
//
// listSpaces()/listIntents() are the single shared readers the verb handlers,
// the auto-birth gate, the resume-rebind, and the statusline all call (P4
// query-layer box). Pure reads — they never mutate. A space exists iff its dir
// is present under aidlc/spaces/; an intent's authoritative row is the
// registry, joined with the on-disk record presence.

export interface SpaceInfo {
  name: string;
  active: boolean;
}

// Enumerate the spaces (dir names under aidlc/spaces/), sorted, each flagged
// active per the active-space cursor. "default" is always reported even when no
// spaces dir exists yet (the resolver treats it as always-valid — activeSpace()
// returns it), so the listing never claims zero spaces on a fresh shell.
export function listSpaces(projectDir: string): SpaceInfo[] {
  const active = activeSpace(projectDir);
  const names = new Set<string>([DEFAULT_SPACE]);
  try {
    for (const name of readdirSync(spacesRoot(projectDir))) {
      if (statSync(join(spacesRoot(projectDir), name)).isDirectory()) names.add(name);
    }
  } catch {
    // no spaces dir → just the always-present default
  }
  return [...names].sort().map((name) => ({ name, active: name === active }));
}

export interface IntentInfo {
  uuid: string;
  slug: string;
  status: string;
  scope?: string;
  repos?: string[];
  dirName: string | null; // the on-disk <slug>-<id8> record dir, or null if registry-only
  active: boolean;
}

// Enumerate a space's intents from the registry, joined with the on-disk record
// dirs, each flagged active per the active-intent cursor. The registry is the
// ordering/identity source; the dir-name is matched by the id8 disambiguator
// suffix so a registry row resolves to its record dir even when the slug was
// later renamed. A record dir with no registry row (a hand-created or migrated
// orphan) is appended so the listing never hides an on-disk intent.
export function listIntents(projectDir: string, space?: string): IntentInfo[] {
  const sp = space ?? activeSpace(projectDir);
  const registry = readIntentRegistry(projectDir, sp);
  const dirs = listIntentDirs(projectDir, sp);
  // activeIntent() returns the record DIR NAME of the active intent (or null).
  const activeDir = activeIntent(projectDir, sp);
  const claimedDirs = new Set<string>();
  const infos: IntentInfo[] = registry.map((entry) => {
    // Match the row to its record dir via the shared join rule (stored dirName,
    // else the legacy `<slug>-<id8>` shape).
    const dirName = dirs.find((d) => recordDirMatches(entry, d)) ?? null;
    if (dirName) claimedDirs.add(dirName);
    return {
      uuid: entry.uuid,
      slug: entry.slug,
      status: entry.status,
      scope: entry.scope,
      repos: entry.repos,
      dirName,
      active: dirName !== null && dirName === activeDir,
    };
  });
  // On-disk records with no registry row (orphans) — surface them too.
  for (const d of dirs) {
    if (claimedDirs.has(d)) continue;
    infos.push({
      uuid: "",
      slug: displaySlugFromDirName(d),
      status: "unknown",
      dirName: d,
      active: d === activeDir,
    });
  }
  return infos;
}

// Write the active-intent cursor for a space (gitignored per-user pointer).
// Best-effort: the cursor dir is created if absent; a write failure is swallowed
// (the cursor is per-user state, never the source of truth — the registry is).
export function setActiveIntentCursor(projectDir: string, dirName: string, space?: string): void {
  const dir = intentsDir(projectDir, space);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ACTIVE_INTENT_POINTER), `${dirName}\n`, "utf-8");
  } catch {
    /* per-user cursor; best-effort */
  }
}

// Write the active-space cursor (gitignored per-user pointer). Best-effort.
export function setActiveSpaceCursor(projectDir: string, name: string): void {
  try {
    mkdirSync(workspaceRoot(projectDir), { recursive: true });
    writeFileSync(join(workspaceRoot(projectDir), ACTIVE_SPACE_POINTER), `${name}\n`, "utf-8");
  } catch {
    /* per-user cursor; best-effort */
  }
}

// --- Per-conversation session→intent record (resume rebind, P8) --------------
//
// A conversation (one Claude Code `session_id`) works ONE intent at a time, but
// the active-intent CURSOR is per-user, durable, and shared across sessions — so
// resuming an A-chat after the cursor moved to B would otherwise silently inject
// B's context (the central multi-space hazard, vision §3). The fix is a tiny
// per-user, machine-local map: at session START stamp the working intent's UUID
// keyed by session_id; on RESUME, compare the stamped UUID to the live cursor
// and OFFER a rebind on mismatch. The map lives at `aidlc/.aidlc-sessions/`
// (gitignored — see dot-gitignore `aidlc/.aidlc-sessions/`): it is per-user
// runtime state, never shared truth. The intent record itself is the durable,
// harness-neutral artifact; the session merely enriches the cursor on resume.
export const SESSIONS_DIR = ".aidlc-sessions";

function sessionsDir(projectDir: string): string {
  return join(workspaceRoot(projectDir), SESSIONS_DIR);
}

// The per-session record file: `aidlc/.aidlc-sessions/<session-id>`. The
// session id is normalised to the slug shape so a host-supplied id can never
// escape the sessions dir (path traversal / separators); an empty id yields "".
function sessionRecordPath(projectDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) return "";
  return join(sessionsDir(projectDir), safe);
}

// Read the intent UUID this conversation last stamped, or null. Best-effort.
export function readSessionIntentUuid(projectDir: string, sessionId: string): string | null {
  const path = sessionRecordPath(projectDir, sessionId);
  if (!path) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

// Stamp the intent UUID this conversation is working into its session record.
// Best-effort (per-user runtime state; a write failure degrades to "no offer on
// the next resume", never breaks the hook). A blank uuid clears nothing — the
// caller only stamps when an intent actually resolves.
export function writeSessionIntentUuid(projectDir: string, sessionId: string, uuid: string): void {
  const path = sessionRecordPath(projectDir, sessionId);
  if (!path || !uuid) return;
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
    writeFileSync(path, `${uuid}\n`, "utf-8");
  } catch {
    /* per-user runtime state; best-effort */
  }
}

// The "current session" marker: a FIXED-name file inside the sessions dir naming
// the most-recently-active session id. The per-session STAMP above is keyed by
// session_id (which only the hook sees); a CLI tool like `/aidlc intent <slug>`
// has no session_id, so it cannot re-stamp the live session's record on its own.
// This marker is the bridge: the hook writes it on EVERY fire (so it always names
// the live conversation), and the switch tool reads it to learn which session to
// re-stamp. Lives beside the per-session records under `aidlc/.aidlc-sessions/`
// (gitignored — dot-gitignore `aidlc/.aidlc-sessions/`): per-user runtime state.
export const CURRENT_SESSION_FILE = ".current-session";

function currentSessionPath(projectDir: string): string {
  return join(sessionsDir(projectDir), CURRENT_SESSION_FILE);
}

// Read the most-recently-active session id, or null. Best-effort.
export function readCurrentSessionId(projectDir: string): string | null {
  try {
    const raw = readFileSync(currentSessionPath(projectDir), "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

// Record the most-recently-active session id. Best-effort; no-op on a blank id
// (a TTY/empty hook invocation has no session to record).
export function writeCurrentSessionId(projectDir: string, sessionId: string): void {
  if (!sessionId) return;
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
    writeFileSync(currentSessionPath(projectDir), `${sessionId}\n`, "utf-8");
  } catch {
    /* per-user runtime state; best-effort */
  }
}

// The UUID of the active intent in a space (the cursor's / lone intent's
// registry row), or null when no new-layout intent resolves (flat-legacy) or
// the active record has no registry row (an orphan — no stable uuid to stamp).
export function activeIntentUuid(projectDir: string, space?: string): string | null {
  const sp = space ?? activeSpace(projectDir);
  const activeDir = activeIntent(projectDir, sp);
  if (activeDir === null) return null;
  const match = listIntents(projectDir, sp).find((i) => i.dirName === activeDir);
  return match && match.uuid ? match.uuid : null;
}

// Resolve an intent UUID to its registry row across EVERY space (a conversation
// may have been working an intent in a different space than the active one).
// Returns the {space, slug} of the first match, or null when the uuid names no
// known intent (a stale stamp from a since-deleted intent → no rebind offer).
export function findIntentByUuid(
  projectDir: string,
  uuid: string,
): { space: string; slug: string } | null {
  if (!uuid) return null;
  for (const sp of listSpaces(projectDir)) {
    const row = readIntentRegistry(projectDir, sp.name).find((e) => e.uuid === uuid);
    if (row) return { space: sp.name, slug: row.slug };
  }
  return null;
}

// --- Intent birth: the deterministic mutation behind the engine's directive ---
//
// birthIntent() is the single deterministic primitive the `intent-birth` tool
// handler calls: mint a UUIDv7, create the record dir, append the registry row,
// set the active-intent cursor. It does NOT emit audit events or write the
// aidlc-state.md body (the handler owns those, since they need the scope graph)
// — it owns only the identity + dir + registry + cursor, the parts that must be
// crash-safe and clash-free. The CALLER MUST already hold the WORKSPACE lock
// (invariant 2: every intents.json mutation takes the workspace bucket); a
// concurrent birth is serialized by that lock, so the within-space dir-clash
// disambiguation here only ever resolves a same-uuid id8 collision, never a
// cross-process race.
export interface BornIntent {
  uuid: string;
  slug: string;
  dirName: string;
  recordDir: string;
  space: string;
}

export function birthIntent(
  projectDir: string,
  label: string,
  space: string,
  scope?: string,
  repos?: string[],
): BornIntent {
  const uuid = uuidv7();
  const intentsRoot = intentsDir(projectDir, space);
  // SPIKE (date-prefix): the dir name is `<YYMMDD>-<short-label>`, the `label` arg
  // being the orchestrator's 2-3 word essence. Normalize it ONCE to the slug shape
  // so the stored row `slug`, the dir-name label, and the display all agree even
  // when the caller passes raw text (cap 24). A same-day same-label clash resolves
  // by a numeric counter (never re-mints).
  const slug = slugify(label, 24);
  if (RESERVED_RECORD_NAMES.has(slug)) {
    throw new Error(
      `"${slug}" is a reserved name and cannot be an intent label. Pick a label that describes the work.`
    );
  }
  const dirName = resolveUniqueIntentDir(intentsRoot, `${dateStamp()}-${slug}`);
  const recordPath = join(intentsRoot, dirName);
  mkdirSync(recordPath, { recursive: true });
  // BIND the record so the resolvers recognize it immediately: activeIntent()
  // only treats a record dir as real once it holds an aidlc-state.md (the cursor
  // + lone-intent checks both gate on existsSync(<dir>/aidlc-state.md)). Birth
  // mkdir's the dir, but the full state body is written AFTER birth by the
  // caller (handleIntentBirth, via the default-resolving writeStateFile). Write
  // a header-only stub here so the cursor resolves to THIS record between mint
  // and the full write — without it, activeIntent() returns null and the
  // post-birth state/audit writes leak to the flat fallback (a bootstrap gap).
  const statePath = join(recordPath, "aidlc-state.md");
  if (!existsSync(statePath)) {
    writeFileSync(statePath, "# AI-DLC State Tracking\n", "utf-8");
  }
  appendIntentToRegistry(
    projectDir,
    // An empty repo set (no --repos, no sibling discovery — the legacy single-repo
    // or fresh-greenfield case) records NO repos row; the lone repo is inferred on
    // the construction path (resolveConstructionRepo). Only a non-empty set is
    // persisted, so existing single-repo + flat-legacy intents stay byte-identical.
    { uuid, slug, dirName, scope, repos: repos && repos.length > 0 ? repos : undefined, status: "in-flight" },
    space,
  );
  setActiveIntentCursor(projectDir, dirName, space);
  return { uuid, slug, dirName, recordDir: recordPath, space };
}

// Flip an intent's registry row to a terminal/other status (e.g. "complete").
// Matches the row by record DIR NAME (the stable identity the cursor/state use),
// rewriting intents.json in place. MUST be called under the WORKSPACE lock
// (invariant 2). Returns true iff a row matched and was updated. No-op (false)
// when the intent is the legacy flat record (dirName null) or no row matches.
export function updateIntentStatus(
  projectDir: string,
  dirName: string,
  status: string,
  space?: string,
): boolean {
  const sp = space ?? activeSpace(projectDir);
  const path = intentsRegistryPath(projectDir, sp);
  const list = readIntentRegistry(projectDir, sp);
  let changed = false;
  for (const entry of list) {
    // Match the active dirName via the shared join rule listIntents() uses.
    if (!recordDirMatches(entry, dirName)) continue;
    if (entry.status !== status) {
      entry.status = status;
      changed = true;
    }
    break;
  }
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(list, null, 2)}\n`);
  }
  return changed;
}

// Run the flat→per-intent migration if needed. Idempotent. Returns the new
// intent dir name on a migration, or null when none was needed. The caller owns
// the git-rm of the flat tree (a tool can shell out to git; lib stays
// git-agnostic) — migrateFlatLayout returns the moved-from path so the caller
// can untrack it. NEVER rmSync's the source: the staged COPY is renamed into the
// leaf, leaving the original aidlc-docs/ for the git-rm step.
export interface FlatMigrationResult {
  intentDirName: string;
  uuid: string;
  slug: string;
  movedFrom: string; // the flat aidlc-docs/ path, for the caller's git-rm
}

export function migrateFlatLayout(projectDir: string): FlatMigrationResult | null {
  // Whole operation under the WORKSPACE lock bucket (intent omitted → sentinel).
  return withAuditLock(projectDir, () => {
    // Re-check inside the lock (another clone may have migrated while we waited).
    if (!needsFlatMigration(projectDir)) return null;

    const flatRoot = flatMigrationSource(projectDir);
    const flatState = join(flatRoot, "aidlc-state.md");

    // Slug from the existing state's most slug-worthy field, else "default".
    // Prefer an explicit intent/workflow name, then the human project name; the
    // bare scope token (feature/bugfix/…) is the last resort before "default".
    let slug = "default";
    try {
      const content = readFileSync(flatState, "utf-8");
      const name =
        getField(content, "Workflow") ??
        getField(content, "Intent") ??
        getField(content, "Project") ??
        getField(content, "Scope") ??
        "";
      if (name.trim().length > 0) slug = slugify(name);
    } catch {
      // unreadable state → keep "default"
    }

    const uuid = uuidv7();
    const space = DEFAULT_SPACE;
    const intentsRoot = intentsDir(projectDir, space);
    // SPIKE (date-prefix): same `<YYMMDD>-<short-label>` shape as birthIntent, with
    // a numeric-counter collision resolve.
    const intentDirName = resolveUniqueIntentDir(intentsRoot, intentDirNameBase(slug));
    const leaf = join(intentsRoot, intentDirName);

    // (1) Stage a COPY of the whole flat tree into a temp dir UNDER the workspace
    // root (same filesystem → the rename in step 3 is atomic, not a cross-device
    // copy+unlink). A unique per-process staging name avoids a concurrent clash.
    const staging = join(workspaceRoot(projectDir), `.migrate-staging-${process.pid}-${reapSuffix()}`);
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* no prior staging */
    }
    cpSync(flatRoot, staging, { recursive: true });

    // ── Shape the staged tree to the target layout BEFORE the atomic rename ──
    // CRASH-SAFETY INVARIANT: the rename in step (3) is the SOLE commit point.
    // Everything below operates on the staging tree (or the idempotent, intent-
    // independent space-knowledge move), so the ONLY "partial" window is steps
    // 1-2b — which produce no `aidlc-state.md` under intents/ and no `.migrated`
    // marker, so needsFlatMigration() stays true and a crash re-fires cleanly
    // (step 1 rmSync's any half-built staging first; the flat source is never
    // mutated). Doing these relocations AFTER the rename would strand them in a
    // window where anyIntentRecordExists() has already flipped the detector off.

    // (2a) RELOCATE the staged `audit.md` into the per-clone SHARD layout the
    // readers glob. The blind copy in step 1 lands the flat `aidlc-docs/audit.md`
    // FILE at `<staging>/audit.md`, but auditShards()/readAllAuditShards() read
    // the `<record>/audit/*.md` DIR (auditShardDir), and the flat-fallback fires
    // ONLY when the record dir is absent — which it never is post-migration. Left
    // as a top-level file, the pre-migration WORKFLOW_STARTED/STAGE/PHASE history
    // would be on disk but INVISIBLE to runtime-graph compile, summary/replay, and
    // every hook. Move it INTO the shard set as `audit/<host>-<clone>.md` so it
    // joins the shards the readers already merge-sort (honours decision #1: a
    // per-clone shard, NOT a single committed audit.md + merge=union). Guard the
    // no-audit case (a flat tree with no audit.md) — skip silently.
    const stagedAudit = join(staging, "audit.md");
    if (existsSync(stagedAudit)) {
      const shardDir = join(staging, "audit");
      mkdirSync(shardDir, { recursive: true });
      renameSync(stagedAudit, join(shardDir, auditShardName(projectDir)));
    }

    // (2b) RELOCATE the staged `knowledge/` tree to the SPACE level. The old flat
    // layout kept team domain knowledge at `aidlc-docs/knowledge/` (the former
    // scaffold stage seeded `knowledge/README.md` + `knowledge/aidlc-shared/`);
    // the blind copy in step 1 lands it at `<staging>/knowledge/`, but the
    // per-intent record is the WRONG home — knowledge is a space-level concern (a
    // sibling of intents) so it compounds across every intent, and the agent
    // personas read it from `spaces/<space>/knowledge/`. Left in the record, a
    // migrating team's accumulated knowledge would be silently invisible to every
    // agent. Move it up to the space dir (merge into any existing space knowledge,
    // entry-by-entry so a pre-existing dir is preserved) and empty it out of the
    // staging tree so the rename carries no `knowledge/` into the record. This is
    // intent-independent and idempotent — safe to re-apply on a crash re-fire; the
    // flat source is untouched, so the caller's gitRmFlatTree(flatRoot) is intact.
    const stagedKnowledge = join(staging, "knowledge");
    if (existsSync(stagedKnowledge)) {
      const spaceKnowledge = knowledgeDir(projectDir, space);
      mkdirSync(spaceKnowledge, { recursive: true });
      for (const entry of readdirSync(stagedKnowledge)) {
        const from = join(stagedKnowledge, entry);
        const to = join(spaceKnowledge, entry);
        if (existsSync(to)) {
          cpSync(from, to, { recursive: true });
        } else {
          renameSync(from, to);
        }
      }
      rmSync(stagedKnowledge, { recursive: true, force: true });
    }

    // (2c) mkdir the intent dir's PARENT chain (the leaf is created by the rename).
    mkdirSync(intentsRoot, { recursive: true });

    // (3) ONE atomic rename of the now-target-shaped staged tree into the leaf —
    // the single commit point (see the crash-safety invariant above).
    renameSync(staging, leaf);

    // (4) Append to intents.json + set the active-intent cursor (workspace bucket).
    appendIntentToRegistry(
      projectDir,
      { uuid, slug, dirName: intentDirName, scope: undefined, repos: undefined, status: "in-flight" },
      space,
    );
    try {
      writeFileSync(join(intentsRoot, ACTIVE_INTENT_POINTER), `${intentDirName}\n`, "utf-8");
    } catch {
      /* cursor is per-user/gitignored; best-effort */
    }

    // (5) Write the `.migrated` marker LAST (the sole idempotency key).
    mkdirSync(workspaceRoot(projectDir), { recursive: true });
    writeFileSync(migratedMarkerPath(projectDir), `migrated ${isoTimestamp()} → ${intentDirName}\n`, "utf-8");

    return { intentDirName, uuid, slug, movedFrom: flatRoot };
  });
}

// --- Per-intent record resolution (P9 end state — no flat fallback) -----------
//
// Each absolute path helper resolves the per-intent record dir when an intent
// exists (explicit arg, active cursor, or a lone intent), else the bare SPACE
// record root (spaceRecordRoot). There is NO flat `aidlc-docs/` fallback any more
// — the transitional bridge was retired in P9 once the fixtures migrated. The
// only place the legacy flat root is still touched is the one-time migration
// SOURCE (flatStateSource/flatMigrationSource above).

export function stateFilePath(projectDir: string, intent?: string, space?: string): string {
  const dir = recordDir(projectDir, intent, space);
  if (dir === null) return join(spaceRecordRoot(projectDir, space), "aidlc-state.md");
  return join(dir, "aidlc-state.md");
}

// Per-clone audit SHARD path: `…/intents/<slug>-<id8>/audit/<host>-<clone>.md`.
// The audit trail is committed (vision §5.1) but each clone writes its OWN
// shard so git never merge-conflicts concurrent appends (merge=union was proven
// to corrupt the multi-line blocks). Readers glob `audit/*.md` and merge-sort by
// timestamp — see auditShards()/readAllAuditShards(). With no intent resolved the
// shard lands under the bare space record root (no flat audit.md any more).
export function auditFilePath(projectDir: string, intent?: string, space?: string): string {
  const dir = recordDir(projectDir, intent, space);
  if (dir === null) return join(spaceRecordRoot(projectDir, space), "audit", auditShardName(projectDir));
  return join(dir, "audit", auditShardName(projectDir));
}

// The clone-id token file: `aidlc/.aidlc-clone-id`. Workspace-level,
// machine-local, GITIGNORED (see the `aidlc/.aidlc-*` rule) so it never travels
// in a commit — that is what makes the token DISTINCT across clones (a fresh
// checkout has no token file and mints its own). The shard name below embeds
// this token, so every process IN one clone resolves the SAME shard while two
// different clones get DIFFERENT shards (no git merge-conflict on concurrent
// appends — the whole point of per-clone sharding).
export const CLONE_ID_FILE = ".aidlc-clone-id";

function cloneIdPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), CLONE_ID_FILE);
}

// The stable per-CLONE token (not per-process). Read from the gitignored
// `aidlc/.aidlc-clone-id` file when present; minted (12 hex chars from a v4
// uuid — no Math.random) and persisted on first use otherwise. Stable WITHIN a
// clone across processes (the fork subprocess and the merge subprocess both
// read the same file → the same shard), DISTINCT across clones (each clone
// mints its own; the file is gitignored so it doesn't travel). A read/mint race
// between two first-run processes converges on whichever write lands last; both
// then read that single file on every subsequent call, so the clone settles on
// ONE token (a transient duplicate shard on the very first concurrent mint is
// harmless — readers glob `audit/*.md`). Memoized per process. Best-effort: an
// unwritable workspace degrades to an in-memory token for this process (still
// stable within the process, still distinct from other clones).
let _cloneId: string | null = null;
function cloneId(projectDir: string): string {
  if (_cloneId !== null) return _cloneId;
  const path = cloneIdPath(projectDir);
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (/^[a-z0-9]{1,32}$/.test(raw)) {
      _cloneId = raw;
      return _cloneId;
    }
  } catch {
    // no token yet → mint one below
  }
  const minted = randomUUID().replace(/-/g, "").slice(0, 12);
  try {
    mkdirSync(workspaceRoot(projectDir), { recursive: true });
    writeFileSync(path, `${minted}\n`, "utf-8");
    // Re-read so a concurrent first-run mint that landed first wins for ALL
    // processes in this clone (converge on one on-disk token).
    const settled = readFileSync(path, "utf-8").trim();
    _cloneId = /^[a-z0-9]{1,32}$/.test(settled) ? settled : minted;
  } catch {
    _cloneId = minted; // unwritable workspace → in-memory token
  }
  return _cloneId;
}

// --- Human presence at an approval/interview gate ---
//
// Ledger-event presence check (the marker-free design). A real human
// is present for THIS gate-commit iff a HUMAN_TURN event appears AFTER the LAST
// GATE RESOLUTION (GATE_APPROVED / GATE_REJECTED / QUESTION_ANSWERED) in ledger
// append order. The prior resolution is the freshness boundary - this is the
// consume-once semantics expressed as event order instead of a flag.
//
// Why the boundary is the prior RESOLUTION, not this gate's STAGE_AWAITING_APPROVAL
// (the live Kiro IDE spike, 2026-06-30, caught this): in the real flow ONE human
// prompt drives the agent to BOTH open the gate AND approve it, so the human turn
// PRECEDES this gate-open. A "human turn after gate-open" rule false-refuses every
// legitimate approval. But a human turn after the prior gate's resolution still
// proves a fresh human acted this turn, while a fabricated cascade (gate2 approved
// right after gate1 committed, no new human turn) has its only human turn BEFORE
// the gate1 GATE_APPROVED -> refused. Stale (human turn long ago, then a fabricated
// approve) likewise has the last resolution after the human turn -> refused.
//
// Ordering is CHRONOLOGICAL (Timestamp, then buffer position as the tiebreak),
// matching findAllEvents: readAllAuditShards concatenates per-clone shards in
// FILENAME order, so the raw buffer is NOT time-ordered across shards (a second
// shard appears after a re-clone or on another machine) and a raw-position scan
// could rank an OLD resolution from a lexically-later shard above a fresh
// HUMAN_TURN. Within one shard the timestamps are non-decreasing and the position
// tiebreak preserves append order, which is what makes same-second events (the
// common case: one human turn drives mint + gate + resolution inside one second)
// resolve by execution order. Fail-open when no ledger exists (no presence
// tracking yet on this harness).
//
// The resolution boundary is workflow-global (the most recent commit of ANY
// gate), which is what makes a same-turn cascade across DIFFERENT stages refuse
// correctly; there is no per-stage scoping.
const GATE_RESOLUTION_EVENTS = new Set(["GATE_APPROVED", "GATE_REJECTED", "QUESTION_ANSWERED"]);
export function humanActedSinceGate(projectDir: string): boolean {
  const audit = readAllAuditShards(projectDir);
  if (audit.length === 0) return true; // no ledger → no presence tracking → fail open
  const blocks = audit.replace(/\r\n/g, "\n").split(/\n---\n/);
  const events: { ts: string; pos: number; human: boolean }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const ev = auditBlockField(blocks[i], "Event");
    if (!ev) continue;
    if (!GATE_RESOLUTION_EVENTS.has(ev) && ev !== "HUMAN_TURN") continue;
    events.push({
      ts: auditBlockField(blocks[i], "Timestamp") ?? "",
      pos: i,
      human: ev === "HUMAN_TURN",
    });
  }
  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.pos - b.pos;
  });
  let lastResolution = -1;
  let lastHuman = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].human) lastHuman = i;
    else lastResolution = i;
  }
  // A human turn appears after the last gate resolution (or there is a human turn
  // and no resolution yet) => a fresh human acted this turn => allow.
  return lastHuman > lastResolution && lastHuman !== -1;
}

// True when any stage sits at [?] (awaiting-approval) in the state file: the
// "a gate is actually OPEN" predicate for the per-harness preToolUse floors.
// Without it a floor would keep refusing tool calls AFTER a legitimate approval
// (the resolution then follows the turn's only HUMAN_TURN), blocking the
// same-turn continuation the stage protocol mandates.
export function hasOpenGate(stateContent: string | null): boolean {
  if (!stateContent) return false;
  return parseCheckboxes(stateContent).some((c) => c.state === "awaiting-approval");
}

// The interview path (handleAnswer) uses the SAME resolution-boundary check: a
// QUESTION_ANSWERED is itself a gate resolution, so "a human turn since the last
// resolution" gives one-answer-per-human-turn for free. Thin alias for call-site
// readability; both paths share one definition so the predicate cannot drift.
export function humanActedSinceLastAnswer(projectDir: string): boolean {
  return humanActedSinceGate(projectDir);
}

// Read a `**Field**: value` line from one audit block (tolerates an optional
// leading `- ` so it serves both audit blocks and the state file). Mirrors the
// per-tool private auditField readers; shared here for humanActedSinceGate.
export function auditBlockField(block: string, fieldName: string): string | null {
  const prefix = `**${fieldName}**:`;
  for (const raw of block.split("\n")) {
    const line = raw.startsWith("- ") ? raw.slice(2) : raw;
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

// This clone's audit shard filename: `<host>-<clone-id>.md`. The clone-id token
// (not the PID) is the cross-clone disambiguator — stable across every process
// in a clone (so the fork process and the merge process resolve ONE shard) and
// distinct across clones (so concurrent clones never collide / git-conflict).
// hostname() is a human-readable hint only; it can carry dots/uppercase, so
// normalise it to the slug shape it never escapes the audit dir.
let _auditShardName: string | null = null;
export function auditShardName(projectDir: string): string {
  if (_auditShardName !== null) return _auditShardName;
  const host = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "host";
  _auditShardName = `${host}-${cloneId(projectDir)}.md`;
  return _auditShardName;
}

// `…/intents/<slug>-<id8>/audit/` — the shard directory, or null when no intent
// resolves (the bare space root has no audit dir, so an enumerator gets []).
export function auditShardDir(projectDir: string, intent?: string, space?: string): string | null {
  const dir = recordDir(projectDir, intent, space);
  if (dir === null) return null;
  return join(dir, "audit");
}

// Every audit shard path for an intent (sorted). With no intent resolved the
// enumerated dir is the bare space record root's audit/ — absent on a fresh
// shell, so the read is []. Readers merge-sort the parsed events by **Timestamp**.
export function auditShards(projectDir: string, intent?: string, space?: string): string[] {
  const shardDir = auditShardDir(projectDir, intent, space) ?? join(spaceRecordRoot(projectDir, space), "audit");
  let entries: string[];
  try {
    entries = readdirSync(shardDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(shardDir, f));
}

// Concatenate every audit shard's content for an intent into one buffer the
// existing block-parsers (findAllEvents / findLatestEvent — both split on
// `\n---\n`) can walk as if it were one file. Each shard is a self-contained
// sequence of `\n---\n`-separated blocks, so concatenation preserves block
// boundaries; cross-shard ordering by timestamp is the parsers' job (they read
// **Timestamp** per block). Returns "" when no shard exists.
export function readAllAuditShards(projectDir: string, intent?: string, space?: string): string {
  const shards = auditShards(projectDir, intent, space);
  if (shards.length === 0) return "";
  const parts: string[] = [];
  for (const path of shards) {
    try {
      parts.push(readFileSync(path, "utf-8"));
    } catch {
      // a shard vanished between enumerate and read — skip it
    }
  }
  return parts.join("\n");
}

export function worktreePath(projectDir: string, boltSlug: string): string {
  return join(projectDir, ".aidlc", "worktrees", `bolt-${boltSlug}`);
}

// --- Multi-repo: repos are siblings of the workspace ----------------------------
//
// In the workspace model the projectDir is the WORKSPACE roof (`my-workspace/`),
// which is NOT itself a git repo. Code repos are its immediate children
// (`my-workspace/repo-a/`, `my-workspace/repo-b/`) — siblings of `aidlc/` and the
// engine dir (vision §7). An intent records the repos it touches in its
// intents.json row (`repos`); construction targets a specific one. P7 decouples
// "the repo to operate on" from "the single projectDir": before P7 the worktree
// tool ran `git worktree add` in the projectDir's own cwd (assuming projectDir IS
// the repo); now `--repo <name>` anchors it to the sibling repo dir instead.
//
// repoDir resolves the on-disk dir for a repo name; it does NOT validate that the
// dir exists or is a git repo (the caller does, where the git op runs).

// A repo name is a single path segment (no separators, no `..`) so it can only
// resolve to an immediate child of the workspace — never escape it.
export const REPO_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRepoName(name: string): boolean {
  return REPO_NAME_REGEX.test(name) && name !== "." && name !== "..";
}

// The on-disk dir for a sibling repo: an immediate child of the workspace root.
export function repoDir(projectDir: string, repoName: string): string {
  return join(projectDir, repoName);
}

// True iff `dir` looks like a git checkout: it holds a `.git` (a directory for a
// normal clone, OR a file for a submodule / linked worktree). Workspace-internal
// dirs that are never code repos are excluded by the discovery scan, not here.
export function isGitRepoDir(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

// Workspace-internal child dirs that are never code repos — excluded from sibling
// auto-discovery so the engine dir / the aidlc roof / VCS metadata never count as
// a repo. The harness dirs are open-set (isHarnessDirName), checked separately.
const NON_REPO_WORKSPACE_DIRS = new Set([
  "aidlc",
  ".git",
  ".aidlc",
  "node_modules",
]);

// Auto-discover the code repos that are immediate children of the workspace root:
// any child dir holding a `.git`, excluding the workspace's own internal dirs and
// the harness engine dir. Sorted + deduped. Returns [] when the workspace root is
// unreadable or holds no sibling repos (the legacy single-repo / fresh-greenfield
// case — the caller records no repos row and the lone repo is inferred later).
export function discoverSiblingRepos(projectDir: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (NON_REPO_WORKSPACE_DIRS.has(name)) continue;
    if (isHarnessDirName(name)) continue; // .claude / .kiro / .codex
    const dir = join(projectDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isGitRepoDir(dir)) found.push(name);
  }
  return [...new Set(found)].sort();
}

// Resolve the repo set for a new intent at birth: an explicit `--repos a,b` set
// wins (authoritative when the user names them); absent it, sibling auto-discovery
// supplies the default. Each name is validated. Returns [] when neither yields a
// repo (→ no repos row → lone-repo inference). Throws on an invalid explicit name.
export function resolveBirthRepoSet(
  projectDir: string,
  explicitReposCsv?: string,
): string[] {
  if (explicitReposCsv && explicitReposCsv.trim().length > 0) {
    const names = explicitReposCsv
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    for (const name of names) {
      if (!isValidRepoName(name)) {
        throw new Error(
          `Invalid --repos entry "${name}": a repo name must be a single path segment matching ${REPO_NAME_REGEX} (no separators or "..").`,
        );
      }
    }
    return [...new Set(names)].sort();
  }
  return discoverSiblingRepos(projectDir);
}

// The recorded repo set for an intent (its intents.json row's `repos`), or [] when
// none was recorded (legacy single-repo / projectDir-is-the-repo). The lookup
// follows the SAME row→record-dir match listIntents() uses, then falls back to the
// active intent's row when no explicit dirName is given.
export function intentRepos(
  projectDir: string,
  intentDirName?: string | null,
  space?: string,
): string[] {
  const sp = space ?? activeSpace(projectDir);
  const dirName = intentDirName ?? activeIntent(projectDir, sp);
  if (!dirName) return [];
  for (const entry of readIntentRegistry(projectDir, sp)) {
    if (!recordDirMatches(entry, dirName)) continue;
    return entry.repos ?? [];
  }
  return [];
}

export interface RepoResolution {
  // The repo NAME to operate on, or null when the intent records NO repos (the
  // legacy single-repo case → git runs in the projectDir cwd, today's behaviour).
  repo: string | null;
  // The cwd the git op must run in: the sibling repo dir when `repo` is set, else
  // the projectDir (back-compat). The caller passes this as the git invocation cwd.
  cwd: string;
}

// Resolve which repo a CONSTRUCTION op targets, decoupling "the repo to operate
// on" from "the single projectDir":
//   - no recorded repos (legacy / projectDir-is-the-repo): with no --repo, null
//     → cwd=projectDir (back-compat); an explicit --repo is HONOURED as a sibling
//     anchor (cwd = the named sibling dir, repoDir(projectDir, requestedRepo)),
//     for multi-repo ops on an unrecorded intent — not errored.
//   - exactly one recorded repo: inferred (the lone repo); --repo optional but, if
//     given, must match.
//   - multiple recorded repos: --repo is REQUIRED to disambiguate; it must name one
//     of the set.
// Throws (string message) on any disambiguation failure so the tool can surface it.
export function resolveConstructionRepo(
  projectDir: string,
  requestedRepo: string | undefined,
  intentDirName?: string | null,
  space?: string,
): RepoResolution {
  const repos = intentRepos(projectDir, intentDirName, space);
  if (requestedRepo !== undefined) {
    if (!isValidRepoName(requestedRepo)) {
      throw new Error(
        `Invalid --repo "${requestedRepo}": a repo name must be a single path segment matching ${REPO_NAME_REGEX}.`,
      );
    }
    if (repos.length > 0 && !repos.includes(requestedRepo)) {
      throw new Error(
        `--repo "${requestedRepo}" is not in this intent's repo set: ${repos.join(", ")}.`,
      );
    }
    // repos.length === 0 (legacy) AND an explicit --repo: honour it as a sibling
    // anchor (the caller may be operating multi-repo on an unrecorded intent),
    // resolving cwd to the named sibling dir.
    return { repo: requestedRepo, cwd: repoDir(projectDir, requestedRepo) };
  }
  if (repos.length === 0) {
    // Legacy single-repo / projectDir-is-the-repo: run git in projectDir's cwd.
    return { repo: null, cwd: projectDir };
  }
  if (repos.length === 1) {
    return { repo: repos[0], cwd: repoDir(projectDir, repos[0]) };
  }
  throw new Error(
    `This intent spans ${repos.length} repos (${repos.join(", ")}); pass --repo <name> to disambiguate which to operate on.`,
  );
}

// --- Record-tree data-path family ---------------------------------------------
//
// Single chokepoint for every path under the project's record tree. Each helper
// resolves the per-intent RECORD dir (aidlc/spaces/<sp>/intents/<slug>-<id8>/)
// when an intent exists, else the bare space record root (spaceRecordRoot) — the
// P9 end state has no flat `aidlc-docs/` root, so the whole tree stays on ONE
// root per intent (state split across two roots is meaningless). The
// state/audit/worktree helpers above are the load-bearing pair; these cover the
// rest of the family (runtime graph, hook health, recovery breadcrumb, plan,
// stop-hook guard, the bare docs dir, and a stage's per-run directory) plus the
// per-worktree mirror copies.
//
// NOT funnelled here (deliberately): the two engine artifact/diary resolvers in
// aidlc-orchestrate.ts (resolveArtifactPath / memoryPathFor) build RELATIVE,
// agent-consumed paths from backtick templates and take no projectDir — the
// absolute, projectDir-keyed shape here is incompatible with them. They re-root
// via relativeRecordDir() threaded from the engine instead.

// The record-tree ROOT for a project: the per-intent record dir when an intent
// resolves, else the bare space record root (aidlc/spaces/<sp>/intents/). Every
// family helper below joins under this so the whole tree moves with the intent in
// lockstep. Stays total (never throws) so the hooks that call the family at
// module top on a pre-birth shell don't crash.
export function docsRoot(projectDir: string, intent?: string, space?: string): string {
  const dir = recordDir(projectDir, intent, space);
  return dir ?? spaceRecordRoot(projectDir, space);
}

// The bare record-tree root (doctor's existence check, the init scaffolder's
// base dir).
export function docsDir(projectDir: string, intent?: string, space?: string): string {
  return docsRoot(projectDir, intent, space);
}

// `<root>/runtime-graph.json` — the compiled runtime graph.
export function runtimeGraphPath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), "runtime-graph.json");
}

// `<root>/.aidlc-hooks-health` — per-hook heartbeat + drop counters surfaced by
// `--doctor`.
export function hooksHealthDir(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-hooks-health");
}

// `<root>/.aidlc-recovery.md` — the validate-state breadcrumb the orchestrator
// reads on resume.
export function recoveryFilePath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-recovery.md");
}

// `<root>/.aidlc-plan.json` — `aidlc-graph resolve` output.
export function planFilePath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-plan.json");
}

// `<root>/.aidlc-stop-hook` — the Stop hook's durable no-progress guard counter
// directory.
export function stopHookDir(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-stop-hook");
}

// `<projectDir>/aidlc/.aidlc-compose-pending`: the in-flight compose gate
// marker the conductor writes before presenting the approve/edit/reject gate
// and deletes on resolve. It lives at the WORKSPACE level (not a per-intent
// record) so a single spelling is shared by the Stop-hook carve-out (which
// honours it as a turn-stop signal) and the doctor probe (which flags an
// orphaned one). Hoisted here so the path is spelled once.
export function composeMarkerPath(projectDir: string): string {
  return join(projectDir, "aidlc", ".aidlc-compose-pending");
}

// Freshness window for the compose marker. The Stop hook honours the carve-out
// only while the marker's mtime is younger than this; an older marker is an
// orphan (a session that crashed between write and gate-resolve) and is ignored
// plus best-effort cleaned up, so it cannot silently disable forwarding-loop
// enforcement forever. 24h is generous enough to cover a long human pause at an
// open gate while still catching a stranded marker.
export const COMPOSE_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

// `<baseDir>/.aidlc-sensors` — the sensor detail-output / tsbuildinfo directory.
// `baseDir` is the project dir for the dispatcher, or a tsconfig anchor for the
// type-check sensor; callers append a stage slug as needed. The tsconfig-anchor
// caller passes a non-projectDir base, so the record-dir resolution is OPT-OUT:
// only resolve per-intent when the caller passes intent/space context; a bare
// baseDir keeps the flat `.aidlc-sensors` leaf for the type-check anchor case.
export function sensorsDir(baseDir: string, intent?: string, space?: string): string {
  if (intent === undefined && space === undefined) {
    return join(docsRoot(baseDir), ".aidlc-sensors");
  }
  return join(docsRoot(baseDir, intent, space), ".aidlc-sensors");
}

// `<root>/<phase>/<slug>` — a stage's per-run artifact directory (the Stop hook
// scans it for unanswered question files).
export function stageDir(projectDir: string, phase: string, slug: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), phase, slug);
}

// Relative diary path recorded on a runtime-graph row — forward slashes
// regardless of host OS so the schema stays portable across worktrees. Mirrors
// the engine's memoryPathFor. `recordPrefix` is the relative per-intent record
// dir (relativeRecordDir) when one resolves, else null → the bare space record
// prefix (relativeSpaceRecordPrefix). Kept here so the prefix decision funnels
// with the rest of the family.
export function relativeMemoryPath(phase: string, stageSlug: string, recordPrefix?: string | null): string {
  const prefix = recordPrefix ?? relativeSpaceRecordPrefix();
  return `${prefix}/${phase}/${stageSlug}/memory.md`;
}

// `<root>/<phase>/<stageSlug>/memory.md` — the absolute diary path for a stage.
export function memoryFilePath(projectDir: string, phase: string, stageSlug: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), phase, stageSlug, "memory.md");
}

// `<root>/inception/units-generation/unit-of-work-dependency.md` — the fenced
// edge block the Bolt-DAG node is computed from.
export function unitDependencyPath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), "inception", "units-generation", "unit-of-work-dependency.md");
}

// --- Per-worktree mirror copies -----------------------------------------------
//
// A Bolt worktree is a git worktree of the project, so it carries its OWN mirror
// of the record tree at the SAME relative layout as the main checkout: the
// per-intent record dir (aidlc/spaces/<sp>/intents/<slug>-<id8>/) when the Bolt
// forks from an intent, else the bare space record root. These take an
// ALREADY-RESOLVED worktree base dir (the output of worktreePath, or an
// audit-recorded path), not projectDir, plus an optional `recordPrefix` — the
// RELATIVE per-intent record dir (relativeRecordDir) the fork inherited from the
// main intent. When omitted (a caller without intent context yet), the prefix
// falls back to the bare space record root (relativeSpaceRecordPrefix). Fork and
// merge MUST pass the SAME prefix or they read the wrong mirror file.

function worktreeRecordRoot(wtPath: string, recordPrefix?: string | null): string {
  const prefix = recordPrefix ?? relativeSpaceRecordPrefix();
  // recordPrefix is a posix-relative path (forward slashes); split so join
  // produces native separators under wtPath.
  return join(wtPath, ...prefix.split("/"));
}

export function worktreeDocsDir(wtPath: string, recordPrefix?: string | null): string {
  return worktreeRecordRoot(wtPath, recordPrefix);
}

export function worktreeStateFilePath(wtPath: string, recordPrefix?: string | null): string {
  return join(worktreeRecordRoot(wtPath, recordPrefix), "aidlc-state.md");
}

export function worktreeAuditFilePath(wtPath: string, recordPrefix?: string | null, projectDir?: string): string {
  // A worktree clone writes its own audit shard inside the worktree mirror.
  // The shard name embeds the MAIN clone's stable token (projectDir), NOT the
  // worktree's own — the fork and merge subprocesses are both spawned from the
  // main checkout, so threading the main clone-id makes them resolve the SAME
  // worktree shard across the two PIDs. A git worktree is a separate working dir
  // and would otherwise mint its own (ungitignored, untracked) clone-id, so the
  // token MUST come from the main checkout. Fall back to wtPath only when no
  // projectDir is threaded (legacy callers without main context).
  return join(worktreeRecordRoot(wtPath, recordPrefix), "audit", auditShardName(projectDir ?? wtPath));
}

export function worktreeRuntimeGraphPath(wtPath: string, recordPrefix?: string | null): string {
  return join(worktreeRecordRoot(wtPath, recordPrefix), "runtime-graph.json");
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

export function readStateFile(projectDir: string, intent?: string, space?: string): string {
  const path = stateFilePath(projectDir, intent, space);
  if (!existsSync(path)) {
    throw new Error(`State file not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

export function writeStateFile(projectDir: string, content: string, intent?: string, space?: string): void {
  const path = stateFilePath(projectDir, intent, space);
  // A read-only aidlc-state.md is a deliberate write barrier the state tool
  // must honour (a corrupt/locked workspace must fail loud, not silently
  // advance — see the t47/t77/t137 read-only-state failure-injection tests).
  // writeFileAtomic uses tmp+rename, and POSIX rename overwrites a read-only
  // TARGET (it only needs directory-write permission), so it would bypass that
  // barrier. Preserve the bare-writeFileSync EACCES semantics by refusing up
  // front when the target exists but is not writable.
  if (existsSync(path)) accessSync(path, fsConstants.W_OK);
  // Ensure the record dir's parent chain exists before the atomic write — a
  // per-intent record dir's parents (aidlc/spaces/<sp>/intents/<slug>-<id8>/)
  // may not exist yet on first write; the flat fallback's aidlc-docs/ is created
  // by the init scaffolder, but mkdir-recursive is idempotent so it's safe for
  // both layouts.
  else mkdirSync(dirname(path), { recursive: true });
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

// --- Autonomy mode ---
//
// The state-file field that distinguishes autonomous Construction (swarm/Bolt)
// from interactive flow. Promoted to ONE exported predicate so the human-
// presence gate's carve-out and the existing open-coded `=== "autonomous"`
// sites cannot drift. (This PR uses the helper only at the NEW gate sites;
// refactoring the existing open-coded sites is a tracked follow-up.)
export const AUTONOMY_MODE_FIELD = "Construction Autonomy Mode";

export function isAutonomousMode(stateContent: string | null): boolean {
  return !!stateContent && getField(stateContent, AUTONOMY_MODE_FIELD)?.trim() === "autonomous";
}

// Deterministic off-switch for the human-presence gate (mirrors
// artifactGuardDisabled in aidlc-state.ts). The suite sets this globally (the
// dedicated guard test clears it), and it is the documented bypass for
// synthetic CI runs that drive approve/answer against bare fixtures.
export function humanPresenceGuardDisabled(): boolean {
  return process.env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD === "1";
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

// removeField: delete the `- **Field**: ...` bullet line if present; a no-op
// otherwise. The inverse of setOrInsertField, for runtime-only fields that are
// cleared rather than reset (e.g. the `Parked` / `Parked At Stage` markers an
// `unpark` removes). Matches the bullet at line start and drops the whole line
// including its trailing newline so no blank line is left behind.
export function removeField(content: string, field: string): string {
  const regex = new RegExp(
    `^- \\*\\*${escapeRegex(field)}\\*\\*:[ \\t]*.*(?:\\r?\\n)?`,
    "m"
  );
  return content.replace(regex, "");
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

// The suffix-setter twin of setCheckbox: flips ONE stage line's plan suffix
// (the em-dash EXECUTE/SKIP tail the router's override channel reads)
// in either direction, leaving the checkbox marker untouched. setCheckbox owns
// the marker (run-state); this owns the suffix (the plan) - the two edit
// disjoint fields of the same line, so recompose and jump compose cleanly.
// Returns the content unchanged when the slug has no stage line.
export function setStageSuffix(
  content: string,
  slug: string,
  action: "EXECUTE" | "SKIP"
): string {
  const regex = new RegExp(
    `^(- \\[[ xSR?-]\\] ${escapeRegex(slug)}\\s*—\\s*)(EXECUTE|SKIP)\\b`,
    "m"
  );
  return content.replace(regex, `$1${action}`);
}

export function countCheckboxes(
  content: string,
  state: CheckboxState
): number {
  const checkboxes = parseCheckboxes(content);
  return checkboxes.filter((c) => c.state === state).length;
}

// --- Audit locking (per-intent, reaper-guarded) -------------------------------
//
// The audit lock is a cross-process mutex: a bare mkdir-EEXIST dir in tmpdir().
// It is keyed PER INTENT so two intents (or two Bolts in different intents) run
// truly in parallel without false serialization. Two keying invariants (P4's
// auto-birth depends on them):
//
//  (1) intent-OMITTED hashes a RESERVED sentinel `__workspace__` bucket, distinct
//      from every per-intent bucket, and does NOT resolve activeIntent() (at
//      birth there is no active intent; resolving would throw or bucket on
//      "default", and two concurrent first-runs would key different/empty
//      buckets and both birth). EVERY intents.json mutation takes this workspace
//      bucket; only intent-scoped state/audit writes take a per-intent bucket.
//  (2) the composite identity (projectDir + space + intent | sentinel) keys the
//      lock dir AND the in-process depth/handler maps, or the maps collide
//      across intents.
//
// REAPER: acquire stamps owner PID + start-time into the lock dir (owner.json).
// A waiter reclaims a lock iff process.kill(pid,0) throws ESRCH (owner gone) OR
// the stamp's age exceeds a conservative threshold — a live under-threshold
// holder is NEVER robbed. Reclaim is atomic (rename the dead dir aside, then
// re-mkdir) so only one waiter wins.

// The reserved bucket for workspace-level mutations (intents.json, intent birth).
export const WORKSPACE_LOCK_SENTINEL = "__workspace__";

// Default stale-lock age threshold (ms). A lock whose owner is still alive but
// whose stamp is older than this is treated as leaked (a wedged holder). Tunable
// via AIDLC_LOCK_STALE_MS for tests/ops. Conservative by default (10 min) so a
// genuinely slow-but-live holder is never robbed on liveness alone — the PID
// liveness check reclaims a dead owner immediately regardless of age.
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

function lockStaleMs(): number {
  const raw = process.env.AIDLC_LOCK_STALE_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_LOCK_STALE_MS;
}

// The composite lock IDENTITY string — keys the dir hash AND the in-process
// maps. intent-omitted → the workspace sentinel (invariant 1). When intent is
// given, the space is default-resolved (a per-intent lock is meaningless without
// its space) but activeIntent() is NEVER consulted here.
export function auditLockIdentity(projectDir: string, intent?: string, space?: string): string {
  if (intent === undefined) {
    return `${projectDir}\x00${WORKSPACE_LOCK_SENTINEL}`;
  }
  const sp = space ?? activeSpace(projectDir);
  return `${projectDir}\x00${sp}\x00${intent}`;
}

export function auditLockDir(projectDir: string, intent?: string, space?: string): string {
  const identity = auditLockIdentity(projectDir, intent, space);
  const hash = createHash("md5").update(identity).digest("hex").slice(0, 8);
  return join(tmpdir(), `.aidlc-audit-${hash}.lock`);
}

// Owner stamp written into the lock dir on acquire. start-time uses the process
// start epoch when available (a wrapped-around PID reuse is then detectable by a
// start-time mismatch); falls back to acquire-time. No Math.random / Date.now in
// the steal SUFFIX (scripts forbid them) — see reapStaleLock.
interface LockOwner {
  pid: number;
  startedAtMs: number;
}

function ownerStampPath(lockDir: string): string {
  return join(lockDir, "owner.json");
}

function writeOwnerStamp(lockDir: string): void {
  const owner: LockOwner = { pid: process.pid, startedAtMs: lockAcquireEpochMs() };
  try {
    writeFileSync(ownerStampPath(lockDir), JSON.stringify(owner), "utf-8");
  } catch {
    // Best-effort: a missing stamp degrades the reaper to age-only on the next
    // waiter (it can't read a PID), never to incorrectness.
  }
}

function readOwnerStamp(lockDir: string): LockOwner | null {
  try {
    const raw = readFileSync(ownerStampPath(lockDir), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed) && typeof parsed.pid === "number" && typeof parsed.startedAtMs === "number") {
      return { pid: parsed.pid, startedAtMs: parsed.startedAtMs };
    }
  } catch {
    // no stamp / unreadable
  }
  return null;
}

// A monotonic-ish epoch for the owner stamp. performance.timeOrigin + now()
// gives a wall-clock-equivalent without the bare `Date.now()` the lint forbids;
// it is used only for AGE comparison (a relative delta), so origin drift is
// irrelevant — both stamps come from the same clock family across processes
// because timeOrigin is anchored to the unix epoch by the runtime.
function lockAcquireEpochMs(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}

// Is the lock-owning process still alive? signal 0 probes liveness without
// delivering a signal: ESRCH ⇒ gone, EPERM ⇒ alive-but-not-ours (still alive),
// success ⇒ alive. A missing/invalid pid is treated as "not alive" so an
// unstamped leaked dir is reclaimable on age alone.
function ownerAlive(owner: LockOwner | null): boolean {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (e) {
    // EPERM ⇒ the process exists but is owned by another user → still alive.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// A monotonic per-process counter for the steal-rename suffix (no Math.random /
// Date.now — scripts/forbid). Combined with the PID it is unique enough that two
// waiters never collide on the same `.dead.<suffix>` name, and only one wins the
// rename anyway (the second gets ENOENT).
let _reapCounter = 0;
function reapSuffix(): string {
  _reapCounter += 1;
  return `${process.pid}-${_reapCounter}`;
}

// Grace window (ms) for an UNSTAMPED lock dir. acquireAuditLock mkdirs the lock
// dir THEN writes owner.json, so there is a brief window where a live holder's
// dir has no stamp yet. A waiter must NOT steal an unstamped dir younger than
// this grace (it is a live process mid-acquire) — only an unstamped dir OLDER
// than the grace is treated as a genuine leak (e.g. a SIGKILL between mkdir and
// stamp). Generous relative to the mkdir→write gap, tiny relative to the stale
// threshold. Tunable via AIDLC_LOCK_UNSTAMPED_GRACE_MS.
function unstampedGraceMs(): number {
  const raw = process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5000;
}

// The lock dir's own mtime epoch (ms), or null if it can't be stat'd. Used as the
// age anchor for an UNSTAMPED dir (no owner.json yet / ever). statSync mtime is a
// wall-clock ms, comparable to lockAcquireEpochMs()'s epoch family.
function lockDirMtimeMs(lockDir: string): number | null {
  try {
    return statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

// True iff `dir` carries the exact owner identity `judged` to be reclaimable
// (same pid + startedAtMs). Called by reapStaleLock on the reaper-PRIVATE moved
// dir AFTER the CAS rename, to confirm we grabbed the same stale lock we judged
// — not a fresh live lock a competitor re-acquired in the decide→rename window.
//
// A `null` judged-owner means the dir was judged reclaimable as an OLD UNSTAMPED
// dir. It still matches only if it is STILL unstamped AND still over the grace
// window. renameSync preserves the inode's mtime, so a genuine old leak keeps
// its over-grace mtime through the move, whereas a competitor's freshly-mkdir'd
// re-acquire has a RECENT mtime (under grace) → mismatch → restore. A now-present
// stamp (a live re-acquirer that already wrote owner.json) likewise mismatches.
//
// A concrete judged stamp (dead, or live-but-over-age) matches only if the moved
// dir still carries the SAME pid + startedAtMs. A re-acquire rewrites owner.json
// with a different pid / fresher startedAtMs → mismatch → restore.
function stampMatches(dir: string, judged: LockOwner | null): boolean {
  const now = readOwnerStamp(dir);
  if (judged === null) {
    // Old-unstamped leak. Still unstamped + still over grace (mtime preserved by
    // rename). A re-created dir resets mtime → under grace → mismatch; a now-
    // stamped dir → a live re-acquirer → mismatch.
    if (now !== null) return false;
    const mtime = lockDirMtimeMs(dir);
    if (mtime === null) return false; // vanished — nothing to steal
    return lockAcquireEpochMs() - mtime > unstampedGraceMs();
  }
  if (now === null) return false;
  return now.pid === judged.pid && now.startedAtMs === judged.startedAtMs;
}

// Reclaim a lock iff it is provably dead (owner gone) OR stale (over-age). A
// live, under-threshold holder is left alone (returns false). Returns true iff
// THIS call freed the dir.
//
// MUTUAL-EXCLUSION SAFETY (compare-and-swap steal): the staleness DECISION (read
// stamp, judge dead/over-age) and the steal are not one OS-atomic operation, so
// a competing waiter can reap + re-mkdir + stamp a FRESH LIVE lock at the same
// path in between. A "re-read stamp THEN rename" guard shrinks but does NOT
// eliminate the window — the competitor can still re-acquire between the re-read
// and the rename, and the rename then robs the fresh live holder (two concurrent
// holders → lost update). So the steal is a true CAS keyed on the OS-atomic
// rename:
//
//   1. Rename lockDir aside to a reaper-PRIVATE nonce path. renameSync is the
//      atomic arbiter — exactly one process moves a given dir; the losers get
//      ENOENT and fall back to a normal mkdir retry. After this we hold the
//      moved dir EXCLUSIVELY (no other process can see it under the nonce name).
//   2. Read the owner stamp INSIDE the moved dir and compare against `judged`
//      (the identity we decided was stale). If it MATCHES, the dir we grabbed is
//      the same stale lock we judged → legitimate steal → remove it, return true.
//   3. If it does NOT match, a competitor reaped the stale dir and re-acquired a
//      FRESH lock at lockDir between our decision and our rename — we just moved
//      THEIR live lock. Restore it: rename the nonce dir back to lockDir. If that
//      restore fails (yet another process already re-mkdir'd lockDir in the gap),
//      the live lock already exists again at lockDir, so just drop our private
//      copy. Either way we return false WITHOUT having robbed a live holder.
//
// This preserves both invariants atomically — a live (fresh, under-threshold)
// holder is never destroyed, and exactly one reaper ever frees a given stale dir.
//
// RESIDUAL (documented, not silently shipped): the only remaining mutual-
// exclusion gap is the restore in step 3 — between renaming a wrongly-grabbed
// fresh lock OUT of lockDir and renaming it BACK, a third process can mkdir
// lockDir (seeing it momentarily empty); the restore then fails EEXIST and two
// processes briefly believe they hold the lock. This requires THREE specific
// interleavings in a sub-microsecond rename↔mkdir window (a competitor must
// re-acquire before our first rename, AND a third process must mkdir between our
// two renames) — orders of magnitude narrower than the pre-CAS decide→rename
// window, and the lock protects an idempotent audit-first transaction (re-run
// safe). A kernel-atomic compare-and-swap on a directory does not exist in
// portable POSIX (rename + mkdir are separate syscalls), so closing it fully
// needs a different primitive (e.g. O_EXCL lockfile with fcntl); tracked as a
// known limitation, acceptable for this phase given the blast radius.
function reapStaleLock(lockDir: string): boolean {
  const owner = readOwnerStamp(lockDir);
  if (owner === null) {
    // UNSTAMPED dir: a live holder mid-acquire (between mkdir and stamp) OR a
    // process SIGKILL'd in that window. Distinguish by the dir's own age — only
    // steal one OLDER than the grace window; a fresh unstamped dir is a live
    // holder about to stamp and MUST NOT be robbed (the C2b concurrent-fork
    // serialization depends on this).
    const mtime = lockDirMtimeMs(lockDir);
    if (mtime === null) return false; // vanished — let the next mkdir try
    if (lockAcquireEpochMs() - mtime <= unstampedGraceMs()) return false;
    // else: an old unstamped dir → genuine leak, fall through to steal.
  } else if (ownerAlive(owner)) {
    // Live owner: only reclaim if its stamp is over-age (a wedged-but-running
    // holder). A fresh, live holder is never robbed.
    if (lockAcquireEpochMs() - owner.startedAtMs <= lockStaleMs()) return false;
  }
  // STEP 1 — CAS swap: move the dir to a reaper-private nonce path. This is the
  // atomic arbiter; only one process wins the rename of a given dir.
  const dead = `${lockDir}.dead.${reapSuffix()}`;
  try {
    renameSync(lockDir, dead);
  } catch {
    return false; // another waiter already reclaimed (or the holder released)
  }
  // STEP 2 — verify the dir we just grabbed STILL carries the identity judged
  // stale. stampMatches re-reads owner.json inside the now-private `dead` dir.
  if (!stampMatches(dead, owner)) {
    // STEP 3 — we grabbed a FRESH lock a competitor re-acquired in the window.
    // Restore it so the live holder is not robbed.
    try {
      renameSync(dead, lockDir);
    } catch {
      // lockDir already re-created by yet another process → the live lock is
      // back in place; discard our private snapshot.
      try { rmSync(dead, { recursive: true, force: true }); } catch { /* harmless */ }
    }
    return false;
  }
  // Legitimate steal: dead owner, live-but-over-age, or old-unstamped — AND the
  // identity we grabbed matches what we judged. Remove the private dir.
  try {
    rmSync(dead, { recursive: true, force: true });
  } catch {
    // leftover .dead dir is harmless (it never collides with the live lock name)
  }
  return true;
}

export function acquireAuditLock(
  projectDir: string,
  maxRetries = 50,
  retryMs = 100,
  intent?: string,
  space?: string,
): boolean {
  const lockDir = auditLockDir(projectDir, intent, space);
  for (let i = 0; i <= maxRetries; i++) {
    try {
      mkdirSync(lockDir);
      writeOwnerStamp(lockDir);
      return true;
    } catch {
      // EEXIST: someone holds it. Before sleeping, try to reap a dead/stale
      // holder so a SIGKILL'd owner doesn't wedge every waiter for the full
      // retry budget. If we reap, retry the mkdir immediately (next loop turn).
      if (reapStaleLock(lockDir)) {
        try {
          mkdirSync(lockDir);
          writeOwnerStamp(lockDir);
          return true;
        } catch {
          // another waiter beat us to the freed dir — fall through to sleep
        }
      }
      if (i < maxRetries) {
        Bun.sleepSync(retryMs);
      }
    }
  }
  return false;
}

export function releaseAuditLock(projectDir: string, intent?: string, space?: string): void {
  const lockDir = auditLockDir(projectDir, intent, space);
  const key = auditLockIdentity(projectDir, intent, space);
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Lock dir may already be removed
  }
  const handler = AUDIT_LOCK_EXIT_HANDLERS.get(key);
  if (handler) {
    process.off("exit", handler);
    AUDIT_LOCK_EXIT_HANDLERS.delete(key);
  }
}

// Tracks per-identity exit handlers that release the audit lock if a caller
// process.exit()s while still holding it. Bun's process.exit skips `finally`
// blocks, so a tool that wraps locked work in try/finally and then calls
// errorWithSlug → emitError → process.exit will leak the lock dir without
// this safety net. Lock acquire registers a handler; release deregisters.
// Keyed on the COMPOSITE lock identity (projectDir + space + intent | sentinel)
// so handlers for different intents don't collide (invariant 2).
const AUDIT_LOCK_EXIT_HANDLERS = new Map<string, () => void>();

// Per-IDENTITY reentrancy depth. Same-process nested withAuditLock calls for the
// same lock identity would otherwise self-deadlock — the inner mkdir hits
// EEXIST against the lock the outer caller already holds, and burns the
// retry budget (50 × 100ms = 5s) before throwing. The depth counter makes the
// primitive reentrant: the outer call performs the OS-level lock acquire/release;
// inner calls just bump depth and return. Cross-process locking is unaffected —
// different processes still serialise via mkdir EEXIST. Keyed on the composite
// identity so two intents in one process don't share a depth counter.
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
  intent?: string,
  space?: string,
): T extends Promise<unknown> ? never : T {
  const key = auditLockIdentity(projectDir, intent, space);
  const currentDepth = AUDIT_LOCK_DEPTH.get(key) ?? 0;
  if (currentDepth === 0) {
    if (!acquireAuditLock(projectDir, 50, 100, intent, space)) {
      throw new Error(`Failed to acquire audit lock for ${key} after retries`);
    }
    // Safety net: if the body calls process.exit (Bun skips `finally` in that
    // case), the on-exit handler releases the lock dir so the project isn't
    // poisoned for ~5s on the next invocation.
    const onExit = () => {
      const lockDir = auditLockDir(projectDir, intent, space);
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* already removed */ }
    };
    AUDIT_LOCK_EXIT_HANDLERS.set(key, onExit);
    process.on("exit", onExit);
  }
  AUDIT_LOCK_DEPTH.set(key, currentDepth + 1);
  try {
    return fn();
  } finally {
    const depth = AUDIT_LOCK_DEPTH.get(key) ?? 0;
    if (depth <= 1) {
      AUDIT_LOCK_DEPTH.delete(key);
      releaseAuditLock(projectDir, intent, space);
    } else {
      AUDIT_LOCK_DEPTH.set(key, depth - 1);
    }
  }
}

// True iff THIS process currently holds the audit lock for the given identity
// (projectDir + intent | sentinel) via an outer withAuditLock (or a bare
// acquireAuditLock paired with the exit-handler install). The lock-acquire path
// registers a per-identity exit handler and the release path removes it (see
// AUDIT_LOCK_EXIT_HANDLERS), so the handler's presence is the in-lock signal.
// emitError (below) already branches on this to pick appendAuditEntryUnlocked
// vs appendAuditEntry; the state tool's emitAudit helper uses it for the same
// reason — an audit emit issued from inside a held lock MUST use the unlocked
// variant or it self-deadlocks against the lock it is already holding
// (appendAuditEntry calls acquireAuditLock, which is NOT reentrant — only
// withAuditLock's depth counter is — so it would burn the full 50×100ms retry
// budget and then throw).
export function holdsAuditLock(projectDir: string, intent?: string, space?: string): boolean {
  return AUDIT_LOCK_EXIT_HANDLERS.has(auditLockIdentity(projectDir, intent, space));
}

// --- Doctor probe: leaked audit locks ----------------------------------------
//
// A leaked lock is a lock dir whose owner is provably dead (ESRCH) OR whose
// stamp is over the stale threshold. `/aidlc doctor` surfaces it (and, when
// clear=true, clears it loudly). We can't enumerate tmpdir() hashes back to
// projects, so we probe the buckets THIS project would use: the workspace
// sentinel bucket + every intent record across every space (the same identities
// the writers key on). A leaked lock is reported with its bucket + owner PID.

export interface LeakedLock {
  bucket: string; // "__workspace__" or "<space>/<intent>"
  lockDir: string;
  ownerPid: number | null;
  reason: "dead-owner" | "over-age" | "unstamped";
}

// Detect (and optionally clear) leaked locks for this project. `staleMs`
// defaults to the configured threshold. Returns the leaks found (and cleared,
// when clear=true). Pure-read when clear=false.
export function detectLeakedLocks(projectDir: string, clear = false): LeakedLock[] {
  const leaks: LeakedLock[] = [];
  const probe = (bucketLabel: string, intent?: string, space?: string): void => {
    const lockDir = auditLockDir(projectDir, intent, space);
    if (!existsSync(lockDir)) return;
    const owner = readOwnerStamp(lockDir);
    let reason: LeakedLock["reason"] | null = null;
    if (!owner) {
      // Unstamped: only a leak if older than the mid-acquire grace window (else
      // a live process is between mkdir and stamp).
      const mtime = lockDirMtimeMs(lockDir);
      if (mtime !== null && lockAcquireEpochMs() - mtime > unstampedGraceMs()) {
        reason = "unstamped";
      }
    } else if (!ownerAlive(owner)) {
      reason = "dead-owner";
    } else if (lockAcquireEpochMs() - owner.startedAtMs > lockStaleMs()) {
      reason = "over-age";
    }
    if (reason === null) return; // a live, fresh, stamped lock is legitimately held
    leaks.push({ bucket: bucketLabel, lockDir, ownerPid: owner?.pid ?? null, reason });
    if (clear) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  };
  // Workspace sentinel bucket.
  probe(WORKSPACE_LOCK_SENTINEL);
  // Every intent record across every space.
  const spacesRoot = join(workspaceRoot(projectDir), "spaces");
  let spaces: string[] = [];
  try { spaces = readdirSync(spacesRoot); } catch { /* no spaces dir */ }
  for (const sp of spaces) {
    for (const intent of listIntentDirs(projectDir, sp)) {
      probe(`${sp}/${intent}`, intent, sp);
    }
  }
  // The flat-legacy project also keys on the workspace bucket for its writes, so
  // the sentinel probe above already covers it.
  return leaks;
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
  const results: { timestamp: string; block: string; pos: number }[] = [];
  const blocks = audit.replace(/\r\n/g, "\n").split(/\n---\n/);
  const eventRegex = new RegExp(`^\\*\\*Event\\*\\*:\\s*${escapeRegex(event)}\\s*$`, "m");
  const slugRegex = slug
    ? new RegExp(`^\\*\\*Bolt slug\\*\\*:\\s*${escapeRegex(slug)}\\s*$`, "m")
    : null;
  const tsRegex = /^\*\*Timestamp\*\*:\s*(\S+)/m;
  let pos = 0;
  for (const block of blocks) {
    if (!eventRegex.test(block)) {
      pos++;
      continue;
    }
    if (slugRegex && !slugRegex.test(block)) {
      pos++;
      continue;
    }
    const tsMatch = block.match(tsRegex);
    if (!tsMatch) {
      pos++;
      continue;
    }
    results.push({ timestamp: tsMatch[1], block, pos });
    pos++;
  }
  // CHRONOLOGICAL, not buffer-order. readAllAuditShards concatenates per-clone
  // shards in FILENAME order, so the raw buffer is NOT time-ordered across
  // shards — a `[len-1]` "newest" reader (buildWorkflowHeader, hasStageAuditEvent)
  // could otherwise pick an OLDER event from a lexically-later shard. ISO-8601
  // timestamps sort lexicographically; ties (same-ms events, or a single shard's
  // already-ordered blocks) break by buffer position to keep the within-shard
  // order stable. This makes the readAllAuditShards "ordering by timestamp is the
  // parsers' job" contract TRUE for every findAllEvents consumer.
  results.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.pos - b.pos;
  });
  return results.map(({ timestamp, block }) => ({ timestamp, block }));
}

// Latest STAGE_STARTED slug in an audit buffer, or null if none. findAllEvents
// returns events in chronological order (timestamp, then buffer position), so
// the last STAGE_STARTED block is the most recent transition. The slug lives in
// the block's `**Stage**:` field (appendAuditEntry writes the fields verbatim).
// Payload-free derivation of "what stage are we on" — used by the Kiro IDE
// sync-statusline path, where the hook receives no task payload and must read
// the current stage from the audit tail instead.
//
// EXCLUDES synthetic `--single` stage-runner rows (Workflow: single-stage:<slug>)
// — those belong to no main workflow and must never rewrite the main pointer
// (mirrors the filter in aidlc-state.ts hasStageAuditEvent). Without this a
// single-stage run's STAGE_STARTED would become the "latest" and the IDE
// sync would repoint the main Current Stage at it.
export function latestStartedStageSlug(audit: string): string | null {
  const started = findAllEvents(audit, "STAGE_STARTED").filter(
    (ev) => !/^\*\*Workflow\*\*:\s*single-stage:/m.test(ev.block),
  );
  if (started.length === 0) return null;
  const last = started[started.length - 1];
  const m = last.block.match(/^\*\*Stage\*\*:\s*([a-z][a-z0-9-]*)\s*$/m);
  return m ? m[1] : null;
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

// Exported so the read-only `detect` verb can TELL the composer agent where
// the runtime scope registry lives (the paths are module-relative to the
// installed tool, which a prose agent cannot derive itself).
export function scopeGridPath(): string {
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
// Exported for the same reason as scopeGridPath: `detect --json` prints it so
// the composer agent is told the authoritative write target per harness.
export function scopesDir(): string {
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

  // `when` is a nested single-key map (when:\n  producer-in-plan: <slug>), not a
  // scalar — parse it separately below. Skip it in the scalar loop so it isn't
  // captured as an empty string.
  const WHEN_KEY = "when";

  for (const key of topLevelKeys) {
    if (key === CONSUMES_KEY) continue;
    if (key === WHEN_KEY) continue;
    if (key === "produces_kinds") continue; // parsed below; the scalar loop would stamp it ""
    if (ARRAY_KEYS.has(key)) continue;
    // optional_produces and required_sections are presence-gated array fields
    // parsed below; skip them here so the scalar loop does not stamp them with
    // an empty-string value.
    if (key === "optional_produces") continue;
    if (key === "required_sections") continue;
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

  // optional_produces is an OPTIONAL array field: an absent key yields an
  // absent property (mirrors for_each), so only annotated stages carry it
  // through compile and the stage-graph JSON stays minimal. listField's regex
  // anchors `^optional_produces:` (multiline), so it cannot cross-match the
  // `produces:` block and vice versa.
  if (topLevelKeys.has("optional_produces")) {
    obj.optional_produces = listField(fm, "optional_produces");
  }

  // produces_kinds is presence-gated: only assigned when the top-level key
  // exists, so an unannotated stage compiles with the property ABSENT (not an
  // empty object), preserving byte-identical emit for every stage that does
  // not use the map.
  if (topLevelKeys.has("produces_kinds")) {
    obj.produces_kinds = mapOfListsField(fm, "produces_kinds");
  }

  // required_sections is an OPTIONAL array field (plugin contribution mechanism
  // §6): named `## ` H2 sections a stage's output must contain. Absent key ->
  // absent property, so core stages that don't author it stay byte-identical.
  // Without this, an authored `required_sections:` block list would fall to the
  // scalar loop and parse as the string "- ...", failing schema validation with
  // "required_sections must be array, got string".
  if (topLevelKeys.has("required_sections")) {
    obj.required_sections = listField(fm, "required_sections");
  }

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

  // workspace_requires is the one boolean scalar field. The generic scalar loop
  // above captured it as a string ("true"/"false"); coerce to a real boolean so
  // StageEntry/GraphStage and the schema validator see the typed value (mirrors
  // consumes.required's "true"/"false" coercion in objectListField). A non-boolean
  // token is left as the string so validateStageFrontmatter rejects it loudly.
  if (typeof obj.workspace_requires === "string") {
    const raw = obj.workspace_requires;
    if (raw === "true" || raw === "false") {
      obj.workspace_requires = raw === "true";
    }
  }

  // `when` — nested single-key predicate map. Present only on plugin stages
  // (plugin mechanism, Layer 4). Parse the one indented `<predicate>: <value>`
  // line into an object so the schema validator sees the map it expects; absent
  // means the key never appears. Only assigned when the key was discovered.
  if (topLevelKeys.has(WHEN_KEY)) {
    // Match the `when:` line and the immediately-following indented child line.
    const whenMatch = fm.match(/^when:\s*\n\s+([a-z][a-z0-9-]*)\s*:\s*(.+?)\s*$/m);
    if (whenMatch) {
      obj.when = { [whenMatch[1]]: whenMatch[2] };
    } else {
      // inline form `when: {producer-in-plan: X}` or malformed — capture the raw
      // scalar so the validator can reject a non-map shape loudly.
      const inline = fm.match(/^when:\s*\{\s*([a-z][a-z0-9-]*)\s*:\s*([^}]+?)\s*\}\s*$/m);
      obj.when = inline ? { [inline[1]]: inline[2].trim() } : scalarField(fm, WHEN_KEY);
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
    "workspace_requires",
    "produces",
    "optional_produces",
    "produces_kinds",
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

    if (key === "produces_kinds") {
      // A map of artifact-name to inline kind list. Emit in insertion order
      // (the parse order the record preserves) so parse, emit, parse
      // round-trips (t65's contract).
      if (!isPlainObject(v)) continue;
      const entries = Object.entries(v);
      if (entries.length === 0) continue;
      lines.push("produces_kinds:");
      for (const [name, kinds] of entries) {
        if (!Array.isArray(kinds)) continue;
        lines.push(`  ${name}: [${(kinds as unknown[]).map((k) => String(k)).join(", ")}]`);
      }
    } else if (key === "consumes") {
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
    } else if (typeof v === "boolean") {
      // workspace_requires round-trips as an unquoted boolean (the parser
      // coerces the "true"/"false" token to a real boolean), so emit it
      // unquoted to preserve the parse -> emit -> parse contract.
      lines.push(`${key}: ${v}`);
    }
  }

  lines.push("---");
  return `${lines.join("\n")}\n`;
}

// Map-of-lists parser for the produces_kinds: frontmatter block. Matches an
// indented block of `artifact-name: [kind, kind]` lines under the top-level
// key, each value an INLINE list only (mirrors listField's strictness: a
// block-list value is rejected, not silently mis-parsed):
//
//   produces_kinds:
//     frontend-components: [ui]
//     scalability-requirements: [service]
//
// Returns an insertion-ordered record (parse order), so emitStageFrontmatter
// can round-trip it byte-identically. Each value is split with the same
// bracket logic parseInlineDepsList uses for depends_on. An empty inline list
// (`[]`) yields an empty array; the schema validator rejects that as a
// non-empty-list violation. Throws on a non-inline value so a mistaken
// block-list author error fails loud rather than dropping the entry.
function mapOfListsField(fm: string, key: string): Record<string, string[]> {
  const blockRe = new RegExp(
    `^${key}:\\s*\\n((?:[ \\t]+[a-z][a-z0-9-]*\\s*:\\s*[^\\n]*(?:\\r?\\n|$))+)`,
    "m"
  );
  const m = fm.match(blockRe);
  if (!m) return {};
  const out: Record<string, string[]> = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const entry = line.match(/^\s+([a-z][a-z0-9-]*)\s*:\s*(.+?)\s*$/);
    if (!entry) {
      throw new Error(`Malformed ${key} entry in frontmatter: ${line.trim()}`);
    }
    const value = entry[2].trim();
    if (!(value.startsWith("[") && value.endsWith("]"))) {
      throw new Error(
        `${key}.${entry[1]} must be an inline list (e.g. [service, ui]), got: ${value}`
      );
    }
    out[entry[1]] = parseInlineDepsList(value);
  }
  return out;
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

// --- Scope cost summary ---
//
// One source of truth for the ceremony a scope (or an arbitrary composer grid)
// carries: stage counts, approval-gate count, and per-unit fan-out. The routing
// strings, the birth print, the scope-change output, and the composer validator
// all read these numbers instead of recomputing them, so the confirm the user
// sees agrees with the grid the engine runs.

export interface ScopeCostSummary {
  total: number;         // stages in the grid (32 today, never hardcoded)
  execute: number;       // EXECUTE count
  skip: number;          // total - execute
  gates: number;         // EXECUTE stages outside initialization; mirrors
                         // computeGate() in aidlc-orchestrate.ts - change together
  perUnitStages: number; // EXECUTE stages that repeat per Unit of Work
}

// Cost of an arbitrary EXECUTE/SKIP grid (the composer-proposal shape). Indexes
// the compiled graph by slug once, then walks the grid entries. The gate rule
// (EXECUTE stage whose phase is not initialization) is the closed form of
// computeGate() in aidlc-orchestrate.ts - if a per-stage gate flag ever lands,
// change both. Grid slugs missing from the graph contribute to total/execute
// but not gates/perUnit (defensive; validate-grid already rejects unknown slugs
// for a real proposal, so this only matters for a stale composed scope).
export function gridCostSummary(
  stages: Record<string, "EXECUTE" | "SKIP">,
): ScopeCostSummary {
  const byslug = new Map<string, StageEntry>();
  for (const s of loadStageGraph()) byslug.set(s.slug, s);
  const total = Object.keys(stages).length;
  let execute = 0;
  let gates = 0;
  let perUnitStages = 0;
  for (const [slug, action] of Object.entries(stages)) {
    if (action !== "EXECUTE") continue;
    execute++;
    const node = byslug.get(slug);
    if (!node) continue;
    if (node.phase !== "initialization") gates++;
    if (isPerUnitStage(node)) perUnitStages++;
  }
  return { total, execute, skip: total - execute, gates, perUnitStages };
}

// Cost of a named scope's grid. Returns null for an unknown scope.
export function scopeCostSummary(scope: string): ScopeCostSummary | null {
  const def = loadScopeMapping()[scope];
  if (!def) return null;
  return gridCostSummary(def.stages);
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
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    const dropFile = join(healthDir, `${hookName}.drops`);
    const line = `${isoTimestamp()}\t${reason.replace(/\r?\n/g, " ")}\n`;
    appendFileSync(dropFile, line, "utf-8");
  } catch {
    // Drop-log failure is truly non-fatal — we're already in a failure path.
  }
}

// --- Hook debug log ---
//
// Append a structured debug line to `<health>/hook-debug.log` so a hook's
// decision path can be inspected after a run WITHOUT re-deriving it by
// hypothesis. OPT-IN ONLY, off by default (zero log growth / zero write cost on
// a normal run). Two independent switches, either enables it:
//   1. Env var `AIDLC_HOOK_DEBUG` — best for the CLI/Claude/Codex:
//      `AIDLC_HOOK_DEBUG=1 <command>` or export it.
//   2. Filesystem marker `aidlc/.aidlc-hook-debug` — best for Kiro IDE, where
//      the hook subprocesses are spawned by the IDE and an env var needs an IDE
//      restart to take effect. `touch aidlc/.aidlc-hook-debug` turns logging on
//      for the very next hook fire (no restart); `rm` it to turn off. When
//      projectDir cannot be resolved (rare), only the env var is consulted.
// Never throws; logging must never break a hook's advisory exit-0 contract.
export function hookDebugEnabled(projectDir?: string): boolean {
  if (process.env.AIDLC_HOOK_DEBUG) return true;
  if (projectDir) {
    try {
      return existsSync(join(workspaceRoot(projectDir), ".aidlc-hook-debug"));
    } catch {
      return false;
    }
  }
  return false;
}

export function hookDebug(
  projectDir: string,
  hookName: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (!hookDebugEnabled(projectDir)) return;
  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    const logFile = join(healthDir, "hook-debug.log");
    const parts = [isoTimestamp(), hookName, message];
    if (fields && Object.keys(fields).length > 0) {
      const flat = Object.entries(fields)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      parts.push(flat);
    }
    appendFileSync(logFile, `${parts.join("\t").replace(/\r?\n/g, " ")}\n`, "utf-8");
  } catch {
    // Debug-log failure is non-fatal — observability is best-effort.
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
  msg: string,
  intent?: string,
  space?: string
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
        // NOTE: holdsAuditLock keys on the COMPOSITE lock identity (per-intent
        // keying, P3) — a bare `AUDIT_LOCK_EXIT_HANDLERS.has(projectDir)` would
        // miss the workspace-bucket / per-intent handler keys and re-introduce
        // the 5s self-deadlock on every in-transaction error emit.
        //
        // The caller threads its RESOLVED intent+space (fork/merge hold a
        // PER-INTENT lock — aidlc-state.ts error()/lockIntent). We MUST probe and
        // emit on the SAME bucket: a bare holdsAuditLock(projectDir) keys the
        // __workspace__ sentinel, returns false mid per-intent transaction, takes
        // the 5s blocking-acquire branch, and writes ERROR_LOGGED to the wrong
        // shard. Omitted intent/space -> sentinel, which is correct for every
        // sentinel-locked caller (the common case).
        if (holdsAuditLock(projectDir, intent, space)) {
          audit.appendAuditEntryUnlocked("ERROR_LOGGED", {
            Tool: tool,
            Command: command,
            Error: msg,
          }, projectDir, intent, space);
        } else {
          audit.appendAuditEntry("ERROR_LOGGED", {
            Tool: tool,
            Command: command,
            Error: msg,
          }, projectDir, intent, space);
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

// The unit-kind enum: what a Unit of Work IS, so the engine can prune the
// per-unit construction design matrix to the artifacts that actually apply.
// A spec unit owes no scalability doc, a packaging unit no business-logic
// model. Authored once at the 2.7 gate on the units-generation edge block and
// confirmed by the human; consumed by the stage-schema validator (which shares
// this constant) and the engine's produces filter. Missing kind = full matrix
// (conservative default, zero behaviour change for untagged units).
export const UNIT_KINDS = ["service", "spec", "ui", "packaging", "library"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export interface UnitDependencyEdge {
  name: string;
  depends_on: string[];
  // Optional per-unit kind (UNIT_KINDS). Absent = full design-artifact matrix.
  kind?: UnitKind;
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

    // Optional per-unit kind. Mirrors the depends_on guard: a kind: line
    // before any - name: is malformed. The value must be one of UNIT_KINDS;
    // a typo fails loud here (mapped to reason "malformed" by parseBoltDag)
    // rather than silently falling back to the full matrix. Last-write-wins
    // on a duplicate kind: line, matching depends_on:'s posture.
    const kindMatch = line.match(/^\s*kind\s*:\s*(.+?)\s*$/);
    if (kindMatch) {
      if (!current) throw new Error("kind: before any - name: entry");
      const value = unquoteScalar(kindMatch[1]);
      if (!(UNIT_KINDS as readonly string[]).includes(value)) {
        throw new Error(
          `unit "${current.name}" has invalid kind "${value}" ` +
            `(expected ${UNIT_KINDS.join("|")})`
        );
      }
      current.kind = value as UnitKind;
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
//       kind: service
//       depends_on: []
//     - name: api
//       depends_on: [auth]
//   ```
//
// The optional `kind:` line (UNIT_KINDS) drives the per-unit construction
// design-artifact pruning; omitting it keeps a unit on the full matrix.
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

// Read the per-unit kinds off the compiled runtime graph's bolt_dag.units[]
// (name to kind). Returns null when there is no graph file, no bolt_dag node, a
// malformed graph, OR when no unit carries a kind: every null path means "no
// kinds known", so the engine cheaply skips filtering and every unit stays on
// the full matrix. Mirrors readBoltDagBatches' fail-safe posture: an absent or
// unreadable graph is a legitimate branch, never a throw.
//
// Trust posture (also matching readBoltDagBatches): kind values are only
// shape-checked here (string), not enum-checked - the UNIT_KINDS enum gate
// lives at units-generation parse, before the graph is compiled. A unit
// hand-tagged in the compiled graph with a valid-but-wrong kind therefore
// over-prunes (or under-prunes) silently; the compiled graph is trusted as
// already-validated input, same as its batches.
export function readBoltDagUnitKinds(projectDir: string): Map<string, string> | null {
  const path = runtimeGraphPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const graph: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (graph !== null && typeof graph === "object" && "bolt_dag" in graph) {
      const boltDag = (graph as { bolt_dag?: { units?: unknown } }).bolt_dag;
      const units = boltDag?.units;
      if (Array.isArray(units)) {
        const kinds = new Map<string, string>();
        for (const u of units) {
          if (
            u !== null &&
            typeof u === "object" &&
            typeof (u as { name?: unknown }).name === "string" &&
            typeof (u as { kind?: unknown }).kind === "string"
          ) {
            kinds.set((u as { name: string }).name, (u as { kind: string }).kind);
          }
        }
        if (kinds.size > 0) return kinds;
      }
    }
  } catch {
    // Malformed runtime graph: fail safe to "no kinds" (full matrix).
  }
  return null;
}

// Read every unit name off the compiled runtime graph's bolt_dag.units[].
// Returns null on a missing file/node, a malformed graph, or an empty units
// list. Companion to readBoltDagUnitKinds: the kinds map only carries the
// kind-tagged units, but the all-vacuous coverage check needs the COMPLETE
// unit set so an untagged unit (which owes the full matrix) still blocks a
// wrong "everything is vacuous" verdict.
export function readBoltDagUnits(projectDir: string): string[] | null {
  const path = runtimeGraphPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const graph: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (graph !== null && typeof graph === "object" && "bolt_dag" in graph) {
      const boltDag = (graph as { bolt_dag?: { units?: unknown } }).bolt_dag;
      const units = boltDag?.units;
      if (Array.isArray(units)) {
        const names: string[] = [];
        for (const u of units) {
          if (
            u !== null &&
            typeof u === "object" &&
            typeof (u as { name?: unknown }).name === "string"
          ) {
            names.push((u as { name: string }).name);
          }
        }
        if (names.length > 0) return names;
      }
    }
  } catch {
    // Malformed runtime graph: fail safe to "no units known".
  }
  return null;
}

// Prune a produces name list to the artifacts that apply to `unitKind`. Returns
// `names` unchanged when the stage has no produces_kinds map or `unitKind` is
// null (an untagged unit stays on the full matrix). For a kind-tagged unit, an
// artifact NOT in the map applies to all kinds (authors annotate only the
// kind-specific entries); a mapped artifact is kept only when its kind list
// includes `unitKind`. Takes the raw map (not a node) so both the orchestrator
// GraphStage and the state-tool StageEntry callers share one implementation.
export function filterProducesByKind(
  producesKinds: Record<string, string[]> | undefined,
  names: string[],
  unitKind: string | null
): string[] {
  if (unitKind === null || producesKinds === undefined) return names;
  return names.filter((name) => {
    const kinds = producesKinds[name];
    return kinds === undefined || kinds.includes(unitKind);
  });
}
