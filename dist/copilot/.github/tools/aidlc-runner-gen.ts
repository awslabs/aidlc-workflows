// The runner-skill generator — one tool, two runner families.
//
// (1) STAGE-RUNNERS: one thin `skills/aidlc-<stage>/SKILL.md`
//     per RUNNABLE compiled stage slug. A stage-runner is OPT-IN SUGAR: it
//     packages `/aidlc --stage <slug> --single`, which works without it, into a
//     typeable `/aidlc-<stage>` command. The authoritative authoring path is
//     "write a stage file"; this generator bakes a runner shell over the
//     compiled graph so the set of runners can never drift from the set of
//     stages by hand. The bootstrap INITIALIZATION stages are excluded (they
//     have no standalone --single meaning); the whole init phase is packaged as
//     ONE `/aidlc-init` runner over `/aidlc --init` instead.
//     Plugin-owned stages use their bare plugin-prefixed slug as the runner
//     name; core stages keep the historical `aidlc-<stage>` name.
//
// (2) SCOPE-RUNNERS: one thin runner per shipped scope file whose frontmatter
//     declares `runner: true`. A scope-runner is packaging,
//     not definition (decision D-A): each is a ~6-line shell that drives the
//     engine (`aidlc-orchestrate next --scope <scope>`) to `done` with a fixed
//     scope and no scope detection. The full set of scopes is always reachable
//     via `/aidlc --scope <name>`; runners are typeable sugar over the
//     high-traffic ones marked in scope metadata.
//
// COMPOSE, don't reimplement. The stage-slug list comes from loadGraph() — the
// one compiled source of truth (data/stage-graph.json); the scope list comes
// from the shipped `.claude/scopes/*.md` files. A stage added to the graph (or a
// scope file dropped in) flows into a runner with no edit here, and the drift
// guards (`check` for stages — t129; `scopes --check` for scopes — t130) fail CI
// if the on-disk set ever diverges from the source-of-truth set.
//
// NO HOOKS in any runner (Fork 2→B, settled): the six skill-scoped hooks live
// project-wide in settings.json, so a runner carries no `hooks:` block to
// replicate or drift-guard — the deterministic spine is inherited, not copied.
//
// The conductor persona is delivered by the ENGINE on the first `next` (decision
// D-E, SPIKE 6) — baked into the run-stage directive — so the runner body does
// NOT load conductor.md by hand.
//
// Subcommands:
//   write            — (re)generate every STAGE-runner dir from the compiled
//                      stage list.
//   check            — STAGE-runner drift guard: exit 0 iff the on-disk runner
//                      set == the compiled stage-slug set (no missing, no
//                      orphan); exit 1 with a diff on stdout otherwise.
//   list             — print the stage slugs one per line (debugging aid).
//   scopes [--all] [--check] [--out <skills-dir>]
//                    — generate/validate SCOPE-runner skills over
//                      `.claude/scopes/*.md` (`runner: true`, or `--all`).
//
// Env seams (mirror aidlc-lib.ts): AIDLC_SCOPES_DIR points the scope-file reader
// at an isolated tree; --out points the scope writer at an isolated skills dir.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  errorMessage,
  frontmatterBlock,
  harnessDir,
  isPluginEnabled,
  loadScopeMetadataAll,
  loadStageGraphAll,
  pluginsEnabled,
  scopeGridPath,
} from "./aidlc-lib.ts";
import { type GraphStage, loadGraph } from "./aidlc-graph.ts";
import {
  resolveHarnessPath,
  resolveSkillsPath,
} from "./aidlc-runtime-paths.ts";

// Resolve the skills/ dir off THIS module's location (tools/ → ../skills/) so the
// generator writes into the shipped tree regardless of the caller's cwd, mirroring
// how the engine resolves aidlc-common/ and the stage files.
// =========================================================================
// STAGE-RUNNER HALF
// =========================================================================

