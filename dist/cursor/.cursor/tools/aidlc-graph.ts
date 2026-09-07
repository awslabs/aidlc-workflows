// Stage-graph library + CLI. Exports the 8-function API consumed by
// the doctor handler (see aidlc-utility.ts handleDoctor) and the
// runtime resolution layer (lib.ts's nextInScopeStage,
// firstInScopeStageOfPhase, stagesInScope delegate here via lazy
// require).
//
// Architectural model (see docs/reference/15-stage-definition.md):
//   - The graph is structural truth: 31 stage definitions + every
//     requires_stage / produces / consumes edge they declare = the
//     complete DAG. Compiled from YAML into stage-graph.json.
//   - A scope is a sub-DAG: scope-mapping.json's EXECUTE slice +
//     whichever requires_stage edges exist among those nodes.
//   - The serial runtime linearizes each sub-DAG to numeric order for
//     iteration. Numeric order is a valid topological sort of the full
//     graph (proven by t65 assertion 17; protected by compile's
//     edge-local invariant check below). The future worktree scheduler
//     will consume the sub-DAG structure directly for parallel Bolts.
//   - topoSort and findCycles exist in the library for analysis
//     (doctor consumes them) and for future scheduling; they do not
//     gate runtime iteration today.
//
// Compile is the YAML -> JSON transform. It bootstraps number + name
// from today's stage-graph.json so YAML stays the authored source of
// truth for everything else while computed fields stay computed. Numbers
// are ALWAYS assigned by the engine, never claimed by authors — a plugin's
// authored `number:` is a relative-ordering hint among its own new stages,
// its absolute value never used, so uncoordinated plugins cannot collide.
//
// A NEW stage slug (a .md on disk with no row in stage-graph.json yet) is
// seeded on compile rather than rejected: each phase's batch of new
// stages is ordered by its own requires_stage edges (Kahn's algorithm;
// ties among independent stages break by the authored `number:` hint,
// then slug), then assigned next-free contiguous indices
// (`<PHASES.indexOf(phase)>.<maxIndexInPhase + 1>` onward); name comes
// from authored `name:`, defaulting to the title-cased slug. Both are
// written into the regenerated JSON, so the FIRST compile assigns them
// and every subsequent compile harvests the pinned values, the assignment
// happens once and is stable thereafter. An author who wants a hand-tuned
// display name edits that one JSON field after the seeding compile; the
// next compile preserves it. Renumbering an existing stage is still an
// explicit JSON edit. (Seeding only ever ADDS rows, it never renumbers a
// stage that already has a row, so an in-flight workflow's slug-keyed
// state is safe.)
//
// See docs/reference/16-artifact-vocabulary.md for artifact naming.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveDistributionPath,
  resolveHarnessPath,
  runtimeProjectDir,
} from "./aidlc-runtime-paths.ts";
import {
  _resetAgentsForTests,
  _resetHarnessDataForTests,
  _resetScopeMappingForTests,
  _resetStageGraphForTests,
  auditLockOwnedByProcess,
  type AgentMetadata,
  errorMessage,
  gridCostSummary,
  loadAgents,
  loadScopeMapping,
  loadScopeMetadata,
  loadScopeMetadataAll,
  harnessDir,
  PHASES,
  type Phase,
  loadStageGraph,
  loadStageGraphAll,
  pluginsEnabled,
  type ScopeCostSummary,
  mustGet,
  mustPop,
  mustShift,
  parseStageFrontmatter,
  planFilePath,
  resolveProjectDir,
  resolveWorkflowSelection,
  type ScopeDefinition,
  type StageEntry,
  stageEnabledBySelection,
  toPosix,
  validScopes,
  withAuditLock,
  writeFileAtomic,
} from "./aidlc-lib.ts";
import {
  parseRuleFrontmatter,
  type RuleFrontmatter,
  validateRuleFrontmatter,
} from "./aidlc-rule-schema.ts";
import {
  parseSensorManifest,
  type SensorManifest,
  validateSensorManifest,
} from "./aidlc-sensor-schema.ts";
import { type StageFrontmatter, validateStageFrontmatter } from "./aidlc-stage-schema.ts";

// --- Types ---

export interface Consume {
  artifact: string;
  required: boolean;
  conditional_on?: "brownfield" | "greenfield";
}

// Per-rule resolution row baked into each stage's rules_in_context.
// Shape is intentionally minimal — `{path, scope}` only. The strict-additive
// runtime model carries no `enforcement` field: every applicable rule is
// concatenated and ALL apply at runtime; conflicts are rejected at
// admission gates (practices-discovery, memory gate) before they reach
// the resolver, not by runtime drop logic.
export interface RuleResolution {
  path: string;
  scope: "org" | "team" | "project" | "phase";
}

// Per-sensor resolution row baked into each stage's sensors_applicable.
// Pull authoring: the stage's frontmatter `sensors: [<id>]` declares the
// import; the resolver looks the manifest up by id and copies its
// dispatch policy and capability metadata verbatim. matches is omitted when
// the manifest declares no path filter. Runtime dispatchers read this
// snapshotted binding off the graph node — never re-open the manifest.
export interface SensorResolution {
  id: string;
  path: string;
  fire_on: "write" | "gate";
  default_severity: "advisory" | "blocking";
  category?: string;
  matches?: string;
}

// Authoritative graph stage shape — fully-populated, no optionals
// except for genuinely-optional-per-spec fields (condition, for_each).
// StageEntry in lib.ts carries the same fields as optional so existing
// runtime callers stay source-compatible without caring about the
// extended shape.
export interface GraphStage extends StageEntry {
  plugin?: string;
  enabled?: false;
  condition?: string;
  produces: string[];
  // optional_produces - artifacts the stage MAY write per unit (marked
  // CONDITIONAL in the stage body). Genuinely optional per spec, like
  // for_each: only annotated stages carry it. Exempt from the per-unit
  // coverage check in aidlc-orchestrate.ts unitCovered, but still resolved
  // into the run-stage directive's produces paths and unioned into the
  // artifact registry / producersOf lookups.
  optional_produces?: string[];
  // produces_kinds - per-kind applicability map (artifact name to unit kinds).
  // Lives on stage YAML, round-trips through parse/emit, and compiles into
  // stage-graph.json. The engine's produces filter reads it to prune the
  // per-unit construction matrix; an unlisted artifact applies to all kinds.
  produces_kinds?: Record<string, string[]>;
  consumes: Consume[];
  requires_stage: string[];
  // sensors is the stage-side pull import — a list of sensor manifest
  // ids. Optional because most stages declare empty (initialization) or
  // some subset; the resolver treats absent and `[]` identically. Lives
  // on stage YAML and round-trips through parse/emit; sensors_applicable
  // is the resolved view.
  sensors?: string[];
  // scopes is the stage-side scope-membership list — the transpose of the
  // legacy scope-mapping.json EXECUTE/SKIP matrix onto stages. A scope name
  // present here marks this stage EXECUTE under that scope. Optional because
  // a fixture stage may declare none; resolver treats absent and `[]`
  // identically. Lives on stage YAML, round-trips through parse/emit, and is
  // transposed into the compiled grid (scope-grid.json) at compile time.
  scopes?: string[];
  inputs: string;
  outputs: string;
  for_each?: string;
  // rules_in_context is REQUIRED — never undefined. The resolver always
  // assigns an array (org+team+project minimum on populated workspaces;
  // [] only when .claude/rules/ is empty). Lives only on the in-memory
  // GraphStage and the compiled stage-graph.json — NOT on stage YAML.
  // (validateStageFrontmatter at aidlc-stage-schema.ts rejects unknown
  // stage YAML keys; introducing rules_in_context to stage frontmatter
  // would trip that guard.)
  rules_in_context: RuleResolution[];
  // sensors_applicable is REQUIRED — assigned [] when stage.sensors is
  // absent/empty. Same compile-baked discipline as rules_in_context.
  sensors_applicable: SensorResolution[];
  // reviewer — the agent to invoke as a quality gate after the stage body.
  // Absent when no review step is configured. Parsed from stage frontmatter
  // `reviewer:` field and carried through to the run-stage directive.
  reviewer?: string;
  // Required Markdown output that owns the appended reviewer section.
  review_artifact?: string;
  // reviewer_max_iterations — review cycle cap before escalating to human.
  // Defaults to 2 when reviewer is present.
  reviewer_max_iterations?: number;
  // review_class — how the review runs: "adversarial" (refute + fix loop up
  // to the cap, §12a classic) or "advisory" (single pass, findings quoted at
  // the human gate, no fix loop). Defaults to "adversarial" when a reviewer
  // is present (the pre-class behavior). Absent when no reviewer. The
  // EFFECTIVE class at runtime may be lowered by the scope's review_cap or a
  // run override — resolveReviewClass in aidlc-lib.ts owns that resolution.
  review_class?: "adversarial" | "advisory";
  // Deterministic pre-generation consolidated-summary checkpoint policy.
  summary_confirmation?: "required" | "if-present";
}

export interface ScopeValidation {
  valid: boolean;
  errors: string[];
  advisories: string[];
  // The deterministic ceremony count of the validated grid (stage/gate/per-unit
  // counts). The composer copies this into its proposal verbatim so the gate the
  // human sees leads with numbers the validator computed, not an LLM recount.
  summary?: ScopeCostSummary;
  // Graph/plugin-authored stock scopes ranked by grid distance from the
  // validated proposal; composer-authored entries are excluded. A front/report
  // matched-vs-custom verdict routes on nearest_stock[0].diff (match when <= 2
  // and depth is compatible), so the routing is the final validator's number,
  // not an LLM recount or the earlier mechanical screen. In-flight treats the
  // ranking as advisory and preserves the running plan.
  nearest_stock?: Array<{ scope: string; diff: number; differs: string[] }>;
}

// --- Module-local state ---

const __FILE_DIR = dirname(fileURLToPath(import.meta.url));

function resolveDataDir(): string {
  return resolveHarnessPath(["tools", "data"]);
}

function mutableDataDir(projectDir: string): string {
  return resolveHarnessPath(["tools", "data"], { mutable: true, projectDir });
}

function requireInstalledHarness(projectDir: string): void {
  const installedLib = resolveHarnessPath(
    ["tools", "aidlc-lib.ts"],
    { mutable: true, projectDir },
  );
  if (!existsSync(installedLib)) {
    throw new Error(
      `compile requires an installed project harness at ${dirname(dirname(installedLib))}`,
    );
  }
}

/** Resolve the stages directory. AIDLC_STAGES_DIR env-var seam mirrors
 *  AIDLC_RULES_DIR + AIDLC_SENSORS_DIR so t89's fixture-driven import
 *  tests can isolate from the real stages tree (e.g., zero-sensors
 *  scenarios where no stage may declare any imports). Evaluated at call
 *  time. */
function stagesDir(): string {
  return process.env.AIDLC_STAGES_DIR
    ?? resolveHarnessPath(["aidlc-common", "stages"]);
}

/** Resolve the stage-graph.json path. Mirrors lib.ts:loadStageGraph()'s
 *  AIDLC_STAGE_GRAPH env-var seam (lib.ts:295-296) so tests can point both
 *  loader and compile-check at a temp file. Evaluated at call time so tests
 *  that set/unset the env mid-process see the change. */
function stageGraphPath(): string {
  return process.env.AIDLC_STAGE_GRAPH ?? join(resolveDataDir(), "stage-graph.json");
}

function mutableStageGraphPath(projectDir: string): string {
  return process.env.AIDLC_STAGE_GRAPH
    ?? join(mutableDataDir(projectDir), "stage-graph.json");
}

// The relocated method ("memory") is harness-neutral and lives at the
// WORKSPACE ROOT under aidlc/spaces/<space>/memory/, NOT inside the harness
// dir — one hand-editable copy, read by every harness via its own native
// include (Claude @-stub, Kiro resources glob, Codex AGENTS.md/@-mention).
// `default` is the always-present space and the zero-cursor fallback.
//
// Two resolution families share these segments:
//   • The COMPILE/DISPLAY family — rulesDir()/memoryDisplayPath() — stays pinned
//     to `default`. rules_in_context is frozen into stage-graph.json at PACKAGE
//     time (compileStageGraph) pointed at default; it is a list of display PATHS,
//     not rule content, so it is correct to ship default-pinned and is never
//     re-resolved at runtime. AIDLC_RULES_DIR still overrides rulesDir() outright.
//   • The PROJECT family — memoryDirFor()/memoryTemplatesDir() — FOLLOWS the
//     active-space cursor. These feed the learnings/practices WRITERS and the
//     templates sensor — the load-bearing channel for a non-default space — so a
//     learning promoted while active-space=teamB lands under teamB/memory, and
//     the templates sensor reads teamB's templates. A cursorless resolve still
//     yields `default` (activeSpace() falls back to DEFAULT_SPACE).
const MEMORY_SPACE = "default";
const MEMORY_SEGMENTS = ["aidlc", "spaces", MEMORY_SPACE, "memory"] as const;

/** Method ("memory") path segments for an explicit space — the active-space
 *  analog of the default-pinned MEMORY_SEGMENTS. Keeps the `aidlc/spaces/<space>/
 *  memory` shape in one place so the project-family resolvers can never drift
 *  from the compile/display family's layout. */
function memorySegmentsForSpace(space: string): string[] {
  return ["aidlc", "spaces", space, "memory"];
}

/** Resolve the method ("memory") directory — the single source of truth for
 *  the layered practices (org/team/project + phases/). AIDLC_RULES_DIR env-var
 *  seam mirrors AIDLC_STAGE_GRAPH so t88's fixture-driven inheritance tests can
 *  isolate from the real tree. Evaluated at call time. Ladder: env seam →
 *  project-dir workspace root → this tool's location (<ws>/<harness>/tools/ →
 *  up two to the workspace root; module-relative, so a dev checkout or an
 *  installed tree resolves without env) → the executable's packaged
 *  distribution (compiled binary outside any install). */
function rulesDir(): string {
  if (process.env.AIDLC_RULES_DIR) return process.env.AIDLC_RULES_DIR;
  const projectRules = join(runtimeProjectDir(), ...MEMORY_SEGMENTS);
  if (existsSync(projectRules)) return projectRules;
  const moduleRules = join(__FILE_DIR, "..", "..", ...MEMORY_SEGMENTS);
  if (existsSync(moduleRules)) return moduleRules;
  return resolveDistributionPath(MEMORY_SEGMENTS);
}

/** The harness-neutral DISPLAY path baked into each RuleResolution — the
 *  workspace-relative location of a method file (e.g. "aidlc/spaces/default/
 *  memory/org.md"). Replaces the old per-harness "<harness>/<rulesSubdir>/<f>"
 *  display form: the method now lives at the neutral aidlc/ roof, identical on
 *  every harness, so the baked path is harness-neutral too. `rel` is the file's
 *  sub-path under memory/ (e.g. "org.md" or "phases/construction.md"). */
function memoryDisplayPath(rel: string): string {
  return toPosix(join(...MEMORY_SEGMENTS, rel));
}

