import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32 as winPath,
} from "node:path";
import { pathToFileURL } from "node:url";
import { appendAuditEntry, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import { main as pluginBuildMain } from "./aidlc-plugin-build.ts";
import { main as pluginValidateMain } from "./aidlc-plugin-validate.ts";
import {
  adaptLegacyResult,
  buildBundle,
  type LegacyDoctorResult,
  mergeFindings,
  redactSecretPatterns,
  runDoctorAnalysis,
} from "./aidlc-doctor-bundle.ts";
import {
  artifactsRegistryFor,
  consumedArtifactProducerCollisions,
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
import { workspaceManifestChecks } from "./aidlc-workspace-doctor.ts";
import {
  type cachedUnitClaimOverview,
  localUnitClaimOverviewForIntent,
  main as unitMain,
} from "./aidlc-unit.ts";
import {
  activeIntent,
  activeSpace,
  authoritativeProjectDescription,
  assertNoSymlinkInChainOrThrow,
  auditBlockField,
  auditFilePath,
  auditShards,
  createIntent,
  composeMarkerPath,
  COMPOSE_MARKER_TTL_MS,
  DEFAULT_SCOPE,
  DEFAULT_SPACE,
  detectLeakedLocks,
  documentInputRequestFilePath,
  DOCUMENT_INPUT_REQUEST_FILE,
  docsDir,
  envDefaultScope,
  knowledgeDir,
  agentsDir,
  emitError,
  errorMessage,
  escapeRegex,
  findAllEvents,
  findStageBySlug,
  frontmatterBlock,
  getField,
  hasUnsafeSingleLineCharacter,
  holdsAuditLock,
  hooksHealthDir,
  isAutonomousMode,
  isPlainObject,
  isTeamUnitOwnership,
  isPluginEnabled,
  isoTimestamp,
  isPackageJson,
  isValidRepoName,
  codekbDir,
  intentsDir,
  codekbRepoName,
  codekbScopeFingerprint,
  codekbSourceFingerprint,
  codekbStoreGeneration,
  parseReScope,
  relativeCodekbDir,
  RESERVED_RECORD_NAMES,
  scopePathCovered,
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
  readAuditShardEvents,
  readActiveDirectiveMarker,
  readUnitClaimRegistryCache,
  readUnitScopeStamp,
  recordHookDrop,
  readCurrentSessionId,
  readProjectDescriptionAuthority,
  resolveWorkflowSelection,
  readStateFile,
  refreshActiveDirectiveMarker,
  resolveIntentRepoSet,
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
  inspectSubagentInflight,
  harnessDataPath,
  pluginsEnabled,
  selectionAwareDefaultScope,
  resolveDefaultScope,
  projectDescriptionFilePath,
  PROJECT_DESCRIPTION_FILE,
  scalarField,
  stageEnabledBySelection,
  stagesInScope,
  stateFilePath,
  clearSessionIntentUuid,
  sourceBaselineAuditFields,
  unitDependencyPath,
  withAuditLock,
  validateBoltSlug,
  validScopes,
  worktreeAuditFilePath,
  worktreePath,
  worktreeStateFilePath,
  writeFileAtomic,
  writeSessionIntentUuid,
  writeSessionBinding,
  writeStateFile,
  harnessDir,
  rulesSubdir,
  _resetHarnessDataForTests,
  _resetScopeMappingForTests,
  _resetStageGraphForTests,
  classifyStateVersion,
  clearSessionRebindOffer,
  CURRENT_STATE_VERSION,
  type AuditShardEvent,
  idSuffix,
} from "./aidlc-lib.ts";
import { validateStageFrontmatter } from "./aidlc-stage-schema.ts";
import { isRuleStale } from "./aidlc-rule-schema.ts";
import {
  captureStageValidationBasis,
  inspectStageValidity,
} from "./aidlc-validity.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import {
  compiledExecutable,
  isCompiledExecutable,
  resolveHarnessPath,
  resolveSkillsPath,
  runtimeHarnessName,
} from "./aidlc-runtime-paths.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const CONFIG_KEYS = ["depth", "test-strategy", "review"] as const;
type ReviewOverride = "adversarial" | "advisory" | "none";

function parseReviewOverride(raw: string | undefined): ReviewOverride | undefined {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value !== "adversarial" && value !== "advisory" && value !== "none") {
    die(`Unknown review class: "${raw}". Valid: adversarial, advisory, none.`);
  }
  return value;
}

function storedReviewOverride(value: ReviewOverride): string {
  // "adversarial" means no per-run ceiling; stage declarations and scope caps
  // still apply, so represent it with the same empty field as config-change.
  return value === "adversarial" ? "" : value;
}

function applyReviewOverride(
  content: string,
  value: ReviewOverride | undefined,
): {
  content: string;
  oldReview: string | null;
  storedReview: string | undefined;
  changed: boolean;
} {
  const oldReview = getField(content, "Review Override");
  if (value === undefined) {
    return { content, oldReview, storedReview: undefined, changed: false };
  }
  const storedReview = storedReviewOverride(value);
  const changed = storedReview !== (oldReview ?? "");
  if (!changed) return { content, oldReview, storedReview, changed };
  if (oldReview === null) {
    const beforeInsert = content;
    content = content.replace(
      /^(- \*\*Test Strategy\*\*:[^\n]*)$/m,
      "$1\n- **Review Override**:",
    );
    if (content === beforeInsert) {
      content = content.replace(
        /^(- \*\*Scope\*\*:[^\n]*)$/m,
        "$1\n- **Review Override**:",
      );
    }
    if (content === beforeInsert) {
      content = `${content.trimEnd()}\n- **Review Override**:\n`;
    }
  }
  content = setField(content, "Review Override", storedReview);
  return { content, oldReview, storedReview, changed };
}

// These workspace transactions can legitimately queue behind a full plugin
// compose (compile + runner regeneration), so they share its ~60s lock budget.
const WORKSPACE_MUTATION_LOCK_RETRIES = 600;
const INTENT_CREATE_VALUE_FLAGS = [
  "scope",
  "arguments",
  "label",
  "depth",
  "test-strategy",
  "review",
  "repos",
  "project-dir",
] as const;
const INTENT_CREATE_DESCRIPTIVE_FLAGS = ["scope", "arguments", "label"] as const;
const NO_STATE_FILE_MESSAGE =
  "No state file found. Start a workflow first by describing what to build (/aidlc \"build the auth service\").";
const INIT_TRANSITION_MESSAGE =
  "init now lays down the project data tree and is not yet available in this release. To start work, describe what to build: /aidlc \"build the auth service\".";
const UPGRADE_UNAVAILABLE_MESSAGE =
  "upgrade is not available in this install; it arrives with the packaged binary distribution.";

let errorArgs: string[] = [];
let errorProjectDirArg: string | undefined;

function die(msg: string): never {
  // main(argv) seeds this context before dispatch so ERROR_LOGGED lands in the
  // same workflow the argv-selected command was targeting. Fall back to default
  // resolution (env var / cwd) for direct in-process helper calls.
  const args = errorArgs;
  const pd = resolveProjectDir(errorProjectDirArg);
  const command = `aidlc-utility ${args.join(" ")}`.trim();
  emitError(pd, "aidlc-utility", command, msg);
}

function validateIntentCreateFlagValues(
  flags: Record<string, string>,
  missingValueFlags: ReadonlySet<string>,
): void {
  const invalid = INTENT_CREATE_VALUE_FLAGS.filter(
    (name) =>
      missingValueFlags.has(name) ||
      (flags[name] !== undefined && flags[name].trim().length === 0),
  );
  if (invalid.length > 0) {
    die(
      `intent-create refused: ${invalid.map((name) => `--${name}`).join(", ")} ` +
        `${invalid.length === 1 ? "requires" : "require"} a nonblank value.`,
    );
  }
  for (const name of INTENT_CREATE_VALUE_FLAGS) {
    if (flags[name] !== undefined) flags[name] = flags[name].trim();
  }
}

// Thin wrapper around the canonical appendAuditEntry. All events must be in
// aidlc-audit.ts VALID_EVENT_TYPES. Throws on invalid event or audit failure —
// caller is expected to let that propagate (creation failures should stop creation).
//
// Lock-aware (mirrors aidlc-state.ts emitAudit): handleIntentCreate wraps the
// whole creation transaction in withAuditLock on the WORKSPACE sentinel bucket, so
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
  --claim <unit>    Atomically claim a team-owned Unit in this checkout
  --release <unit>  Release a Unit claim from the unscoped main checkout
  unit adopt <unit>  Adopt the checked-out live claim branch in a fresh clone
  unit participate  Mark this checkout for the guided Unit-claim picker
  unit publish <unit>  Publish this scoped checkout's committed candidate
  unit pin <unit>   Pin and validate a completed candidate from main
  unit gate <unit>  Record approve/reject against the pinned candidate
  unit land <unit>  Land pinned content, fold state, and finalize receipts (explicit post-git release recovery supported)
  unit merge-status <unit>  Show the local pinned-merge transaction
  unit status       Show claimable, claimed, and dependency-blocked Units
  compose "<task>"  Suggest a plan tailored to this task (mid-workflow: adjust the steps not yet run)
  compose --report <path>  Build a plan from a scan report (sort findings into a fix-and-ship run)
  --new-scope "<task>"  Build a custom plan even when a ready-made one matches
  intent list       List intents in the active space (read-only; --json for structured output)
  intent switch <name>  Switch the active intent (bare intent <name> still works)
  space list        List spaces (read-only; --json for structured output)
  space switch <name>  Switch the active space (bare space <name> still works)
  space create <name>  Create a new space (space-create <name> still works)
  config get <key>  Show active workflow config (depth, test-strategy, review)
  config set <key> <value>  Change active workflow config (depth, test-strategy, review)
  config list       List active workflow config (--json for structured output)
  plugin select [names]  Show or set the enabled plugin list
  plugin list       List installed plugins and enabled state (--json for structured output)
  plugin sync       Compose installed plugins into the current install
  plugin validate [path]  Validate authored plugin content (--json for structured output)
  plugin build <harness> [outDir]  Build a host plugin projection (--plugin-root <path>)
  knowledge onboard [path]  Index customer documents into the space DocumentKB
  knowledge sync    Reconcile the catalog with disk; retries extractor_unavailable rows
  knowledge list    The DocumentKB catalog (--json for structured output)
  knowledge show <id>  One document's record, plus its extracted text
  knowledge associate <id> --intent [slug]   Scope a document to one intent
  knowledge dissociate <id> --intent [slug]  Remove that scoping
  knowledge rebind <id> --to <path>  Repair a row whose original moved AND changed
  --doctor          Run health check on hooks, settings, and directory structure
  --doctor --export Write a redacted diagnostic report (timeline + findings, no work product); --output <dir> to relocate
  --stage <id>      Jump to a specific stage (by slug or number, e.g., code-generation or 3.5)
  --phase <name>    Jump to the first in-scope stage of a phase (e.g., construction or 3)
  --scope <scope>   Set or change scope (standalone or with --stage/--phase)
  --depth <level>   Override depth (minimal, standard, comprehensive)
  --test-strategy <level>  Override test strategy (minimal, standard, comprehensive)
  --review <class>  Cap stage reviews for this run (adversarial, advisory, none)
  --version         Show the framework version
  --help            Show this help message

Other:
  <description>     Describe what to build — scope is auto-detected
  (no arguments)    Resume existing workflow, or start fresh if none exists