// The dir name for a stage's runner skill. Core stages keep `aidlc-<slug>`;
// plugin-owned stages use the bare plugin-prefixed slug. The skill `name`
// frontmatter equals the dir name (Agent-Skills-spec invariant t123 asserts).
function runnerDirName(node: Pick<GraphStage, "slug" | "plugin">): string {
  return node.plugin ? node.slug : `aidlc-${node.slug}`;
}

// Initialization-phase stages are bootstrap: they have no standalone meaning
// (`produces: []`, and the engine's --single mode REFUSES them — you cannot
// scaffold half a workspace). The whole initialization phase is run as ONE
// atomic operation by `/aidlc --init` (aidlc-utility.ts: scaffold + scan +
// state-init in one call). So a per-init-stage `--single` runner would be a
// typeable command that always errors. We exclude them from stage-runner
// generation and ship ONE `/aidlc-init` runner that wraps `/aidlc --init`
// instead — initialization is a PHASE, not standalone stages, so the
// stage-runner set is the runnable (non-init) stages.
function isRunnableStage(node: GraphStage): boolean {
  return node.phase !== "initialization";
}

// The runnable stage nodes — every compiled stage EXCEPT the bootstrap
// initialization stages. This is the source of truth for which stage-runners
// exist; a runner is generated for each, and the drift guard asserts the
// on-disk set matches it exactly.
export function runnableStages(): GraphStage[] {
  return loadGraph().filter(isRunnableStage);
}

// The runnable stage-slug list (graph/topological-author order), excluding the
// bootstrap initialization stages.
function stageSlugs(): string[] {
  return runnableStages().map((s) => s.slug);
}

// The dir name for the init-phase runner: `/aidlc-init`. It wraps the whole
// initialization phase via `/aidlc --init`, NOT a single stage.
const INIT_RUNNER_DIR = "aidlc-init";

// Render the ~6-line runner shell for one stage. The body is intentionally thin:
// it states what the runner does and the one command it drives. It does NOT
// load the conductor persona (the engine bakes it into the first `next`), and it
// carries NO `hooks:` block (the spine is project-wide in settings.json).
//
// `name` == dir (spec invariant). `description` is present and non-empty (spec
// invariant). The `--single` invariant is named in prose so a reader of the
// runner understands it never advances the main workflow.
export function renderStageRunner(node: GraphStage): string {
  const dir = runnerDirName(node);
  const descriptionLead = node.plugin
    ? `Run the ${node.plugin} plugin \`${node.slug}\` stage (${node.phase} phase) in isolation, without`
    : `Run the AI-DLC \`${node.slug}\` stage (${node.phase} phase) in isolation, without`;
  const bodyLead = node.plugin
    ? `Run the \`${node.slug}\` stage from the ${node.plugin} plugin on its own. This is opt-in packaging over`
    : `Run the \`${node.slug}\` stage on its own. This is opt-in packaging over`;
  return `---
name: ${dir}
generated-by: aidlc-runner-gen
description: >
  ${descriptionLead}
  advancing the main workflow. Packages \`/aidlc --stage ${node.slug} --single\`:
  the engine emits one run-stage directive for ${node.slug} and its gate, the
  conductor runs it, then the single-stage run commits a synthetic-id pair and
  stops. The main workflow's Current Stage is never touched.
argument-hint: ""
user-invocable: true
---

# AI-DLC Stage Runner — ${node.slug}

${bodyLead}
\`/aidlc --stage ${node.slug} --single\`; the same stage is always reachable via
that flag without this skill.

## Steps

1. Ask the engine for the single-stage directive:

   \`\`\`bash
   bun ${harnessDir()}/tools/aidlc-orchestrate.ts next --stage ${node.slug} --single
   \`\`\`

   The engine emits one \`run-stage\` directive for \`${node.slug}\` (carrying the
   lead agent, the resolved consumes/produces paths, the rules and sensors in
   context, and — on this first directive — the conductor persona). Run the stage
   exactly as the directive describes; do not load the conductor persona by hand,
   the engine delivers it.

2. When the stage's work is done, commit the single-stage record:

   \`\`\`bash
   bun ${harnessDir()}/tools/aidlc-orchestrate.ts report --single --stage ${node.slug} --result completed
   \`\`\`

   This records a STAGE_STARTED / STAGE_COMPLETED pair under a synthetic workflow
   id and stops. It NEVER writes the main workflow's \`Current Stage\` — a
   single-stage run is isolated by design (the tool refuses to advance the main
   workflow).
`;
}