/** The method ("memory") directory under a given workspace root:
 *  `<projectDir>/aidlc/spaces/<space>/memory`. FOLLOWS the active-space cursor —
 *  `space` defaults to `activeSpace(projectDir)` (which itself falls back to
 *  `default` when no cursor is set), mirroring the `space?`/`?? activeSpace`
 *  shape of codekbDir()/knowledgeDir()/intentsDir() in aidlc-lib.ts. So the
 *  learnings/practices writers that resolve through here land under the active
 *  space, while a cursorless resolve still yields `default`. The path layout
 *  stays byte-aligned with the packager's emit and the native includes via
 *  `memorySegmentsForSpace`. (The TPL templates dir is this + "templates"; see
 *  `memoryTemplatesDir`.) */
export function memoryDirFor(projectDir: string, space?: string): string {
  const resolvedSpace =
    space ?? resolveWorkflowSelection(projectDir).space;
  return join(projectDir, ...memorySegmentsForSpace(resolvedSpace));
}

/** The TPL template-override source-of-truth dir for a workspace:
 *  `<projectDir>/aidlc/spaces/<space>/memory/templates` — where SEED ships the
 *  `templates/` floor and a team drops `<artifact>.md` overrides. Used by the
 *  `required-sections` sensor dispatcher as the default `--templates-dir`. Like
 *  `memoryDirFor`, FOLLOWS the active-space cursor (defaults to
 *  `activeSpace(projectDir)`, cursorless → `default`) so a team in space teamB
 *  gets teamB's templates. Kept here (not hardcoded in the dispatcher) so it
 *  stays byte-aligned with where the packager emits and the resolver reads. */
export function memoryTemplatesDir(projectDir: string, space?: string): string {
  const resolvedSpace =
    space ?? resolveWorkflowSelection(projectDir).space;
  return join(projectDir, ...memorySegmentsForSpace(resolvedSpace), "templates");
}

/** The FRAMEWORK-DEFAULT templates dir — the read-only, engine-shipped middle
 *  tier of the §10 templates resolution order (team override → framework default
 *  → generic floor). Ships at `<harness>/tools/data/templates/` beside the
 *  compiled data, resolved relative to THIS tool's location (like DATA_DIR), so
 *  it is harness-correct and space-INDEPENDENT (a framework default is the same
 *  for every space — it's the baseline a team optionally overrides per-space via
 *  `memoryTemplatesDir`). The framework ships zero default files at GA, so this
 *  dir resolves but holds only a marker → the sensor's middle branch misses and
 *  falls through to the floor. AIDLC_FRAMEWORK_TEMPLATES_DIR is a test/relocation
 *  seam mirroring AIDLC_TEMPLATES_DIR. */
export function frameworkTemplatesDir(): string {
  return process.env.AIDLC_FRAMEWORK_TEMPLATES_DIR ?? join(resolveDataDir(), "templates");
}

/** Engine-only-install self-heal: the ENGINE-BUNDLED method ("memory") seed — the
 *  core/memory/ tree copied INSIDE the engine at <harness>/tools/data/memory-seed/
 *  by the packager (mirrors frameworkTemplatesDir's tools/data/templates). It
 *  exists so an ENGINE-ONLY install (a user who copies only the harness engine
 *  dir, NOT the sibling aidlc/ workspace shell) can self-heal: the first /aidlc
 *  copies this OUT to aidlc/spaces/default/memory/ via ensureWorkspaceDirs IF that
 *  default tree is absent. Resolved relative to THIS tool's location (DATA_DIR),
 *  like frameworkTemplatesDir, so it is harness-correct on every harness.
 *  AIDLC_MEMORY_SEED_DIR is a test/relocation seam mirroring AIDLC_FRAMEWORK_TEMPLATES_DIR. */
export function frameworkMemorySeedDir(): string {
  return process.env.AIDLC_MEMORY_SEED_DIR ?? join(resolveDataDir(), "memory-seed");
}

/** Resolve the sensors directory. AIDLC_SENSORS_DIR env-var seam mirrors
 *  AIDLC_RULES_DIR so t89's fixture-driven import tests can isolate from
 *  the real .claude/sensors/ tree. Evaluated at call time. */
function sensorsDir(): string {
  return process.env.AIDLC_SENSORS_DIR ?? resolveHarnessPath(["sensors"]);
}

/** Resolve the compiled scope-grid.json path. Mirrors stageGraphPath()'s
 *  AIDLC_STAGE_GRAPH seam: AIDLC_SCOPE_GRID lets the parity/transpose tests
 *  point `compile --check` at a tempfile without touching the real grid.
 *  Evaluated at call time so tests that set/unset mid-process see it. */
function scopeGridPath(): string {
  return process.env.AIDLC_SCOPE_GRID ?? join(resolveDataDir(), "scope-grid.json");
}

function mutableScopeGridPath(projectDir: string): string {
  return process.env.AIDLC_SCOPE_GRID
    ?? join(mutableDataDir(projectDir), "scope-grid.json");
}

let _graph: GraphStage[] | null = null;
let _artifactsRegistry: ReadonlySet<string> | null = null;
let _scopeGrid: ScopeGrid | null = null;

/** Reset all module-level caches. Test-only — used when fixture
 *  injection via AIDLC_STAGE_GRAPH swaps the backing file mid-process.
 *  Also resets lib.ts's scope-mapping and agent caches (AIDLC_SCOPE_MAPPING /
 *  AIDLC_AGENTS_DIR env-seams) because compile/export consumers read them in
 *  the same call; resetting only the local cache leaves stale fixture views. */
export function __resetGraphCache(): void {
  _graph = null;
  _artifactsRegistry = null;
  _scopeGrid = null;
  _resetHarnessDataForTests();
  _resetStageGraphForTests();
  _resetAgentsForTests();
  _resetScopeMappingForTests();
}

/** Load the compiled scope-grid.json (the transpose). Cached. The grid is
 *  the runtime source of truth for EXECUTE/SKIP per scope after the
 *  scope-mapping.json source-of-truth is retired — subgraphForScope and
 *  lib.ts's loadScopeMapping() both read it. Falls back to recompiling
 *  from stage YAML when the file is absent (e.g. a fresh fixture tree)
 *  so callers never see a hard ENOENT for a derivable artifact. */
export function loadScopeGrid(): ScopeGrid {
  if (_scopeGrid !== null) return _scopeGrid;
  // When the AIDLC_SCOPE_MAPPING JSON-fixture seam is active, the grid must
  // come from that SAME fixture's `.stages` slices, not the real compiled
  // grid — otherwise the injected scope set (validScopes) and the grid
  // diverge. loadScopeMapping() already reads the fixture under the seam, so
  // project its `.stages` into the grid shape.
  if (process.env.AIDLC_SCOPE_MAPPING) {
    const mapping = loadScopeMapping();
    const grid: ScopeGrid = {};
    for (const [name, def] of Object.entries(mapping)) {
      grid[name] = { stages: def.stages };
    }
    _scopeGrid = grid;
    return _scopeGrid;
  }
  const p = scopeGridPath();
  try {
    _scopeGrid = JSON.parse(readFileSync(p, "utf-8")) as ScopeGrid;
  } catch {
    // Derive on the fly from the loaded graph when no compiled grid exists.
    _scopeGrid = transposeScopeGrid(loadGraph());
  }
  return _scopeGrid;
}

// --- Field-order pin for canonical JSON emission ---

const FIELD_ORDER = [
  "slug",
  "number",
  "name",
  "plugin",
  "enabled",
  "phase",
  "execution",
  "condition",
  "lead_agent",
  "support_agents",
  "mode",
  "for_each",
  "workspace_requires",
  "produces",
  "optional_produces",
  "produces_kinds",
  "consumes",
  "requires_stage",
  "sensors",
  "scopes",
  "reviewer",
  "review_artifact",
  "reviewer_max_iterations",
  "review_class",
  "summary_confirmation",
  "inputs",
  "outputs",
  "rules_in_context",
  "sensors_applicable",
] as const;

// --- Rule resolution ---
//
// Strict-additive runtime model: every applicable rule is concatenated
// into rules_in_context. No drop logic, no overrides, no enforcement
// keyword. Conflicts (narrower contradicting broader policy) are
// rejected at admission gates (practices-discovery, memory gate) by
// section-level LLM check before content reaches the resolver.
//
// Per-stage chain: org → team → project → phase. Pull authoring puts
// the phase→stage relationship on the stage's existing `phase:`
// declaration; the resolver attaches the matching aidlc-phase-<name>.md
// file with no rule-side glob filter. A confirmed learning is a PRACTICE
// (vision §6): the §13 gate appends it under a topical heading in
// team.md / project.md directly — there is no parallel `*-learnings.md`
// surface and no fractional override tier.

export interface RuleFile {
  path: string;          // "aidlc/spaces/default/memory/org.md"
  scope: "org" | "team" | "project" | "phase";
  phase?: string;        // populated only when scope === "phase"
  frontmatter: RuleFrontmatter;
  // `## <heading>` -> concatenated body text, surfaced from the same `raw`
  // loadRules() already reads. The doctor rule-drift check reads this
  // directly (single walking surface) instead of re-reading from `path`
  // (a relative DISPLAY path that would miss the AIDLC_RULES_DIR fixture).
  headings: Map<string, string>;
}

// Filename anchors for the relocated method tree (aidlc/memory/). The layered
// practice files are top-level (org/team/project, plain neutral names — no
// `aidlc-` prefix now that they live under the neutral aidlc/ roof); the
// phase-scoped files are nested under phases/<phase>.md. A confirmed learning
// is a practice (vision §6) — it lands in team.md / project.md directly, so
// there is no `*-learnings.md` slot and no fractional override tier. Anything
// not matching is silently ignored — including user-extension overlays like
// `team-overrides.md`, per 08-rule-system.md.
const RULE_FILE_REGEX = /^(org|team|project)\.md$/;
// Phase rule files live in phases/<phase>.md (the flat aidlc-phase-<phase>.md
// scheme moved under a nested phases/ dir in the aidlc/memory/ relocation).
const PHASE_RULES_SUBDIR = "phases";
const PHASE_FILE_REGEX = /^([a-z][a-z0-9-]*)\.md$/;

// Scope-priority for the deterministic sort — the resolved chain reads
// org → team → project → phase (a clean four-layer additive chain).
const SCOPE_PRIORITY: Record<string, number> = {
  "org": 0,
  "team": 1,
  "project": 2,
  "phase": 3,
};

/** Split a rule-file body into `## <heading>` -> concatenated body text.
 *  Skips fenced code blocks (```), blockquote lines (>), and HTML comment
 *  lines — both single-line (`<!-- ... -->`) AND multi-line (`<!--` ...
 *  `-->` across lines, tracked by an `inComment` flag). The multi-line
 *  flag is the difference from parseMemoryHeadings (lib.ts), which only
 *  skips single-line comments; rule files (e.g. aidlc-org.md's
 *  `## Corrections`) carry multi-line comment blocks whose interior lines
 *  would otherwise count as body and produce false drift candidates.
 *  Private — surfaced to the doctor rule-drift check via RuleFile.headings. */
function parseRuleHeadings(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const normalized = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let current: string | null = null;
  let inFence = false;
  let inComment = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const trimmed = line.trim();

    // Multi-line HTML comment tracking. A line can both open and close a
    // comment (single-line `<!-- ... -->`) — that is skipped by the body
    // filter below. A line that opens without closing flips inComment;
    // the closing line flips it back. Interior lines never count as body.
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--") && !trimmed.includes("-->")) {
      inComment = true;
      continue;
    }

    if (/^## /.test(line)) {
      current = line.slice(3).trim();
      if (!out.has(current)) out.set(current, "");
      continue;
    }

    if (current === null) continue;

    if (trimmed === "") continue;
    if (/^>/.test(trimmed)) continue;
    if (/^<!--.*-->\s*$/.test(trimmed)) continue;

    const prior = out.get(current) ?? "";
    out.set(current, prior === "" ? trimmed : `${prior}\n${trimmed}`);
  }

  return out;
}

/** Walk the rules directory and return parsed + validated rule files in
 *  precedence order. Public — the future doctor rule-drift check imports
 *  this same walker (single walking surface, no parser duplication).
 *  Tolerates a missing rules dir (returns []) so the zero-rules edge
 *  case stays clean. */
export function loadRules(): RuleFile[] {
  const dir = rulesDir();
  if (!existsSync(dir)) return [];

  // Each candidate: the absolute on-disk path to read, the display sub-path
  // (relative to aidlc/memory/, e.g. "org.md" or "phases/construction.md")
  // baked into the RuleResolution, the resolved scope, and the phase name when
  // scope === "phase". The method tree is shallow: top-level layered files plus
  // one nested phases/ dir, so the walk is two explicit reads (no recursion).
  type Candidate = {
    rel: string;
    filePath: string;
    scope: RuleFile["scope"];
    phase?: string;
  };
  const candidates: Candidate[] = [];

  // 1. Top-level layered files: org/team/project (the neutral practice files).
  for (const f of readdirSync(dir)) {
    const m = f.match(RULE_FILE_REGEX);
    if (!m) continue;
    const scopeKey = m[1];
    if (scopeKey !== "org" && scopeKey !== "team" && scopeKey !== "project") {
      continue; // unreachable given the regex, but keep the guard explicit
    }
    candidates.push({ rel: f, filePath: join(dir, f), scope: scopeKey });
  }

  // 2. Phase-scoped files nested under phases/<phase>.md.
  const phasesDir = join(dir, PHASE_RULES_SUBDIR);
  if (existsSync(phasesDir)) {
    for (const f of readdirSync(phasesDir)) {
      const m = f.match(PHASE_FILE_REGEX);
      if (!m) continue;
      candidates.push({
        rel: toPosix(join(PHASE_RULES_SUBDIR, f)),
        filePath: join(phasesDir, f),
        scope: "phase",
        phase: m[1],
      });
    }
  }

  const matched: RuleFile[] = [];
  for (const c of candidates) {
    const raw = readFileSync(c.filePath, "utf-8");
    const fm = parseRuleFrontmatter(raw);
    validateRuleFrontmatter(fm, c.filePath);
    const headings = parseRuleHeadings(raw);

    matched.push({
      path: memoryDisplayPath(c.rel),
      scope: c.scope,
      phase: c.phase,
      frontmatter: fm,
      headings,
    });
  }

  // Deterministic sort: (scope-priority, filename). readdirSync is
  // filesystem-order; non-portable. The sort is the determinism contract
  // that t66's canonical-emitter pin and `--check` rely on.
  matched.sort((a, b) => {
    const pri = SCOPE_PRIORITY[a.scope] - SCOPE_PRIORITY[b.scope];
    if (pri !== 0) return pri;
    return a.path.localeCompare(b.path);
  });

  return matched;
}

/** Build the strict-additive per-stage chain. Every applicable rule is
 *  included; nothing drops. Length 3 (org+team+project) when no phase
 *  rule applies, 4 (org+team+project+phase) when the stage's
 *  `phase: <name>` matches a phase-rule filename. Length 0 only when
 *  the rules directory is empty.
 *
 *  Pull authoring: org/team/project attach by filename to every stage
 *  (universal-default tier); the matching phase rule attaches because
 *  the stage already declared `phase: <name>` in its frontmatter — that
 *  declaration is the pull import. No glob filter on the rule side. */
export function resolveRulesForStage(
  stage: GraphStage,
  rules: RuleFile[],
): RuleResolution[] {
  const out: RuleResolution[] = [];
  for (const r of rules) {
    if (r.scope === "org" || r.scope === "team" || r.scope === "project") {
      out.push({ path: r.path, scope: r.scope });
    } else if (r.scope === "phase" && r.phase === stage.phase) {
      out.push({ path: r.path, scope: r.scope });
    }
  }
  return out;
}