Examples:
  /aidlc feature                                Start a feature workflow
  /aidlc Fix the login timeout bug              Auto-detected as bugfix scope
  /aidlc compose "harden the deploy pipeline"   Composer proposes a tailored plan
  /aidlc config list                         Show depth, test strategy, and review override
  /aidlc plugin list                         Show installed plugin selection
  /aidlc plugin validate                     Validate the plugin in the current directory
  /aidlc plugin build claude                 Build its Claude projection
  /aidlc                                        Resume or begin
  /aidlc --stage code-generation                Jump to code-generation stage
  /aidlc --phase construction --scope bugfix    Jump to construction with bugfix scope
  /aidlc --scope bugfix --depth comprehensive  Bugfix with comprehensive depth
  /aidlc --depth minimal                       Change depth of active workflow
  /aidlc --depth standard --test-strategy minimal  Full artifacts, minimal tests
  /aidlc --review advisory                     Single-pass reviews, findings at the gate`;

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

function mutableHarnessDataPath(projectDir: string): string {
  return resolveHarnessPath(
    ["tools", "data", "harness.json"],
    { mutable: true, projectDir },
  );
}

function stageGraphDataPath(projectDir: string): string {
  return resolveHarnessPath(
    ["tools", "data", "stage-graph.json"],
    { mutable: true, projectDir },
  );
}

function scopeGridDataPath(projectDir: string): string {
  return resolveHarnessPath(
    ["tools", "data", "scope-grid.json"],
    { mutable: true, projectDir },
  );
}

function requireInstalledHarness(projectDir: string): void {
  const installedLib = resolveHarnessPath(
    ["tools", "aidlc-lib.ts"],
    { mutable: true, projectDir },
  );
  if (!existsSync(installedLib)) {
    die(
      `select-plugins requires an installed project harness at ${dirname(dirname(installedLib))}.`,
    );
  }
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

function writePluginSelection(projectDir: string, names: string[]): void {
  const data = readHarnessDataObject();
  data.plugins = names;
  const path = mutableHarnessDataPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  resetSelectionSensitiveCaches();
}

function runBunTool(projectDir: string, rel: string, args: string[], label: string): void {
  let dispatcherArgs: string[];
  if (rel === "aidlc-graph.ts") {
    dispatcherArgs = ["graph", ...args];
  } else if (rel === "aidlc-runner-gen.ts" && args[0] === "write") {
    dispatcherArgs = ["gen", "runners", ...args.slice(1)];
  } else if (rel === "aidlc-runner-gen.ts" && args[0] === "scopes") {
    dispatcherArgs = ["gen", "runner-scopes", ...args.slice(1)];
  } else {
    throw new Error(`No dispatcher route for ${rel} ${args.join(" ")}`);
  }
  dispatcherArgs.push("--project-dir", projectDir);
  const executable = compiledExecutable();
  const command = executable
    ? [executable, ...dispatcherArgs]
    : [
        process.execPath,
        resolveHarnessPath(["tools", rel], { projectDir }),
        ...args,
        "--project-dir",
        projectDir,
      ];
  const result = Bun.spawnSync({
    cmd: command,
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      AIDLC_HARNESS_DIR: harnessDir(),
      AIDLC_HARNESS_NAME: runtimeHarnessName(projectDir, harnessDir()),
      AIDLC_PROJECT_DIR: projectDir,
      ...(holdsAuditLock(projectDir)
        ? { AIDLC_WORKSPACE_LOCK_OWNER_PID: String(process.pid) }
        : {}),
    },
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

export function regenerateSelectionSurfaces(projectDir: string): void {
  runBunTool(projectDir, "aidlc-graph.ts", ["compile"], "aidlc-graph compile");
  resetSelectionSensitiveCaches();
  const skillsDir = resolveSkillsPath([], { mutable: true, projectDir });
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
// scopes/required_sections) into CORE stage source, where no selection filter
// reaches, and records what it actually added in a per-plugin sidecar
// (tools/data/plugin-contrib-<key>.json). Prose fragments carry their own
// sentinel markers. On disable, select-plugins strips both, so a disabled
// plugin's contributions stop steering enabled stages; re-enabling restores
// them on the next session start (the plugin's compose hook re-merges).

interface ConsumeContribRecord {
  artifact: string;
  required: boolean;
  conditional_on?: string;
}

interface StageContribRecord {
  produces?: string[];
  sensors?: string[];
  consumes?: Array<string | ConsumeContribRecord>;
  scopes?: string[];
  required_sections?: string[];
  required_sections_created?: boolean;
  fragments?: Array<{ anchor: string; order: number; hash: string }>;
}

function pluginContribSidecarPath(plugin: string): string {
  return resolveHarnessPath(
    ["tools", "data", `plugin-contrib-${plugin.replace(/[^\w.-]/g, "_")}.json`],
    { mutable: true },
  );
}

function installedStagesRoot(): string {
  return resolveHarnessPath(["aidlc-common", "stages"], { mutable: true });
}

// Remove recorded values from a `field:` block. An emptied block collapses to
// the inline `field: []` form (the shape compose's merge expanded from); a
// created-by-compose required_sections field is deleted outright.
function removeListValues(content: string, field: string, values: ReadonlySet<string>, dropEmptyField: boolean): string {
  const blockRe = new RegExp(`^${field}:\\n((?:  - .+\\n)*)`, "m");
  const m = content.match(blockRe);
  if (!m) return content;
  const entries = [...m[1].matchAll(/^ {2}- (.+)$/gm)].map((x) => x[1]);
  const removeIndexes = new Set<number>();
  const remaining = new Set(values);
  // Compose renders ordinary structural additions unquoted. Prefer that exact
  // spelling so a legacy sidecar cannot remove an equivalent quoted membership
  // that predated the plugin.
  for (let i = 0; i < entries.length; i++) {
    if (remaining.delete(entries[i].trim())) removeIndexes.add(i);
  }
  // required_sections are rendered quoted while their sidecar values are bare.
  // Remove at most one canonical match for each recorded addition.
  for (const value of remaining) {
    const index = entries.findIndex((entry, i) => {
      if (removeIndexes.has(i)) return false;
      const bare = entry.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      return bare === value;
    });
    if (index !== -1) removeIndexes.add(index);
  }
  const kept = entries.filter((_, i) => !removeIndexes.has(i));
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

function fragmentProseHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function missingRecordedContributions(
  parsed: Record<string, unknown>,
  content: string,
  plugin: string,
  record: StageContribRecord,
): string[] {
  const missing: string[] = [];
  for (const field of ["produces", "sensors", "scopes", "required_sections"] as const) {
    const recorded = record[field];
    if (!Array.isArray(recorded) || recorded.length === 0) continue;
    const present = new Set(
      (Array.isArray(parsed[field]) ? parsed[field] : [])
        .filter((value): value is string => typeof value === "string"),
    );
    const absent = recorded.filter((value) => !present.has(value));
    if (absent.length > 0) missing.push(`${field}=[${absent.join(", ")}]`);
  }

  if (Array.isArray(record.consumes) && record.consumes.length > 0) {
    const present = (Array.isArray(parsed.consumes) ? parsed.consumes : [])
      .flatMap((entry): ConsumeContribRecord[] => {
        if (
          !isPlainObject(entry) ||
          typeof entry.artifact !== "string" ||
          typeof entry.required !== "boolean"
        ) {
          return [];
        }
        return [{
          artifact: entry.artifact,
          required: entry.required,
          ...(typeof entry.conditional_on === "string"
            ? { conditional_on: entry.conditional_on }
            : {}),
        }];
      });
    const absent = record.consumes.filter((expected) => {
      if (typeof expected === "string") {
        return !present.some((entry) => entry.artifact === expected);
      }
      return !present.some((entry) =>
        entry.artifact === expected.artifact &&
        entry.required === expected.required &&
        entry.conditional_on === expected.conditional_on
      );
    }).map((expected) =>
      typeof expected === "string"
        ? expected
        : `${expected.artifact}(required=${expected.required}${
          expected.conditional_on ? `, conditional_on=${expected.conditional_on}` : ""
        })`
    );
    if (absent.length > 0) missing.push(`consumes=[${absent.join(", ")}]`);
  }
  if (Array.isArray(record.fragments) && record.fragments.length > 0) {
    const absent = record.fragments.flatMap((fragment) => {
      const id = `${fragment.anchor}@${fragment.order}:${fragment.hash}`;
      const open =
        `<!-- plugin:${plugin}:${fragment.anchor}:${fragment.order}:${fragment.hash} -->`;
      const close =
        `<!-- /plugin:${plugin}:${fragment.anchor}:${fragment.order}:${fragment.hash} -->`;
      const openIdx = content.indexOf(open);
      if (openIdx === -1) return [id];
      const bodyStart = openIdx + open.length;
      const closeIdx = content.indexOf(close, bodyStart);
      if (closeIdx === -1) return [id];
      const wrapped = content.slice(bodyStart, closeIdx);
      if (!wrapped.startsWith("\n") || !wrapped.endsWith("\n")) return [id];
      return fragmentProseHash(wrapped.slice(1, -1)) === fragment.hash ? [] : [id];
    });
    if (absent.length > 0) missing.push(`fragments=[${absent.join(", ")}]`);
  }
  return missing;
}

function contributionRecordError(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "expected an object";
  let hasContribution = false;
  for (const field of ["produces", "sensors", "scopes", "required_sections"] as const) {
    if (!(field in value)) continue;
    if (!Array.isArray(value[field])) return `${field} must be an array`;
    if (value[field].some((entry) => typeof entry !== "string" || entry.length === 0)) {
      return `${field} must contain non-empty strings`;
    }
    if (value[field].length > 0) hasContribution = true;
  }
  if ("consumes" in value) {
    if (!Array.isArray(value.consumes)) return "consumes must be an array";
    for (const [index, consume] of value.consumes.entries()) {
      if (typeof consume === "string") {
        if (consume.length === 0) return `consumes[${index}] must be a non-empty string`;
        continue;
      }
      if (!isPlainObject(consume)) {
        return `consumes[${index}] must be a legacy string or an object`;
      }
      if (typeof consume.artifact !== "string" || consume.artifact.length === 0) {
        return `consumes[${index}].artifact must be a non-empty string`;
      }
      if (typeof consume.required !== "boolean") {
        return `consumes[${index}].required must be a boolean`;
      }
      if (
        "conditional_on" in consume &&
        consume.conditional_on !== undefined &&
        consume.conditional_on !== "brownfield" &&
        consume.conditional_on !== "greenfield"
      ) {
        return `consumes[${index}].conditional_on must be brownfield or greenfield`;
      }
    }
    if (value.consumes.length > 0) hasContribution = true;
  }
  if (
    "required_sections_created" in value &&
    typeof value.required_sections_created !== "boolean"
  ) {
    return "required_sections_created must be a boolean";
  }
  if ("fragments" in value) {
    if (!Array.isArray(value.fragments)) return "fragments must be an array";
    const identities = new Set<string>();
    for (const [index, fragment] of value.fragments.entries()) {
      if (!isPlainObject(fragment)) return `fragments[${index}] must be an object`;
      if (
        typeof fragment.anchor !== "string" ||
        !/^\S+$/.test(fragment.anchor)
      ) {
        return `fragments[${index}].anchor must be a non-empty token`;
      }
      if (
        typeof fragment.order !== "number" ||
        !Number.isSafeInteger(fragment.order) ||
        fragment.order < 0
      ) {
        return `fragments[${index}].order must be a non-negative integer`;
      }
      if (typeof fragment.hash !== "string" || !/^[0-9a-f]{8}$/.test(fragment.hash)) {
        return `fragments[${index}].hash must be an 8-character lowercase hex hash`;
      }
      const identity = `${fragment.anchor}\0${fragment.order}`;
      if (identities.has(identity)) {
        return `fragments contains duplicate identity ${fragment.anchor}@${fragment.order}`;
      }
      identities.add(identity);
    }
    if (value.fragments.length > 0) hasContribution = true;
  }
  return hasContribution ? undefined : "record has no contributions";
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
          if (record.scopes?.length) content = removeListValues(content, "scopes", new Set(record.scopes), false);
          if (record.consumes?.length) {
            const artifacts = record.consumes.flatMap((entry) =>
              typeof entry === "string"
                ? [entry]
                : entry && typeof entry.artifact === "string"
                  ? [entry.artifact]
                  : []
            );
            content = removeConsumesEntries(content, new Set(artifacts));
          }
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
  const names = [...new Set(parsedSelection.names)].sort();
  requireInstalledHarness(projectDir);

  // A plugin compose holds the workspace lock across compile + runner
  // regeneration (can exceed the default ~5s acquire budget on a loaded
  // machine), and select-plugins legitimately queues behind it - so wait up
  // to ~60s. Dead holders are reaped immediately regardless of budget.
  withAuditLock(projectDir, () => {
    // Compose can install a plugin while this command waits for the lock, so
    // discover and validate identities only after entering the transaction.
    const known = knownPluginNames();
    const knownSet = new Set(known);
    const unknown = names.filter((name) => !knownSet.has(name));
    if (unknown.length > 0) {
      die(`Unknown plugin name(s): ${unknown.join(", ")}. Valid plugins: ${known.join(", ")}.`);
    }
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
      snapshotFile(mutableHarnessDataPath(projectDir)),
      snapshotFile(stageGraphDataPath(projectDir)),
      snapshotFile(scopeGridDataPath(projectDir)),
    ];

    try {
      // Strip disabled plugins' merged contributions BEFORE recompiling, so the
      // regenerated graph no longer carries their produces/sensors/consumes/
      // scopes on core stages. Mutated stage files join `snapshots`, so the catch-side
      // rollback restores them too. Re-enabling restores contributions on the
      // next session start (the plugin's own compose hook re-merges).
      const strippedPlugins = stripDisabledPluginContributions(disabling, snapshots);
      writePluginSelection(projectDir, names);
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
  }, undefined, undefined, WORKSPACE_MUTATION_LOCK_RETRIES);
}

function pluginListRows(): Array<{ name: string; enabled: boolean }> {
  const selected = pluginsEnabled();
  return knownPluginNames().map((name) => ({
    name,
    enabled: selected === null || selected.has(name),
  }));
}

function handlePluginList(flags: Record<string, string>): void {
  const selected = pluginsEnabled();
  const rows = pluginListRows();
  if (flags.json === "true") {
    process.stdout.write(
      `${JSON.stringify({
        plugins: rows,
        selectionActive: selected !== null,
      })}\n`,
    );
    return;
  }

  process.stdout.write(
    `Plugin selection: ${renderPluginSelection(selected)}\n` +
      rows.map((row) => `${row.name} ${row.enabled ? "enabled" : "disabled"}`).join("\n") +
      (rows.length > 0 ? "\n" : ""),
  );
}

function pluginAuthorCommandCode(code: number): void {
  if (code !== 0) process.exitCode = code;
}

function handlePluginValidate(
  positional: string[],
  flags: Record<string, string>,
): void {
  const unknown = Object.keys(flags).filter(
    (key) => key !== "json" && key !== "help",
  );
  if (unknown.length > 0 || positional.length > 2) {
    pluginAuthorCommandCode(pluginValidateMain([]));
    return;
  }
  if (
    flags.help === "true" ||
    positional[1] === "-h" ||
    positional[1] === "--help"
  ) {
    pluginAuthorCommandCode(pluginValidateMain(["--help"]));
    return;
  }
  const args = [positional[1] ?? process.cwd()];
  if (flags.json === "true") args.push("--json");
  pluginAuthorCommandCode(pluginValidateMain(args));
}

function handlePluginBuild(
  positional: string[],
  flags: Record<string, string>,
  missingValueFlags: ReadonlySet<string>,
): void {
  const unknown = Object.keys(flags).filter(
    (key) =>
      key !== "json" &&
      key !== "help" &&
      key !== "plugin-root",
  );
  if (
    unknown.length > 0 ||
    positional.length > 3 ||
    missingValueFlags.has("plugin-root")
  ) {
    pluginAuthorCommandCode(pluginBuildMain([]));
    return;
  }
  if (
    flags.help === "true" ||
    positional[1] === "-h" ||
    positional[1] === "--help"
  ) {
    pluginAuthorCommandCode(pluginBuildMain(["--help"]));
    return;
  }
  const args = [
    flags["plugin-root"] ?? process.cwd(),
    ...(positional[1] ? [positional[1]] : []),
    ...(positional[2] ? [positional[2]] : []),
  ];
  if (flags.json === "true") args.push("--json");
  pluginAuthorCommandCode(pluginBuildMain(args));
}

function pluginRootCandidatesFromEnv(): string[] {
  const roots = [
    process.env.CLAUDE_PLUGIN_ROOT,
    process.env.PLUGIN_ROOT,
    process.env.AIDLC_PLUGIN_ROOT,
  ]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
  return [...new Set(roots)];
}

async function handlePluginSync(projectDir: string): Promise<void> {
  const roots = pluginRootCandidatesFromEnv();
  if (roots.length === 0) {
    process.stdout.write("no installed plugins; nothing to sync\n");
    return;
  }

  const pluginRoots = roots.map((root) => {
    const compose = join(root, "hooks", "compose.ts");
    return {
      root,
      compose,
      reason: existsSync(compose)
        ? null
        : existsSync(root)
          ? "missing hooks/compose.ts"
          : "root directory does not exist",
    };
  });
  const composePaths = pluginRoots.filter((item) => item.reason === null);
  const skippedRoots = pluginRoots.filter((item) => item.reason !== null);
  const skippedDetails = skippedRoots
    .map((item) => `- ${item.root}: ${item.reason}`)
    .join("\n");

  if (composePaths.length === 0) {
    die(
      `plugin-sync: no compose hook found in ${roots.length} configured plugin root(s):\n${skippedDetails}`,
    );
  }

  if (skippedRoots.length > 0) {
    process.stderr.write(
      `plugin-sync warning: skipped ${skippedRoots.length} configured plugin root(s):\n${skippedDetails}\n`,
    );
  }

  for (const item of composePaths) {
    const composeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AIDLC_HARNESS_DIR: harnessDir(),
      AIDLC_HARNESS_NAME: runtimeHarnessName(projectDir, harnessDir()),
      AIDLC_PROJECT_DIR: projectDir,
      AIDLC_PLUGIN_ROOT: item.root,
      CLAUDE_PLUGIN_ROOT: item.root,
      PLUGIN_ROOT: item.root,
    };
    if (isCompiledExecutable()) {
      const envKeys = [
        "AIDLC_HARNESS_DIR",
        "AIDLC_HARNESS_NAME",
        "AIDLC_PROJECT_DIR",
        "AIDLC_PLUGIN_ROOT",
        "CLAUDE_PLUGIN_ROOT",
        "PLUGIN_ROOT",
        "AIDLC_COMPILED_EXECUTABLE",
      ] as const;
      const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      Object.assign(process.env, composeEnv, {
        AIDLC_COMPILED_EXECUTABLE: process.execPath,
      });
      try {
        const mod = await import(pathToFileURL(item.compose).href) as {
          compose?: () => void | Promise<void>;
        };
        if (typeof mod.compose !== "function") {
          die(`plugin-sync failed for ${item.root}: compose.ts does not export compose()`);
        }
        await mod.compose();
      } catch (error) {
        die(`plugin-sync failed for ${item.root}: ${errorMessage(error)}`);
      } finally {
        for (const key of envKeys) {
          const value = previous[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      continue;
    }

    const result = spawnSync(process.execPath, [item.compose], {
      cwd: projectDir,
      encoding: "utf-8",
      env: composeEnv,
    });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.status ?? 1}`).trim();
      die(`plugin-sync failed for ${item.root}: ${detail}`);
    }
  }

  process.stdout.write(`plugin sync complete: ${composePaths.length} plugin(s)\n`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export const GATE_PENDING_ADVISORY_MS = 24 * 60 * 60 * 1000;

interface PendingOrganicGate {
  timestamp: string;
  timestampMs: number;
}

function pendingOrganicGate(
  audit: AuditShardEvent[],
  stage: string,
): PendingOrganicGate | null {
  const relevant = new Set([
    "WORKFLOW_STARTED",
    "STAGE_JUMPED",
    "STAGE_STARTED",
    "STAGE_AWAITING_APPROVAL",
    "GATE_APPROVED",
    "GATE_REJECTED",
  ]);
  const events = audit
    .filter((event) => relevant.has(event.event))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    });

  let pending: PendingOrganicGate | null = null;
  for (let start = 0; start < events.length;) {
    let end = start + 1;
    while (
      end < events.length &&
      events[end].timestamp === events[start].timestamp
    ) {
      end++;
    }

    // Only same-shard append order is causal. The last effective row in each
    // shard can be globally last; disagreeing effects therefore fail closed.
    const effectByShard = new Map<string, "open" | "clear">();
    for (const event of events.slice(start, end)) {
      const eventStage = auditBlockField(event.block, "Stage");
      const boundary =
        event.event === "WORKFLOW_STARTED" ||
        event.event === "STAGE_JUMPED" ||
        (
          event.event === "STAGE_STARTED" &&
          eventStage === stage &&
          !auditBlockField(event.block, "Workflow")?.startsWith("single-stage:")
        );
      if (boundary) {
        effectByShard.set(event.shard, "clear");
        continue;
      }
      if (eventStage !== stage) continue;
      if (event.event === "STAGE_AWAITING_APPROVAL") {
        if (
          auditBlockField(event.block, "Recovered") === "true" ||
          auditBlockField(event.block, "Revalidated") === "true"
        ) {
          continue;
        }
        effectByShard.set(event.shard, "open");
      } else {
        effectByShard.set(event.shard, "clear");
      }
    }

    const effects = new Set(effectByShard.values());
    if (effects.size > 1 || effects.has("clear")) {
      pending = null;
    } else if (effects.has("open")) {
      const timestamp = events[start].timestamp;
      const timestampMs = Date.parse(timestamp);
      pending = Number.isFinite(timestampMs)
        ? { timestamp, timestampMs }
        : null;
    }
    start = end;
  }
  return pending;
}

