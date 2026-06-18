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
// truth for everything else while computed fields stay computed. Adding
// a new stage requires pre-seeding {slug, number, name} in
// stage-graph.json before the first compile; renumbering existing
// stages similarly edits those rows then recompiles.
//
// See docs/reference/16-artifact-vocabulary.md for artifact naming.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _resetScopeMappingForTests,
  type AgentMetadata,
  errorMessage,
  loadAgents,
  loadScopeMapping,
  harnessDir,
  rulesSubdir,
  loadStageGraph,
  mustGet,
  mustPop,
  mustShift,
  parseStageFrontmatter,
  resolveProjectDir,
  type ScopeDefinition,
  type StageEntry,
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
// capability filter (matches) verbatim. matches is omitted when the
// manifest declares no path filter (e.g., required-sections,
// upstream-coverage). The PostToolUse hook reads the snapshotted matches
// off the graph node — never re-opens the manifest at fire time.
export interface SensorResolution {
  id: string;
  path: string;
  matches?: string;
}

// Authoritative graph stage shape — fully-populated, no optionals
// except for genuinely-optional-per-spec fields (condition, for_each).
// StageEntry in lib.ts carries the same fields as optional so existing
// runtime callers stay source-compatible without caring about the
// extended shape.
export interface GraphStage extends StageEntry {
  condition?: string;
  produces: string[];
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
  // reviewer_max_iterations — review cycle cap before escalating to human.
  // Defaults to 2 when reviewer is present.
  reviewer_max_iterations?: number;
}

export interface ScopeValidation {
  valid: boolean;
  errors: string[];
  advisories: string[];
}

// --- Module-local state ---

const __FILE_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__FILE_DIR, "data");
const DEFAULT_STAGES_DIR = join(__FILE_DIR, "..", "aidlc-common", "stages");

/** Resolve the stages directory. AIDLC_STAGES_DIR env-var seam mirrors
 *  AIDLC_RULES_DIR + AIDLC_SENSORS_DIR so t89's fixture-driven import
 *  tests can isolate from the real stages tree (e.g., zero-sensors
 *  scenarios where no stage may declare any imports). Evaluated at call
 *  time. */
function stagesDir(): string {
  return process.env.AIDLC_STAGES_DIR ?? DEFAULT_STAGES_DIR;
}

/** Resolve the stage-graph.json path. Mirrors lib.ts:loadStageGraph()'s
 *  AIDLC_STAGE_GRAPH env-var seam (lib.ts:295-296) so tests can point both
 *  loader and compile-check at a temp file. Evaluated at call time so tests
 *  that set/unset the env mid-process see the change. */
function stageGraphPath(): string {
  return process.env.AIDLC_STAGE_GRAPH ?? join(DATA_DIR, "stage-graph.json");
}

/** Resolve the rules directory. AIDLC_RULES_DIR env-var seam mirrors
 *  AIDLC_STAGE_GRAPH so t88's fixture-driven inheritance tests can isolate
 *  from the real .claude/rules/ tree. Evaluated at call time. */
function rulesDir(): string {
  return process.env.AIDLC_RULES_DIR ?? join(__FILE_DIR, "..", rulesSubdir());
}

/** Resolve the sensors directory. AIDLC_SENSORS_DIR env-var seam mirrors
 *  AIDLC_RULES_DIR so t89's fixture-driven import tests can isolate from
 *  the real .claude/sensors/ tree. Evaluated at call time. */
function sensorsDir(): string {
  return process.env.AIDLC_SENSORS_DIR ?? join(__FILE_DIR, "..", "sensors");
}

/** Resolve the compiled scope-grid.json path. Mirrors stageGraphPath()'s
 *  AIDLC_STAGE_GRAPH seam: AIDLC_SCOPE_GRID lets the parity/transpose tests
 *  point `compile --check` at a tempfile without touching the real grid.
 *  Evaluated at call time so tests that set/unset mid-process see it. */
function scopeGridPath(): string {
  return process.env.AIDLC_SCOPE_GRID ?? join(DATA_DIR, "scope-grid.json");
}

let _graph: GraphStage[] | null = null;
let _artifactsRegistry: ReadonlySet<string> | null = null;
let _scopeGrid: ScopeGrid | null = null;

/** Reset all module-level caches. Test-only — used when fixture
 *  injection via AIDLC_STAGE_GRAPH swaps the backing file mid-process.
 *  Also resets lib.ts's scope-mapping cache (AIDLC_SCOPE_MAPPING env-seam)
 *  because the export consumer reads both graph and scope-mapping in one
 *  call; resetting only the local cache leaves a stale scope view. */
