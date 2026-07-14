import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntry, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  artifactsRegistryFor,
  findCycles,
  frameworkMemorySeedDir,
  loadGraph,
  loadRules,
  memoryDirFor,
  selectionDroppedOrderingEdges,
  stageGraphDrift,
  type GraphStage,
  validateGrid,
  validateScope,
} from "./aidlc-graph.ts";
import { repointHarnessIncludes } from "./aidlc-includes.ts";
import {
  activeIntent,
  activeSpace,
  auditFilePath,
  auditShards,
  birthIntent,
  composeMarkerPath,
  COMPOSE_MARKER_TTL_MS,
  DEFAULT_SPACE,
  detectLeakedLocks,
  docsDir,
  knowledgeDir,
  agentsDir,
  emitError,
  errorMessage,
  escapeRegex,
  findAllEvents,
  findStageBySlug,
  frontmatterBlock,
  getField,
  holdsAuditLock,
  hooksHealthDir,
  isAutonomousMode,
  isoTimestamp,
  isPackageJson,
  codekbRepoName,
  relativeCodekbDir,
  RESERVED_RECORD_NAMES,
  gridCostSummary,
  listIntents,
  listSpaces,
  loadAgents,
  loadScopeMapping,
  loadStageGraph,
  loadStageGraphAll,
  loadScopeMetadataAll,
  MERGE_SUCCEEDED_TAG_REGEX,
  migrateFlatLayout,
  nextInScopeStage,
  PHASES,
  parseArgs,
  parseCheckboxes,
  parseRefsList,
  parseStageFrontmatter,
  parseStateStageSuffixes,
  readAllAuditShards,
  readCurrentSessionId,
  readStateFile,
  resolveBirthRepoSet,
  resolveProjectDir,
  setActiveIntentCursor,
  setActiveSpaceCursor,
  slugify,
  SLUG_TAG_REGEX,
  spacesRoot,
  type StageEntry,
  setCheckbox,
  setField,
  setPhaseProgress,
  setStageSuffix,
  scopeGridPath,
  scopesDir,
  harnessDataPath,
  pluginsEnabled,
  selectionAwareDefaultScope,
  scalarField,
  stageEnabledBySelection,
  stagesInScope,
  stateFilePath,
  withAuditLock,
  validateBoltSlug,
  validScopes,
  worktreeAuditFilePath,
  worktreePath,
  worktreeStateFilePath,
  writeSessionIntentUuid,
  writeStateFile,
  harnessDir,
  rulesSubdir,
  _resetHarnessDataForTests,
  _resetScopeMappingForTests,
  _resetStageGraphForTests,
} from "./aidlc-lib.ts";
import { validateStageFrontmatter } from "./aidlc-stage-schema.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

const VALID_DEPTHS: Record<string, string> = {
  minimal: "Minimal",
  standard: "Standard",
  comprehensive: "Comprehensive",
};

const VALID_TEST_STRATEGIES: Record<string, string> = {
  minimal: "Minimal",
  standard: "Standard",
  comprehensive: "Comprehensive",
};

function die(msg: string): never {
  // Parse --project-dir from argv so ERROR_LOGGED lands in the correct workflow
  // even on errors raised BEFORE main() completes flag parsing. Fall back to
  // default resolution (env var / cwd) if absent.
  const args = process.argv.slice(2);
  const pdIdx = args.indexOf("--project-dir");
  const explicitPd = pdIdx !== -1 && pdIdx + 1 < args.length ? args[pdIdx + 1] : undefined;
  const pd = resolveProjectDir(explicitPd);
  const command = `aidlc-utility ${args.join(" ")}`.trim();
  emitError(pd, "aidlc-utility", command, msg);
}