// --- Sensor resolution ---
//
// Pull authoring: each stage's frontmatter `sensors: [<id>]` declares
// the manifests that fire when an agent writes a stage output. The
// resolver indexes .claude/sensors/ by id, looks each declared import
// up, and copies the manifest's `matches` filter verbatim into
// sensors_applicable. Unknown ids fail loud at compile — not silently
// at fire time. matches is compile-snapshotted, never re-read by the
// PostToolUse hook (preserves the BGP-stability invariant for in-flight
// workflows).

export interface SensorFile {
  id: string;
  path: string;        // ".claude/sensors/aidlc-<id>.md"
  manifest: SensorManifest;
}

// Filename anchor — sensor manifests live at `.claude/sensors/aidlc-<id>.md`.
// Anything not matching the prefix is silently ignored (mirrors loadRules).
const SENSOR_FILE_REGEX = /^aidlc-([a-z][a-z0-9-]*)\.md$/;

/** Walk the sensors directory and return a Map keyed by manifest id for
 *  O(1) lookup at resolution time. Public — future doctor sensor-drift
 *  check imports this same walker (single walking surface, no parser
 *  duplication). Tolerates a missing sensors dir (returns empty Map) so
 *  the zero-sensors edge case stays clean. Throws on duplicate ids.
 *  readdirSync is filesystem-order; non-portable across macOS/Linux. The
 *  sort is the determinism contract the canonical JSON emitter relies
 *  on (mirrors loadRules above). */
export function loadSensors(): Map<string, SensorFile> {
  const dir = sensorsDir();
  const out = new Map<string, SensorFile>();
  if (!existsSync(dir)) return out;

  for (const f of readdirSync(dir).sort()) {
    const m = f.match(SENSOR_FILE_REGEX);
    if (!m) continue;

    const filenameId = m[1];
    const filePath = join(dir, f);
    const raw = readFileSync(filePath, "utf-8");

    let manifest: SensorManifest;
    try {
      manifest = parseSensorManifest(raw);
    } catch (err) {
      throw new Error(`${filePath}: ${errorMessage(err)}`);
    }

    // Duplicate-id check before full validation so two manifests claiming
    // the same id surface the duplicate error, not a downstream
    // id↔filename mismatch on the second file. The check uses the parsed
    // id (which the schema later cross-validates against the filename).
    if (typeof manifest.id === "string" && out.has(manifest.id)) {
      const previous = mustGet(out, manifest.id, "sensor-manifest dup");
      throw new Error(
        `${filePath}: duplicate sensor id "${manifest.id}" — also declared ` +
          `in ${previous.path}. Rename one of them.`,
      );
    }

    validateSensorManifest(manifest, filePath, filenameId);

    out.set(manifest.id, {
      id: manifest.id,
      path: toPosix(join(harnessDir(), "sensors", f)),
      manifest,
    });
  }

  return out;
}

/** Resolve a stage's `sensors:` imports against the manifest registry.
 *  Throws when an imported id has no matching manifest — authoring
 *  errors fail loud at compile, not silently at fire time. Preserves
 *  declared import order (deterministic emission for the JSON pin). */
export function resolveSensorsForStage(
  stage: GraphStage,
  sensorsById: Map<string, SensorFile>,
): SensorResolution[] {
  const out: SensorResolution[] = [];
  const ids = stage.sensors ?? [];
  for (const id of ids) {
    const sensor = sensorsById.get(id);
    if (!sensor) {
      const known = [...sensorsById.keys()].sort().join(", ") || "(none)";
      throw new Error(
        `Stage "${stage.slug}" imports unknown sensor id "${id}". ` +
          `Known ids: ${known}`,
      );
    }
    const entry: SensorResolution = {
      id: sensor.id,
      path: sensor.path,
      fire_on: sensor.manifest.fire_on,
      default_severity: sensor.manifest.default_severity,
    };
    if (sensor.manifest.category !== undefined) {
      entry.category = sensor.manifest.category;
    }
    if (sensor.manifest.matches !== undefined) {
      entry.matches = sensor.manifest.matches;
    }
    out.push(entry);
  }
  return out;
}

// --- Library API (8 functions) ---

// rules_in_context is populated by compileStageGraph; downstream
// consumers (dispatcher, doctor) read pre-resolved arrays off graph
// nodes — no runtime walks of .claude/rules/.
/** Load the compiled graph (cached). Reads stage-graph.json via
 *  lib.ts's loadStageGraph(). Caller must NOT mutate the returned array.
 *  StageEntry and GraphStage are structurally compatible (GraphStage
 *  extends StageEntry's runtime shape); the validateStageFrontmatter
 *  pass at compile time has populated the extended fields. */
export function loadGraph(): GraphStage[] {
  if (!_graph) {
    // Single trust-boundary cast: stage-graph.json was emitted by
    // canonicalStageGraphJson, which writes only fields declared on
    // GraphStage. The narrowing happens at compile, not at load.
    // type-coverage:ignore-next-line
    _graph = loadStageGraph() as GraphStage[];
  }
  return _graph;
}

/** Stages that produce the given artifact. Empty array = orphan
 *  consumer candidate (doctor surfaces). Unions produces and
 *  optional_produces so a conditionally-produced artifact still resolves to
 *  its producer stage. */
export function producersOf(artifact: string): GraphStage[] {
  return loadGraph().filter(
    (s) =>
      (s.produces ?? []).includes(artifact) ||
      (s.optional_produces ?? []).includes(artifact)
  );
}

/** Stages that consume the given artifact. */
export function consumersOf(artifact: string): GraphStage[] {
  return loadGraph().filter((s) =>
    (s.consumes ?? []).some((c) => c.artifact === artifact)
  );
}

/** Consumed artifacts with more than one loaded producer. Runtime resolution
 *  selects the first producer by graph load order, so callers can surface this
 *  ambiguous configuration before that implicit choice affects a workflow. */
export function consumedArtifactProducerCollisions(): {
  artifact: string;
  producers: string[];
  consumers: string[];
}[] {
  const consumedArtifacts = [
    ...new Set(
      loadGraph().flatMap((stage) =>
        (stage.consumes ?? []).map((consume) => consume.artifact)
      )
    ),
  ].sort();

  return consumedArtifacts
    .map((artifact) => ({
      artifact,
      producers: producersOf(artifact).map((stage) => stage.slug),
      consumers: consumersOf(artifact).map((stage) => stage.slug).sort(),
    }))
    .filter(({ producers }) => producers.length >= 2);
}

/** TPL — the subset of a stage's `produces[]` eligible for a template
 *  override. The template-override layer keys a template off the
 *  output-filename stem (artifact X → X.md, per resolveArtifactPath's
 *  `<...>/${name}.md`), but that stem==artifact key is SOUND only for prose
 *  artifacts: a `*-questions.md` Q&A file or a `*-timestamp.md` marker is
 *  intentionally not a ≥2-H2 doc, so applying a heading-set template to it
 *  would yield spurious missing-section findings. The per-sensor
 *  required-sections script gets only --stage/--output-path and so cannot know
 *  the stage's artifact set — the dispatcher (aidlc-sensor.ts) and the
 *  PostToolUse fire hook (aidlc-run-sensors.ts) both hold the GraphStage and
 *  thread this filtered set so a resolved template applies ONLY to a
 *  declared-prose artifact. Lives here so both invocation sites derive it
 *  identically without importing the dispatcher (whose top-level main() would
 *  run on import). */
export function templateEligibleArtifacts(produces: string[]): string[] {
  return (produces ?? []).filter(
    (a) =>
      typeof a === "string" &&
      a.length > 0 &&
      !a.endsWith("-questions") &&
      !a.endsWith("-timestamp")
  );
}

/** Topological sort of the given subset using Kahn's algorithm with
 *  numeric-order tiebreak. Operates on arbitrary subsets: full graph,
 *  scope sub-DAG, or synthetic test fixtures. Edges to nodes outside
 *  the input subset are ignored. Throws on cycle. */
export function topoSort(stages: GraphStage[]): string[] {
  const inSet = new Set(stages.map((s) => s.slug));

  // inDegree counts only edges where both ends are in the input subset.
  const inDegree = new Map<string, number>();
  for (const s of stages) inDegree.set(s.slug, 0);
  for (const s of stages) {
    for (const dep of s.requires_stage ?? []) {
      if (!inSet.has(dep)) continue;
      inDegree.set(s.slug, (inDegree.get(s.slug) ?? 0) + 1);
    }
  }

  // Priority queue by numeric order. Plain sort is fine at 31-node scale.
  const ready = stages
    .filter((s) => (inDegree.get(s.slug) ?? 0) === 0)
    .sort((a, b) => numericStageOrder(a.number, b.number));

  const result: string[] = [];
  while (ready.length > 0) {
    const next = mustShift(ready, "topoSort.ready");
    result.push(next.slug);
    for (const s of stages) {
      if (!(s.requires_stage ?? []).includes(next.slug)) continue;
      const remaining = (inDegree.get(s.slug) ?? 0) - 1;
      inDegree.set(s.slug, remaining);
      if (remaining === 0) {
        // Insert in numeric order.
        let i = 0;
        while (
          i < ready.length &&
          numericStageOrder(ready[i].number, s.number) < 0
        ) {
          i++;
        }
        ready.splice(i, 0, s);
      }
    }
  }

  if (result.length !== stages.length) {
    throw new Error(
      `topoSort: cycle detected. Processed ${result.length} of ` +
        `${stages.length} nodes. Use findCycles() to enumerate.`
    );
  }
  return result;
}

/** Strongly-connected components of size >= 2, plus self-loops.
 *  Tarjan's algorithm. Works on arbitrary subsets; edges to out-of-
 *  subset nodes ignored. */
export function findCycles(stages: GraphStage[]): string[][] {
  const inSet = new Set(stages.map((s) => s.slug));
  const bySlug = new Map(stages.map((s) => [s.slug, s]));

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let idx = 0;
  const cycles: string[][] = [];

  function strongconnect(v: string): void {
    index.set(v, idx);
    lowlink.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);

    const stage = bySlug.get(v);
    const deps = (stage?.requires_stage ?? []).filter((d) => inSet.has(d));
    for (const w of deps) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(
          v,
          Math.min(
            mustGet(lowlink, v, "Tarjan.lowlink[v]"),
            mustGet(lowlink, w, "Tarjan.lowlink[w]")
          )
        );
      } else if (onStack.has(w)) {
        lowlink.set(
          v,
          Math.min(
            mustGet(lowlink, v, "Tarjan.lowlink[v]"),
            mustGet(index, w, "Tarjan.index[w]")
          )
        );
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = mustPop(stack, "Tarjan.stack");
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      // Report SCCs with size >= 2 (real cycles) OR size 1 with self-loop.
      if (scc.length >= 2) {
        cycles.push(scc);
      } else if (scc.length === 1) {
        const self = scc[0];
        const stageObj = bySlug.get(self);
        if ((stageObj?.requires_stage ?? []).includes(self)) {
          cycles.push([self]);
        }
      }
    }
  }

  for (const s of stages) {
    if (!index.has(s.slug)) strongconnect(s.slug);
  }
  return cycles;
}

/** The scope's sub-DAG as a linear array, sorted by numeric order.
 *  Filter to scope-mapping's EXECUTE slice, then sort by number.
 *  No topological sort at runtime — numeric order is a valid topo-
 *  order of the full graph (proven by t65, protected by compile's
 *  invariant) and therefore of any node subset. The future worktree
 *  scheduler will consume the sub-DAG structure directly for
 *  parallelism.
 *
 *  Throws on unknown scope. Returns [] when scope has zero EXECUTE
 *  entries — a legitimate edge case, e.g. a freshly-dropped
 *  .claude/scopes/aidlc-x.md that no stage names yet (valid scope, empty
 *  grid column). Scope validity is the .md-presence authority (validScopes),
 *  not the grid: a scope present as a file but absent from the grid is a
 *  zero-EXECUTE scope, not an unknown one. */
export function subgraphForScope(scope: string): GraphStage[] {
  if (!validScopes().has(scope)) {
    throw new Error(
      `Unknown scope: "${scope}". Valid scopes: ${[...validScopes()].join(", ")}`
    );
  }
  const entry = loadScopeGrid()[scope];
  const executeSlugs = new Set(
    Object.entries(entry?.stages ?? {})
      .filter(([, action]) => action === "EXECUTE")
      .map(([slug]) => slug)
  );
  return loadGraph()
    .filter((s) => executeSlugs.has(s.slug))
    .sort((a, b) => numericStageOrder(a.number, b.number));
}

/** Rank every graph/plugin-authored stock scope by grid distance from the given
 *  EXECUTE/SKIP grid: `{scope, diff, differs}` sorted by diff then name.
 *  Composer-authored entries appended to scope-grid.json are deliberately
 *  excluded. Distance covers the union of proposal and stock keys, so missing
 *  proposal stages and unknown extras are differences rather than invisible
 *  overlap. Shared by `ars` (against the complete mechanical screen grid) and
 *  `validate-grid` (against the composer's proposal); only the latter is a
 *  front/report stock-match authority. */
export function nearestStockScopes(
  grid: Record<string, "EXECUTE" | "SKIP">
): Array<{ scope: string; diff: number; differs: string[] }> {
  const stockScopeNames = stageDeclaredScopeNames(loadGraph());
  return Object.entries(loadScopeGrid())
    // Composer-authored scopes are appended only to scope-grid.json; no stage
    // declares them. They remain runnable but must never become stock-match
    // candidates for an unrelated later composition.
    .filter(([scope]) => stockScopeNames.has(scope))
    .map(([scope, def]) => {
      const differs: string[] = [];
      const slugs = new Set([
        ...Object.keys(def.stages),
        ...Object.keys(grid),
      ]);
      for (const slug of slugs) {
        if (grid[slug] !== def.stages[slug]) differs.push(slug);
      }
      return { scope, diff: differs.length, differs };
    })
    .sort((a, b) => a.diff - b.diff || a.scope.localeCompare(b.scope));
}

/** Resolve a scope's plan: the EXECUTE/SKIP slice over the full graph in
 *  numeric order, shaped `{slug, phase, action}` — byte-identical to
 *  lib.ts's stagesInScope() / the legacy scope-mapping-derived plan. The
 *  `aidlc-graph resolve` subcommand writes this to .aidlc-plan.json. The
 *  parity test asserts this matches the legacy plan across all 11 scopes. */
export function resolvePlanForScope(
  scope: string
): Array<{ slug: string; phase: string; action: "EXECUTE" | "SKIP" }> {
  if (!validScopes().has(scope)) {
    throw new Error(
      `Unknown scope: "${scope}". Valid scopes: ${[...validScopes()].join(", ")}`
    );
  }
  const entry = loadScopeGrid()[scope];
  const stages = entry?.stages ?? {};
  return loadGraph()
    .slice()
    .sort((a, b) => numericStageOrder(a.number, b.number))
    .map((s) => ({
      slug: s.slug,
      phase: s.phase,
      action: stages[s.slug] === "EXECUTE" ? ("EXECUTE" as const) : ("SKIP" as const),
    }));
}

