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
//
// (2) SCOPE-RUNNERS: one thin `skills/aidlc-<scope>/SKILL.md` per
//     shipped `.claude/scopes/aidlc-<name>.md` file. A scope-runner is packaging,
//     not definition (decision D-A): each is a ~6-line shell that drives the
//     engine (`aidlc-orchestrate next --scope <scope>`) to `done` with a fixed
//     scope and no scope detection. The full set of scopes is always reachable
//     via `/aidlc --scope <name>`; runners are typeable sugar over the
//     high-traffic ones (the FIRST_BATCH).
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
//                      `.claude/scopes/*.md` (FIRST_BATCH, or `--all`).
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
import { fileURLToPath } from "node:url";
import { errorMessage, harnessDir } from "./aidlc-lib.ts";
import { type GraphStage, loadGraph } from "./aidlc-graph.ts";

// Resolve the skills/ dir off THIS module's location (tools/ → ../skills/) so the
// generator writes into the shipped tree regardless of the caller's cwd, mirroring
// how the engine resolves aidlc-common/ and the stage files.
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(TOOLS_DIR, "..", "skills");

// =========================================================================
// STAGE-RUNNER HALF
// =========================================================================

// The dir name for a stage's runner skill: `aidlc-<slug>`. The skill `name`
// frontmatter equals the dir name (Agent-Skills-spec invariant t123 asserts).
function runnerDirName(slug: string): string {
  return `aidlc-${slug}`;
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
  const dir = runnerDirName(node.slug);
  return `---
name: ${dir}
description: >
  Run the AI-DLC \`${node.slug}\` stage (${node.phase} phase) in isolation, without
  advancing the main workflow. Packages \`/aidlc --stage ${node.slug} --single\`:
  the engine emits one run-stage directive for ${node.slug} and its gate, the
  conductor runs it, then the single-stage run commits a synthetic-id pair and
  stops. The main workflow's Current Stage is never touched.
argument-hint: ""
user-invocable: true
---

# AI-DLC Stage Runner — ${node.slug}

Run the \`${node.slug}\` stage on its own. This is opt-in packaging over
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

// Render the `/aidlc-init` runner: a thin wrapper over `/aidlc --init` (which
// runs the whole initialization phase — scaffold + workspace-detection +
// state-init — in one deterministic call). This is the init-phase analogue of
// the per-stage runners: opt-in packaging over a path the orchestrator already
// exposes. It drives `--init`, NOT `--stage … --single`, so the stage-runner
// drift guard (which keys on the `--stage`+`--single` marker) never counts it.
export function renderInitRunner(): string {
  return `---
name: ${INIT_RUNNER_DIR}
description: >
  Scaffold an AI-DLC workspace — run the whole Initialization phase
  (scaffold the aidlc-docs/ tree, detect the workspace, initialise state) in one
  step, without starting a stage workflow. Packaging over \`/aidlc --init\`,
  which works without this skill. Pass \`--force\` to reinitialise an existing
  workspace; \`--scope <name>\` to seed the initial scope (defaults to poc).
argument-hint: "[--force] [--scope <name>]"
user-invocable: true
---

# AI-DLC — initialize a workspace

Scaffold a fresh AI-DLC workspace. This is opt-in packaging over
\`/aidlc --init\`; the same initialization runs via that flag without this skill.
Initialization is a PHASE, not a single stage — it scaffolds the \`aidlc-docs/\`
directory tree, detects the workspace (greenfield/brownfield), and initialises
\`aidlc-state.md\` together, in one deterministic call. There is no per-init-stage
runner because an init stage has no standalone meaning.

## Steps

1. Run the initialization phase:

   \`\`\`bash
   bun ${harnessDir()}/tools/aidlc-utility.ts init $ARGUMENTS
   \`\`\`

   Pass \`$ARGUMENTS\` through verbatim — \`--force\` reinitialises over an existing
   \`aidlc-state.md\`, and \`--scope <name>\` seeds the initial scope (defaults to
   \`poc\`). Print the tool's output and stop. This does not start a stage
   workflow; run \`/aidlc\` (or a scope runner) afterwards to begin one.
`;
}