// Render the `/aidlc-init` runner: a thin wrapper over the deterministic
// `intent-birth` move (which runs the whole initialization phase — mint the
// intent + detect the workspace + build state — in one call). This is the
// init-phase analogue of the per-stage runners: opt-in packaging over a path
// the engine already names at birth. It drives `intent-birth`, NOT
// `--stage … --single`, so the stage-runner drift guard (which keys on the
// `--stage`+`--single` marker) never counts it. There is no user-facing
// `/aidlc --init` (P4): the workspace shell ships in dist/ and the engine
// auto-births the first intent — this runner just makes that explicit.
export function renderInitRunner(): string {
  return `---
name: ${INIT_RUNNER_DIR}
generated-by: aidlc-runner-gen
description: >
  Start an AI-DLC workflow — run the whole Initialization phase (mint the
  intent, detect the workspace, build state) in one step, without typing a
  stage. The engine normally auto-births the first intent; this is opt-in
  packaging over that move. Pass \`--scope <name>\` to seed the initial scope
  (defaults to poc), or a freeform description of what to build.
argument-hint: "[--scope <name>] [description]"
user-invocable: true
---

# AI-DLC — start a workflow (birth the first intent)

Start a fresh AI-DLC workflow. The workspace shell ships in \`dist/\` (no setup
command), and the engine auto-births the first intent when you describe what to
build — this skill is opt-in packaging over that birth move. Initialization is a
PHASE, not a single stage — it mints the intent, detects the workspace
(greenfield/brownfield), and builds \`aidlc-state.md\` together, in one
deterministic call. There is no per-init-stage runner because an init stage has
no standalone meaning.

## Steps

1. Birth the intent (run the initialization phase). Parse the user's
   \`$ARGUMENTS\`: forward any recognized flags
   (\`--scope <name>\`/\`--depth <level>\`/\`--test-strategy <level>\`)
   as-is, and pass any freeform description text via \`--arguments "<text>"\`
   (\`intent-birth\` reads the description from the \`--arguments\` flag, NOT a
   positional — forwarding it bare would silently drop it). ALSO derive a short
   **\`--label\`**: a 2-3 word kebab-case essence of what's being built
   (\`"I would like to build a simple calculator application"\` → \`--label
   "simple calc"\`). The label becomes the readable, date-prefixed record dir name
   (\`<YYMMDD>-simple-calc\`); the full \`--arguments\` text is preserved separately
   in the audit + state. Omit \`--label\` only when there is no description (the
   tool then falls back to the scope token):

   \`\`\`bash
   bun ${harnessDir()}/tools/aidlc-utility.ts intent-birth --scope <name> --arguments "<description>" --label "<2-3 word essence>"
   \`\`\`

   \`--scope\` seeds the initial scope (defaults to \`poc\`); omit \`--arguments\`
   and \`--label\` when the user gave no description. Print the tool's output and
   stop. This does not advance a stage; run \`/aidlc\` afterwards to continue.
`;
}

// The dir name for the composer shortcut runner: `/aidlc-compose`. A thin
// typeable wrapper over `/aidlc compose ...` - the same one-door path, never a
// divergent flow.
const COMPOSE_RUNNER_DIR = "aidlc-compose";