/** Validate a scope's sub-DAG. Returns structured result so callers
 *  (doctor, future CI hooks) can tier severity:
 *    - errors:     orphan consumes (artifact has no producer anywhere).
 *                  Hard graph-level bugs.
 *    - advisories: off-path producer (artifact produced by a stage
 *                  not on this scope's path — the scope author chose
 *                  the shortcut and is responsible for the upstream
 *                  work).
 *
 *  consumes[].required: false is silent (not error, not advisory —
 *  optional consumes missing producers is a first-class valid state).
 *
 *  opts.projectType filters conditional_on: brownfield/greenfield
 *  consumes. Without projectType, conditional consumes are checked as
 *  if they fire; advisories for scope-skipped producers still surface.
 *
 *  Future home of the reserved `when:` predicate evaluation —
 *  contributors extend opts rather than adding a new function. */
export function validateScope(
  scope: string,
  opts?: { projectType?: "brownfield" | "greenfield" }
): ScopeValidation {
  // Delegate to the arbitrary-grid core over the named scope's EXECUTE set.
  // Default (lenient) mode preserves this function's historical behavior
  // byte-for-byte: off-path producers advise, only a TRUE orphan errors.
  const subgraph = subgraphForScope(scope); // throws on unknown scope (unchanged)
  const grid: Record<string, "EXECUTE" | "SKIP"> = {};
  for (const s of loadGraph()) grid[s.slug] = "SKIP";
  for (const s of subgraph) grid[s.slug] = "EXECUTE";
  return validateGrid(grid, { ...opts, label: scope });
}

/** Validate an ARBITRARY {slug -> EXECUTE|SKIP} grid - the composer's
 *  proposal shape, not yet a named scope. Same dependency walk as
 *  validateScope (which now delegates here), with one addition:
 *
 *    opts.strict - RECOMPOSE MODE. Promotes the off-path-producer advisory
 *    to a hard ERROR: a required consume whose producer exists in the graph
 *    but is not on the proposed EXECUTE set REJECTS the grid instead of
 *    advising. Plain (lenient) validation returns valid:true for that case
 *    because a pre-composed scope's author owns the upstream work; an
 *    IN-FLIGHT re-shape has no such author guarantee - an ADD whose producer
 *    was SKIPped would run starved, so it must be refused, not advised.
 *
 *  The TRUE-orphan hard error (no producer anywhere in the graph) applies in
 *  BOTH modes. Unknown slugs in the grid error in both modes too - a typo'd
 *  stage name must never pass as an implicit SKIP.
 *
 *  opts.projectType filters conditional_on consumes exactly as
 *  validateScope does. opts.label names the grid in messages (defaults to
 *  "proposed grid"). */
export function validateGrid(
  grid: Record<string, string>,
  opts?: {
    projectType?: "brownfield" | "greenfield";
    strict?: boolean;
    label?: string;
  }
): ScopeValidation {
  const label = opts?.label ?? "proposed grid";
  const graph = loadGraph();
  const knownSlugs = new Set(graph.map((s) => s.slug));
  const errors: string[] = [];
  const advisories: string[] = [];

  // Reject unknown slugs up front (a typo silently treated as SKIP would
  // validate a different plan than the one proposed).
  for (const slug of Object.keys(grid)) {
    if (!knownSlugs.has(slug)) {
      errors.push(
        `Grid names unknown stage "${slug}" - not in the compiled stage graph.`
      );
    }
    const action = grid[slug];
    if (action !== "EXECUTE" && action !== "SKIP") {
      errors.push(
        `Grid entry "${slug}" has invalid action "${action}" (expected EXECUTE or SKIP).`
      );
    }
  }
  const missingSlugs = graph
    .map((stage) => stage.slug)
    .filter((slug) => !(slug in grid));
  if (missingSlugs.length > 0) {
    errors.push(
      `Grid is missing ${missingSlugs.length} compiled stage entr${missingSlugs.length === 1 ? "y" : "ies"}: ` +
        `${missingSlugs.join(", ")}. Every compiled stage must be explicitly EXECUTE or SKIP.`,
    );
  }

  const onPath = new Set(
    Object.entries(grid)
      .filter(([slug, action]) => action === "EXECUTE" && knownSlugs.has(slug))
      .map(([slug]) => slug)
  );
  const subgraph = graph
    .filter((s) => onPath.has(s.slug))
    .sort((a, b) => numericStageOrder(a.number, b.number));

  for (const stage of subgraph) {
    for (const consume of stage.consumes ?? []) {
      // required: false -> silent
      if (!consume.required) continue;
      // projectType filter for conditional consumes
      if (
        consume.conditional_on &&
        opts?.projectType &&
        consume.conditional_on !== opts.projectType
      ) {
        continue;
      }
      const producers = producersOf(consume.artifact);
      if (producers.length === 0) {
        errors.push(
          `Stage "${stage.slug}" requires artifact "${consume.artifact}" ` +
            `but no stage in the graph produces it.`
        );
        continue;
      }
      const onPathProducers = producers.filter((p) => onPath.has(p.slug));
      if (onPathProducers.length === 0) {
        const message =
          `Stage "${stage.slug}" requires artifact "${consume.artifact}" ` +
          `whose producer(s) [${producers.map((p) => p.slug).join(", ")}] ` +
          `are not on the "${label}" path.`;
        if (opts?.strict) {
          errors.push(
            `${message} Strict (recompose) mode rejects a starved required input.`
          );
        } else {
          advisories.push(`${message} Ensure existing artifact is current.`);
        }
      }
    }
  }

  // The ceremony count travels with the validation so the composer relays the
  // validator's numbers, not a hand recount. Computed over the raw proposal
  // entries; unknown slugs already produced errors above and contribute only to
  // total/execute per gridCostSummary's graph-lookup guard.
  const summary = gridCostSummary(
    grid as Record<string, "EXECUTE" | "SKIP">,
  );
  // Distance to each stock scope travels with the validation for the same
  // reason as summary: the match decision must ride the validator's numbers.
  // Unknown and missing slugs already errored above; the ranking still counts
  // them so an invalid partial grid can never look like an exact stock match.
  const nearest_stock = nearestStockScopes(
    grid as Record<string, "EXECUTE" | "SKIP">,
  );
  return { valid: errors.length === 0, errors, advisories, summary, nearest_stock };
}

/** Check proposed (granted-at-the-gate) keywords against the keywords the
 *  existing scopes already claim - the same loadScopeMapping data both
 *  inference (inferScopeFromText) and findScopeByKeyword read. Inference
 *  takes the FIRST ALPHABETICAL keyword match, so a duplicate keyword would
 *  permanently shadow the incumbent scope on every future cold start; a
 *  collision is therefore a hard error naming the colliding scope, never an
 *  advisory. Comparison is case-insensitive exact equality, matching
 *  findScopeByKeyword. */
export function keywordCollisions(granted: string[]): string[] {
  const mapping = loadScopeMapping();
  const errors: string[] = [];
  for (const kw of granted) {
    const holders = Object.keys(mapping)
      .filter((scope) =>
        (mapping[scope]?.keywords ?? []).some(
          (k) => k.toLowerCase() === kw.toLowerCase()
        )
      )
      .sort();
    if (holders.length > 0) {
      errors.push(
        `Keyword "${kw}" is already claimed by scope${holders.length > 1 ? "s" : ""} ` +
          `[${holders.join(", ")}] - granting it would shadow that scope in ` +
          `keyword inference. Pick a keyword no existing scope claims.`
      );
    }
  }
  return errors;
}

/** Union of produces[] and optional_produces[] across all stages. */
export function artifactsRegistryFor(stages: readonly GraphStage[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const stage of stages) {
    for (const name of stage.produces ?? []) {
      names.add(name);
    }
    for (const name of stage.optional_produces ?? []) {
      names.add(name);
    }
  }
  return names;
}

export function artifactsRegistry(): ReadonlySet<string> {
  if (!_artifactsRegistry) {
    _artifactsRegistry = artifactsRegistryFor(loadGraph());
  }
  return _artifactsRegistry;
}

// --- Designer export ---
//
// Raw, unversioned bundle of graph + scopes + artifacts + agents.
// Consumed by the visual workflow designer when that ships. No --format
// flag, no version envelope, no schema chapter — the bundle is a data
// snapshot, not a stable contract. The designer-v1 schema lands when
// the consumer spec materialises. Reshapes with its inputs (future
// stage renumbering, new phase sub-stages) — releases that change the
// underlying YAML regenerate the golden fixture at
// tests/fixtures/designer-export/export.json in the same commit, identical
// pattern to `compile` regenerating stage-graph.json.

interface ExportBundle {
  stages: GraphStage[];
  scopes: Record<string, ScopeDefinition>;
  artifacts: string[];
  agents: AgentMetadata[];
}

const TOP_EXPORT_ORDER = ["stages", "scopes", "artifacts", "agents"] as const;
const AGENT_FIELD_ORDER = ["slug", "display_name", "examples"] as const;

/** Union the live graph + scopes + artifacts + agents into a single
 *  object. Pure — no I/O beyond what the underlying loaders already do.
 *  Stages and scopes pass through in file-insertion order from their JSON
 *  sources; artifacts are alphabetically sorted; agents are pre-sorted by
 *  slug in loadAgents(). */
export function exportBundle(): ExportBundle {
  return {
    stages: loadGraph(),
    scopes: loadScopeMapping(),
    artifacts: [...artifactsRegistry()].sort(),
    agents: loadAgents(),
  };
}

/** Canonical JSON emitter for the designer export. Mirrors
 *  canonicalStageGraphJson's pinned-key-order discipline so the golden
 *  fixture at tests/fixtures/designer-export/export.json survives any runtime
 *  change to JS property iteration order. Pins top-level keys via
 *  TOP_EXPORT_ORDER, stage fields via FIELD_ORDER (reused), agent fields
 *  via AGENT_FIELD_ORDER. scopes values are primitive-valued records from
 *  loadScopeMapping() — JSON.stringify preserves insertion order for
 *  string keys per ECMAScript spec, so no per-scope rebuild is needed. */