// Write (or refresh) every stage-runner dir from the RUNNABLE stage list (init
// stages excluded — see isRunnableStage), plus the single `/aidlc-init` phase
// wrapper. Idempotent: re-running emits byte-identical SKILL.md files. Also
// PRUNES any stale init-phase stage-runner dir (aidlc-state-init,
// aidlc-workspace-detection, aidlc-workspace-scaffold) left by an earlier
// generation that emitted runners for all 32 stages. Returns the slugs written.
function handleWrite(): string[] {
  const slugs = stageSlugs();
  for (const node of runnableStages()) {
    const dir = join(SKILLS_DIR, runnerDirName(node.slug));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), renderStageRunner(node), "utf-8");
  }
  // Emit the init-phase wrapper.
  const initDir = join(SKILLS_DIR, INIT_RUNNER_DIR);
  if (!existsSync(initDir)) mkdirSync(initDir, { recursive: true });
  writeFileSync(join(initDir, "SKILL.md"), renderInitRunner(), "utf-8");
  // Prune stale per-init-stage runner dirs from an earlier all-32 generation.
  for (const node of loadGraph()) {
    if (isRunnableStage(node)) continue;
    const staleDir = join(SKILLS_DIR, runnerDirName(node.slug));
    const staleSkill = join(staleDir, "SKILL.md");
    if (isRunnerSkill(staleSkill)) rmSync(staleDir, { recursive: true, force: true });
  }
  return slugs;
}

// The on-disk runner SIGNATURE: a stage-runner's SKILL.md drives
// `aidlc-orchestrate next --stage <slug> --single`. Identifying runners by this
// body marker — NOT by compiled-set membership — is what lets the drift guard see
// ORPHANS: a `skills/aidlc-<slug>/` dir that drives `--single` but whose slug is
// no longer a compiled stage. Non-runner skills (aidlc, aidlc-replay,
// aidlc-session-cost, aidlc-outcomes-pack, and the scope-runners, which drive
// `--scope` not `--stage`) carry no `--stage … --single` marker, so they are
// never mistaken for stage-runners and never flagged.
const SINGLE_RUNNER_MARKER = "--stage";
function isRunnerSkill(skillMdPath: string): boolean {
  if (!existsSync(skillMdPath)) return false;
  const body = readFileSync(skillMdPath, "utf-8");
  return body.includes(SINGLE_RUNNER_MARKER) && body.includes("--single");
}

// The on-disk stage-runner set: every `skills/aidlc-<slug>/` dir whose SKILL.md
// is a stage-runner (carries the `--single` signature). Returns the slugs —
// compiled or not — so the caller can compute BOTH missing (compiled, no runner)
// AND orphan (runner, not compiled) divergences.
function onDiskRunnerSlugs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("aidlc-")) continue;
    const slug = entry.name.slice("aidlc-".length);
    if (isRunnerSkill(join(SKILLS_DIR, entry.name, "SKILL.md"))) {
      found.push(slug);
    }
  }
  return found;
}

// Stage-runner drift guard (t129's mechanism): the on-disk runner set must be
// EXACTLY the compiled stage-slug set — no stage missing a runner, no orphan
// runner for a stage the graph dropped. Exit 1 with a legible diff on any
// divergence so a stage added to the graph without regenerating runners fails
// loudly.
function handleCheck(): void {
  const compiled = stageSlugs();
  const compiledSet = new Set(compiled);
  const onDisk = new Set(onDiskRunnerSlugs());

  const missing = compiled.filter((s) => !onDisk.has(s)).sort();
  const orphans = [...onDisk].filter((s) => !compiledSet.has(s)).sort();

  if (missing.length === 0 && orphans.length === 0) {
    console.log(
      `stage-runner set is in sync with the compiled stage graph (${compiled.length} runners).`,
    );
    return;
  }
  if (missing.length > 0) {
    console.log(`MISSING runners (stage in graph, no skills/aidlc-<slug>/): ${missing.join(", ")}`);
  }
  if (orphans.length > 0) {
    console.log(`ORPHAN runners (skills/aidlc-<slug>/ with no matching stage): ${orphans.join(", ")}`);
  }
  console.log(`Run \`bun ${harnessDir()}/tools/aidlc-runner-gen.ts write\` to regenerate.`);
  process.exit(1);
}