// Render the `/aidlc-compose` runner: a thin wrapper over the engine's compose
// dispatch (`next compose ...`). Modeled on renderInitRunner's shape (its own
// hardcoded single-runner, NOT a reuse - renderInitRunner is init-specific).
// Drift-guard note: this runner drives `next compose`, so NEITHER existing
// guard counts it - the stage guard keys on the `--stage`+`--single` body
// marker and the scope guard byte-compares the frontmatter-selected scope set. Like
// `/aidlc-init`, its parity is held by the packager's dist-level `--check`
// (handleWrite is idempotent, so a stale or hand-edited copy fails the
// byte-compare there).
export function renderComposeRunner(): string {
  return `---
name: ${COMPOSE_RUNNER_DIR}
generated-by: aidlc-runner-gen
description: >
  Compose a tailored AI-DLC workflow plan - the adaptive composer reads your
  task (or a scan report), proposes the EXECUTE/SKIP stage grid that fits,
  and after your approval authors it as a scope and runs it. A typeable
  shortcut for \`/aidlc compose\`; the same one door, forced to the full
  composer even when a stock scope would match.
argument-hint: "[description | --report <path> | --new-scope]"
user-invocable: true
---

# AI-DLC - compose a workflow plan

Force the adaptive composer on a task. This is packaging over
\`/aidlc compose ...\` - it does not add a second entry point; the engine
recognizes the compose request and names the composer dispatch, and the
conductor runs the same forwarding loop as \`/aidlc\`.

## Steps

1. Forward the user's \`$ARGUMENTS\` into the engine with the leading
   \`compose\` verb (pass \`--report <path>\` / \`--new-scope\` through as-is):

   \`\`\`bash
   bun ${harnessDir()}/tools/aidlc-orchestrate.ts next compose $ARGUMENTS
   \`\`\`

2. Act on the directive exactly as the \`aidlc\` skill's forwarding loop
   describes (the composer-dispatch print names the composer agent; render
   its proposal and hold the approve/edit/reject gate). From here the flow IS
   the \`/aidlc\` flow - continue its loop until the directive says stop.
`;
}

// Write (or refresh) every stage-runner dir from the RUNNABLE stage list (init
// stages excluded — see isRunnableStage), plus the single `/aidlc-init` phase
// wrapper and the `/aidlc-compose` composer shortcut. Idempotent: re-running
// emits byte-identical SKILL.md files. Also PRUNES any stale init-phase
// stage-runner dir (aidlc-state-init, aidlc-workspace-detection,
// aidlc-workspace-scaffold) left by an earlier generation that emitted runners
// for all 32 stages. Returns the slugs written.
function handleWrite(): string[] {
  const skillsDir = defaultSkillsDir(true);
  const slugs = stageSlugs();
  const compiledSet = new Set(slugs);
  for (const node of runnableStages()) {
    const dir = join(skillsDir, runnerDirName(node));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), renderStageRunner(node), "utf-8");
  }
  // Emit the init-phase wrapper.
  const initDir = join(skillsDir, INIT_RUNNER_DIR);
  if (!existsSync(initDir)) mkdirSync(initDir, { recursive: true });
  writeFileSync(join(initDir, "SKILL.md"), renderInitRunner(), "utf-8");
  // Emit the composer shortcut.
  const composeDir = join(skillsDir, COMPOSE_RUNNER_DIR);
  if (!existsSync(composeDir)) mkdirSync(composeDir, { recursive: true });
  writeFileSync(join(composeDir, "SKILL.md"), renderComposeRunner(), "utf-8");
  // Prune stale stage-runner dirs: old per-init runners and runners for stages
  // now absent from the filtered graph because their plugin is disabled.
  const legacyBareSlugs = pluginOwnedStageSlugsForLegacy();
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const slug = generatedRunnerSlugForPrune(
      join(dir, "SKILL.md"),
      entry.name,
      stageRunnerSlugFromBody,
      legacyBareSlugs,
    );
    if (slug && !compiledSet.has(slug)) rmSync(dir, { recursive: true, force: true });
  }
  return slugs;
}

const RUNNER_GEN_MARKER_KEY = "generated-by";
const RUNNER_GEN_MARKER_VALUE = "aidlc-runner-gen";

type RunnerSlugParser = (body: string) => string | null;

function leadingFrontmatter(body: string): string | null {
  return frontmatterBlock(body);
}