export function __resetGraphCache(): void {
  _graph = null;
  _artifactsRegistry = null;
  _scopeGrid = null;
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
  "phase",
  "execution",
  "condition",
  "lead_agent",
  "support_agents",
  "mode",
  "for_each",
  "produces",
  "consumes",
  "requires_stage",
  "sensors",
  "scopes",
  "reviewer",
  "reviewer_max_iterations",
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
// file with no rule-side glob filter. The
// `aidlc-{team,project}-learnings.md` slots in the filename regex are
// reserved for the future memory-gate surface; today no learnings files
// ship.

export interface RuleFile {
  path: string;          // ".claude/rules/aidlc-org.md"
  scope: "org" | "team" | "project" | "phase";
  phase?: string;        // populated only when scope === "phase"
  frontmatter: RuleFrontmatter;
  // `## <heading>` -> concatenated body text, surfaced from the same `raw`
  // loadRules() already reads. The doctor rule-drift check reads this
  // directly (single walking surface) instead of re-reading from `path`
  // (a relative DISPLAY path that would miss the AIDLC_RULES_DIR fixture).
  headings: Map<string, string>;
}

// Filename anchor. `team-learnings` and `project-learnings` slots are
// the future memory-gate surface (two-surface separation locked
// 2026-05-24). The regex permits them so the future memory-gate work
// doesn't have to widen the schema. Anything not matching is silently
// ignored — including user-extension overlays like `team-overrides.md`
// (no `aidlc-` prefix), per 08-rule-system.md.
const RULE_FILE_REGEX =
  /^aidlc-(org|team|team-learnings|project|project-learnings|phase-[a-z][a-z0-9-]*)\.md$/;

// Scope-priority for the deterministic sort. learnings sit immediately
// after their parent tier's substantive file so the resolved chain reads
// org → team → team-learnings → project → project-learnings → phase.
const SCOPE_PRIORITY: Record<string, number> = {
  "org": 0,
  "team": 1,
  "team-learnings": 1.5,
  "project": 2,
  "project-learnings": 2.5,
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

  const matched: RuleFile[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(RULE_FILE_REGEX);
    if (!m) continue;

    const scopeKey = m[1];
    const filePath = join(dir, f);
    const raw = readFileSync(filePath, "utf-8");
    const fm = parseRuleFrontmatter(raw);
    validateRuleFrontmatter(fm, filePath);
    const headings = parseRuleHeadings(raw);

    let scope: RuleFile["scope"];
    let phase: string | undefined;
    if (scopeKey.startsWith("phase-")) {
      scope = "phase";
      phase = scopeKey.slice("phase-".length);
    } else if (scopeKey === "team-learnings") {
      scope = "team";
    } else if (scopeKey === "project-learnings") {
      scope = "project";
    } else {
      // scopeKey didn't match any of the named cases above ("phase-*",
      // "team-learnings", "project-learnings") nor was it a known prefix.
      // The filename pattern that fed scopeKey is \\.claude/rules/aidlc-(.+)\\.md
      // — the only legal scopes left are "org" and "team". Verify and assert.
      if (scopeKey !== "org" && scopeKey !== "team" && scopeKey !== "project") {
        // Filename was aidlc-<unknown>.md — not a recognised rule scope.
        // Skip silently to match the previous else-cast behaviour (which
        // accepted any string).
        continue;
      }
      scope = scopeKey;
    }

    matched.push({
      path: toPosix(join(harnessDir(), rulesSubdir(), f)),
      scope,
      phase,
      frontmatter: fm,
      headings,
    });
  }

  // Deterministic sort: (scope-priority, filename). readdirSync is
  // filesystem-order; non-portable. The sort is the determinism contract
  // that t66's canonical-emitter pin and `--check` rely on.
  matched.sort((a, b) => {
    const aKey = a.scope === "team" && a.path.includes("team-learnings")
      ? "team-learnings"
      : a.scope === "project" && a.path.includes("project-learnings")
        ? "project-learnings"
        : a.scope;
    const bKey = b.scope === "team" && b.path.includes("team-learnings")
      ? "team-learnings"
      : b.scope === "project" && b.path.includes("project-learnings")
        ? "project-learnings"
        : b.scope;
    const pri = SCOPE_PRIORITY[aKey] - SCOPE_PRIORITY[bKey];
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
    const entry: SensorResolution = { id: sensor.id, path: sensor.path };
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
 *  consumer candidate (doctor surfaces). */
export function producersOf(artifact: string): GraphStage[] {
  return loadGraph().filter((s) => (s.produces ?? []).includes(artifact));
}

/** Stages that consume the given artifact. */
export function consumersOf(artifact: string): GraphStage[] {
  return loadGraph().filter((s) =>
    (s.consumes ?? []).some((c) => c.artifact === artifact)
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

/** Resolve a scope's plan: the EXECUTE/SKIP slice over the full graph in
 *  numeric order, shaped `{slug, phase, action}` — byte-identical to
 *  lib.ts's stagesInScope() / the legacy scope-mapping-derived plan. The
 *  `aidlc-graph resolve` subcommand writes this to .aidlc-plan.json. The
 *  parity test asserts this matches the legacy plan across all 9 scopes. */
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
  const subgraph = subgraphForScope(scope);
  const onPath = new Set(subgraph.map((s) => s.slug));
  const errors: string[] = [];
  const advisories: string[] = [];

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
        advisories.push(
          `Stage "${stage.slug}" requires artifact "${consume.artifact}" ` +
            `whose producer(s) [${producers.map((p) => p.slug).join(", ")}] ` +
            `are not on the "${scope}" path. Ensure existing artifact is current.`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, advisories };
}

/** Union of produces[] across all stages. */
export function artifactsRegistry(): ReadonlySet<string> {
  if (!_artifactsRegistry) {
    const stages = loadGraph();
    const names = new Set<string>();
    for (const stage of stages) {
      for (const name of stage.produces ?? []) {
        names.add(name);
      }
    }
    _artifactsRegistry = names;
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
export function transposeScopeGrid(stages: GraphStage[]): ScopeGrid {
  const scopeNames = new Set<string>();
  for (const s of stages) {
    for (const name of s.scopes ?? []) scopeNames.add(name);
  }
  const grid: ScopeGrid = {};
  for (const scope of [...scopeNames].sort()) {
    const stagesMap: Record<string, "EXECUTE" | "SKIP"> = {};
    for (const s of stages) {
      stagesMap[s.slug] = (s.scopes ?? []).includes(scope) ? "EXECUTE" : "SKIP";
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

/** Parse a numeric stage identifier like "3.5" into a tuple [phase, index]
 *  for total-ordering comparison. Returns negative, zero, or positive. */
export function numericStageOrder(a: string, b: string): number {
  const [aP, aI] = a.split(".").map((x) => parseInt(x, 10));
  const [bP, bI] = b.split(".").map((x) => parseInt(x, 10));
  if (aP !== bP) return aP - bP;
  return aI - bI;
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
  // Harvest number + name mappings from existing JSON. Adding a new
  // stage requires pre-seeding a {slug, number, name} row before first
  // compile; renumbering existing stages is an explicit JSON edit.
  const existing = loadStageGraph();
  const numberBySlug = new Map(existing.map((s) => [s.slug, s.number]));
  const nameBySlug = new Map(existing.map((s) => [s.slug, s.name]));

  const stages: GraphStage[] = [];
  // Track slug-to-first-file so duplicate-slug errors name both files.
  const slugToFile = new Map<string, string>();

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
    for (const f of readdirSync(pdir).filter((f) => f.endsWith(".md"))) {
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

      const number = numberBySlug.get(slug);
      const name = nameBySlug.get(slug);
      if (!number || !name) {
        throw new Error(
          `Stage "${slug}" (${filePath}) not found in stage-graph.json. ` +
            `Pre-seed new rows and edit renumbered rows in stage-graph.json ` +
            `before compile.`
        );
      }

      stages.push(buildGraphStage(validation.data, phase, number, name));
    }
  }

  // Sort by numeric order (phase-prefix.index).
  stages.sort((a, b) => numericStageOrder(a.number, b.number));

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
  // sensors[] list is looked up against the manifest registry; matches
  // is copied verbatim into the resolved entry. Unknown ids throw —
  // authoring errors fail loud at compile, not at fire time.
  const sensorsById = loadSensors();
  for (const stage of stages) {
    stage.sensors_applicable = resolveSensorsForStage(stage, sensorsById);
  }

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

  return {
    json: canonicalStageGraphJson(stages),
    gridJson: canonicalScopeGridJson(transposeScopeGrid(stages)),
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
  const requires_stage = parsed.requires_stage ?? [];
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
  if (parsed.condition !== undefined) {
    stage.condition = parsed.condition;
  }
  if (parsed.for_each !== undefined) {
    stage.for_each = parsed.for_each;
  }
  if (parsed.sensors !== undefined) {
    stage.sensors = parsed.sensors;
  }
  if (parsed.scopes !== undefined) {
    stage.scopes = parsed.scopes;
  }
  if (parsed.reviewer !== undefined) {
    stage.reviewer = parsed.reviewer;
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
  // as a stale one rather than throwing an unhandled ENOENT.
  let gridOnDisk: string;
  try {
    gridOnDisk = readFileSync(scopeGridPath(), "utf-8");
  } catch {
    gridOnDisk = "";
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

function printSlugs(stages: GraphStage[]): void {
  for (const s of stages) console.log(s.slug);
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
    withAuditLock(pd, () => {
      const { json, gridJson } = compileStageGraph();
      writeFileAtomic(stageGraphPath(), json);
      writeFileAtomic(scopeGridPath(), gridJson);
    });
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
      process.env.AIDLC_PLAN_PATH ?? join(pd, "aidlc-docs", ".aidlc-plan.json");
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
  aidlc-graph compile                  Regenerate stage-graph.json + scope-grid.json from YAML
  aidlc-graph compile --check          CI drift guard (exit 1 on mismatch)
  aidlc-graph resolve <name>           Emit .aidlc-plan.json for a scope (AIDLC_GRAPH_RESOLVE=1)
  aidlc-graph export                   Emit designer-facing bundle (stdout)
  aidlc-graph export --check           CI drift guard against fixture

See docs/reference/16-artifact-vocabulary.md for artifact rules.`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
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

if (import.meta.main) void main();