// Thin wrapper around the canonical appendAuditEntry. All events must be in
// aidlc-audit.ts VALID_EVENT_TYPES. Throws on invalid event or audit failure —
// caller is expected to let that propagate (birth failures should stop birth).
//
// Lock-aware (mirrors aidlc-state.ts emitAudit): handleIntentBirth wraps the
// whole birth transaction in withAuditLock on the WORKSPACE sentinel bucket, so
// this process already owns that OS lock. Routing through appendAuditEntry
// (which calls the NON-reentrant acquireAuditLock keyed on the same sentinel
// when intent is omitted) would self-deadlock and burn the 5s retry budget
// before throwing — so detect the held lock and use the unlocked variant.
// Outside a held lock (every other caller — status/doctor/etc.) it takes its
// own lock as before.
function appendAuditEvent(
  projectDir: string,
  event: string,
  fields: Record<string, string>
): void {
  if (holdsAuditLock(projectDir)) {
    appendAuditEntryUnlocked(event, fields, projectDir);
  } else {
    appendAuditEntry(event, fields, projectDir);
  }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
//
// HELP_TEXT is no longer a static constant — the scopes block renders
// from loadScopeMapping() so stage counts stay fresh by construction.
// Previously hardcoded counts drifted as scopes evolved; sourcing from
// the live mapping makes that impossible.

const HELP_TEXT_HEAD = `AI-DLC — AI-Driven Development Life Cycle

Usage: /aidlc [command]

Scopes (set depth, test strategy, and stage count):
`;

const HELP_TEXT_TAIL = `
Utilities:
  --status          Show current workflow progress (read-only)
  compose "<task>"  Propose a tailored EXECUTE/SKIP plan (mid-workflow: re-shape the pending stages)
  compose --report <path>  Compose from a scan report (triage findings into a fix-and-ship run)
  --new-scope "<task>"  Force the composer to synthesize a custom scope even when a stock scope matches
  intent            List intents in the active space (read-only; --json for structured output)
  intent <name>     Switch the active intent
  space             List spaces (read-only; --json for structured output)
  space <name>      Switch the active space (team)
  space-create <name>  Create a new space (team) seeded from the framework baseline
  select-plugins [names]  Show or set enabled plugins (comma-separated names)
  --doctor          Run health check on hooks, settings, and directory structure
  --stage <id>      Jump to a specific stage (by slug or number, e.g., code-generation or 3.5)
  --phase <name>    Jump to the first in-scope stage of a phase (e.g., construction or 3)
  --scope <scope>   Set or change scope (standalone or with --stage/--phase)
  --depth <level>   Override depth (minimal, standard, comprehensive)
  --test-strategy <level>  Override test strategy (minimal, standard, comprehensive)
  --version         Show the framework version
  --help            Show this help message

Other:
  <description>     Describe what to build — scope is auto-detected
  (no arguments)    Resume existing workflow, or start fresh if none exists

Examples:
  /aidlc feature                                Start a feature workflow
  /aidlc Fix the login timeout bug              Auto-detected as bugfix scope
  /aidlc compose "harden the deploy pipeline"   Composer proposes a tailored plan
  bun ${harnessDir()}/tools/aidlc-utility.ts select-plugins aidlc,test-pro  Enable core + test-pro
  /aidlc                                        Resume or begin
  /aidlc --stage code-generation                Jump to code-generation stage
  /aidlc --phase construction --scope bugfix    Jump to construction with bugfix scope
  /aidlc --scope bugfix --depth comprehensive  Bugfix with comprehensive depth
  /aidlc --depth minimal                       Change depth of active workflow
  /aidlc --depth standard --test-strategy minimal  Full artifacts, minimal tests`;

/** Exported for t67 unit tests. */
export function renderHelpText(): string {
  const mapping = loadScopeMapping();
  const defaultResolution = selectionAwareDefaultScope();
  const defaultScope = defaultResolution.error ? "" : defaultResolution.scope;
  const scopeLines = [...validScopes()].map((name) => {
    const def = mapping[name];
    const execute = Object.values(def.stages).filter((v) => v === "EXECUTE")
      .length;
    const total = Object.keys(def.stages).length;
    const depth = def.depth.toLowerCase();
    const ts = def.testStrategy
      ? `, ${def.testStrategy.toLowerCase()} test strategy`
      : "";
    const desc = def.description ? ` — ${def.description}` : "";
    const defaultMarker = name === defaultScope ? " (default)" : "";
    const countStr =
      execute === total ? `All ${total} stages` : `${execute} of ${total} stages`;
    return `  ${name.padEnd(18)}${countStr}, ${depth} depth${ts}${defaultMarker}${desc}`;
  });
  // Blank line before HELP_TEXT_TAIL so the `Utilities:` header is visually
  // separated from the scope list.
  return `${HELP_TEXT_HEAD + scopeLines.join("\n")}\n${HELP_TEXT_TAIL}`;
}

function handleHelp(): void {
  process.stdout.write(`${renderHelpText()}\n`);
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

function handleVersion(): void {
  process.stdout.write(`aidlc ${AIDLC_VERSION}\n`);
}

// ---------------------------------------------------------------------------
// select-plugins
// ---------------------------------------------------------------------------

interface FileSnapshot {
  path: string;
  exists: boolean;
  bytes: string;
}

function snapshotFile(path: string): FileSnapshot {
  return {
    path,
    exists: existsSync(path),
    bytes: existsSync(path) ? readFileSync(path, "utf-8") : "",
  };
}

function restoreSnapshot(snapshot: FileSnapshot): void {
  if (snapshot.exists) {
    mkdirSync(dirname(snapshot.path), { recursive: true });
    writeFileSync(snapshot.path, snapshot.bytes, "utf-8");
  } else if (existsSync(snapshot.path)) {
    rmSync(snapshot.path, { force: true });
  }
}

function resetSelectionSensitiveCaches(): void {
  _resetHarnessDataForTests();
  _resetStageGraphForTests();
  _resetScopeMappingForTests();
}

function stageGraphDataPath(): string {
  return join(TOOLS_DIR, "data", "stage-graph.json");
}

function knownPluginNames(): string[] {
  const names = new Set<string>(["aidlc"]);
  try {
    for (const stage of loadStageGraphAll()) {
      if (stage.plugin) names.add(stage.plugin);
    }
  } catch {
    // Scope files still provide known plugin identities when the graph is stale.
  }
  for (const meta of Object.values(loadScopeMetadataAll())) {
    names.add(meta.plugin ?? "aidlc");
  }
  return [...names].sort();
}

function selectionOwner(stage: Pick<StageEntry, "plugin">): string {
  return stage.plugin ?? "aidlc";
}

function countOwner(stage: Pick<StageEntry, "plugin" | "phase">): string {
  return stage.phase === "initialization" ? "bootstrap" : selectionOwner(stage);
}

function expectedEnabledBySelection(stage: Pick<StageEntry, "plugin" | "phase">): boolean {
  return stageEnabledBySelection(stage);
}

function parsePluginSelectionArgs(positional: string[]): { names: string[]; hasEmpty: boolean } {
  const parts = positional.slice(1).join(",").split(",").map((s) => s.trim());
  return {
    names: parts.filter((s) => s.length > 0),
    hasEmpty: parts.some((s) => s.length === 0),
  };
}

function renderPluginSelection(selected: ReadonlySet<string> | null): string {
  return selected === null ? "all enabled (no selection)" : [...selected].sort().join(", ");
}

function readHarnessDataObject(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(harnessDataPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Reconstruct a legacy/missing file from runtime defaults.
  }
  return { harnessDir: harnessDir(), rulesSubdir: rulesSubdir() };
}

function writePluginSelection(names: string[]): void {
  const data = readHarnessDataObject();
  data.plugins = names;
  mkdirSync(dirname(harnessDataPath()), { recursive: true });
  writeFileSync(harnessDataPath(), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  resetSelectionSensitiveCaches();
}

function runBunTool(projectDir: string, rel: string, args: string[], label: string): void {
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(TOOLS_DIR, rel), ...args],
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AIDLC_HARNESS_DIR: harnessDir() },
  });
  if (result.exitCode !== 0) {
    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${label} failed: ${(stderr || stdout || `exit ${result.exitCode}`).slice(0, 800)}`);
  }
}

interface GeneratedRegionLocation {
  beginIdx: number;
  endIdx: number;
  regionEndIdx: number;
}

function findGeneratedRegion(
  body: string,
  beginMarker: string,
  endMarker: string,
  verb: string,
  skillPath: string,
): GeneratedRegionLocation {
  const beginIdx = body.indexOf(beginMarker);
  const lastBeginIdx = body.lastIndexOf(beginMarker);
  const endIdx = body.indexOf(endMarker);
  const lastEndIdx = body.lastIndexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(
      `SKILL.md at ${skillPath} is missing ${verb} markers. Expected:\n  ${beginMarker}\n  ${endMarker}`,
    );
  }
  if (beginIdx !== lastBeginIdx || endIdx !== lastEndIdx) {
    throw new Error(
      `SKILL.md at ${skillPath} has duplicate ${verb} markers. Expected exactly one BEGIN and one END.`,
    );
  }
  if (endIdx < beginIdx) {
    throw new Error(
      `SKILL.md at ${skillPath} has ${verb} markers out of order (END before BEGIN).`,
    );
  }
  return { beginIdx, endIdx, regionEndIdx: endIdx + endMarker.length };
}

function replaceGeneratedRegion(
  verb: string,
  beginMarker: string,
  endMarker: string,
  region: string,
): void {
  const path = skillMdPath();
  const before = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  const located = findGeneratedRegion(before, beginMarker, endMarker, verb, path);
  const after = before.slice(0, located.beginIdx) + region + before.slice(located.regionEndIdx);
  if (after !== before) writeFileSync(path, after, "utf-8");
}

function regenerateSelectionSurfaces(projectDir: string): void {
  runBunTool(projectDir, "aidlc-graph.ts", ["compile"], "aidlc-graph compile");
  resetSelectionSensitiveCaches();
  const skillsDir = join(TOOLS_DIR, "..", "skills");
  if (existsSync(skillsDir)) {
    runBunTool(projectDir, "aidlc-runner-gen.ts", ["write"], "aidlc-runner-gen write");
    runBunTool(projectDir, "aidlc-runner-gen.ts", ["scopes"], "aidlc-runner-gen scopes");
  } else {
    process.stdout.write(
      `note: runner regeneration skipped: ${skillsDir} not present in this install\n`,
    );
  }
  resetSelectionSensitiveCaches();
  replaceGeneratedRegion(
    "stage-table",
    STAGE_TABLE_BEGIN,
    STAGE_TABLE_END,
    canonicalStageTableRegion(renderStageTable()),
  );
  replaceGeneratedRegion(
    "scope-table",
    SCOPE_TABLE_BEGIN,
    SCOPE_TABLE_END,
    canonicalScopeTableRegion(renderScopeTable()),
  );
}

// --- disable-time contribution strip -----------------------------------------
//
// Compose merges a plugin's structural adds (produces/sensors/consumes/
// required_sections) into CORE stage source, where no selection filter
// reaches, and records what it actually added in a per-plugin sidecar
// (tools/data/plugin-contrib-<key>.json). Prose fragments carry their own
// sentinel markers. On disable, select-plugins strips both, so a disabled
// plugin's contributions stop steering enabled stages; re-enabling restores
// them on the next session start (the plugin's compose hook re-merges).

interface StageContribRecord {
  produces?: string[];
  sensors?: string[];
  consumes?: string[];
  required_sections?: string[];
  required_sections_created?: boolean;
}

function pluginContribSidecarPath(plugin: string): string {
  return join(TOOLS_DIR, "data", `plugin-contrib-${plugin.replace(/[^\w.-]/g, "_")}.json`);
}

function installedStagesRoot(): string {
  return join(TOOLS_DIR, "..", "aidlc-common", "stages");
}

// Remove recorded values from a `field:` block. An emptied block collapses to
// the inline `field: []` form (the shape compose's merge expanded from); a
// created-by-compose required_sections field is deleted outright.
function removeListValues(content: string, field: string, values: ReadonlySet<string>, dropEmptyField: boolean): string {
  const blockRe = new RegExp(`^${field}:\\n((?:  - .+\\n)*)`, "m");
  const m = content.match(blockRe);
  if (!m) return content;
  const kept = [...m[1].matchAll(/^ {2}- (.+)$/gm)]
    .map((x) => x[1])
    .filter((v) => {
      const bare = v.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      return !values.has(bare) && !values.has(v.trim());
    });
  const replacement = kept.length > 0
    ? `${field}:\n${kept.map((v) => `  - ${v}`).join("\n")}\n`
    : dropEmptyField ? "" : `${field}: []\n`;
  return content.replace(blockRe, replacement);
}

function removeConsumesEntries(content: string, artifacts: ReadonlySet<string>): string {
  const blockRe = /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m;
  const m = content.match(blockRe);
  if (!m) return content;
  const kept = [...m[1].matchAll(/^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm)]
    .filter((entry) => !artifacts.has(entry[1]))
    .map((entry) => entry[0]);
  const replacement = kept.length > 0 ? `consumes:\n${kept.join("")}` : "consumes: []\n";
  return content.replace(blockRe, replacement);
}

// Strip every sentinel-marked prose fragment this plugin spliced. The open
// and close markers carry the plugin name, so removal needs no sidecar.
// Anchors may themselves contain colons (after-step:9, in:Sensors), so the
// anchor segment is matched non-greedily up to the trailing :order:hash.
function removePluginFragments(content: string, plugin: string): string {
  const pE = escapeRegex(plugin);
  const openRe = new RegExp(`<!-- plugin:${pE}:.+?:\\d+:[0-9a-f]+ -->`, "g");
  let out = content;
  let match = openRe.exec(out);
  while (match !== null) {
    const close = `<!-- /${match[0].slice(5)}`;
    const closeIdx = out.indexOf(close, match.index);
    if (closeIdx === -1) break; // unpaired marker: leave as-is (doctor territory)
    const end = closeIdx + close.length;
    out = `${out.slice(0, match.index)}${out.slice(end)}`.replace(/\n{3,}/g, "\n\n");
    openRe.lastIndex = 0;
    match = openRe.exec(out);
  }
  return out;
}

// Strip the merged contributions of every named plugin from installed stage
// source. Mutated stage files are snapshotted into `snapshots` FIRST so the
// caller's rollback restores them; consumed sidecars are snapshotted then
// deleted (compose re-records on re-enable).
function stripDisabledPluginContributions(
  plugins: readonly string[],
  snapshots: FileSnapshot[],
): string[] {
  const stagesRoot = installedStagesRoot();
  const touched = new Set<string>();
  const snapshotOnce = (path: string): void => {
    if (touched.has(path)) return;
    snapshots.push(snapshotFile(path));
    touched.add(path);
  };
  const stripped: string[] = [];
  for (const plugin of plugins) {
    const sidecar = pluginContribSidecarPath(plugin);
    let manifest: Record<string, StageContribRecord> = {};
    if (existsSync(sidecar)) {
      try {
        const parsed = JSON.parse(readFileSync(sidecar, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed;
      } catch {
        // Unreadable sidecar: fragments still strip below; structural adds stay.
      }
    }
    let pluginTouched = false;
    for (const phase of PHASES) {
      const dir = join(stagesRoot, phase);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
        const path = join(dir, f);
        const before = readFileSync(path, "utf-8");
        let content = before;
        const record = manifest[f.replace(/\.md$/, "")];
        if (record) {
          if (record.produces?.length) content = removeListValues(content, "produces", new Set(record.produces), false);
          if (record.sensors?.length) content = removeListValues(content, "sensors", new Set(record.sensors), false);
          if (record.consumes?.length) content = removeConsumesEntries(content, new Set(record.consumes));
          if (record.required_sections?.length) {
            content = removeListValues(content, "required_sections", new Set(record.required_sections), record.required_sections_created === true);
          }
        }
        content = removePluginFragments(content, plugin);
        if (content !== before) {
          snapshotOnce(path);
          writeFileSync(path, content, "utf-8");
          pluginTouched = true;
        }
      }
    }
    if (existsSync(sidecar)) {
      snapshotOnce(sidecar);
      rmSync(sidecar, { force: true });
      pluginTouched = true;
    }
    if (pluginTouched) stripped.push(plugin);
  }
  return stripped;
}

// A selection change must not strand a live workflow: after disable, a state
// file whose Scope belongs to a disabled plugin makes every later /aidlc on
// that workflow hard-error ("Unknown scope") with no in-band way out (the
// state file's scope out-ranks --scope), and a plugin-owned EXECUTE stage
// still pending in the plan either errors (it is Current Stage) or silently
// vanishes from the walk. Enumerate every non-complete workflow across all
// spaces and name each dependency on a plugin the new selection disables.
function activeWorkflowDependencyViolations(
  projectDir: string,
  enabled: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  const scopeOwner = new Map<string, string>();
  for (const [name, meta] of Object.entries(loadScopeMetadataAll())) {
    scopeOwner.set(name, meta.plugin ?? "aidlc");
  }
  // Mirror stageEnabledBySelection: initialization stages are always enabled,
  // so they can never strand a plan regardless of the selection.
  const stageOwner = new Map<string, string>();
  for (const stage of loadStageGraphAll()) {
    if (stage.phase === "initialization") continue;
    stageOwner.set(stage.slug, stage.plugin ?? "aidlc");
  }
  for (const space of listSpaces(projectDir)) {
    for (const intent of listIntents(projectDir, space.name)) {
      if (intent.status === "complete" || !intent.dirName) continue;
      const sp = stateFilePath(projectDir, intent.dirName, space.name);
      if (!existsSync(sp)) continue;
      const content = readFileSync(sp, "utf-8");
      if ((getField(content, "Status") ?? "") === "Completed") continue;
      const where = `workflow "${intent.dirName}" (space ${space.name})`;
      const scope = getField(content, "Scope");
      if (scope) {
        const owner = scopeOwner.get(scope);
        if (owner && !enabled.has(owner)) {
          violations.push(`${where} runs under scope "${scope}" owned by plugin "${owner}"`);
        }
      }
      // Pending/active plugin-owned stages in the plan (EXECUTE rows that are
      // not yet completed/skipped) - the walk would error on or silently drop
      // them. Completed rows are history; they don't depend on the plugin.
      for (const cb of parseCheckboxes(content)) {
        if (cb.state === "completed" || cb.state === "skipped") continue;
        if (!cb.suffix.startsWith("EXECUTE")) continue;
        const owner = stageOwner.get(cb.slug);
        if (owner && !enabled.has(owner)) {
          violations.push(`${where} has pending stage "${cb.slug}" owned by plugin "${owner}"`);
        }
      }
    }
  }
  return violations;
}

function handleSelectPlugins(projectDir: string, positional: string[]): void {
  if (positional.length === 1) {
    const selection = renderPluginSelection(pluginsEnabled());
    process.stdout.write(
      `Current plugin selection: ${selection}\nKnown plugins: ${knownPluginNames().join(", ")}\n`,
    );
    return;
  }

  const parsedSelection = parsePluginSelectionArgs(positional);
  if (parsedSelection.hasEmpty || parsedSelection.names.length === 0) {
    die("select-plugins requires at least one non-empty plugin name, or no arguments to print the current selection.");
  }
  const known = knownPluginNames();
  const knownSet = new Set(known);
  const unknown = parsedSelection.names.filter((name) => !knownSet.has(name));
  if (unknown.length > 0) {
    die(`Unknown plugin name(s): ${unknown.join(", ")}. Valid plugins: ${known.join(", ")}.`);
  }
  const names = [...new Set(parsedSelection.names)].sort();

  const violations = activeWorkflowDependencyViolations(projectDir, new Set(names));
  if (violations.length > 0) {
    die(
      `select-plugins refused: the new selection would strand ${violations.length} active workflow dependency(ies):\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        `\nComplete or park the workflow(s) first (or keep the plugin enabled), then re-run select-plugins.`,
    );
  }

  const previousSelection = renderPluginSelection(pluginsEnabled());
  const newSelection = names.join(", ");
  const nameSet = new Set(names);
  // Plugins this change DISABLES (known but not selected; the implicit core
  // plugin has no composed contributions to strip).
  const disabling = known.filter((n) => n !== "aidlc" && !nameSet.has(n));

  const snapshots = [
    snapshotFile(harnessDataPath()),
    snapshotFile(stageGraphDataPath()),
    snapshotFile(scopeGridPath()),
  ];

  try {
    // Strip disabled plugins' merged contributions BEFORE recompiling, so the
    // regenerated graph no longer carries their produces/sensors/consumes on
    // core stages. Mutated stage files join `snapshots`, so the catch-side
    // rollback restores them too. Re-enabling restores contributions on the
    // next session start (the plugin's own compose hook re-merges).
    const strippedPlugins = stripDisabledPluginContributions(disabling, snapshots);
    writePluginSelection(names);
    regenerateSelectionSurfaces(projectDir);
    appendAuditEvent(projectDir, "PLUGIN_SELECTION_CHANGED", {
      "Previous Selection": previousSelection,
      "New Selection": newSelection,
    });
    if (strippedPlugins.length > 0) {
      process.stdout.write(
        `Stripped merged contributions of disabled plugin(s): ${strippedPlugins.join(", ")} (re-enabling restores them on the next session start)\n`,
      );
    }
    process.stdout.write(`Enabled plugins: ${names.join(", ")}\n`);
  } catch (err) {
    const original = errorMessage(err);
    let recoveryMessage = "";
    try {
      for (const snapshot of snapshots) restoreSnapshot(snapshot);
      resetSelectionSensitiveCaches();
      regenerateSelectionSurfaces(projectDir);
      recoveryMessage =
        " Restored harness.json, stage-graph.json, scope-grid.json, and any stripped stage files, then re-ran the regeneration chain against the restored selection.";
    } catch (recoveryErr) {
      recoveryMessage =
        ` Restore was attempted, but regeneration against the restored selection also failed: ${errorMessage(recoveryErr)}.`;
    }
    die(`select-plugins failed: ${original}.${recoveryMessage}`);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function handleStatus(projectDir: string, flags: Record<string, string>): void {
  // --intent <record> / --space <name> target a specific intent's status
  // (vision §5); omitted -> the active record.
  const sp = stateFilePath(projectDir, flags.intent, flags.space);
  if (!existsSync(sp)) {
    process.stdout.write(
      `No active AI-DLC workflow found.

To get started:
  /aidlc "build the auth service"   Describe what to build (auto-births an intent)
  /aidlc <scope>      Start a workflow by scope (e.g., /aidlc feature)
  /aidlc --help       Show all commands and scopes
`
    );
    return;
  }

  const content = readFileSync(sp, "utf-8");
  const graph = loadStageGraph();

  // Extract key fields
  const project = getField(content, "Project") || "Unknown";
  const scope = getField(content, "Scope") || "Unknown";
  const phase = getField(content, "Lifecycle Phase") || "Unknown";
  const currentStage = getField(content, "Current Stage") || "Unknown";
  const status = getField(content, "Status") || "Unknown";
  const activeAgent = getField(content, "Active Agent") || "None";
  const lastCompleted = getField(content, "Last Completed Stage") || "None";
  const nextStage = getField(content, "Next Stage") || "None";

  // Find current stage number
  const currentEntry = graph.find((s) => s.slug === currentStage);
  const stageDisplay = currentEntry
    ? `${currentEntry.name} (${currentEntry.number})`
    : currentStage;

  // Gate awareness — when the current stage's checkbox is [?] or [R], the
  // user (not the LLM) is the blocker. Surface this explicitly in Status so
  // `/aidlc --status` answers "what's blocking this workflow?" correctly.
  const checkboxesAll = parseCheckboxes(content);
  const currentCheckbox = checkboxesAll.find((c) => c.slug === currentStage);
  let statusLine = status;
  if (currentCheckbox?.state === "awaiting-approval") {
    const displayName = currentEntry?.name ?? currentStage;
    statusLine = `Awaiting your approval on ${displayName}`;
  } else if (currentCheckbox?.state === "revising") {
    const displayName = currentEntry?.name ?? currentStage;
    const revisionCount = getField(content, "Revision Count");
    // If the Revision Count field is missing, omit the count rather than
    // render a literal "?" — state files authored before the field existed
    // would otherwise render "revision ? of 3".
    statusLine = revisionCount
      ? `Revising ${displayName} (revision ${revisionCount} of 3)`
      : `Revising ${displayName}`;
  } else if (currentCheckbox?.state === "completed" && status === "Running") {
    // Post-approve window: the stage was approved (→ [x]) but the orchestrator
    // hasn't called `advance` yet, so Current Stage still points here. Tell
    // the user honestly rather than showing "Running" on a completed stage.
    const displayName = currentEntry?.name ?? currentStage;
    statusLine = `${displayName} approved — ready to advance`;
  }

  // Checkbox counts - filter to the EFFECTIVE plan when scope is known: the
  // state file's per-stage EXECUTE/SKIP suffixes (a recomposed plan) override
  // the static grid, so status counts against what the router will actually
  // run, not the pre-recompose column.
  const checkboxes = parseCheckboxes(content);
  const suffixOverrides = parseStateStageSuffixes(content);
  const inScopeInfo = stagesInScope(scope);
  const inScopeSlugs = new Set(
    inScopeInfo
      .filter((s) => (suffixOverrides.get(s.slug) ?? s.action) === "EXECUTE")
      .map((s) => s.slug)
  );
  const scopedCheckboxes =
    scope !== "Unknown" && inScopeSlugs.size > 0
      ? checkboxes.filter((c) => inScopeSlugs.has(c.slug))
      : checkboxes;
  const total = scopedCheckboxes.length;
  const completed = scopedCheckboxes.filter((c) => c.state === "completed").length;
  const skipped = scopedCheckboxes.filter((c) => c.state === "skipped").length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Build phase progress bars
  const phaseLabels: Record<string, string> = {
    initialization: "INITIALIZATION",
    ideation: "IDEATION",
    inception: "INCEPTION",
    construction: "CONSTRUCTION",
    operation: "OPERATION",
  };

  let phaseProgress = "";
  for (const p of PHASES) {
    const phaseStages = graph.filter((s) => s.phase === p);
    const phaseSlugs = new Set(phaseStages.map((s) => s.slug));
    const phaseCheckboxes = scopedCheckboxes.filter((c) => phaseSlugs.has(c.slug));
    if (phaseCheckboxes.length === 0) continue;

    const bar = phaseCheckboxes
      .map((c) => {
        switch (c.state) {
          case "completed":
            return "\u2588";
          case "in-progress":
            return "\u2592";
          case "awaiting-approval":
            return "?";
          case "revising":
            return "R";
          case "skipped":
            return "S";
          default:
            return "\u2591";
        }
      })
      .join("");

    const done = phaseCheckboxes.filter(
      (c) => c.state === "completed"
    ).length;
    phaseProgress += `  ${(phaseLabels[p] || p).padEnd(16)} ${bar} ${done}/${phaseCheckboxes.length}\n`;
  }

  const output = `AI-DLC Workflow Status
==============================
Project:        ${project}
Scope:          ${scope}
Phase:          ${phase}
Current Stage:  ${stageDisplay}
Status:         ${statusLine}
Active Agent:   ${activeAgent}
Completion:     ${completed}/${total} stages (${pct}%)${skipped > 0 ? ` — ${skipped} skipped` : ""}

Phase Progress:
${phaseProgress}
Last Completed: ${lastCompleted}
Next Stage:     ${nextStage}
`;
  process.stdout.write(output);
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

// Threshold (days) beyond which doctor flags practices as stale and prompts
// re-affirmation.
export const PRACTICES_STALENESS_DAYS = 90;

// MERGE_DISPATCH INVOKED-orphan window for advisory reconciliation. Window
// covers a generous LLM Task call budget (Haiku 30s + retry + parse).
export const MERGE_DISPATCH_TIMEOUT_SEC = 60;

interface NamingMismatch {
  file: string;
  stem: string;
  name: string;
}

function frontmatterFields(filePath: string, kind: "Agent" | "Scope"): { name: string; plugin: string } {
  const body = readFileSync(filePath, "utf-8");
  const fm = frontmatterBlock(body);
  if (fm === null) throw new Error(`${kind} file missing frontmatter: ${filePath}`);
  const name = scalarField(fm, "name");
  if (!name) throw new Error(`${kind} file ${filePath} missing required frontmatter: name`);
  return { name, plugin: scalarField(fm, "plugin") };
}

function scopeFilenameMatchesDeclaredName(stem: string, name: string, plugin: string): boolean {
  if (plugin) return stem === name;
  return stem === name || stem === `aidlc-${name}`;
}

function namingMismatches(
  dir: string,
  kind: "Agent" | "Scope",
  matches: (stem: string, name: string, plugin: string) => boolean,
): NamingMismatch[] {
  if (!existsSync(dir)) return [];
  const mismatches: NamingMismatch[] = [];
  for (const f of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
    const filePath = join(dir, f);
    if (!statSync(filePath).isFile()) continue;
    const { name, plugin } = frontmatterFields(filePath, kind);
    const stem = basename(f, ".md");
    if (!matches(stem, name, plugin)) {
      mismatches.push({ file: filePath, stem, name });
    }
  }
  return mismatches;
}

function pushNamingAdvisory(
  results: Array<{ pass: boolean; label: string; fix?: string }>,
  label: "Agent" | "Scope",
  mismatches: NamingMismatch[],
): void {
  if (mismatches.length === 0) {
    results.push({
      pass: true,
      label: `${label} filename/name consistency: all ${label.toLowerCase()} files match declared names`,
    });
    return;
  }
  const detail = mismatches
    .map((m) => `${m.file} stem "${m.stem}" declares name "${m.name}"`)
    .join("; ");
  results.push({
    pass: true,
    label: `${label} filename/name consistency: ${mismatches.length} mismatch(es) (advisory): ${detail}. Rename the file or fix the name.`,
  });
}

function handleDoctor(projectDir: string): void {
  const results: Array<{ pass: boolean; label: string; fix?: string }> = [];
  const isWindows = process.platform === "win32";

  // 1. bun installed — check PATH (Bun.which handles Windows .exe suffix automatically)
  const bunHome = process.env.HOME ? join(process.env.HOME, ".bun", "bin", "bun") : "";
  const bunFound = Bun.which("bun") !== null || (bunHome !== "" && existsSync(bunHome));
  results.push({
    pass: bunFound,
    label: "bun installed (required for CLI tools and hooks)",
    fix: isWindows
      ? "install via `npm install -g bun` or `powershell -c \"irm bun.sh/install.ps1 | iex\"`"
      : "install via `curl -fsSL https://bun.sh/install | bash`",
  });

  // 2. Hook presence — every framework hook is TypeScript, run via bun (no
  // executable bit needed). The core hook bodies ship in EVERY harness tree; the
  // Kiro and Codex trees additionally carry an authored stdin adapter that wires
  // them up.
  const harness = harnessDir();
  if (harness === ".claude") {
    // Claude Code: the EXPECTED roster is the set of aidlc-*.ts hooks that
    // settings.json actually wires (its `hooks` event blocks + the `statusLine`
    // command) — that is the CONTRACT Claude Code will try to run. Each
    // expected hook's PRESENCE is then probed against the project's own
    // .claude/hooks/ directory. A hook wired in settings.json but missing on
    // disk is a real runtime breakage, and this surfaces it as a loud ✗.
    //
    // Why settings.json, not readdirSync of the hooks dir: doctor's normal
    // invocation derives projectDir from the tool's OWN location
    // (resolveProjectDir step 3), so the hooks dir IS the dir a roster would be
    // enumerated from — probing an enumerated-from-itself roster is tautological
    // (every hook trivially "present", a deleted hook silently absent from the
    // roster). Sourcing the expectation from settings.json instead means the
    // roster and the probe target genuinely diverge, so a missing hook is caught
    // in the real single-install path. It is also self-maintaining: wire a new
    // hook in settings.json and doctor checks it automatically (no hardcoded
    // list to drift — the old list named only 7 of the 10 shipped hooks).
    const settingsForHooks = join(projectDir, harness, "settings.json");
    let expectedHooks: string[] = [];
    let settingsReadable = true;
    try {
      const raw = readFileSync(settingsForHooks, "utf-8");
      // jq-free: collect every distinct aidlc-*.ts basename referenced anywhere
      // in settings.json (hook command paths like
      // "bun $CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-audit-logger.ts" and the
      // statusLine command). Basename, not path, so the probe is dir-relative.
      const refs = new Set<string>();
      for (const m of raw.matchAll(/aidlc-[A-Za-z0-9_-]+\.ts/g)) {
        refs.add(m[0]);
      }
      expectedHooks = [...refs].sort();
    } catch {
      settingsReadable = false;
    }
    if (!settingsReadable) {
      // settings.json missing/unreadable: fail LOUD (the wiring-config check
      // below also flags its absence, but the hook contract genuinely cannot be
      // verified, so say so rather than silently checking nothing).
      results.push({
        pass: false,
        label: "Hook contract: settings.json unreadable — cannot verify wired hooks",
        fix: "restore .claude/settings.json (copy from `dist/claude/.claude/settings.json`)",
      });
    } else if (expectedHooks.length === 0) {
      // settings.json parsed but wires no aidlc hooks — also loud (a stripped
      // settings.json that lost its hooks block is a real misconfiguration).
      results.push({
        pass: false,
        label: "Hook contract: settings.json wires no aidlc-*.ts hooks",
        fix: "restore the hooks block in .claude/settings.json (copy from `dist/claude/.claude/settings.json`)",
      });
    } else {
      for (const h of expectedHooks) {
        const hookPath = join(projectDir, harness, "hooks", h);
        results.push({
          pass: existsSync(hookPath),
          label: `${h} present`,
          fix: "verify file exists in .claude/hooks/",
        });
      }
    }
  } else {
    // Kiro / Codex: the wiring config is not settings.json (it is
    // agents/aidlc.json / hooks.json — checked below). The core hook bodies
    // ship in every tree plus an authored adapter, so probe the explicit roster.
    const tsHooks = [
      "aidlc-audit-logger",
      "aidlc-sync-statusline",
      "aidlc-validate-state",
      "aidlc-log-subagent",
      "aidlc-session-start",
      "aidlc-session-end",
      "aidlc-statusline",
    ];
    if (harness === ".kiro") tsHooks.push("aidlc-kiro-adapter");
    if (harness === ".codex") tsHooks.push("aidlc-codex-adapter");
    for (const h of tsHooks) {
      const hookPath = join(projectDir, harness, "hooks", `${h}.ts`);
      results.push({
        pass: existsSync(hookPath),
        label: `${h}.ts present`,
        fix: `verify file exists in ${harness}/hooks/`,
      });
    }
  }

  // 4. Harness wiring config present. Claude Code: settings.json (hooks +
  // permissions live there). Kiro CLI: the aidlc agent config (hooks +
  // permissions live there) plus settings/cli.json (activation). Codex CLI:
  // config.toml + hooks.json (the hook wiring) + rules/default.rules (permissions).
  if (harness === ".kiro") {
    const agentPath = join(projectDir, harness, "agents", "aidlc.json");
    results.push({
      pass: existsSync(agentPath),
      label: "agents/aidlc.json present (hook + permission wiring)",
      fix: "copy from `dist/kiro/.kiro/agents/aidlc.json`",
    });
    const cliSettingsPath = join(projectDir, harness, "settings", "cli.json");
    results.push({
      pass: existsSync(cliSettingsPath),
      label: "settings/cli.json present (workspace default-agent activation)",
      fix: "copy from `dist/kiro/.kiro/settings/cli.json` (or use `kiro-cli chat --agent aidlc`)",
    });
  } else if (harness === ".codex") {
    for (const [file, what, from] of [
      ["config.toml", "model/provider/sandbox config", "dist/codex/.codex/config.toml"],
      ["hooks.json", "hook wiring", "dist/codex/.codex/hooks.json"],
      ["rules/default.rules", "permission prefix rules", "dist/codex/.codex/rules/default.rules"],
    ] as const) {
      results.push({
        pass: existsSync(join(projectDir, harness, file)),
        label: `${file} present (${what})`,
        fix: `copy from \`${from}\``,
      });
    }
    // Minimum Codex version pin (G10): SubagentStart/Stop agent_type carries
    // the real role name only from 0.139.0 (hyphenated agent TOMLs resolve
    // without registration from the same release). Older versions degrade
    // SUBAGENT_COMPLETED attribution and the agent transposition contract.
    const MIN_CODEX = [0, 139, 0] as const;
    const codexVer = Bun.spawnSync(["codex", "--version"], { stdout: "pipe", stderr: "ignore" });
    const verText = (codexVer.stdout?.toString() ?? "").trim();
    const verMatch = verText.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!verMatch) {
      results.push({
        pass: false,
        label: "codex CLI on PATH",
        fix: "install Codex CLI >= 0.139.0 (https://developers.openai.com/codex)",
      });
    } else {
      const v = [Number(verMatch[1]), Number(verMatch[2]), Number(verMatch[3])];
      const ok =
        v[0] > MIN_CODEX[0] ||
        (v[0] === MIN_CODEX[0] &&
          (v[1] > MIN_CODEX[1] || (v[1] === MIN_CODEX[1] && v[2] >= MIN_CODEX[2])));
      results.push({
        pass: ok,
        label: `codex CLI version ${verMatch[0]} >= 0.139.0 (subagent attribution + agent TOML resolution)`,
        fix: "upgrade Codex CLI to 0.139.0 or later",
      });
    }
    // Hook trust pre-seed reminder (advisory pass-with-label): untrusted
    // project hooks never fire (the bypass flag does not run them either).
    results.push({
      pass: true,
      label:
        "hook trust: ensure [hooks.state] entries are pre-seeded in $CODEX_HOME/config.toml (`bun scripts/package.ts codex trust --project <dir>`) or run one TUI trust pass",
    });
  } else {
    const settingsPath = join(projectDir, harness, "settings.json");
    results.push({
      pass: existsSync(settingsPath),
      label: "settings.json present",
      fix: "copy from `dist/claude/.claude/settings.json`",
    });
  }

  // 4b. Dual-harness coexistence (D-11): another harness tree installed AND a
  // workflow active is supported-but-untested — warn (advisory pass with a
  // visible label), never block.
  const otherTrees = [".claude", ".kiro", ".codex"].filter(
    (h) => h !== harness && existsSync(join(projectDir, h, "tools", "aidlc-lib.ts")),
  );
  if (
    otherTrees.length > 0 &&
    existsSync(join(projectDir, harness, "tools", "aidlc-lib.ts")) &&
    existsSync(stateFilePath(projectDir))
  ) {
    results.push({
      pass: true,
      label: `Multi-harness install detected (${harness} + ${otherTrees.join(" + ")}) with an active workflow — supported but untested; keep all trees at the same framework version`,
    });
  }

  // 4a. AWS_AIDLC_DEFAULT_SCOPE env var — project-default scope from settings.json env.
  // Only observable inside a Claude Code session (where settings.json env is exposed
  // to Bash invocations). When doctor is invoked directly via bun, the env is unset
  // and we report "unset — no project default" as a pass.
  const envScope = (process.env.AWS_AIDLC_DEFAULT_SCOPE || "").trim();
  if (envScope === "") {
    results.push({
      pass: true,
      label: "AWS_AIDLC_DEFAULT_SCOPE (unset — no project default)",
    });
  } else if (validScopes().has(envScope)) {
    results.push({
      pass: true,
      label: `AWS_AIDLC_DEFAULT_SCOPE=${envScope} (valid)`,
    });
  } else {
    results.push({
      pass: false,
      label: `AWS_AIDLC_DEFAULT_SCOPE=${envScope} (invalid)`,
      fix: `valid values: ${[...validScopes()].join(", ")}`,
    });
  }

  // 4c. Plugin selection — doctor is a full-graph consumer. Runtime consumers
  // read the filtered graph, but doctor must verify the persisted enabled flags
  // still agree with tools/data/harness.json and that enabled stage files were
  // not lost by a torn select-plugins run.
  try {
    const selected = pluginsEnabled();
    const graphAll = loadStageGraphAll();
    const enabledStages = graphAll.filter((s) => s.enabled !== false);
    const counts = new Map<string, number>();
    for (const stage of enabledStages) {
      const owner = countOwner(stage);
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    const countText = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, count]) => `${owner}=${count}`)
      .join(", ");
    results.push({
      pass: true,
      label:
        selected === null
          ? `Enabled plugins: all enabled (no selection); enabled stage counts: ${countText}`
          : `Enabled plugins: ${[...selected].sort().join(", ")}; enabled stage counts: ${countText}`,
    });

    const disagreements: string[] = [];
    for (const stage of graphAll) {
      const expected = expectedEnabledBySelection(stage);
      const actual = stage.enabled !== false;
      if (expected !== actual) {
        disagreements.push(
          `${stage.slug}: expected ${expected ? "enabled" : "disabled"}, graph is ${actual ? "enabled" : "disabled"}`,
        );
      }
    }
    results.push({
      pass: disagreements.length === 0,
      label: disagreements.length === 0
        ? "Plugin selection flags: harness.json agrees with stage-graph.json"
        : `Plugin selection flags: ${disagreements.length} disagreement(s)`,
      fix: disagreements.length > 0
        ? `${disagreements.join("; ")} - run \`bun ${harnessDir()}/tools/aidlc-utility.ts select-plugins ${
            selected === null ? knownPluginNames().join(",") : [...selected].sort().join(",")
          }\` to recover`
        : undefined,
    });

    const graphSlugs = new Set(graphAll.map((s) => s.slug));
    const missingEnabled: string[] = [];
    const stagesRoot = join(TOOLS_DIR, "..", "aidlc-common", "stages");
    for (const phase of PHASES) {
      const dir = join(stagesRoot, phase);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
        const path = join(dir, f);
        try {
          const parsed = parseStageFrontmatter(readFileSync(path, "utf-8")) as Record<string, unknown>;
          const slug = typeof parsed.slug === "string" ? parsed.slug : f.replace(/\.md$/, "");
          const plugin = typeof parsed.plugin === "string" ? parsed.plugin : undefined;
          const stagePhase = typeof parsed.phase === "string" ? parsed.phase : phase;
          if (
            expectedEnabledBySelection({ plugin, phase: stagePhase }) &&
            !graphSlugs.has(slug)
          ) {
            missingEnabled.push(`${slug} (${path})`);
          }
        } catch (e) {
          if (selected !== null) {
            missingEnabled.push(
              `${f.replace(/\.md$/, "")} (${path}) - frontmatter parse failed: ${errorMessage(e)}`,
            );
          }
        }
      }
    }
    // Hard-fail ONLY under an active selection: there the missing node means a
    // torn select-plugins run (selection installs regenerate via select-plugins,
    // which compiles in-chain). Without a selection an uncompiled stage file is
    // deliberate authoring state - the pre-existing "Uncompiled stage files"
    // advisory row below owns that case as an exit-zero advisory.
    const torn = selected !== null && missingEnabled.length > 0;
    results.push({
      pass: !torn,
      label: missingEnabled.length === 0
        ? "Enabled stage compile coverage: every enabled stage file is in the full graph"
        : torn
          ? `Enabled stage compile coverage: ${missingEnabled.length} enabled stage file(s) missing from the full graph`
          : `Enabled stage compile coverage: ${missingEnabled.length} uncompiled stage file(s) - no selection active, see the Uncompiled stage files advisory`,
      fix: torn
        ? `${missingEnabled.join("; ")} - recover with \`bun ${harnessDir()}/tools/aidlc-utility.ts select-plugins ${
            [...(selected as ReadonlySet<string>)].sort().join(",")
          }\``
        : undefined,
    });

    // Active workflows stranded by the CURRENT selection (a selection written
    // before this guard existed, or a hand-edited harness.json): every /aidlc
    // on such a workflow hard-errors, so doctor must not stay green.
    if (selected !== null) {
      const stranded = activeWorkflowDependencyViolations(projectDir, selected);
      results.push({
        pass: stranded.length === 0,
        label: stranded.length === 0
          ? "Plugin selection vs active workflows: no stranded dependencies"
          : `Plugin selection vs active workflows: ${stranded.length} stranded dependency(ies)`,
        fix: stranded.length > 0
          ? `${stranded.join("; ")} - re-enable the plugin(s) with \`bun ${harnessDir()}/tools/aidlc-utility.ts select-plugins\`, or complete/park the workflow(s)`
          : undefined,
      });

      // Ordering edges the selection silently drops (an enabled stage's
      // requires_stage names a disabled stage). Legitimate in plugin-only
      // installs (plugin stages ordering after core ones), so ADVISORY - but
      // surfaced, or a surprising walk order has no explanation anywhere.
      const droppedEdges = selectionDroppedOrderingEdges(graphAll);
      if (droppedEdges.length > 0) {
        results.push({
          pass: true,
          label: `Selection-dropped ordering edges (advisory): ${droppedEdges.length} requires_stage edge(s) point at disabled stages - ${droppedEdges.join("; ")}`,
        });
      }
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Plugin selection: check failed",
      fix: errorMessage(e),
    });
  }

  // 5. Workspace shell ready (P4: no --init artifact to check). With auto-birth
  // there is no scaffolded aidlc-docs/ to verify; readiness is the SHIPPED SHELL
  // the user copies from dist/: the harness engine dir (.claude/.kiro/.codex)
  // present AND the default space's memory dir present (the source of truth the
  // native include resolves). When both are present the first /aidlc auto-births
  // with no ceremony; a missing piece means the dist/ copy was incomplete.
  const harnessEngineDir = join(projectDir, harnessDir());
  // Pin to the DEFAULT space explicitly: readiness is "did the dist/ shell copy
  // in?", and `default` is the always-shipped space. memoryDirFor() now follows
  // the active-space cursor, so pass DEFAULT_SPACE to keep this probe checking
  // the shipped baseline rather than a (possibly absent) switched-to space. The
  // harness includes are committed (generated-on-demand only for their pointer),
  // so their presence is not part of shell-readiness.
  const defaultMemoryDir = memoryDirFor(projectDir, DEFAULT_SPACE);
  const shellReady = existsSync(harnessEngineDir) && existsSync(defaultMemoryDir);
  results.push({
    pass: shellReady,
    label: `workspace shell ready (${harnessDir()}/ + aidlc/spaces/default/memory/)`,
    fix: `copy the workspace shell from \`dist/${harnessDir().replace(/^\./, "")}/\` into your project root`,
  });

  // 5a. Naming consistency for agent/scope files. Duplicate declared names are
  // loader corruption and fail through loadAgents()/validScopes(); stem/name
  // drift is recoverable authoring drift, so it is advisory and names the file.
  try {
    pushNamingAdvisory(
      results,
      "Agent",
      namingMismatches(agentsDir(), "Agent", (stem, name) => stem === name),
    );
  } catch (e) {
    results.push({
      pass: false,
      label: "Agent filename/name consistency: check failed",
      fix: errorMessage(e),
    });
  }
  try {
    pushNamingAdvisory(
      results,
      "Scope",
      namingMismatches(scopesDir(), "Scope", scopeFilenameMatchesDeclaredName),
    );
  } catch (e) {
    results.push({
      pass: false,
      label: "Scope filename/name consistency: check failed",
      fix: errorMessage(e),
    });
  }

  // 5b. Git submodules - an uninitialized submodule leaves its dir empty, so the
  // scanner would classify a submodule-only workspace greenfield and auto-skip
  // reverse-engineering. This ADVISORY row surfaces the state and the remedy.
  // pass:true always (an uninitialized submodule is a user-environment pre-flight
  // state, not framework breakage, and doctor's exit code feeds CI/scripts): the
  // detail lives in the LABEL because the renderer prints `fix` only on a FAILED
  // row (mirrors the intent-registry advisory).
  if (!existsSync(join(projectDir, ".gitmodules"))) {
    results.push({
      pass: true,
      label: "Submodules: no .gitmodules at workspace root",
    });
  } else {
    const submodules = scanSubmodules(projectDir);
    const uninit = submodules.filter((s) => !s.initialized);
    if (submodules.length === 0) {
      results.push({
        pass: true,
        label:
          "Submodules: .gitmodules present but no parseable submodule entries",
      });
    } else if (uninit.length === 0) {
      results.push({
        pass: true,
        label: `Submodules: ${submodules.length} declared, all initialized`,
      });
    } else {
      results.push({
        pass: true,
        label: `Submodules: ${submodules.length} declared, ${uninit.length} uninitialized (advisory) (${enumerateSubmodulePaths(uninit)}) - run \`${SUBMODULE_INIT_REMEDY}\` to fetch them so reverse-engineering can read the code`,
      });
    }
  }

  // 6. Hook heartbeats
  // Three states:
  //   (a) .aidlc-hooks-health/ missing entirely → fresh install, hooks haven't
  //       had a chance to fire yet. Pass with advisory label — not drift.
  //   (b) Directory exists but no .last files → hooks registered but have
  //       never fired. Genuine drift; fail.
  //   (c) Directory has .last files → hooks are working; pass with timestamps.
  const healthDir = hooksHealthDir(projectDir);
  const heartbeatEntries: string[] = [];
  const heartbeatDirExists = existsSync(healthDir);
  // A health dir that exists but carries NO hook-fired content is equivalent to
  // "not yet fired" (state a), not drift (state b). Besides the `.last`
  // heartbeats, the dir may hold purely-diagnostic files that no hook firing
  // produced: `hook-debug.log` (written by hookDebug under AIDLC_HOOK_DEBUG) and
  // `.first-fired` (the sensor-fire banner marker). If ONLY those exist, treat
  // it as fresh — otherwise enabling AIDLC_HOOK_DEBUG on a fresh install would
  // flip this check from PASS to a false drift FAIL for exactly the user trying
  // to diagnose hooks.
  let hasHookFiredContent = false;
  if (heartbeatDirExists) {
    try {
      const files = readdirSync(healthDir).filter((f) => f.endsWith(".last"));
      if (files.length > 0) hasHookFiredContent = true;
      for (const f of files) {
        try {
          const ts = readFileSync(join(healthDir, f), "utf-8").trim();
          const name = f.replace(".last", "");
          heartbeatEntries.push(`${name} ${ts}`);
        } catch {
          // skip unreadable
        }
      }
    } catch {
      // skip unreadable dir
    }
  }
  if (heartbeatEntries.length > 0) {
    // (c) hooks working
    results.push({
      pass: true,
      label: `Hooks last fired: ${heartbeatEntries.join(", ")}`,
    });
  } else if (!heartbeatDirExists || !hasHookFiredContent) {
    // (a) fresh install (dir absent) OR a debug-only dir with no heartbeats yet
    // — nothing to verify. Not drift.
    results.push({
      pass: true,
      label: "Hook heartbeats: not yet fired (first workflow stage will populate)",
    });
  } else {
    // (b) registered but never fired — genuine drift
    results.push({
      pass: false,
      label: "Hook heartbeat data",
      fix: "health dir exists but no hooks have fired — verify hooks are registered in settings.json",
    });
  }

  // 6b. Hook drop records. A hook that hit a non-fatal failure appends a line
  // to `<hook>.drops` in the health dir (recordHookDrop: ISO timestamp, TAB,
  // reason). Severity-split: a `[degraded]` line means something was silently
  // half-applied (a dropped plugin contribution, a failed recompile) and must
  // FAIL doctor so a CI gate catches it; everything else ([advisory] or
  // untagged, e.g. core recordHookDrop telemetry) is a PASSING advisory row -
  // a drop is telemetry about a PAST swallowed failure, and a failing row
  // would pin doctor's exit at 1 long after the cause was fixed. The compose
  // hook rewrites its .drops each run, so a fixed + re-composed install
  // self-clears a degraded drop. The advisory label carries count + last
  // timestamp per hook (detail lives in the LABEL because the renderer prints
  // `fix` only on a FAILED row); the newest line is the likeliest to be torn
  // (recordHookDrop fires under disk-full/EACCES), so only a timestamp-shaped
  // first token is shown, else a placeholder. Unlike the sibling probes this
  // one does NOT absorb read errors into the clean row: EACCES is exactly the
  // environment that produces drops, so an unreadable dir/file is named
  // rather than reported "none recorded".
  const advisoryEntries: string[] = [];
  let dropsUnreadable = 0;
  if (heartbeatDirExists) {
    try {
      const dropFiles = readdirSync(healthDir).filter((f) => f.endsWith(".drops"));
      for (const f of dropFiles) {
        try {
          const lines = readFileSync(join(healthDir, f), "utf-8")
            .split("\n")
            .filter((l) => l.trim().length > 0);
          if (lines.length === 0) continue;
          const hook = f.replace(".drops", "");
          const reasons = lines.map((l) => l.split("\t").slice(1).join(" "));
          const degraded = reasons.filter((r) => r.includes("[degraded]"));
          if (degraded.length > 0) {
            const last = reasons[reasons.length - 1].slice(0, 160);
            results.push({
              pass: false,
              label: `Hook drops (${hook}): ${degraded.length} degraded of ${lines.length}`,
              fix: `${hook} degraded silently - read ${join(healthDir, f)} (latest: ${last}); fix the cause and re-compose (the file self-clears on a clean run)`,
            });
          } else {
            const lastToken = lines[lines.length - 1].split("\t")[0].trim();
            const lastTs = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(lastToken)
              ? lastToken
              : "unparseable line";
            advisoryEntries.push(`${hook} x${lines.length} (last ${lastTs})`);
          }
        } catch {
          dropsUnreadable++;
        }
      }
    } catch {
      dropsUnreadable = -1; // whole dir unreadable
    }
  }
  if (dropsUnreadable !== 0) {
    results.push({
      pass: true,
      label:
        dropsUnreadable === -1
          ? "Hook drops: health dir unreadable (advisory) - check permissions on .aidlc-hooks-health/"
          : `Hook drops: ${dropsUnreadable} .drops file(s) unreadable (advisory)${advisoryEntries.length > 0 ? `; readable: ${advisoryEntries.join(", ")}` : ""} - check permissions on .aidlc-hooks-health/`,
    });
  } else if (advisoryEntries.length > 0) {
    results.push({
      pass: true,
      label: `Hook drops recorded (advisory): ${advisoryEntries.join(", ")} - a hook swallowed a failure and fail-opened; inspect the named .drops file(s) under .aidlc-hooks-health/ for the reasons, then delete them once investigated`,
    });
  } else {
    results.push({
      pass: true,
      label: "Hook drops: none recorded",
    });
  }

  // State / audit drift check — if latest audit event implies the state file
  // should be in a certain shape (e.g., Status=Completed after WORKFLOW_COMPLETED),
  // verify the state actually matches. Covers the rare case where audit-first
  // succeeded but the state write failed (disk full, permission lost mid-run).
  const stateMdPath = stateFilePath(projectDir);
  // Read across every per-clone audit shard (single shard in the common case).
  const auditAllShards = readAllAuditShards(projectDir);
  if (existsSync(stateMdPath) && auditAllShards.length > 0) {
    try {
      const auditContent = auditAllShards;
      const stateContent = readFileSync(stateMdPath, "utf-8");
      // Find last WORKFLOW_COMPLETED event
      const wcIdx = auditContent.lastIndexOf("**Event**: WORKFLOW_COMPLETED");
      if (wcIdx !== -1) {
        const status = stateContent.match(/^- \*\*Status\*\*:\s*(\S+)/m);
        if (status && status[1] !== "Completed") {
          results.push({
            pass: false,
            label: `State/audit drift: audit has WORKFLOW_COMPLETED but state Status=${status[1]}`,
            fix: "manually set Status=Completed in aidlc-state.md or restart the workflow",
          });
        } else {
          results.push({
            pass: true,
            label: "State matches last audit event (no drift)",
          });
        }
      }
    } catch {
      // Drift-check failure is non-fatal for doctor report
    }
  }

  // Leaked-lock probe (P3 reaper surface) — a wedged audit lock (owner process
  // dead, or stamp over the stale threshold) blocks every writer on its bucket.
  // Doctor detects it loudly and CLEARS it (clear=true) so a SIGKILL'd holder
  // doesn't poison the next run; a live, fresh holder is left alone.
  try {
    const leaks = detectLeakedLocks(projectDir, true);
    if (leaks.length === 0) {
      results.push({ pass: true, label: "Audit locks: none leaked" });
    } else {
      for (const leak of leaks) {
        results.push({
          pass: false,
          label: `Leaked audit lock on bucket "${leak.bucket}" (${leak.reason}${leak.ownerPid !== null ? `, pid ${leak.ownerPid}` : ""}) — cleared`,
          fix: "the stale lock was cleared automatically; re-run your /aidlc command",
        });
      }
    }
  } catch {
    // Lock-probe failure is non-fatal for the doctor report.
  }

  // State version check — current template adds Worktree Path, Bolt
  // Refs, and Practices Affirmed Timestamp fields. Older v6 state
  // files lack them, so setFieldStrict writes would throw at runtime.
  // Fail loud here with archive-and-reinit guidance per the framework's
  // pre-1.0 no-migration policy.
  if (existsSync(stateMdPath)) {
    try {
      const stateContent = readFileSync(stateMdPath, "utf-8");
      const versionMatch = stateContent.match(/^- \*\*State Version\*\*:\s*(\S+)/m);
      if (versionMatch === null) {
        results.push({
          pass: false,
          label: "state version readable",
          fix: "State Version field missing or unparseable in aidlc-state.md. Archive your workspace ('mv aidlc-docs aidlc-docs.v6-archive') and start a fresh workflow (describe what to build).",
        });
      } else if (versionMatch[1] !== "7") {
        results.push({
          pass: false,
          label: "state version current",
          fix: `v${versionMatch[1]} state detected. The framework does not ship user-visible migration support pre-1.0. Archive your workspace ('mv aidlc-docs aidlc-docs.v${versionMatch[1]}-archive') and start a fresh workflow (describe what to build) to get a current-template workspace. The current template adds Worktree Path, Bolt Refs, and Practices Affirmed Timestamp fields used by Construction worktrees and practices-discovery.`,
        });
      } else {
        results.push({
          pass: true,
          label: "State Version: 7",
        });
      }
    } catch {
      // State-version check failure is non-fatal for doctor report
    }
  }

  // Orphaned compose-marker probe: a read-only tripwire. The conductor writes
  // the compose marker before an in-flight compose gate and deletes it on
  // resolve; the Stop hook treats a FRESH marker as a carve-out (the turn may
  // end at the gate). A crash between write and resolve can leave the marker on
  // disk, so doctor reports a present marker with its age and the remediation
  // (delete it if no compose gate is actually pending). Pass/fail follows the
  // shared freshness window: a FRESH marker is the normal state while a compose
  // gate is legitimately open (written before the gate, deleted on resolve), so
  // it renders as an advisory pass (running doctor in a second terminal during
  // a live gate must not exit 1 on a healthy workspace). Only a STALE marker
  // (older than the TTL, i.e. an orphan the Stop hook has begun ignoring) is a
  // fault. Silent when absent (no marker means nothing to report). Read-only:
  // doctor never deletes it (the Stop hook is the janitor for a stale one).
  try {
    const composeMarker = composeMarkerPath(projectDir);
    if (existsSync(composeMarker)) {
      const ageMs = Date.now() - statSync(composeMarker).mtimeMs;
      const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
      const ageLabel = ageHours >= 1 ? `${ageHours}h old` : "under 1h old";
      const stale = ageMs > COMPOSE_MARKER_TTL_MS;
      const staleLabel = stale ? ", stale" : ", fresh";
      results.push({
        pass: !stale,
        label: `Compose marker present (aidlc/.aidlc-compose-pending, ${ageLabel}${staleLabel})`,
        fix: "if no in-flight compose gate is actually pending, delete it ('rm aidlc/.aidlc-compose-pending') or resolve the pending gate. A stale marker no longer disables the Stop hook, but it should not linger.",
      });
    }
  } catch {
    // Compose-marker probe failure is non-fatal for the doctor report.
  }

  // ===========================================================================
  // Reconciliation checks
  //
  // Doctor's role: read-only reconciliation against on-disk state, audit, and
  // git for the worktree / state-fork / audit-fork / practices surfaces. Each
  // check anchors on a specific drift class:
  //
  //   Check 1 — orphan worktrees       (cleanup-orphan, BOLT_FAILED rows)
  //   Check 2 — stale branches         (git branch -l 'bolt-*')
  //   Check 3 — orphan state files     (STATE_FORKED slug-tag)
  //   Check 4 — orphan audit drift     (AUDIT_FORKED, PRACTICES_OVERRIDE)
  //   Check 5 — practices staleness    (Practices Affirmed Timestamp)
  //   Check 6 — MERGE_DISPATCH advisory (LLM-dispatch reconciliation)
  //
  // Two surfaces deferred to a future release:
  //   - orphan `Merge-Held: true` reconciliation (graph traversal, not a
  //     check; needs workshop-resume false-positive guard)
  //   - workshop `git ls-remote origin "bolt-*"` stale-claim detection
  //     (remote-aware doctor, composes with future designer offline-mode)
  // ===========================================================================

  const auditMd = auditAllShards;
  const stateMd = existsSync(stateMdPath) ? readFileSync(stateMdPath, "utf-8") : "";
  const boltRefs = stateMd
    ? parseRefsList(getField(stateMd, "Bolt Refs") ?? "")
    : [];

  // Helper: extract the Bolt slug from an audit block. Returns null if absent.
  const blockBoltSlug = (block: string): string | null => {
    const m = block.match(/^\*\*Bolt slug\*\*:\s*(\S+)/m);
    return m ? m[1] : null;
  };

  // Helper: extract a named field value from an audit block.
  const blockField = (block: string, field: string): string | null => {
    const re = new RegExp(`^\\*\\*${escapeRegex(field)}\\*\\*:\\s*(.+)$`, "m");
    const m = block.match(re);
    return m ? m[1].trim() : null;
  };

  // Helper: was a slug terminated (worktree merged or discarded) in audit?
  const slugTerminated = (slug: string): boolean => {
    if (
      findAllEvents(auditMd, "WORKTREE_MERGED", slug).length > 0 ||
      findAllEvents(auditMd, "WORKTREE_DISCARDED", slug).length > 0
    ) {
      return true;
    }
    return false;
  };

  // ---------------------------------------------------------------------------
  // Check 1 — Orphan worktrees
  //
  // Walk `.aidlc/worktrees/bolt-*/` directories on disk; cross-reference each
  // against:
  //   (a) main state's Bolt Refs (active fork → ✓)
  //   (b) audit WORKTREE_DISCARDED / WORKTREE_MERGED (terminated → orphan dir)
  //   (c) ERROR_LOGGED rows with [merge-succeeded:<sha>] tag (cleanup-orphan
  //       after a successful merge)
  //
  // Reports `0 worktrees observed` with pass=true when the directory is empty
  // or absent — the issue 75 line 215 "fail-clean on no-worktrees" guarantee.
  // ---------------------------------------------------------------------------
  try {
    const worktreesDir = join(projectDir, ".aidlc", "worktrees");
    let observed = 0;
    let activeForks = 0;
    let preservedByAbort = 0;
    const orphanActive: string[] = []; // dir present but no audit/Bolt Refs trail
    const cleanupOrphans: string[] = []; // dir present, merge succeeded, cleanup failed

    // Helper: did this slug get aborted via `aidlc-bolt abort` (BOLT_FAILED
    // with `Reason: aborted` from multi-failure halt-and-ask)?
    // Default-path abort preserves the worktree, so the slug remains in
    // Bolt Refs but it's not "in flight" — it's awaiting /aidlc --resume.
    // Doctor output distinguishes "3 active forks (in flight)" from "3
    // preserved-by-abort (awaiting resume)".
    const isAbortedSlug = (slug: string): boolean => {
      return findAllEvents(auditMd, "BOLT_FAILED", slug).some((b) => {
        const reason = blockField(b.block, "Reason") ?? "";
        return reason === "aborted";
      });
    };

    if (existsSync(worktreesDir)) {
      for (const entry of readdirSync(worktreesDir)) {
        if (!entry.startsWith("bolt-")) continue;
        const slug = entry.slice("bolt-".length);
        if (validateBoltSlug(slug) !== null) continue;
        observed++;

        // Active fork — slug is in main state's Bolt Refs. Expected; not orphan.
        // Sub-classify into "preserved-by-abort" (BOLT_FAILED Reason: aborted
        // exists for the slug — the user aborted multi-failure AUQ at index k
        // and these dirs are awaiting /aidlc --resume) vs "in flight".
        if (boltRefs.includes(slug)) {
          if (isAbortedSlug(slug)) {
            preservedByAbort++;
          } else {
            activeForks++;
          }
          continue;
        }

        // Cleanup-orphan: a WORKTREE_MERGED landed (or ERROR_LOGGED carries
        // [merge-succeeded:<sha>] on a post-merge cleanup failure) but the
        // directory persists. The worktree primitive guarantees the tag.
        const errBlocks = findAllEvents(auditMd, "ERROR_LOGGED");
        const matchesMergeSucceeded = errBlocks.some((b) => {
          const tag = b.block.match(MERGE_SUCCEEDED_TAG_REGEX);
          if (!tag) return false;
          const slugTag = b.block.match(SLUG_TAG_REGEX);
          return slugTag !== null && slugTag[1] === slug;
        });
        if (matchesMergeSucceeded || findAllEvents(auditMd, "WORKTREE_MERGED", slug).length > 0) {
          cleanupOrphans.push(slug);
          continue;
        }
        if (findAllEvents(auditMd, "WORKTREE_DISCARDED", slug).length > 0) {
          // Terminated explicitly via discard but directory persists — discard
          // failed mid-cleanup. Surface so the operator can `rm -rf` manually.
          cleanupOrphans.push(slug);
          continue;
        }
        orphanActive.push(slug);
      }
    }

    const pass = orphanActive.length === 0 && cleanupOrphans.length === 0;
    let label: string;
    let fix: string | undefined;
    if (observed === 0) {
      label = "Orphan worktrees: 0 observed";
    } else if (pass) {
      const segments: string[] = [];
      if (activeForks > 0) segments.push(`${activeForks} active fork${activeForks === 1 ? "" : "s"}`);
      if (preservedByAbort > 0) segments.push(`${preservedByAbort} preserved-by-abort (awaiting resume)`);
      label = `Orphan worktrees: 0 (${segments.join(", ")})`;
    } else {
      const parts: string[] = [];
      if (orphanActive.length > 0) {
        parts.push(`${orphanActive.length} unmatched (no audit trail): ${orphanActive.join(", ")}`);
      }
      if (cleanupOrphans.length > 0) {
        parts.push(
          `${cleanupOrphans.length} cleanup-orphan${cleanupOrphans.length === 1 ? "" : "s"} (merge/discard landed, dir persists): ${cleanupOrphans.join(", ")}`,
        );
      }
      label = `Orphan worktrees: ${orphanActive.length + cleanupOrphans.length} drift`;
      fix = `${parts.join("; ")}. Inspect and remove via 'aidlc-worktree discard --slug <slug>' or 'rm -rf .aidlc/worktrees/bolt-<slug>'.`;
    }
    results.push({ pass, label, fix });
  } catch (e) {
    results.push({
      pass: false,
      label: "Orphan worktrees: check failed",
      fix: errorMessage(e),
    });
  }

  // ---------------------------------------------------------------------------
  // Check 2 — Stale branches
  //
  // Walk `git branch --list 'bolt-*'`; flag any `bolt-<slug>` branch whose
  // worktree directory is gone but no terminal WORKTREE_DISCARDED or
  // WORKTREE_MERGED audit row landed for that slug.
  //
  // Skips branches that aren't valid Bolt slugs — e.g. user-created
  // `bolt-experiment` outside the framework. Skips silently when not a git
  // repo (smoke / fresh fixtures) so doctor remains usable in non-git contexts.
  // ---------------------------------------------------------------------------
  try {
    const proc = Bun.spawnSync({
      cmd: ["git", "-C", projectDir, "branch", "--list", "bolt-*"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      // Not a git repo or git failure — skip silently with informational pass.
      results.push({ pass: true, label: "Stale branches: 0 observed (not a git repo)" });
    } else {
      const stdout = new TextDecoder().decode(proc.stdout);
      const branchSlugs: string[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.replace(/^\*?\s+/, "").trim();
        if (!trimmed.startsWith("bolt-")) continue;
        const slug = trimmed.slice("bolt-".length);
        if (validateBoltSlug(slug) !== null) continue;
        branchSlugs.push(slug);
      }

      const stale: string[] = [];
      for (const slug of branchSlugs) {
        const wtDir = worktreePath(projectDir, slug);
        if (existsSync(wtDir)) continue; // worktree intact — branch is live
        // Worktree gone — needs a terminal audit row to be legitimate.
        if (slugTerminated(slug)) continue;
        stale.push(slug);
      }

      if (stale.length === 0) {
        results.push({
          pass: true,
          label: `Stale branches: 0 (${branchSlugs.length} bolt-* observed)`,
        });
      } else {
        results.push({
          pass: false,
          label: `Stale branches: ${stale.length} drift`,
          fix: `branches ${stale.join(", ")} have no worktree directory and no WORKTREE_MERGED/_DISCARDED audit row. Delete via 'git branch -D bolt-<slug>' if abandoned.`,
        });
      }
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Stale branches: check failed",
      fix: errorMessage(e),
    });
  }

  // ---------------------------------------------------------------------------
  // Check 3 — Orphan state files (paired with STATE_FORKED slug-tag)
  //
  // Walk `.aidlc/worktrees/*/aidlc-docs/aidlc-state.md`; each found state file
  // must map to a slug in main's Bolt Refs (active fork) OR pair with a
  // WORKTREE_DISCARDED audit row (pre-discard). Anything else is post-fork
  // drift — STATE_FORKED emitted, slug added to Bolt Refs, but state-write or
  // STATE_MERGED never landed.
  // ---------------------------------------------------------------------------
  try {
    const worktreesDir = join(projectDir, ".aidlc", "worktrees");
    const orphan: string[] = [];
    let observed = 0;

    if (existsSync(worktreesDir)) {
      for (const entry of readdirSync(worktreesDir)) {
        if (!entry.startsWith("bolt-")) continue;
        const slug = entry.slice("bolt-".length);
        if (validateBoltSlug(slug) !== null) continue;
        const wtStatePath = worktreeStateFilePath(join(worktreesDir, entry));
        if (!existsSync(wtStatePath)) continue;
        observed++;
        if (boltRefs.includes(slug)) continue;
        if (findAllEvents(auditMd, "WORKTREE_DISCARDED", slug).length > 0) continue;
        orphan.push(slug);
      }
    }

    if (orphan.length === 0) {
      results.push({
        pass: true,
        label: observed === 0
          ? "Orphan state files: 0 observed"
          : `Orphan state files: 0 (${observed} active)`,
      });
    } else {
      results.push({
        pass: false,
        label: `Orphan state files: ${orphan.length} drift`,
        fix: `state files for ${orphan.join(", ")} exist but slug not in Bolt Refs and no WORKTREE_DISCARDED row. Recover via 'aidlc-worktree discard --slug <slug>' (idempotent).`,
      });
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Orphan state files: check failed",
      fix: errorMessage(e),
    });
  }

  // ---------------------------------------------------------------------------
  // Check 4 — Orphan audit drift (3 sub-cases)
  //
  // Sub-case (a): AUDIT_FORKED-without-disk-state — main has AUDIT_FORKED but
  //   <wtPath>/aidlc-docs/audit.md is absent on disk.
  // Sub-case (b): orphan-delta — main has AUDIT_FORKED but no matching
  //   AUDIT_MERGED for an unterminated, non-active slug.
  // Sub-case (c): PRACTICES_OVERRIDE Reason filter — write-failure-* rows
  //   without a following PRACTICES_AFFIRMED are flagged as orphan; rows
  //   carrying Reason: bolt-plan-marker-conflict are expected behaviour and
  //   ignored. audit-format.md:138 anchors the discriminator routing.
  //
  // Sub-case (c) shares the orphan-audit umbrella because both classes ride
  // the same audit-walker pass; per plan-v3 §51, this is one Check, not two.
  // ---------------------------------------------------------------------------
  try {
    const forkedDriftDisk: string[] = []; // (a)
    const forkedDriftMerge: string[] = []; // (b)
    const overrideDrift: string[] = []; // (c)

    const forks = findAllEvents(auditMd, "AUDIT_FORKED");
    for (const fork of forks) {
      const slug = blockBoltSlug(fork.block);
      if (!slug) continue;
      // Terminal short-circuits run BEFORE the disk check. A successfully
      // merged-and-cleaned Bolt has AUDIT_MERGED + WORKTREE_MERGED in main
      // audit and the worktree directory removed by `aidlc-worktree merge`'s
      // cleanup — without the short-circuit, sub-case (a) would flag every
      // healthy historical AUDIT_FORKED as drift forever. Same logic for
      // active forks (still in flight) and explicit discards.
      if (findAllEvents(auditMd, "AUDIT_MERGED", slug).length > 0) continue;
      if (boltRefs.includes(slug)) continue;
      if (findAllEvents(auditMd, "WORKTREE_DISCARDED", slug).length > 0) continue;
      // Sub-case (a): no terminal pairing — is the worktree audit on disk?
      // If yes, we're mid-fork (orphan-delta — sub-case b). If no, the fork
      // emitted but disk copy never landed.
      const wtAudit = worktreeAuditFilePath(worktreePath(projectDir, slug));
      if (!existsSync(wtAudit)) {
        forkedDriftDisk.push(slug);
        continue;
      }
      // Sub-case (b): disk audit landed but no AUDIT_MERGED — orphan-delta.
      forkedDriftMerge.push(slug);
    }

    // Sub-case (c): PRACTICES_OVERRIDE Reason filter.
    let unknownReasonCount = 0;
    const overrides = findAllEvents(auditMd, "PRACTICES_OVERRIDE");
    for (const o of overrides) {
      const reason = blockField(o.block, "Reason") ?? "";
      // bolt-plan-marker-conflict is expected behaviour (orchestrator override
      // per team practices) — skip per audit-format.md routing.
      if (reason.startsWith("bolt-plan-marker-conflict")) continue;
      // write-failure-* rows are practices-promote failures. Orphan if no
      // following PRACTICES_AFFIRMED row; matched-pair otherwise. Compare
      // timestamps via Date.parse — ISO 8601 strings only sort lexicographically
      // when in identical format, but `2026-05-19T11:00:00.123Z` sorts before
      // `2026-05-19T11:00:00Z` (`.` 0x2E < `Z` 0x5A) and `Z` vs `+00:00` shapes
      // also break naive string compare. Date.parse normalises both to ms.
      if (reason.startsWith("write-failure")) {
        const overrideMs = Date.parse(o.timestamp);
        const affirmAfter = findAllEvents(auditMd, "PRACTICES_AFFIRMED").some(
          (a) => {
            const am = Date.parse(a.timestamp);
            return Number.isFinite(am) && am > overrideMs;
          },
        );
        if (!affirmAfter) {
          overrideDrift.push(`${reason}@${o.timestamp}`);
        }
        continue;
      }
      // Reason value matched neither prefix — track for follow-up. Future
      // PRACTICES_OVERRIDE Reason variants may need their own routing rule;
      // doctor surfaces the count for later reconciliation.
      unknownReasonCount++;
    }

    const total = forkedDriftDisk.length + forkedDriftMerge.length + overrideDrift.length;
    if (total === 0) {
      const reconciled = forks.length + overrides.length - unknownReasonCount;
      let label: string;
      if (reconciled === 0) {
        label = "Orphan audit: 0 observed";
      } else {
        label = `Orphan audit: 0 (${reconciled} reconciled)`;
      }
      if (unknownReasonCount > 0) {
        label += `; ${unknownReasonCount} PRACTICES_OVERRIDE row(s) with unknown Reason — track for follow-up`;
      }
      results.push({ pass: true, label });
    } else {
      const parts: string[] = [];
      if (forkedDriftDisk.length > 0) parts.push(`${forkedDriftDisk.length} AUDIT_FORKED-without-disk: ${forkedDriftDisk.join(", ")}`);
      if (forkedDriftMerge.length > 0) parts.push(`${forkedDriftMerge.length} orphan-delta (no AUDIT_MERGED): ${forkedDriftMerge.join(", ")}`);
      if (overrideDrift.length > 0) parts.push(`${overrideDrift.length} PRACTICES_OVERRIDE write-failure(s) without follow-up PRACTICES_AFFIRMED`);
      if (unknownReasonCount > 0) parts.push(`${unknownReasonCount} PRACTICES_OVERRIDE row(s) with unknown Reason`);
      results.push({
        pass: false,
        label: `Orphan audit: ${total} drift`,
        fix: parts.join("; "),
      });
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Orphan audit: check failed",
      fix: errorMessage(e),
    });
  }

  // ---------------------------------------------------------------------------
  // Check 5 — Practices staleness
  //
  // Read `Practices Affirmed Timestamp` from main state. Compare to now.
  // Empty / missing → informational pass (never affirmed). Within 90 days → ✓.
  // Older → advisory pass=true (does NOT fail exit code; mirrors heartbeat
  // and state/audit drift advisory pattern at aidlc-utility.ts:421-466).
  // Invalid ISO timestamp → fail readable.
  // ---------------------------------------------------------------------------
  try {
    if (!stateMd) {
      results.push({ pass: true, label: "Practices staleness: state file absent (informational)" });
    } else {
      const value = (getField(stateMd, "Practices Affirmed Timestamp") ?? "").trim();
      if (value === "" || value.startsWith("[")) {
        // Empty placeholder OR `[ISO 8601 timestamp on affirmation]` template
        // string that hasn't been replaced by practices-promote yet.
        results.push({ pass: true, label: "Practices staleness: never affirmed (informational)" });
      } else {
        const affirmed = Date.parse(value);
        if (Number.isNaN(affirmed)) {
          results.push({
            pass: false,
            label: "Practices staleness: timestamp unreadable",
            fix: `Practices Affirmed Timestamp value "${value}" is not a valid ISO 8601 datetime. Re-run practices-discovery (stage 2.2) to re-affirm.`,
          });
        } else {
          const ageDays = Math.floor((Date.now() - affirmed) / (1000 * 60 * 60 * 24));
          if (ageDays < 0) {
            // Future-dated timestamp — clock skew or hand-edit. Advisory pass
            // so doctor doesn't fail loud, but surfaces the anomaly.
            results.push({
              pass: true,
              label: `Practices staleness: affirmed in the future (clock skew or hand-edited timestamp ${Math.abs(ageDays)} day${Math.abs(ageDays) === 1 ? "" : "s"} ahead)`,
            });
          } else if (ageDays <= PRACTICES_STALENESS_DAYS) {
            results.push({
              pass: true,
              label: `Practices staleness: affirmed ${ageDays} day${ageDays === 1 ? "" : "s"} ago`,
            });
          } else {
            results.push({
              pass: true,
              label: `Practices staleness: affirmed ${ageDays} days ago (advisory — > ${PRACTICES_STALENESS_DAYS} days; consider re-running practices-discovery)`,
            });
          }
        }
      }
    }
  } catch {
    // Practices-staleness check failure is non-fatal for doctor report
  }

  // ---------------------------------------------------------------------------
  // Check 6 — MERGE_DISPATCH advisory
  //
  // Walk MERGE_DISPATCH_INVOKED rows; an INVOKED row should pair with either
  // _RETURNED or _FALLBACK for the same slug within MERGE_DISPATCH_TIMEOUT_SEC.
  // Orphan INVOKED rows are reported as advisory (pass=true) — observation-
  // time drift on an in-memory LLM dispatch is not a fail-loud condition. A
  // future observer layer may take over this reconciliation.
  //
  // No correlation tag — slug + timestamp window is sufficient for doctor
  // reconciliation (the LLM call has no disk artifact to anchor against).
  // ---------------------------------------------------------------------------
  try {
    const invokedRows = findAllEvents(auditMd, "MERGE_DISPATCH_INVOKED");
    let orphans = 0;
    const now = Date.now();
    // Pair-match per slug: each terminal row (RETURNED or FALLBACK) consumed
    // by at most one preceding INVOKED. Without consumption tracking, two
    // consecutive INVOKED + 1 RETURNED for the same slug would report 0
    // orphans because `.some(r >= invokedTs)` is satisfied by ANY later
    // terminal, not the next-unmatched one.
    const invokedBySlug = new Map<string, number[]>(); // slug → INVOKED timestamps (ms)
    for (const inv of invokedRows) {
      const slug = blockBoltSlug(inv.block);
      if (!slug) continue;
      const invokedMs = Date.parse(inv.timestamp);
      if (Number.isNaN(invokedMs)) continue;
      const list = invokedBySlug.get(slug) ?? [];
      list.push(invokedMs);
      invokedBySlug.set(slug, list);
    }
    for (const [slug, invokedList] of invokedBySlug) {
      invokedList.sort((a, b) => a - b);
      // Build a chronological list of terminal events (RETURNED + FALLBACK)
      // for this slug, then consume each in pair order with the earliest
      // not-yet-paired INVOKED that precedes it.
      const terminals: number[] = [];
      for (const r of findAllEvents(auditMd, "MERGE_DISPATCH_RETURNED", slug)) {
        const ms = Date.parse(r.timestamp);
        if (Number.isFinite(ms)) terminals.push(ms);
      }
      for (const f of findAllEvents(auditMd, "MERGE_DISPATCH_FALLBACK", slug)) {
        const ms = Date.parse(f.timestamp);
        if (Number.isFinite(ms)) terminals.push(ms);
      }
      terminals.sort((a, b) => a - b);
      const consumed = new Array<boolean>(terminals.length).fill(false);
      for (const invokedMs of invokedList) {
        // Active session within the timeout window — still in flight, skip.
        if (now - invokedMs < MERGE_DISPATCH_TIMEOUT_SEC * 1000) continue;
        // Find the first not-yet-consumed terminal at or after invokedMs.
        let matched = false;
        for (let i = 0; i < terminals.length; i++) {
          if (consumed[i]) continue;
          if (terminals[i] < invokedMs) continue;
          consumed[i] = true;
          matched = true;
          break;
        }
        if (!matched) orphans++;
      }
    }
    results.push({
      pass: true,
      label: orphans === 0
        ? `MERGE_DISPATCH: 0 orphan INVOKED (${invokedRows.length} bracketed)`
        : `MERGE_DISPATCH: ${orphans} orphan INVOKED (advisory — LLM dispatch unmatched after ${MERGE_DISPATCH_TIMEOUT_SEC}s)`,
    });
  } catch {
    // MERGE_DISPATCH check failure is non-fatal for doctor report
  }

  // --- Graph-level checks (library-direct, no subprocess) ---

  // Cycle detection — findCycles returns [] on a healthy DAG
  try {
    const cycles = findCycles(loadGraph());
    results.push({
      pass: cycles.length === 0,
      label: cycles.length === 0
        ? "Cycle detection: 0 cycles"
        : `Cycle detection: ${cycles.length} cycle(s) found`,
      fix: cycles.length > 0
        ? `cycles: ${cycles.map((c) => c.join(" → ")).join("; ")}`
        : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Cycle detection: graph load failed",
      fix: errorMessage(e),
    });
  }

  // Stage-graph <-> disk drift, both directions (stageGraphDrift()):
  //   - graph->disk (missingFiles): a slug in stage-graph.json with no
  //     <phase>/<slug>.md on disk. Real runtime breakage (conductor handed a
  //     path to a missing file) -> hard FAIL.
  //   - disk->graph (uncompiledStages): a <phase>/<slug>.md whose slug is absent
  //     from the compiled graph. The runtime resolves stages from the compiled
  //     graph only, so the file is silently never executed. The file is inert,
  //     not corrupt, and recompiling is a deliberate authoring act -> ADVISORY
  //     (pass:true; does not fail the doctor exit code, mirroring
  //     the rule-drift / MERGE_DISPATCH advisory rows).
  try {
    const { missingFiles, uncompiledStages, graphCount } = stageGraphDrift();
    results.push({
      pass: missingFiles.length === 0,
      label: missingFiles.length === 0
        ? `Orphan stage files: ${graphCount} graph entries all have files`
        : `Orphan stage files: ${missingFiles.length} graph entries have no file on disk`,
      fix: missingFiles.length > 0 ? `missing files: ${missingFiles.join(", ")}` : undefined,
    });
    // Advisory row (pass:true), the detail must live in the LABEL, not the
    // `fix` field: the report renderer only prints `fix` on a FAILED (pass:false)
    // row (see the render loop below). Fold the slug list + the compile hint into
    // the label so the operator can act on it, mirroring the MERGE_DISPATCH /
    // rule-drift advisory rows that carry their detail inline.
    results.push({
      pass: true,
      label: uncompiledStages.length === 0
        ? "Uncompiled stage files: 0 stage files missing from the compiled graph"
        : `Uncompiled stage files: ${uncompiledStages.length} stage file(s) not in the compiled graph (advisory, will not execute until recompiled): ${uncompiledStages.join(", ")} - run \`bun ${harnessDir()}/tools/aidlc-graph.ts compile\` to include them`,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Orphan stage files: check failed",
      fix: errorMessage(e),
    });
  }

  // Scope validation — run validateScope over all 9 scopes, tally errors
  // and advisories. Repo-level setup check, not workflow-state.
  try {
    const scopes = [...validScopes()];
    let totalErrors = 0;
    let totalAdvisories = 0;
    const failingScopes: { scope: string; errors: string[] }[] = [];
    for (const scope of scopes) {
      const r = validateScope(scope);
      totalAdvisories += r.advisories.length;
      if (r.errors.length > 0) {
        totalErrors += r.errors.length;
        failingScopes.push({ scope, errors: r.errors });
      }
    }
    results.push({
      pass: totalErrors === 0,
      label: totalErrors === 0
        ? `Scope validation: ${scopes.length} scopes valid (${totalAdvisories} advisories)`
        : `Scope validation: ${failingScopes.length} of ${scopes.length} scopes have errors`,
      fix: totalErrors > 0
        ? failingScopes.map((f) => `${f.scope}: ${f.errors.join("; ")}`).join(" | ")
        : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Scope validation: check failed",
      fix: errorMessage(e),
    });
  }

  // Schema validation — parse + validate every stage's YAML frontmatter.
  // Uses the same library functions every other caller does; drift impossible.
  // Tracks attempted vs valid separately so the label can't silently say
  // "N/N valid" when files are missing (that's the orphan-files check's job).
  try {
    const stagesDir = join(TOOLS_DIR, "..", "aidlc-common", "stages");
    const graph = loadStageGraphAll();
    const agentSlugs = loadAgents().map((a) => a.slug);
    const schemaFails: { slug: string; errors: string[] }[] = [];
    let attempted = 0;
    for (const stage of graph) {
      const filePath = join(stagesDir, stage.phase, `${stage.slug}.md`);
      if (!existsSync(filePath)) continue; // orphan-files check handles this
      attempted++;
      const raw = readFileSync(filePath, "utf-8");
      try {
        const parsed = parseStageFrontmatter(raw);
        // Initialization stages lead with the orchestrator (SKILL.md itself),
        // not a .claude/agents/ file — skip agent cross-reference there.
        // Matches t65's convention. This phase-based skip agrees with the
        // compile guard's RESERVED_AGENT_SLUG exemption on the shipped graph
        // (the 3 orchestrator-led stages ARE the 3 initialization stages);
        // the compile guard is slug-precise, this is phase-coarse — both
        // correct for their purpose.
        const ctx = stage.phase === "initialization" ? undefined : { agents: agentSlugs };
        const vr = validateStageFrontmatter(parsed, ctx);
        if (!vr.valid) schemaFails.push({ slug: stage.slug, errors: vr.errors });
      } catch (parseErr) {
        schemaFails.push({ slug: stage.slug, errors: [errorMessage(parseErr)] });
      }
    }
    const valid = attempted - schemaFails.length;
    results.push({
      pass: schemaFails.length === 0,
      label: schemaFails.length === 0
        ? `Schema validation: ${valid}/${attempted} stages validated`
        : `Schema validation: ${schemaFails.length} of ${attempted} stage(s) failed`,
      fix: schemaFails.length > 0
        ? schemaFails.map((f) => `${f.slug}: ${f.errors[0]}`).join("; ")
        : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Schema validation: check failed",
      fix: errorMessage(e),
    });
  }

  // Graph references — every consumes[].artifact and requires_stage[] slug
  // must resolve to something real. Catches typos that pure schema-lint
  // and scope-walk both miss.
  try {
    const graph = loadStageGraphAll();
    const allSlugs = new Set(graph.map((s) => s.slug));
    const allArtifacts = artifactsRegistryFor(graph as unknown as readonly GraphStage[]);
    const refFails: string[] = [];
    for (const stage of graph) {
      for (const c of stage.consumes ?? []) {
        if (!allArtifacts.has(c.artifact)) {
          refFails.push(`${stage.slug}: consumes unknown artifact "${c.artifact}"`);
        }
      }
      for (const r of stage.requires_stage ?? []) {
        if (!allSlugs.has(r)) {
          refFails.push(`${stage.slug}: requires_stage unknown slug "${r}"`);
        }
      }
    }
    results.push({
      pass: refFails.length === 0,
      label: refFails.length === 0
        ? `Graph references: ${allArtifacts.size} artifacts + edges resolved`
        : `Graph references: ${refFails.length} broken reference(s)`,
      fix: refFails.length > 0 ? refFails.join("; ") : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Graph references: check failed",
      fix: errorMessage(e),
    });
  }

  // Keyword overlap — no keyword should be claimed by >1 scope. A conflict
  // means /aidlc "<freeform>" has ambiguous scope routing, which silently
  // burns artifacts. findScopeByKeyword (exported from this file) resolves
  // the other direction; this check inverts it to scan for collisions.
  try {
    const keywordToScopes = new Map<string, string[]>();
    const mapping = loadScopeMapping();
    for (const [scope, def] of Object.entries(mapping)) {
      for (const kw of def.keywords ?? []) {
        const list = keywordToScopes.get(kw) ?? [];
        list.push(scope);
        keywordToScopes.set(kw, list);
      }
    }
    const conflicts = [...keywordToScopes.entries()].filter(
      ([, scopes]) => scopes.length > 1
    );
    results.push({
      pass: conflicts.length === 0,
      label: conflicts.length === 0
        ? "Keyword overlap: no conflicts"
        : `Keyword overlap: ${conflicts.length} conflict(s)`,
      fix: conflicts.length > 0
        ? conflicts
            .map(([kw, scopes]) => `"${kw}" claimed by ${scopes.join(", ")}`)
            .join("; ")
        : undefined,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Keyword overlap: check failed",
      fix: errorMessage(e),
    });
  }

  // Rule drift (advisory, always pass:true) — surface team/project rule files
  // whose `##` headings overlap a POPULATED heading in the org layer
  // (aidlc/spaces/default/memory/org.md), quoting the org sentence inline so
  // the orchestrator-LLM can review for contradiction at observation time. A
  // learning is a practice (vision §6) — it lands in team.md / project.md, so
  // those two scopes are the whole team/project surface the walk reads.
  //
  // Three-concerns seam (T2): doctor is a deterministic tool — it detects
  // same-heading structural overlap (byte-reproducible), NOT semantic
  // contradiction. The contradiction VERDICT is the orchestrator-LLM's at
  // observation time, non-blocking. The row never fails the health check.
  //
  // Read seam: heading bodies come from loadRules().headings (surfaced from
  // the same `raw` loadRules reads under rulesDir(), honouring
  // AIDLC_RULES_DIR), never a second read from the relative .path.
  try {
    const rules = loadRules();
    const org = rules.find(
      (r) => r.scope === "org" && r.path.endsWith("org.md")
    );
    if (!org) {
      results.push({
        pass: true,
        label: "Rule drift: org rules absent (informational)",
      });
    } else {
      // Populated org headings only — multi-line-comment-only headings
      // (e.g. ## Corrections) read as empty and are excluded.
      const orgPopulated = new Map<string, string>();
      for (const [h, text] of org.headings) {
        if (text.trim() !== "") orgPopulated.set(h, text);
      }
      const drifts: Array<{ file: string; heading: string; orgSentence: string }> = [];
      for (const rule of rules) {
        if (rule.scope !== "team" && rule.scope !== "project") continue;
        for (const [h, text] of rule.headings) {
          if (text.trim() === "") continue;
          const orgText = orgPopulated.get(h);
          if (orgText === undefined) continue;
          // First sentence of the org body under that heading, quoted
          // verbatim. Split on the first sentence terminator; fall back to
          // the whole first non-empty line when none is present.
          const firstLine = orgText.split("\n")[0] ?? orgText;
          const sentenceMatch = firstLine.match(/^.*?[.!?](?=\s|$)/);
          const orgSentence = (sentenceMatch ? sentenceMatch[0] : firstLine).trim();
          drifts.push({ file: rule.path, heading: h, orgSentence });
        }
      }
      if (drifts.length === 0) {
        results.push({
          pass: true,
          label: "Rule drift: no team/project rule overlaps org policy",
        });
      } else {
        const detail = drifts
          .map((d) => `${d.file} ## ${d.heading} ⇄ org "${d.orgSentence}"`)
          .join("; ");
        results.push({
          pass: true,
          label: `Rule drift: ${drifts.length} team/project rule(s) overlap org policy (review for contradiction): ${detail}`,
        });
      }
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Rule drift: check failed",
      fix: errorMessage(e),
    });
  }

  // Paired sensor coverage (advisory, always pass:true) — for each rule
  // carrying frontmatter.pairing, confirm the named sensor exists in some
  // stage's resolved sensor set. File-existence check only (structural):
  // it confirms the binding resolves, NOT that the sensor semantically
  // fits the rule. feedforward-only rules never need a sensor.
  //
  // Read seams: pairing via loadRules().frontmatter (it is NOT on the
  // graph node); sensor ids via loadGraph() -> sensors_applicable[].id.
  // Manifest ids are bare ("required-sections"); a rule's pairing value is
  // aidlc-prefixed — strip "aidlc-" before matching (milestone-7b-frozen join).
  //
  // Emits GUARDRAIL_LOADED once per doctor run — but ONLY when an audit trail
  // already exists (cold-safe, see auditExists below); appendAuditEntry
  // self-creates the audit shard/dir, so an unconditional emit on a pristine
  // project would create a record as a side effect, making --doctor NOT
  // read-only. Doctor runs on a fresh checkout before any workflow is born, so
  // it must create nothing. On a project with a born intent the emit fires
  // exactly as before (BARE appendAuditEvent — the only throw is a real write
  // failure, which the rest of the codebase lets propagate).
  const pairedRules = loadRules();
  // sensors_applicable is REQUIRED on a compiled graph node, but a
  // hand-rolled or pre-milestone-9 graph JSON can omit it; `?? []` keeps this
  // advisory row from crashing doctor on a malformed/legacy graph (the
  // same defensive posture the cycle/orphan/scope checks take above).
  const sensorIds = new Set(
    loadGraph().flatMap((n) => (n.sensors_applicable ?? []).map((s) => s.id))
  );
  let pairM = 0;
  let pairX = 0;
  let pairP = 0;
  // unpaired holds the U set (sensor id named but absent anywhere);
  // unpaired.length is U, so no separate counter is needed.
  const unpaired: Array<{ file: string; sensor: string }> = [];
  for (const rule of pairedRules) {
    const pairing = rule.frontmatter.pairing;
    if (pairing === undefined) continue;
    pairM++;
    if (pairing === "feedforward-only") {
      pairX++;
      continue;
    }
    const bareId = pairing.replace(/^aidlc-/, "");
    if (sensorIds.has(bareId)) {
      pairP++;
    } else {
      unpaired.push({ file: rule.path, sensor: pairing });
    }
  }
  const needing = pairM - pairX;
  let coverageLabel: string;
  if (needing === 0) {
    coverageLabel = `Paired sensor coverage: no sensor-bound rules (${pairX} feedforward-only)`;
  } else {
    coverageLabel = `Paired sensor coverage: ${pairP}/${needing} guardrails paired (${pairX} feedforward-only)`;
  }
  if (unpaired.length > 0) {
    const unpairedDetail = unpaired
      .map((u) => `unpaired: ${u.file} → ${u.sensor} (no stage binds it)`)
      .join("; ");
    coverageLabel = `${coverageLabel}; ${unpairedDetail}`;
  }
  results.push({ pass: true, label: coverageLabel });

  // ---------------------------------------------------------------------------
  // Check 7 — Intent registry ⇄ record-dir reconciliation
  //
  // The record dir name is the join key between a registry row and its on-disk
  // dir; a HAND-RENAME of the dir (e.g. in a file tree) breaks that pairing in
  // two directions, both of which listIntents() already surfaces:
  //   (a) a registry row whose stored dirName no longer resolves on disk
  //       (listIntents → dirName: null) — the intent's status/repos detach,
  //       and in a multi-intent space its cursor can no longer resolve it.
  //   (b) a record dir on disk with no registry row (listIntents → an orphan
  //       row with empty uuid + status "unknown").
  // Advisory (pass=true): a rename is a user action, not a framework fault, and
  // the lone-intent fallback keeps a single renamed intent working. The fix
  // names the editable repair: set the row's `dirName` (or rename the dir back).
  // Runs across EVERY space so a rename in a non-active space is still surfaced.
  // ---------------------------------------------------------------------------
  try {
    const danglingRows: string[] = []; // registry rows whose dir vanished
    const orphanDirs: string[] = []; // on-disk dirs with no registry row
    for (const sp of listSpaces(projectDir)) {
      for (const i of listIntents(projectDir, sp.name)) {
        if (i.uuid !== "" && i.dirName === null) {
          danglingRows.push(`${sp.name}/${i.slug} (uuid ${i.uuid.slice(0, 8)}…)`);
        } else if (i.uuid === "" && i.status === "unknown") {
          orphanDirs.push(`${sp.name}/${i.dirName}`);
        }
      }
    }
    const total = danglingRows.length + orphanDirs.length;
    if (total === 0) {
      results.push({ pass: true, label: "Intent registry: all rows ⇄ record dirs reconciled" });
    } else {
      const detail = [
        danglingRows.length > 0 ? `${danglingRows.length} row(s) with a missing dir [${danglingRows.join(", ")}]` : "",
        orphanDirs.length > 0 ? `${orphanDirs.length} dir(s) with no row [${orphanDirs.join(", ")}]` : "",
      ].filter(Boolean).join("; ");
      results.push({
        pass: true,
        label: `Intent registry: ${total} record-dir mismatch (advisory — likely a hand-renamed intent dir): ${detail}. Fix: set the row's \`dirName\` in the space's intents.json to the on-disk dir name, or rename the dir back.`,
      });
    }
  } catch (e) {
    results.push({
      pass: false,
      label: "Intent registry: reconciliation check failed",
      fix: errorMessage(e),
    });
  }

  // Cold-safe gate: only emit audit when an audit trail already exists. On a
  // pristine project (no audit shard / flat audit.md) doctor prints its health
  // report and creates NOTHING — it stays a pure read-only diagnostic. On an
  // initialized project both GUARDRAIL_LOADED and HEALTH_CHECKED emit as before.
  const auditExists = auditShards(projectDir).length > 0;

  if (auditExists) {
    appendAuditEvent(projectDir, "GUARDRAIL_LOADED", {
      Scope: "all",
      Path: `${harnessDir()}/${rulesSubdir()}/`,
      "Rule count": String(pairedRules.length),
    });
  }

  // Print report
  let output = "AI-DLC Health Check\n";
  output += `${"\u2500".repeat(37)}\n`;
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.pass) {
      output += `\u2713  ${r.label}\n`;
      passed++;
    } else {
      output += `\u2717  ${r.label}`;
      if (r.fix) output += ` — ${r.fix}`;
      output += "\n";
      failed++;
    }
  }
  output += `${"\u2500".repeat(37)}\n`;
  output += `${passed} passed, ${failed} failed\n`;

  process.stdout.write(output);

  // Audit only if audit.md already existed when doctor started (cold-safe —
  // see auditExists above). A pristine project gets the stdout report and no
  // file side effects; an initialized project records HEALTH_CHECKED as before.
  if (auditExists) {
    appendAuditEvent(projectDir, "HEALTH_CHECKED", {
      Request: `/aidlc --doctor`,
      Details: `${passed} passed, ${failed} failed`,
    });
  }

  // Exit non-zero on any check failure so CI and scripts get a clear
  // signal. Doctor's stdout carries the diagnostic regardless of exit
  // code — the orchestrator's tool-failure handler was updated in this
  // same change to print stdout (not stderr) for doctor.
  process.exit(failed > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// init (scaffold 0.2) — bootstrap state/audit files + scaffold aidlc-docs/
// ---------------------------------------------------------------------------

// Agent knowledge metadata (display name + example files) is now derived
// from `.claude/agents/*.md` frontmatter via loadAgents() in lib.ts.

// ---------------------------------------------------------------------------
// Deterministic workspace scanner
// ---------------------------------------------------------------------------

interface SubmoduleEntry {
  name: string;
  path: string;          // as written in .gitmodules (validated relative)
  url: string;           // "" when absent
  initialized: boolean;  // existsSync(join(projectDir, path, ".git"))
}

interface ScanResult {
  projectType: string;   // "Greenfield" | "Brownfield"
  languages: string;     // e.g. "TypeScript, JavaScript"
  frameworks: string;    // e.g. "React, Vite"
  buildSystem: string;   // e.g. "npm (package.json)"
  // Comma-joined top-level subdirectory name(s) the nested-project fallback
  // classified Brownfield from. Absent when the root itself decided the verdict
  // (the common case). Surfaced only in the WORKSPACE_SCANNED audit event and
  // the `detect --json` payload, never in the state file.
  nestedRoot?: string;
  submodules: SubmoduleEntry[]; // [] when no .gitmodules / none parseable
}

// The remedy naming the git command that fetches uninitialized submodules.
// Shared by every warning surface so the wording never drifts.
const SUBMODULE_INIT_REMEDY = "git submodule update --init --recursive";

// Enumerate submodule paths for a warning string: at most 5, then "(+N more)".
// Returns the bare comma-joined list (no parens) so each surface wraps it as
// it needs. Caps the enumerated set to keep audit/stdout lines bounded.
function enumerateSubmodulePaths(entries: SubmoduleEntry[]): string {
  const paths = entries.map((e) => e.path);
  if (paths.length <= 5) return paths.join(", ");
  return `${paths.slice(0, 5).join(", ")} (+${paths.length - 5} more)`;
}

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".java": "Java",
  ".kt": "Kotlin",
  ".go": "Go",
  ".rs": "Rust",
  ".rb": "Ruby",
  ".cs": "C#",
  ".cpp": "C++",
  ".c": "C",
  ".h": "C",
  ".hpp": "C++",
  ".swift": "Swift",
  ".php": "PHP",
};

