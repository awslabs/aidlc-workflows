// gen-coverage-registry.ts — the L-SURFACE coverage registry + CI ratchet.
//
// WHAT THIS IS. The mechanism that makes test coverage ENFORCED, not hoped.
// It enumerates the real "units" of the framework FROM DISK (the left side of
// the join, which cannot drift because it IS reality read fresh each run),
// discovers which test files CLAIM to cover each unit (the right side, via a
// machine-readable `// covers:` / `# covers:` header), JOINS the two through a
// GUARANTEE-PRINCIPLE GATE (a test's mechanism must be >= the unit's
// minMechanism), and EMITS tests/.coverage-registry.json.
//
// WHY IT EXISTS. A new arg-dispatch case, a new VALID_EVENT_TYPES member, or a
// new scope-mapping.json key changes the enumerated universe. If nobody wrote a
// `covers:` claim for it, the unit lands status=UNCOVERED, the regenerated
// registry differs from the committed one, and `--check` exits 1 naming the
// gap. Coverage cannot silently rot because the universe is recomputed from
// source on every CI run.
//
// THE FRESHNESS-DIFF IDIOM (borrowed from aidlc-graph.ts compile/export
// --check, :1127 / :1142). `--check` regenerates the registry in memory, diffs
// it against the committed tests/.coverage-registry.json, and exits 1 with the
// diff on any mismatch. Same shape as the proven stage-graph drift guard.
//
// THE RATCHET (tests/.coverage-ratchet.json). A committed per-class baseline of
// how many units are covered RIGHT NOW (honest: most are UNCOVERED). `--check`
// also fails if any class's covered-count DECREASES below its baseline without
// a reviewed deferred entry — monotonic anti-regression. You can only ever
// cover MORE; you cannot quietly drop a claim and stay green.
//
// TWO ANTI-ROT GUARDS (mandatory, run inside --check and in the test):
//   (a) NON-EMPTY enumeration per unit class. A broken enumerator that returns
//       [] would otherwise report "100% covered, 0 units". We assert each class
//       count > 0.
//   (b) SUBCOMMAND CROSS-CHECK. The structured arg-dispatch parser's count must
//       equal an INDEPENDENT regex count of dispatch sites in the same anchored
//       block. Catches a parser that silently stops seeing a tool.
//
// Run:
//   bun tests/gen-coverage-registry.ts            # regenerate + write the 3 files
//   bun tests/gen-coverage-registry.ts --check     # CI drift guard (exit 1 on drift)
//   bun tests/gen-coverage-registry.ts --print      # regenerate to stdout, write nothing

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths. Resolved from this file's location so the tool runs from any cwd.
// tests/ is one level below repo root; the shipped tools live under
// dist/claude/.claude/tools/.
// ---------------------------------------------------------------------------
const __FILE_DIR = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = __FILE_DIR;

// ENV-VAR SEAMS (mirrors aidlc-graph.ts's AIDLC_EXPORT_FIXTURE pattern, :1172).
// Tests point these at a temp tree to PROVE the ratchet: copy the shipped
// source, inject a fake new audit event / subcommand, and run `--check` against
// the temp roots + temp committed baselines without mutating real source.
//   AIDLC_COVERAGE_SRC_ROOT  — repo root containing dist/claude/ (source)
//   AIDLC_COVERAGE_TESTS_DIR — dir containing the test tiers to scan for claims
//   AIDLC_COVERAGE_REGISTRY  — committed .coverage-registry.json to diff against
//   AIDLC_COVERAGE_RATCHET   — committed .coverage-ratchet.json to ratchet against
const REPO_ROOT = process.env.AIDLC_COVERAGE_SRC_ROOT ?? join(TESTS_DIR, "..");
const CLAIMS_TESTS_DIR = process.env.AIDLC_COVERAGE_TESTS_DIR ?? TESTS_DIR;
const TOOLS_DIR = join(
  REPO_ROOT,
  "dist", "claude",
  ".claude",
  "tools",
);
const HOOKS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "hooks");
const STATUSLINE_PATH = join(HOOKS_DIR, "aidlc-statusline.ts");
const LEGACY_STAGES_DIR = join(
  REPO_ROOT,
  "dist", "claude",
  ".claude",
  "skills",
  "aidlc",
  "stages",
);
const COMMON_STAGES_DIR = join(
  REPO_ROOT,
  "dist", "claude",
  ".claude",
  "aidlc-common",
  "stages",
);
const STAGES_DIR = existsSync(COMMON_STAGES_DIR) ? COMMON_STAGES_DIR : LEGACY_STAGES_DIR;
const STAGES_SOURCE_ROOT = existsSync(COMMON_STAGES_DIR)
  ? "dist/claude/.claude/aidlc-common/stages"
  : "dist/claude/.claude/skills/aidlc/stages";
const SCOPE_MAPPING_PATH = join(TOOLS_DIR, "data", "scope-mapping.json");
const SCOPE_GRID_PATH = join(TOOLS_DIR, "data", "scope-grid.json");
const AUDIT_PATH = join(TOOLS_DIR, "aidlc-audit.ts");
const LIB_PATH = join(TOOLS_DIR, "aidlc-lib.ts");
const GRAPH_PATH = join(TOOLS_DIR, "aidlc-graph.ts");

const REGISTRY_PATH =
  process.env.AIDLC_COVERAGE_REGISTRY ?? join(TESTS_DIR, ".coverage-registry.json");
const RATCHET_PATH =
  process.env.AIDLC_COVERAGE_RATCHET ?? join(TESTS_DIR, ".coverage-ratchet.json");
// tests/coverage-exclusions.json is reviewer-facing documentation of legit
// L-CODE exclusions (import.meta.main shims, process.exit terminals, external-
// binary spawn sites). This UNIT-surface generator does not read it — units are
// surfaces, not lines — so it is referenced here only as a pointer for the
// reader: the file lives alongside this tool at tests/coverage-exclusions.json.

// ---------------------------------------------------------------------------
// MECHANISM LADDER. The guarantee principle: a stronger mechanism drives the
// real system further end-to-end, so it can vouch for everything a weaker one
// can plus more. A test claiming a unit must run at a mechanism >= the unit's
// minMechanism; otherwise the claim is UNDER-MECHANISM (treated as uncovered).
//
//   none — pure in-process: import the fn / spawn a deterministic CLI tool
//          against a temp dir. Zero LLM, zero tokens. (t106-t114 are .none.)
//   cli  — exercises a tool's argv dispatch as a spawned subprocess.
//   sdk  — drives the real /aidlc through the Claude Agent SDK (spends tokens;
//          the harness calibration tier).
//   tui  — drives the real terminal UI (tmux). Strongest; observes rendering.
//
// The dot-segment in a test filename (t112.NONE.test.ts) names its mechanism.
// `calibration` is the SDK calibration tier — it drives the SDK, so it maps to
// `sdk`.
// ---------------------------------------------------------------------------
export const MECHANISMS = ["none", "cli", "sdk", "tui"] as const;
export type Mechanism = (typeof MECHANISMS)[number];