export function canonicalExportJson(b: ExportBundle): string {
  const orderedStages = b.stages.map((s) => {
    const out: Record<string, unknown> = {};
    for (const key of FIELD_ORDER) {
      const v: unknown = s[key as keyof GraphStage];
      if (v === undefined) continue;
      out[key] = v;
    }
    return out;
  });
  const orderedAgents = b.agents.map((a) => {
    const out: Record<string, unknown> = {};
    for (const key of AGENT_FIELD_ORDER) {
      const v: unknown = a[key as keyof AgentMetadata];
      if (v === undefined) continue;
      out[key] = v;
    }
    return out;
  });
  const ordered: Record<string, unknown> = {};
  for (const key of TOP_EXPORT_ORDER) {
    if (key === "stages") ordered[key] = orderedStages;
    else if (key === "agents") ordered[key] = orderedAgents;
    else ordered[key] = b[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// --- Compile ---

/** Canonical JSON emitter. The ONLY place that writes stage-graph.json
 *  bytes. Pinning the emitter in one function makes `compile --check`
 *  byte-compare robust — formatter drift is impossible when there's
 *  exactly one writer. */
export function canonicalStageGraphJson(stages: GraphStage[]): string {
  // Build each object with pinned key order so JSON.stringify emits
  // keys in the canonical order regardless of construction order.
  const ordered = stages.map((s) => {
    const out: Record<string, unknown> = {};
    for (const key of FIELD_ORDER) {
      const v: unknown = s[key as keyof GraphStage];
      if (v === undefined) continue;
      out[key] = v;
    }
    return out;
  });
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// --- Scope grid (the transpose) ---
//
// The compiled scope-grid.json is the EXECUTE/SKIP matrix, derived by
// transposing each stage's `scopes:` membership list. It is a PURE
// transpose — no graph-closure, no predicate. Shape is
// `{ <scope>: { stages: { <slug>: "EXECUTE" | "SKIP" } } }`, exactly the
// `.stages` half of the legacy scope-mapping.json so the runtime
// consumers that read `mapping[scope].stages` stay byte-for-byte
// unchanged. The scope-prose metadata (depth/keywords/description) lives
// in `.claude/scopes/aidlc-<name>.md`, not here.

export interface ScopeGrid {
  [scope: string]: { stages: Record<string, "EXECUTE" | "SKIP"> };
}

/** Transpose the per-stage `scopes:` lists into the EXECUTE/SKIP grid.
 *  Scope columns = the sorted union of every name any stage declares.
 *  Slug rows = stage order (the array passed in — already numeric-sorted
 *  by compileStageGraph). A stage that names a scope is EXECUTE under it;
 *  every other scope/stage cell is SKIP. Pure — no I/O. */
export function transposeScopeGrid(
  stages: GraphStage[],
  allowedScopes?: ReadonlySet<string>,
): ScopeGrid {
  const scopeNames = new Set<string>();
  for (const s of stages) {
    for (const name of s.scopes ?? []) {
      if (allowedScopes === undefined || allowedScopes.has(name)) scopeNames.add(name);
    }
  }
  if (allowedScopes !== undefined) {
    for (const name of allowedScopes) scopeNames.add(name);
  }
  const grid: ScopeGrid = {};
  for (const scope of [...scopeNames].sort()) {
    const stagesMap: Record<string, "EXECUTE" | "SKIP"> = {};
    for (const s of stages) {
      stagesMap[s.slug] =
        s.phase === "initialization" || (s.scopes ?? []).includes(scope)
          ? "EXECUTE"
          : "SKIP";
    }
    grid[scope] = { stages: stagesMap };
  }
  return grid;
}

/** Canonical JSON emitter for the scope grid. The ONLY place that writes
 *  scope-grid.json bytes — same sole-writer discipline as
 *  canonicalStageGraphJson, so `compile --check` byte-compares are robust.
 *  Scopes are emitted in sorted order (transposeScopeGrid already sorts);
 *  per-scope stage keys follow the stages array's numeric order. */
export function canonicalScopeGridJson(grid: ScopeGrid): string {
  return `${JSON.stringify(grid, null, 2)}\n`;
}

/** Fold COMPOSED-scope entries from the on-disk grid into a freshly
 *  transposed one. The transpose derives only the stock scopes (those a
 *  stage's `scopes:` frontmatter names); a composed scope's grid entry is
 *  appended at approval time by the composer and has no frontmatter
 *  producer, so a bare re-transpose would silently drop it — and with the
 *  scope's `.md` still present the name stays "valid" and resolves as
 *  all-SKIP, an emptied plan with no diagnostic. Any on-disk entry whose
 *  scope name the transpose does not produce survives the recompile; keys
 *  re-sort so the canonical emitter stays deterministic. Unparseable or
 *  malformed on-disk grids contribute nothing (fresh wins). When
 *  `preserveNames` is supplied, an orphan grid column with no matching scope
 *  identity file is dropped rather than mistaken for a composed scope. */
export function mergeComposedScopes(
  fresh: ScopeGrid,
  onDiskJson: string | null,
  preserveNames?: ReadonlySet<string>,
): ScopeGrid {
  if (!onDiskJson) return fresh;
  let onDisk: unknown;
  try {
    onDisk = JSON.parse(onDiskJson);
  } catch {
    return fresh;
  }
  if (typeof onDisk !== "object" || onDisk === null || Array.isArray(onDisk)) return fresh;
  const merged: ScopeGrid = { ...fresh };
  for (const [name, entry] of Object.entries(onDisk as Record<string, unknown>)) {
    if (name in merged) continue;
    if (preserveNames !== undefined && !preserveNames.has(name)) continue;
    if (
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      typeof (entry as { stages?: unknown }).stages === "object"
    ) {
      merged[name] = entry as ScopeGrid[string];
    }
  }
  const sorted: ScopeGrid = {};
  for (const k of Object.keys(merged).sort()) sorted[k] = merged[k];
  return sorted;
}

function composedScopeNames(
  onDiskJson: string | null,
  stockScopeNames: ReadonlySet<string>,
): ReadonlySet<string> {
  if (!onDiskJson) return new Set();
  let onDisk: unknown;
  try {
    onDisk = JSON.parse(onDiskJson);
  } catch {
    return new Set();
  }
  if (typeof onDisk !== "object" || onDisk === null || Array.isArray(onDisk)) {
    return new Set();
  }
  return new Set(
    Object.keys(onDisk as Record<string, unknown>)
      .filter((name) => !stockScopeNames.has(name))
      .sort(),
  );
}

function stageDeclaredScopeNames(stages: readonly Pick<GraphStage, "scopes">[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const stage of stages) {
    for (const name of stage.scopes ?? []) names.add(name);
  }
  return names;
}

function filterScopeGrid(
  grid: ScopeGrid,
  allowedScopes: ReadonlySet<string> | null,
  exemptScopes: ReadonlySet<string> = new Set(),
): ScopeGrid {
  if (allowedScopes === null) return grid;
  const filtered: ScopeGrid = {};
  for (const scope of Object.keys(grid).sort()) {
    if (allowedScopes.has(scope) || exemptScopes.has(scope)) filtered[scope] = grid[scope];
  }
  return filtered;
}

function enabledScopeNames(): ReadonlySet<string> | null {
  if (pluginsEnabled() === null) return null;
  return new Set(Object.keys(loadScopeMetadata()).sort());
}

/** Parse a numeric stage identifier like "3.5" into a tuple [phase, index]
 *  for total-ordering comparison. Returns negative, zero, or positive. */
export function numericStageOrder(a: string, b: string): number {
  const [aP, aI] = a.split(".").map((x) => parseInt(x, 10));
  const [bP, bI] = b.split(".").map((x) => parseInt(x, 10));
  if (aP !== bP) return aP - bP;
  return aI - bI;
}

/** Two-direction drift between the on-disk stage `.md` files and the compiled
 *  stage-graph.json. Pure set-difference over slugs, no YAML parse, no graph
 *  rebuild, so it is cheap enough to run on the session-start hot path.
 *
 *  - `missingFiles`: graph->disk. A slug in stage-graph.json with no matching
 *    `<phase>/<slug>.md` on disk, a real runtime breakage (the conductor is
 *    handed a path to a file that does not exist). The doctor reports it as a
 *    hard fail.
 *  - `uncompiledStages`: disk->graph. A `<phase>/<slug>.md` whose slug is absent
 *    from the compiled graph, the issue #364 case. The runtime resolves stages
 *    from the compiled graph only (loadGraph), so this file is silently never
 *    executed until `aidlc-graph compile` regenerates the graph. Advisory: the
 *    file is inert, not corrupt, and recompiling is a deliberate authoring act.
 *  - `graphCount`: how many slugs the compiled graph holds. Returned here so a
 *    caller (the doctor) can label the in-sync case without a second
 *    loadStageGraph() call.
 *
 *  Honours the AIDLC_STAGES_DIR (stagesDir) and AIDLC_STAGE_GRAPH
 *  (loadStageGraph) seams so a test can point both sources at a temp tree. */
export function stageGraphDrift(): {
  missingFiles: string[];
  uncompiledStages: string[];
  graphCount: number;
} {
  const graphSlugs = new Set(loadStageGraphAll().map((s) => s.slug));
  const diskSlugs = new Set<string>();
  const root = stagesDir();
  for (const phase of PHASES) {
    const dir = join(root, phase);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".md")) diskSlugs.add(f.replace(/\.md$/, ""));
    }
  }
  return {
    missingFiles: [...graphSlugs].filter((s) => !diskSlugs.has(s)).sort(),
    uncompiledStages: [...diskSlugs].filter((s) => !graphSlugs.has(s)).sort(),
    graphCount: graphSlugs.size,
  };
}

/** Default display name for an auto-seeded stage: title-cased slug
 *  ("my-custom-stage" -> "My Custom Stage"). A one-time default only,
 *  compile pins it into stage-graph.json, so an author can refine the name
 *  there afterwards (e.g. "NFR Requirements") and the next compile keeps it. */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function stagePluginOwner(stage: Pick<GraphStage, "plugin">): string {
  return stage.plugin ?? "aidlc";
}

function applyPluginSelection(stages: GraphStage[]): void {
  for (const stage of stages) {
    delete stage.enabled;
    if (!stageEnabledBySelection(stage)) stage.enabled = false;
  }
}

function validateSelectionClosure(stages: GraphStage[]): void {
  const producersByArtifact = new Map<string, GraphStage[]>();
  for (const stage of stages) {
    for (const artifact of [...(stage.produces ?? []), ...(stage.optional_produces ?? [])]) {
      const producers = producersByArtifact.get(artifact) ?? [];
      producers.push(stage);
      producersByArtifact.set(artifact, producers);
    }
  }

  for (const stage of stages.filter((s) => s.enabled !== false)) {
    for (const consume of stage.consumes ?? []) {
      if (!consume.required) continue;
      const producers = producersByArtifact.get(consume.artifact) ?? [];
      if (producers.length === 0) continue;
      const enabledProducers = producers.filter((p) => p.enabled !== false);
      if (enabledProducers.length > 0) continue;
      const producerList = producers
        .map((p) => `${p.slug} (${stagePluginOwner(p)})`)
        .sort()
        .join(", ");
      const disabledPlugins = [...new Set(producers.map(stagePluginOwner))].sort();
      throw new Error(
        `Plugin selection closure failed: enabled stage "${stage.slug}" consumes required artifact "${consume.artifact}", ` +
          `but its only producer(s) are disabled: ${producerList}. ` +
          `Enable plugin(s) ${disabledPlugins.join(", ")} or disable the consuming stage.`
      );
    }
  }
}

/** Enabled stages whose requires_stage points at a selection-disabled stage.
 *  NOT part of the closure ERROR: an ordering edge to a never-running stage is
 *  vacuous (topoSort ignores edges outside the enabled subset), and the shipped
 *  plugin-only flow legitimately runs plugin stages whose requires_stage names
 *  core stages. But the silently-dropped edge is worth surfacing - doctor
 *  reports these as an advisory so a surprising walk order is explainable. */
export function selectionDroppedOrderingEdges(
  stages: Array<{ slug: string; plugin?: string; enabled?: boolean; requires_stage?: string[] }>,
): string[] {
  const bySlug = new Map(stages.map((s) => [s.slug, s]));
  const dropped: string[] = [];
  for (const stage of stages.filter((s) => s.enabled !== false)) {
    for (const dep of stage.requires_stage ?? []) {
      const depStage = bySlug.get(dep);
      if (depStage?.enabled !== false) continue;
      dropped.push(`${stage.slug} requires ${dep} (${stagePluginOwner(depStage)}, disabled)`);
    }
  }
  return dropped.sort();
}

/** Regenerate stage-graph.json from the 31 YAML stage files.
 *  Bootstraps number + name from the existing JSON (the "computed
 *  not authored" contract — see stage-definition.md). Asserts the
 *  edge-local invariant: every requires_stage edge points from a
 *  higher-numbered stage to a lower-numbered one. Also transposes each
 *  stage's `scopes:` into the compiled scope-grid.json (gridJson) — both
 *  artifacts derive from the same in-memory stages, so a single compile
 *  keeps stage-graph.json and scope-grid.json in lockstep. */
export function compileStageGraph(): {
  json: string;
  gridJson: string;
  stages: GraphStage[];
} {
  // Load selected scope metadata up front so scope authoring invariants, such
  // as a single enabled freeform default, fail during compile.
  loadScopeMetadata();

  // Harvest number + name mappings from existing JSON. A slug already in
  // the JSON keeps its pinned number + name (the "computed not authored,
  // stable thereafter" contract); a NEW slug is auto-seeded below.
  const existing = loadStageGraphAll();
  const numberBySlug = new Map(existing.map((s) => [s.slug, s.number]));
  const nameBySlug = new Map(existing.map((s) => [s.slug, s.name]));

  // Highest index already used in each phase (keyed by numeric prefix),
  // so a new stage in that phase gets the next free index. Seeded from the
  // existing JSON, then bumped as new stages in the same phase are seeded
  // within this compile, so adding several new stages to one phase at once
  // assigns distinct, contiguous indices rather than colliding.
  const maxIndexByPhasePrefix = new Map<number, number>();
  for (const s of existing) {
    const [prefix, index] = s.number.split(".").map((n) => parseInt(n, 10));
    if (!Number.isFinite(prefix) || !Number.isFinite(index)) continue;
    maxIndexByPhasePrefix.set(
      prefix,
      Math.max(maxIndexByPhasePrefix.get(prefix) ?? 0, index)
    );
  }
  const stages: GraphStage[] = [];
  // NEW slugs (no pinned row yet), grouped by phase prefix for the
  // topological number seed after the walk.
  type NewStageSeed = { data: StageFrontmatter; phase: string; prefix: number; name: string };
  const newByPrefix = new Map<number, NewStageSeed[]>();
  // Track slug-to-first-file so duplicate-slug errors name both files.
  const slugToFile = new Map<string, string>();
  type StageDeclaration = { file: string; slug: string };
  const artifactProducers = new Map<string, StageDeclaration[]>();
  const artifactConsumers = new Map<string, StageDeclaration[]>();

  // Known agent slugs (the `name:` field of each .claude/agents/*.md), passed
  // to validateStageFrontmatter so a stage referencing a lead_agent or
  // support_agent with no matching agent file fails the compile loudly rather
  // than surfacing at runtime as a "subagent not registered" Task error.
  // Hoisted once: loadAgents() is memoised, but the .map is per-call.
  const knownAgents = loadAgents().map((a) => a.slug);

  const stagesRoot = stagesDir();
  for (const phase of readdirSync(stagesRoot)) {
    const pdir = join(stagesRoot, phase);
    if (!statSync(pdir).isDirectory()) continue;
    for (const f of readdirSync(pdir).filter((f) => f.endsWith(".md")).sort()) {
      const filePath = join(pdir, f);
      const raw = readFileSync(filePath, "utf-8");

      // Wrap parse in filename context — parseStageFrontmatter's default
      // error messages don't include the file path, which makes debugging
      // a bad YAML edit across 31 stage files painful.
      let parsed: Record<string, unknown>;
      try {
        parsed = parseStageFrontmatter(raw) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`${filePath}: ${errorMessage(err)}`);
      }

      // Validate frontmatter against stage-schema.ts before extracting fields
      // — the validator returns a typed StageFrontmatter, so subsequent reads
      // (slug, phase, etc.) need no casts. Catches missing required fields
      // (e.g., execution: undefined would silently drop from the emitted JSON
      // via canonicalStageGraphJson's undefined skip). Passing knownAgents
      // activates the agent-registration cross-check (Rule 9): an unknown
      // lead_agent / support_agent fails here, not at runtime.
      const validation = validateStageFrontmatter(parsed, { agents: knownAgents });
      if (!validation.valid) {
        throw new Error(
          `${filePath}: schema validation failed: ${validation.errors.join("; ")}`
        );
      }
      const slug = validation.data.slug;
      const plugin = validation.data.plugin;
      if (plugin !== undefined) {
        if (plugin === "aidlc") {
          throw new Error(
            `${filePath}: stage "${slug}" declares plugin "aidlc"; omit plugin for core stages.`
          );
        }
        // `aidlc-` is core's namespace: runner dirs are `aidlc-<slug>` for core
        // but the bare slug for plugin stages, so a plugin named `aidlc-<x>`
        // generates runner paths identical to core's and silently clobbers them
        // (/aidlc-<x>-... routes to the wrong stage).
        if (plugin.startsWith("aidlc-")) {
          throw new Error(
            `${filePath}: stage "${slug}" declares plugin "${plugin}"; the "aidlc-" prefix is reserved for core (a plugin named aidlc-<x> collides with core runner paths). Rename the plugin.`
          );
        }
        if (!slug.startsWith(`${plugin}-`)) {
          throw new Error(
            `${filePath}: stage "${slug}" declares plugin "${plugin}", but plugin-owned stage slugs must start with "${plugin}-". Rename the slug or fix the plugin field.`
          );
        }
      }

      const filenameStem = basename(filePath, ".md");
      if (filenameStem !== slug) {
        throw new Error(
          `${filePath}: stage filename stem "${filenameStem}" does not match frontmatter slug "${slug}". Rename the file or fix the slug.`
        );
      }

      // Duplicate-slug guard: two YAML files claiming the same slug would
      // silently produce a corrupt graph (two rows, findStageBySlug returns
      // only the first). Catch it loud and name both files.
      const previousFile = slugToFile.get(slug);
      if (previousFile) {
        throw new Error(
          `Duplicate stage slug "${slug}" in ${filePath} — already declared ` +
            `in ${previousFile}. Rename one of them.`
        );
      }
      slugToFile.set(slug, filePath);

      const declaration = { file: filePath, slug };
      // Match producersOf(): required and optional outputs share one artifact
      // producer namespace. Set semantics avoid counting one stage twice if an
      // author repeats a name across both lists.
      for (const artifact of new Set([
        ...(validation.data.produces ?? []),
        ...(validation.data.optional_produces ?? []),
      ])) {
        const producers = artifactProducers.get(artifact) ?? [];
        producers.push(declaration);
        artifactProducers.set(artifact, producers);
      }
      for (const artifact of new Set(
        (validation.data.consumes ?? []).map((consume) => consume.artifact),
      )) {
        const consumers = artifactConsumers.get(artifact) ?? [];
        consumers.push(declaration);
        artifactConsumers.set(artifact, consumers);
      }

      // Existing slug -> keep its pinned number + name (the "computed once,
      // stable thereafter" contract; a pinned row missing only its name
      // seeds the name inline). New slug -> DEFER numbering to the per-phase
      // topological seed after the file walk (below): with several new
      // stages arriving in one compile (a multi-stage plugin), numbering
      // them in file-walk (alphabetical) order can contradict their own
      // requires_stage edges and fail the lower-numbered-dependency
      // invariant, so the batch is ordered by its edges first.
      const prefix = PHASES.indexOf(phase as Phase);
      if (prefix < 0) {
        // A stage directory whose name is not one of the five canonical
        // phases can't be placed on the numeric spine, fail loud rather
        // than invent a prefix.
        throw new Error(
          `Stage "${slug}" (${filePath}) is in an unknown phase directory ` +
            `"${phase}". Stage phase directories must be one of: ${PHASES.join(", ")}.`
        );
      }
      const number = numberBySlug.get(slug);
      const name =
        nameBySlug.get(slug) ?? validation.data.name ?? titleCaseSlug(slug);
      if (number) {
        stages.push(buildGraphStage(validation.data, phase, number, name));
      } else {
        newByPrefix.get(prefix)?.push({ data: validation.data, phase, prefix, name }) ??
          newByPrefix.set(prefix, [{ data: validation.data, phase, prefix, name }]);
      }
    }
  }

  for (const [artifact, producers] of artifactProducers) {
    if (producers.length < 2) continue;
    const consumer = artifactConsumers.get(artifact)?.[0];
    if (!consumer) continue;

    // Shared artifact names are legal when unconsumed: traceability is
    // produced by eight stages and consumed by none, so only consumed names
    // require a unique producer.
    const producerList = producers
      .map(({ file, slug }) => `${file} (stage "${slug}")`)
      .join(", ");
    throw new Error(
      `Duplicate producers for consumed artifact "${artifact}" in ${producerList} — ` +
        `consumed by stage "${consumer.slug}" in ${consumer.file}. ` +
        `Rename one produced artifact or update the consumer.`
    );
  }

  // Per-phase topological seed for NEW slugs. Numbers are assigned by the
  // ENGINE, never claimed by authors: within one phase's batch of new
  // stages, order by the batch's own requires_stage edges (Kahn), breaking
  // ties among independent stages by the authored `number:` hint (a
  // relative-ordering hint only — its absolute value is never used) and
  // then slug; assign next-free contiguous indices in that order. Edges to
  // stages OUTSIDE the batch need no handling here: an already-pinned
  // same-phase dependency is lower-numbered by construction (new indices
  // start past the phase max), and cross-phase edges are ordered by the
  // phase prefix — the edge-local invariant below still backstops all of
  // it. Uncoordinated plugins therefore cannot collide on numbers, and a
  // batch whose file order contradicts its flow order still seeds validly.
  for (const prefix of [...newByPrefix.keys()].sort((a, b) => a - b)) {
    const batch = newByPrefix.get(prefix)!;
    const inBatch = new Map(batch.map((e) => [e.data.slug, e]));
    // Dedupe each stage's edges: the decrement below fires once per
    // dependent, so a duplicated requires_stage entry would strand the
    // stage at indegree > 0 and misreport a copy-paste duplicate as a
    // cycle (the schema shape-checks the list but does not dedupe it).
    const indegree = new Map(batch.map((e) => [e.data.slug, 0]));
    for (const e of batch) {
      for (const dep of new Set(e.data.requires_stage ?? [])) {
        if (inBatch.has(dep)) indegree.set(e.data.slug, (indegree.get(e.data.slug) ?? 0) + 1);
      }
    }
    const hint = (e: NewStageSeed): number => {
      const authored = e.data.number;
      if (!authored) return Number.POSITIVE_INFINITY;
      const idx = parseInt(authored.split(".")[1], 10);
      return Number.isFinite(idx) ? idx : Number.POSITIVE_INFINITY;
    };
    const byHintThenSlug = (a: NewStageSeed, b: NewStageSeed): number =>
      hint(a) - hint(b) || a.data.slug.localeCompare(b.data.slug);
    const ready = batch.filter((e) => indegree.get(e.data.slug) === 0).sort(byHintThenSlug);
    const seeded: NewStageSeed[] = [];
    while (ready.length > 0) {
      const e = ready.shift()!;
      seeded.push(e);
      for (const other of batch) {
        if (!(other.data.requires_stage ?? []).includes(e.data.slug)) continue;
        const d = (indegree.get(other.data.slug) ?? 0) - 1;
        indegree.set(other.data.slug, d);
        if (d === 0) {
          ready.push(other);
          ready.sort(byHintThenSlug);
        }
      }
    }
    if (seeded.length < batch.length) {
      // The unseeded set = the cycle's members plus anything downstream of
      // them, so name it "stuck", not "the cycle" — a stage can appear here
      // solely because its dependency is cyclic.
      const stuck = batch.filter((e) => !seeded.includes(e)).map((e) => e.data.slug);
      throw new Error(
        `Cannot seed stage numbers for phase "${batch[0].phase}": ` +
          `requires_stage cycle among new stages (stuck: ${stuck.join(", ")}). Break the cycle.`
      );
    }
    for (const e of seeded) {
      const nextIndex = (maxIndexByPhasePrefix.get(prefix) ?? 0) + 1;
      maxIndexByPhasePrefix.set(prefix, nextIndex);
      stages.push(buildGraphStage(e.data, e.phase, `${prefix}.${nextIndex}`, e.name));
    }
  }

  // Sort by numeric order (phase-prefix.index).
  stages.sort((a, b) => numericStageOrder(a.number, b.number));
  const stockScopeNames = stageDeclaredScopeNames(stages);

  // Resolve per-stage rule chain. Strict-additive: every applicable rule
  // appears in rules_in_context (org+team+project + phase when stage's
  // `phase:` matches the rule's filename suffix). The walk + parse +
  // validate happens once per compile; downstream consumers (dispatcher,
  // doctor) read pre-resolved arrays off graph nodes — no runtime walks
  // of .claude/rules/.
  const rules = loadRules();
  for (const stage of stages) {
    stage.rules_in_context = resolveRulesForStage(stage, rules);
  }

  // Resolve per-stage sensor imports. Pull authoring: each stage's
  // sensors[] list is looked up against the manifest registry; dispatch
  // policy, severity, category, and matches are copied into the resolved
  // entry. Unknown ids throw —
  // authoring errors fail loud at compile, not at fire time.
  const sensorsById = loadSensors();
  for (const stage of stages) {
    stage.sensors_applicable = resolveSensorsForStage(stage, sensorsById);
  }

  applyPluginSelection(stages);
  validateSelectionClosure(stages);

  // Edge-local invariant: for every edge A in B.requires_stage,
  // numericOrder(A) < numericOrder(B). Topological sort is non-unique
  // in the presence of fan-out (Construction's NFR and functional-
  // design branches are independent); sort-equivalence would be
  // tautological. The edge-local check captures the real failure mode.
  const numberLookup = new Map(stages.map((s) => [s.slug, s.number]));
  for (const stage of stages) {
    for (const dep of stage.requires_stage ?? []) {
      const depNum = numberLookup.get(dep);
      if (!depNum) {
        throw new Error(
          `Unknown requires_stage: "${dep}" on stage "${stage.slug}". ` +
            `Every requires_stage entry must reference a known stage slug.`
        );
      }
      if (numericStageOrder(depNum, stage.number) >= 0) {
        throw new Error(
          `Compile invariant violated: stage "${stage.slug}" (${stage.number}) ` +
            `requires "${dep}" (${depNum}) — dependency must be lower-numbered. ` +
            `Fix: either renumber in stage-graph.json to match the dependency ` +
            `direction, or remove the offending requires_stage edge.`
        );
      }
    }
  }

  // Swarm-trigger guard (advisory): the autonomous Construction swarm fires
  // on a field match — for_each: unit-of-work + mode: subagent (see
  // SWARM_FOR_EACH / SWARM_MODE in aidlc-orchestrate.ts). A per-unit
  // Construction stage carrying any OTHER mode silently falls off the swarm
  // path and builds its units serially, which is legal (the topology is the
  // author's call) but easy to do by accident when retuning modes. Warn on
  // stderr; never fail — warnings do not affect the emitted JSON, so
  // compile --check parity is untouched.
  for (const stage of stages) {
    if (
      stage.phase === "construction" &&
      stage.for_each === "unit-of-work" &&
      stage.workspace_requires === true &&
      stage.mode !== "subagent"
    ) {
      console.error(
        `[advisory] stage "${stage.slug}" is the per-unit build stage ` +
          `(for_each: unit-of-work + workspace_requires) but mode is ` +
          `"${stage.mode}", not "subagent" — the autonomous Construction ` +
          `swarm will NOT fire for it; units build serially.`
      );
    }
  }

  // The grid transpose covers only frontmatter-declared (stock) scopes;
  // composed scopes live solely as appended grid entries, so fold the
  // on-disk grid's composed entries back in before emitting — a recompile
  // must never destroy an approved composed scope.
  let onDiskGrid: string | null = null;
  try {
    onDiskGrid = readFileSync(scopeGridPath(), "utf-8");
  } catch {
    /* first compile: no grid on disk yet */
  }
  const selectedScopeNames = enabledScopeNames();
  const installedScopeNames = new Set(Object.keys(loadScopeMetadataAll()));
  const composedNames = new Set(
    [...composedScopeNames(onDiskGrid, stockScopeNames)].filter((name) =>
      installedScopeNames.has(name),
    ),
  );
  const seededScopeNames =
    selectedScopeNames === null
      ? undefined
      : new Set([...selectedScopeNames].filter((name) => !composedNames.has(name)));
  return {
    json: canonicalStageGraphJson(stages),
    gridJson: canonicalScopeGridJson(
      filterScopeGrid(
        mergeComposedScopes(
          transposeScopeGrid(
            stages.filter((s) => s.enabled !== false),
            seededScopeNames,
          ),
          onDiskGrid,
          composedNames,
        ),
        selectedScopeNames,
        composedNames,
      ),
    ),
    stages,
  };
}