// =========================================================================
// SCOPE-RUNNER HALF
// =========================================================================

// The first batch of scopes that ship a typeable runner skill. Author-decided
// (high-traffic + the named bugfix): `bugfix` (the spec's headline example),
// `feature` (the highest-traffic standard greenfield scope), `mvp` (the common
// greenfield starting point), and `security-patch` (high-value incremental).
// Every other scope still runs via `/aidlc --scope <name>` — runners are
// packaging, not definition. Pass `--all` to emit a runner per shipped scope.
export const FIRST_BATCH: readonly string[] = [
  "bugfix",
  "feature",
  "mvp",
  "security-patch",
];

function scopesDir(): string {
  return process.env.AIDLC_SCOPES_DIR ?? join(TOOLS_DIR, "..", "scopes");
}

function defaultSkillsDir(): string {
  return SKILLS_DIR;
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
}

// Read a scope file's frontmatter. Throws on a missing frontmatter block or a
// missing `name` (the generator must never silently emit a malformed runner).
function readScopeFront(path: string): ScopeFront {
  const body = readFileSync(path, "utf-8");
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`Scope file missing frontmatter: ${path}`);
  const fm = m[1];
  const name = scalarField(fm, "name");
  if (!name) throw new Error(`Scope file ${path} missing required frontmatter: name`);
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
  return { name, description };
}

// Discover the shipped scope names (sorted, platform-independent). Each scope
// file is `.claude/scopes/aidlc-<name>.md`; the canonical name is its `name`
// frontmatter field (not the filename, which carries the aidlc- prefix).
export function discoverScopes(): Record<string, ScopeFront> {
  const dir = scopesDir();
  const out: Record<string, ScopeFront> = {};
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    const front = readScopeFront(join(dir, f));
    out[front.name] = front;
  }
  return out;
}

// Render the SKILL.md body for one scope-runner. Spec-conformant frontmatter
// (`name` == dir name == `aidlc-<scope>`), NO `hooks:` block (the six spine
// hooks live in settings.json project-wide, inherited by every runner), and
// a ~6-line shell that runs the engine forwarding loop with the scope baked in.
export function renderRunner(scope: string, description: string): string {
  const dir = `aidlc-${scope}`;
  // Normalise the scope's one-line description into a sentence (trailing period)
  // so it reads cleanly when stitched between the lead-in and the packaging note.
  const raw = (description || `Run the AI-DLC workflow with the ${scope} scope`).trim();
  const desc = /[.!?]$/.test(raw) ? raw : `${raw}.`;
  return `---
name: ${dir}
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
any flags (\`--status\`, \`--stage\`, \`--test-run\`, …) and the \`--scope\` from the
state file always wins on an existing workflow, so re-running a started workflow
resumes it. To run a different scope, use \`/aidlc --scope <other>\` instead.
`;
}

// The target SKILL.md path for one scope-runner under a skills dir.
function scopeRunnerPath(skillsDir: string, scope: string): string {
  return join(skillsDir, `aidlc-${scope}`, "SKILL.md");
}

// Resolve the batch of scopes to generate: --all → every shipped scope;
// otherwise the FIRST_BATCH (filtered to scopes that actually have a file).
function resolveBatch(all: boolean, discovered: Record<string, ScopeFront>): string[] {
  if (all) return Object.keys(discovered).sort();
  return FIRST_BATCH.filter((s) => s in discovered).sort();
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
  const skillsDir = out ?? defaultSkillsDir();
  const discovered = discoverScopes();
  const batch = resolveBatch(all, discovered);

  if (batch.length === 0) {
    console.error("No scope files found — nothing to generate.");
    process.exit(1);
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
  console.log(`Generated ${batch.length} scope-runner(s): ${batch.join(", ")}`);
}

// =========================================================================
// DISPATCH
// =========================================================================

function main(): void {
  const [, , subcommand, ...rest] = process.argv;
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
    main();
  } catch (e) {
    console.error(`aidlc-runner-gen: ${errorMessage(e)}`);
    process.exit(1);
  }
}