export function mechanismRank(m: Mechanism): number {
  return MECHANISMS.indexOf(m);
}

/** Map a filename dot-segment token to a mechanism. Unknown tokens that are not
 *  one of the canonical four are normalised: `calibration` -> `sdk` (the SDK
 *  calibration tier drives the Agent SDK). Anything else is rejected loudly so
 *  a new tier cannot silently weaken the gate. */
export function mechanismFromSegment(seg: string): Mechanism {
  if ((MECHANISMS as readonly string[]).includes(seg)) return seg as Mechanism;
  if (seg === "calibration") return "sdk";
  throw new Error(
    `unknown mechanism segment "${seg}": add it to MECHANISMS or map it in mechanismFromSegment`,
  );
}

// ---------------------------------------------------------------------------
// UNIT CLASSES. Each has a minMechanism — the weakest mechanism that can
// legitimately verify a unit of that class.
//
//   function (exported lib/graph fn)  -> none  (importable, pure-ish)
//   audit    (VALID_EVENT_TYPES member)-> none  (state.ts spawn proves emission)
//   scope    (scope-mapping.json key)  -> none  (data; loadScopeMapping in-proc)
//   stage    (*.md under stages/)      -> none  (data; compile reads off disk)
//   hook     (hook .ts file)           -> none  (spawnable deterministically)
//   subcommand (tool argv dispatch)    -> cli   (the dispatch surface IS argv;
//              proving it routes needs spawning the CLI, not importing a fn)
//   render-surface (a statusline render branch) -> tui  (only a PAINTED screen
//              shows what a render branch draws; a `none`/`cli`/`sdk` test never
//              renders, so the guarantee-principle gate refuses to count it).
// ---------------------------------------------------------------------------
export type UnitClass =
  | "function"
  | "audit"
  | "scope"
  | "stage"
  | "hook"
  | "subcommand"
  | "render-surface";

export const UNIT_CLASSES: readonly UnitClass[] = [
  "function",
  "audit",
  "scope",
  "stage",
  "hook",
  "subcommand",
  "render-surface",
];

export const MIN_MECHANISM: Record<UnitClass, Mechanism> = {
  function: "none",
  audit: "none",
  scope: "none",
  stage: "none",
  hook: "none",
  subcommand: "cli",
  "render-surface": "tui",
};

export interface Unit {
  unitClass: UnitClass;
  unitId: string;
  minMechanism: Mechanism;
  source: string; // disk path the unit was read from (relative to repo root)
}

export type UnitStatus =
  | "covered"
  | "UNCOVERED"
  | "UNDER-MECHANISM"
  | "DEFERRED-tui";

export interface CoverageClaim {
  file: string; // relative to repo root
  // The SCALAR REPRESENTATIVE of the test's derived mechanism set: its strongest
  // member (Math.max over the set's ranks). This is what the registry serialises
  // — a single value per claim, byte-identical to the legacy filename suffix
  // while files still carry one (max(set) == suffix for every current file).
  // The gate evaluates the full set (see buildRegistry); this field is the
  // serialisation projection, not the gate input.
  mechanism: Mechanism;
}

export interface RegistryRow {
  unitClass: UnitClass;
  unitId: string;
  minMechanism: Mechanism;
  coveredBy: CoverageClaim[];
  status: UnitStatus;
}

// ---------------------------------------------------------------------------
// CLI tool descriptors. Each names the dispatch construct the parser must read.
//   kind "object"  -> a `const <anchor>: ... = { key: ..., "k-2": ... }` table
//                     (aidlc-graph COMMANDS, aidlc-runtime SUBCOMMANDS).
//   kind "switch"  -> the entry `switch (<switchVar>) { case "x": }` inside
//                     main(). switchVar disambiguates the entry dispatch from
//                     nested sub-switches (state.ts has practices-event + lookup
//                     sub-switches keyed on different vars; we read only the
//                     entry one keyed on `subcommand`).
//
// Verified against source on 2026-05-31:
//   state.ts:115 switch(subcommand)     audit.ts:639 switch(subcommand)
//   bolt.ts:803 switch(subcommand)      jump.ts:57 switch(subcommand)
//   log.ts:133 switch(subcommand)       worktree.ts:777 switch(subcommand)
//   validate.ts:295 switch(subcommand)  learnings.ts:750 switch(cmd)
//   sensor.ts:659 switch(cmd)           utility.ts:2814 switch(subcommand)
//   graph.ts:1088 const COMMANDS = {}   runtime.ts:1024 const SUBCOMMANDS = {}
// ---------------------------------------------------------------------------
interface ToolDescriptor {
  file: string; // basename under TOOLS_DIR
  kind: "object" | "switch";
  anchor: string; // object const name, or the switch variable
}

export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  { file: "aidlc-state.ts", kind: "switch", anchor: "subcommand" },
  { file: "aidlc-audit.ts", kind: "switch", anchor: "subcommand" },
  { file: "aidlc-bolt.ts", kind: "switch", anchor: "subcommand" },
  { file: "aidlc-jump.ts", kind: "switch", anchor: "subcommand" },
  { file: "aidlc-log.ts", kind: "switch", anchor: "subcommand" },
  { file: "aidlc-worktree.ts", kind: "switch", anchor: "subcommand" },
  { file: "aidlc-validate.ts", kind: "switch", anchor: "subcommand" },
  { file: "aidlc-learnings.ts", kind: "switch", anchor: "cmd" },
  { file: "aidlc-sensor.ts", kind: "switch", anchor: "cmd" },
  { file: "aidlc-utility.ts", kind: "switch", anchor: "subcommand" },
  { file: "aidlc-graph.ts", kind: "object", anchor: "COMMANDS" },
  { file: "aidlc-runtime.ts", kind: "object", anchor: "SUBCOMMANDS" },
];

// ===========================================================================
// ENUMERATORS — the left side of the join. Each reads source FRESH off disk.
// ===========================================================================

/** Brace-balanced slice of `src` starting at the first index after `openIdx`'s
 *  `{` through its matching `}`. openIdx must point at (or before) the `{`. */
function balancedBlock(src: string, openIdx: number): string {
  const start = src.indexOf("{", openIdx);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return "";
}

/** Direct (depth-1) object keys of a `const <anchor> ... = { ... }` table.
 *  Reads only top-level keys, not keys nested in handler bodies. */
export function parseObjectDispatchKeys(src: string, anchor: string): string[] {
  // Anchor the const declaration; tolerate a type annotation before `=`.
  const declRe = new RegExp(`\\bconst\\s+${anchor}\\b[^=]*=\\s*\\{`);
  const m = declRe.exec(src);
  if (!m) return [];
  const block = balancedBlock(src, m.index);
  return depthOneKeys(block);
}