const SCAN_SOURCE_DIRS = ["src", "app", "lib", "pages", "components", "tests"];
// Set view for the sweep-side skip in scanSignals: the depth-6 recurse there
// is the SOLE counter for these dirs, so the file sweep must never enter them.
const SCAN_SOURCE_DIR_SET: ReadonlySet<string> = new Set(SCAN_SOURCE_DIRS);
const SCAN_EXCLUDE = new Set([
  ".claude",
  ".kiro",
  ".codex",
  "aidlc-docs",
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
]);

// Package/build manifests that mark a directory as an application (not just
// scaffolding). Shared by the root scan and the nested-project fallback.
const SOURCE_MANIFESTS = [
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
];

// Top-level directories the nested-project fallback never descends into: they
// commonly hold sample/snippet/boilerplate code that is not the project's own
// source. The harness/VCS/build dirs in SCAN_EXCLUDE and SCAN_SOURCE_DIRS
// (already scanned at the root) are skipped separately. Lowercased for a
// case-insensitive match.
const NESTED_SCAN_EXCLUDE = new Set([
  "aidlc",
  "docs",
  "doc",
  "examples",
  "example",
  "samples",
  "sample",
  "demos",
  "demo",
  "reference",
  "testdata",
  "fixtures",
  "templates",
  "scripts",
]);