function buildGraphStage(
  parsed: StageFrontmatter,
  phase: string,
  number: string,
  name: string
): GraphStage {
  const slug = parsed.slug;
  // Support_agents + produces + requires_stage are always arrays
  // (parseStageFrontmatter normalises empty).
  const support_agents = parsed.support_agents ?? [];
  const produces = parsed.produces ?? [];
  // Dependency edges are set-valued. Normalize copy-paste duplicates here so
  // every graph consumer, including topoSort's indegree accounting, observes
  // the same edge cardinality as the compile-time number seeder.
  const requires_stage = [...new Set(parsed.requires_stage ?? [])];
  const consumesRaw = parsed.consumes ?? [];
  const consumes: Consume[] = consumesRaw.map((c) => {
    const out: Consume = {
      artifact: c.artifact,
      required: c.required,
    };
    if (c.conditional_on !== undefined) {
      out.conditional_on = c.conditional_on;
    }
    return out;
  });

  const stage: GraphStage = {
    slug,
    number,
    name,
    phase: parsed.phase ?? phase,
    execution: parsed.execution,
    lead_agent: parsed.lead_agent,
    support_agents,
    mode: parsed.mode,
    produces,
    consumes,
    requires_stage,
    inputs: parsed.inputs ?? "",
    outputs: parsed.outputs ?? "",
    // Filled by resolveRulesForStage in compileStageGraph after the
    // sort. The field is REQUIRED on GraphStage; assigning [] here
    // keeps the type honest until resolution runs.
    rules_in_context: [],
    // Filled by resolveSensorsForStage in compileStageGraph. Same
    // discipline as rules_in_context — REQUIRED on GraphStage.
    sensors_applicable: [],
  };
  if (parsed.plugin !== undefined) {
    stage.plugin = parsed.plugin;
  }
  if (parsed.condition !== undefined) {
    stage.condition = parsed.condition;
  }
  if (parsed.for_each !== undefined) {
    stage.for_each = parsed.for_each;
  }
  if (parsed.workspace_requires !== undefined) {
    stage.workspace_requires = parsed.workspace_requires;
  }
  if (parsed.optional_produces !== undefined) {
    stage.optional_produces = parsed.optional_produces;
  }
  if (parsed.produces_kinds !== undefined) {
    stage.produces_kinds = parsed.produces_kinds;
  }
  if (parsed.sensors !== undefined) {
    stage.sensors = parsed.sensors;
  }
  if (parsed.scopes !== undefined) {
    stage.scopes = parsed.scopes;
  }
  if (parsed.reviewer !== undefined) {
    stage.reviewer = parsed.reviewer;
    stage.review_artifact = parsed.review_artifact;
    // Default the cap to 2 when a reviewer is declared but no explicit cap is
    // set. The parser (V1) now returns a real number and validateStageFrontmatter
    // (V2) rejects a non-positive-integer cap upstream, so this should always
    // see a valid number or undefined. Keep the coercion defensive: a value
    // that isn't a positive integer falls back to the default 2 rather than
    // letting NaN reach stage-graph.json.
    const cap = Number(parsed.reviewer_max_iterations);
    stage.reviewer_max_iterations =
      parsed.reviewer_max_iterations !== undefined &&
      Number.isInteger(cap) &&
      cap >= 1
        ? cap
        : 2;
    // Default the class to "adversarial" (the pre-class behavior) when a
    // reviewer is declared without one. Schema (V2) rejects any value other
    // than adversarial/advisory upstream; keep the coercion defensive so a
    // bad value degrades to the strict default rather than leaking through.
    stage.review_class =
      parsed.review_class === "advisory" ? "advisory" : "adversarial";
  }
  if (parsed.summary_confirmation !== undefined) {
    stage.summary_confirmation = parsed.summary_confirmation;
  }
  return stage;
}

function runCompileCheck(): void {
  const { json, gridJson } = compileStageGraph();
  const graphOnDisk = readFileSync(stageGraphPath(), "utf-8");
  if (json !== graphOnDisk) {
    console.error(
      "stage-graph.json is out of date. Run `bun aidlc-graph.ts compile` to regenerate."
    );
    process.exit(1);
  }
  // The scope grid is the second compiled artifact (the transpose of every
  // stage's scopes:). Same drift discipline as stage-graph.json — a stale
  // grid (someone edited a stage's scopes: without recompiling) fails CI.
  // Read the grid path lazily so a missing grid file reports the same way
  // as a stale one rather than throwing an unhandled ENOENT. The on-disk
  // bytes are re-emitted through the canonical emitter before comparing:
  // the composer APPENDS its approved entry (insertion order, end of file)
  // while the emitter sorts scope keys, so a purely positional difference
  // must not read as drift — only a real content difference (a cell, a
  // scope, a stage set) fails the check.
  let gridOnDisk: string;
  try {
    gridOnDisk = readFileSync(scopeGridPath(), "utf-8");
  } catch {
    gridOnDisk = "";
  }
  try {
    const parsed = JSON.parse(gridOnDisk) as ScopeGrid;
    const sorted: ScopeGrid = {};
    for (const k of Object.keys(parsed).sort()) sorted[k] = parsed[k];
    gridOnDisk = canonicalScopeGridJson(sorted);
  } catch {
    /* unparseable/missing grid: compare the raw bytes (guaranteed drift) */
  }
  if (gridJson !== gridOnDisk) {
    console.error(
      "scope-grid.json is out of date. Run `bun aidlc-graph.ts compile` to regenerate."
    );
    process.exit(1);
  }
}

// --- CLI ---

type Handler = (args: string[]) => Promise<void> | void;

function requireArg(args: string[], label: string): string {
  if (args.length === 0 || args[0].startsWith("--")) {
    throw new Error(`Missing required argument: <${label}>`);
  }
  return args[0];
}

// A required VALUED flag (--flag <value>). Throws when the flag is absent or
// its value slot is missing/another flag.
function requireFlag(args: string[], flag: string): string {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length || args[idx + 1].startsWith("--")) {
    throw new Error(`Missing required flag: ${flag} <value>`);
  }
  return args[idx + 1];
}

function printSlugs(stages: GraphStage[]): void {
  for (const s of stages) console.log(s.slug);
}

// --- ARS (Autonomy Risk Score) deterministic scoring ---
//
// The composer persona scores the five entropy components from evidence (the
// knowledge half); THIS code owns every downstream number: the weighted
// composite, band labels, the per-stage expected-value screen against the
// cost-prior table, nearest stock scopes by grid diff count, and the two
// pre-rendered gate tables. Same component scores in, same proposal numbers
// out — auditable and runnable without an LLM. All constants live in
// tools/data/ars-priors.json (schema-versioned); the persona's tables are
// documentation of that file, not the source. The composite stays an
// ADVISORY index: nothing deterministic routes on it.