/** Keys at brace-depth 0 of an object-literal body (the body is already the
 *  inside of the outer braces). A key is `ident:` or `"quoted-key":` that sits
 *  at depth 0. */
function depthOneKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  const lines = body.split("\n");
  for (const line of lines) {
    if (depth === 0) {
      const km = /^\s*(?:"([a-z][a-z0-9-]*)"|([a-z][a-z0-9-]*))\s*:/.exec(line);
      if (km) keys.push(km[1] ?? km[2]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
  }
  return keys;
}

/** `case "x":` labels at the top level of the entry switch keyed on
 *  `switchVar`. Reads only the direct cases of that switch — nested switches
 *  (keyed on other vars) contribute their cases at deeper brace depth and are
 *  excluded by the depth-0 filter. */
export function parseSwitchDispatchCases(
  src: string,
  switchVar: string,
): string[] {
  const swRe = new RegExp(`\\bswitch\\s*\\(\\s*${switchVar}\\s*\\)\\s*\\{`);
  const m = swRe.exec(src);
  if (!m) return [];
  const block = balancedBlock(src, m.index);
  const cases: string[] = [];
  let depth = 0;
  for (const line of block.split("\n")) {
    if (depth === 0) {
      const cm = /^\s*case\s+"([a-z][a-z0-9-]*)"\s*:/.exec(line);
      if (cm) cases.push(cm[1]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
  }
  return cases;
}

/** Public: the subcommands of one tool, by its descriptor. */
export function subcommandsForTool(d: ToolDescriptor): string[] {
  const src = readFileSync(join(TOOLS_DIR, d.file), "utf-8");
  const keys =
    d.kind === "object"
      ? parseObjectDispatchKeys(src, d.anchor)
      : parseSwitchDispatchCases(src, d.anchor);
  return keys;
}

/** ANTI-ROT GUARD (b), independent counter. Re-counts the dispatch sites in the
 *  SAME anchored block via a DIFFERENT regex pass than subcommandsForTool's
 *  line-by-line parser: a single global regex over the balanced block text.
 *  If a parser bug silently drops a tool's cases, the two counts diverge. */
export function independentSubcommandCount(d: ToolDescriptor): number {
  const src = readFileSync(join(TOOLS_DIR, d.file), "utf-8");
  if (d.kind === "object") {
    const declRe = new RegExp(`\\bconst\\s+${d.anchor}\\b[^=]*=\\s*\\{`);
    const m = declRe.exec(src);
    if (!m) return 0;
    const block = balancedBlock(src, m.index);
    return countDepthOneKeys(block);
  }
  const swRe = new RegExp(`\\bswitch\\s*\\(\\s*${d.anchor}\\s*\\)\\s*\\{`);
  const m = swRe.exec(src);
  if (!m) return 0;
  const block = balancedBlock(src, m.index);
  return countDepthZeroCases(block);
}

/** Count depth-0 `case "x":` sites by scanning char-by-char and matching the
 *  literal at depth 0 — structurally independent of parseSwitchDispatchCases'
 *  line-oriented loop. */
function countDepthZeroCases(block: string): number {
  let depth = 0;
  let n = 0;
  const re = /case\s+"[a-z][a-z0-9-]*"\s*:/g;
  // Walk lines so we can track depth, but match with a global regex per line.
  for (const line of block.split("\n")) {
    if (depth === 0) {
      const matches = line.match(re);
      if (matches) n += matches.length;
    }
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
  }
  return n;
}

function countDepthOneKeys(body: string): number {
  return depthOneKeys(body).length;
}

export function enumerateSubcommands(): Unit[] {
  const units: Unit[] = [];
  for (const d of TOOL_DESCRIPTORS) {
    const toolName = basename(d.file, ".ts"); // aidlc-state
    for (const sub of subcommandsForTool(d)) {
      units.push({
        unitClass: "subcommand",
        unitId: `${toolName} ${sub}`,
        minMechanism: MIN_MECHANISM.subcommand,
        source: `dist/claude/.claude/tools/${d.file}`,
      });
    }
  }
  return units;
}

/** VALID_EVENT_TYPES Set members in aidlc-audit.ts (~:19). Read the Set body
 *  fresh; pull every quoted UPPER_SNAKE literal. */
export function enumerateAuditEvents(): Unit[] {
  const src = readFileSync(AUDIT_PATH, "utf-8");
  const m = /const\s+VALID_EVENT_TYPES\s*=\s*new\s+Set\s*\(\s*\[/.exec(src);
  if (!m) return [];
  // Slice from the `[` to its matching `]`.
  const open = src.indexOf("[", m.index);
  let depth = 0;
  let body = "";
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        body = src.slice(open + 1, i);
        break;
      }
    }
  }
  const ids = [...body.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1]);
  return ids.map((id) => ({
    unitClass: "audit" as const,
    unitId: id,
    minMechanism: MIN_MECHANISM.audit,
    source: "dist/claude/.claude/tools/aidlc-audit.ts",
  }));
}

/** Scope keys from the v0.6 scope grid, with legacy scope-mapping fallback. */
export function enumerateScopes(): Unit[] {
  const sourcePath = existsSync(SCOPE_GRID_PATH) ? SCOPE_GRID_PATH : SCOPE_MAPPING_PATH;
  const raw = JSON.parse(readFileSync(sourcePath, "utf-8"));
  const sourceRel = existsSync(SCOPE_GRID_PATH)
    ? "dist/claude/.claude/tools/data/scope-grid.json"
    : "dist/claude/.claude/tools/data/scope-mapping.json";
  return Object.keys(raw).map((k) => ({
    unitClass: "scope" as const,
    unitId: k,
    minMechanism: MIN_MECHANISM.scope,
    source: sourceRel,
  }));
}

/** Stage units: every *.md under stages/<phase>/. unitId is <phase>/<slug>. */
export function enumerateStages(): Unit[] {
  const units: Unit[] = [];
  for (const phase of readdirSync(STAGES_DIR, { withFileTypes: true })) {
    if (!phase.isDirectory()) continue;
    const phaseDir = join(STAGES_DIR, phase.name);
    for (const f of readdirSync(phaseDir)) {
      if (!f.endsWith(".md")) continue;
      const slug = basename(f, ".md");
      units.push({
        unitClass: "stage",
        unitId: `${phase.name}/${slug}`,
        minMechanism: MIN_MECHANISM.stage,
        source: `${STAGES_SOURCE_ROOT}/${phase.name}/${f}`,
      });
    }
  }
  return units;
}

/** Hook units: every aidlc-*.ts under hooks/. */
export function enumerateHooks(): Unit[] {
  return readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({
      unitClass: "hook" as const,
      unitId: basename(f, ".ts"),
      minMechanism: MIN_MECHANISM.hook,
      source: `dist/claude/.claude/hooks/${f}`,
    }));
}