// skipDirs: directory names to skip at THIS level only (not propagated into
// the recursion); the caller counts those dirs through a separate deeper call.
function countFilesByLang(
  dir: string,
  counts: Record<string, number>,
  maxDepth: number,
  skipDirs?: ReadonlySet<string>
): void {
  if (maxDepth < 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SCAN_EXCLUDE.has(entry)) continue;
    const full = join(dir, entry);
    let st: import("node:fs").Stats;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    // Don't follow symlinks — cycle protection.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (skipDirs?.has(entry)) continue;
      countFilesByLang(full, counts, maxDepth - 1);
    } else if (st.isFile()) {
      const dot = entry.lastIndexOf(".");
      if (dot > 0) {
        const ext = entry.slice(dot).toLowerCase();
        const lang = LANG_BY_EXT[ext];
        if (lang) counts[lang] = (counts[lang] || 0) + 1;
      }
    }
  }
}

function detectFrameworks(topEntries: Set<string>, projectDir: string): string[] {
  const fws: string[] = [];
  const has = (name: string) => topEntries.has(name);

  if (["next.config.js", "next.config.ts", "next.config.mjs", "next.config.cjs"].some(has))
    fws.push("Next.js");
  if (["vite.config.js", "vite.config.ts", "vite.config.mjs"].some(has))
    fws.push("Vite");
  if (has("angular.json")) fws.push("Angular");
  if (["nuxt.config.js", "nuxt.config.ts"].some(has)) fws.push("Nuxt");
  if (has("remix.config.js")) fws.push("Remix");
  if (has("gatsby-config.js")) fws.push("Gatsby");
  if (["astro.config.mjs", "astro.config.js", "astro.config.ts"].some(has))
    fws.push("Astro");
  if (has("svelte.config.js")) fws.push("Svelte");
  if (has("nest-cli.json")) fws.push("NestJS");

  // React surfaces via package.json dependencies/peerDependencies
  if (has("package.json")) {
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(projectDir, "package.json"), "utf-8")
      );
      if (isPackageJson(raw)) {
        const deps = {
          ...(raw.dependencies ?? {}),
          ...(raw.peerDependencies ?? {}),
        };
        if (deps.react && !fws.includes("React")) fws.push("React");
      }
    } catch {
      // ignore parse errors
    }
  }

  if (has("manage.py")) fws.push("Django");

  if (has("Gemfile")) {
    try {
      const gemfile = readFileSync(join(projectDir, "Gemfile"), "utf-8");
      if (/^[^#]*\brails\b/m.test(gemfile)) fws.push("Rails");
    } catch {
      // ignore
    }
  }

  if (has("pom.xml")) {
    try {
      const pom = readFileSync(join(projectDir, "pom.xml"), "utf-8");
      if (/spring-boot/.test(pom)) fws.push("Spring Boot");
    } catch {
      // ignore
    }
  }

  return fws;
}

function detectBuildSystem(topEntries: Set<string>, projectDir: string): string {
  if (topEntries.has("package.json")) {
    if (topEntries.has("pnpm-lock.yaml")) return "pnpm (package.json)";
    if (topEntries.has("yarn.lock")) return "yarn (package.json)";
    if (topEntries.has("bun.lockb") || topEntries.has("bun.lock"))
      return "bun (package.json)";
    return "npm (package.json)";
  }
  if (topEntries.has("pyproject.toml")) {
    try {
      const pp = readFileSync(join(projectDir, "pyproject.toml"), "utf-8");
      if (/\[tool\.poetry\]/.test(pp)) return "poetry (pyproject.toml)";
      if (/\[tool\.uv\]/.test(pp)) return "uv (pyproject.toml)";
      if (/\[tool\.hatch\]/.test(pp)) return "hatch (pyproject.toml)";
    } catch {
      // ignore
    }
    return "python (pyproject.toml)";
  }
  if (topEntries.has("requirements.txt")) return "pip (requirements.txt)";
  if (topEntries.has("setup.py")) return "setuptools (setup.py)";
  if (topEntries.has("Cargo.toml")) return "cargo (Cargo.toml)";
  if (topEntries.has("go.mod")) return "go modules (go.mod)";
  if (topEntries.has("pom.xml")) return "maven (pom.xml)";
  if (topEntries.has("build.gradle") || topEntries.has("build.gradle.kts"))
    return "gradle (build.gradle)";
  if (topEntries.has("composer.json")) return "composer (composer.json)";
  if (topEntries.has("Gemfile")) return "bundler (Gemfile)";
  return "Unknown";
}

function hasNonDevDeps(projectDir: string): boolean {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf-8")
    );
    if (!isPackageJson(raw)) return false;
    const deps = raw.dependencies ?? {};
    // peerDependencies declare what a consumer must provide, not what this
    // project needs at runtime — exclude from the brownfield signal.
    return Object.keys(deps).length > 0;
  } catch {
    return false;
  }
}