function hasRunnerGenMarker(body: string): boolean {
  const frontmatter = leadingFrontmatter(body);
  if (!frontmatter) return false;
  return new RegExp(`^${RUNNER_GEN_MARKER_KEY}:\\s*${RUNNER_GEN_MARKER_VALUE}\\s*$`, "m").test(frontmatter);
}

function isLegacyGeneratedRunnerDirName(
  dirName: string,
  slug: string,
  legacyBareSlugs: ReadonlySet<string>,
): boolean {
  // One-release transition for markerless runners generated before the
  // provenance marker existed: core-owned generated runners used aidlc-<slug>,
  // while plugin-owned generated runners used the bare plugin-prefixed slug.
  return dirName === `aidlc-${slug}` || (legacyBareSlugs.has(slug) && dirName === slug);
}

function generatedRunnerSlugForPrune(
  skillMdPath: string,
  dirName: string,
  parseSlug: RunnerSlugParser,
  legacyBareSlugs: ReadonlySet<string>,
): string | null {
  if (!existsSync(skillMdPath)) return null;
  const body = readFileSync(skillMdPath, "utf-8");
  const slug = parseSlug(body);
  if (!slug) return null;
  if (hasRunnerGenMarker(body) || isLegacyGeneratedRunnerDirName(dirName, slug, legacyBareSlugs)) {
    return slug;
  }
  console.error(`unmanaged skill, not pruned: ${dirName}`);
  return null;
}

function pluginOwnedStageSlugsForLegacy(): ReadonlySet<string> {
  return new Set(loadStageGraphAll().filter((s) => s.plugin).map((s) => s.slug));
}

function pluginOwnedScopeSlugsForLegacy(): ReadonlySet<string> {
  const all = loadScopeMetadataAll() as Record<string, { plugin?: string }>;
  return new Set(Object.entries(all).filter(([, front]) => front.plugin).map(([scope]) => scope));
}

// The on-disk runner SIGNATURE: a stage-runner's SKILL.md drives
// `aidlc-orchestrate next --stage <slug> --single`. Identifying runners by this
// body marker — NOT by compiled-set membership — is what lets the drift guard see
// ORPHANS: a runner skill dir that drives `--single` but whose slug is
// no longer a compiled stage. Non-runner skills (aidlc, aidlc-replay,
// aidlc-session-cost, aidlc-outcomes-pack, and the scope-runners, which drive
// `--scope` not `--stage`) carry no `--stage … --single` marker, so they are
// never mistaken for stage-runners and never flagged.
const SINGLE_RUNNER_MARKER = "--stage";
function stageRunnerSlugFromBody(body: string): string | null {
  if (!body.includes(SINGLE_RUNNER_MARKER) || !body.includes("--single")) return null;
  const m = body.match(/--stage\s+([a-z][a-z0-9-]*)\s+--single/);
  return m?.[1] ?? null;
}

function isRunnerSkill(skillMdPath: string): boolean {
  if (!existsSync(skillMdPath)) return false;
  const body = readFileSync(skillMdPath, "utf-8");
  return stageRunnerSlugFromBody(body) !== null;
}

function runnerSlugFromSkill(skillMdPath: string): string | null {
  if (!isRunnerSkill(skillMdPath)) return null;
  const body = readFileSync(skillMdPath, "utf-8");
  return stageRunnerSlugFromBody(body);
}

// The on-disk stage-runner set: every skill dir whose SKILL.md is a stage-runner
// (carries the `--single` signature). Returns the slugs — compiled or not — so
// the caller can compute BOTH missing (compiled, no runner) AND orphan (runner,
// not compiled) divergences. Slugs are parsed from the command body because
// plugin-owned runner dirs intentionally do not have an `aidlc-` prefix.
function onDiskRunnerSlugs(): string[] {
  return onDiskRunnerEntries().map((e) => e.slug);
}