/** RENDER-SURFACE units: the distinct render branches of the statusline hook
 *  (dist/claude/.claude/hooks/aidlc-statusline.ts). Each branch can break
 *  independently and only a PAINTED terminal shows it, so each is its own unit
 *  at minMechanism `tui` (D-TUI-5: 6 units, not one coarse "statusline-render").
 *
 *  Enumerated FROM DISK like every other class (the §7 freshness-read): each
 *  unit names the anchor token in the statusline source that draws it. A renamed
 *  or deleted branch drops its anchor -> the unit vanishes from the enumerated
 *  universe -> the committed registry drifts -> `--check` fails. The enumerator
 *  asserts every anchor is present so a silently-removed branch cannot pass as
 *  "still covered". */
const RENDER_SURFACE_ANCHORS: ReadonlyArray<{ id: string; anchor: string }> = [
  // The 10-cell progress bar (▓/░), drawn by progressBar().
  { id: "statusline-phase-bar", anchor: "function progressBar(" },
  // The "done/total" completion counter appended after the bar.
  { id: "statusline-counter", anchor: "const phaseProg =" },
  // The "> Stage Name" segment, mapped through the STAGE_DISPLAY table.
  { id: "statusline-stage-name", anchor: "const STAGE_DISPLAY" },
  // The context-window colour (red/yellow/green), chosen by contextColor().
  { id: "statusline-colour", anchor: "function contextColor(" },
  // The right-aligned model/ctx side, padded to terminal width by printLine().
  { id: "statusline-align", anchor: "function printLine(" },
  // The COMPLETE sentinel branch (full bar at workflow completion).
  { id: "statusline-complete", anchor: "[AIDLC] COMPLETE" },
];

export function enumerateRenderSurfaces(): Unit[] {
  const src = readFileSync(STATUSLINE_PATH, "utf-8");
  const units: Unit[] = [];
  for (const { id, anchor } of RENDER_SURFACE_ANCHORS) {
    if (!src.includes(anchor)) {
      // A render branch lost its anchor: fail loud rather than silently shrink
      // the universe (which would let a regressed branch pass as covered).
      throw new Error(
        `render-surface enumerator: anchor "${anchor}" for unit "${id}" not ` +
          `found in aidlc-statusline.ts — the render branch was renamed or ` +
          `removed. Update RENDER_SURFACE_ANCHORS in gen-coverage-registry.ts.`,
      );
    }
    units.push({
      unitClass: "render-surface",
      unitId: id,
      minMechanism: MIN_MECHANISM["render-surface"],
      source: "dist/claude/.claude/hooks/aidlc-statusline.ts",
    });
  }
  return units;
}

/** Exported lib functions from aidlc-lib.ts + aidlc-graph.ts. Matches a
 *  top-level `export function|const|class|async function NAME`. unitId is
 *  `function:NAME` so it joins to the `function:NAME` covers-IDs t106-t111 use. */
export function enumerateExportedFunctions(): Unit[] {
  const units: Unit[] = [];
  const re =
    /^export\s+(?:async\s+function|function|const|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const [path, rel] of [
    [LIB_PATH, "dist/claude/.claude/tools/aidlc-lib.ts"],
    [GRAPH_PATH, "dist/claude/.claude/tools/aidlc-graph.ts"],
  ] as const) {
    const src = readFileSync(path, "utf-8");
    for (const m of src.matchAll(re)) {
      units.push({
        unitClass: "function",
        unitId: `function:${m[1]}`,
        minMechanism: MIN_MECHANISM.function,
        source: rel,
      });
    }
  }
  return units;
}

/** All units, every class. The full enumerated universe (left side). */
export function enumerateAllUnits(): Unit[] {
  return [
    ...enumerateExportedFunctions(),
    ...enumerateAuditEvents(),
    ...enumerateScopes(),
    ...enumerateStages(),
    ...enumerateHooks(),
    ...enumerateSubcommands(),
    ...enumerateRenderSurfaces(),
  ];
}

// ===========================================================================
// CLAIM DISCOVERY — the right side of the join. Scan test files for a
// machine-readable covers: header.
// ===========================================================================

const TEST_TIERS = [
  "unit",
  "feature",
  "integration",
  "workflow",
  "stage",
  "worktree",
  "harness",
  "smoke",
  "tui",
];

export interface DiscoveredClaim {
  file: string; // relative to repo root
  // The DERIVED mechanism SET — every driver the test body actually calls (§2
  // of the refactor doc). A test that calls driveAidlc() AND spawns
  // tui-drive.ts derives {sdk, tui}; one that calls no driver is the
  // deterministic floor, seeded from its filename segment. This field is the
  // single source of truth for the gate (which takes max(...ranks)); it is NOT
  // serialised — the per-claim mechanism written into the registry is the
  // scalar representative (the set's strongest member, == the legacy suffix
  // while filenames still carry one). Modelling it as a set is what lets one
  // test legitimately cover both a `tui` render-surface unit and an `sdk`
  // audit unit.
  mechanisms: Mechanism[];
  unitIds: string[];
}

/** The mechanism of a test file is the dot-segment between its stem and the
 *  trailing `.test.ts` / `.sh`. e.g. t112.none.test.ts -> none;
 *  sdk-drive.calibration.test.ts -> calibration -> sdk. A file with no
 *  recognised dot-segment (e.g. plain t01.sh) defaults to its strongest claim
 *  being unknowable — we treat the missing segment as `none` (the weakest), so
 *  it can never over-claim a stronger unit.
 *
 *  This is now the NON-BREAKING FALLBACK SEED for mechanismsOf() — used when the
 *  body scan finds no driver call (the deterministic `none` floor, or a legacy
 *  suffixed file whose driver is implied by the segment). Kept exported so the
 *  unit test's filename-segment assertions stay green through Phase 0. */
export function mechanismOfTestFile(fileName: string): Mechanism {
  const stripped = fileName
    .replace(/\.test\.ts$/, "")
    .replace(/\.sh$/, "");
  const parts = stripped.split(".");
  if (parts.length >= 2) {
    // The trailing dot-segment is only a mechanism when it IS one (the legacy
    // `.cli`/`.none`/`.sdk`/`.tui` suffix, or `.calibration`). Any OTHER trailing
    // segment is a DESCRIPTIVE slug, not a mechanism — e.g. once milestone 6 drops the
    // suffixes, a suffix-free `t200.scope-exclusion.test.ts` must seed `none`,
    // not crash the generator. So recognise a real mechanism segment, else fall
    // through to `none` (the weakest seed — it can never over-claim). The strict
    // throwing form (mechanismFromSegment) stays for callers that demand a known
    // segment; here the fallback must be total.
    const seg = parts[parts.length - 1];
    if ((MECHANISMS as readonly string[]).includes(seg)) return seg as Mechanism;
    if (seg === "calibration") return "sdk";
    return "none";
  }
  return "none";
}