// The signal evaluation for a single directory, used for both the workspace
// root and (via the nested-project fallback) each depth-1 subdirectory. Returns
// the raw brownfield signal plus the findings so the caller can aggregate.
//
//   fileScanDepth = the countFilesByLang depth for the SOURCE-FILE signal:
//     - root: 0 for the top-level file sweep (files directly under dir; the
//       inline top-level loop the base code ran is equivalent to
//       countFilesByLang(dir, counts, 0), same SCAN_EXCLUDE filter + symlink
//       skip, files only) PLUS a depth-6 recurse into each present
//       SCAN_SOURCE_DIRS entry.
//     - a nested container: 1, sweeping the container's own files plus one
//       level of arbitrary subdirs so a project under `wordbook/**` or
//       `backend/server/**` is seen. A present SCAN_SOURCE_DIRS entry is
//       skipped by the sweep: the depth-6 recurse below is its only counter,
//       so files directly under it are never counted twice.
interface DirSignals {
  brownfield: boolean;
  langCounts: Record<string, number>;
  frameworks: string[];
  buildSystem: string;
}

function scanSignals(dir: string, fileScanDepth: number): DirSignals {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    // dir doesn't exist yet (caller should scaffold first)
  }
  const entrySet = new Set(entries.filter((e) => !SCAN_EXCLUDE.has(e)));

  // Source-file count. countFilesByLang(dir, counts, 0) counts files directly
  // under dir (its recursion guard returns immediately at depth -1), matching
  // the base top-level file sweep. Any present known source dir is then
  // recursed at the base depth cap. The sweep itself never enters a
  // SCAN_SOURCE_DIRS entry: at depth 1 (the nested-container scan) it would
  // count the files directly under <dir>/src etc. that the depth-6 recurse
  // below counts again, inflating that language and potentially flipping the
  // reported primary. (At the root's depth 0 the skip is a no-op: the sweep
  // never enters subdirs there.)
  const langCounts: Record<string, number> = {};
  countFilesByLang(dir, langCounts, fileScanDepth, SCAN_SOURCE_DIR_SET);
  for (const dirName of SCAN_SOURCE_DIRS) {
    if (entrySet.has(dirName)) {
      countFilesByLang(join(dir, dirName), langCounts, 6);
    }
  }

  const frameworks = detectFrameworks(entrySet, dir);
  const buildSystem = detectBuildSystem(entrySet, dir);

  // Classification signals (mirror workspace-detection.md Step 3).
  const hasSourceFiles = Object.keys(langCounts).length > 0;
  const hasFrameworkConfig = frameworks.length > 0;
  const hasNonDev = entrySet.has("package.json") && hasNonDevDeps(dir);
  const hasOtherManifest = SOURCE_MANIFESTS.some((m) => entrySet.has(m));
  const hasAppSourceDir = SCAN_SOURCE_DIRS.some((d) => entrySet.has(d));

  return {
    brownfield:
      hasSourceFiles ||
      hasFrameworkConfig ||
      hasNonDev ||
      hasOtherManifest ||
      hasAppSourceDir,
    langCounts,
    frameworks,
    buildSystem,
  };
}

// Parse .gitmodules (ini-like) into submodule entries. Pure and exported for
// direct unit testing. Line-oriented, tolerant: malformed content degrades to
// whatever parses (total garbage yields []); it never throws. An entry with no
// path is dropped, as is any path that is absolute or escapes the project via a
// `..` segment (a caller joins path under projectDir and must not follow it out).
export function parseGitmodules(
  content: string
): Array<{ name: string; path: string; url: string }> {
  const entries: Array<{ name: string; path: string; url: string }> = [];
  let current: { name: string; path: string; url: string } | null = null;
  const finish = () => {
    if (!current) return;
    const p = current.path;
    const isUnsafe =
      p === "" ||
      p.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(p) || // Windows drive-absolute
      p.split(/[/\\]/).includes("..");
    if (!isUnsafe) entries.push(current);
    current = null;
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      finish();
      const m = line.match(/^\[submodule\s+"(.+)"\]$/);
      current = m ? { name: m[1], path: "", url: "" } : null;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "path") current.path = value;
    else if (key === "url") current.url = value;
  }
  finish();
  return entries;
}

// Read + parse the workspace-root .gitmodules and probe each declared path for
// initialization. A missing/unreadable file yields [] (the swallow idiom of the
// scanner neighbors). `initialized` mirrors isGitRepoDir (aidlc-lib.ts): the dir
// must exist AND hold a `.git` entry - so a missing dir, an empty dir, and a dir
// without `.git` all classify uninitialized.
function scanSubmodules(projectDir: string): SubmoduleEntry[] {
  let content: string;
  try {
    content = readFileSync(join(projectDir, ".gitmodules"), "utf-8");
  } catch {
    return [];
  }
  return parseGitmodules(content).map((e) => ({
    ...e,
    initialized: existsSync(join(projectDir, e.path, ".git")),
  }));
}

export function detectWorkspace(projectDir: string): ScanResult {
  let topEntries: string[] = [];
  try {
    topEntries = readdirSync(projectDir);
  } catch {
    // projectDir doesn't exist yet (caller should scaffold first)
  }
  const topSet = new Set(topEntries.filter((e) => !SCAN_EXCLUDE.has(e)));

  // Root scan (depth 0 for the top-level file sweep, byte-identical to the
  // base inline loop plus the SCAN_SOURCE_DIRS recurse, both inside scanSignals).
  const root = scanSignals(projectDir, 0);
  const langCounts = { ...root.langCounts };
  const frameworks = [...root.frameworks];
  let buildSystem = root.buildSystem;
  let brownfield = root.brownfield;
  const nestedHits: string[] = [];

  // Nested-project fallback: only when the root itself shows NO brownfield
  // signal. Scan each arbitrarily-named depth-1 subdirectory with the same
  // signal set (source files one level in via scanSignals(.., 1)), skipping
  // dot-dirs, NESTED_SCAN_EXCLUDE, the SCAN_SOURCE_DIRS entries already scanned
  // at the root, symlinks, and non-dirs. Aggregate every hit: languages merged,
  // frameworks unioned, first non-Unknown build system kept.
  if (!brownfield) {
    for (const entry of [...topSet].sort()) {
      if (entry.startsWith(".")) continue;
      if (NESTED_SCAN_EXCLUDE.has(entry.toLowerCase())) continue;
      if (SCAN_SOURCE_DIRS.includes(entry)) continue;
      const full = join(projectDir, entry);
      let st: import("node:fs").Stats;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) continue;

      const sub = scanSignals(full, 1);
      if (!sub.brownfield) continue;

      brownfield = true;
      nestedHits.push(entry);
      for (const [lang, n] of Object.entries(sub.langCounts)) {
        langCounts[lang] = (langCounts[lang] || 0) + n;
      }
      for (const fw of sub.frameworks) {
        if (!frameworks.includes(fw)) frameworks.push(fw);
      }
      if (buildSystem === "Unknown") buildSystem = sub.buildSystem;
    }
  }

  // Language list: primary = highest count; secondary = >= 20% of primary count.
  const sortedLangs = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
  let languages: string;
  if (sortedLangs.length === 0) {
    languages = "Unknown";
  } else {
    const primary = sortedLangs[0][0];
    const primaryCount = sortedLangs[0][1];
    const threshold = Math.max(1, Math.floor(primaryCount * 0.2));
    const extras = sortedLangs
      .slice(1)
      .filter(([, c]) => c >= threshold)
      .map(([l]) => l);
    languages = [primary, ...extras].join(", ");
  }

  // Repo metadata: a .gitmodules with >= 1 valid submodule path declares code,
  // even when the submodule dirs are empty/uninitialized. Languages stay AS
  // SCANNED (Unknown is truthful until the submodules are fetched). A root
  // signal: folded in after the nested fallback so nested aggregation (and
  // nestedRoot attribution) still runs when submodules are the only signal.
  const submodules = scanSubmodules(projectDir);
  if (submodules.length > 0) brownfield = true;

  const result: ScanResult = {
    projectType: brownfield ? "Brownfield" : "Greenfield",
    languages,
    frameworks: frameworks.length > 0 ? frameworks.join(", ") : "Unknown",
    buildSystem,
    submodules,
  };
  if (nestedHits.length > 0) result.nestedRoot = nestedHits.join(", ");
  return result;
}

// ---------------------------------------------------------------------------
// intent-birth (0.1-0.3) — deterministic: mint intent + scan + state-init
// ---------------------------------------------------------------------------

// Deferred `git rm` of a migrated flat tree. migrateFlatLayout MOVED the data
// (staged copy → per-intent record) and left the original aidlc-docs/ in place
// for this untrack step (it never rmSync's the source). Best-effort: a non-git
// project, or a tree git doesn't track, is a clean no-op — `git rm -r --cached`
// untracks without touching the working tree, then we remove the now-moved
// directory from disk. Resolved decision (3): migration git-rm's the tracked
// flat aidlc-docs/ post-move.
function gitRmFlatTree(projectDir: string, flatTree: string): void {
  try {
    if (!existsSync(flatTree)) return;
    // Untrack (cached only — the data already moved). Ignore failure (non-git
    // project, or already untracked) — the rmSync below still tidies disk.
    Bun.spawnSync(["git", "-C", projectDir, "rm", "-r", "--cached", "--quiet", "--", flatTree], {
      stdout: "ignore",
      stderr: "ignore",
    });
    // Remove the moved-from directory from the working tree (the data lives in
    // the per-intent record now; this is the empty husk).
    rmSync(flatTree, { recursive: true, force: true });
  } catch {
    // best-effort untrack; the migration itself already succeeded
  }
}

// Ensure the dirs a workflow writes into exist. Idempotent ensure-exists (NOT
// the old data/scaffold copy — SEED ships the shell). Creates the active intent's
// record dir plus its per-phase artifact dirs, AND the SPACE-level domain
// knowledge/ dir (a sibling of intents, not a record subdir); all skipped if
// already present. The active-intent cursor must be set (birthIntent/migration
// did so) before this runs.
function ensureWorkspaceDirs(projectDir: string): void {
  // docsDir() default-resolves the active intent's record dir (or the flat
  // fallback when no intent resolves) — the cursor set by birthIntent/migration
  // points it at the born intent.
  const record = docsDir(projectDir);
  mkdirSync(record, { recursive: true });
  // Lazy per-phase artifact dirs (the engine/stages write reports here).
  for (const phase of PHASES) {
    mkdirSync(join(record, phase), { recursive: true });
  }
  mkdirSync(join(record, "verification"), { recursive: true });
  // SPACE-level domain knowledge dir (NOT per-intent): vision §"Spaces" makes
  // knowledge a sibling of memory/codekb/intents under spaces/<space>/, so team
  // domain knowledge accumulates across every intent in the space rather than
  // being trapped in one intent's record. Free-form, empty at bootstrap. The
  // engine's per-agent METHODOLOGY knowledge ships separately under
  // <harness>/knowledge/ (untouched). Lazy ensure-exists — never SEED.
  mkdirSync(knowledgeDir(projectDir), { recursive: true });
  // Engine-only-install self-heal: recover an ENGINE-ONLY install. Normally the
  // workspace shell (aidlc/spaces/default/memory/) ships as a SIBLING of the
  // engine dir (the packager's emitMemory → MEMORY_DST), so a complete dist/
  // copy already carries it and the lines below leave it untouched. But a user
  // who copies ONLY the harness engine dir (e.g. dist/kiro/.kiro/) and NOT the
  // sibling aidlc/ shell lands with NO default-space method tree → doctor's
  // "workspace shell ready" check fails and the rule resolver loads zero rules.
  // To recover, seed the default-space memory tree from the copy the packager
  // bundled INSIDE the engine at tools/data/memory-seed/ (frameworkMemorySeedDir,
  // mirroring the tools/data/templates pattern) — but ONLY if the default tree is
  // ABSENT. The existsSync guard makes this strictly idempotent: a normal install
  // that copied aidlc/ already has the dir, so the seed never fires and the
  // committed default tree never churns (preserving the "default tree never
  // churns" invariant). This is a deliberate, GUARDED exception to the
  // "never SEED" rule the rest of this function follows.
  const defaultMemory = memoryDirFor(projectDir, DEFAULT_SPACE);
  if (!existsSync(defaultMemory)) {
    const seed = frameworkMemorySeedDir();
    if (existsSync(seed)) cpSync(seed, defaultMemory, { recursive: true });
  }
  // Align the harness-native includes with the active space at bootstrap (first
  // /aidlc). A no-op when they already point there (the common default-cursor
  // case) — so this never dirties a single-team committed tree; it self-heals a
  // tree whose cursor and includes drifted out of sync.
  repointHarnessIncludes(projectDir, activeSpace(projectDir));
}