function onDiskRunnerEntries(): Array<{ slug: string; dir: string }> {
  const skillsDir = defaultSkillsDir();
  if (!existsSync(skillsDir)) return [];
  const found: Array<{ slug: string; dir: string }> = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const slug = runnerSlugFromSkill(join(dir, "SKILL.md"));
    if (slug) found.push({ slug, dir });
  }
  return found;
}

// Stage-runner drift guard (t129's mechanism): the on-disk runner set must be
// EXACTLY the compiled stage-slug set — no stage missing a runner, no orphan
// runner for a stage the graph dropped. Exit 1 with a legible diff on any
// divergence so a stage added to the graph without regenerating runners fails
// loudly.
function handleCheck(): void {
  const compiledNodes = runnableStages();
  const compiled = compiledNodes.map((s) => s.slug);
  const compiledSet = new Set(compiled);
  const onDisk = new Set(onDiskRunnerSlugs());

  const missing = compiledNodes
    .filter((s) => !onDisk.has(s.slug))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const orphans = [...onDisk].filter((s) => !compiledSet.has(s)).sort();

  if (missing.length === 0 && orphans.length === 0) {
    console.log(
      `stage-runner set is in sync with the compiled stage graph (${compiled.length} runners).`,
    );
    return;
  }
  if (missing.length > 0) {
    console.log(`MISSING runners (stage in graph, no matching skill dir): ${missing.map((s) => `${s.slug} (${runnerDirName(s)})`).join(", ")}`);
  }
  if (orphans.length > 0) {
    console.log(`ORPHAN runners (skill drives --single stage with no matching stage): ${orphans.join(", ")}`);
  }
  console.log(`Run \`bun ${harnessDir()}/tools/aidlc-runner-gen.ts write\` to regenerate.`);
  process.exit(1);
}

// =========================================================================
// SCOPE-RUNNER HALF
// =========================================================================

function scopesDir(): string {
  return process.env.AIDLC_SCOPES_DIR ?? resolveHarnessPath(["scopes"]);
}

function defaultSkillsDir(mutable = false): string {
  return resolveSkillsPath([], { mutable });
}