/** Derive the mechanism SET from the DRIVERS a test actually calls (§2 of the
 *  refactor doc) — the zero-authoring equivalent of multi-tagging. The drivers
 *  the test invokes ARE the tags; you never declare a mechanism, so a test
 *  cannot claim one it does not drive.
 *
 *  Scan the test's EXECUTABLE CODE (see codeView — comments and `import` lines
 *  are stripped first) and collect every match (not the first):
 *    - `driveAidlc(` ............ adds `sdk` (the Agent-SDK driver)
 *    - spawns `tui-drive.ts` .... adds `tui` (the painted-terminal driver)
 *    - shipped-surface spawn .... adds `cli` (the literal shipped binary): `claude -p`,
 *                                 a runtime (`BUN`/`process.execPath`/`"bun"`/`"node"`)
 *                                 spawn whose argv targets an `aidlc-*.ts` tool, or a
 *                                 `bash`/`execFileSync("bash")` spawn of `run-tests.sh`
 *  Scanning the code view (not the raw source) is what makes "match the CALL /
 *  SPAWN expression, never a bare mention" true: the t118 lesson (it references
 *  `run_claude` only in a comment that says it NEVER calls it) AND D-TUI-7 (only
 *  `resolveWinNode` is import-safe — importing it must NOT register `tui`) are
 *  both handled, because a driver named only in a comment or an `import` line is
 *  removed before the patterns run. A genuine spawn (`const DRIVER = join(...,
 *  "tui-drive.ts")`) or call survives the strip and registers.
 *
 *  When the body scan is INCONCLUSIVE (no driver call — the deterministic floor,
 *  or a file whose driver is still only implied by its legacy `.sdk.`/`.tui.`/
 *  `.cli.`/`.none.` suffix), fall back to the filename segment via
 *  mechanismOfTestFile(). This is the doc's NON-BREAKING transition (§7 Phase 0):
 *  every existing suffixed file keeps classifying exactly as before, and new
 *  suffix-free `t<NN>.test.ts` files class by what they drive.
 *
 *  Returns the SET (deduped, ladder-ordered). The empty set never happens — the
 *  fallback always yields at least one member. */