const ARS_COMPONENTS = ["iae", "csu", "ve", "r", "ua"] as const;
export type ArsComponent = (typeof ARS_COMPONENTS)[number];
type ArsBand = "LOW" | "MED" | "HIGH";
type ArsDecision = "EXECUTE" | "SKIP" | "COMPLETED";
const ARS_PROJECT_TYPES = ["brownfield", "greenfield"] as const;
type ArsProjectType = (typeof ARS_PROJECT_TYPES)[number];

/** IEEE summation of the weighted terms can land a hair under an exact
 *  half-point - 0.75 + 12.45 + 7.3 evaluates to 20.499999999999996, which
 *  Math.round would drop into the band BELOW the one the documented formula
 *  computes exactly, and the band label is the one thing the gate table
 *  bolds. Normalising the sum at a precision far above the accumulated
 *  error (~1e-14 at composite magnitudes) makes the rounded total agree
 *  with exact arithmetic and keeps `raw` free of 62.74999999999999 noise. */
const ARS_RAW_PRECISION = 9;

interface ArsPriors {
  schemaVersion: number;
  weights: Record<ArsComponent, number>;
  componentInfo: Record<ArsComponent, { name: string }>;
  componentBands: { lowMax: number; medMax: number };
  compositeBands: Array<{ min: number; max: number; label: string; shape: string }>;
  evThresholds: Record<string, number>;
  stages: Record<
    string,
    {
      targets: ArsComponent[];
      cost: number | null;
      role?: string;
      // Present only on stages whose compiled `condition:` restricts them to
      // one kind of project (today: reverse-engineering, brownfield-only).
      // Absent = the stage runs on either project type.
      projectTypes?: ArsProjectType[];
    }
  >;
}

export interface ArsScreenRow {
  stage: string;
  number: string;
  decision: ArsDecision;
  screen:
    | "component"
    | "initialization"
    | "core"
    | "phase-gate"
    | "structural"
    | "project-type"
    | "no-cost-prior"
    | "no-prior"
    | "completed";
  targets: ArsComponent[];
  cost: number | null;
  maxTargetScore: number | null;
  threshold: number | null;
  reason: string;
}

export interface ArsResult {
  schemaVersion: 1;
  components: Record<ArsComponent, { name: string; score: number; band: ArsBand }>;
  composite: { raw: number; total: number; label: string; shape: string };
  evScreen: ArsScreenRow[];
  screenGrid: Record<string, "EXECUTE" | "SKIP">;
  nearestScopes: Array<{ scope: string; diff: number; differs: string[] }>;
  completed: string[];
  projectType: ArsProjectType | null;
  tables: { arsScores: string; stageDecisions: string };
}

/** Resolve tools/data/ars-priors.json. AIDLC_ARS_PRIORS mirrors the
 *  AIDLC_SCOPE_GRID test seam. Evaluated at call time. */
function arsPriorsPath(): string {
  return process.env.AIDLC_ARS_PRIORS ?? join(resolveDataDir(), "ars-priors.json");
}

/** Load + schema-validate the priors file. Throws (-> exit 1 via main's
 *  catch) on any violation: a silent fallback default would reintroduce
 *  exactly the unauditable arithmetic this file exists to remove. */
export function loadArsPriors(): ArsPriors {
  const p = arsPriorsPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf-8"));
  } catch (err) {
    throw new Error(`cannot read ars priors at ${p}: ${errorMessage(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ars priors at ${p}: not a JSON object.`);
  }
  const priors = parsed as ArsPriors;
  if (priors.schemaVersion !== 1) {
    throw new Error(
      `ars priors at ${p}: unsupported schemaVersion ${String(priors.schemaVersion)} (expected 1).`
    );
  }
  let weightSum = 0;
  for (const c of ARS_COMPONENTS) {
    const w = priors.weights?.[c];
    if (typeof w !== "number" || w < 0 || w > 1) {
      throw new Error(`ars priors: weights.${c} must be a number in [0,1].`);
    }
    weightSum += w;
    if (typeof priors.componentInfo?.[c]?.name !== "string") {
      throw new Error(`ars priors: componentInfo.${c}.name is missing.`);
    }
  }
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new Error(`ars priors: weights must sum to 1.0 (got ${weightSum}).`);
  }
  const lowMax = priors.componentBands?.lowMax;
  const medMax = priors.componentBands?.medMax;
  if (
    typeof lowMax !== "number" ||
    typeof medMax !== "number" ||
    !(0 < lowMax && lowMax < medMax && medMax <= 1)
  ) {
    throw new Error("ars priors: componentBands must satisfy 0 < lowMax < medMax <= 1.");
  }
  if (!Array.isArray(priors.compositeBands) || priors.compositeBands.length === 0) {
    throw new Error("ars priors: compositeBands must be a non-empty array.");
  }
  let expectMin = 0;
  for (const b of priors.compositeBands) {
    if (
      b.min !== expectMin ||
      typeof b.max !== "number" ||
      b.max < b.min ||
      typeof b.label !== "string" ||
      typeof b.shape !== "string"
    ) {
      throw new Error("ars priors: compositeBands must tile 0..100 contiguously with label + shape.");
    }
    expectMin = b.max + 1;
  }
  if (expectMin !== 101) {
    throw new Error("ars priors: compositeBands must end at 100.");
  }
  for (const [key, t] of Object.entries(priors.evThresholds ?? {})) {
    if (typeof t !== "number" || t < 0 || t > 1) {
      throw new Error(`ars priors: evThresholds["${key}"] must be a number in [0,1].`);
    }
  }
  for (const [slug, st] of Object.entries(priors.stages ?? {})) {
    if (!Array.isArray(st.targets) || st.targets.some((t) => !ARS_COMPONENTS.includes(t))) {
      throw new Error(
        `ars priors: stages.${slug}.targets must be a subset of {${ARS_COMPONENTS.join(", ")}}.`
      );
    }
    // Type before lookup: `String(cost) in evThresholds` alone accepts the
    // STRING "1", which then leaks into the result JSON's cost fields and
    // breaks the `number | null` contract this interface declares.
    if (st.cost !== null && typeof st.cost !== "number") {
      throw new Error(
        `ars priors: stages.${slug}.cost must be a number or null (got ${typeof st.cost}).`
      );
    }
    if (st.cost !== null && !(String(st.cost) in (priors.evThresholds ?? {}))) {
      throw new Error(`ars priors: stages.${slug}.cost ${String(st.cost)} has no evThresholds entry.`);
    }
    if (st.projectTypes !== undefined) {
      if (
        !Array.isArray(st.projectTypes) ||
        st.projectTypes.length === 0 ||
        st.projectTypes.some((t) => !ARS_PROJECT_TYPES.includes(t))
      ) {
        throw new Error(
          `ars priors: stages.${slug}.projectTypes must be a non-empty subset of {${ARS_PROJECT_TYPES.join(", ")}}.`
        );
      }
    }
  }
  return priors;
}

/** The deterministic half of the composer's Step 2/4/6/8a: composite +
 *  bands + EV screen + nearest stock scopes + gate tables. Pure with
 *  respect to its inputs; throws on out-of-range scores or unknown stage
 *  slugs (same typo discipline as validate-grid). */
export function computeArs(
  scores: Record<ArsComponent, number>,
  opts?: { completed?: string[]; projectType?: ArsProjectType }
): ArsResult {
  const priors = loadArsPriors();
  for (const c of ARS_COMPONENTS) {
    const v = scores[c];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`--${c} must be a number in [0.00, 1.00] (got ${String(v)}).`);
    }
    // The rubric and every rendered table speak in two decimals. Banding reads
    // the EXACT value while `fmt` renders it rounded, so a finer input makes
    // the two disagree in print: 0.299 renders "0.30 | LOW" against the
    // documented LOW < 0.30, and 0.4004 yields "reduces CSU=0.40 > threshold
    // 0.4". Rejecting here keeps table and band incapable of contradicting.
    if (Number(v.toFixed(2)) !== v) {
      throw new Error(`--${c} must have at most two decimals (got ${String(v)}).`);
    }
  }
  const graph = loadGraph();
  const knownSlugs = new Set(graph.map((s) => s.slug));
  const completed = opts?.completed ?? [];
  for (const slug of completed) {
    if (!knownSlugs.has(slug)) {
      throw new Error(`--completed names unknown stage "${slug}" - not in the compiled stage graph.`);
    }
  }
  // Same discipline for the priors themselves: an entry naming a stage the
  // compiled graph does not know is stale data, not a screening input. The
  // check runs against the UNFILTERED graph on purpose - loadGraph() drops
  // stages a plugin selection marked `enabled: false`, and the shipped
  // priors name every core stage, so screening against the filtered set
  // would make every `ars` call exit 1 on an install that disabled one.
  // A slug missing from the unfiltered graph is still stale and still throws.
  const compiledSlugs = new Set(loadStageGraphAll().map((s) => s.slug));
  for (const slug of Object.keys(priors.stages)) {
    if (!compiledSlugs.has(slug)) {
      throw new Error(`ars priors: stages.${slug} is not in the compiled stage graph.`);
    }
  }

  const band = (v: number): ArsBand =>
    v < priors.componentBands.lowMax ? "LOW" : v < priors.componentBands.medMax ? "MED" : "HIGH";
  const fmt = (v: number): string => v.toFixed(2);
  const sym = (c: ArsComponent): string => c.toUpperCase();

  const components = {} as ArsResult["components"];
  for (const c of ARS_COMPONENTS) {
    components[c] = { name: priors.componentInfo[c].name, score: scores[c], band: band(scores[c]) };
  }
  const raw = Number(
    (100 * ARS_COMPONENTS.reduce((acc, c) => acc + priors.weights[c] * scores[c], 0)).toFixed(
      ARS_RAW_PRECISION
    )
  );
  const total = Math.round(raw);
  const compositeBand = priors.compositeBands.find((b) => total >= b.min && total <= b.max);
  if (!compositeBand) {
    throw new Error(`composite ${total} falls outside the compositeBands coverage.`);
  }

  // Pass 1 - decide every stage except phase-gates (they key off the other
  // decisions in their phase). COMPLETED (in-flight context) wins over any
  // screen: the stage already ran, so it stays EXECUTE in the derived grid.
  const completedSet = new Set(completed);
  const projectType = opts?.projectType;
  // A stage whose compiled `condition:` restricts it to one project type is
  // decided by that condition, not by the component arithmetic: without this
  // the screen could emit `reverse-engineering EXECUTE` on a greenfield
  // project, contradicting the stage the composer would have to run. Only a
  // COMPLETED stage outranks it (it already ran; in-flight evidence wins).
  const offProjectType = (p?: { projectTypes?: ArsProjectType[] }): boolean =>
    projectType !== undefined &&
    p?.projectTypes !== undefined &&
    !p.projectTypes.includes(projectType);
  const decisionOf = new Map<string, ArsDecision>();
  const deferred = new Set<string>();
  for (const s of graph) {
    const p = priors.stages[s.slug];
    if (completedSet.has(s.slug)) {
      decisionOf.set(s.slug, "COMPLETED");
    } else if (offProjectType(p)) {
      decisionOf.set(s.slug, "SKIP");
    } else if (p?.role === "phase-gate") {
      deferred.add(s.slug);
    } else if (p?.role === "initialization" || p?.role === "core") {
      decisionOf.set(s.slug, "EXECUTE");
    } else if (!p || p.role === "structural" || p.cost === null) {
      decisionOf.set(s.slug, "SKIP");
    } else {
      const maxTarget = p.targets.length > 0 ? Math.max(...p.targets.map((t) => scores[t])) : 0;
      const threshold = priors.evThresholds[String(p.cost)];
      decisionOf.set(s.slug, maxTarget > threshold ? "EXECUTE" : "SKIP");
    }
  }
  // Pass 2 - a phase-gate executes iff any OTHER stage in its phase does
  // (persona: approval-handoff is "Always at ideation->inception boundary";
  // when the whole phase folds away, the boundary does not exist).
  for (const s of graph) {
    if (!deferred.has(s.slug)) continue;
    const phaseActive = graph.some(
      (o) => o.phase === s.phase && o.slug !== s.slug && decisionOf.get(o.slug) !== "SKIP"
    );
    decisionOf.set(s.slug, phaseActive ? "EXECUTE" : "SKIP");
  }

  // Pass 3 - render the screen rows in graph order with the reasoning the
  // gate table shows verbatim.
  const evScreen: ArsScreenRow[] = [];
  for (const s of graph) {
    const p = priors.stages[s.slug];
    const decision = decisionOf.get(s.slug) as ArsDecision;
    const base = {
      stage: s.slug,
      number: s.number,
      decision,
      targets: p?.targets ?? [],
      cost: p?.cost ?? null,
      maxTargetScore: null as number | null,
      threshold: null as number | null,
    };
    if (decision === "COMPLETED") {
      evScreen.push({
        ...base,
        screen: "completed",
        reason: "completed - in-flight evidence; kept as EXECUTE in the derived grid",
      });
    } else if (!p) {
      evScreen.push({
        ...base,
        screen: "no-prior",
        reason: "no entry in ars-priors.json - not screenable",
      });
    } else if (offProjectType(p)) {
      evScreen.push({
        ...base,
        screen: "project-type",
        reason: `project is ${String(projectType)} - the stage's compiled condition restricts it to ${(p.projectTypes ?? []).join("/")} projects`,
      });
    } else if (p.role === "initialization") {
      evScreen.push({ ...base, screen: "initialization", reason: "initialization - always runs" });
    } else if (p.role === "core") {
      evScreen.push({ ...base, screen: "core", reason: "spine - always (core implementation / verification)" });
    } else if (p.role === "phase-gate") {
      evScreen.push({
        ...base,
        screen: "phase-gate",
        reason:
          decision === "EXECUTE"
            ? `phase gate - other ${s.phase} stages execute, so the boundary exists`
            : `phase gate - every other ${s.phase} stage folds away, so the boundary does not exist`,
      });
    } else if (p.role === "structural") {
      evScreen.push({
        ...base,
        screen: "structural",
        reason: "structural (decomposition) - not numerically screenable; mechanical default SKIP, human judgment at the gate",
      });
    } else if (p.cost === null) {
      evScreen.push({
        ...base,
        screen: "no-cost-prior",
        reason: "no cost prior in the shipped table - not numerically screenable; human judgment at the gate",
      });
    } else {
      const maxSym = p.targets.reduce((a, b) => (scores[a] >= scores[b] ? a : b));
      const maxTarget = scores[maxSym];
      const threshold = priors.evThresholds[String(p.cost)];
      evScreen.push({
        ...base,
        maxTargetScore: maxTarget,
        threshold,
        screen: "component",
        reason:
          decision === "EXECUTE"
            ? `reduces ${sym(maxSym)}=${fmt(maxTarget)} > threshold ${threshold} (cost ${p.cost})`
            : `max target ${sym(maxSym)}=${fmt(maxTarget)} <= threshold ${threshold} (cost ${p.cost})`,
      });
    }
  }

  const screenGrid: Record<string, "EXECUTE" | "SKIP"> = {};
  for (const s of graph) {
    screenGrid[s.slug] = decisionOf.get(s.slug) === "SKIP" ? "SKIP" : "EXECUTE";
  }

  // Nearest stock scopes by grid diff count against the mechanical screen
  // grid. The composer's folded grid may differ - this is the deterministic
  // starting signal, not the proposal.
  const nearestScopes = nearestStockScopes(screenGrid);

  const arsScores = [
    "| Component | Symbol | Score | Band |",
    "|-----------|--------|-------|------|",
    ...ARS_COMPONENTS.map(
      (c) => `| ${components[c].name} | ${sym(c)} | ${fmt(scores[c])} | ${components[c].band} |`
    ),
    `| **Composite ARS (advisory)** | - | **${total} / 100** | **${compositeBand.label}** |`,
  ].join("\n");
  const stageDecisions = [
    "| # | Stage | Decision | Reasoning |",
    "|---|-------|----------|-----------|",
    ...evScreen.map((r) => `| ${r.number} | ${r.stage} | ${r.decision} | ${r.reason} |`),
  ].join("\n");

  return {
    schemaVersion: 1,
    components,
    composite: { raw, total, label: compositeBand.label, shape: compositeBand.shape },
    evScreen,
    screenGrid,
    nearestScopes,
    completed,
    projectType: opts?.projectType ?? null,
    tables: { arsScores, stageDecisions },
  };
}