function scopeNamesInWrittenGrid(): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(readFileSync(scopeGridPath(), "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Set();
    return new Set(Object.keys(parsed as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

// Extract a simple scalar frontmatter field (inline or single-quoted/double-
// quoted). Mirrors aidlc-lib.ts scalarField for the fields the generator reads.
function scalarField(frontmatter: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const m = frontmatter.match(re);
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}

interface ScopeFront {
  name: string;
  description: string;
  plugin?: string;
  runner?: boolean;
}

// Read a scope file's frontmatter. Throws on a missing frontmatter block or a
// missing `name` (the generator must never silently emit a malformed runner).
function readScopeFront(path: string): ScopeFront {
  const body = readFileSync(path, "utf-8");
  const fm = frontmatterBlock(body);
  if (fm === null) throw new Error(`Scope file missing frontmatter: ${path}`);
  const name = scalarField(fm, "name");
  if (!name) throw new Error(`Scope file ${path} missing required frontmatter: name`);
  const plugin = scalarField(fm, "plugin");
  const runnerRaw = scalarField(fm, "runner");
  let runner: boolean | undefined;
  if (runnerRaw === "true" || runnerRaw === "false") runner = runnerRaw === "true";
  let description = scalarField(fm, "description");
  // Tolerate a folded/block description ('>' or '|') by stitching the first
  // non-empty continuation line — the runner description is one line anyway.
  if (description === ">" || description === "|" || description === ">-" || description === "|-") {
    const lines = fm.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^description:/.test(l));
    description = "";
    for (let j = idx + 1; j < lines.length; j++) {
      if (/^\S/.test(lines[j])) break; // next top-level key
      const t = lines[j].trim();
      if (t.length > 0) { description = t; break; }
    }
  }
  const front: ScopeFront = { name, description };
  if (plugin) front.plugin = plugin;
  if (runner !== undefined) front.runner = runner;
  return front;
}

// Discover the shipped scope names (sorted, platform-independent). Each scope
// file is `.claude/scopes/aidlc-<name>.md`; the canonical name is its `name`
// frontmatter field (not the filename, which carries the aidlc- prefix).
export function discoverScopes(): Record<string, ScopeFront> {
  const dir = scopesDir();
  const out: Record<string, ScopeFront> = {};
  const gridNames = scopeNamesInWrittenGrid();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (err) {
    console.error(`Warning: scope directory not readable at ${dir}: ${errorMessage(err)}`);
    files = [];
  }
  for (const f of files) {
    const front = readScopeFront(join(dir, f));
    if (!isPluginEnabled(front.plugin ?? "aidlc") && !gridNames.has(front.name)) continue;
    out[front.name] = front;
  }
  return out;
}

export function defaultScopeBatch(discovered: Record<string, ScopeFront> = discoverScopes()): string[] {
  return Object.keys(discovered)
    .filter((scope) => discovered[scope].runner === true)
    .sort();
}

function scopeRunnerDirName(scope: string, front: Pick<ScopeFront, "plugin">): string {
  return front.plugin ? scope : `aidlc-${scope}`;
}

// Render the SKILL.md body for one scope-runner. Spec-conformant frontmatter
// (`name` == dir name), NO `hooks:` block (the six spine
// hooks live in settings.json project-wide, inherited by every runner), and
// a ~6-line shell that runs the engine forwarding loop with the scope baked in.
export function renderRunner(scope: string, description: string): string {
  const front = discoverScopes()[scope];
  const dir = scopeRunnerDirName(scope, front ?? {});
  // Normalise the scope's one-line description into a sentence (trailing period)
  // so it reads cleanly when stitched between the lead-in and the packaging note.
  const raw = (description || `Run the AI-DLC workflow with the ${scope} scope`).trim();
  const desc = /[.!?]$/.test(raw) ? raw : `${raw}.`;
  return `---
name: ${dir}
generated-by: aidlc-runner-gen
description: >
  Run the AI-DLC workflow with the ${scope} scope baked in — no scope
  detection. ${desc} Packaging over \`/aidlc --scope ${scope}\`, which works
  without this skill.
argument-hint: "[description | --status | --stage <slug|#> | --phase <name|#>]"
user-invocable: true
---

# AI-DLC — ${scope} scope

Drive the AI-DLC engine with the **${scope}** scope fixed. This is the same
deterministic forwarding loop the \`/aidlc\` orchestrator runs, with \`--scope
${scope}\` baked into the first \`next\` so scope detection is skipped. The
engine owns all routing; the conductor persona arrives on the first directive's
\`conductor_persona\` field — adopt it for the whole run.

## The loop

1. \`directive = bun ${harnessDir()}/tools/aidlc-orchestrate.ts next --scope ${scope} $ARGUMENTS\`
2. Act on \`directive.kind\` exactly as the orchestrator does (run-stage / ask / print / error / done) — see \`aidlc-common/protocols/stage-protocol.md\`.
3. \`bun ${harnessDir()}/tools/aidlc-orchestrate.ts report --stage <directive.stage> --result <outcome> [--user-input "<text>"]\` when the directive names a stage; omit \`--stage\` only for non-stage report round-trips.
4. Repeat from step 1 until \`directive.kind == done\`.

Pass \`$ARGUMENTS\` through verbatim after \`--scope ${scope}\`; the engine parses
any flags (\`--status\`, \`--stage\`, …) and the \`--scope\` from the
state file always wins on an existing workflow, so re-running a started workflow
resumes it. To run a different scope, use \`/aidlc --scope <other>\` instead.
`;
}

// The target SKILL.md path for one scope-runner under a skills dir.
function scopeRunnerPath(skillsDir: string, scope: string): string {
  const front = discoverScopes()[scope];
  return join(skillsDir, scopeRunnerDirName(scope, front ?? {}), "SKILL.md");
}

// Resolve the batch of scopes to generate: --all → every shipped scope;
// otherwise scopes whose frontmatter declares `runner: true`.
function resolveBatch(all: boolean, discovered: Record<string, ScopeFront>): string[] {
  if (all) return Object.keys(discovered).sort();
  return defaultScopeBatch(discovered);
}

function parseScopeArgs(argv: string[]): { check: boolean; all: boolean; out: string | null } {
  let check = false;
  let all = false;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") check = true;
    else if (a === "--all") all = true;
    else if (a === "--out" && i + 1 < argv.length) { out = argv[++i]; }
  }
  return { check, all, out };
}

function handleScopes(rest: string[]): void {
  const { check, all, out } = parseScopeArgs(rest);
  const skillsDir = out ?? defaultSkillsDir(!check);
  const discovered = discoverScopes();
  const batch = resolveBatch(all, discovered);

  if (batch.length === 0) {
    if (pluginsEnabled() === null) {
      console.error(
        `Warning: no scope-runner batch resolved from ${scopesDir()}. ` +
          "No pruning performed. Likely causes: no scope files with runner:true found, " +
          "or the scope directory is missing or mispointed.",
      );
      console.log("No scope files with runner:true found; nothing to generate.");
      return;
    }
    if (!check) pruneScopeRunners(skillsDir, new Set());
    console.log(
      check
        ? "No enabled scope files with runner:true; nothing to check."
        : "No enabled scope files with runner:true; pruned stale scope-runners; nothing to generate.",
    );
    return;
  }

  if (check) {
    const drift: string[] = [];
    for (const scope of batch) {
      const path = scopeRunnerPath(skillsDir, scope);
      const want = renderRunner(scope, discovered[scope].description);
      if (!existsSync(path)) {
        drift.push(`missing runner: ${path}`);
        continue;
      }
      const got = readFileSync(path, "utf-8");
      if (got !== want) drift.push(`stale runner: ${path}`);
    }
    if (drift.length > 0) {
      console.error("Scope-runner drift detected:");
      for (const d of drift) console.error(`  ${d}`);
      console.error("Re-run `bun aidlc-runner-gen.ts scopes` to regenerate.");
      process.exit(1);
    }
    console.log(`OK — ${batch.length} scope-runner(s) in sync: ${batch.join(", ")}`);
    return;
  }

  for (const scope of batch) {
    const path = scopeRunnerPath(skillsDir, scope);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderRunner(scope, discovered[scope].description), "utf-8");
    console.log(`wrote ${path}`);
  }
  pruneScopeRunners(skillsDir, new Set(batch));
  console.log(`Generated ${batch.length} scope-runner(s): ${batch.join(", ")}`);
}

function scopeRunnerSlugFromBody(body: string): string | null {
  if (!body.includes("aidlc-orchestrate.ts next --scope")) return null;
  const m = body.match(/aidlc-orchestrate\.ts\s+next\s+--scope\s+([a-z][a-z0-9-]*)\b/);
  return m?.[1] ?? null;
}

function pruneScopeRunners(skillsDir: string, keep: ReadonlySet<string>): void {
  if (!existsSync(skillsDir)) return;
  const legacyBareSlugs = pluginOwnedScopeSlugsForLegacy();
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const slug = generatedRunnerSlugForPrune(
      join(dir, "SKILL.md"),
      entry.name,
      scopeRunnerSlugFromBody,
      legacyBareSlugs,
    );
    if (slug && !keep.has(slug)) rmSync(dir, { recursive: true, force: true });
  }
}

// =========================================================================
// DISPATCH
// =========================================================================

export function main(argv: string[]): void {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "write": {
      const written = handleWrite();
      console.log(`Wrote ${written.length} stage-runner dirs under skills/.`);
      break;
    }
    case "check":
      handleCheck();
      break;
    case "list":
      console.log(stageSlugs().join("\n"));
      break;
    case "scopes":
      handleScopes(rest);
      break;
    default:
      console.error(
        `Unknown subcommand: ${subcommand ?? "(none)"}. Valid: write, check, list, scopes`,
      );
      process.exit(1);
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`aidlc-runner-gen: ${errorMessage(e)}`);
    process.exit(1);
  }
}