// intent-birth — the deterministic mutation behind the engine's birth
// directive (the engine NAMES the move read-only; this tool performs it).
// Births the FIRST intent into the active space on a fresh workspace, OR a new
// intent for new work alongside an active one. Crash-safe + concurrent-safe:
// the WHOLE transaction (migration probe, intent mint, registry append,
// active-intent cursor, state-build, audit emits) runs inside ONE withAuditLock
// on the WORKSPACE sentinel bucket — every intents.json mutation takes that
// bucket (invariant 2), so two concurrent first-runs are serialized and BOTH
// births land distinct uuids/dirs/rows with no lost update.
//
// The data/scaffold dir-copy + knowledge READMEs that the old `--init` shipped
// are gone: the workspace shell (spaces/default/memory, native includes) ships
// in dist/ (SEED), and lazy per-intent/codekb/knowledge dirs are ensure-exists
// (created on demand). What stays is the scope→stage state-build that routes
// the workflow to its first post-init stage — relocated here, now writing into
// the BORN intent's record (the active-intent cursor set first makes the
// default-resolving state/audit helpers resolve there).
function handleIntentBirth(projectDir: string, flags: Record<string, string>): void {
  // Default to poc when --scope is omitted. Matches the orchestrator's
  // ultimate fallback in SKILL.md and makes direct tool invocations
  // (`bun aidlc-utility.ts intent-birth`) work without extra flags.
  const scope = flags.scope || "poc";
  if (!validScopes().has(scope)) {
    die(
      `Unknown scope: "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }

  const depthOverride = flags.depth;
  if (depthOverride && !VALID_DEPTHS[depthOverride.toLowerCase()]) {
    die(`Unknown depth: "${depthOverride}". Valid depths: minimal, standard, comprehensive.`);
  }

  const testStrategyOverride = flags["test-strategy"];
  if (testStrategyOverride && !VALID_TEST_STRATEGIES[testStrategyOverride.toLowerCase()]) {
    die(`Unknown test strategy: "${testStrategyOverride}". Valid: minimal, standard, comprehensive.`);
  }

  // Resolve the repo set the intent touches (P7 multi-repo): an explicit
  // `--repos a,b` wins; absent it, sibling auto-discovery scans the workspace
  // root's immediate children for a `.git`. An empty result (legacy single-repo /
  // fresh greenfield) records no repos row — the lone repo is inferred on the
  // construction path. Validated up front so a bad name fails before any mutation.
  let repos: string[];
  try {
    repos = resolveBirthRepoSet(projectDir, flags.repos);
  } catch (e) {
    die(errorMessage(e));
  }

  // The whole mutation runs under the WORKSPACE lock so a concurrent first-run
  // is serialized — both births append distinct rows to intents.json without a
  // lost update. The migration probe + the registry append are the reads/writes
  // the hazard box demands be in ONE critical section on the sentinel bucket.
  withAuditLock(projectDir, () => {
    // (1) MIGRATION WIRING. A pre-workspace project still at the flat aidlc-docs/
    // layout is migrated ONCE here (idempotent + crash-safe; no-op on a fresh
    // SEED shell or an already-migrated project). migrateFlatLayout MOVES the
    // existing flat state INTO a per-intent record (mints the intent, sets the
    // cursor + registry row), so when it fires the migrated state is AUTHORITATIVE
    // — we do NOT mint a second intent and do NOT rebuild state on top (that
    // would clobber the moved workflow). We git-rm the moved flat tree and emit a
    // migration acknowledgement, then return. The deferred `git rm` untracks the
    // data that MOVED (the source is never rmSync'd; best-effort — a non-git
    // project skips it).
    const migration = migrateFlatLayout(projectDir);
    if (migration) {
      gitRmFlatTree(projectDir, migration.movedFrom);
      // The migrated record carries its prior state + audit history. Record that
      // the workspace was migrated into this intent (lands in the migrated
      // intent's audit shard — the cursor points there now). No state rebuild.
      appendAuditEvent(projectDir, "WORKSPACE_INITIALISED", {
        Request: `/aidlc ${flags.arguments || scope}`,
        Scope: scope,
        Details: `Migrated flat aidlc-docs/ into ${migration.intentDirName}`,
      });
      process.stdout.write(
        `Migrated flat workspace into intent: ${migration.intentDirName} (space: ${DEFAULT_SPACE})\n`,
      );
      return;
    }

    // (2) MINT THE INTENT. SPIKE (date-prefix): the dir name is `<YYMMDD>-<label>`.
    // TWO seams, by the three-concerns split:
    //   • KNOWLEDGE→LLM: the conductor passes a short 2-3 word essence via --label
    //     ("simple calc"). This is the dir-name label — the readable, condensed half
    //     no deterministic tool can produce from a long sentence.
    //   • DETERMINISM→TOOL: --label is slugified (cap 24), the date prefix + collision
    //     counter are appended, the dirName is stored in the registry row.
    // Fallback chain so a NON-LLM caller (direct tool invocation, scripts, or a
    // conductor that omits --label) still births a sane name: --label, else the
    // freeform --arguments (truncated — may cut mid-phrase, the pre-LLM behaviour),
    // else the scope token. The full --arguments text still flows to the audit
    // Request + state Project fields below (verbose prose belongs there, not the dir).
    const description = flags.arguments?.trim();
    const label = flags.label?.trim();
    const slugSource = label || description || scope;
    const slug = slugify(slugSource, 24);
    // "help" is grammar (`intent help` prints help), so an intent slugged
    // "help" would be unswitchable by name. birthIntent throws on it too
    // (library backstop); dying here keeps the clean JSON error shape.
    if (RESERVED_RECORD_NAMES.has(slug)) {
      die(
        `"${slug}" is a reserved name and cannot be an intent label. Pick a label that describes the work.`
      );
    }
    birthIntent(projectDir, slug, activeSpace(projectDir), scope, repos);

    const ts = isoTimestamp();

    // ---- Audit bootstrap + birth events (relocated from the old --init) ----

    // audit.md: header-only bootstrap if absent. WORKFLOW_STARTED is the birth
    // event; SESSION_STARTED is owned by the SessionStart hook. This resolves to
    // the born intent's per-clone audit shard (cursor set above).
    const auditPath = auditFilePath(projectDir);
    if (!existsSync(auditPath)) {
      mkdirSync(dirname(auditPath), { recursive: true });
      writeFileSync(auditPath, `# AI-DLC Audit Log\n`, "utf-8");
    }

    // WORKFLOW_STARTED — mandatory first event of any new workflow. Captures the
    // birth timestamp so "when did this feature begin?" is answerable from the
    // audit alone. Lands in the born intent's audit (relocated from --init).
    appendAuditEvent(projectDir, "WORKFLOW_STARTED", {
      Scope: scope,
      Request: `/aidlc ${flags.arguments || scope}`,
      // Record the intent's repo span at birth (P7). Omitted when no repos were
      // captured (legacy single-repo / fresh greenfield → the lone repo is inferred).
      ...(repos.length > 0 ? { Repos: repos.join(", ") } : {}),
    });

    // PHASE_STARTED for the Init phase — Init always runs. Other phases emit
    // PHASE_STARTED at their boundary (via aidlc-state.ts advance) or
    // PHASE_SKIPPED right now if the scope excludes them.
    const initStageCount = stagesInScope(scope).filter(
      (s) => s.phase === "initialization" && s.action === "EXECUTE"
    ).length;
    appendAuditEvent(projectDir, "PHASE_STARTED", {
      Phase: "initialization",
      "Stage count": String(initStageCount),
      Scope: scope,
    });

    // PHASE_SKIPPED — one per phase the scope excludes entirely (no EXECUTE
    // stages in that phase). Captures the scope decision at workflow birth so
    // you don't have to derive it later by diffing the stage list.
    for (const phase of PHASES) {
      if (phase === "initialization") continue;
      const inPhase = stagesInScope(scope).filter((s) => s.phase === phase);
      const anyExecute = inPhase.some((s) => s.action === "EXECUTE");
      if (!anyExecute && inPhase.length > 0) {
        appendAuditEvent(projectDir, "PHASE_SKIPPED", {
          Phase: phase,
          Scope: scope,
          Reason: `scope ${scope} excludes ${phase}`,
        });
      }
    }

    appendAuditEvent(projectDir, "STAGE_STARTED", {
      Stage: "workspace-scaffold",
      Agent: "orchestrator",
    });

    // ---- Ensure-exists scaffold (lazy; SEED ships the shell) ----
    // The shipped shell already carries spaces/default/memory + native includes.
    // Birth only ensures the per-intent artifact dirs + the space-level knowledge/
    // dir the workflow will write into exist; it never re-copies the data/scaffold
    // tree (SEED owns that). All idempotent — skip any dir that already exists.
    ensureWorkspaceDirs(projectDir);

    appendAuditEvent(projectDir, "WORKSPACE_SCAFFOLDED", {
      Request: `/aidlc ${flags.arguments || scope}`,
      Details: "Per-intent artifact dirs + space-level knowledge/ ensured (shell shipped by SEED)",
    });
    appendAuditEvent(projectDir, "STAGE_COMPLETED", {
      Stage: "workspace-scaffold",
      Details: "Per-intent artifact dirs + space-level knowledge/ ensured",
    });

    handleIntentBirthStateBuild(projectDir, flags, scope, ts);
  });
}

// The scope→stage state-build half of birth: the workspace detection + state
// file authoring + routing audit emits the old --init ran after scaffolding.
// Split out only so handleIntentBirth's lock body stays readable; it is called
// from inside that lock (every write here resolves the born intent's record).
function handleIntentBirthStateBuild(
  projectDir: string,
  flags: Record<string, string>,
  scope: string,
  ts: string,
): void {
  const depthOverride = flags.depth;
  const testStrategyOverride = flags["test-strategy"];
  // ---- Workspace detection (stage 0.2) ----

  appendAuditEvent(projectDir, "STAGE_STARTED", {
    Stage: "workspace-detection",
    Agent: "orchestrator",
  });

  const scan = detectWorkspace(projectDir);
  const uninitSubmodules = scan.submodules.filter((s) => !s.initialized);
  const submoduleRemedy =
    uninitSubmodules.length > 0
      ? `${uninitSubmodules.length} uninitialized submodule path(s) (${enumerateSubmodulePaths(uninitSubmodules)}) - run '${SUBMODULE_INIT_REMEDY}' to fetch them`
      : "";

  appendAuditEvent(projectDir, "WORKSPACE_SCANNED", {
    "Project Type": scan.projectType,
    Languages: scan.languages,
    Frameworks: scan.frameworks,
    "Build System": scan.buildSystem,
    ...(scan.nestedRoot ? { "Nested Root": scan.nestedRoot } : {}),
    ...(scan.submodules.length > 0
      ? {
          Submodules: `${scan.submodules.length} declared, ${uninitSubmodules.length} uninitialized`,
        }
      : {}),
    Details:
      uninitSubmodules.length > 0
        ? `Deterministic rule-based scan; ${submoduleRemedy}`
        : "Deterministic rule-based scan",
  });
  appendAuditEvent(projectDir, "STAGE_COMPLETED", {
    Stage: "workspace-detection",
    Details: `Classified ${scan.projectType}; languages=${scan.languages}; frameworks=${scan.frameworks}`,
  });

  // ---- State init (stage 0.3) ----

  appendAuditEvent(projectDir, "STAGE_STARTED", {
    Stage: "state-init",
    Agent: "orchestrator",
  });

  const graph = loadStageGraph();
  const scopeMapping = loadScopeMapping();
  const scopeDef = scopeMapping[scope];
  if (!scopeDef) die(`Unknown scope: ${scope}`);
  const effectiveDepth = depthOverride
    ? VALID_DEPTHS[depthOverride.toLowerCase()]
    : scopeDef.depth;
  const effectiveTestStrategy = testStrategyOverride
    ? VALID_TEST_STRATEGIES[testStrategyOverride.toLowerCase()]
    : (scopeDef.testStrategy ?? effectiveDepth);

  // Compute stages to execute/skip
  const executeStages: string[] = [];
  const skipStages: string[] = [];
  for (const stage of graph) {
    const action = scopeDef.stages[stage.slug] || "SKIP";
    if (action === "EXECUTE") {
      executeStages.push(stage.number);
    } else {
      skipStages.push(`${stage.number} (${stage.slug})`);
    }
  }

  // For greenfield, reverse-engineering becomes SKIP
  const adjustedMapping = { ...scopeDef.stages };
  if (scan.projectType.toLowerCase() === "greenfield") {
    if (adjustedMapping["reverse-engineering"] === "EXECUTE") {
      adjustedMapping["reverse-engineering"] = "SKIP";
      const reStage = graph.find((s) => s.slug === "reverse-engineering");
      if (reStage) {
        const idx = executeStages.indexOf(reStage.number);
        if (idx >= 0) executeStages.splice(idx, 1);
        skipStages.push(`${reStage.number} (reverse-engineering — greenfield)`);
      }
      // Advisory: the incremental scopes presume existing code, so a greenfield
      // scan is a likely misread (source nested past the depth-1 fallback, or a
      // wrong scope). We do NOT override routing (an empty workspace genuinely
      // has nothing to reverse-engineer); we point the user at the fix.
      if (["bugfix", "refactor", "security-patch"].includes(scope)) {
        process.stderr.write(
          `Note: scope "${scope}" usually targets existing code, but the workspace scanned as Greenfield ` +
            `so Reverse Engineering will be skipped. If this project has a codebase the scanner missed, ` +
            `edit "Project Type" to Brownfield in the intent's aidlc-state.md, or move the source so it is ` +
            `detected (top-level or one folder down), then re-run.\n`,
        );
      }
    }
  }

  // Build stage progress checkboxes
  let stageProgress = "";
  const phaseMap: Record<string, typeof graph> = {};
  for (const stage of graph) {
    if (!phaseMap[stage.phase]) phaseMap[stage.phase] = [];
    phaseMap[stage.phase].push(stage);
  }

  const phaseHeaders: Record<string, string> = {
    initialization: "INITIALIZATION PHASE",
    ideation: "IDEATION PHASE",
    inception: "INCEPTION PHASE",
    construction: "CONSTRUCTION PHASE",
    operation: "OPERATION PHASE",
  };

  for (const phase of PHASES) {
    const stages = phaseMap[phase] || [];
    stageProgress += `\n### ${phaseHeaders[phase]}\n`;
    if (phase === "construction") {
      stageProgress += "Per unit: [TBD]\n";
    }
    for (const stage of stages) {
      const action =
        adjustedMapping[stage.slug] || scopeDef.stages[stage.slug] || "SKIP";
      const isInit = phase === "initialization";
      const marker = isInit ? "[x]" : "[ ]";
      const suffix = action === "EXECUTE" ? "EXECUTE" : `SKIP`;
      stageProgress += `- ${marker} ${stage.slug} — ${suffix}\n`;
    }
  }

  const firstPostInit = determineFirstPostInitStage(adjustedMapping, graph);
  stageProgress = stageProgress.replace(
    `- [ ] ${firstPostInit}`,
    `- [-] ${firstPostInit}`
  );

  const totalInScope = executeStages.length;
  const completedInit = graph.filter((s) => s.phase === "initialization").length;

  const firstPostInitEntry = graph.find((s) => s.slug === firstPostInit);
  const firstPostInitPhase = firstPostInitEntry
    ? firstPostInitEntry.phase.toUpperCase()
    : "IDEATION";
  const firstPostInitAgent = firstPostInitEntry
    ? firstPostInitEntry.lead_agent
    : "aidlc-product-agent";

  const nextAfterFirst = nextInScopeStage(firstPostInit, scope);
  const nextStageName = nextAfterFirst ? nextAfterFirst.slug : "none";

  const projectDesc = flags.arguments || "[Project description]";

  // Phase Progress - per-phase status. Birth completes every initialization
  // stage ([x]) and hands off to the first post-init stage ([-]), emitting the
  // PHASE_COMPLETED/VERIFIED/STARTED trio for that boundary below - so the
  // seed mirrors it: Initialization is Verified and the first post-init
  // stage's phase is Active. Later phases are Skipped if the adjusted scope
  // mapping has zero EXECUTE stages for them, otherwise Pending; advance /
  // finalize / complete-workflow / jump flip the rows at each subsequent
  // boundary (aidlc-state.ts, aidlc-jump.ts).
  const phaseStatus = (phase: string): string => {
    if (phase === "initialization") return "Verified";
    if (firstPostInitEntry && phase === firstPostInitEntry.phase) return "Active";
    const stagesInPhase = graph.filter((s) => s.phase === phase);
    const hasExecute = stagesInPhase.some(
      (s) => (adjustedMapping[s.slug] || scopeDef.stages[s.slug] || "SKIP") === "EXECUTE"
    );
    return hasExecute ? "Pending" : "Skipped";
  };
  const phaseProgressLines = [
    `- **Initialization**: ${phaseStatus("initialization")}`,
    `- **Ideation**: ${phaseStatus("ideation")}`,
    `- **Inception**: ${phaseStatus("inception")}`,
    `- **Construction**: ${phaseStatus("construction")}`,
    `- **Operation**: ${phaseStatus("operation")}`,
  ].join("\n");

  const stateContent = `# AI-DLC State Tracking

## Project Information
- **Project**: ${projectDesc}
- **Project Type**: ${scan.projectType}
- **Scope**: ${scope}
- **Start Date**: ${ts}
- **State Version**: 7
- **Active Agent**: ${firstPostInitAgent}
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Scope Configuration
- **Stages to Execute**: ${executeStages.join(", ")}
- **Stages to Skip**: ${skipStages.length > 0 ? skipStages.join(", ") : "none"}
- **Depth**: ${effectiveDepth}
- **Test Strategy**: ${effectiveTestStrategy}

## Workspace State
- **Project Root**: ${projectDir}
- **Languages**: ${scan.languages}
- **Frameworks**: ${scan.frameworks}
- **Build System**: ${scan.buildSystem}

## Execution Plan Summary
- **Total Stages**: ${totalInScope}
- **Completed**: ${completedInit}
- **In Progress**: ${firstPostInit}

## Runtime State
- **Revision Count**: 0

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

${phaseProgressLines}

## Stage Progress
<!-- Checkbox states: [ ] not started, [-] in progress, [?] awaiting approval (gate open), [R] revising (user rejected gate), [x] completed, [S] skipped via --stage/--phase jump -->
${stageProgress}
## Current Status
- **Lifecycle Phase**: ${firstPostInitPhase}
- **Current Stage**: ${firstPostInit}
- **Next Stage**: ${nextStageName}
- **Status**: Running
- **Last Updated**: ${ts}

## Session Resume Point
- **Last Completed Stage**: state-init
- **Next Action**: Execute ${firstPostInit}
- **Pending Artifacts**: none
`;

  writeStateFile(projectDir, stateContent);

  appendAuditEvent(projectDir, "WORKSPACE_INITIALISED", {
    Request: `/aidlc ${flags.arguments || scope}`,
    "Project Type": scan.projectType,
    Scope: scope,
    Languages: scan.languages,
    Frameworks: scan.frameworks,
    "Build System": scan.buildSystem,
    Details: `${totalInScope} stages in scope, routing to ${firstPostInit}`,
  });
  appendAuditEvent(projectDir, "STAGE_COMPLETED", {
    Stage: "state-init",
    Details: `State initialized: ${scope} scope, ${totalInScope} stages, routing to ${firstPostInit}`,
  });

  // Phase hand-off: initialization → first post-init phase. The state file
  // advertises Current Stage = first post-init, so the audit must reflect
  // the same transition (PHASE_COMPLETED + PHASE_VERIFIED + PHASE_STARTED +
  // STAGE_STARTED) to keep the two streams coherent. Without these, the first
  // subsequent `advance` call would appear to jump from workspace-scaffold
  // directly into a fresh phase.
  if (firstPostInitEntry && firstPostInitEntry.phase !== "initialization") {
    appendAuditEvent(projectDir, "PHASE_COMPLETED", {
      "From phase": "initialization",
      "To phase": firstPostInitEntry.phase,
      "Stages completed": String(completedInit),
    });
    appendAuditEvent(projectDir, "PHASE_VERIFIED", {
      "Phase boundary": `initialization → ${firstPostInitEntry.phase}`,
    });
    appendAuditEvent(projectDir, "PHASE_STARTED", {
      Phase: firstPostInitEntry.phase,
      Scope: scope,
    });
    appendAuditEvent(projectDir, "STAGE_STARTED", {
      Stage: firstPostInit,
      Agent: firstPostInitAgent,
    });
  }

  // Combined stdout summary (intent born + state-build). The active-intent
  // cursor + the record dir were set by birthIntent above; the state file lives
  // under the born intent's record (resolved by writeStateFile's default).
  const bornDir = activeIntent(projectDir) ?? "(legacy flat record)";
  const submoduleWarningLine =
    uninitSubmodules.length > 0
      ? `Warning: ${uninitSubmodules.length} uninitialized git submodule path(s) (${enumerateSubmodulePaths(uninitSubmodules)}) - run '${SUBMODULE_INIT_REMEDY}' before proceeding so reverse-engineering can read the code.\n`
      : "";
  process.stdout.write(
    `Intent born: ${bornDir} (space: ${activeSpace(projectDir)})
State initialized: ${scope} scope, ${totalInScope} stages, ${effectiveDepth} depth
Project type: ${scan.projectType}
Languages: ${scan.languages}
Frameworks: ${scan.frameworks}
Build System: ${scan.buildSystem}
${submoduleWarningLine}First post-init stage: ${firstPostInit} (${firstPostInitPhase})
`
  );
}

// ---------------------------------------------------------------------------
// state-init / init — deprecated aliases, merged into intent-birth
// ---------------------------------------------------------------------------

function handleStateInit(_projectDir: string, _flags: Record<string, string>): void {
  die(
    "state-init is merged into intent-birth. A workflow starts by describing what to build (/aidlc \"build the auth service\"); the engine auto-births the intent."
  );
}

// ---------------------------------------------------------------------------
// intent / space — the verb families + the deterministic query layer
// ---------------------------------------------------------------------------

// Print an intent listing (the query layer's human OR --json mode). Both modes
// read the SAME listSpaces/listIntents source so they never diverge. --json
// shape: {active, spaces:[...], intents:[{uuid,slug,status,repos}]} — consumed
// by the birth gate, resume-rebind, and statusline; human text is the bare
// `/aidlc intent` rendering. Pure read.
function printIntentListing(projectDir: string, asJson: boolean): void {
  const space = activeSpace(projectDir);
  const intents = listIntents(projectDir, space);
  const active = intents.find((i) => i.active);
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({
        active: active ? active.dirName : null,
        space,
        intents: intents.map((i) => ({
          uuid: i.uuid,
          slug: i.slug,
          status: i.status,
          repos: i.repos ?? [],
          dirName: i.dirName,
          active: i.active,
        })),
      })}\n`
    );
    return;
  }
  if (intents.length === 0) {
    process.stdout.write(
      `No intents in space "${space}" yet. Start one by describing what to build: /aidlc "build the auth service"\n`
    );
    return;
  }
  let out = `Intents in space "${space}":\n`;
  for (const i of intents) {
    const marker = i.active ? "*" : " ";
    out += `${marker} ${i.dirName ?? i.slug}  [${i.status}]\n`;
  }
  if (!active) {
    out += `\n(no active intent — switch with /aidlc intent <name>)\n`;
  }
  process.stdout.write(out);
}

// Print a space listing (human OR --json). --json shape:
// {active, spaces:[{name,active}]}. Pure read.
function printSpaceListing(projectDir: string, asJson: boolean): void {
  const spaces = listSpaces(projectDir);
  const active = spaces.find((s) => s.active);
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({
        active: active ? active.name : DEFAULT_SPACE,
        spaces: spaces.map((s) => ({ name: s.name, active: s.active })),
      })}\n`
    );
    return;
  }
  let out = `Spaces:\n`;
  for (const s of spaces) {
    out += `${s.active ? "*" : " "} ${s.name}\n`;
  }
  process.stdout.write(out);
}

// `/aidlc intent` (list) · `/aidlc intent <name>` (switch the active-intent
// cursor). Switching an intent is a PURE cursor write (an intent has no native
// include — only a space does). The <name> matches a record dir name exactly,
// or a slug (when unambiguous within the space). --json on the bare list emits
// the structured query shape.
function handleIntent(projectDir: string, positional: string[], flags: Record<string, string>): void {
  const asJson = flags.json === "true";
  const target = positional[1];
  if (!target) {
    printIntentListing(projectDir, asJson);
    return;
  }
  // `intent help`/`-h` is a help request, not a switch to a record named
  // "help" ("help" is a reserved record name, so no real record is shadowed).
  // The engine routes it to help before it ever reaches this tool; this arm is
  // the backstop for a direct invocation, so a confused caller gets the help
  // text instead of an "Unknown intent" error that reads like an invitation to
  // start new work.
  if (target === "help" || target === "-h") {
    handleHelp();
    return;
  }
  const space = activeSpace(projectDir);
  const intents = listIntents(projectDir, space);
  // Exact record-dir match first; then a unique slug match.
  let match = intents.find((i) => i.dirName === target);
  if (!match) {
    const bySlug = intents.filter((i) => i.slug === target && i.dirName !== null);
    if (bySlug.length === 1) match = bySlug[0];
    else if (bySlug.length > 1) {
      die(
        `Ambiguous intent "${target}" in space "${space}" (${bySlug.length} match). Use the full record-dir name: ${bySlug.map((i) => i.dirName).join(", ")}.`
      );
    }
  }
  if (!match || match.dirName === null) {
    // Deliberately NOT "describe what to build to start a new one": a conductor
    // recovering from a failed switch read that as an instruction and birthed an
    // unwanted intent. Point at the read-only listing only; starting new work
    // stays a separate, human-confirmed move.
    die(
      `Unknown intent "${target}" in space "${space}". This command only switches between existing intents - run /aidlc intent to list them. Do not start a new workflow to recover from this error.`
    );
  }
  setActiveIntentCursor(projectDir, match.dirName, space);
  // Re-stamp the LIVE conversation's session→intent record to the switched-to
  // intent. WHY: the resume-rebind stamp (session-start hook) is keyed by
  // session_id, which this tool never sees; only the hook does. Without this, a
  // deliberate in-conversation `/aidlc intent <slug>` switch leaves the session
  // stamped at the OLD intent, so resuming THIS same conversation fires a FALSE
  // rebind nag ("was working X, switch back?"). The hook records the live session
  // in `.current-session` on every fire (it owns session-id capture); we read
  // that marker here and re-stamp deterministically. Self-switch: the marker
  // names THIS session → its stamp follows the cursor → no false nag. Foreign
  // drift (a DIFFERENT session moved the cursor): the marker names that OTHER
  // session → its stamp moves, not ours → a genuine resume of our session still
  // offers the rebind. writeSessionIntentUuid no-ops on a blank uuid, so an
  // orphan (registry-less) record is fail-safe. Best-effort throughout.
  const sid = readCurrentSessionId(projectDir);
  if (sid && match.uuid) writeSessionIntentUuid(projectDir, sid, match.uuid);
  process.stdout.write(`Active intent → ${match.dirName} (space: ${space})\n`);
}