const COMMANDS: Record<string, Handler> = {
  artifacts: () => {
    for (const name of [...artifactsRegistry()].sort()) {
      console.log(name);
    }
  },
  producers: (args) => {
    printSlugs(producersOf(requireArg(args, "artifact")));
  },
  consumers: (args) => {
    printSlugs(consumersOf(requireArg(args, "artifact")));
  },
  topo: () => {
    for (const slug of topoSort(loadGraph())) console.log(slug);
  },
  cycles: (args) => {
    // `cycles` -> full graph; `cycles --scope <name>` -> per-scope sub-DAG.
    const scopeIdx = args.indexOf("--scope");
    const stages =
      scopeIdx >= 0 && args[scopeIdx + 1]
        ? subgraphForScope(args[scopeIdx + 1])
        : loadGraph();
    const cs = findCycles(stages);
    if (cs.length === 0) return;
    for (const c of cs) console.log(c.join(" -> "));
    process.exit(1);
  },
  scope: (args) => {
    printSlugs(subgraphForScope(requireArg(args, "scope")));
  },
  "validate-scope": (args) => {
    const r = validateScope(requireArg(args, "scope"));
    for (const a of r.advisories) console.error(`[advisory] ${a}`);
    if (!r.valid) {
      for (const e of r.errors) console.error(`[error] ${e}`);
      process.exit(1);
    }
  },
  // ars --iae <s> --csu <s> --ve <s> --r <s> --ua <s> [--completed <csv>]
  // [--project-type <bg>] - the deterministic ARS arithmetic: weighted
  // composite + band labels, the per-stage EV screen against the cost-prior
  // table, nearest stock scopes by grid diff count, and the two gate tables
  // pre-rendered as markdown - all constants read from
  // tools/data/ars-priors.json. The composer scores the five components from
  // evidence, runs this, and copies the output verbatim; a model never does
  // the multiplication. --project-type screens out the stages whose compiled
  // condition restricts them to the other kind of project (greenfield ->
  // reverse-engineering SKIPs) so the mechanical screen cannot contradict a
  // stage's own execution condition. Prints a JSON ArsResult on stdout; exit
  // 1 on out-of-range scores, unknown stage slugs (same typo discipline as
  // validate-grid), or a priors-schema violation. The composite is advisory:
  // nothing deterministic routes on it.
  ars: (args) => {
    const scores = {} as Record<ArsComponent, number>;
    for (const c of ARS_COMPONENTS) {
      const rawScore = requireFlag(args, `--${c}`);
      const v = Number(rawScore);
      if (rawScore.trim() === "" || !Number.isFinite(v) || v < 0 || v > 1) {
        console.error(`ars: --${c} must be a number in [0.00, 1.00] (got "${rawScore}").`);
        process.exit(1);
      }
      if (Number(v.toFixed(2)) !== v) {
        console.error(`ars: --${c} must have at most two decimals (got "${rawScore}").`);
        process.exit(1);
      }
      scores[c] = v;
    }
    const compIdx = args.indexOf("--completed");
    const compRaw = compIdx >= 0 ? args[compIdx + 1] : undefined;
    if (compIdx >= 0 && (compRaw === undefined || compRaw.startsWith("--"))) {
      console.error("ars: --completed requires a comma-separated value.");
      process.exit(1);
    }
    const completed =
      compRaw === undefined
        ? undefined
        : compRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const ptIdx = args.indexOf("--project-type");
    const ptRaw = ptIdx >= 0 ? args[ptIdx + 1] : undefined;
    // Same shape as the --completed guard one screen up: a trailing flag with
    // no value must not fall through to "unset". Silently ignoring it would
    // report EXECUTE for a stage the caller believes the screen excluded.
    // (A flag-as-value, `--project-type --completed x`, is already rejected by
    // the enum check below, which names what it read.)
    if (ptIdx >= 0 && ptRaw === undefined) {
      console.error("ars: --project-type requires a value (brownfield or greenfield).");
      process.exit(1);
    }
    let projectType: ArsProjectType | undefined;
    if (ptRaw !== undefined) {
      const lowered = ptRaw.toLowerCase();
      if (lowered !== "brownfield" && lowered !== "greenfield") {
        console.error(`ars: --project-type must be brownfield or greenfield (got "${ptRaw}").`);
        process.exit(1);
      }
      projectType = lowered;
    }
    const result = computeArs(scores, { completed, projectType });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  },
  // validate-grid --proposal <path> [--strict] [--project-type <bg>]
  // [--keywords <csv>] - validate an ARBITRARY {slug: EXECUTE|SKIP} grid
  // (the composer's proposal JSON; also accepts a { stages: {...} } wrapper
  // matching a scope-grid entry). Lenient mode mirrors validate-scope
  // (off-path producer of a required consume = advisory); --strict is the
  // recompose mode that REJECTS a starved required input. --keywords checks
  // each granted keyword against the keywords already claimed by existing
  // scopes (the same loadScopeMapping data inference reads): a collision is
  // a hard ERROR naming the colliding scope, because inference takes the
  // first alphabetical keyword match and a duplicate would permanently
  // shadow the incumbent. Prints a JSON ScopeValidation on stdout; exit 1
  // iff invalid - callers branch on the exit code and read the reasons off
  // stdout.
  "validate-grid": (args) => {
    const proposalPath = requireFlag(args, "--proposal");
    const strict = args.includes("--strict");
    const kwIdx = args.indexOf("--keywords");
    const kwRaw = kwIdx >= 0 ? args[kwIdx + 1] : undefined;
    if (kwIdx >= 0 && (kwRaw === undefined || kwRaw.startsWith("--"))) {
      console.error("validate-grid: --keywords requires a comma-separated value.");
      process.exit(1);
    }
    const ptIdx = args.indexOf("--project-type");
    const ptRaw = ptIdx >= 0 ? args[ptIdx + 1] : undefined;
    let projectType: "brownfield" | "greenfield" | undefined;
    if (ptRaw !== undefined) {
      const lowered = ptRaw.toLowerCase();
      if (lowered !== "brownfield" && lowered !== "greenfield") {
        console.error(
          `validate-grid: --project-type must be brownfield or greenfield (got "${ptRaw}").`
        );
        process.exit(1);
      }
      projectType = lowered;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(proposalPath, "utf-8"));
    } catch (err) {
      console.error(`validate-grid: cannot read ${proposalPath}: ${errorMessage(err)}`);
      process.exit(1);
    }
    // Accept either the bare {slug: action} map or a {stages: {...}} wrapper
    // (the shape of a scope-grid.json entry / the composer's proposal.grid).
    const obj = parsed as Record<string, unknown>;
    const gridRaw =
      obj !== null && typeof obj === "object" && typeof obj.stages === "object" && obj.stages !== null
        ? (obj.stages as Record<string, unknown>)
        : obj;
    if (gridRaw === null || typeof gridRaw !== "object" || Array.isArray(gridRaw)) {
      console.error(
        "validate-grid: proposal must be a JSON object of {\"<stage-slug>\": \"EXECUTE\"|\"SKIP\"} (or {stages: {...}})."
      );
      process.exit(1);
    }
    const grid: Record<string, string> = {};
    for (const [slug, action] of Object.entries(gridRaw)) grid[slug] = String(action);
    const r = validateGrid(grid, { strict, projectType });
    if (kwRaw !== undefined) {
      const granted = kwRaw.split(",").map((k) => k.trim()).filter(Boolean);
      for (const err of keywordCollisions(granted)) r.errors.push(err);
      r.valid = r.errors.length === 0;
    }
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    if (!r.valid) process.exit(1);
  },
  compile: (args) => {
    if (args.includes("--check")) return runCompileCheck();
    // Concurrency-safe write per the explainer's "from day one" stance:
    //   - withAuditLock serialises concurrent compiles. The second waits
    //     for the first; both run against fresh source state.
    //   - writeFileAtomic (temp + POSIX rename) means readers always see
    //     either the previous output or the new one, never a half-written
    //     file. Crash mid-write leaves stage-graph.json intact.
    // Both compiled artifacts (stage-graph.json + the transposed
    // scope-grid.json) are derived from the same in-memory stages and
    // written under the one lock so they never diverge.
    const pd = resolveProjectDir();
    requireInstalledHarness(pd);
    const writeCompiledGraph = (): void => {
      const { json, gridJson } = compileStageGraph();
      writeFileAtomic(mutableStageGraphPath(pd), json);
      writeFileAtomic(mutableScopeGridPath(pd), gridJson);
    };
    const inheritedOwnerRaw = process.env.AIDLC_WORKSPACE_LOCK_OWNER_PID;
    if (inheritedOwnerRaw !== undefined) {
      const inheritedOwner = Number(inheritedOwnerRaw);
      if (
        inheritedOwner !== process.ppid ||
        !auditLockOwnedByProcess(pd, inheritedOwner)
      ) {
        throw new Error(
          "Refusing inherited workspace lock: the declared owner is not this process's live parent lock holder."
        );
      }
      writeCompiledGraph();
    } else {
      withAuditLock(pd, writeCompiledGraph);
    }
  },
  resolve: (args) => {
    // resolve <scope> — emit the active scope's plan (.aidlc-plan.json) to
    // the project dir. The plan is the EXECUTE/SKIP slice for the scope,
    // derived from the compiled grid (the same transpose runtime reads).
    // Feature-flagged via AIDLC_GRAPH_RESOLVE=1 so it ships
    // behind a gate until the orchestrator opts into engine-side resolution.
    if (process.env.AIDLC_GRAPH_RESOLVE !== "1") {
      console.error(
        "aidlc-graph resolve is gated behind AIDLC_GRAPH_RESOLVE=1 (rollout flag)."
      );
      process.exit(1);
    }
    const scope = requireArg(args, "scope");
    const plan = resolvePlanForScope(scope);
    const pd = resolveProjectDir();
    const outPath =
      process.env.AIDLC_PLAN_PATH ?? planFilePath(pd);
    const planJson = `${JSON.stringify(plan, null, 2)}\n`;
    if (args.includes("--stdout")) {
      process.stdout.write(planJson);
      return;
    }
    writeFileAtomic(outPath, planJson);
    console.log(outPath);
  },
  export: (args) => {
    const json = canonicalExportJson(exportBundle());
    if (args.includes("--check")) {
      const fixturePath = exportFixturePath();
      let expected: string;
      try {
        expected = readFileSync(fixturePath, "utf-8");
      } catch {
        console.error(`export --check: fixture not found at ${fixturePath}`);
        process.exit(1);
      }
      if (json !== expected) {
        console.error(
          `export --check: bundle drift vs ${fixturePath}. ` +
            `Regenerate with: bun aidlc-graph.ts export > ${fixturePath}`
        );
        process.exit(1);
      }
      return;
    }
    // process.stdout.write preserves the emitter's canonical trailing
    // newline exactly. console.log would add a second newline, breaking
    // byte-parity between `export > file` and `export --check` against
    // that file.
    process.stdout.write(json);
  },
};

/** Resolve the designer-export fixture path. Mirrors stageGraphPath()'s
 *  env-var seam pattern so tests can point `export --check` at a tempfile
 *  without mutating the real fixture. Repo-root is 4 levels up from
 *  dist/claude/.claude/tools/ (tools → .claude → claude → dist → root). */
function exportFixturePath(): string {
  const envPath = process.env.AIDLC_EXPORT_FIXTURE;
  if (envPath) return envPath;
  const repoRoot = join(__FILE_DIR, "..", "..", "..", "..");
  return join(repoRoot, "tests", "fixtures", "designer-export", "export.json");
}

function printHelp(): void {
  const available = Object.keys(COMMANDS).sort().join(", ");
  console.log(`Usage: aidlc-graph <subcommand>

Subcommands:
  ${available}
  --help, -h     Show this message

Common forms:
  aidlc-graph artifacts                List all artifact slugs
  aidlc-graph producers <artifact>     Stages producing an artifact
  aidlc-graph consumers <artifact>     Stages consuming an artifact
  aidlc-graph topo                     Topological sort of full graph
  aidlc-graph cycles                   Cycle check on full graph
  aidlc-graph cycles --scope <name>    Cycle check on scope sub-DAG
  aidlc-graph scope <name>             Stages on a scope's path
  aidlc-graph validate-scope <name>    Validate scope dependencies
  aidlc-graph validate-grid --proposal <path> [--strict] [--project-type <t>] [--keywords <csv>]
                                       Validate an arbitrary EXECUTE/SKIP grid
                                       (--strict rejects a starved required input;
                                       --keywords rejects keywords an existing scope claims)
  aidlc-graph ars --iae <s> --csu <s> --ve <s> --r <s> --ua <s> [--completed <csv>] [--project-type <t>]
                                       Deterministic ARS arithmetic: composite + bands,
                                       per-stage EV screen, nearest stock scopes, and the
                                       two gate tables (data: tools/data/ars-priors.json)
  aidlc-graph compile                  Regenerate stage-graph.json + scope-grid.json from YAML
  aidlc-graph compile --check          CI drift guard (exit 1 on mismatch)
  aidlc-graph resolve <name>           Emit .aidlc-plan.json for a scope (AIDLC_GRAPH_RESOLVE=1)
  aidlc-graph export                   Emit designer-facing bundle (stdout)
  aidlc-graph export --check           CI drift guard against fixture

See docs/reference/16-artifact-vocabulary.md for artifact rules.`);
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  if (cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === undefined) {
    // No subcommand — print usage hint to stderr and exit 1. t63 asserts
    // this shape (stderr-only, mentions "artifacts" to aid discovery).
    const available = Object.keys(COMMANDS).sort().join(", ");
    console.error(
      `Usage: aidlc-graph <subcommand>. Valid: ${available}. Run with --help for detail.`
    );
    process.exit(1);
  }
  const handler = COMMANDS[cmd];
  if (!handler) {
    const available = Object.keys(COMMANDS).sort().join(", ");
    console.error(
      `Unknown subcommand: ${cmd}. Valid: ${available}`
    );
    process.exit(1);
  }
  try {
    await handler(args);
  } catch (err) {
    console.error(`aidlc-graph ${cmd}: ${errorMessage(err)}`);
    process.exit(1);
  }
}

if (import.meta.main) void main(process.argv.slice(2));