export function mechanismsOf(fileName: string, src: string): Mechanism[] {
  // Scan only executable code — a driver named in a comment (the t118 /
  // calibration lesson) or imported for a helper (D-TUI-7: resolveWinNode is
  // import-safe) is NOT a driver the test calls.
  const code = codeView(src);
  const found = new Set<Mechanism>();
  // sdk — a call expression: `driveAidlc(` (whitespace tolerated before the paren).
  if (/\bdriveAidlc\s*\(/.test(code)) found.add("sdk");
  // tui — spawning the painted-terminal driver by its filename (in code, not an import).
  if (/tui-drive\.ts/.test(code)) found.add("tui");
  // cli — driving a shipped binary as a subprocess (claude -p, an aidlc-*.ts tool
  // under the bun/node runtime, or run-tests.sh under bash). See drivesCliSurface.
  if (drivesCliSurface(code)) found.add("cli");

  if (found.size === 0) {
    // Inconclusive body scan → seed from the filename segment (non-breaking).
    return [mechanismOfTestFile(fileName)];
  }
  // Ladder-order the derived set so serialisation / inspection is deterministic.
  return MECHANISMS.filter((m) => found.has(m));
}

/** Does this code-view DRIVE the shipped CLI surface as a subprocess? Three ways,
 *  each a genuine spawn of a literal shipped binary — never a bare mention:
 *
 *    1. `claude -p` / `claude --print` — the one live-model preflight surface.
 *       (A `claude --version` AVAILABILITY GUARD is NOT a drive — it is excluded,
 *        which is why 16 tui tests that guard on `spawnSync("claude",["--version"])`
 *        stay {tui} and never spuriously gain {cli}.)
 *    2. A RUNTIME spawn — `spawnSync`/`spawn`/`execSync`/`execFileSync`/`Bun.spawn*`
 *       whose runtime is `BUN` / `process.execPath` / a literal `"bun"` or `"node"` —
 *       whose argv targets an `aidlc-*.ts` tool. The tool is matched whether it is an
 *       inline string literal (`spawnSync(BUN,["…/aidlc-state.ts"])`) OR a const bound
 *       to one (`const GRAPH_TS = join(TOOLS_DIR,"aidlc-graph.ts"); spawnSync(BUN,[GRAPH_TS,…])`),
 *       since the const definition survives in the code view (imports/comments are stripped,
 *       but a `const X = "…aidlc-*.ts"` is real code).
 *    3. A `bash` spawn (`spawnSync("bash",…)` / `execFileSync("bash",…)`) of `run-tests.sh`.
 *
 *  WHY gate on a real spawn and not a bare `aidlc-*.ts` mention: 12 deterministic floor
 *  tests reference a tool ONLY through a multi-line `import { … } from "…/aidlc-lib.ts"`
 *  whose path lands on a CONTINUATION line the import-strip misses — they call the lib
 *  IN-PROCESS and must stay {none}. Requiring (spawn primitive ∧ runtime ∧ shipped target)
 *  keeps every such import-only test out of cli. */
function drivesCliSurface(code: string): boolean {
  // 1. claude in print mode (NOT --version).
  if (/claude\s+-p\b|claude\s+--print\b/.test(code)) return true;

  // The shipped targets: an aidlc-*.ts tool, or the run-tests.sh runner — as a
  // string literal anywhere in the code view (inline arg OR a `const X = "…"` def).
  const hasAidlcToolLiteral = /["'][^"']*\baidlc-[A-Za-z0-9_-]+\.ts["']/.test(code);
  const hasRunnerLiteral = /["'][^"']*\brun-tests\.sh["']/.test(code);
  if (!hasAidlcToolLiteral && !hasRunnerLiteral) return false;

  // 2 + 3. A subprocess primitive must actually appear AND its launcher must be a
  // runtime / bash — never tmux, git, grep, or the tui driver binary (those are not
  // the shipped CLI surface). We require a runtime/bash token to co-occur with a
  // spawn primitive; combined with the shipped-target literal above, that is the
  // "spawned a shipped binary" signal.
  const SPAWN_PRIMITIVE =
    /\b(?:spawnSync|spawn|execSync|execFileSync|Bun\.spawnSync|Bun\.spawn)\s*[({]/;
  if (!SPAWN_PRIMITIVE.test(code)) return false;

  // runtime launcher (bun/node) — covers `spawnSync(BUN,…)`, `spawnSync(process.execPath,…)`,
  // `Bun.spawnSync({cmd:["bun",…]})` (t18's object form), and literal `"bun"`/`"node"`.
  const RUNTIME_LAUNCHER =
    /\bBUN\b|\bprocess\.execPath\b|["'](?:bun|node)["']/;
  if (RUNTIME_LAUNCHER.test(code) && hasAidlcToolLiteral) return true;

  // bash launcher driving the runner.
  const BASH_LAUNCHER = /["']bash["']/;
  if (BASH_LAUNCHER.test(code) && hasRunnerLiteral) return true;

  return false;
}

/** A code-only view of a test's source: per line, ES `import` statements, shell
 *  comments / shebangs (a leading `#`), and `//` line comments stripped FIRST,
 *  then block comments removed. mechanismsOf scans this rather than the raw
 *  source so a driver named only in prose or pulled in by an import cannot
 *  register a mechanism the test does not actually drive. Deterministic; no
 *  execution.
 *
 *  ORDER MATTERS: line comments are stripped BEFORE the block-comment pass. A
 *  prior version ran the block-comment regex `/\/\*[\s\S]*?\*\//` on RAW source
 *  first, so a `//` line comment whose text merely CONTAINED the substring `/*`
 *  (e.g. a `tests/fixtures/**` glob, t38.cli:64) was treated as a block-comment
 *  OPENER and paired with a downstream block-close, silently SWALLOWING the real
 *  code in between — including the `const TOOL = join(..., "aidlc-*.ts")` spawn
 *  site the mechanism scan needs. Stripping `//` lines first removes that trigger
 *  so the block pass only ever sees genuine block comments. */
function codeView(src: string): string {
  // First drop whole `import` statements and shell shebang/comment lines — a
  // driver named only in an import path or a `#` line is not a driver the test
  // calls. (Whole-line removal; safe because these never share a line with a
  // spawn/call expression.)
  const lineStripped = src
    .split("\n")
    .map((line) => {
      if (/^\s*import\b/.test(line)) return ""; // ES import — not a driver call
      if (/^\s*#/.test(line)) return ""; // shell comment / shebang
      return line;
    })
    .join("\n");
  // Then strip `//` line comments and `/* … */` block comments with a single
  // pass that RESPECTS string literals, so a `//` inside a URL ("https://…") or
  // a `/*` inside a string ("a glob /* …") never truncates or swallows real
  // code. This subsumes the earlier line-strip-before-block ordering (a `//`
  // comment that merely CONTAINS `/*` is consumed as a line comment, so it can
  // no longer open a phantom block) AND closes the string-literal hole that the
  // indexOf/regex form had. Regex literals are not lexed (a `/`-delimited regex
  // containing `//` or `/*` is vanishingly rare in a test body and never carries
  // a driver token), so they are left as a known, documented non-goal.
  return stripCommentsRespectingStrings(lineStripped);
}

/** Remove line comments and block comments from TS/JS source while leaving the
 *  contents of string literals (single-quote, double-quote, backtick) intact, so
 *  a comment-opener appearing INSIDE a string (a URL's "//", or a "/*" in a glob)
 *  never truncates or swallows real code. A small single-pass state machine — not
 *  a full tokeniser (it does not lex regex literals) — sufficient for the
 *  mechanism scan, whose tokens (driveAidlc(, tui-drive.ts, spawnSync, BUN,
 *  claude -p) never live inside a string or a regex. Newlines are preserved so
 *  downstream line-based patterns still work. */
function stripCommentsRespectingStrings(src: string): string {
  let out = "";
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";
    // String literal — copy verbatim through the matching quote, honouring `\` escapes.
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i++;
      while (i < n) {
        const c = src[i];
        if (c === "\\") {
          // Escape: copy the backslash and the next char verbatim.
          out += c;
          if (i + 1 < n) out += src[i + 1];
          i += 2;
          continue;
        }
        out += c;
        i++;
        if (c === ch) break; // closing quote of the same kind
      }
      continue;
    }
    // `//` line comment — drop to end of line (the newline itself is preserved
    // by the next iteration, so line structure is kept).
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // `/* … */` block comment — drop through the closing `*/`.
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Parse a `covers:` header out of a test file's leading comment block.
 *  Supports `// covers:` (ts) and `# covers:` (sh). Continuation lines that
 *  start with the comment leader + whitespace + more IDs are folded in (t114's
 *  multi-line sub-id list). IDs are comma- and/or whitespace-separated tokens
 *  of the form `<class>:<id...>`. Returns [] if no header. */
export function parseCoversHeader(src: string, isShell: boolean): string[] {
  const leader = isShell ? "#" : "//";
  const lines = src.split("\n");
  const ids: string[] = [];
  let inHeader = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(leader)) {
      // A non-comment line ends the leading comment block.
      if (inHeader) break;
      if (trimmed === "") continue; // tolerate a blank shebang gap
      break;
    }
    const body = trimmed.slice(leader.length);
    const coversIdx = body.indexOf("covers:");
    if (coversIdx !== -1) {
      inHeader = true;
      collectIds(body.slice(coversIdx + "covers:".length), ids);
      continue;
    }
    if (inHeader) {
      // Continuation: only fold lines that actually carry `<class>:<id>` tokens
      // (so prose continuation paragraphs don't pollute the claim set). A
      // continuation line must contain at least one valid unit-id token.
      const before = ids.length;
      collectIds(body, ids);
      if (ids.length === before) {
        // No new IDs on this comment line — header's structured part is over.
        // Keep scanning subsequent lines in case of an interleaved blank
        // comment line, but a prose line that mentions no `class:id` is fine
        // to skip; we stop only at the first non-comment line (handled above).
      }
    }
  }
  return dedupe(ids);
}

const UNIT_ID_RE = /\b([a-z][a-z0-9-]*):([A-Za-z0-9_][\w./:-]*)/g;

function collectIds(text: string, out: string[]): void {
  // Strip trailing parenthetical annotations like "(handleApprove :675)" first
  // so a `:675` doesn't masquerade as an id segment.
  for (const m of text.matchAll(UNIT_ID_RE)) {
    out.push(`${m[1]}:${m[2]}`);
  }
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Walk the test tiers, returning every file that carries a covers: header. */
export function discoverClaims(): DiscoveredClaim[] {
  const claims: DiscoveredClaim[] = [];
  for (const tier of TEST_TIERS) {
    const dir = join(CLAIMS_TESTS_DIR, tier);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const isTs = f.endsWith(".test.ts");
      const isSh = f.endsWith(".sh");
      if (!isTs && !isSh) continue;
      const src = readFileSync(join(dir, f), "utf-8");
      const ids = parseCoversHeader(src, isSh);
      if (ids.length === 0) continue;
      claims.push({
        file: `tests/${tier}/${f}`,
        // DERIVED SET from the drivers the body calls (§2), seeded from the
        // filename segment when the body scan is inconclusive (non-breaking).
        mechanisms: mechanismsOf(f, src),
        unitIds: ids,
      });
    }
  }
  return claims;
}

// ===========================================================================
// JOIN — units x claims, through the guarantee-principle gate.
// ===========================================================================

/** unitId form a covers-claim uses, per class:
 *    function -> `function:NAME`  (matches enumerator unitId exactly)
 *    audit    -> `audit:EVENT`
 *    scope    -> `scope:key`
 *    stage    -> `stage:<phase>/<slug>` OR `stage:<slug>`
 *    hook     -> `hook:aidlc-x`
 *    subcommand -> `subcommand:<tool> <sub>` OR `subcommand:<tool>:<sub>`
 *    render-surface -> `render-surface:<id>`
 *  We index units by every claim-form they could legitimately be referenced by.
 */
function claimKeysForUnit(u: Unit): string[] {
  switch (u.unitClass) {
    case "function":
      // unitId already is `function:NAME`.
      return [u.unitId];
    case "audit":
      return [`audit:${u.unitId}`];
    case "scope":
      return [`scope:${u.unitId}`];
    case "stage": {
      const slug = u.unitId.split("/")[1] ?? u.unitId;
      return [`stage:${u.unitId}`, `stage:${slug}`];
    }
    case "hook":
      return [`hook:${u.unitId}`];
    case "subcommand": {
      const [tool, sub] = u.unitId.split(" ");
      return [`subcommand:${u.unitId}`, `subcommand:${tool}:${sub}`];
    }
    case "render-surface":
      return [`render-surface:${u.unitId}`];
  }
}

export interface BuildResult {
  rows: RegistryRow[];
  claims: DiscoveredClaim[];
}

export function buildRegistry(): BuildResult {
  const units = enumerateAllUnits();
  const claims = discoverClaims();

  // Index: claim-key -> list of indexed claims that named it. Each carries BOTH
  // the full derived mechanism SET (for the gate's Math.max) AND the scalar
  // representative (max of the set) that the registry serialises.
  interface IndexedClaim {
    file: string;
    mechanisms: Mechanism[]; // the derived set — gate input
    mechanism: Mechanism; // scalar representative (strongest) — serialised
  }
  const claimIndex = new Map<string, IndexedClaim[]>();
  for (const c of claims) {
    // Strongest member of the derived set, by ladder rank. The set is never
    // empty (mechanismsOf always seeds at least one member).
    const representative = c.mechanisms.reduce((best, m) =>
      mechanismRank(m) >= mechanismRank(best) ? m : best,
    );
    for (const id of c.unitIds) {
      const arr = claimIndex.get(id) ?? [];
      arr.push({
        file: c.file,
        mechanisms: c.mechanisms,
        mechanism: representative,
      });
      claimIndex.set(id, arr);
    }
  }

  const rows: RegistryRow[] = units.map((u) => {
    const keys = claimKeysForUnit(u);
    const matched: IndexedClaim[] = [];
    for (const k of keys) {
      for (const cl of claimIndex.get(k) ?? []) matched.push(cl);
    }
    // De-dup by file (a unit referenced via two key-forms in one file counts
    // once).
    const byFile = new Map<string, IndexedClaim>();
    for (const m of matched) byFile.set(m.file, m);
    const indexed = [...byFile.values()];
    // The serialised claim list carries the scalar representative per file.
    const coveredBy: CoverageClaim[] = indexed.map((c) => ({
      file: c.file,
      mechanism: c.mechanism,
    }));

    // GUARANTEE-PRINCIPLE GATE. A claim counts when SOME mechanism in its
    // derived set ranks >= the unit's minMechanism — i.e. Math.max over the
    // set's ranks clears the bar (§7 Phase 0). A {sdk, tui} test therefore
    // covers a `tui` render-surface unit (max == tui) AND an `sdk`/`none` unit,
    // which a single-label model could never express. Claims whose whole set is
    // too weak are recorded in coveredBy (for transparency) but reported
    // UNDER-MECHANISM rather than covered.
    const minRank = mechanismRank(u.minMechanism);
    const adequate = indexed.filter(
      (c) => Math.max(...c.mechanisms.map(mechanismRank)) >= minRank,
    );

    let status: UnitStatus;
    if (adequate.length > 0) {
      status = "covered";
    } else if (coveredBy.length > 0) {
      // There ARE claims, but every one is too weak for this unit's bar.
      status = "UNDER-MECHANISM";
    } else if (u.minMechanism === "tui") {
      status = "DEFERRED-tui";
    } else {
      status = "UNCOVERED";
    }

    return {
      unitClass: u.unitClass,
      unitId: u.unitId,
      minMechanism: u.minMechanism,
      coveredBy: coveredBy.sort((a, b) => a.file.localeCompare(b.file)),
      status,
    };
  });

  rows.sort(
    (a, b) =>
      a.unitClass.localeCompare(b.unitClass) ||
      a.unitId.localeCompare(b.unitId),
  );

  return { rows, claims };
}

// ===========================================================================
// SERIALISATION — deterministic JSON so the freshness diff is byte-stable.
// ===========================================================================

export function registryJson(rows: RegistryRow[]): string {
  const byClass: Record<string, number> = {};
  const coveredByClass: Record<string, number> = {};
  for (const c of UNIT_CLASSES) {
    byClass[c] = 0;
    coveredByClass[c] = 0;
  }
  for (const r of rows) {
    byClass[r.unitClass]++;
    if (r.status === "covered") coveredByClass[r.unitClass]++;
  }
  const doc = {
    generator: "tests/gen-coverage-registry.ts",
    generatedFrom: "disk (units re-enumerated fresh)",
    unitClasses: UNIT_CLASSES,
    minMechanism: MIN_MECHANISM,
    counts: {
      total: rows.length,
      enumeratedByClass: byClass,
      coveredByClass,
    },
    units: rows,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export interface RatchetDoc {
  note: string;
  coveredByClass: Record<UnitClass, number>;
}

export function ratchetFromRows(rows: RegistryRow[]): RatchetDoc {
  const coveredByClass = Object.fromEntries(
    UNIT_CLASSES.map((c) => [c, 0]),
  ) as Record<UnitClass, number>;
  for (const r of rows) {
    if (r.status === "covered") coveredByClass[r.unitClass]++;
  }
  return {
    note:
      "Committed baseline: covered-unit count per class. The --check ratchet " +
      "fails CI if any class's covered count DROPS below these numbers without " +
      "a reviewed deferred entry. Monotonic anti-regression: you can cover " +
      "more, never silently less. Regenerate with: bun tests/gen-coverage-registry.ts",
    coveredByClass,
  };
}

export function ratchetJson(doc: RatchetDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ===========================================================================
// ANTI-ROT GUARDS.
// ===========================================================================

/** Guard (a): each unit class must enumerate > 0 units. Returns the list of
 *  empty classes (empty array == healthy). */
export function emptyClasses(rows: RegistryRow[]): UnitClass[] {
  const counts = Object.fromEntries(UNIT_CLASSES.map((c) => [c, 0])) as Record<
    UnitClass,
    number
  >;
  for (const r of rows) counts[r.unitClass]++;
  return UNIT_CLASSES.filter((c) => counts[c] === 0);
}

/** Guard (b): per-tool, the structured parser's count must equal the
 *  independent regex count of dispatch sites. Returns mismatches (empty ==
 *  healthy). */
export function subcommandCrossCheck(): Array<{
  tool: string;
  parsed: number;
  independent: number;
}> {
  const mismatches: Array<{
    tool: string;
    parsed: number;
    independent: number;
  }> = [];
  for (const d of TOOL_DESCRIPTORS) {
    const parsed = subcommandsForTool(d).length;
    const independent = independentSubcommandCount(d);
    if (parsed !== independent) {
      mismatches.push({ tool: d.file, parsed, independent });
    }
  }
  return mismatches;
}

// ===========================================================================
// --check : the freshness-diff + ratchet CI guard.
// ===========================================================================

function lineDiff(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");
  const max = Math.max(e.length, a.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    if (e[i] !== a[i]) {
      if (e[i] !== undefined) out.push(`- ${e[i]}`);
      if (a[i] !== undefined) out.push(`+ ${a[i]}`);
    }
  }
  return out.slice(0, 80).join("\n");
}

export interface CheckResult {
  ok: boolean;
  messages: string[];
}

export function runCheck(): CheckResult {
  const messages: string[] = [];
  let ok = true;

  const { rows } = buildRegistry();

  // GUARD (a): non-empty per class.
  const empties = emptyClasses(rows);
  if (empties.length > 0) {
    ok = false;
    messages.push(
      `ANTI-ROT GUARD (a) FAILED: unit class(es) enumerated ZERO units: ` +
        `${empties.join(", ")}. A broken enumerator would report "100% ` +
        `covered, 0 units". Fix the enumerator.`,
    );
  }

  // GUARD (b): subcommand parser vs independent count.
  const mismatches = subcommandCrossCheck();
  if (mismatches.length > 0) {
    ok = false;
    for (const m of mismatches) {
      messages.push(
        `ANTI-ROT GUARD (b) FAILED: ${m.tool} subcommand parser counted ` +
          `${m.parsed} but the independent dispatch-site count is ` +
          `${m.independent}. The structured parser may have silently stopped ` +
          `seeing this tool's cases.`,
      );
    }
  }

  // FRESHNESS DIFF: committed registry must match the freshly generated one.
  const actual = registryJson(rows);
  if (!existsSync(REGISTRY_PATH)) {
    ok = false;
    messages.push(
      `FRESHNESS DIFF FAILED: ${REGISTRY_PATH} does not exist. ` +
        `Generate it with: bun tests/gen-coverage-registry.ts`,
    );
  } else {
    const committed = readFileSync(REGISTRY_PATH, "utf-8");
    if (committed !== actual) {
      ok = false;
      messages.push(
        `FRESHNESS DIFF FAILED: the enumerated universe changed but ` +
          `tests/.coverage-registry.json was not regenerated. A new unit ` +
          `(arg-dispatch case, audit event, scope, stage, hook, or exported ` +
          `fn) with no covers: claim lands UNCOVERED. Regenerate with: ` +
          `bun tests/gen-coverage-registry.ts\n` +
          `--- committed / +++ fresh ---\n${lineDiff(committed, actual)}`,
      );
    }
  }

  // RATCHET: covered count per class must not drop below the committed baseline.
  if (!existsSync(RATCHET_PATH)) {
    ok = false;
    messages.push(
      `RATCHET FAILED: ${RATCHET_PATH} does not exist. ` +
        `Generate it with: bun tests/gen-coverage-registry.ts`,
    );
  } else {
    const baseline = JSON.parse(readFileSync(RATCHET_PATH, "utf-8")) as RatchetDoc;
    const current = ratchetFromRows(rows).coveredByClass;
    for (const c of UNIT_CLASSES) {
      const base = baseline.coveredByClass[c] ?? 0;
      const now = current[c] ?? 0;
      if (now < base) {
        ok = false;
        messages.push(
          `RATCHET FAILED: class "${c}" covered count DROPPED from ${base} ` +
            `(baseline) to ${now}. A covered unit lost its claim. Either ` +
            `restore the claim, or — if the unit was legitimately removed — ` +
            `regenerate the baseline with a reviewed commit: ` +
            `bun tests/gen-coverage-registry.ts`,
        );
      }
    }
  }

  return { ok, messages };
}

// ===========================================================================
// MAIN.
// ===========================================================================

function writeAll(rows: RegistryRow[]): void {
  writeFileSync(REGISTRY_PATH, registryJson(rows));
  writeFileSync(RATCHET_PATH, ratchetJson(ratchetFromRows(rows)));
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--check")) {
    const r = runCheck();
    if (!r.ok) {
      for (const m of r.messages) console.error(m);
      process.exit(1);
    }
    console.log("coverage registry: OK (fresh, guards green, ratchet held)");
    return;
  }

  const { rows } = buildRegistry();

  // Guards also run on a plain generate so we never WRITE a rotted registry.
  const empties = emptyClasses(rows);
  if (empties.length > 0) {
    console.error(
      `Refusing to write: empty unit class(es): ${empties.join(", ")}`,
    );
    process.exit(1);
  }
  const mismatches = subcommandCrossCheck();
  if (mismatches.length > 0) {
    for (const m of mismatches) {
      console.error(
        `Refusing to write: ${m.tool} parser/independent count mismatch ` +
          `(${m.parsed} vs ${m.independent})`,
      );
    }
    process.exit(1);
  }

  if (args.includes("--print")) {
    process.stdout.write(registryJson(rows));
    return;
  }

  writeAll(rows);

  // Report enumerated + covered counts per class to stdout.
  const byClass: Record<string, { total: number; covered: number }> = {};
  for (const c of UNIT_CLASSES) byClass[c] = { total: 0, covered: 0 };
  for (const r of rows) {
    byClass[r.unitClass].total++;
    if (r.status === "covered") byClass[r.unitClass].covered++;
  }
  console.log("Wrote tests/.coverage-registry.json + tests/.coverage-ratchet.json");
  console.log("Enumerated units (covered / total) per class:");
  for (const c of UNIT_CLASSES) {
    console.log(
      `  ${c.padEnd(11)} ${byClass[c].covered}/${byClass[c].total}`,
    );
  }
  console.log(`  ${"TOTAL".padEnd(11)} ${rows.filter((r) => r.status === "covered").length}/${rows.length}`);
}

if (import.meta.main) main();