// `/aidlc space` (list) · `/aidlc space <name>` (switch the active-space
// cursor). Switching a space does TWO per-user writes: move the gitignored
// active-space cursor, then SURGICALLY repoint the harness-native rule includes
// in place so the next turn loads the switched space's method (the ambient
// channel — Claude @-stub / Kiro resources glob / Codex AIDLC_RULES_DIR). Both
// are per-user: the cursor is gitignored, and the include re-point is a no-op at
// `default` (so a single-team user never dirties the committed tree). Switching
// to a non-existent space errors (use space-create). --json on the bare list
// emits the structured shape.
function handleSpace(projectDir: string, positional: string[], flags: Record<string, string>): void {
  const asJson = flags.json === "true";
  const raw = positional[1];
  if (!raw) {
    printSpaceListing(projectDir, asJson);
    return;
  }
  // `space help`/`-h` is a help request, not a switch to a space named "help"
  // - same backstop as handleIntent (the engine routes it to help upstream,
  // and "help" is a reserved space name).
  if (raw === "help" || raw === "-h") {
    handleHelp();
    return;
  }
  // Spaces are STORED under their slug (handleSpaceCreate writes slugify(raw)),
  // so slugify the switch target before lookup AND before the cursor write —
  // otherwise `/aidlc space "My Space"` (stored as my-space) would miss.
  const target = slugify(raw);
  const spaces = listSpaces(projectDir);
  if (!spaces.some((s) => s.name === target)) {
    die(
      `Unknown space "${target}". Existing: ${spaces.map((s) => s.name).join(", ")}. This command only switches between existing spaces. Do not create a space to recover from this error - creating one is a separate, deliberate move (/aidlc space-create <name>).`
    );
  }
  setActiveSpaceCursor(projectDir, target);
  // Re-point the harness-native includes at the switched space so the NEXT turn
  // loads its method into ambient context (the cursor alone only moves AIDLC's
  // own resolver; the CLI-native include is the ambient channel). Surgical
  // in-place rewrite of the pointer segment only — preserves all engine wiring.
  const repointed = repointHarnessIncludes(projectDir, target);
  process.stdout.write(`Active space → ${target}\n`);
  if (repointed.length > 0) {
    process.stdout.write(`  repointed ${repointed.length} harness include(s) → ${target}\n`);
  }
}

// `aidlc-utility.ts codekb-path [--repo <name>] [--json]` — read-only. Prints the
// deterministic space-level per-repo codekb directory (forward-slash, workspace-
// relative) the reverse-engineering stage writes its 9 artifacts into. The repo
// is the caller-supplied --repo, else the engine-resolved codekbRepoName (the
// lone recorded repo, or basename(projectDir) when none is recorded). No mkdir,
// no state read, no audit — mirrors the intent/space read-only query arms.
function handleCodekbPath(projectDir: string, flags: Record<string, string>): void {
  const asJson = flags.json === "true";
  const space = activeSpace(projectDir);
  const repo = flags.repo && flags.repo.length > 0 ? flags.repo : codekbRepoName(projectDir, space);
  const dir = relativeCodekbDir(projectDir, repo, space);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ space, repo, dir })}\n`);
    return;
  }
  process.stdout.write(`${dir}/\n`);
}

// `detect [--json]` - read-only. Runs the workspace scan (detectWorkspace) on
// the bare project dir - it needs no aidlc/ workspace; it scans the app root -
// and prints projectType (Greenfield/Brownfield), languages, frameworks, and
// buildSystem. ALSO prints the resolved scope-registry paths (scopesDir +
// scopeGridPath): those are module-relative to the installed tool, which a
// prose agent cannot derive itself, so the composer agent is TOLD where the
// runtime reads scope data (and therefore where an authored scope must land).
// Writes nothing, no audit, no mkdir - mirrors codekb-path's read-only shape.
function handleDetect(projectDir: string, flags: Record<string, string>): void {
  const scan = detectWorkspace(projectDir);
  const payload = {
    projectType: scan.projectType,
    languages: scan.languages,
    frameworks: scan.frameworks,
    buildSystem: scan.buildSystem,
    ...(scan.nestedRoot ? { nestedRoot: scan.nestedRoot } : {}),
    submodules: scan.submodules,
    scopesDir: scopesDir(),
    scopeGridPath: scopeGridPath(),
    scopes: [...validScopes()],
  };
  if (flags.json === "true") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  const uninitCount = scan.submodules.filter((s) => !s.initialized).length;
  const submoduleLine =
    scan.submodules.length > 0
      ? `Submodules: ${scan.submodules.length} declared, ${uninitCount} uninitialized\n`
      : "";
  process.stdout.write(
    `Project type: ${payload.projectType}\n` +
      `Languages: ${payload.languages}\n` +
      `Frameworks: ${payload.frameworks}\n` +
      `Build system: ${payload.buildSystem}\n` +
      (scan.nestedRoot ? `Nested root: ${scan.nestedRoot}\n` : "") +
      submoduleLine +
      `Scopes dir: ${payload.scopesDir}\n` +
      `Scope grid: ${payload.scopeGridPath}\n` +
      `Valid scopes: ${payload.scopes.join(", ")}\n`,
  );
}

// `/aidlc space-create <name>` — seed a NEW space's memory. org.md is copied
// from spaces/default/memory/org.md (the always-present SEED baseline), plus
// fresh empty team.md/project.md/phases stubs + the templates/ floor. A new team
// starts at the framework baseline and earns its OWN practices — it does NOT
// inherit another space's learnings. (A new INTENT, by contrast, seeds nothing:
// it reads its space's live memory — handled in birthIntent.)
function handleSpaceCreate(projectDir: string, positional: string[], _flags: Record<string, string>): void {
  const raw = positional[1];
  if (!raw) die("Usage: aidlc-utility space-create <name>");
  // A help-shaped arg is a help request, not a name. Checked BEFORE slugify:
  // slugify("-h") is "h", which is not a reserved name, so the guard below
  // would let it through and a junk space would be created.
  if (raw === "-h" || raw === "help") {
    die("Did you mean /aidlc --help? To create a space, pass a name: /aidlc space-create <name>.");
  }
  const name = slugify(raw);
  // "help" is grammar (`space help` prints help), so a space with that slug
  // would be unswitchable by name - refuse it here, the creation chokepoint.
  if (RESERVED_RECORD_NAMES.has(name)) {
    die(
      `"${name}" is a reserved name and cannot be a space name. Pick a name that describes the team.`
    );
  }
  const dest = join(spacesRoot(projectDir), name);
  if (existsSync(dest)) die(`Space "${name}" already exists at ${dest}.`);

  const memoryDest = join(dest, "memory");
  mkdirSync(memoryDest, { recursive: true });
  mkdirSync(join(memoryDest, "phases"), { recursive: true });
  mkdirSync(join(memoryDest, "templates"), { recursive: true });
  mkdirSync(join(dest, "intents"), { recursive: true });
  // #5 — a new space gets the FULL space shape so it matches default's
  // committed layout (vision §11.2 "identical shape"): the space-level codekb/
  // and knowledge/ siblings of memory/intents. Built as bare parents — the
  // per-repo codekb/<repo>/ subdir is authored later by RE/codekb-path (no repo
  // is recorded at create time, so codekbDir() can't be called here), and
  // knowledge/ is free-form/empty at bootstrap. .gitkeep floors so the empty
  // dirs track (codekb output is COMMITTED, so the floor is not gitignored).
  mkdirSync(join(dest, "codekb"), { recursive: true });
  mkdirSync(knowledgeDir(projectDir, name), { recursive: true });

  // Copy the org.md baseline from the default space (the always-present SEED
  // shell). If absent (a malformed shell), fall back to an empty stub rather
  // than dying — the resolver tolerates an empty/absent rules dir.
  const orgSrc = join(spacesRoot(projectDir), DEFAULT_SPACE, "memory", "org.md");
  const orgDest = join(memoryDest, "org.md");
  if (existsSync(orgSrc)) {
    writeFileSync(orgDest, readFileSync(orgSrc, "utf-8"), "utf-8");
  } else {
    writeFileSync(orgDest, "# Organization defaults\n", "utf-8");
  }
  // Fresh empty team/project stubs (a new team earns its own practices).
  if (!existsSync(join(memoryDest, "team.md"))) {
    writeFileSync(join(memoryDest, "team.md"), "# Team practices\n", "utf-8");
  }
  if (!existsSync(join(memoryDest, "project.md"))) {
    writeFileSync(join(memoryDest, "project.md"), "# Project overrides\n", "utf-8");
  }
  // templates/ floor marker so the empty dir is tracked (mirrors SEED's floor).
  const floor = join(memoryDest, "templates", ".gitkeep");
  if (!existsSync(floor)) writeFileSync(floor, "", "utf-8");
  // codekb/ + knowledge/ floors so the empty siblings track (both committed).
  const codekbFloor = join(dest, "codekb", ".gitkeep");
  if (!existsSync(codekbFloor)) writeFileSync(codekbFloor, "", "utf-8");
  const knowledgeFloor = join(knowledgeDir(projectDir, name), ".gitkeep");
  if (!existsSync(knowledgeFloor)) writeFileSync(knowledgeFloor, "", "utf-8");

  process.stdout.write(
    `Space created: ${name}\n  memory/org.md (copied from default), team.md, project.md, phases/, templates/, codekb/, knowledge/\nSwitch to it with /aidlc space ${name}.\n`
  );
}


// Caller is responsible for applying any scope- or project-type-specific
// downgrades (e.g., reverse-engineering SKIP for greenfield) to the mapping
// before calling this helper. Walks post-init stages and returns the slug of
// the first EXECUTE entry.
function determineFirstPostInitStage(
  adjustedMapping: Record<string, string>,
  graph: StageEntry[]
): string {
  for (const stage of graph) {
    if (stage.phase === "initialization") continue;
    const action = adjustedMapping[stage.slug] || "SKIP";
    if (action === "EXECUTE") {
      return stage.slug;
    }
  }
  return "intent-capture"; // fallback
}

// ---------------------------------------------------------------------------
// scope-change — atomically change scope on an existing workflow
// ---------------------------------------------------------------------------

function handleScopeChange(projectDir: string, flags: Record<string, string>): void {
  const newScope = flags.scope;
  if (!newScope) die("--scope is required for scope-change");

  const depthOverride = flags.depth;
  if (depthOverride && !VALID_DEPTHS[depthOverride.toLowerCase()]) {
    die(`Unknown depth: "${depthOverride}". Valid depths: minimal, standard, comprehensive.`);
  }

  const testStrategyOverride = flags["test-strategy"];
  if (testStrategyOverride && !VALID_TEST_STRATEGIES[testStrategyOverride.toLowerCase()]) {
    die(`Unknown test strategy: "${testStrategyOverride}". Valid: minimal, standard, comprehensive.`);
  }

  const sp = stateFilePath(projectDir, flags.intent, flags.space);
  if (!existsSync(sp)) die("No state file found. Start a workflow first by describing what to build (/aidlc \"build the auth service\").");

  const scopeMapping = loadScopeMapping();
  const newScopeDef = scopeMapping[newScope];
  if (!newScopeDef) die(`Unknown scope: ${newScope}. Valid scopes: ${Object.keys(scopeMapping).join(", ")}`);

  let content = readStateFile(projectDir, flags.intent, flags.space);
  // AUTONOMY GUARD (the recompose guard's twin, same rationale): scope-change
  // flips stage EXECUTE/SKIP suffixes exactly like recompose does, so an
  // unattended autonomous Construction run must not have its plan re-shaped
  // through this verb either - there is no human at the gate to approve the
  // new shape. Guard placed before the same-scope early exit (fail-fast, the
  // recompose posture): under autonomy even a no-op call is refused, so the
  // conductor learns the rule on first contact rather than on the first
  // differing scope. Uses the exported isAutonomousMode predicate per its
  // contract (new gate sites use the helper; only pre-existing open-coded
  // sites are grandfathered), so this site cannot drift from the others.
  if (isAutonomousMode(content)) {
    die(
      "Cannot change scope: Construction Autonomy Mode is autonomous. Re-shaping the " +
        "plan needs a human at the gate, and an unattended run has none. Switch to " +
        "gated Construction first (aidlc-bolt set-autonomy --mode gated) or let the " +
        "swarm finish, then change scope.",
    );
  }
  const oldScope = getField(content, "Scope");
  if (!oldScope) die("Cannot read current Scope from state file.");

  if (oldScope === newScope) {
    process.stdout.write(`Scope is already ${newScope}\n`);
    return;
  }

  const graph = loadStageGraph();
  const projectType = getField(content, "Project Type") || "Greenfield";

  // Compute adjusted mapping (greenfield reverse-engineering adjustment)
  const adjustedMapping = { ...newScopeDef.stages };
  if (projectType.toLowerCase() === "greenfield") {
    if (adjustedMapping["reverse-engineering"] === "EXECUTE") {
      adjustedMapping["reverse-engineering"] = "SKIP";
    }
  }

  // Compute new execute/skip lists
  const executeStages: string[] = [];
  const skipStages: string[] = [];
  for (const stage of graph) {
    const action = adjustedMapping[stage.slug] || "SKIP";
    if (action === "EXECUTE") {
      executeStages.push(stage.number);
    } else {
      let reason = stage.slug;
      if (stage.slug === "reverse-engineering" && projectType.toLowerCase() === "greenfield" &&
          newScopeDef.stages["reverse-engineering"] === "EXECUTE") {
        reason += " — greenfield";
      }
      skipStages.push(`${stage.number} (${reason})`);
    }
  }

  // Parse existing checkboxes to preserve states
  const existingCheckboxes = parseCheckboxes(content);
  const existingMap = new Map(existingCheckboxes.map(c => [c.slug, c]));

  // Rebuild Stage Progress section
  const phaseMap: Record<string, typeof graph> = {};
  for (const stage of graph) {
    if (!phaseMap[stage.phase]) phaseMap[stage.phase] = [];
    phaseMap[stage.phase].push(stage);
  }

  const phaseHeaders: Record<string, string> = {
    initialization: "INITIALIZATION PHASE",
    ideation: "IDEATION PHASE",
    inception: "INCEPTION PHASE",
    construction: "CONSTRUCTION PHASE",
    operation: "OPERATION PHASE",
  };

  let newStageProgress = "";
  for (const phase of PHASES) {
    const stages = phaseMap[phase] || [];
    newStageProgress += `\n### ${phaseHeaders[phase]}\n`;
    if (phase === "construction") {
      // Preserve existing "Per unit:" line
      const perUnitMatch = content.match(/^Per unit:.*$/m);
      if (perUnitMatch) {
        newStageProgress += `${perUnitMatch[0]}\n`;
      }
    }
    for (const stage of stages) {
      const action = adjustedMapping[stage.slug] || "SKIP";
      const existing = existingMap.get(stage.slug);
      // Preserve existing checkbox state, default to [ ] if not found
      const marker = existing
        ? `[${existing.state === "completed" ? "x" : existing.state === "in-progress" ? "-" : existing.state === "skipped" ? "S" : " "}]`
        : "[ ]";
      const suffix = action === "EXECUTE" ? "EXECUTE" : "SKIP";
      newStageProgress += `- ${marker} ${stage.slug} \u2014 ${suffix}\n`;
    }
  }

  // Replace Stage Progress section in content
  const stageProgressRegex = /## Stage Progress\n<!-- [^\n]* -->\n([\s\S]*?)(?=\n## (?!Stage Progress))/;
  const stageProgressHeader = "## Stage Progress\n<!-- Checkbox states: [ ] not started, [-] in progress, [x] completed, [S] skipped via --stage/--phase jump -->\n";
  content = content.replace(stageProgressRegex, stageProgressHeader + newStageProgress);

  // Update fields
  content = setField(content, "Scope", newScope);
  content = setField(content, "Stages to Execute", executeStages.join(", "));
  content = setField(content, "Stages to Skip", skipStages.length > 0 ? skipStages.join(", ") : "none");
  const effectiveDepth = depthOverride
    ? VALID_DEPTHS[depthOverride.toLowerCase()]
    : newScopeDef.depth;
  content = setField(content, "Depth", effectiveDepth);
  const effectiveTestStrategy = testStrategyOverride
    ? VALID_TEST_STRATEGIES[testStrategyOverride.toLowerCase()]
    : (newScopeDef.testStrategy ?? effectiveDepth);
  content = setField(content, "Test Strategy", effectiveTestStrategy);
  content = setField(content, "Total Stages", String(executeStages.length));

  // Recount completed based on actual [x] count of in-scope EXECUTE stages
  const updatedCheckboxes = parseCheckboxes(content);
  const executeSlugs = new Set(
    graph.filter(s => (adjustedMapping[s.slug] || "SKIP") === "EXECUTE").map(s => s.slug)
  );
  const completedCount = updatedCheckboxes.filter(
    c => c.state === "completed" && executeSlugs.has(c.slug)
  ).length;
  content = setField(content, "Completed", String(completedCount));

  // Re-derive the not-yet-reached Phase Progress rows against the new plan:
  // a phase the new scope leaves without EXECUTE stages reads Skipped, one it
  // (re-)includes reads Pending. Verified/Active rows record history the
  // scope change does not rewrite (checkbox states are preserved above for
  // the same reason), so they are left untouched.
  for (const phase of PHASES) {
    const label = phase.charAt(0).toUpperCase() + phase.slice(1);
    const row = getField(content, label);
    if (row !== "Pending" && row !== "Skipped") continue;
    const hasExecute = graph.some(
      (s) => s.phase === phase && (adjustedMapping[s.slug] || "SKIP") === "EXECUTE"
    );
    content = setPhaseProgress(content, phase, hasExecute ? "Pending" : "Skipped");
  }

  // Update Last Updated timestamp
  content = setField(content, "Last Updated", isoTimestamp());

  writeStateFile(projectDir, content, flags.intent, flags.space);

  // Append SCOPE_CHANGED audit event
  const oldScopeDef = scopeMapping[oldScope];
  const oldExecuteCount = oldScopeDef
    ? graph.filter(s => (oldScopeDef.stages[s.slug] || "SKIP") === "EXECUTE").length
    : 0;
  const stageDelta = executeStages.length - oldExecuteCount;
  const deltaStr = stageDelta >= 0 ? `+${stageDelta}` : String(stageDelta);

  // Ceremony preview for the switch: gate count from the effective grid (the
  // reverse-engineering greenfield adjustment already applied) so the same
  // disclosure exists on a scope switch as on the cold-start confirm.
  const gates = gridCostSummary(
    adjustedMapping as Record<string, "EXECUTE" | "SKIP">,
  ).gates;

  appendAuditEvent(projectDir, "SCOPE_CHANGED", {
    "Old Scope": oldScope,
    "New Scope": newScope,
    "Stage Count Delta": deltaStr,
    "Stages in Scope": String(executeStages.length),
    "Approval Gates": String(gates),
    Depth: effectiveDepth,
  });

  process.stdout.write(
    `Scope changed: ${oldScope} → ${newScope}
Stages in scope: ${executeStages.length} (${deltaStr})
Approval gates: ${gates}
Depth: ${effectiveDepth}
Completed: ${completedCount}/${executeStages.length}
`
  );
}

// ---------------------------------------------------------------------------
// recompose - flip a PENDING stage's plan suffix on the live state file
// (the adaptive composer's in-flight write). `--skip <slugs>` drops stages
// from the plan; `--add <slugs>` promotes them back (comma-separated). The
// whole mutation runs under withAuditLock; validation is STRICT (a starved
// required input rejects, not advises); the derived state fields are rebuilt
// the way scope-change rebuilds them; a RECOMPOSED audit event lands with the
// flip lists. A run that never calls recompose is byte-identical to before -
// the verb is inert when unused.
// ---------------------------------------------------------------------------