function pendingDuration(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / (60 * 1000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function handleStatus(projectDir: string, flags: Record<string, string>): void {
  // --intent <record> / --space <name> target a specific intent's status
  // (vision §5); omitted -> the active record.
  const selection = resolveWorkflowSelection(projectDir, {
    space: flags.space,
    intent: flags.intent,
  });
  const sp =
    selection.intent === null
      ? join(intentsDir(projectDir, selection.space), "aidlc-state.md")
      : stateFilePath(projectDir, selection.intent, selection.space);
  if (!existsSync(sp)) {
    process.stdout.write(
      `No active AI-DLC workflow found.

To get started:
  /aidlc "build the auth service"   Describe what to build (creates the workflow record automatically)
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
    try {
      const pending = pendingOrganicGate(
        readAuditShardEvents(projectDir, flags.intent, flags.space),
        currentStage,
      );
      if (pending) {
        statusLine +=
          ` (waiting since ${pending.timestamp}, ` +
          `~${pendingDuration(Date.now() - pending.timestampMs)})`;
      }
    } catch {
      // Status remains useful when the ledger is absent, unreadable, or stale.
    }
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

  let validityOutput = "Validity:       Current\n";
  try {
    const validity = inspectStageValidity(projectDir, content, {
      stages: graph,
      audit: readAllAuditShards(projectDir, flags.intent, flags.space),
      currentBasis: (stage, stages) =>
        captureStageValidationBasis(projectDir, stage, content, stages, {
          resolution: { recordPath: dirname(sp), stateContent: content },
        }),
    });
    const directlyStale = validity.issues
      .filter((issue) => issue.direct)
      .map((issue) => issue.stage);
    const needsRevalidation = validity.issues
      .filter((issue) => !issue.direct)
      .map((issue) => issue.stage);
    const earliest = directlyStale[0] ?? validity.issues[0]?.stage ?? null;
    if (validity.warnings.length > 0) {
      validityOutput =
        "Validity:       Inspection partly unavailable — advisory; routing continues\n" +
        `Directly stale: ${directlyStale.join(", ") || "none"}\n` +
        `Revalidate:     ${needsRevalidation.join(", ") || "none"}\n` +
        `Untracked:      ${validity.untracked.join(", ") || "none"}\n` +
        `Warnings:       ${validity.warnings.join(" ")}\n`;
    } else if (validity.issues.length > 0) {
      validityOutput =
        "Validity:       Drift detected — advisory; routing continues\n" +
        `Directly stale: ${directlyStale.join(", ") || "none"}\n` +
        `Revalidate:     ${needsRevalidation.join(", ") || "none"}\n` +
        `Suggested redo: ${earliest ? `/aidlc --stage ${earliest}` : "none"}\n` +
        `Untracked:      ${validity.untracked.join(", ") || "none"}\n`;
    } else if (validity.untracked.length > 0) {
      validityOutput =
        "Validity:       Untracked completions — advisory; routing continues\n" +
        `Untracked:      ${validity.untracked.join(", ")}\n`;
    }
  } catch (error) {
    validityOutput =
      "Validity:       Inspection unavailable — advisory; routing continues\n" +
      `Warnings:       ${errorMessage(error)}\n`;
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
${validityOutput}
Last Completed: ${lastCompleted}
Next Stage:     ${nextStage}
`;
  if (isTeamUnitOwnership(content)) {
    const selectorArgs = [
      ...(flags.intent ? ["--intent", flags.intent] : []),
      ...(flags.space ? ["--space", flags.space] : []),
    ];
    const executable = compiledExecutable();
    const command = executable
      ? [
        executable,
        "team-board",
        "--snapshot",
        ...selectorArgs,
        "--project-dir",
        projectDir,
      ]
      : [
        process.execPath,
        resolveHarnessPath(["tools", "aidlc-orchestrate.ts"], { projectDir }),
        "team-board",
        "--snapshot",
        ...selectorArgs,
        "--project-dir",
        projectDir,
      ];
    const board = spawnSync(command[0], command.slice(1), {
      cwd: projectDir,
      encoding: "utf-8",
      env: process.env,
    });
    if ((board.status ?? 1) !== 0) {
      die(
        `Cannot render Team Construction snapshot: ${
          (board.stderr || board.stdout || `exit ${board.status ?? 1}`).trim()
        }`,
      );
    }
    process.stdout.write(`${output}\n${board.stdout.trimEnd()}\n`);
    return;
  }
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
export const CLAIM_ACTIVITY_STALE_HOURS = 24;

/**
 * Resolve the ordered list of Claude Code `managed-settings.json` paths to probe
 * for a `disableAllHooks` override, most-authoritative first. Pure and
 * platform/env-injected so every OS can be unit-tested without a host of that OS.
 *
 * Paths per Claude Code's settings docs (code.claude.com/docs/en/settings):
 *   - macOS:       /Library/Application Support/ClaudeCode/managed-settings.json
 *   - Linux / WSL: /etc/claude-code/managed-settings.json
 *   - Windows:     %ProgramFiles%\ClaudeCode\managed-settings.json
 *                  (legacy %PROGRAMDATA%\ClaudeCode\ — unsupported since v2.1.75,
 *                   kept only as a secondary probe)
 *
 * AIDLC_MANAGED_SETTINGS_PATH overrides the list entirely — a custom managed
 * path, and the seam tests use to stay hermetic against the host's real file.
 */
export function resolveManagedSettingsCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (env.AIDLC_MANAGED_SETTINGS_PATH) return [env.AIDLC_MANAGED_SETTINGS_PATH];
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") {
    // Use the win32 joiner explicitly so paths carry backslashes regardless of
    // the host OS running doctor's tests (native `join` would use the host's).
    return [
      winPath.join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json"),
      winPath.join(env.PROGRAMDATA || "C:\\ProgramData", "ClaudeCode", "managed-settings.json"),
    ];
  }
  return ["/etc/claude-code/managed-settings.json"];
}

type ClaudeManagedBooleanKey = "disableAllHooks" | "allowManagedHooksOnly";

function managedSettingsFiles(candidate: string): string[] {
  const files = [candidate];
  const fragmentsDir = join(dirname(candidate), "managed-settings.d");
  try {
    for (const name of readdirSync(fragmentsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const path = join(fragmentsDir, name);
      try {
        if (statSync(path).isFile()) files.push(path);
      } catch {
        // A fragment that vanished during enumeration carries no policy.
      }
    }
  } catch {
    // An absent or unreadable fragment directory carries no policy.
  }
  return files;
}

function resolveManagedBooleanSetting(
  key: ClaudeManagedBooleanKey,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean | undefined {
  for (const candidate of resolveManagedSettingsCandidates(platform, env)) {
    let effective: boolean | undefined;
    for (const path of managedSettingsFiles(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
        const value = parsed[key];
        if (typeof value === "boolean") effective = value;
      } catch {
        // Absent, unreadable, or malformed managed files do not define the key.
      }
    }
    if (effective !== undefined) return effective;
  }
  return undefined;
}

interface NamingMismatch {
  file: string;
  stem: string;
  name: string;
}

type DoctorCheckResult = LegacyDoctorResult;

const DEFAULT_PLUGIN_DOCTOR_TIMEOUT_MS = 10_000;
const PLUGIN_DOCTOR_MAX_BUFFER = 256 * 1024;
const PLUGIN_DOCTOR_MAX_ROWS = 50;
const PLUGIN_DOCTOR_MAX_TEXT = 300;
const PLUGIN_DOCTOR_FINDING_ID_MAX = 48;
const PLUGIN_NAME_REGEX = /^[a-z][a-z0-9-]*$/;
const PLUGIN_DOCTOR_REQUIRED_JSON =
  '{"checks":[{"pass":boolean,"label":string,"fix"?:string,"severity"?:"error"|"advisory"}]}';
const HOOK_EXECUTION_RECOVERY =
  "1. Run /hooks to check hook approval and policy state. 2. If hooks need approval, approve them and fully restart the CLI; approval does not take effect until a full restart. 3. If /hooks says hooks are restricted by policy, only your Claude Code administrator can lift allowManagedHooksOnly in managed-settings.json. Until then, for an attended session, launch the CLI with AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 and AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD=1";
// Hook heartbeats and audit rows are written in the same turn, normally
// seconds apart. Five minutes absorbs host scheduling and slow tool-return
// ordering without hiding a resumed workflow that advances after hooks die.
const HOOK_HEARTBEAT_STALE_SLACK_MS = 5 * 60 * 1000;

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
  results: DoctorCheckResult[],
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

function truncatePluginDoctorText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0/DEL controls from plugin-supplied text is the point of this line.
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, "");
  if (sanitized.length <= PLUGIN_DOCTOR_MAX_TEXT) return sanitized;
  return `${sanitized.slice(0, PLUGIN_DOCTOR_MAX_TEXT - 3)}...`;
}

function pluginDoctorResult(
  pass: boolean,
  label: string,
  options: {
    fix?: string;
    id?: string;
    severity?: DoctorCheckResult["severity"];
  } = {},
): DoctorCheckResult {
  return {
    pass,
    label: truncatePluginDoctorText(label),
    ...(options.fix === undefined
      ? {}
      : { fix: truncatePluginDoctorText(options.fix) }),
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.severity === undefined ? {} : { severity: options.severity }),
  };
}

function validPluginIdentity(plugin: string): boolean {
  return (
    PLUGIN_NAME_REGEX.test(plugin) &&
    plugin !== "aidlc" &&
    !plugin.startsWith("aidlc-")
  );
}

function pathContainedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function uniquePluginDoctorFindingId(
  plugin: string,
  check: string,
  emitted: Set<string>,
): string {
  const raw = `plugin-${plugin}-${check}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = (raw || "plugin-check")
    .slice(0, PLUGIN_DOCTOR_FINDING_ID_MAX)
    .replace(/-+$/g, "") || "plugin-check";
  let candidate = base;
  let occurrence = 2;
  while (emitted.has(candidate)) {
    const suffix = `-${occurrence}`;
    const head = base
      .slice(0, PLUGIN_DOCTOR_FINDING_ID_MAX - suffix.length)
      .replace(/-+$/g, "");
    candidate = `${head || "plugin-check"}${suffix}`;
    occurrence++;
  }
  emitted.add(candidate);
  return candidate;
}

function pluginDoctorTimeoutMs(): number {
  const raw = process.env.AIDLC_PLUGIN_DOCTOR_TIMEOUT_MS?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(raw)) return DEFAULT_PLUGIN_DOCTOR_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_PLUGIN_DOCTOR_TIMEOUT_MS;
}

function invalidPluginDoctorOutput(
  plugin: string,
  scriptPath: string,
  exitCode: number | null,
  detail: string,
  findingId: string,
): DoctorCheckResult {
  return pluginDoctorResult(
    false,
    `Plugin check (${plugin}): ${scriptPath} returned exit code ${exitCode ?? "null"}; required JSON shape ${PLUGIN_DOCTOR_REQUIRED_JSON}`,
    { fix: detail, id: findingId, severity: "error" },
  );
}

function appendPluginDoctorChecks(
  results: DoctorCheckResult[],
  projectDir: string,
): void {
  const selected = pluginsEnabled();
  const installed = knownPluginNames().filter((name) => name !== "aidlc");
  const enabled = selected === null
    ? installed
    : installed.filter((name) => selected.has(name));
  const harness = harnessDir();
  const timeoutMs = pluginDoctorTimeoutMs();
  const toolsDir = resolve(projectDir, harness, "tools");
  const findingIds = new Set<string>();

  for (const plugin of enabled) {
    if (!validPluginIdentity(plugin)) {
      results.push(pluginDoctorResult(
        false,
        `Plugin check identity: invalid plugin name "${plugin}"`,
        {
          fix: "Plugin names must be lowercase kebab-case, start with a letter, and must not use the reserved aidlc namespace.",
          id: uniquePluginDoctorFindingId(
            plugin,
            "invalid-identity",
            findingIds,
          ),
          severity: "error",
        },
      ));
      continue;
    }

    const scriptPath = resolve(toolsDir, `${plugin}-doctor.ts`);
    if (!pathContainedBy(toolsDir, scriptPath)) {
      results.push(pluginDoctorResult(
        false,
        `Plugin check (${plugin}): doctor script path escapes the harness tools directory`,
        {
          fix: `Expected the script under ${toolsDir}.`,
          id: uniquePluginDoctorFindingId(
            plugin,
            "script-path-boundary",
            findingIds,
          ),
          severity: "error",
        },
      ));
      continue;
    }
    if (!existsSync(scriptPath)) continue;
    let realToolsDir: string;
    let realScriptPath: string;
    try {
      realToolsDir = realpathSync(toolsDir);
      realScriptPath = realpathSync(scriptPath);
    } catch (e) {
      results.push(pluginDoctorResult(
        false,
        `Plugin check (${plugin}): doctor script path could not be resolved`,
        {
          fix: errorMessage(e),
          id: uniquePluginDoctorFindingId(
            plugin,
            "script-path-resolution",
            findingIds,
          ),
          severity: "error",
        },
      ));
      continue;
    }
    if (!pathContainedBy(realToolsDir, realScriptPath)) {
      results.push(pluginDoctorResult(
        false,
        `Plugin check (${plugin}): doctor script resolves outside the harness tools directory`,
        {
          fix: `Replace ${scriptPath} with a regular file contained by ${toolsDir}.`,
          id: uniquePluginDoctorFindingId(
            plugin,
            "script-realpath-boundary",
            findingIds,
          ),
          severity: "error",
        },
      ));
      continue;
    }

    // Installing a plugin is the trust boundary for its code. Spawn its doctor
    // script directly through Bun (never a shell), following the sensor
    // dispatcher's sibling-script precedent. Sensors fail open because they are
    // advisory runtime checks; doctor fails loud because this is the diagnostic
    // surface users rely on to explain a broken install.
    const startedAt = Date.now();
    // SIGKILL hard-bounds the direct script process. Detached grandchildren can
    // still outlive that process; plugins must not create them.
    const run = spawnSync(process.execPath, [realScriptPath], {
      cwd: projectDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: projectDir,
        AIDLC_HARNESS_DIR: harness,
        AIDLC_PLUGIN_NAME: plugin,
      },
      maxBuffer: PLUGIN_DOCTOR_MAX_BUFFER,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    const elapsedMs = Date.now() - startedAt;
    const spawnCode = (run.error as NodeJS.ErrnoException | undefined)?.code;
    const timedOut =
      spawnCode === "ETIMEDOUT" ||
      (run.signal === "SIGKILL" &&
        elapsedMs >= Math.max(0, timeoutMs - 100));

    if (timedOut) {
      results.push(pluginDoctorResult(
        false,
        `Plugin check (${plugin}): check script timed out after ${timeoutMs}ms`,
        {
          fix: `Inspect or replace ${scriptPath}.`,
          id: uniquePluginDoctorFindingId(
            plugin,
            "script-timeout",
            findingIds,
          ),
          severity: "error",
        },
      ));
      continue;
    }

    if (run.error) {
      results.push(pluginDoctorResult(
        false,
        `Plugin check (${plugin}): check script spawn failed: ${errorMessage(run.error)}`,
        {
          fix: `Verify ${scriptPath} can be run with Bun.`,
          id: uniquePluginDoctorFindingId(
            plugin,
            "script-spawn",
            findingIds,
          ),
          severity: "error",
        },
      ));
      continue;
    }

    if (run.status !== 0) {
      results.push(invalidPluginDoctorOutput(
        plugin,
        scriptPath,
        run.status,
        "The script exited non-zero; repair it and emit only the required JSON object on stdout.",
        uniquePluginDoctorFindingId(
          plugin,
          "script-nonzero",
          findingIds,
        ),
      ));
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof run.stdout === "string" ? run.stdout.trim() : "");
    } catch (e) {
      results.push(invalidPluginDoctorOutput(
        plugin,
        scriptPath,
        run.status,
        `stdout was not valid JSON: ${errorMessage(e)}`,
        uniquePluginDoctorFindingId(
          plugin,
          "script-invalid-json",
          findingIds,
        ),
      ));
      continue;
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.checks)) {
      results.push(invalidPluginDoctorOutput(
        plugin,
        scriptPath,
        run.status,
        `stdout did not contain a checks array matching ${PLUGIN_DOCTOR_REQUIRED_JSON}.`,
        uniquePluginDoctorFindingId(
          plugin,
          "script-invalid-shape",
          findingIds,
        ),
      ));
      continue;
    }

    let malformed = 0;
    let emitted = 0;
    let truncated = 0;
    for (const entry of parsed.checks) {
      if (
        !isPlainObject(entry) ||
        typeof entry.pass !== "boolean" ||
        typeof entry.label !== "string" ||
        (Object.hasOwn(entry, "fix") && typeof entry.fix !== "string") ||
        (Object.hasOwn(entry, "severity") &&
          entry.severity !== "error" &&
          entry.severity !== "advisory")
      ) {
        malformed++;
        continue;
      }
      if (emitted >= PLUGIN_DOCTOR_MAX_ROWS) {
        truncated++;
        continue;
      }

      const label = `Plugin check (${plugin}): ${entry.label}`;
      const fix = typeof entry.fix === "string" ? entry.fix : undefined;
      const id = uniquePluginDoctorFindingId(
        plugin,
        redactSecretPatterns(entry.label),
        findingIds,
      );
      if (entry.pass) {
        results.push(pluginDoctorResult(true, label, {
          fix,
          id,
          severity: "info",
        }));
      } else if (entry.severity === "advisory") {
        results.push(pluginDoctorResult(
          true,
          `${label} (advisory)`,
          {
            fix: fix ?? "review this plugin-provided finding",
            id,
            severity: "warning",
          },
        ));
      } else {
        results.push(pluginDoctorResult(false, label, {
          fix,
          id,
          severity: "error",
        }));
      }
      emitted++;
    }

    if (malformed > 0) {
      results.push(pluginDoctorResult(
        false,
        `Plugin check (${plugin}): ${malformed} malformed check entr${malformed === 1 ? "y" : "ies"} skipped`,
        {
          fix: `Every entry must match ${PLUGIN_DOCTOR_REQUIRED_JSON}.`,
          id: uniquePluginDoctorFindingId(
            plugin,
            "malformed-entries",
            findingIds,
          ),
          severity: "error",
        },
      ));
    }
    if (truncated > 0) {
      results.push(pluginDoctorResult(
        false,
        `Plugin check (${plugin}): ${truncated} check result(s) truncated after ${PLUGIN_DOCTOR_MAX_ROWS} rows`,
        {
          fix: `Reduce the number of checks emitted by ${scriptPath}.`,
          id: uniquePluginDoctorFindingId(
            plugin,
            "truncated-entries",
            findingIds,
          ),
          severity: "error",
        },
      ));
    }
  }
}

function handleDoctor(projectDir: string, flags: Record<string, string> = {}): void {
  const results: DoctorCheckResult[] = [];
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
  const harnessName = runtimeHarnessName(projectDir, harness);
  const isCopilot = harnessName === "copilot";
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
      // "bun $CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-write-audit-log.ts" and the
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

    // Hooks GLOBALLY disabled (issue #802). Every check above verifies the hook
    // files are present and wired, but Claude Code honours `disableAllHooks:
    // true` in any settings layer, which silently skips EVERY hook — audit
    // emission, state sync, sensor dispatch, stage-graph rebuild, the lot. A
    // regulated-industry install (IT policy sets the flag) then passes doctor
    // clean yet blocks at runtime on the first stage: the exact false positive
    // reported. The presence rows can't catch it, so probe the flag explicitly.
    //
    // Resolve it the way Claude Code does — the HIGHEST-precedence layer that
    // sets the key wins — so a lower layer's `true` overridden by a higher
    // layer's `false` does not false-alarm. Precedence (high→low): enterprise
    // managed settings, project settings.local.json, project settings.json,
    // user ~/.claude/settings.json. (The command line can also disable hooks
    // via `--settings '{"disableAllHooks": true}'`, sitting between managed and
    // local, but that is not persisted to a file so it is unprobeable here.)
    //
    // We inspect the on-disk managed-settings file and its alphabetical
    // managed-settings.d fragments. Claude Code can also receive managed policy
    // through channels we cannot read here (MDM, Windows registry, or a
    // remote/server-managed source), so a pass is not a guarantee that every
    // enterprise channel is clean.
    //
    // Managed-settings file location is platform-specific (resolved by the pure,
    // per-platform-tested resolveManagedSettingsCandidates below).
    if (harnessName === "claude") {
      const managedDisableAllHooks = resolveManagedBooleanSetting(
        "disableAllHooks",
        process.platform,
        process.env,
      );
      const home = process.env.HOME || process.env.USERPROFILE || "";
      const MANAGED_LABEL = "enterprise managed settings";
      const hookDisableLayers: Array<[string, string]> = [
        [
          join(projectDir, harness, "settings.local.json"),
          ".claude/settings.local.json",
        ],
        [join(projectDir, harness, "settings.json"), ".claude/settings.json"],
        ...(home
          ? [
              [
                join(home, ".claude", "settings.json"),
                "~/.claude/settings.json",
              ] as [string, string],
            ]
          : []),
      ];
      let hooksDisabledBy: string | null =
        managedDisableAllHooks === true ? MANAGED_LABEL : null;
      if (managedDisableAllHooks === undefined) {
        for (const [path, label] of hookDisableLayers) {
          try {
            const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
              disableAllHooks?: unknown;
            };
            // Only a layer that EXPLICITLY sets the boolean resolves it; a layer
            // that omits the key defers to the next-lower layer.
            if (typeof parsed.disableAllHooks === "boolean") {
              if (parsed.disableAllHooks) hooksDisabledBy = label;
              break; // highest-precedence definition wins, true or false
            }
          } catch {
            // Absent/unreadable/malformed layer — the wiring-config rows own
            // those cases; only an explicit disableAllHooks value matters here.
          }
        }
      }
      // Enterprise managed settings is the highest-precedence layer: nothing
      // in a project or user file can override it.
      const disabledByManaged = hooksDisabledBy === MANAGED_LABEL;
      results.push({
        pass: hooksDisabledBy === null,
        label:
          hooksDisabledBy === null
            ? "Hooks enabled (resolved disableAllHooks is not true)"
            : `Hooks DISABLED via "disableAllHooks": true in ${hooksDisabledBy} — AI-DLC cannot run (audit, state sync, sensors, and stage-graph rebuild are all silently skipped even though the hook files are present)`,
        fix:
          hooksDisabledBy === null
            ? undefined
            : disabledByManaged
              ? `"disableAllHooks": true is enforced by enterprise managed settings — the highest-precedence layer, which a project or user setting cannot override. IT policy must remove it (or set it to false) for AI-DLC to run. If policy mandates disabled hooks, AI-DLC v2 is not compatible with this environment — its workflow engine is hook-driven.`
              : `remove "disableAllHooks": true from ${hooksDisabledBy} (or set it to false in a higher-precedence layer such as .claude/settings.local.json) and restart the Claude Code session — AI-DLC's workflow engine is hook-driven and cannot advance while hooks are disabled.`,
      });

      if (
        resolveManagedBooleanSetting(
          "allowManagedHooksOnly",
          process.platform,
          process.env,
        ) === true
      ) {
        results.push({
          pass: false,
          label: "Claude managed hook policy: allowManagedHooksOnly=true",
          fix: "hooks from .claude/settings.json are blocked by organization policy (allowManagedHooksOnly); only the Claude Code administrator can lift it in managed-settings.json. Until then, the workflow's human-presence and summary-confirmation receipts cannot be minted; attended sessions can set AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 and AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD=1 in the environment that launches the CLI as a temporary bypass",
        });
      }
    }
  } else {
    // Kiro / Codex: the wiring config is not settings.json (it is
    // agents/aidlc.json / hooks.json — checked below). The core hook bodies
    // ship in every tree plus an authored adapter, so probe the explicit roster.
    const tsHooks = [
      "aidlc-write-audit-log",
      "aidlc-sync-workflow-state",
      "aidlc-validate-state",
      "aidlc-log-subagent",
      "aidlc-session-start",
      "aidlc-session-end",
      "aidlc-statusline",
    ];
    if (harness === ".kiro") tsHooks.push("aidlc-kiro-adapter");
    if (harness === ".codex") tsHooks.push("aidlc-codex-adapter");
    if (isCopilot) {
      tsHooks.push(
        "aidlc-state-transition-guard",
        "aidlc-reviewer-scope",
        "aidlc-continue-workflow",
        "aidlc-run-sensors",
        "aidlc-rebuild-stage-graph",
        "aidlc-deliver-stage-rules",
        "aidlc-plan-approval-guard",
        "aidlc-review-freeze",
      );
    }
    if (harness === ".cursor") tsHooks.push("aidlc-cursor-adapter");
    for (const h of tsHooks) {
      const hookPath = join(projectDir, harness, "hooks", `${h}.ts`);
      results.push({
        pass: existsSync(hookPath),
        label: `${h}.ts present`,
        fix: `verify file exists in ${harness}/hooks/`,
      });
    }
    if (harness === ".aidlc") {
      // Two harnesses ship the .aidlc engine dir; the adapter file names the
      // flavor. Copilot: a hooks/ shim inside the engine dir (wired by
      // .github/hooks/aidlc.json). opencode: a plugin in the .opencode shell.
      const copilotAdapter = join(projectDir, harness, "hooks", "aidlc-copilot-adapter.ts");
      if (isCopilot) {
        results.push({
          pass: existsSync(copilotAdapter),
          label: "hooks/aidlc-copilot-adapter.ts present (hook shim)",
          fix: "copy from `dist/copilot/.aidlc/hooks/aidlc-copilot-adapter.ts`",
        });
      } else {
        const adapterPath = join(projectDir, ".opencode", "plugin", "aidlc-opencode-adapter.ts");
        results.push({
          pass: existsSync(adapterPath),
          label: "plugin/aidlc-opencode-adapter.ts present (hook wiring)",
          fix: "copy from `dist/opencode/.opencode/plugin/aidlc-opencode-adapter.ts`",
        });
      }
    }
  }

  // 4. Harness wiring config present. Claude Code: settings.json (hooks +
  // permissions live there). Kiro CLI: agents/aidlc.json plus
  // settings/cli.json; Kiro IDE: agents/aidlc.md. Codex CLI: config.toml +
  // hooks.json (the hook wiring) + rules/default.rules (permissions).
  if (harness === ".kiro") {
    const jsonAgentPath = join(projectDir, harness, "agents", "aidlc.json");
    const markdownAgentPath = join(projectDir, harness, "agents", "aidlc.md");
    const hasJsonAgent = existsSync(jsonAgentPath);
    results.push({
      pass: hasJsonAgent || existsSync(markdownAgentPath),
      label: "agents/aidlc.{json,md} present (conductor wiring)",
      fix: "copy from `dist/kiro/.kiro/agents/aidlc.json` (Kiro CLI) or `dist/kiro-ide/.kiro/agents/aidlc.md` (Kiro IDE)",
    });
    if (hasJsonAgent) {
      const cliSettingsPath = join(projectDir, harness, "settings", "cli.json");
      results.push({
        pass: existsSync(cliSettingsPath),
        label: "settings/cli.json present (workspace default-agent activation)",
        fix: "copy from `dist/kiro/.kiro/settings/cli.json` (or use `kiro-cli chat --agent aidlc`)",
      });
    }
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
    // Minimum Codex version pin (G10): 0.139.0 introduced real role names in
    // SubagentStart/Stop and hyphenated agent-TOML resolution; 0.145.0 also
    // drains compact-source SessionStart hooks immediately after a mid-turn
    // compaction. Older versions either break agent attribution/transposition
    // or let the first post-compaction continuation run without the restored
    // workflow mission.
    const MIN_CODEX = [0, 145, 0] as const;
    const codexVer = Bun.spawnSync(["codex", "--version"], { stdout: "pipe", stderr: "ignore" });
    const verText = (codexVer.stdout?.toString() ?? "").trim();
    const verMatch = verText.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!verMatch) {
      results.push({
        pass: false,
        label: "codex CLI on PATH",
        fix: "install Codex CLI >= 0.145.0 (https://developers.openai.com/codex)",
      });
    } else {
      const v = [Number(verMatch[1]), Number(verMatch[2]), Number(verMatch[3])];
      const ok =
        v[0] > MIN_CODEX[0] ||
        (v[0] === MIN_CODEX[0] &&
          (v[1] > MIN_CODEX[1] || (v[1] === MIN_CODEX[1] && v[2] >= MIN_CODEX[2])));
      results.push({
        pass: ok,
        label: `codex CLI version ${verMatch[0]} >= 0.145.0 (immediate compact-session reload + subagent attribution + agent TOML resolution)`,
        fix: "upgrade Codex CLI to 0.145.0 or later",
      });
    }
    // Hook trust pre-seed reminder (advisory pass-with-label): untrusted
    // project hooks never fire (the bypass flag does not run them either).
    results.push({
      pass: true,
      label:
        "hook trust: ensure [hooks.state] entries are pre-seeded in $CODEX_HOME/config.toml (`bun scripts/package.ts codex trust --project <dir>`) or run one TUI trust pass",
    });
  } else if (harness === ".aidlc" && isCopilot) {
    // Copilot (CLI + VS Code, one install): the wiring config is
    // .github/hooks/aidlc.json; skills and personas ride .github/{skills,agents}.
    for (const [file, what, from] of [
      [".github/hooks/aidlc.json", "hook wiring", "dist/copilot/.github/hooks/aidlc.json"],
      [".github/skills/aidlc/SKILL.md", "/aidlc entry point", "dist/copilot/.github/skills/aidlc/SKILL.md"],
      [".github/agents/aidlc-developer-agent.md", "persona custom agents", "dist/copilot/.github/agents/"],
      ["AGENTS.md", "onboarding + method imports", "dist/copilot/AGENTS.md"],
    ] as const) {
      results.push({
        pass: existsSync(join(projectDir, file)),
        label: `${file} present (${what})`,
        fix: `copy from \`${from}\``,
      });
    }
    // Copilot CLI version floor: 1.0.74 is the line this port was verified
    // against (PascalCase hook registration delivering snake_case payloads,
    // hookSpecificOutput deny honored, SubagentStart/Stop events, and
    // --output-format json). The CLI is optional when only VS Code
    // drives the install, so a missing binary is advisory, not a failure.
    const MIN_COPILOT = [1, 0, 74] as const;
    // Bun.spawnSync THROWS (ENOENT) on a missing executable rather than
    // returning - probe with Bun.which first so a VS Code-only install (no
    // CLI) gets the advisory branch instead of aborting the whole doctor.
    const copilotBin = Bun.which("copilot");
    const copilotVer = copilotBin
      ? Bun.spawnSync([copilotBin, "--version"], { stdout: "pipe", stderr: "ignore" })
      : null;
    const verText = (copilotVer?.stdout?.toString() ?? "").trim();
    const verMatch = verText.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!verMatch) {
      results.push({
        pass: true,
        label:
          "copilot CLI not on PATH — fine when VS Code agent mode drives this install; for CLI use install @github/copilot >= 1.0.74",
      });
    } else {
      const v = [Number(verMatch[1]), Number(verMatch[2]), Number(verMatch[3])];
      const ok =
        v[0] > MIN_COPILOT[0] ||
        (v[0] === MIN_COPILOT[0] &&
          (v[1] > MIN_COPILOT[1] || (v[1] === MIN_COPILOT[1] && v[2] >= MIN_COPILOT[2])));
      results.push({
        pass: ok,
        label: `copilot CLI version ${verMatch[0]} >= 1.0.74 (PascalCase hook registration + deny/block channels verified on this line)`,
        fix: "run `copilot update` or `npm i -g @github/copilot`",
      });
    }
    // Folder trust: untrusted project hooks silently never fire (no warning
    // anywhere on the Copilot side — the doctor is the only surface that says
    // so). trustedFolders lives in ~/.copilot/config.json (COPILOT_HOME).
    // Tolerances, all field-observed: the CLI writes JSONC (line/block/inline
    // comments plus trailing commas), entries may carry trailing
    // slashes, and the project may be reached via a symlink (compare
    // realpath-normalized). An absent config is ADVISORY because a VS
    // Code-only install has no CLI config; an existing unreadable or malformed
    // config fails because CLI hook trust cannot be verified.
    try {
      const configPath = join(
        process.env.COPILOT_HOME ?? join(process.env.HOME ?? "", ".copilot"),
        "config.json",
      );
      if (!existsSync(configPath)) {
        results.push({
          pass: true,
          label:
            "~/.copilot/config.json absent — fine for VS Code-only installs; for the CLI, one interactive run records folder trust (hooks silently no-op untrusted)",
        });
      } else {
        const raw = readFileSync(configPath, "utf-8");
        const trusted =
          (Bun.JSONC.parse(raw) as { trustedFolders?: string[] }).trustedFolders ?? [];
        const norm = (p: string) => {
          let out = p.replace(/[/\\]+$/, "");
          try {
            out = realpathSync(out);
          } catch {
            // keep the trimmed form — a recorded-but-deleted path never matches
          }
          return out;
        };
        const projectNorm = norm(projectDir);
        results.push({
          pass: trusted.some((t) => norm(t) === projectNorm),
          label:
            "project folder in ~/.copilot/config.json trustedFolders (CLI hooks silently no-op without it)",
          fix: `add "${projectDir}" to trustedFolders in ~/.copilot/config.json (or accept the CLI's interactive trust prompt)`,
        });
      }
    } catch {
      results.push({
        pass: false,
        label:
          "could not parse ~/.copilot/config.json to verify folder trust (CLI hooks silently no-op untrusted)",
        fix:
          "repair ~/.copilot/config.json as valid JSONC, then re-run doctor",
      });
    }
    // Headless reminder (advisory pass-with-label): -p/prompt-mode runs skip
    // repo hooks unless the env var opts in.
    results.push({
      pass: true,
      label:
        "headless runs: set GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=1 for `copilot -p` sessions — repo hooks are off by default in prompt mode",
    });
  } else if (harness === ".cursor") {
    // Cursor: hooks.json (the hook wiring), cli.json (permissions), and the
    // standing + phase method rule pointers are all inside .cursor/.
    for (const [file, what, from] of [
      ["hooks.json", "hook wiring", "dist/cursor/.cursor/hooks.json"],
      ["cli.json", "Shell(bun) permission pre-approval", "dist/cursor/.cursor/cli.json"],
      ["rules/aidlc.mdc", "standing method rule (alwaysApply read instruction)", "dist/cursor/.cursor/rules/aidlc.mdc"],
      ["rules/aidlc-phase-ideation.mdc", "Ideation phase rule (agent-decided read instruction)", "dist/cursor/.cursor/rules/aidlc-phase-ideation.mdc"],
      ["rules/aidlc-phase-inception.mdc", "Inception phase rule (agent-decided read instruction)", "dist/cursor/.cursor/rules/aidlc-phase-inception.mdc"],
      ["rules/aidlc-phase-construction.mdc", "Construction phase rule (agent-decided read instruction)", "dist/cursor/.cursor/rules/aidlc-phase-construction.mdc"],
      ["rules/aidlc-phase-operation.mdc", "Operation phase rule (agent-decided read instruction)", "dist/cursor/.cursor/rules/aidlc-phase-operation.mdc"],
    ] as const) {
      results.push({
        pass: existsSync(join(projectDir, harness, file)),
        label: `${file} present (${what})`,
        fix: `copy from \`${from}\``,
      });
    }
  } else if (harness === ".aidlc") {
    // opencode: the wiring config is the project-root opencode.json/jsonc
    // (permissions + the method-include instructions glob) plus the /aidlc
    // command entry; the plugin adapter is checked with the hook roster above.
    const opencodeJson = join(projectDir, "opencode.json");
    const opencodeJsonc = join(projectDir, "opencode.jsonc");
    results.push({
      pass: existsSync(opencodeJson) || existsSync(opencodeJsonc),
      label: "opencode.json or opencode.jsonc present (permissions + method instructions glob)",
      fix: "copy `dist/opencode/opencode.json` beside .opencode/, or merge it into opencode.jsonc",
    });
    results.push({
      pass: existsSync(join(projectDir, ".opencode", "command", "aidlc.md")),
      label: ".opencode/command/aidlc.md present (/aidlc entry point)",
      fix: "copy from `dist/opencode/.opencode/command/aidlc.md`",
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
  const otherTrees = [".claude", ".kiro", ".codex", ".aidlc", ".cursor"].filter(
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
    const missingPluginStages: string[] = [];
    const stageSources = new Map<
      string,
      { path: string; content: string; parsed: Record<string, unknown> }
    >();
    const stagesRoot = resolveHarnessPath(["aidlc-common", "stages"]);
    for (const phase of PHASES) {
      const dir = join(stagesRoot, phase);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
        const path = join(dir, f);
        try {
          const content = readFileSync(path, "utf-8");
          const parsed = parseStageFrontmatter(content) as Record<string, unknown>;
          const slug = typeof parsed.slug === "string" ? parsed.slug : f.replace(/\.md$/, "");
          const plugin = typeof parsed.plugin === "string" ? parsed.plugin : undefined;
          const stagePhase = typeof parsed.phase === "string" ? parsed.phase : phase;
          stageSources.set(slug, { path, content, parsed });
          if (
            expectedEnabledBySelection({ plugin, phase: stagePhase }) &&
            !graphSlugs.has(slug)
          ) {
            missingEnabled.push(`${slug} (${path})`);
            if (plugin) missingPluginStages.push(`${plugin}: stage ${slug}`);
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

    const missingComposition: string[] = [...missingPluginStages];
    const dataDir = resolveHarnessPath(["tools", "data"]);
    if (existsSync(dataDir)) {
      for (const file of readdirSync(dataDir).filter((name) =>
        /^plugin-contrib-.+\.json$/.test(name)
      ).sort()) {
        const plugin = file.replace(/^plugin-contrib-/, "").replace(/\.json$/, "");
        if (!isPluginEnabled(plugin)) continue;
        const sidecar = join(dataDir, file);
        let manifest: Record<string, StageContribRecord>;
        try {
          const parsed = JSON.parse(readFileSync(sidecar, "utf-8"));
          if (!isPlainObject(parsed)) throw new Error("expected a JSON object");
          manifest = parsed as Record<string, StageContribRecord>;
        } catch (e) {
          missingComposition.push(
            `${plugin}: contribution sidecar ${sidecar} is unreadable or invalid (${errorMessage(e)}); refresh the stock engine and remove the invalid sidecar before syncing`,
          );
          continue;
        }
        if (Object.keys(manifest).length === 0) {
          missingComposition.push(
            `${plugin}: contribution sidecar ${sidecar} has no stage records; refresh the stock engine and remove the invalid sidecar before syncing`,
          );
          continue;
        }
        for (const [target, record] of Object.entries(manifest).sort(([a], [b]) =>
          a.localeCompare(b)
        )) {
          const invalid = contributionRecordError(record);
          if (invalid) {
            missingComposition.push(
              `${plugin}: contribution sidecar ${sidecar} target ${target} is invalid (${invalid}); refresh the stock engine and remove the invalid sidecar before syncing`,
            );
            continue;
          }
          const source = stageSources.get(target);
          if (!source) {
            missingComposition.push(
              `${plugin}: contribution sidecar ${sidecar} target ${target} has no installed stage source; restore a compatible engine or plugin version before syncing`,
            );
            continue;
          }
          const missing = missingRecordedContributions(
            source.parsed,
            source.content,
            plugin,
            record as StageContribRecord,
          );
          if (missing.length > 0) {
            missingComposition.push(
              `${plugin}: stage ${target} (${source.path}) missing ${missing.join("; ")}`,
            );
          }
        }
      }
    }
    results.push({
      pass: missingComposition.length === 0,
      label: missingComposition.length === 0
        ? "Composed plugin surface: all enabled plugin stages and recorded contributions are present"
        : `Composed plugin surface: ${missingComposition.length} missing composition item(s)`,
      fix: missingComposition.length > 0
        ? `${missingComposition.join("; ")} - correct any sidecar or target issue named above, then re-run \`/aidlc plugin sync\` (or \`bun ${harnessDir()}/tools/aidlc-utility.ts plugin-sync\` with the plugin root environment set). Hook-carrying hosts retry sync on the next session start.`
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

  // 4d. Optional plugin-authored install diagnostics. Discovery is
  // selection-aware, so a disabled plugin's executable check remains inert.
  try {
    appendPluginDoctorChecks(results, projectDir);
  } catch (e) {
    results.push({
      pass: false,
      label: "Plugin checks: discovery failed",
      fix: errorMessage(e),
    });
  }

  // 5. Workspace shell ready (P4: no --init artifact to check). With auto-create
  // there is no scaffolded aidlc-docs/ to verify; readiness is the SHIPPED SHELL
  // the user copies from dist/: the harness engine dir (.claude/.kiro/.codex)
  // present AND the default space's memory dir present (the source of truth the
  // native include resolves). When both are present the first /aidlc auto-creates
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

  // Read across every per-clone audit shard (single shard in the common case).
  // Both hook-health and state-drift checks use the same intent-scoped ledger.
  const auditAllShards = readAllAuditShards(projectDir);
  const auditShardEvents = readAuditShardEvents(projectDir);
  const stateMdPath = stateFilePath(projectDir);
  let stateContent = "";
  try {
    if (existsSync(stateMdPath)) {
      stateContent = readFileSync(stateMdPath, "utf-8");
    }
  } catch {
    // An unreadable state contributes no progress evidence; audit remains usable.
  }
  const stateProgressedStages = new Set(
    parseCheckboxes(stateContent)
      .filter((entry) => entry.state !== "pending")
      .map((entry) => entry.slug),
  );
  const stageOrGateEvents = auditShardEvents.filter(
    (event) => event.event.startsWith("STAGE_") || event.event.startsWith("GATE_"),
  );
  let newestStageOrGateEvent: {
    timestampMs: number;
    timestampRaw: string;
  } | null = null;
  for (const event of stageOrGateEvents) {
    const timestampMs = Date.parse(event.timestamp);
    if (
      Number.isFinite(timestampMs) &&
      (newestStageOrGateEvent === null ||
        timestampMs > newestStageOrGateEvent.timestampMs)
    ) {
      newestStageOrGateEvent = {
        timestampMs,
        timestampRaw: event.timestamp,
      };
    }
  }
  const auditProgressedStages = new Set(
    stageOrGateEvents
      .map(
        (event) =>
          auditBlockField(event.block, "Stage") ??
          auditBlockField(event.block, "Slug"),
      )
      .filter((slug): slug is string => slug !== null),
  );
  const progressedStageCount = Math.max(
    stateProgressedStages.size,
    auditProgressedStages.size,
  );
  const workflowHasProgress = progressedStageCount > 0;
  const workflowStageStarted = auditAllShards.includes("**Event**: STAGE_STARTED");
  const hookExecutionRecovery =
    harnessName === "claude"
      ? HOOK_EXECUTION_RECOVERY
      : "verify this harness's hook registration or trust configuration, then fully restart the harness before resuming the workflow";

  // 6. Hook heartbeats
  // Three states, discriminated by health-dir presence, readable heartbeats,
  // and evidence that the workflow advanced in the same intent-scoped ledger:
  //   (a) .aidlc-hooks-health/ missing entirely, or present without .last files
  //       before workflow progress → hooks have not had a chance to fire. Pass.
  //       This preserves debug-only dirs and ignores doctor's HEALTH_CHECKED.
  //   (b) No readable heartbeat after progress, or unreadable .last files →
  //       hooks should have fired. Fail.
  //   (c) Readable .last files exist → compare the newest one to progress.
  const healthDir = hooksHealthDir(projectDir);
  const heartbeatEntries: string[] = [];
  let newestHeartbeat: { timestampMs: number; timestampRaw: string } | null =
    null;
  const heartbeatDirExists = existsSync(healthDir);
  // Track .last presence separately from readable entries so an unreadable
  // heartbeat file remains a failure instead of looking like a fresh install.
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
          const timestampMs = Date.parse(ts);
          if (
            Number.isFinite(timestampMs) &&
            (newestHeartbeat === null || timestampMs > newestHeartbeat.timestampMs)
          ) {
            newestHeartbeat = { timestampMs, timestampRaw: ts };
          }
        } catch {
          // skip unreadable
        }
      }
    } catch {
      // skip unreadable dir
    }
  }
  if (heartbeatEntries.length > 0) {
    if (
      newestHeartbeat !== null &&
      newestStageOrGateEvent !== null &&
      newestStageOrGateEvent.timestampMs - newestHeartbeat.timestampMs >
        HOOK_HEARTBEAT_STALE_SLACK_MS
    ) {
      results.push({
        pass: false,
        label: `Hooks last fired ${newestHeartbeat.timestampRaw}, but the workflow last advanced ${newestStageOrGateEvent.timestampRaw}`,
        fix: hookExecutionRecovery,
      });
    } else {
      results.push({
        pass: true,
        label: `Hooks last fired: ${heartbeatEntries.join(", ")}`,
      });
    }
  } else if (
    !heartbeatDirExists &&
    workflowHasProgress
  ) {
    const stages = progressedStageCount === 1 ? "stage" : "stages";
    results.push({
      pass: false,
      label: `Hooks have never executed although this workflow has progressed ${progressedStageCount} ${stages}`,
      fix: hookExecutionRecovery,
    });
  } else if (
    heartbeatDirExists &&
    !hasHookFiredContent &&
    workflowStageStarted
  ) {
    results.push({
      pass: false,
      label: "Hook heartbeat data",
      fix: "health dir exists and the ledger shows STAGE_STARTED, but no hook has ever fired — verify hooks are registered in settings.json",
    });
  } else if (
    !heartbeatDirExists ||
    (!hasHookFiredContent && !workflowStageStarted)
  ) {
    // (a) fresh install, pre-created dir, or debug-only dir before progress.
    results.push({
      pass: true,
      label: "Hook heartbeats: not yet fired (first workflow stage will populate)",
    });
  } else {
    // (b) heartbeat files exist but are unreadable.
    results.push({
      pass: false,
      label: "Hook heartbeat data",
      fix: "health dir exists but heartbeat files are unreadable — verify permissions and hook registration",
    });
  }

  if (
    stageOrGateEvents.length > 0 &&
    !auditShardEvents.some((event) => event.event === "HUMAN_TURN")
  ) {
    results.push({
      pass: true,
      label: `Human-turn receipts: 0 HUMAN_TURN rows across ${stageOrGateEvents.length} stage/gate event(s) (advisory) - receipts are not being minted, so presence-gated checkpoints will refuse`,
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

  // Leaked-lock probe (P3 reaper surface). Doctor automatically clears only a
  // provably-dead valid owner or an old genuinely-missing stamp. Live,
  // malformed, and unreadable owners fail closed and require quiescent manual
  // recovery.
  try {
    const leaks = detectLeakedLocks(projectDir, true);
    if (leaks.length === 0) {
      results.push({ pass: true, label: "Runtime locks: none leaked" });
    } else {
      for (const leak of leaks) {
        const subject = leak.kind === "audit" ? "audit lock"
          : leak.kind === "active-directive" ? "active-directive lock"
          : leak.kind === "coordination-gate" ? "lock coordination gate"
          : "legacy active-directive transaction";
        const outcome = leak.cleared ? "cleared" : "not cleared";
        const manual = !leak.cleared;
        results.push({
          pass: false,
          label: `Leaked ${subject} on bucket "${leak.bucket}" (${leak.reason}${leak.ownerPid !== null ? `, pid ${leak.ownerPid}` : ""}) — ${outcome}`,
          fix: manual
            ? `stop all AI-DLC processes, inspect ${leak.lockDir}, then remove or restore it under quiescence`
            : "the stale lock was cleared automatically; re-run your /aidlc command",
        });
      }
    }
  } catch {
    // Lock-probe failure is non-fatal for the doctor report.
  }

  // State version check — v8 reshapes the Inception design graph:
  // `application-design` is renamed to `domain-design` and a new
  // `contract-design` stage is inserted, so a pre-v8 state file carries
  // stage-progress rows keyed by slugs that no longer exist in the graph.
  // Advancing such a state hits `emitRunStageForSlug()` on a missing slug
  // (or silently no-ops a checkbox while `Current Stage` moves on, then
  // fails in `report`). The framework ships no user-visible migration
  // pre-1.0, so fail loud here with archive-and-reinit guidance rather than
  // let a stale-graph state look healthy.
  if (existsSync(stateMdPath)) {
    try {
      const stateContent = readFileSync(stateMdPath, "utf-8");
      // Shared classifier (aidlc-lib.ts): the SAME parse + branch selection the
      // runtime guard uses, so doctor and next/report never disagree on whether
      // a state is unparseable / past / future / ok. Doctor's per-branch rows
      // let a human see WHICH kind of incompatibility the state hit rather
      // than routing everything through a generic "not current" line.
      const verdict = classifyStateVersion(stateContent);
      if (verdict.kind === "unparseable") {
        results.push({
          pass: false,
          label: "state version readable",
          fix: verdict.message,
        });
      } else if (verdict.kind === "past") {
        results.push({
          pass: false,
          label: "state version current",
          fix: verdict.message,
        });
      } else if (verdict.kind === "future") {
        results.push({
          pass: false,
          label: "state version compatible",
          fix: verdict.message,
        });
      } else {
        results.push({
          pass: true,
          label: `State Version: ${CURRENT_STATE_VERSION}`,
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

  // A long-open approval gate is healthy waiting, not a hung workflow. Surface
  // it as an advisory PASS so operators can distinguish human latency from a
  // stuck engine without changing doctor's exit code.
  try {
    if (existsSync(stateMdPath)) {
      const stateContent = readFileSync(stateMdPath, "utf-8");
      const currentStage = getField(stateContent, "Current Stage");
      const currentCheckbox = currentStage
        ? parseCheckboxes(stateContent).find((c) => c.slug === currentStage)
        : undefined;
      if (currentStage && currentCheckbox?.state === "awaiting-approval") {
        const pending = pendingOrganicGate(auditShardEvents, currentStage);
        if (pending) {
          const ageMs = Date.now() - pending.timestampMs;
          if (ageMs > GATE_PENDING_ADVISORY_MS) {
            const displayName =
              loadStageGraph().find((stage) => stage.slug === currentStage)?.name ??
              currentStage;
            const duration = pendingDuration(ageMs);
            results.push({
              pass: true,
              label:
                `Approval gate pending: ${displayName} (~${duration}); ` +
                "waiting for a human, not stuck. Run /aidlc --status to review the current gate.",
              fix: "run `/aidlc --status` to review and resolve the pending approval",
            });
          }
        }
      }
    }
  } catch {
    // Gate-pending probe failure is non-fatal for the doctor report.
  }

  // Background-subagent ledger probe. Fresh entries are expected while
  // accepted run_in_background dispatches are active, so they are advisory.
  // Stale or malformed entries fail with manual remediation. Read-only: doctor
  // never rewrites the ledger; the Stop hook prunes stale entries.
  try {
    const subagents = inspectSubagentInflight(projectDir);
    if (subagents.exists) {
      const ageMs = subagents.oldestAgeMs ?? 0;
      const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
      const ageLabel = ageHours >= 1 ? `${ageHours}h old` : "under 1h old";
      const countLabel = subagents.malformed
        ? "malformed"
        : `${subagents.freshCount} fresh, ${subagents.staleCount} stale, oldest ${ageLabel}`;
      results.push({
        pass: !subagents.malformed && subagents.staleCount === 0,
        label: `Background-subagent ledger present (aidlc/.aidlc-subagent-inflight, ${countLabel})`,
        fix: "if no background subagent is actually running, delete it ('rm aidlc/.aidlc-subagent-inflight'). Stale or malformed entries never authorize the Stop hook, but the ledger should not linger.",
      });
    }
  } catch {
    // Background-subagent ledger probe failure is non-fatal for doctor.
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
  // One surface remains deferred to a future release:
  //   - orphan `Merge-Held: true` reconciliation (graph traversal, not a
  //     check; needs workshop-resume false-positive guard)
  // ===========================================================================

  const auditMd = auditAllShards;
  const stateMd = existsSync(stateMdPath) ? readFileSync(stateMdPath, "utf-8") : "";
  const boltRefs = stateMd
    ? parseRefsList(getField(stateMd, "Bolt Refs") ?? "")
    : [];

  // Team claim reconciliation stays local-only. Registry refs are read from
  // local refs/cache; doctor never fetches and never releases a claim. The
  // presence gate preserves exact dormancy for workspaces that have never
  // enabled team Unit ownership while retaining orphan detection after a team
  // intent is removed but its local cache or checkout stamp remains.
  const teamClaimDiagnostics =
    readUnitScopeStamp(projectDir) !== null ||
    readUnitClaimRegistryCache(projectDir) !== null ||
    listSpaces(projectDir).some((space) =>
      listIntents(projectDir, space.name).some((intent) => {
        if (!intent.dirName) return false;
        try {
          return isTeamUnitOwnership(
            readStateFile(projectDir, intent.dirName, space.name),
          );
        } catch {
          return false;
        }
      })
    );
  if (teamClaimDiagnostics) {
    try {
    const overviewForIdentity = (
      space: string,
      intentUuid: string,
    ): ReturnType<typeof cachedUnitClaimOverview> | null => {
      const intent = listIntents(projectDir, space).find(
        (candidate) =>
          candidate.uuid === intentUuid &&
          candidate.dirName !== null,
      );
      if (!intent?.dirName) return null;
      try {
        return localUnitClaimOverviewForIntent(projectDir, {
          space,
          intentUuid,
          stateContent: readStateFile(projectDir, intent.dirName, space),
          dependencyBody: readFileSync(
            unitDependencyPath(projectDir, intent.dirName, space),
            "utf-8",
          ),
        });
      } catch {
        return null;
      }
    };
    const stamp = readUnitScopeStamp(projectDir);
    if (stamp) {
      const overview = overviewForIdentity(
        stamp.space,
        stamp.intent_uuid,
      );
      const current = overview?.claims.get(stamp.unit);
      if (
        current &&
        (
          current.status === "released" ||
          current.generation !== stamp.generation ||
          current.nonce !== stamp.nonce
        )
      ) {
        results.push({
          pass: false,
          label:
            `Unit claim stamp stale: ${stamp.unit} generation ${stamp.generation} is tombstoned or superseded`,
          fix:
            `the checkout stamp may linger after release; preserve any useful work, then delete ${join("aidlc", ".aidlc-unit-scope.json")} and re-claim explicitly`,
        });
      }
    }

    const claimCache = readUnitClaimRegistryCache(projectDir);
    if (claimCache) {
      const now = Date.now();
      const observedOverview = overviewForIdentity(
        claimCache.space,
        claimCache.intent_uuid,
      );
      const observedClaims = [...(observedOverview?.claims.values() ?? [])]
        .filter((claim) => claim.status === "claimed")
        .filter((claim) => !claim.movementObserved);
      const missingObservation = observedClaims
        .filter(
          (claim) =>
            !claim.observedAt ||
            Number.isNaN(Date.parse(claim.observedAt)),
        )
        .map((claim) => claim.unit)
        .sort();
      if (missingObservation.length > 0) {
        results.push({
          pass: true,
          label:
            `Unit claim activity baseline missing (advisory): ${missingObservation.join(", ")} - run /aidlc --status after the next explicit fetch to establish a local observed-ref timestamp`,
        });
      }
      const staleActivity = observedClaims
        .filter(
          (claim) =>
            !!claim.observedAt &&
            !Number.isNaN(Date.parse(claim.observedAt)),
        )
        .filter((claim) => {
          const observed = Date.parse(claim.observedAt!);
          return now - observed >
            CLAIM_ACTIVITY_STALE_HOURS * 60 * 60 * 1000;
        })
        .map((claim) => claim.unit)
        .sort();
      if (staleActivity.length > 0) {
        results.push({
          pass: false,
          label:
            `Unit claim activity: ${staleActivity.length} claim(s) with no observed ref movement for ${CLAIM_ACTIVITY_STALE_HOURS}h (${staleActivity.join(", ")}) - report only; inspect the team checkout and release only after a human decision`,
          fix:
            "inspect the owning checkout and candidate history; release only after a human confirms the attempt is abandoned",
        });
      }
    }

    const refs = spawnSync(
      "git",
      [
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/claim/",
        "refs/remotes/",
      ],
      {
        cwd: projectDir,
        encoding: "utf-8",
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      },
    );
    if ((refs.status ?? 1) === 0) {
      const knownIntentIds = new Set<string>();
      for (const space of listSpaces(projectDir)) {
        for (const intent of listIntents(projectDir, space.name)) {
          if (intent.uuid) knownIntentIds.add(idSuffix(intent.uuid));
        }
      }
      const orphanRefs = [
        ...new Set(
          (refs.stdout ?? "")
            .split(/\r?\n/)
            .map((ref) => ({
              ref,
              id8:
                /^refs\/heads\/claim\/([^/]+)\/[^/]+$/.exec(ref)?.[1] ??
                /^refs\/remotes\/[^/]+\/claim\/([^/]+)\/[^/]+$/.exec(ref)?.[1],
            }))
            .filter(
              (row): row is { ref: string; id8: string } =>
                !!row.id8 && !knownIntentIds.has(row.id8),
            )
            .map((row) => row.ref),
        ),
      ].sort();
      if (orphanRefs.length > 0) {
        results.push({
          pass: false,
          label:
            `Orphan Unit claim refs: ${orphanRefs.length} ref(s) match no local intent (${orphanRefs.join(", ")})`,
          fix:
            "confirm the intent was removed or renamed, preserve any candidate commit needed for salvage, then delete the orphan refs manually",
        });
      }
    }
    } catch {
      // Claim reconciliation is additive; existing doctor checks still render.
    }
  }

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
      fix = `${parts.join("; ")}. Inspect, then remove via 'aidlc-worktree discard --slug <slug>'.`;
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
        : `MERGE_DISPATCH: ${orphans} orphan INVOKED (advisory - a merge started but no matching finish was recorded within ${MERGE_DISPATCH_TIMEOUT_SEC}s)`,
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
    const uncompiledPluginStages: string[] = [];
    if (uncompiledStages.length > 0) {
      const uncompiled = new Set(uncompiledStages);
      const stagesRoot = resolveHarnessPath(["aidlc-common", "stages"]);
      for (const phase of PHASES) {
        const dir = join(stagesRoot, phase);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
          const fallbackSlug = file.replace(/\.md$/, "");
          if (!uncompiled.has(fallbackSlug)) continue;
          try {
            const parsed = parseStageFrontmatter(readFileSync(join(dir, file), "utf-8"));
            const slug = typeof parsed.slug === "string" ? parsed.slug : fallbackSlug;
            const plugin = typeof parsed.plugin === "string" ? parsed.plugin : undefined;
            if (plugin) uncompiledPluginStages.push(`${slug} (${plugin})`);
          } catch {
            // Schema validation below owns malformed frontmatter.
          }
        }
      }
    }
    const uncompiledHint = uncompiledPluginStages.length > 0
      ? ` - plugin-owned files ${uncompiledPluginStages.join(", ")} require \`/aidlc plugin sync\` (or \`bun ${harnessDir()}/tools/aidlc-utility.ts plugin-sync\` with the plugin root environment set); run \`bun ${harnessDir()}/tools/aidlc-graph.ts compile\` for other authored stages`
      : ` - run \`bun ${harnessDir()}/tools/aidlc-graph.ts compile\` to include them`;
    results.push({
      pass: true,
      label: uncompiledStages.length === 0
        ? "Uncompiled stage files: 0 stage files missing from the compiled graph"
        : `Uncompiled stage files: ${uncompiledStages.length} stage file(s) not in the compiled graph (advisory, will not execute until recompiled): ${uncompiledStages.join(", ")}${uncompiledHint}`,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Orphan stage files: check failed",
      fix: errorMessage(e),
    });
  }

  // Scope validation — run validateScope over all 11 scopes, tally errors
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
    const stagesDir = resolveHarnessPath(["aidlc-common", "stages"]);
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

  // Advisory only: runtime resolves producersOf(artifact)[0], so duplicate
  // producers are deterministic but ambiguous rather than an immediate setup
  // failure. Keep all actionable detail in the label because passing rows do
  // not render their `fix` field.
  try {
    const collisions = consumedArtifactProducerCollisions();
    results.push({
      pass: true,
      label: collisions.length === 0
        ? "Duplicate producers: every consumed artifact has a single producer"
        : `Duplicate producers: ${collisions.length} consumed artifact(s) with multiple producers (advisory); runtime resolves the first by load order: ${collisions.map(({ artifact, producers }) => `"${artifact}" <- [${producers.join(", ")}]`).join("; ")} - re-run \`bun ${harnessDir()}/tools/aidlc-graph.ts compile\``,
    });
  } catch (e) {
    results.push({
      pass: false,
      label: "Duplicate producers: check failed",
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
      const staleSuppressed: Array<{ file: string; heading: string; orgSentence: string }> = [];
      const today = new Date().toISOString().slice(0, 10);
      for (const rule of rules) {
        if (rule.scope !== "team" && rule.scope !== "project") continue;
        const stale = isRuleStale(rule.frontmatter, today);
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
          const overlap = { file: rule.path, heading: h, orgSentence };
          if (stale) {
            staleSuppressed.push(overlap);
          } else {
            drifts.push(overlap);
          }
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
      if (staleSuppressed.length > 0) {
        const detail = staleSuppressed
          .map((d) => `${d.file} ## ${d.heading} ⇄ org "${d.orgSentence}"`)
          .join("; ");
        results.push({
          pass: true,
          label: `Rule drift: ${staleSuppressed.length} stale-suppressed: ${detail}`,
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
  // read-only. Doctor runs on a fresh checkout before any workflow is created, so
  // it must create nothing. On a project with a created intent the emit fires
  // exactly as before (BARE appendAuditEvent — the only throw is a real write
  // failure, which the rest of the codebase lets propagate).
  let pairedRuleCount: number | null = null;
  try {
    const pairedRules = loadRules();
    pairedRuleCount = pairedRules.length;
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
  } catch (e) {
    results.push({
      pass: false,
      label: "Paired sensor coverage: check failed",
      fix: errorMessage(e),
    });
  }

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

  try {
    const shadows: string[] = [];
    for (const sp of listSpaces(projectDir)) {
      if (RESERVED_RECORD_NAMES.has(sp.name)) shadows.push(`space '${sp.name}'`);
    }
    const active = activeSpace(projectDir);
    for (const intent of listIntents(projectDir, active)) {
      if (RESERVED_RECORD_NAMES.has(intent.slug)) shadows.push(`intent '${intent.slug}'`);
    }
    if (shadows.length > 0) {
      results.push({
        pass: true,
        label: `Workspace names shadowing grammar verbs (advisory): ${shadows.join(", ")} - reachable via explicit switch; consider renaming.`,
      });
    }
  } catch {
    // Advisory only; a scan failure must not hide the main doctor report.
  }

  // Workspace-manifest rows (W1: uncommitted records; W2: repos.json vs disk
  // drift; W3: stale managed .gitignore block). All advisory (pass:true) so
  // they never change the exit code; W2/W3 only emit when a repos.json manifest
  // exists, avoiding manifest-specific rows on a single-repo install.
  try {
    for (const row of workspaceManifestChecks(projectDir)) results.push(row);
  } catch {
    // Advisory only; a scan failure must not hide the main doctor report.
  }

  // Cold-safe gate: only emit audit when an audit trail already exists. On a
  // pristine project (no audit shard / flat audit.md) doctor prints its health
  // report and creates NOTHING — it stays a pure read-only diagnostic. On an
  // initialized project both GUARDRAIL_LOADED and HEALTH_CHECKED emit as before.
  const auditExists = auditShards(projectDir).length > 0;

  if (auditExists && pairedRuleCount !== null) {
    appendAuditEvent(projectDir, "GUARDRAIL_LOADED", {
      Scope: "all",
      Path: `${harnessDir()}/${rulesSubdir()}/`,
      "Rule count": String(pairedRuleCount),
    });
  }

  // One fresh analysis, shared by the live report AND the --export writer
  // (issue #575, Arden #3): the structured condition->remedy findings and the
  // reconstructed timeline are computed ONCE here. A plain --doctor renders
  // these findings alongside the legacy check rows, so gate-unresolved /
  // runtime-graph-stale / cold-hook and the rest surface live too - the live
  // output and the export can never diverge. The analysis performs no writes.
  const analysis = runDoctorAnalysis(projectDir);

  // Print report
  let output = "AI-DLC Health Check\n";
  output += `${"\u2500".repeat(37)}\n`;
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.pass) {
      output += `\u2713  ${r.label}`;
      if (r.severity === "warning" && r.fix) output += ` \u2014 ${r.fix}`;
      output += "\n";
      passed++;
    } else {
      output += `\u2717  ${r.label}`;
      if (r.fix) output += ` — ${r.fix}`;
      output += "\n";
      failed++;
    }
  }
  // Structured diagnosis findings (workflow timeline analysis) are ADVISORY and
  // never change doctor's exit code: they render for visibility but do not count
  // toward `failed`. Only the legacy environment/config checks above drive the
  // exit status, so a plain `/aidlc --doctor` keeps its pre-existing contract \u2014
  // a workflow-level diagnosis (which can be a soft, workflow-in-progress signal)
  // must not flip the exit code that CI and scripts gate on. Info is omitted from
  // the live view to keep it terse; the export carries the full set.
  const diagErrors = analysis.findings.filter((f) => f.severity === "error");
  const diagWarnings = analysis.findings.filter((f) => f.severity === "warning");
  if (diagErrors.length > 0 || diagWarnings.length > 0) {
    output += `${"\u2500".repeat(37)}\n`;
    output += "Workflow diagnosis (advisory):\n";
    for (const f of diagErrors) {
      output += `\u2717  [${f.id}] ${f.summary}`;
      if (f.remedy) output += ` (${f.remedy})`;
      output += "\n";
    }
    for (const f of diagWarnings) {
      output += `!  [${f.id}] ${f.summary}\n`;
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

  // --export: after the live report, write a redacted diagnostic report from
  // the SAME analysis this run already computed (issue #575). No second read,
  // no cached diagnosis. The export write never changes doctor's exit code.
  // `--export` is a bare boolean flag; accept it whether the arg parser recorded
  // it as "true" (bare) or a stray token followed it, so a trailing word can
  // never silently disable the export.
  if ("export" in flags) {
    try {
      const tsToken = fsSafeTimestamp();
      // A bare `--output` (no value) parses to "true"; treat that as an error
      // rather than creating a directory literally named "true".
      if (flags.output === "true") {
        throw new Error("--output requires a directory path (e.g. --output /tmp/aidlc-report)");
      }
      const outParent = flags.output
        ? flags.output
        : join(projectDir, "aidlc", "diagnostics");
      mkdirSync(outParent, { recursive: true });
      // Merge the legacy environment/config checks (bun present, hooks wired,
      // settings intact) into the exported analysis so report.md/report.json
      // carry the SAME findings the live report shows — the bundle exists so
      // the maintainer does NOT need the user's project, so a failing env check
      // must reach it. The live render (above) and the exit code are untouched;
      // this only enriches what buildBundle serializes. (Arden round-3 #1.)
      const analysisForExport = {
        ...analysis,
        findings: mergeFindings(results.map(adaptLegacyResult), analysis.findings),
      };
      const report = buildBundle(outParent, analysisForExport, tsToken);
      let out = "\nDiagnostic report created:\n";
      out += `  ${report.archivePath ?? report.bundleDir}\n\n`;
      out += "Findings:\n";
      const topFindings = report.findings.filter((f) => f.severity !== "info").slice(0, 20);
      if (topFindings.length === 0) {
        out += "  (no errors or warnings)\n";
      } else {
        for (const f of topFindings) out += `  ${f.severity.toUpperCase()} ${f.id}\n`;
      }
      out += "\nNo source files or artifact bodies were included.\n";
      if (report.manualShareNote) out += `\n${report.manualShareNote}\n`;
      process.stdout.write(out);
    } catch (e) {
      // Export failure must not mask the live doctor result; report and go on.
      process.stdout.write(`\nDiagnostic report could not be created: ${errorMessage(e)}\n`);
    }
  }

  // Exit non-zero on any check failure so CI and scripts get a clear
  // signal. Doctor's stdout carries the diagnostic regardless of exit
  // code — the orchestrator's tool-failure handler was updated in this
  // same change to print stdout (not stderr) for doctor.
  process.exit(failed > 0 ? 1 : 0);
}

// A filesystem-safe UTC timestamp token (isoTimestamp has colons that some
// filesystems reject in names): 2026-07-14T15:26:31Z → 20260714T152631Z.
function fsSafeTimestamp(): string {
  return isoTimestamp().replace(/[-:]/g, "").replace(/\.\d+/, "");
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
  // Comma-joined workspace-relative directory path(s) the nested-project
  // fallback classified Brownfield from. Absent when the root itself decided
  // the verdict (the common case). Surfaced only in the WORKSPACE_SCANNED audit
  // event and the `detect --json` payload, never in the state file.
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
  ".opencode",
  ".aidlc",
  ".cursor",
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

// Directory names the nested-project fallback never descends into at any
// container level: they commonly hold sample/snippet/boilerplate code that is
// not the project's own source. The harness/VCS/build dirs in SCAN_EXCLUDE and
// SCAN_SOURCE_DIRS are skipped separately. Lowercased for a case-insensitive
// match.
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

const NESTED_SCAN_MAX_DEPTH = 3;
const SCAN_EXCLUDE_LOWER = new Set(
  [...SCAN_EXCLUDE].map((entry) => entry.toLowerCase())
);

function skipNestedScanDir(entry: string): boolean {
  const lower = entry.toLowerCase();
  return (
    entry.startsWith(".") ||
    SCAN_EXCLUDE_LOWER.has(lower) ||
    NESTED_SCAN_EXCLUDE.has(lower) ||
    SCAN_SOURCE_DIR_SET.has(entry)
  );
}

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
// root and each directory visited by the nested-project fallback. Returns the
// raw brownfield signal plus the findings so the caller can aggregate.
//
//   fileScanDepth = the countFilesByLang depth for the SOURCE-FILE signal:
//     - root: 0 for the top-level file sweep (files directly under dir; the
//       inline top-level loop the base code ran is equivalent to
//       countFilesByLang(dir, counts, 0), same SCAN_EXCLUDE filter + symlink
//       skip, files only) PLUS a depth-6 recurse into each present
//       SCAN_SOURCE_DIRS entry.
//     - a nested container: 0, sweeping files directly under the visited
//       directory. Arbitrary child containers are evaluated independently by
//       the bounded walker. A present SCAN_SOURCE_DIRS entry is counted only by
//       the depth-6 recurse below, so files are never counted twice.
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
  // SCAN_SOURCE_DIRS entry, which the depth-6 recurse below counts separately.
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
  // Root scan (depth 0 for the top-level file sweep, byte-identical to the
  // base inline loop plus the SCAN_SOURCE_DIRS recurse, both inside scanSignals).
  const root = scanSignals(projectDir, 0);
  const langCounts = { ...root.langCounts };
  const frameworks = [...root.frameworks];
  let buildSystem = root.buildSystem;
  let brownfield = root.brownfield;
  const nestedHits: string[] = [];

  // Nested-project fallback: only when the root itself shows NO brownfield
  // signal. Walk candidate container directories in sorted order, bounded to
  // three levels below the workspace root. Each visited directory gets the
  // same nested signal evaluation; a Brownfield hit is aggregated once and is
  // not descended into, preventing language counts from overlapping. Dot dirs,
  // excluded names, known source dirs, symlinks, and non-dirs are never visited.
  if (!brownfield) {
    const walkContainers = (
      parentDir: string,
      parentParts: string[],
      parentDepth: number
    ): void => {
      let entries: string[];
      try {
        entries = readdirSync(parentDir).sort();
      } catch {
        return;
      }

      for (const entry of entries) {
        if (skipNestedScanDir(entry)) continue;
        const full = join(parentDir, entry);
        let st: import("node:fs").Stats;
        try {
          st = lstatSync(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink() || !st.isDirectory()) continue;

        const parts = [...parentParts, entry];
        const depth = parentDepth + 1;
        const sub = scanSignals(full, 0);
        if (sub.brownfield) {
          brownfield = true;
          nestedHits.push(parts.join("/"));
          for (const [lang, n] of Object.entries(sub.langCounts)) {
            langCounts[lang] = (langCounts[lang] || 0) + n;
          }
          for (const fw of sub.frameworks) {
            if (!frameworks.includes(fw)) frameworks.push(fw);
          }
          if (buildSystem === "Unknown") buildSystem = sub.buildSystem;
          continue;
        }

        if (depth < NESTED_SCAN_MAX_DEPTH) {
          walkContainers(full, parts, depth);
        }
      }
    };

    walkContainers(projectDir, [], 0);
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
// intent-create (0.1-0.3) — deterministic: mint intent + scan + state-init
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

// The phases a scope actually runs: those holding at least one EXECUTE stage.
// This is the SINGLE derivation behind two decisions that must never disagree:
// which per-phase dirs a new record gets (ensureWorkspaceDirs) and which phases
// report PHASE_SKIPPED at creation. Both read the compiled scope grid via
// stagesInScope, so the folders on disk and the audit trail always tell the same
// story, with no LLM input in the path. A phase whose stage set is empty under
// the enabled bundle (plugin selection can empty one) has nothing to write and
// is likewise out.
function phasesWithExecuteStages(scope: string): Set<string> {
  const stages = stagesInScope(scope);
  return new Set(
    PHASES.filter((phase) =>
      stages.some((s) => s.phase === phase && s.action === "EXECUTE")
    )
  );
}

// Ensure the dirs a workflow writes into exist. Idempotent ensure-exists (SEED
// ships the shell). Creates the active intent's record dir plus a per-phase
// artifact dir for each phase the SCOPE RUNS, plus the SPACE-level CodeKB
// parent and domain knowledge dir; all skipped if already present. The active
// intent cursor must be set before this runs.
//
// Scope-excluded phases get NO folder: an empty `operation/` in a bugfix record
// reads as work that was planned and skipped, when that phase was never in the
// plan. Nothing depends on the folder pre-existing: a stage artifact is written
// by the agent's own file tool, which creates its parent chain on first write,
// and every deterministic reader of a phase dir guards on existence. This only
// ever creates: an older record that already carries all five keeps them.
function ensureWorkspaceDirs(projectDir: string, scope: string): void {
  // docsDir() default-resolves the active intent's record dir (or the flat
  // fallback when no intent resolves) — the cursor set by createIntent/migration
  // points it at the created intent.
  const record = docsDir(projectDir);
  mkdirSync(record, { recursive: true });
  // Lazy per-phase artifact dirs, in-scope phases only (stages write reports here).
  for (const phase of phasesWithExecuteStages(scope)) {
    mkdirSync(join(record, phase), { recursive: true });
  }
  // verification/ is scope-independent: sensor and gate verification can land
  // for any phase, so every record gets it.
  mkdirSync(join(record, "verification"), { recursive: true });
  // The shared CodeKB parent is safe to inspect before any repository has been
  // analyzed. Per-repo stores remain lazy and appear only when RE writes them.
  mkdirSync(dirname(codekbDir(projectDir, "_")), { recursive: true });
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

// intent-create - the deterministic mutation behind the engine's creation
// directive (the engine NAMES the move read-only; this tool performs it).
// Creates the FIRST intent in the active space on a fresh workspace, OR a new
// intent for new work alongside an active one. Crash-safe + concurrent-safe:
// the WHOLE transaction (migration probe, intent mint, registry append,
// active-intent cursor, state-build, audit emits) runs inside ONE withAuditLock
// on the WORKSPACE sentinel bucket — every intents.json mutation takes that
// bucket (invariant 2), so two concurrent first-runs are serialized and BOTH
// creation attempts land distinct uuids/dirs/rows with no lost update.
//
// The directory-tree copy + knowledge READMEs that the old `--init` shipped are
// gone: the workspace shell (spaces/default/memory, native includes) ships in
// dist/ (SEED), and lazy workspace dirs are ensure-exists at creation or first
// use. What stays is the scope→stage state-build that routes
// the workflow to its first post-init stage — relocated here, now writing into
// the CREATED intent's record (the active-intent cursor set first makes the
// default-resolving state/audit helpers resolve there).
function handleIntentCreate(projectDir: string, flags: Record<string, string>): void {
  // Creation mutates the registry and active cursor. Refuse an invocation that
  // carries no meaningful scope or description instead of minting a default
  // record from an accidental bare command.
  if (!INTENT_CREATE_DESCRIPTIVE_FLAGS.some((name) => flags[name])) {
    die(
      "intent-create refused: no --scope, --arguments, or --label given. Creation " +
        "is a mutation and a bare invocation mints a garbage default-scope " +
        "intent. Start work via `/aidlc \"<what to build>\"` (the engine names " +
        "the create move for you) or `/aidlc-init [--scope <name>] <description>`; " +
        "to invoke this tool directly, pass at least `--scope <name>` (and " +
        "ideally `--arguments \"<description>\" --label \"<2-3 word essence>\"`).",
    );
  }

  // Default when --scope is omitted: AWS_AIDLC_DEFAULT_SCOPE overrides, then
  // the framework's single hard-coded fallback (DEFAULT_SCOPE, "classic");
  // selection-aware so a plugin-only install (where the core default is
  // deselected) resolves to its nominated freeform default instead of
  // crashing with "Unknown scope".
  const scope = flags.scope || envDefaultScope() ||
    resolveDefaultScope(DEFAULT_SCOPE);
  if (!validScopes().has(scope)) {
    die(
      `Unknown scope: "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }

  if (flags.arguments !== undefined) {
    const description = authoritativeProjectDescription(flags.arguments);
    if (description.error) {
      die(
        `intent-create refused: ${description.error}. Use exact, non-nested ` +
          "<document>...</document> markers and clarify the request before retrying.",
      );
    }
    if (
      description.pastedDocumentPresent &&
      description.description.length === 0
    ) {
      die(
        "intent-create refused: pasted document content has no authoritative user " +
          "directions outside <document>...</document>. State what to do with the " +
          "document before retrying.",
      );
    }
  }

  const depthOverride = flags.depth;
  if (depthOverride && !VALID_DEPTHS[depthOverride.toLowerCase()]) {
    die(`Unknown depth: "${depthOverride}". Valid depths: minimal, standard, comprehensive.`);
  }

  const testStrategyOverride = flags["test-strategy"];
  if (testStrategyOverride && !VALID_TEST_STRATEGIES[testStrategyOverride.toLowerCase()]) {
    die(`Unknown test strategy: "${testStrategyOverride}". Valid: minimal, standard, comprehensive.`);
  }
  const reviewOverride = parseReviewOverride(flags.review);
  const initialSelection = resolveWorkflowSelection(projectDir);

  // Resolve the repo set the intent touches (P7 multi-repo): an explicit
  // `--repos a,b` wins; absent it, sibling auto-discovery scans the workspace
  // root's immediate children for a `.git`. An empty result (legacy single-repo /
  // fresh greenfield) records no repos row — the lone repo is inferred on the
  // construction path. Validated up front so a bad name fails before any mutation.
  let repos: string[];
  try {
    repos = resolveIntentRepoSet(projectDir, flags.repos);
  } catch (e) {
    die(errorMessage(e));
  }

  // The whole mutation runs under the WORKSPACE lock so a concurrent first-run
  // is serialized - both creation attempts append distinct rows to intents.json without a
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
      if (initialSelection.sessionId) {
        writeSessionBinding(
          projectDir,
          initialSelection.sessionId,
          DEFAULT_SPACE,
          migration.intentDirName,
        );
      }
      gitRmFlatTree(projectDir, migration.movedFrom);
      const migratedState = readStateFile(projectDir);
      const reviewUpdate = applyReviewOverride(
        migratedState,
        reviewOverride,
      );
      if (reviewUpdate.changed) {
        writeStateFile(projectDir, reviewUpdate.content);
      }
      // The migrated record carries its prior state + audit history. Record that
      // the workspace was migrated into this intent (lands in the migrated
      // intent's audit shard — the cursor points there now). No state rebuild.
      appendAuditEvent(projectDir, "WORKSPACE_INITIALISED", {
        Request: `/aidlc ${flags.arguments || scope}`,
        Scope: scope,
        Details: `Migrated flat aidlc-docs/ into ${migration.intentDirName}`,
        ...(reviewOverride !== undefined
          ? {
              "Review Override":
                reviewUpdate.storedReview || "adversarial (stage defaults)",
            }
          : {}),
      });
      if (reviewUpdate.changed) {
        appendAuditEvent(projectDir, "REVIEW_CLASS_CHANGED", {
          "Old Override": reviewUpdate.oldReview || "none set",
          "New Override":
            reviewUpdate.storedReview || "cleared (stage defaults apply)",
        });
      }
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
    // conductor that omits --label) still creates a sane name: --label, else the
    // freeform --arguments (truncated — may cut mid-phrase, the pre-LLM behaviour),
    // else the scope token. The full --arguments text still flows to the audit
    // Request + state Project fields below (verbose prose belongs there, not the dir).
    const description = flags.arguments?.trim();
    const label = flags.label?.trim();
    const slugSource = label || description || scope;
    const slug = slugify(slugSource, 24);
    // "help" is grammar (`intent help` prints help), so an intent slugged
    // "help" would be unswitchable by name. createIntent throws on it too
    // (library backstop); dying here keeps the clean JSON error shape.
    if (RESERVED_RECORD_NAMES.has(slug)) {
      die(
        `"${slug}" is a reserved name and cannot be an intent label. Pick a label that describes the work.`
      );
    }
    const space = initialSelection.space;
    const created = createIntent(
      projectDir,
      slug,
      space,
      scope,
      repos,
      initialSelection.sessionId ?? undefined,
    );

    const ts = isoTimestamp();

    // ---- Audit bootstrap + creation events (relocated from the old --init) ----

    // audit.md: header-only bootstrap if absent. WORKFLOW_STARTED is the creation
    // event; SESSION_STARTED is owned by the SessionStart hook. This resolves to
    // the created intent's per-clone audit shard (cursor set above).
    const auditPath = auditFilePath(projectDir);
    if (!existsSync(auditPath)) {
      mkdirSync(dirname(auditPath), { recursive: true });
      writeFileSync(auditPath, `# AI-DLC Audit Log\n`, "utf-8");
    }

    // WORKFLOW_STARTED — mandatory first event of any new workflow. Captures the
    // creation timestamp so "when did this feature begin?" is answerable from the
    // audit alone. Lands in the created intent's audit (relocated from --init).
    appendAuditEvent(projectDir, "WORKFLOW_STARTED", {
      Scope: scope,
      Request: `/aidlc ${flags.arguments || scope}`,
      ...sourceBaselineAuditFields(projectDir, "code-generation"),
      ...(reviewOverride !== undefined
        ? {
            "Review Override":
              storedReviewOverride(reviewOverride) || "adversarial (stage defaults)",
          }
        : {}),
      // Record the intent's repo span at creation (P7). Omitted when no repos were
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
    // stages in that phase). Captures the scope decision at workflow creation so
    // you don't have to derive it later by diffing the stage list. Shares
    // phasesWithExecuteStages with the folder creation below, so a phase that
    // reports skipped here is exactly a phase that gets no folder.
    const runningPhases = phasesWithExecuteStages(scope);
    for (const phase of PHASES) {
      if (phase === "initialization") continue;
      const inPhase = stagesInScope(scope).filter((s) => s.phase === phase);
      if (!runningPhases.has(phase) && inPhase.length > 0) {
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

    // ---- Ensure-exists record dirs (lazy; SEED ships the shell) ----
    // The shipped shell already carries spaces/default/memory + native includes.
    // Intent creation only ensures the dirs this workflow will write into: an artifact dir
    // per IN-SCOPE phase (a scope-excluded phase gets none), verification/, and
    // the space-level knowledge/ dir. All idempotent: skip any dir that already
    // exists, and never remove one.
    ensureWorkspaceDirs(projectDir, scope);

    const phaseDirDetail = `${runningPhases.size} in-scope phase dirs + verification/ + space-level knowledge/ ensured`;
    appendAuditEvent(projectDir, "WORKSPACE_SCAFFOLDED", {
      Request: `/aidlc ${flags.arguments || scope}`,
      Details: `${phaseDirDetail} (shell shipped by SEED)`,
    });
    appendAuditEvent(projectDir, "STAGE_COMPLETED", {
      Stage: "workspace-scaffold",
      Details: phaseDirDetail,
    });

    handleIntentCreateStateBuild(
      projectDir,
      flags,
      scope,
      ts,
      reviewOverride,
      created.dirName,
      created.space,
    );
  }, undefined, undefined, WORKSPACE_MUTATION_LOCK_RETRIES);
}

// The scope→stage state-build half of creation: the workspace detection + state
// file authoring + routing audit emits the old --init ran after scaffolding.
// Split out only so handleIntentCreate's lock body stays readable; it is called
// from inside that lock (every write here resolves the created intent's record).
function handleIntentCreateStateBuild(
  projectDir: string,
  flags: Record<string, string>,
  scope: string,
  ts: string,
  reviewOverride: ReviewOverride | undefined,
  createdDir: string,
  createdSpace: string,
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
      // scan is a likely misread (source nested past the bounded fallback, or a
      // wrong scope). We do NOT override routing (an empty workspace genuinely
      // has nothing to reverse-engineer); we point the user at the fix.
      if (["bugfix", "refactor", "security-patch"].includes(scope)) {
        process.stderr.write(
          `Note: scope "${scope}" usually targets existing code, but the workspace scanned as Greenfield ` +
            `so Reverse Engineering will be skipped. If this project has a codebase the scanner missed, ` +
            `edit "Project Type" to Brownfield in the intent's aidlc-state.md, or move the source so it is ` +
            `detected (top-level or within three container levels), then re-run.\n`,
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

  const rawProjectDesc = flags.arguments || "[Project description]";
  const descriptionAuthority = authoritativeProjectDescription(rawProjectDesc);
  const previewSource = descriptionAuthority.error
    ? "[Pasted document boundary needs clarification]"
    : descriptionAuthority.pastedDocumentPresent
      ? descriptionAuthority.description || "[Pasted document provided]"
      : rawProjectDesc;
  const projectDesc = hasUnsafeSingleLineCharacter(previewSource)
    ? Array.from(previewSource, (char) => {
        const codePoint = char.codePointAt(0) ?? 0;
        return codePoint <= 0x1f ||
            codePoint === 0x7f ||
            codePoint === 0x2028 ||
            codePoint === 0x2029
          ? " "
          : char;
      })
        .join("")
        .replace(/ {2,}/g, " ")
        .trim() || "[Project description]"
    : previewSource;

  // Phase Progress - per-phase status. Creation completes every initialization
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
- **Project Description Source**: ${PROJECT_DESCRIPTION_FILE}
- **Project Type**: ${scan.projectType}
- **Scope**: ${scope}
- **Start Date**: ${ts}
- **State Version**: ${CURRENT_STATE_VERSION}
- **Active Agent**: ${firstPostInitAgent}
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Scope Configuration
- **Stages to Execute**: ${executeStages.join(", ")}
- **Stages to Skip**: ${skipStages.length > 0 ? skipStages.join(", ") : "none"}
- **Depth**: ${effectiveDepth}
- **Test Strategy**: ${effectiveTestStrategy}
- **Review Override**: ${reviewOverride === undefined ? "" : storedReviewOverride(reviewOverride)}

## Workspace State
- **Project Root**: .
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

  writeFileAtomic(
    projectDescriptionFilePath(projectDir),
    `${JSON.stringify(rawProjectDesc)}\n`,
  );
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

  // Combined stdout summary (intent created + state-build). The active-intent
  // cursor + the record dir were set by createIntent above; the state file lives
  // under the created intent's record (resolved by writeStateFile's default).
  const submoduleWarningLine =
    uninitSubmodules.length > 0
      ? `Warning: ${uninitSubmodules.length} uninitialized git submodule path(s) (${enumerateSubmodulePaths(uninitSubmodules)}) - run '${SUBMODULE_INIT_REMEDY}' before proceeding so reverse-engineering can read the code.\n`
      : "";
  process.stdout.write(
    `Intent created: ${createdDir} (space: ${createdSpace})
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
// state-init / init - transition aliases
// ---------------------------------------------------------------------------

function handleInitTransition(): void {
  die(INIT_TRANSITION_MESSAGE);
}

function handleStateInit(_projectDir: string, _flags: Record<string, string>): void {
  die(
    "state-init is merged into intent-create. Just describe what you want to build (/aidlc \"build the auth service\") and the workflow record is created for you."
  );
}

function handleUpgrade(): void {
  die(UPGRADE_UNAVAILABLE_MESSAGE);
}

// ---------------------------------------------------------------------------
// intent / space — the verb families + the deterministic query layer
// ---------------------------------------------------------------------------

// Print an intent listing (the query layer's human OR --json mode). Both modes
// read the SAME listSpaces/listIntents source so they never diverge. --json
// shape: {active, spaces:[...], intents:[{uuid,slug,status,repos}]} — consumed
// by the creation gate, resume-rebind, and statusline; human text is the bare
// `/aidlc intent` rendering. Pure read.
function printIntentListing(
  projectDir: string,
  asJson: boolean,
): void {
  const selection = resolveWorkflowSelection(projectDir);
  const space = selection.space;
  const intents = listIntents(projectDir, space, selection.intent);
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
function printSpaceListing(
  projectDir: string,
  asJson: boolean,
): void {
  const selection = resolveWorkflowSelection(projectDir);
  const spaces = listSpaces(projectDir, selection.space);
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
function handleIntent(
  projectDir: string,
  positional: string[],
  flags: Record<string, string>,
): void {
  const asJson = flags.json === "true";
  const verbOrTarget = positional[1];
  if (verbOrTarget === "list") {
    printIntentListing(projectDir, asJson);
    return;
  }
  if (verbOrTarget === "create") {
    handleIntentCreate(projectDir, flags);
    return;
  }
  const target = verbOrTarget === "switch" ? positional[2] : verbOrTarget;
  if (verbOrTarget === "switch" && !target) {
    die("Usage: aidlc-utility intent switch <name>");
  }
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
  const selection = resolveWorkflowSelection(projectDir);
  const space = selection.space;
  const intents = listIntents(projectDir, space, selection.intent);
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
    // recovering from a failed switch read that as an instruction and created an
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
  const sid =
    selection.sessionId ??
    readCurrentSessionId(projectDir);
  if (sid) {
    writeSessionBinding(projectDir, sid, space, match.dirName);
    clearSessionRebindOffer(projectDir, sid);
    if (match.uuid) writeSessionIntentUuid(projectDir, sid, match.uuid);
  }
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
  const verbOrTarget = positional[1];
  if (verbOrTarget === "list") {
    printSpaceListing(projectDir, asJson);
    return;
  }
  if (verbOrTarget === "create") {
    handleSpaceCreate(projectDir, ["space-create", positional[2] ?? ""], flags);
    return;
  }
  const raw = verbOrTarget === "switch" ? positional[2] : verbOrTarget;
  if (verbOrTarget === "switch" && !raw) {
    die("Usage: aidlc-utility space switch <name>");
  }
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
      `Unknown space "${target}". Existing: ${spaces.map((s) => s.name).join(", ")}. This command only switches between existing spaces. Do not create a space to recover from this error - creating one is a separate, deliberate move (/aidlc space create <name>, or legacy /aidlc space-create <name>).`
    );
  }
  const selection = resolveWorkflowSelection(projectDir);
  setActiveSpaceCursor(projectDir, target);
  const sessionId = selection.sessionId ?? readCurrentSessionId(projectDir);
  if (sessionId) {
    const targetIntent = activeIntent(projectDir, target);
    writeSessionBinding(projectDir, sessionId, target, targetIntent);
    clearSessionRebindOffer(projectDir, sessionId);
    if (targetIntent) {
      const uuid = listIntents(projectDir, target).find(
        (entry) => entry.dirName === targetIntent,
      )?.uuid;
      if (uuid) writeSessionIntentUuid(projectDir, sessionId, uuid);
    } else {
      clearSessionIntentUuid(projectDir, sessionId);
    }
  }
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
  const selection = resolveWorkflowSelection(projectDir);
  const space = selection.space;
  const repo = flags.repo && flags.repo.length > 0
    ? flags.repo
    : codekbRepoName(projectDir, space, selection.intent ?? undefined);
  const dir = relativeCodekbDir(projectDir, repo, space);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ space, repo, dir })}\n`);
    return;
  }
  process.stdout.write(`${dir}/\n`);
}

// `aidlc-utility.ts document-input` - read-only. Reads one selected path from
// the active record's fixed DOCUMENT_INPUT_REQUEST_FILE, so customer-controlled
// filename bytes never enter a shell command. Resolves that path from the
// project root and refuses search/fallback, symlinks, non-regular files,
// out-of-project targets, binary input, and content beyond the same
// 200k-character delivery cap used by DocumentKB. Successful output carries
// DocumentKB's path/content trust notices in the same JSON object as the bytes
// they govern. No mkdir, state write, or audit event.
function handleProjectDescription(projectDir: string): void {
  const recordRoot = dirname(stateFilePath(projectDir));
  process.stdout.write(
    `${JSON.stringify(readProjectDescriptionAuthority(recordRoot))}\n`,
  );
}

async function handleDocumentInput(projectDir: string): Promise<void> {
  const {
    detectMimeType,
    EXTRACT_OUTPUT_CHAR_CAP,
    readDocumentBytes,
    resolveContainedFile,
    UNTRUSTED_CONTENT_NOTICE,
    UNTRUSTED_PATH_NOTICE,
  } = await import("./aidlc-knowledge.ts");
  const documentInputByteCap = EXTRACT_OUTPUT_CHAR_CAP * 4;
  // The transport file carries ONE path line, so it gets a path-sized cap, not
  // the document cap. Without an explicit bound the whole file is allocated and
  // UTF-8 decoded BEFORE the one-line check, so a sparse multi-megabyte
  // .aidlc-document-input-path kills the process with an out-of-memory error
  // before any validation runs. 4096 bytes covers PATH_MAX on every supported
  // platform, plus the trailing newline.
  const requestFileByteCap = 4096;

  const refuse = (message: string): never =>
    die(`${UNTRUSTED_PATH_NOTICE} ${message}`);
  const requestFile = documentInputRequestFilePath(projectDir);
  const requested = (() => {
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(
        readDocumentBytes(
          requestFile,
          DOCUMENT_INPUT_REQUEST_FILE,
          undefined,
          requestFileByteCap,
        ),
      );
    } catch (error) {
      return refuse(
        `cannot read ${DOCUMENT_INPUT_REQUEST_FILE}: ${errorMessage(error)}. ` +
          "Write one exact path to that active-record file with the native file-write tool.",
      );
    }
    const value = raw.replace(/\r?\n$/, "");
    if (value === "" || /[\r\n]/.test(value)) {
      return refuse(
        `${DOCUMENT_INPUT_REQUEST_FILE} must contain exactly one non-empty path line.`,
      );
    }
    return value;
  })();

  const projectRoot = (() => {
    try {
      return realpathSync(projectDir);
    } catch (error) {
      return refuse(`cannot resolve the project root: ${errorMessage(error)}`);
    }
  })();

  const requestedAbs = isAbsolute(requested)
    ? resolve(requested)
    : resolve(projectRoot, requested);
  const rel = relative(projectRoot, requestedAbs);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    refuse(
      `document path must resolve to a file inside the project root: ${JSON.stringify(requested)}`,
    );
  }
  const portablePath = rel.split(sep).join("/");

  const { absPath, bytes } = (() => {
    try {
      const resolved = resolveContainedFile(projectRoot, portablePath);
      return {
        absPath: resolved.absPath,
        bytes: readDocumentBytes(
          resolved.absPath,
          `document input ${JSON.stringify(portablePath)}`,
          undefined,
          documentInputByteCap,
          resolved.identity,
        ),
      };
    } catch (error) {
      return refuse(
        `cannot read ${JSON.stringify(portablePath)} directly: ${errorMessage(error)} ` +
          "The path is resolved from the project root and filenames are not searched " +
          "recursively. Provide one accessible regular file inside the project, or use DocumentKB.",
      );
    }
  })();

  const mime = detectMimeType(absPath, bytes);
  if (mime !== "text/plain" && mime !== "text/markdown") {
    refuse(
      `${JSON.stringify(portablePath)} is ${mime}, not direct UTF-8 text or Markdown. ` +
        "Place it under aidlc/spaces/<space>/knowledge/documents/, run " +
        "`/aidlc knowledge onboard <path>`, then read it with `/aidlc knowledge show <id>`.",
    );
  }

  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (content.length > EXTRACT_OUTPUT_CHAR_CAP) {
    refuse(
      `${JSON.stringify(portablePath)} contains ${content.length} characters; direct input is ` +
        `limited to ${EXTRACT_OUTPUT_CHAR_CAP}. Use DocumentKB so extraction and truncation ` +
        "are explicit.",
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      path_notice: UNTRUSTED_PATH_NOTICE,
      content_notice: UNTRUSTED_CONTENT_NOTICE,
      path: portablePath,
      bytes: bytes.length,
      content_trust: "untrusted",
      content_handling: "data-not-instructions",
      content,
    })}\n`,
  );
}

const CODEKB_ARTIFACT_FILES = [
  "api-documentation.md",
  "architecture.md",
  "business-overview.md",
  "code-quality-assessment.md",
  "code-structure.md",
  "component-inventory.md",
  "dependencies.md",
  "reverse-engineering-timestamp.md",
  "technology-stack.md",
] as const;

function resolveCodekbRepo(
  projectDir: string,
  flags: Record<string, string>,
): { space: string; repo: string; repoDir: string; storeDir: string; excludes: string[] } {
  const selection = resolveWorkflowSelection(projectDir);
  const space = selection.space;
  const repo = flags.repo && flags.repo.length > 0
    ? flags.repo
    : codekbRepoName(projectDir, space, selection.intent ?? undefined);
  if (!isValidRepoName(repo)) {
    die(`Invalid --repo "${repo}": a repo name must be one path segment.`);
  }
  const siblingDir = join(projectDir, repo);
  const sourceDir =
    existsSync(siblingDir) && statSync(siblingDir).isDirectory()
      ? siblingDir
      : projectDir;
  return {
    space,
    repo,
    repoDir: sourceDir,
    storeDir: codekbDir(projectDir, repo, space),
    excludes: sourceDir === projectDir ? ["aidlc"] : [],
  };
}

function codekbPaths(flags: Record<string, string>, command: string): string[] {
  const paths = (flags.paths ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path !== "");
  if (paths.length === 0) {
    die(`${command}: pass --paths <comma-separated repo-relative paths>`);
  }
  return [...new Set(paths)];
}

function codekbLockIntent(repo: string): string {
  return `__codekb__${createHash("sha256").update(repo).digest("hex").slice(0, 16)}`;
}

function codekbTransactionRoot(
  projectDir: string,
  space: string,
  repo: string,
): string {
  return join(
    projectDir,
    "aidlc",
    "spaces",
    space,
    "intents",
    ".aidlc-codekb-transactions",
    repo,
  );
}

function trustedCodekbRecoveryPath(
  projectReal: string,
  relativePath: string,
): string {
  try {
    return assertNoSymlinkInChainOrThrow(projectReal, relativePath);
  } catch (error) {
    throw new Error(
      `refusing CodeKB recovery through an unsafe project path: ${errorMessage(error)}`,
    );
  }
}

function recoverCodekbTransactions(
  projectDir: string,
  space: string,
  repo: string,
): void {
  const projectReal = realpathSync(projectDir);
  const rootRelative = relative(
    projectReal,
    codekbTransactionRoot(projectReal, space, repo),
  );
  const storeRelative = join("aidlc", "spaces", space, "codekb", repo);
  const root = trustedCodekbRecoveryPath(projectReal, rootRelative);
  const storeDir = trustedCodekbRecoveryPath(projectReal, storeRelative);
  if (!existsSync(root)) return;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`refusing CodeKB recovery from non-directory transaction root: ${root}`);
  }
  for (const name of readdirSync(root).sort()) {
    const txnRelative = join(rootRelative, name);
    const txn = trustedCodekbRecoveryPath(projectReal, txnRelative);
    const txnStat = lstatSync(txn);
    if (!txnStat.isDirectory() || txnStat.isSymbolicLink()) {
      throw new Error(`refusing CodeKB recovery from non-directory transaction: ${txn}`);
    }
    const backupRelative = join(txnRelative, "backup");
    const backup = trustedCodekbRecoveryPath(projectReal, backupRelative);
    if (!existsSync(storeDir) && existsSync(backup)) {
      const backupStat = lstatSync(backup);
      if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
        throw new Error(`refusing CodeKB recovery from non-directory backup: ${backup}`);
      }
      const checkedStore = trustedCodekbRecoveryPath(projectReal, storeRelative);
      const checkedBackup = trustedCodekbRecoveryPath(projectReal, backupRelative);
      mkdirSync(dirname(checkedStore), { recursive: true });
      renameSync(checkedBackup, checkedStore);
    }
    rmSync(
      trustedCodekbRecoveryPath(projectReal, txnRelative),
      { recursive: true, force: true },
    );
  }
  rmSync(
    trustedCodekbRecoveryPath(projectReal, rootRelative),
    { recursive: true, force: true },
  );
}

function withCodekbLock<T>(
  projectDir: string,
  space: string,
  repo: string,
  fn: () => T extends Promise<unknown> ? never : T,
): T extends Promise<unknown> ? never : T {
  return withAuditLock(
    projectDir,
    fn,
    codekbLockIntent(repo),
    space,
  );
}

// Snapshot the two generations a scan is built from. The stage takes this
// immediately before scanning and passes both tokens to codekb-publish.
function handleCodekbSnapshot(
  projectDir: string,
  flags: Record<string, string>,
): void {
  const { space, repo, repoDir, storeDir, excludes } =
    resolveCodekbRepo(projectDir, flags);
  const paths = codekbPaths(flags, "codekb-snapshot");
  const snapshot = withCodekbLock(projectDir, space, repo, () => {
    recoverCodekbTransactions(projectDir, space, repo);
    const sourceFingerprint = codekbSourceFingerprint(repoDir, paths, excludes);
    if (sourceFingerprint === null) {
      die(`codekb-snapshot: cannot fingerprint source paths: ${paths.join(", ")}`);
    }
    return {
      repo,
      store: `${relativeCodekbDir(projectDir, repo, space)}/`,
      paths,
      store_generation: codekbStoreGeneration(storeDir),
      source_fingerprint: sourceFingerprint,
    };
  });
  if (flags.json === "true") {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return;
  }
  process.stdout.write(
    `STORE_GENERATION ${snapshot.store_generation}\n` +
      `SOURCE_FINGERPRINT ${snapshot.source_fingerprint}\n` +
      `SOURCE_PATHS ${snapshot.paths.join(",")}\n`,
  );
}

function readCodekbCandidate(
  projectDir: string,
  stagedFlag: string | undefined,
): {
  files: Map<string, Buffer>;
  scope: Extract<ReturnType<typeof parseReScope>, { ok: true }>["scope"];
} {
  if (!stagedFlag) {
    die("codekb-publish: pass --staged <directory-containing-all-nine-artifacts>");
  }
  const stagedPath = resolve(projectDir, stagedFlag);
  const rel = relative(projectDir, stagedPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    die("codekb-publish: --staged must resolve inside the project directory");
  }
  let stagedStat: ReturnType<typeof lstatSync>;
  try {
    stagedStat = lstatSync(stagedPath);
  } catch {
    die(`codekb-publish: staged directory not found: ${stagedFlag}`);
  }
  if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) {
    die("codekb-publish: --staged must be a real directory, not a symlink");
  }
  const projectReal = realpathSync(projectDir);
  const stagedDir = realpathSync(stagedPath);
  const realRel = relative(projectReal, stagedDir);
  if (
    realRel === "" ||
    realRel === ".." ||
    realRel.startsWith(`..${sep}`) ||
    isAbsolute(realRel)
  ) {
    die("codekb-publish: --staged must not escape the project through a symlinked ancestor");
  }
  const entries = readdirSync(stagedDir).sort();
  const required = [...CODEKB_ARTIFACT_FILES].sort();
  if (JSON.stringify(entries) !== JSON.stringify(required)) {
    die(
      `codekb-publish: staged directory must contain exactly the nine CodeKB artifacts; ` +
        `found: ${entries.join(", ") || "(empty)"}`,
    );
  }
  const files = new Map<string, Buffer>();
  for (const name of required) {
    const path = join(stagedDir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      die(`codekb-publish: staged artifact must be a regular file: ${name}`);
    }
    files.set(name, readFileSync(path));
  }
  const parsed = parseReScope(
    files.get("reverse-engineering-timestamp.md")?.toString("utf-8") ?? "",
  );
  if (!parsed.ok) {
    die(
      `codekb-publish: staged reverse-engineering-timestamp.md has an invalid ` +
        `Scope of Analysis block (${parsed.reason}: ${parsed.detail})`,
    );
  }
  return { files, scope: parsed.scope };
}

function handleCodekbPublish(
  projectDir: string,
  flags: Record<string, string>,
): void {
  const { space, repo, repoDir, storeDir, excludes } =
    resolveCodekbRepo(projectDir, flags);
  const expectedStore = flags["expect-store"];
  const expectedSource = flags["expect-source"];
  if (!expectedStore || !expectedSource) {
    die(
      "codekb-publish: pass --expect-store <generation> and --expect-source <fingerprint> from codekb-snapshot",
    );
  }
  const sourcePaths = codekbPaths(flags, "codekb-publish");
  const candidate = readCodekbCandidate(projectDir, flags.staged);
  for (const path of candidate.scope.analyzedPaths) {
    if (!sourcePaths.includes("./") && !scopePathCovered(sourcePaths, path)) {
      die(
        `codekb-publish: snapshot paths do not cover candidate analyzed path "${path}"; ` +
          `take a fresh codekb-snapshot over the complete candidate scope`,
      );
    }
  }

  const result = withCodekbLock(projectDir, space, repo, () => {
    recoverCodekbTransactions(projectDir, space, repo);
    const currentStore = codekbStoreGeneration(storeDir);
    if (currentStore !== expectedStore) {
      die(
        `CODEKB_STORE_CHANGED: expected ${expectedStore}, found ${currentStore}. ` +
          `Re-read the current store, re-merge the staged scan, take a fresh snapshot, and retry.`,
      );
    }
    const currentSource = codekbSourceFingerprint(repoDir, sourcePaths, excludes);
    if (currentSource === null || currentSource !== expectedSource) {
      die(
        `CODEKB_SOURCE_CHANGED: expected ${expectedSource}, found ${currentSource ?? "unavailable"}. ` +
          `Re-scan the affected source, re-synthesize all nine artifacts, take a fresh snapshot, and retry.`,
      );
    }
    const currentCandidateFingerprint = codekbScopeFingerprint(
      repoDir,
      candidate.scope.analyzedPaths,
      excludes,
    );
    if (
      candidate.scope.fingerprint !== currentCandidateFingerprint &&
      !(candidate.scope.fingerprint === null && currentCandidateFingerprint === null)
    ) {
      die(
        `CODEKB_CANDIDATE_STALE: staged fingerprint ` +
          `${candidate.scope.fingerprint ?? "unknown"} does not match the current source ` +
          `${currentCandidateFingerprint ?? "unknown"}. Re-mint the timestamp and retry.`,
      );
    }

    const txn = join(
      codekbTransactionRoot(projectDir, space, repo),
      `${process.pid}-${randomUUID()}`,
    );
    const next = join(txn, "next");
    const backup = join(txn, "backup");
    mkdirSync(next, { recursive: true });
    try {
      for (const [name, bytes] of candidate.files) {
        writeFileSync(join(next, name), bytes);
      }
      mkdirSync(dirname(storeDir), { recursive: true });
      const hadStore = existsSync(storeDir);
      if (hadStore) renameSync(storeDir, backup);
      try {
        renameSync(next, storeDir);
      } catch (error) {
        if (hadStore && existsSync(backup) && !existsSync(storeDir)) {
          renameSync(backup, storeDir);
        }
        throw error;
      }
      rmSync(backup, { recursive: true, force: true });
      return {
        repo,
        published: `${relativeCodekbDir(projectDir, repo, space)}/`,
        generation: codekbStoreGeneration(storeDir),
      };
    } finally {
      rmSync(txn, { recursive: true, force: true });
    }
  });
  process.stdout.write(
    flags.json === "true"
      ? `${JSON.stringify(result)}\n`
      : `PUBLISHED ${result.published} ${result.generation}\n`,
  );
}

// `aidlc-utility.ts codekb-scope-diff [--repo <name>] [--compare <timestamp.md>]
// [--json]` - read-only. The deterministic half of the reverse-engineering
// rerun guard (the store is shared space-level knowledge; compare mode reports
// which paths/components are no longer claimed as verified deep coverage).
//
// Status mode (default): parse the STORE's reverse-engineering-timestamp.md
// scope block and recompute the content fingerprint over its analyzed paths.
//   NO_STORE       no store timestamp - first scan, nothing to guard
//   CURRENT        fingerprint matches - the store's deep knowledge is exact
//   STALE          analyzed paths changed since the store was built
//   UNVERIFIED     scope parsed but no/uncomputable fingerprint (non-git)
//   UNKNOWN_SCOPE  block absent (legacy store) or malformed
//
// Compare mode (--compare <incoming timestamp.md>): does the incoming run's
// analyzed scope cover the store's? COVERS, or NARROWER + the exact paths and
// components an overwrite would discard.
//
// Mint mode (--mint --paths <a,b,...>): print the content fingerprint over
// the given repo-relative paths - the value the architect writes into the
// scope block's `fingerprint:` line at synthesis time. Prints `unknown` when
// not computable (non-git or invalid pathspec), which the block records
// verbatim.
//
// Always exits 0 with the verdict in the output (read-only query - mirrors
// codekb-path; refusals are for lifecycle verbs). No mkdir, no state write,
// no audit.
function handleCodekbScopeDiff(projectDir: string, flags: Record<string, string>): void {
  const asJson = flags.json === "true";
  const selection = resolveWorkflowSelection(projectDir);
  const space = selection.space;
  const repo = flags.repo && flags.repo.length > 0
    ? flags.repo
    : codekbRepoName(projectDir, space, selection.intent ?? undefined);
  const storeDir = relativeCodekbDir(projectDir, repo, space);
  const storePath = join(projectDir, ...storeDir.split("/"), "reverse-engineering-timestamp.md");

  // The repo's source root: the sibling dir `<workspace>/<repo>/` when it
  // exists (the multi-repo layout reverse-engineering.md Step 1 scans), else
  // the workspace root itself (the lone-repo case, where codekbRepoName is
  // basename(projectDir)).
  const siblingDir = join(projectDir, repo);
  const repoDir = existsSync(siblingDir) && statSync(siblingDir).isDirectory() ? siblingDir : projectDir;
  // In the lone-repo layout the framework-owned aidlc workspace tree lives
  // under the repository root. Exclude it from full-root fingerprints so
  // writing the scope draft, codekb, audit, or state cannot stale its own hash.
  const fingerprintExcludes = repoDir === projectDir ? ["aidlc"] : [];

  if (flags.mint === "true") {
    const paths = (flags.paths ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (paths.length === 0) {
      die("codekb-scope-diff --mint: pass --paths <comma-separated repo-relative paths>");
    }
    const fp = codekbScopeFingerprint(repoDir, paths, fingerprintExcludes) ?? "unknown";
    if (asJson) process.stdout.write(`${JSON.stringify({ repo, fingerprint: fp, paths })}\n`);
    else process.stdout.write(`${fp}\n`);
    return;
  }

  const emit = (payload: Record<string, unknown>, human: string): void => {
    if (asJson) process.stdout.write(`${JSON.stringify({ repo, store: `${storeDir}/`, ...payload })}\n`);
    else process.stdout.write(`${human}\n`);
  };

  if (!existsSync(storePath)) {
    emit(
      { verdict: "NO_STORE" },
      `NO_STORE: no reverse-engineering-timestamp.md at ${storeDir}/ - first scan, nothing to compare.`,
    );
    return;
  }
  const parsed = parseReScope(readFileSync(storePath, "utf-8"));
  if (!parsed.ok) {
    emit(
      { verdict: "UNKNOWN_SCOPE", reason: parsed.reason, detail: parsed.detail },
      `UNKNOWN_SCOPE (${parsed.reason}): ${parsed.detail}. The store predates scope tracking. A focused merge may retain its prose, but prior paths and components are not claimed as verified coverage until rescanned.`,
    );
    return;
  }
  const store = parsed.scope;

  if (flags.compare !== undefined) {
    const incomingPath = flags.compare;
    if (!incomingPath || !existsSync(incomingPath)) {
      die(`codekb-scope-diff --compare: file not found: ${incomingPath || "(missing path)"}`);
    }
    const incomingParsed = parseReScope(readFileSync(incomingPath, "utf-8"));
    if (!incomingParsed.ok) {
      emit(
        { verdict: "UNKNOWN_SCOPE", reason: incomingParsed.reason, detail: `incoming: ${incomingParsed.detail}` },
        `UNKNOWN_SCOPE (incoming ${incomingParsed.reason}): ${incomingParsed.detail}.`,
      );
      return;
    }
    const incoming = incomingParsed.scope;
    const fullScopeDowngrade = store.kind === "full" && incoming.kind !== "full";
    const discardedPaths =
      incoming.kind === "full"
        ? []
        : fullScopeDowngrade
          ? [...store.analyzedPaths]
          : store.analyzedPaths.filter((p) => !scopePathCovered(incoming.analyzedPaths, p));
    const discardedComponents =
      incoming.kind === "full"
        ? []
        : store.analyzedComponents.filter((c) => !incoming.analyzedComponents.includes(c));
    const narrower = discardedPaths.length > 0 || discardedComponents.length > 0;
    const payload = {
      verdict: narrower ? "NARROWER" : "COVERS",
      store_intent: store.intent,
      incoming_intent: incoming.intent,
      discarded_paths: discardedPaths,
      discarded_components: discardedComponents,
    };
    if (narrower) {
      emit(
        payload,
        `NARROWER: the incoming scope no longer claims verified deep coverage for:\n` +
          discardedPaths.map((p) => `  - ${p}`).join("\n") +
          (discardedComponents.length > 0
            ? `\n  components: ${discardedComponents.join(", ")}`
            : "") +
          `\n(store intent: ${store.intent || "unrecorded"}; incoming intent: ${incoming.intent || "unrecorded"})`,
      );
    } else {
      emit(payload, `COVERS: the incoming scan covers everything the store analyzed.`);
    }
    return;
  }

  // Status mode.
  const currentFingerprint =
    store.analyzedPaths.length > 0
      ? codekbScopeFingerprint(repoDir, store.analyzedPaths, fingerprintExcludes)
      : null;
  const scopeLines = store.analyzedPaths.map((p) => `  - ${p}`).join("\n");
  if (store.fingerprint === null || currentFingerprint === null) {
    emit(
      {
        verdict: "UNVERIFIED",
        store_intent: store.intent,
        kind: store.kind,
        analyzed_paths: store.analyzedPaths,
        detail: store.fingerprint === null ? "store has no fingerprint" : "fingerprint not computable here",
      },
      `UNVERIFIED: the store (intent: ${store.intent || "unrecorded"}) analyzed:\n${scopeLines}\n` +
        `but ${store.fingerprint === null ? "recorded no fingerprint" : "the current tree's fingerprint cannot be computed"} - freshness unknown.`,
    );
    return;
  }
  const current = store.fingerprint === currentFingerprint;
  emit(
    {
      verdict: current ? "CURRENT" : "STALE",
      store_intent: store.intent,
      kind: store.kind,
      analyzed_paths: store.analyzedPaths,
      store_fingerprint: store.fingerprint,
      current_fingerprint: currentFingerprint,
    },
    current
      ? `CURRENT: the analyzed paths are unchanged since the store was built (intent: ${store.intent || "unrecorded"}, coverage: ${store.kind}):\n${scopeLines}`
      : `STALE: the analyzed paths have changed since the store was built (intent: ${store.intent || "unrecorded"}):\n${scopeLines}`,
  );
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

// `/aidlc space create <name>` (legacy `/aidlc space-create <name>`) - seed a NEW space's memory. org.md is copied
// from spaces/default/memory/org.md (the always-present SEED baseline), plus
// fresh empty team.md/project.md/phases stubs + the templates/ floor. A new team
// starts at the framework baseline and earns its OWN practices — it does NOT
// inherit another space's learnings. (A new INTENT, by contrast, seeds nothing:
// it reads its space's live memory — handled in createIntent.)
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
  const reviewOverride = parseReviewOverride(flags.review);

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
      "Cannot change scope while Construction is running unattended (Construction Autonomy Mode " +
        "is autonomous). Changing the plan needs someone to approve it, and nobody is being asked " +
        "right now. Either switch back to stopping for approval at each Bolt " +
        "(aidlc-bolt set-autonomy --mode gated) or wait for the current build to finish, then change scope.",
    );
  }
  const oldScope = getField(content, "Scope");
  if (!oldScope) die("Cannot read current Scope from state file.");

  if (oldScope === newScope) {
    if (depthOverride || testStrategyOverride || reviewOverride !== undefined) {
      handleConfigChange(projectDir, flags);
      return;
    }
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
  const reviewUpdate = applyReviewOverride(content, reviewOverride);
  content = reviewUpdate.content;
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
  if (reviewUpdate.changed) {
    appendAuditEvent(projectDir, "REVIEW_CLASS_CHANGED", {
      "Old Override": reviewUpdate.oldReview || "none set",
      "New Override":
        reviewUpdate.storedReview || "cleared (stage defaults apply)",
    });
  }

  process.stdout.write(
    `Scope changed: ${oldScope} → ${newScope}
Stages in scope: ${executeStages.length} (${deltaStr})
Approval gates: ${gates}
Depth: ${effectiveDepth}
${reviewOverride === undefined
      ? ""
      : `Review override: ${reviewUpdate.storedReview || "adversarial (stage defaults)"}\n`}Completed: ${completedCount}/${executeStages.length}
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
        "Cannot change the plan while Construction is running unattended (Construction Autonomy " +
          "Mode is autonomous). Changing the plan needs someone to approve it, and nobody is being " +
          "asked right now. Either switch back to stopping for approval at each Bolt " +
          "(aidlc-bolt set-autonomy --mode gated) or wait for the current build to finish, then recompose.",
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
    // CREATED with structural advisories (e.g. bugfix's code-generation consumes
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
    // The Stages to Skip row carries creation/scope-change annotations (entry
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
  }, undefined, undefined, WORKSPACE_MUTATION_LOCK_RETRIES);
}

// ---------------------------------------------------------------------------
// config get/list/set - read or update active workflow config
// ---------------------------------------------------------------------------

function configFieldForKey(key: string): "Depth" | "Test Strategy" | "Review Override" | null {
  if (key === "depth") return "Depth";
  if (key === "test-strategy") return "Test Strategy";
  if (key === "review") return "Review Override";
  return null;
}

function readConfigField(projectDir: string, flags: Record<string, string>, field: "Depth" | "Test Strategy" | "Review Override"): string {
  const sp = stateFilePath(projectDir, flags.intent, flags.space);
  if (!existsSync(sp)) die(NO_STATE_FILE_MESSAGE);
  const content = readStateFile(projectDir, flags.intent, flags.space);
  return getField(content, field) || "";
}

function handleConfigGet(projectDir: string, positional: string[], flags: Record<string, string>): void {
  const key = positional[1] ?? "";
  const field = configFieldForKey(key);
  if (!field) die(`Unknown config key: "${key}". Valid keys: ${CONFIG_KEYS.join(", ")}.`);
  process.stdout.write(`${readConfigField(projectDir, flags, field)}\n`);
}

function handleConfigList(projectDir: string, flags: Record<string, string>): void {
  const depth = readConfigField(projectDir, flags, "Depth");
  const testStrategy = readConfigField(projectDir, flags, "Test Strategy");
  const review = readConfigField(projectDir, flags, "Review Override");
  if (flags.json === "true") {
    process.stdout.write(`${JSON.stringify({ depth, "test-strategy": testStrategy, review })}\n`);
    return;
  }
  process.stdout.write(`depth: ${depth}\ntest-strategy: ${testStrategy}\nreview: ${review}\n`);
}

function handleConfigChange(projectDir: string, flags: Record<string, string>): void {
  const rawDepth = flags.depth;
  const rawStrategy = flags["test-strategy"];
  const rawReview = flags.review;

  if (!rawDepth && !rawStrategy && !rawReview) {
    die("config-change requires --depth, --test-strategy, and/or --review");
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

  // --review sets the per-run Review Override (a CEILING on the effective
  // review class, low-wins against stage declaration and scope review_cap).
  const newReview = parseReviewOverride(rawReview);

  const sp = stateFilePath(projectDir, flags.intent, flags.space);
  if (!existsSync(sp)) die(NO_STATE_FILE_MESSAGE);

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
  const reviewUpdate = applyReviewOverride(content, newReview);
  content = reviewUpdate.content;
  const { oldReview, storedReview } = reviewUpdate;
  const depthChanging = newDepth !== undefined && newDepth !== oldDepth;
  const strategyChanging =
    newStrategy !== undefined && newStrategy !== oldStrategy;
  const reviewChanging = reviewUpdate.changed;
  if (depthChanging || strategyChanging || reviewChanging) {
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
  if (reviewChanging) {
    appendAuditEvent(projectDir, "REVIEW_CLASS_CHANGED", {
      "Old Override": oldReview || "none set",
      "New Override": storedReview || "cleared (stage defaults apply)",
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
  if (newReview !== undefined) {
    const display = storedReview === "" ? "adversarial (stage defaults)" : storedReview;
    process.stdout.write(
      reviewChanging
        ? `Review override changed: ${oldReview || "none"} → ${display}\n`
        : `Review override is already ${display}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// set-status — atomically update statusline fields at stage start
// ---------------------------------------------------------------------------

function handleSetStatus(projectDir: string, flags: Record<string, string>): void {
  if (
    process.env.AIDLC_STATUSLINE_OWNER !== `statusline:${process.ppid}`
  ) {
    die(
      "Direct aidlc-utility set-status is blocked: there is nothing for you to do here. " +
        "The workflow's position updates on its own as stages start and outcomes are reported. " +
        "Run /aidlc --status to see where things stand. " +
        "(status synchronization is owned by the sync-workflow-state hook.)",
    );
  }
  const sp = stateFilePath(projectDir, flags.intent, flags.space);
  if (!existsSync(sp)) die("No state file found. Start a workflow first by describing what to build (/aidlc \"build the auth service\").");

  const stage = flags.stage;
  if (!stage) die("--stage is required for set-status");

  const entry = findStageBySlug(stage);
  if (!entry) die(`Unknown stage: ${stage}`);

  const phase = (flags.phase || entry.phase).toUpperCase();
  const agent = flags.agent || entry.lead_agent;

  const previousContent = readStateFile(projectDir, flags.intent, flags.space);
  const currentStage = (getField(previousContent, "Current Stage") ?? "").trim();
  const activeDirective = readActiveDirectiveMarker(projectDir, previousContent);
  const preserveUnitMajorCursor =
    getField(previousContent, "Construction Iteration")?.trim() === "unit-major" &&
    phase === "CONSTRUCTION" &&
    activeDirective?.stage === stage &&
    activeDirective.unit !== undefined &&
    currentStage.length > 0 &&
    currentStage !== stage;
  let content = previousContent;
  content = setField(content, "Lifecycle Phase", phase);
  content = setField(content, "Active Agent", agent);
  content = setField(content, "Status", "Running");
  content = setField(content, "Last Updated", isoTimestamp());
  if (!preserveUnitMajorCursor) {
    content = setField(content, "Current Stage", stage);
    content = setField(content, "In Progress", stage);
    content = setCheckbox(content, stage, "in-progress");
  }
  writeStateFile(projectDir, content, flags.intent, flags.space);
  try {
    refreshActiveDirectiveMarker(projectDir, stage, previousContent, content);
  } catch (e) {
    recordHookDrop(projectDir, "active-directive", errorMessage(e));
  }

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
  const harnessSkill = resolveSkillsPath(["aidlc", "SKILL.md"]);
  if (existsSync(harnessSkill)) return harnessSkill;
  const agentsSkill = join(
    dirname(resolveHarnessPath([])),
    ".agents",
    "skills",
    "aidlc",
    "SKILL.md",
  );
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
//   - Env names an installed but disabled scope: resolve the selection-aware
//     default. This preserves plugin-only installs whose existing config names
//     a deselected core scope such as `feature`.
//   - Env names an unknown scope: exit 1 with the canonical error. Explicit
//     typos never enter the internal default-fallback path.
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
    if (loadScopeMetadataAll()[envScope] === undefined) {
      die(
        `Invalid AWS_AIDLC_DEFAULT_SCOPE "${envScope}". Valid scopes: ${[...validScopes()].join(", ")}.`
      );
    }
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

export async function main(argv: string[]): Promise<void> {
  const rawArgs = argv;
  errorArgs = [...rawArgs];
  const { positional, flags, bareFlags, blankFlags } = parseArgs(rawArgs);
  const subcommand = positional[0];
  if (
    (subcommand === "intent-create" || subcommand === "init") &&
    (flags.help === "true" || rawArgs.includes("-h"))
  ) {
    process.stdout.write(
      "Usage: aidlc-utility intent-create --scope <scope> " +
        '[--arguments "<description>"] [--label "<short label>"] ' +
        "[--depth <level>] [--test-strategy <level>] [--review <class>] [--repos <name,...>] " +
        "[--project-dir <path>]\n",
    );
    return;
  }
  const isIntentCreate =
    subcommand === "intent-create" ||
    subcommand === "init" ||
    (subcommand === "intent" && positional[1] === "create");
  const missingValueFlags = new Set([...bareFlags, ...blankFlags]);
  errorProjectDirArg = missingValueFlags.has("project-dir")
    ? undefined
    : flags["project-dir"];
  if (isIntentCreate) {
    validateIntentCreateFlagValues(flags, missingValueFlags);
  }
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
    case "claim":
      unitMain([
        "claim",
        ...rawArgs.slice(1),
        "--project-dir",
        projectDir,
      ]);
      break;
    case "release":
      unitMain([
        "release",
        ...rawArgs.slice(1),
        "--project-dir",
        projectDir,
      ]);
      break;
    case "participate":
      unitMain(["participate", "--project-dir", projectDir]);
      break;
    case "doctor":
      handleDoctor(projectDir, flags);
      break;
    case "intent-create":
      handleIntentCreate(projectDir, flags);
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
    // project-description - read-only exact-description authority boundary.
    // Marked records must load the JSON sidecar; only unmarked legacy records
    // fall back to the state preview.
    case "project-description":
      handleProjectDescription(projectDir);
      break;
    // document-input - read-only direct-document boundary used by Intent Capture
    // and Requirements Analysis. One exact path in, one trust-marked JSON object
    // out; no search, mutation, or audit.
    case "document-input":
      await handleDocumentInput(projectDir);
      break;
    case "codekb-snapshot":
      handleCodekbSnapshot(projectDir, flags);
      break;
    case "codekb-publish":
      handleCodekbPublish(projectDir, flags);
      break;
    // codekb-scope-diff - read-only query verb. Compares the codekb store's
    // recorded scope of analysis against the live tree (status) or an
    // incoming run's timestamp (--compare). The RE stage's rerun guard.
    case "codekb-scope-diff":
      handleCodekbScopeDiff(projectDir, flags);
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
    case "plugin-list":
      handlePluginList(flags);
      break;
    case "plugin-sync":
      await handlePluginSync(projectDir);
      break;
    case "plugin-validate":
      handlePluginValidate(positional, flags);
      break;
    case "plugin-build":
      handlePluginBuild(positional, flags, missingValueFlags);
      break;
    // init / state-init are transition-only and intentionally absent from help.
    // Stale init callers get a loud error for this release; workflow start is
    // still intent-create through the orchestrator.
    case "init":
      handleInitTransition();
      break;
    case "state-init":
      handleStateInit(projectDir, flags);
      break;
    case "upgrade":
      handleUpgrade();
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
    case "config-get":
      handleConfigGet(projectDir, positional, flags);
      break;
    case "config-list":
      handleConfigList(projectDir, flags);
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
      // `intent-birth` was renamed to `intent-create`; point the old name at
      // the new one rather than burying it in the verb list.
      if (subcommand === "intent-birth") {
        die(
          "`intent-birth` was renamed to `intent-create`. Run the same command with " +
            "`intent-create` instead (flags are unchanged)."
        );
      }
      die(
        `Unknown command "${subcommand}". Run \`aidlc-utility help\` for what this tool can do.\n\n` +
          "Available commands: help, version, status, doctor, intent-create, intent, space, " +
          "space-create, codekb-path, codekb-snapshot, codekb-publish, project-description, document-input, codekb-scope-diff, detect, select-plugins, plugin-list, plugin-sync, plugin-validate, plugin-build, " +
          "recompose, scope-change, config-change, config-get, config-list, set-status, " +
          "detect-scope, resolve-env-scope, scope-table, stage-table, upgrade\n" +
          "Common options: [--project-dir <path>] [--scope <scope>] [--json]"
      );
  }
}

if (import.meta.main) {
  void main(process.argv.slice(2)).catch((error) => {
    die(errorMessage(error));
  });
}