function handleRecompose(projectDir: string, flags: Record<string, string>): void {
  const skipList = (flags.skip ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const addList = (flags.add ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (skipList.length === 0 && addList.length === 0) {
    die("Usage: recompose [--skip <slug,...>] [--add <slug,...>] - name at least one flip.");
  }
  const overlap = skipList.filter((s) => addList.includes(s));
  if (overlap.length > 0) {
    die(`Cannot both --skip and --add the same stage: ${overlap.join(", ")}.`);
  }

  const sp = stateFilePath(projectDir, flags.intent, flags.space);
  if (!existsSync(sp)) {
    die("No state file found. recompose re-shapes a RUNNING workflow; start one first.");
  }

  withAuditLock(projectDir, () => {
    let content = readStateFile(projectDir, flags.intent, flags.space);
    // AUTONOMY GUARD (mirrors the park guard's shape in aidlc-state.ts): an
    // unattended autonomous Construction run has no human at the gate, so a
    // conductor that drifts into "improving the plan" must not flip pending
    // stages on its own. The SKILL.md prose says plan-reshape never runs under
    // autonomous Construction on any harness; this is the deterministic anchor
    // that enforcement was missing (the strict validator catches starvation and
    // anchor moves, but not the absence of a human). Refuse outright; a
    // legitimate unattended-recompose story, if one ever arrives, comes as an
    // explicit flag, not the default.
    if (getField(content, "Construction Autonomy Mode")?.trim() === "autonomous") {
      die(
        "Cannot recompose: Construction Autonomy Mode is autonomous. Re-shaping the " +
          "plan needs a human at the gate, and an unattended run has none. Switch to " +
          "gated Construction first (aidlc-bolt set-autonomy --mode gated) or let the " +
          "swarm finish, then recompose.",
      );
    }
    // Only a RUNNING workflow has a live plan to re-shape. A Completed (or
    // Parked/terminated) state file is a terminal record: flipping its rows
    // would grow Total Stages under a summary computed at completion and
    // leave no cursor to ever reach the added stage — a corrupted record,
    // not a plan change. (With no cursor, the behind-cursor guard below is
    // also inert, so this check is the only thing standing between recompose
    // and a finished workflow.)
    const wfStatus = getField(content, "Status") || "";
    if (wfStatus !== "Running") {
      die(
        `Cannot recompose: workflow Status is "${wfStatus || "unknown"}", not Running. ` +
          "Recompose re-shapes a LIVE plan; for finished work start a new workflow instead.",
      );
    }
    const scope = getField(content, "Scope");
    if (!scope) die("Cannot read current Scope from state file.");
    const scopeDef = loadScopeMapping()[scope];
    if (!scopeDef) die(`Unknown scope in state file: ${scope}.`);

    const graph = loadStageGraph();
    const knownSlugs = new Set(graph.map((s) => s.slug));
    const checkboxes = parseCheckboxes(content);
    const checkboxMap = new Map(checkboxes.map((c) => [c.slug, c.state]));
    const suffixes = parseStateStageSuffixes(content);
    const currentSlug = getField(content, "Current Stage") || "";
    const currentIdx = graph.findIndex((s) => s.slug === currentSlug);

    // The effective pre-flip plan (suffix override wins over the grid).
    const effective = (slug: string): "EXECUTE" | "SKIP" => {
      const v = suffixes.get(slug) ?? scopeDef.stages[slug];
      return v === "EXECUTE" ? "EXECUTE" : "SKIP";
    };

    // --- Per-flip guards: pending-only, ahead-of-cursor, skeleton-gate ------
    const reject = (slug: string, why: string): never =>
      die(`Cannot recompose "${slug}": ${why}`);

    for (const slug of [...skipList, ...addList]) {
      if (!knownSlugs.has(slug)) {
        reject(slug, "not a compiled stage.");
      }
      const state = checkboxMap.get(slug);
      if (state === "completed" || state === "in-progress" || state === "skipped" ||
          state === "awaiting-approval" || state === "revising") {
        reject(slug, `its checkbox is not pending ([${state}]). Only a PENDING stage's plan can be re-shaped; completed/in-progress/skipped stages are frozen.`);
      }
      const idx = graph.findIndex((s) => s.slug === slug);
      if (currentIdx !== -1 && idx !== -1 && idx <= currentIdx) {
        reject(slug, `it is at or behind the current stage ("${currentSlug}"). In-flight recompose only reaches forward; re-running the past is out of scope.`);
      }
    }

    // The walking-skeleton gate derivation keys off the FIRST construction
    // EXECUTE stage (static). A flip that MOVES that anchor - skipping the
    // current anchor, or adding a construction stage AHEAD of it - would
    // silently relocate Bolt 1 and the skeleton stance round-trip. Compare
    // the anchor before and after the proposed flips and reject any move
    // (the cheapest sound answer; a suffix-aware gate derivation is a larger
    // change this verb must not smuggle in).
    const anchorOf = (plan: (slug: string) => "EXECUTE" | "SKIP"): string | undefined =>
      graph.find((s) => s.phase === "construction" && plan(s.slug) === "EXECUTE")?.slug;
    const anchorBefore = anchorOf(effective);
    const anchorAfter = anchorOf((slug) => {
      if (skipList.includes(slug)) return "SKIP";
      if (addList.includes(slug)) return "EXECUTE";
      return effective(slug);
    });
    if (anchorBefore !== anchorAfter) {
      const mover =
        anchorBefore && skipList.includes(anchorBefore) ? anchorBefore : (anchorAfter ?? anchorBefore ?? "construction");
      reject(
        mover,
        `the flip moves the first EXECUTE stage of Construction (the walking-skeleton gate anchor) from "${anchorBefore ?? "none"}" to "${anchorAfter ?? "none"}". The skeleton gate must stay anchored; jump or change scope instead.`,
      );
    }

    // --- Build the proposed effective grid and validate STRICT --------------
    // Strictness is a DIFF against the pre-flip baseline: a stock scope may be
    // BORN with structural advisories (e.g. bugfix's code-generation consumes
    // unit-of-work from the skipped units-generation - the scope author owns
    // that upstream work), and those must not veto an unrelated flip. What the
    // recompose validator hard-rejects is NEW starvation the flips introduce:
    // any strict error present post-flip that was absent pre-flip.
    const baseGrid: Record<string, string> = {};
    for (const s of graph) baseGrid[s.slug] = effective(s.slug);
    const proposed: Record<string, string> = { ...baseGrid };
    for (const slug of skipList) proposed[slug] = "SKIP";
    for (const slug of addList) proposed[slug] = "EXECUTE";
    // Stages already completed [x] satisfy their consumers even if the plan
    // now skips them - mark them EXECUTE for the dependency walk (in BOTH
    // grids) so a flip after a producer already ran is not falsely starved.
    for (const c of checkboxes) {
      if (c.state === "completed") {
        baseGrid[c.slug] = "EXECUTE";
        proposed[c.slug] = "EXECUTE";
      }
    }
    const projectType = (getField(content, "Project Type") || "").toLowerCase();
    const pt = projectType === "brownfield" || projectType === "greenfield"
      ? (projectType as "brownfield" | "greenfield")
      : undefined;
    const label = `recomposed ${scope}`;
    const baseErrors = new Set(
      validateGrid(baseGrid, { strict: true, projectType: pt, label }).errors,
    );
    const validation = validateGrid(proposed, {
      strict: true,
      projectType: pt,
      label,
    });
    const newErrors = validation.errors.filter((e) => !baseErrors.has(e));
    if (newErrors.length > 0) {
      die(
        `Recompose rejected by the strict validator:\n${newErrors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }

    // --- Apply the suffix flips ---------------------------------------------
    for (const slug of skipList) content = setStageSuffix(content, slug, "SKIP");
    for (const slug of addList) content = setStageSuffix(content, slug, "EXECUTE");

    // --- Rebuild the derived fields against the EFFECTIVE plan --------------
    // (the scope-change set: Stages to Execute / to Skip / Total / Completed).
    const postSuffixes = parseStateStageSuffixes(content);
    const eff = (slug: string): "EXECUTE" | "SKIP" => {
      const v = postSuffixes.get(slug) ?? scopeDef.stages[slug];
      return v === "EXECUTE" ? "EXECUTE" : "SKIP";
    };
    // The Stages to Skip row carries birth/scope-change annotations (entry
    // shape "<number> (<slug>)", e.g. "2.1 (reverse-engineering — greenfield)")
    // that a bare-slug rebuild would destroy. Preserve each existing entry
    // VERBATIM, in its existing position, when its stage is still skipped;
    // drop entries whose stage was promoted; append newly-skipped stages in
    // graph order, rendered the way scope-change renders them. A skip+add
    // round trip therefore leaves the row byte-identical.
    const priorSkipRow = getField(content, "Stages to Skip") || "";
    const priorTokens =
      priorSkipRow.trim() === "" || priorSkipRow.trim() === "none"
        ? []
        : priorSkipRow.split(", ");
    const slugOfSkipToken = (token: string): string => {
      const m = /^\S+ \((.+)\)$/.exec(token);
      const inner = m ? m[1] : token;
      return inner.split(" — ")[0];
    };
    const executeStages: string[] = [];
    const skipStages: string[] = [];
    const preservedSlugs = new Set<string>();
    for (const token of priorTokens) {
      const slug = slugOfSkipToken(token);
      if (knownSlugs.has(slug) && eff(slug) === "SKIP") {
        skipStages.push(token);
        preservedSlugs.add(slug);
      }
    }
    for (const s of graph) {
      if (eff(s.slug) === "EXECUTE") executeStages.push(s.number);
      else if (!preservedSlugs.has(s.slug)) skipStages.push(`${s.number} (${s.slug})`);
    }
    content = setField(content, "Stages to Execute", executeStages.join(", "));
    content = setField(content, "Stages to Skip", skipStages.length > 0 ? skipStages.join(", ") : "none");
    content = setField(content, "Total Stages", String(executeStages.length));
    const completedCount = parseCheckboxes(content).filter(
      (c) => c.state === "completed" && eff(c.slug) === "EXECUTE",
    ).length;
    content = setField(content, "Completed", String(completedCount));
    // Re-derive not-yet-reached Phase Progress rows against the effective
    // plan (scope-change's twin): a flip can empty a phase of EXECUTE stages
    // (-> Skipped) or give a Skipped phase its first (-> Pending).
    // Verified/Active rows are history and stay untouched.
    for (const phase of PHASES) {
      const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1);
      const row = getField(content, phaseLabel);
      if (row !== "Pending" && row !== "Skipped") continue;
      const hasExecute = graph.some(
        (s) => s.phase === phase && eff(s.slug) === "EXECUTE",
      );
      content = setPhaseProgress(content, phase, hasExecute ? "Pending" : "Skipped");
    }
    // The Next Stage projection over the recomposed plan (override-aware).
    if (currentSlug) {
      const next = nextInScopeStage(currentSlug, scope, content);
      content = setField(content, "Next Stage", next ? next.slug : "none");
    }
    content = setField(content, "Last Updated", isoTimestamp());

    writeStateFile(projectDir, content, flags.intent, flags.space);

    appendAuditEvent(projectDir, "RECOMPOSED", {
      Scope: scope,
      "Stages skipped": skipList.length > 0 ? skipList.join(", ") : "none",
      "Stages added": addList.length > 0 ? addList.join(", ") : "none",
      "Stages in Scope": String(executeStages.length),
    });

    process.stdout.write(
      `Recomposed: ${skipList.length} skipped (${skipList.join(", ") || "none"}), ` +
        `${addList.length} added (${addList.join(", ") || "none"})\n` +
        `Stages in scope: ${executeStages.length}\n` +
        `Completed: ${completedCount}/${executeStages.length}\n`,
    );
  });
}

// ---------------------------------------------------------------------------
// config-change — update depth and/or test-strategy without changing scope
// ---------------------------------------------------------------------------

function handleConfigChange(projectDir: string, flags: Record<string, string>): void {
  const rawDepth = flags.depth;
  const rawStrategy = flags["test-strategy"];

  if (!rawDepth && !rawStrategy) {
    die("config-change requires --depth and/or --test-strategy");
  }

  let newDepth: string | undefined;
  if (rawDepth) {
    newDepth = VALID_DEPTHS[rawDepth.toLowerCase()];
    if (!newDepth) die(`Unknown depth: "${rawDepth}". Valid depths: minimal, standard, comprehensive.`);
  }

  let newStrategy: string | undefined;
  if (rawStrategy) {
    newStrategy = VALID_TEST_STRATEGIES[rawStrategy.toLowerCase()];
    if (!newStrategy) die(`Unknown test strategy: "${rawStrategy}". Valid: minimal, standard, comprehensive.`);
  }

  const sp = stateFilePath(projectDir, flags.intent, flags.space);
  if (!existsSync(sp)) die("No state file found. Start a workflow first by describing what to build (/aidlc \"build the auth service\").");

  let content = readStateFile(projectDir, flags.intent, flags.space);
  const oldDepth = getField(content, "Depth");
  const oldStrategy = getField(content, "Test Strategy");

  // Inline existence checks (instead of caching to a boolean) so TS narrows
  // newDepth / newStrategy at each use site — avoids non-null assertions.
  if (newDepth !== undefined && newDepth !== oldDepth) {
    content = setField(content, "Depth", newDepth);
  }
  if (newStrategy !== undefined && newStrategy !== oldStrategy) {
    content = setField(content, "Test Strategy", newStrategy);
  }
  const depthChanging = newDepth !== undefined && newDepth !== oldDepth;
  const strategyChanging =
    newStrategy !== undefined && newStrategy !== oldStrategy;
  if (depthChanging || strategyChanging) {
    content = setField(content, "Last Updated", isoTimestamp());
    writeStateFile(projectDir, content, flags.intent, flags.space);
  }

  if (newDepth !== undefined && newDepth !== oldDepth) {
    appendAuditEvent(projectDir, "DEPTH_CHANGED", {
      "Old Depth": oldDepth || "unknown",
      "New Depth": newDepth,
    });
  }
  if (newStrategy !== undefined && newStrategy !== oldStrategy) {
    appendAuditEvent(projectDir, "TEST_STRATEGY_CHANGED", {
      "Old Strategy": oldStrategy || "unknown",
      "New Strategy": newStrategy,
    });
  }

  if (newDepth !== undefined) {
    process.stdout.write(
      depthChanging
        ? `Depth changed: ${oldDepth} → ${newDepth}\n`
        : `Depth is already ${newDepth}\n`
    );
  }
  if (newStrategy !== undefined) {
    process.stdout.write(
      strategyChanging
        ? `Test strategy changed: ${oldStrategy} → ${newStrategy}\n`
        : `Test strategy is already ${newStrategy}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// set-status — atomically update statusline fields at stage start
// ---------------------------------------------------------------------------

function handleSetStatus(projectDir: string, flags: Record<string, string>): void {
  const sp = stateFilePath(projectDir, flags.intent, flags.space);
  if (!existsSync(sp)) die("No state file found. Start a workflow first by describing what to build (/aidlc \"build the auth service\").");

  const stage = flags.stage;
  if (!stage) die("--stage is required for set-status");

  const entry = findStageBySlug(stage);
  if (!entry) die(`Unknown stage: ${stage}`);

  const phase = (flags.phase || entry.phase).toUpperCase();
  const agent = flags.agent || entry.lead_agent;

  let content = readStateFile(projectDir, flags.intent, flags.space);
  content = setField(content, "Lifecycle Phase", phase);
  content = setField(content, "Current Stage", stage);
  content = setField(content, "Active Agent", agent);
  content = setField(content, "In Progress", stage);
  content = setField(content, "Status", "Running");
  content = setField(content, "Last Updated", isoTimestamp());
  content = setCheckbox(content, stage, "in-progress");
  writeStateFile(projectDir, content, flags.intent, flags.space);

  process.stdout.write(`${JSON.stringify({ updated: true, phase, stage, agent })}\n`);
}

// ---------------------------------------------------------------------------
// Scope inference from freeform text
//
// The keyword sets live in each scope's `.claude/scopes/aidlc-<name>.md`
// frontmatter `keywords` field; this
// helper resolves the scope using word-boundary matching (so "debug"
// does not match "bug"),
// alphabetical iteration over scopes (so first-match-wins is
// deterministic), and a ">5 word" heuristic that falls back to the
// selection-aware default scope when the input looks like a project description
// that happens to contain a keyword.
//
// Exported for t67 unit tests; not a stable public API.

export interface InferResult {
  scope: string;
  source: "keyword" | "freeform";
  matches: Array<{ scope: string; keyword: string }>;
}

export function inferScopeFromText(input: string): InferResult {
  const text = input.toLowerCase();
  const trimmed = input.trim();
  const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  const mapping = loadScopeMapping();
  const allMatches: Array<{ scope: string; keyword: string }> = [];

  // Iterate in alphabetical order for determinism (not JSON insertion
  // order). validScopes() already returns a sorted set. Multi-word
  // keywords like "proof of concept" allow any whitespace run between
  // tokens, so "proof  of  concept" (double-spaced) still matches.
  for (const scope of [...validScopes()]) {
    const keywords = mapping[scope]?.keywords ?? [];
    for (const kw of keywords) {
      const tokens = kw.toLowerCase().trim().split(/\s+/).map(escapeRegex);
      const re = new RegExp(`\\b${tokens.join("\\s+")}\\b`, "i");
      if (re.test(text)) {
        allMatches.push({ scope, keyword: kw });
        break; // One keyword per scope is enough to mark it matched.
      }
    }
  }

  // Disambiguation: keyword + >5 words → likely a project description
  // containing the keyword incidentally. Also: no matches at all → default.
  if (allMatches.length === 0 || wordCount > 5) {
    return {
      scope: selectionAwareDefaultScope().scope,
      source: "freeform",
      matches: allMatches,
    };
  }

  // First alphabetical match wins (deterministic across calls).
  return {
    scope: allMatches[0].scope,
    source: "keyword",
    matches: allMatches,
  };
}

/** Doctor uses this for keyword-overlap detection. */
export function findScopeByKeyword(kw: string): string[] {
  const mapping = loadScopeMapping();
  const hits: string[] = [];
  for (const scope of [...validScopes()]) {
    if (
      (mapping[scope]?.keywords ?? []).some(
        (k) => k.toLowerCase() === kw.toLowerCase()
      )
    ) {
      hits.push(scope);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// scope-table - compiled summary of the scope grid for SKILL.md
//
// Emits a Markdown table delimited by BEGIN/END HTML comments. SKILL.md
// has a matching region that is regenerated via this tool. --check mode
// byte-compares the current SKILL.md region against the rendered output
// and exits 1 on drift. Mirrors aidlc-graph.ts compile / compile --check.
//
// AIDLC_SKILL_MD_PATH env-seam lets t67 sandbox --check against a
// fixture SKILL.md (so drift tests never mutate the real file).

const SCOPE_TABLE_BEGIN =
  "<!-- BEGIN: compiled scope grid via `bun aidlc-utility.ts scope-table` - do NOT hand-edit -->";
const SCOPE_TABLE_END =
  "<!-- END: compiled scope grid -->";

/** Exported for t67 unit tests. */
export function renderScopeTable(): string {
  const mapping = loadScopeMapping();
  const scopes = [...validScopes()]; // alphabetical
  const lines = [
    "| Scope          | Depth         | TestStrategy | EXECUTE / Total |",
    "|----------------|---------------|--------------|-----------------|",
  ];
  for (const name of scopes) {
    const def = mapping[name];
    const stages = def.stages;
    const total = Object.keys(stages).length;
    const execute = Object.values(stages).filter((v) => v === "EXECUTE").length;
    const depth = def.depth;
    const ts = def.testStrategy ?? "(default)";
    lines.push(
      `| ${name.padEnd(14)} | ${depth.padEnd(13)} | ${ts.padEnd(12)} | ${`${execute} / ${total}`.padEnd(15)} |`
    );
  }
  return lines.join("\n");
}

/** Canonical byte-shape: BEGIN\n\n<table>\n\nEND. */
export function canonicalScopeTableRegion(table: string): string {
  return `${SCOPE_TABLE_BEGIN}\n\n${table}\n\n${SCOPE_TABLE_END}`;
}

function skillMdPath(): string {
  if (process.env.AIDLC_SKILL_MD_PATH) return process.env.AIDLC_SKILL_MD_PATH;
  const harnessSkill = join(TOOLS_DIR, "..", "skills", "aidlc", "SKILL.md");
  if (existsSync(harnessSkill)) return harnessSkill;
  const agentsSkill = join(TOOLS_DIR, "..", "..", ".agents", "skills", "aidlc", "SKILL.md");
  if (existsSync(agentsSkill)) return agentsSkill;
  return harnessSkill;
}

function checkGeneratedTableRegion(
  verb: string,
  beginMarker: string,
  endMarker: string,
  renderRegion: () => string,
): void {
  const skillPath = skillMdPath();
  let skillRaw: string;
  try {
    skillRaw = readFileSync(skillPath, "utf-8");
  } catch (err) {
    console.error(
      `SKILL.md not readable at ${skillPath}: ${errorMessage(err)}`
    );
    process.exit(1);
  }

  // Normalize line endings before comparison so Windows CRLF files
  // (core.autocrlf=true) don't false-positive as drifted.
  skillRaw = skillRaw.replace(/\r\n/g, "\n");

  let located: GeneratedRegionLocation;
  try {
    located = findGeneratedRegion(skillRaw, beginMarker, endMarker, verb, skillPath);
  } catch (err) {
    console.error(errorMessage(err));
    process.exit(1);
  }

  const currentRegion = skillRaw.substring(located.beginIdx, located.regionEndIdx);
  const expectedRegion = renderRegion();

  if (currentRegion === expectedRegion) {
    return; // exit 0 silent
  }

  console.error(
    `SKILL.md ${verb} region is out of date. Refresh it from \`bun ${harnessDir()}/tools/aidlc-utility.ts ${verb}\`.`
  );
  process.exit(1);
}

function handleScopeTable(
  _projectDir: string,
  _flags: Record<string, string>,
  rawArgs: string[]
): void {
  const check = rawArgs.includes("--check");
  const expectedRegion = canonicalScopeTableRegion(renderScopeTable());

  if (!check) {
    process.stdout.write(`${expectedRegion}\n`);
    return;
  }

  checkGeneratedTableRegion(
    "scope-table",
    SCOPE_TABLE_BEGIN,
    SCOPE_TABLE_END,
    () => expectedRegion,
  );
}

// ---------------------------------------------------------------------------
// stage-table — compiled summary of the stage graph for SKILL.md
//
// Emits a Markdown table delimited by BEGIN/END HTML comments. SKILL.md
// has a matching region that is regenerated via this tool. --check mode
// byte-compares the current SKILL.md region against the rendered output
// and exits 1 on drift. Mirrors scope-table above.
//
// AIDLC_SKILL_MD_PATH env-seam lets tests sandbox --check against a
// fixture SKILL.md (so drift tests never mutate the real file).

const STAGE_TABLE_BEGIN =
  "<!-- BEGIN: compiled stage graph via `bun aidlc-utility.ts stage-table` - do NOT hand-edit -->";
const STAGE_TABLE_END =
  "<!-- END: compiled stage graph -->";

function displayPhase(phase: string): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

function displayLeadAgent(agent: string): string {
  return agent === "orchestrator" ? "(orchestrator)" : agent;
}

function displaySupportAgents(agents: string[] | undefined): string {
  return Array.isArray(agents) && agents.length > 0 ? agents.join(", ") : "—";
}

/** Exported for t32 integration tests. */
export function renderStageTable(): string {
  const lines = [
    "| Slug | # | Stage | Phase | Execution | Lead Agent | Support Agents | Mode |",
    "|------|---|-------|-------|-----------|------------|----------------|------|",
  ];
  for (const stage of loadStageGraph()) {
    lines.push(
      `| ${stage.slug} | ${stage.number} | ${stage.name} | ${displayPhase(stage.phase)} | ${stage.execution} | ${displayLeadAgent(stage.lead_agent)} | ${displaySupportAgents(stage.support_agents)} | ${stage.mode} |`
    );
  }
  return lines.join("\n");
}

/** Canonical byte-shape: BEGIN\n\n<table>\n\nEND. */
export function canonicalStageTableRegion(table: string): string {
  return `${STAGE_TABLE_BEGIN}\n\n${table}\n\n${STAGE_TABLE_END}`;
}

function handleStageTable(
  _projectDir: string,
  _flags: Record<string, string>,
  rawArgs: string[]
): void {
  const check = rawArgs.includes("--check");
  const expectedRegion = canonicalStageTableRegion(renderStageTable());

  if (!check) {
    process.stdout.write(`${expectedRegion}\n`);
    return;
  }

  checkGeneratedTableRegion(
    "stage-table",
    STAGE_TABLE_BEGIN,
    STAGE_TABLE_END,
    () => expectedRegion,
  );
}

// ---------------------------------------------------------------------------
// detect-scope — record a scope-detection event
//
// Two modes:
//   1. Explicit: `--scope <scope> --input <text> [--source ...]`.
//      Recorded unchanged.
//   2. Inference: `--from-text --input <text>`.
//      Resolves the scope via inferScopeFromText and emits SCOPE_DETECTED
//      with Source=keyword (match) or Source=freeform (default fallback).
//
// Passing both `--scope` and `--from-text` is an error — they are
// mutually exclusive modes. Missing both is also an error.

const VALID_SCOPE_SOURCES: ReadonlySet<string> = new Set([
  "freeform",
  "keyword",
  "env",
  "cli",
]);

function handleDetectScope(
  projectDir: string,
  flags: Record<string, string>
): void {
  const fromText = flags["from-text"] !== undefined;
  const explicitScope = flags.scope;

  if (fromText && explicitScope) {
    die(
      "Cannot combine --from-text and --scope. Use one or the other."
    );
  }
  if (!fromText && !explicitScope) {
    die(
      "Missing --scope <scope> (or pass --from-text to infer from --input)."
    );
  }

  // --input requirement differs by mode:
  //   --scope mode: --input is required (audit event needs original text).
  //   --from-text mode: --input may be empty string — inferScopeFromText
  //     returns `feature` as the documented default. Missing --input
  //     entirely is still an error; an empty string is fine.
  const input = flags.input;
  if (input === undefined) {
    die("Missing --input <original-text>");
  }
  if (!fromText && input === "") {
    die("--input cannot be empty under --scope mode.");
  }

  let scope: string;
  let source: string;
  let matchedKeywords: string[] = [];

  if (fromText) {
    const result = inferScopeFromText(input);
    scope = result.scope;
    source = result.source;
    matchedKeywords = result.matches.map((m) => m.keyword);
  } else {
    scope = explicitScope;
    source = flags.source || "freeform";
    if (!VALID_SCOPE_SOURCES.has(source)) {
      die(
        `Unknown source: "${source}". Valid: ${[...VALID_SCOPE_SOURCES].join(", ")}.`
      );
    }
  }

  if (!validScopes().has(scope)) {
    die(
      `Unknown scope: "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }

  const auditFields: Record<string, string> = {
    "Detected scope": scope,
    "Input text": input,
    Source: source,
  };
  if (matchedKeywords.length > 0) {
    auditFields["Matched keywords"] = matchedKeywords.join(", ");
  }
  appendAuditEvent(projectDir, "SCOPE_DETECTED", auditFields);

  process.stdout.write(
    `${JSON.stringify({
      emitted: "SCOPE_DETECTED",
      scope,
      source,
      matches: matchedKeywords,
    })}\n`
  );
}

// ---------------------------------------------------------------------------
// resolve-env-scope — validate AWS_AIDLC_DEFAULT_SCOPE and emit its value
//
// The orchestrator's step 0 in SKILL.md calls this to resolve the env default
// deterministically. Behavior:
//   - Env unset or empty: exit 0, no output. The orchestrator takes the
//     non-env path (CLI flag, keyword detection, or hard-coded fallback).
//   - Env set to a valid scope: exit 0, print `scope=<value>` to stdout.
//     The orchestrator synthesizes `--scope <value>` into $ARGUMENTS.
//   - Env names a disabled/unknown scope while core is disabled and exactly one
//     plugin scope owner is enabled: exit 0, print that plugin owner's
//     selection-aware default scope.
//   - Otherwise, env set to an invalid value: exit 1, print the canonical error
//     message to stderr. The orchestrator stops without mutating state.
//
// Centralising validation here (instead of leaving it to LLM prose) guarantees
// the error message shape and guarantees invalid env never reaches scope-change
// / state-init.
// ---------------------------------------------------------------------------

function handleResolveEnvScope(): void {
  const envScope = (process.env.AWS_AIDLC_DEFAULT_SCOPE || "").trim();
  if (envScope === "") {
    return; // unset — no output, exit 0
  }
  if (!validScopes().has(envScope)) {
    const fallback = selectionAwareDefaultScope(envScope);
    if (!fallback.error && validScopes().has(fallback.scope)) {
      if (fallback.note) {
        process.stderr.write(
          `AWS_AIDLC_DEFAULT_SCOPE="${envScope}" is not an enabled scope; using ${fallback.scope} (sole enabled plugin's first scope)\n`,
        );
      }
      process.stdout.write(`scope=${fallback.scope}\n`);
      return;
    }
    die(
      `Invalid AWS_AIDLC_DEFAULT_SCOPE "${envScope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }
  process.stdout.write(`scope=${envScope}\n`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const rawArgs = process.argv.slice(2);
  const { positional, flags } = parseArgs(rawArgs);
  const subcommand = positional[0];
  const projectDir = resolveProjectDir(flags["project-dir"]);

  switch (subcommand) {
    case "help":
      handleHelp();
      break;
    case "version":
      handleVersion();
      break;
    case "status":
      handleStatus(projectDir, flags);
      break;
    case "doctor":
      handleDoctor(projectDir);
      break;
    case "intent-birth":
      handleIntentBirth(projectDir, flags);
      break;
    case "intent":
      handleIntent(projectDir, positional, flags);
      break;
    case "space":
      handleSpace(projectDir, positional, flags);
      break;
    case "space-create":
      handleSpaceCreate(projectDir, positional, flags);
      break;
    // codekb-path — read-only query verb. Prints the deterministic
    // space-level per-repo codekb dir the RE stage writes into. Mirrors the
    // read-only intent/space query arms: no mutation, no audit, no mkdir.
    case "codekb-path":
      handleCodekbPath(projectDir, flags);
      break;
    // detect - read-only query verb. Prints the workspace scan
    // (greenfield/brownfield, languages) + the resolved scope-registry paths so
    // the composer agent is told where scope data lives. No mutation, no audit.
    case "detect":
      handleDetect(projectDir, flags);
      break;
    case "select-plugins":
      handleSelectPlugins(projectDir, positional);
      break;
    // init / state-init — deprecated aliases kept for back-compat only (not in
    // usage/help). The user-facing `/aidlc --init` is retired in P4: the
    // workspace shell ships in dist/ (SEED) and the engine auto-births the
    // intent. `init` now routes to the birth handler so any stale caller still
    // works; `state-init` dies with migration guidance.
    case "init":
      handleIntentBirth(projectDir, flags);
      break;
    case "state-init":
      handleStateInit(projectDir, flags);
      break;
    case "scope-change":
      handleScopeChange(projectDir, flags);
      break;
    // recompose - the adaptive composer's in-flight write: flip PENDING
    // stages' plan suffixes (--skip/--add) under the audit lock, strict-
    // validated, derived fields rebuilt, RECOMPOSED audited.
    case "recompose":
      handleRecompose(projectDir, flags);
      break;
    case "config-change":
      handleConfigChange(projectDir, flags);
      break;
    case "set-status":
      handleSetStatus(projectDir, flags);
      break;
    case "detect-scope":
      handleDetectScope(projectDir, flags);
      break;
    case "resolve-env-scope":
      handleResolveEnvScope();
      break;
    case "scope-table":
      handleScopeTable(projectDir, flags, rawArgs);
      break;
    case "stage-table":
      handleStageTable(projectDir, flags, rawArgs);
      break;
    default:
      die(
        `Usage: aidlc-utility <help|version|status|doctor|intent-birth|intent|space|space-create|codekb-path|detect|select-plugins|recompose|scope-change|config-change|set-status|detect-scope|resolve-env-scope|scope-table|stage-table> [--project-dir <path>] [--scope <scope>] [--json]`
      );
  }
}

if (import.meta.main) main();
