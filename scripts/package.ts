#!/usr/bin/env bun
// scripts/package.ts — THE build entry for the one-core-N-harnesses layout.
//
//   bun scripts/package.ts            regenerate dist/{claude,kiro,codex}
//   bun scripts/package.ts --check     total drift guard (exit 1 on any drift)
//   bun scripts/package.ts <name>      regenerate just one harness
//   bun scripts/package.ts <name> --check
//
// PIPELINE PER HARNESS (per the engine design, generalized from the proven S4 prototype and
// the package-codex.ts engine):
//   1. COPY core/<src> → dist/<name>/<harnessDir>/<dst>, substituting
//      {{HARNESS_DIR}} → harnessDir in .md prose (the ONE transform class) and
//      applying the manifest's rules-dir rename.
//   2. COPY harness/<name>/<src> → dist/<name>/<harnessDir>/<dst> (authored
//      surfaces: orchestrator skill, CLAUDE.md/AGENTS.md, settings/config), same
//      token substitution on .md.
//   3. COMPILE the stage graph into the assembled tree (emits harness-correct
//      stage-graph.json + scope-grid.json — compiled data lives only in dist).
//   4. GENERATE runners into the assembled tree by composing aidlc-runner-gen's
//      exported render fns under AIDLC_HARNESS_DIR (the proven codex idiom, now
//      uniform for all three harnesses).
//   5. EMIT via harness/<name>/emit.ts if the manifest declares one (codex only
//      today: config.toml, hooks.json, trust-seed, agent TOMLs, .agents/skills).
//
// THE TRANSFORM CLASS (T5 — the only permitted text transform): the harness-dir
// token. core/ prose carries {{HARNESS_DIR}}; here it becomes `.claude`/`.kiro`/
// `.codex`. Truthful carve-outs in core (workspace-detection's 3-dir list, the
// `$CLAUDE_PROJECT_DIR on Claude Code` note) never carried the token, so they
// pass through untouched.
//
// --check is the freshness-diff idiom (aidlc-graph.ts compile --check): build
// each tree into a temp dir, diff byte-for-byte against the committed dist/,
// exit 1 with the offending paths on any drift. dist/ stays committed; this
// guard fails CI when someone hand-edits a dist or forgets to regenerate.

import {
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { HarnessManifest } from "./manifest-types.ts";
import { renderOnboarding } from "./onboarding.ts";
import {
  kiroModelDefaults,
  projectTier,
  readEnvCap,
  readMemoryCap,
} from "../core/tools/aidlc-tiers.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_ROOT = join(REPO_ROOT, "core");
const HARNESS_ROOT = join(REPO_ROOT, "harness");

// The pack-time tier cap, resolved ONCE for the whole build: the
// AIDLC_TIER_CAP env var (per-invocation) beats the persistent space-memory
// `tier_cap:` frontmatter key (core/memory org.md -> team.md -> project.md,
// last writer wins). The env var applies to WRITE runs only - a one-shot
// build knob. Under --check it is IGNORED: the drift guard must compare
// what the committed dist was legitimately built from, and a stray
// AIDLC_TIER_CAP in a CI or test runner's environment must not fail (or
// mask) drift. The memory cap travels with the repo, so it applies in both
// modes and keeps write and check consistent for a project that commits a
// capped dist. The diagnostic below names the active cap and mode.
// The `codex trust` subcommand performs NO projection (it prints trust
// entries for the installer), so it skips cap resolution entirely - a
// malformed cap must not break an installer command that never uses it.
const IS_CHECK_MODE = process.argv.includes("--check");
const IS_TRUST_MODE = process.argv[2] === "codex" && process.argv[3] === "trust";
const ENV_CAP = IS_CHECK_MODE || IS_TRUST_MODE ? null : readEnvCap();
const MEMORY_CAP = IS_TRUST_MODE ? null : readMemoryCap(join(CORE_ROOT, "memory"));
const TIER_CAP = ENV_CAP ?? MEMORY_CAP;
if (TIER_CAP) {
  // stderr, not stdout: the `codex trust` subcommand's stdout is pasted
  // verbatim into a config.toml and must stay clean.
  console.error(
    `[tier] pack-time tier cap active: ${TIER_CAP} ` +
      `(source: ${ENV_CAP ? "AIDLC_TIER_CAP env var" : "core/memory tier_cap:"})`,
  );
} else if (IS_CHECK_MODE && process.env.AIDLC_TIER_CAP) {
  console.error(
    "[tier] AIDLC_TIER_CAP is set but IGNORED under --check " +
      "(the env cap is a one-shot write knob; persistent caps live in core/memory)",
  );
}
// The shared onboarding-doc skeleton, rendered per harness (scripts/onboarding.ts).
const ONBOARDING_SKELETON = join(CORE_ROOT, "templates", "onboarding.md");
const HARNESS_TOKEN = /\{\{HARNESS_DIR\}\}/g;

// Harnesses the packager builds = every harness/<name>/ that carries a
// manifest.ts. DISCOVERED, not hardcoded: adding harness #N is one harness/<n>/
// dir + manifest row (+ optional emit.ts), with zero edits here — the
// one-core-many-harnesses promise. Sorted so the default build/--check order is
// stable (claude first by name).
function discoverHarnessNames(): string[] {
  if (!existsSync(HARNESS_ROOT)) return [];
  return readdirSync(HARNESS_ROOT)
    .filter((n) => existsSync(join(HARNESS_ROOT, n, "manifest.ts")))
    .sort();
}

// ---------------------------------------------------------------------------
// Transform: the ONE class. Token substitution on .md prose; .json + .ts copied
// verbatim (compiled JSON is regenerated per-tree by graph compile, never
// token-bearing in core; .ts uses the runtime harnessDir() seam).
// ---------------------------------------------------------------------------
function substituteToken(s: string, harnessDir: string): string {
  return s.replace(HARNESS_TOKEN, harnessDir);
}

// Rewrite in-prose `<harnessDir>/rules/` → `<harnessDir>/<rulesRename>/` for a
// harness that renames its rules dir (kiro: steering, codex: aidlc-rules).
// Anchored on the post-substitution harness-dir form so it can't touch an
// unrelated `rules/` mention — the proven STEERING_RENAME step from the spike
// packagers. No-op when rulesRename is null (claude).
function applyRulesRename(s: string, harnessDir: string, rulesRename: string | null): string {
  if (!rulesRename) return s;
  return s.replaceAll(`${harnessDir}/rules/`, `${harnessDir}/${rulesRename}/`);
}

// Read the authored `tier:` from an agent .md's YAML FRONTMATTER (scoped to
// the block between the `---` fences - a `tier:` token in body prose never
// matches). Fails loudly when the frontmatter or the key is missing: every
// shipped agent must carry a tier, and a silent pass-through would ship an
// unprojected agent (no model/effort keys at all) without failing the build.
function agentTierFromMd(s: string, srcPath: string): string {
  // Strip a UTF-8 BOM before anchoring - macOS/Windows editors occasionally
  // save .md with one, and the ^--- anchor would otherwise miss (same
  // tolerance as the rule-frontmatter parser).
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`${srcPath}: agent .md has no YAML frontmatter block.`);
  const tierMatch = m[1].match(/^tier:\s*(\S+)\s*$/m);
  if (!tierMatch) {
    throw new Error(`${srcPath}: agent frontmatter has no tier: line (the authored contract).`);
  }
  return tierMatch[1];
}

// Rewrite an agent .md's frontmatter `tier: <t>` line into the harness-native
// keys (Claude: `model:` + optional `effort:`; Kiro: optional `model:`; Codex
// .md copies mirror Claude's shape - the TOMLs emit.ts writes are the binding
// surface there). Called AFTER the token substitution + rules-rename pass.
// A missing tier: on an agent file fails the build (agentTierFromMd). A null
// projected model/effort means the harness-native key is OMITTED: the
// harness's own session/config default applies (the inherit contract for
// judgment/balanced agents). When every key is omitted the `tier:` line is
// dropped without a replacement.
function projectTierFrontmatter(
  s: string,
  srcPath: string,
  harness: "claude" | "codex" | "kiro",
): string {
  // Only apply to files under agents/. Guard on the POSIX-normalized path
  // (srcPath carries the platform separator on Windows) because a stage .md
  // legitimately talks about "tier:" in prose.
  const posixPath = srcPath.split(sep).join("/");
  if (!posixPath.includes("/agents/") || !posixPath.endsWith("-agent.md")) return s;
  const tier = agentTierFromMd(s, srcPath);
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error(`${srcPath}: agent .md has no closed frontmatter block.`);
  const fm = m[1];
  const proj = projectTier(tier, harness, TIER_CAP); // throws on unknown tier
  const lines: string[] = [];
  if (proj.model !== null) lines.push(`model: ${proj.model}`);
  if ("effort" in proj && proj.effort !== null) lines.push(`effort: ${proj.effort}`);
  // Rebuild the frontmatter line-wise: replace the tier line with the
  // projected keys, or drop it entirely when every key is omitted. Line-wise
  // filtering (not a regex splice) removes the tier line cleanly wherever it
  // sits - first, last, or mid-frontmatter.
  const newFm = fm
    .split(/\r?\n/)
    .flatMap((line) => (/^tier:/.test(line) ? lines : [line]))
    .join("\n");
  // Function replacement: a literal `$&`/`$'` in frontmatter must not be
  // interpreted as a replacement pattern.
  return s.replace(m[0], () => `---\n${newFm}\n---\n`);
}

// Project the `"model"` field of an authored Kiro agent .json from the tier
// table. The JSONs stay hand-written (tools, resources, sandbox settings) but
// the model dial is projection-owned: the authored files carry NO "model"
// field at all (so nobody edits a value the build would overwrite), and the
// tier comes from the same-name core/agents/<slug>.md (single source of
// truth). A pinned tier ADDS the field; a null projected model leaves it
// absent - the agent-v1 schema documents the fallback ("If not specified,
// uses the default model"), which is exactly the judgment-tier inherit
// contract. Files with no core .md counterpart (the aidlc.json orchestrator
// config) pass through untouched: the orchestrator is not a tier-carrying
// persona. Never writes any effort-like key - kiro-cli fail-closes on
// unknown agent-JSON fields.
function projectKiroAgentJson(srcPath: string, content: Buffer): Buffer {
  const name = srcPath.split(sep).join("/").split("/").pop() ?? "";
  if (!name.endsWith("-agent.json")) return content;
  const coreMd = join(CORE_ROOT, "agents", name.replace(/\.json$/, ".md"));
  if (!existsSync(coreMd)) return content;
  const tier = agentTierFromMd(readFileSync(coreMd, "utf-8"), coreMd);
  const proj = projectTier(tier, "kiro", TIER_CAP);
  const parsed = JSON.parse(content.toString("utf-8")) as Record<string, unknown>;
  if (proj.model === null) delete parsed.model;
  else parsed.model = proj.model;
  // Canonical re-serialization (2-space indent, trailing newline). Key order
  // is preserved, but authored inline arrays re-expand one-per-line and
  // authored unicode escapes re-emit as raw UTF-8 - the dist form is the
  // stringify form, byte-stable under --check, not the authored bytes.
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

// Merge the tier-derived chat.modelDefaults entries into an authored Kiro
// settings/cli.json: one entry per distinct pinned Kiro model, carrying the
// highest sharing tier's effort (the collapse rule - kiroModelDefaults()).
// Authored entries (the orchestrator's opus-4.8 -> xhigh) are preserved and
// win on collision, so a hand-tuned override in harness/kiro*/settings/
// cli.json survives regeneration. CLI-only: the Kiro IDE ignores cli.json.
function projectKiroCliJson(content: Buffer): Buffer {
  const parsed = JSON.parse(content.toString("utf-8")) as Record<string, unknown>;
  const defaults = (parsed["chat.modelDefaults"] ?? {}) as Record<string, unknown>;
  for (const [model, effort] of Object.entries(kiroModelDefaults(TIER_CAP))) {
    if (!(model in defaults)) defaults[model] = { output_config: { effort } };
  }
  parsed["chat.modelDefaults"] = defaults;
  return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

function transform(
  srcPath: string,
  content: Buffer,
  harnessDir: string,
  rulesRename: string | null,
  harness?: "claude" | "codex" | "kiro",
): Buffer {
  if (srcPath.endsWith(".md")) {
    let s = substituteToken(content.toString("utf-8"), harnessDir);
    s = applyRulesRename(s, harnessDir, rulesRename);
    if (harness) s = projectTierFrontmatter(s, srcPath, harness);
    return Buffer.from(s, "utf-8");
  }
  return content;
}

// Append manifest-declared frontmatter lines to a projected .md, just before
// the closing `---` of its YAML block (manifest-types.ts frontmatterAdditions).
// Hard errors, never silent: the file must open with a frontmatter block, and
// no added line's key may already exist in it - if core later grows the same
// key, the build fails loudly instead of shipping a double.
function applyFrontmatterAdditions(
  content: string,
  lines: string[],
  file: string,
): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n(---\r?\n)/);
  if (!m) {
    throw new Error(
      `frontmatterAdditions: ${file} has no leading frontmatter block to extend.`,
    );
  }
  const fm = m[1];
  for (const line of lines) {
    const key = line.split(":")[0]?.trim();
    if (!key || !/^[A-Za-z_][\w-]*$/.test(key)) {
      throw new Error(
        `frontmatterAdditions: line "${line}" for ${file} does not start with a YAML key.`,
      );
    }
    if (new RegExp(`^${key}:`, "m").test(fm)) {
      throw new Error(
        `frontmatterAdditions: ${file} already declares "${key}:" in core - ` +
          `resolve the collision instead of shipping a duplicate key.`,
      );
    }
  }
  const insertAt = m[0].length - m[2].length;
  return `${content.slice(0, insertAt)}${lines.join("\n")}\n${content.slice(insertAt)}`;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

// Byte-diff a freshly built tree against its committed counterpart, returning
// MISSING / DIFFERS / ORPHAN problem strings prefixed by `relPrefix`. The single
// built-vs-committed walk shared by checkHarness and checkPlugins so both drift
// guards stay in lockstep (round-2: the two had drifted into separate copies).
// `generatedFiles` lets a builder pass its explicit inventory; otherwise this
// helper inventories `built` itself.
function diffTrees(
  built: string,
  committed: string,
  relPrefix: string,
  generatedFiles?: readonly string[],
): string[] {
  const problems: string[] = [];
  const builtFiles = new Set<string>();
  const files = generatedFiles ?? (existsSync(built) ? [...walk(built)] : []);
  for (const f of files) {
    const rel = relative(built, f);
    builtFiles.add(rel);
    const c = join(committed, rel);
    if (!existsSync(c)) problems.push(`MISSING in dist: ${relPrefix}/${rel}`);
    else if (!readFileSync(f).equals(readFileSync(c))) problems.push(`DIFFERS: ${relPrefix}/${rel}`);
  }
  if (existsSync(committed)) {
    for (const f of walk(committed)) {
      const rel = relative(committed, f);
      if (builtFiles.has(rel)) continue;
      problems.push(`ORPHAN in dist: ${relPrefix}/${rel}`);
    }
  }
  return problems;
}

// The two compiled-data files graph compile bootstraps its number/name seed
// from. They are regenerated into every tree, never authored in core/.
const COMPILED_DATA = ["tools/data/stage-graph.json", "tools/data/scope-grid.json"];

// The packager-emitted harness descriptor (vision T1 open-set seam): the
// runtime reads tools/data/harness.json to learn this harness's rules-subdir
// without a hardcoded map. Derived from the manifest, written into every tree.
const HARNESS_DATA = "tools/data/harness.json";

// The relocated method ("memory") — the single hand-editable source of truth
// for the layered practices (org/team/project + phases/). It is HARNESS-NEUTRAL
// (identical bytes on every harness — neutral filenames, no {{HARNESS_DIR}}
// token), so the source dir + the dist destination are constants here, not
// per-manifest. The authored source already carries the renamed/nested layout
// (core/rules/aidlc-org.md → core/memory/org.md; flat aidlc-phase-<p>.md →
// core/memory/phases/<p>.md) — the per-file rename map is realized by that move,
// so the packager copies the tree verbatim. The destination sits at the
// WORKSPACE ROOT (beside the harness dir), under the always-present `default`
// space, so a fresh `dist/<harness>/` copy ships a resolving method tree and the
// per-harness native include points at it (Claude @-stub, Kiro resources glob,
// Codex AGENTS.md/@-mention) — one copy, no drift.
const MEMORY_SRC = "memory";
const MEMORY_DST = join("aidlc", "spaces", "default", "memory");

// Engine-only-install self-heal: the SAME method content (core/memory/) ALSO emitted
// INSIDE the engine dir at <harnessDir>/tools/data/memory-seed/, mirroring how
// tools/data/templates ships (an engine-bundled, copy-out-at-runtime data dir
// resolved relative to the running tool — see frameworkTemplatesDir/DATA_DIR in
// aidlc-graph.ts). This lets an ENGINE-ONLY install (a user who copies only
// dist/<h>/.<engine>/ and NOT the sibling aidlc/ shell) self-heal: the first
// /aidlc seeds aidlc/spaces/default/memory/ from this bundled copy if (and only
// if) it is absent (see ensureWorkspaceDirs). The sibling MEMORY_DST shell STILL
// ships for normal installs — this is an additive fallback, not a replacement.
const MEMORY_SEED_DST = join("tools", "data", "memory-seed");

// The active-space CURSOR shipped as part of the workspace shell (SEED). It
// lives at aidlc/active-space (ABOVE spaces/, not inside memory/) and holds the
// name of the space the next /aidlc resolves against. Ships pointed at the
// always-present "default" space so a fresh copy resolves with zero ceremony.
// NOTE: it is GITIGNORED in the user's workspace (a per-user session cursor,
// vision 5.1 - teammates legitimately point at different spaces at once), yet
// dist must SHIP it as part of the shell. The two reconcile: the dist
// .gitignore ignores aidlc/active-space for the END USER (their first /aidlc
// cursor-write stays untracked), while OUR repo commits the shipped pointer
// once (git add -f on the seed commit) - after which it is tracked and the
// gitignore is moot for that path here, exactly like a shipped default .env.
const ACTIVE_SPACE_REL = join("aidlc", "active-space");
const ACTIVE_SPACE_VALUE = "default\n";

// Write tools/data/harness.json from manifest data. Today it carries just the
// rules-subdir (the one rename the runtime must know per-tree); the object shape
// leaves room for future per-harness runtime facts. Pretty-printed + trailing
// newline so the committed file is diff-friendly and stable under --check.
function writeHarnessData(treeRoot: string, m: HarnessManifest): void {
  const data = { harnessDir: m.harnessDir, rulesSubdir: m.rulesRename ?? "rules" };
  const dst = join(treeRoot, HARNESS_DATA);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, `${JSON.stringify(data, null, 2)}\n`);
}

// Emit the method ("memory") tree at the WORKSPACE ROOT of the dist tree
// (dist/<name>/aidlc/spaces/default/memory/), copying core/memory/ verbatim with
// the standard .md token transform (a no-op on the neutral method files, which
// carry no {{HARNESS_DIR}} token). Same source + destination for every harness
// — the method is harness-neutral; the per-harness native include is what
// differs.
function emitMemory(
  outRoot: string,
  harnessDir: string,
  rulesRename: string | null,
  harness: "claude" | "codex" | "kiro",
): void {
  const srcDir = join(CORE_ROOT, MEMORY_SRC);
  if (!existsSync(srcDir)) return;
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    const outPath = join(outRoot, MEMORY_DST, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(file, readFileSync(file), harnessDir, rulesRename, harness));
  }
}

// Engine-only-install self-heal: emit the SAME core/memory/ tree a SECOND time,
// INSIDE the engine dir at <treeRoot>/tools/data/memory-seed/, so an engine-only
// install carries the method content with it (the first /aidlc copies it out via
// ensureWorkspaceDirs/frameworkMemorySeedDir). Mirrors emitMemory's transform
// (a no-op on the neutral method files) but writes into treeRoot (the harness
// engine dir), so the generated-root inventory covers it. Same source as
// emitMemory, different destination.
function emitMemorySeed(
  treeRoot: string,
  harnessDir: string,
  rulesRename: string | null,
  harness: "claude" | "codex" | "kiro",
): void {
  const srcDir = join(CORE_ROOT, MEMORY_SRC);
  if (!existsSync(srcDir)) return;
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    const outPath = join(treeRoot, MEMORY_SEED_DST, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(file, readFileSync(file), harnessDir, rulesRename, harness));
  }
}

// Emit the active-space CURSOR (aidlc/active-space -> "default") into the dist
// tree, as part of the workspace shell (SEED). Lives at the dist root beside
// the harness dir (dist/<name>/aidlc/active-space), OUTSIDE <harnessDir>, like
// the memory tree and projectRoot harness files. Harness-neutral: same pointer
// value for every harness (the resolver follows it identically). The dist
// .gitignore ignores this path for the END USER's workspace; OUR repo commits
// the shipped pointer via git add -f on the seed commit (see the
// ACTIVE_SPACE_REL note).
function emitActiveSpace(outRoot: string): void {
  const outPath = join(outRoot, ACTIVE_SPACE_REL);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, ACTIVE_SPACE_VALUE);
}

// Copy the committed compiled-data JSON into the assembled tree so
// compileStageGraph() can harvest the number/name seed before it re-derives
// (and rewrites harness-correct paths into) the file. The number/name mapping
// is harness-INDEPENDENT (slug → number/name), so any harness's committed JSON
// is a valid seed; compile re-derives every other field and emits
// harness-correct paths. `seedFrom` is the committed <harnessDir> tree; if it
// lacks the JSON (a harness's first-ever build), fall back to the committed
// claude tree's JSON as the canonical seed-of-record.
function seedCompiledData(treeRoot: string, seedFrom: string): void {
  const claudeSeedRoot = join(REPO_ROOT, "dist", "claude", ".claude");
  for (const rel of COMPILED_DATA) {
    let src = join(seedFrom, rel);
    if (!existsSync(src)) src = join(claudeSeedRoot, rel); // first build: seed from claude
    if (!existsSync(src)) continue;
    const dst = join(treeRoot, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }
}

// ---------------------------------------------------------------------------
// Build one harness tree into `outRoot` (the dist/<name> dir). Returns the full
// generated-file inventory rooted there, including project-root files beside
// <harnessDir> (onboarding/config, workspace memory, emitted skills, and so on).
// `seedFrom` is the committed <harnessDir> tree the compiled-data seed is read
// from (the same tree under --check; a pre-sweep stash under write).
// ---------------------------------------------------------------------------
function buildTree(m: HarnessManifest, outRoot: string, seedFrom: string): string[] {
  const harnessDir = m.harnessDir;
  const treeRoot = join(outRoot, harnessDir);
  // Every harness projects onto ONE of the three flavors the tier module
  // knows (Kiro CLI and Kiro IDE share the "kiro" flavor - identical model
  // dial). Declared per manifest, never inferred from the harness name.
  const harnessKind = m.tierFlavor;
  // 1. Copy core dirs with token substitution + rules rename. Manifest-declared
  //    frontmatter additions (harness-native fields, e.g. the Kiro IDE's
  //    subagent `tools:` grant) are appended during this projection; every
  //    declared file must be hit exactly once (typo/rename guard).
  const fmAdditions = new Map(
    (m.frontmatterAdditions ?? []).map(({ file, lines }) => [file, lines]),
  );
  const fmApplied = new Set<string>();
  for (const { src, dst } of m.coreDirs) {
    const srcDir = join(CORE_ROOT, src);
    if (!existsSync(srcDir)) continue;
    const finalDst = m.rulesRename && dst === "rules" ? m.rulesRename : dst;
    for (const file of walk(srcDir)) {
      const rel = relative(srcDir, file);
      const outPath = join(treeRoot, finalDst, rel);
      mkdirSync(dirname(outPath), { recursive: true });
      let out = transform(file, readFileSync(file), harnessDir, m.rulesRename, harnessKind);
      // Manifest keys are POSIX; normalize the platform separator so the
      // lookup works on Windows too.
      const harnessRel = join(finalDst, rel).split(sep).join("/");
      const fmLines = fmAdditions.get(harnessRel);
      if (fmLines) {
        out = Buffer.from(
          applyFrontmatterAdditions(out.toString("utf-8"), fmLines, harnessRel),
          "utf-8",
        );
        fmApplied.add(harnessRel);
      }
      writeFileSync(outPath, out);
    }
  }
  const fmMissed = [...fmAdditions.keys()].filter((f) => !fmApplied.has(f));
  if (fmMissed.length > 0) {
    throw new Error(
      `[${m.name}] frontmatterAdditions name file(s) the core projection never produced: ` +
        `${fmMissed.join(", ")} - fix the path(s) in the manifest.`,
    );
  }

  // 2. Copy authored harness surfaces (token substitution on .md). projectRoot
  //    files land beside the harness dir (e.g. dist/kiro/AGENTS.md), the rest
  //    inside <harnessDir>/. On the kiro harnesses two authored JSON surfaces
  //    are additionally tier-projected: the agent .json "model" fields and the
  //    settings/cli.json chat.modelDefaults entries (effort rides on the model
  //    on Kiro - see aidlc-tiers.ts).
  const harnessSrcRoot = join(HARNESS_ROOT, m.name);
  for (const { src, dst, projectRoot } of m.harnessFiles) {
    const srcPath = join(harnessSrcRoot, src);
    if (!existsSync(srcPath)) continue;
    const outPath = projectRoot ? join(outRoot, dst) : join(treeRoot, dst);
    mkdirSync(dirname(outPath), { recursive: true });
    let out = transform(srcPath, readFileSync(srcPath), harnessDir, m.rulesRename, harnessKind);
    if (harnessKind === "kiro") {
      if (src.startsWith("agents/") && src.endsWith(".json")) {
        out = projectKiroAgentJson(srcPath, out);
      } else if (src === "settings/cli.json") {
        out = projectKiroCliJson(out);
      }
    }
    writeFileSync(outPath, out);
  }

  // 2b. Render the onboarding doc from the shared skeleton (scripts/onboarding.ts),
  //     then run it through the SAME transform as any core .md — so {{HARNESS_DIR}}
  //     and the rules-rename are applied identically. The skeleton is the single
  //     source for every harness's onboarding doc; codex renders its own (with a
  //     Codex-specific header) inside emit(), so its manifest leaves onboarding null.
  if (m.onboarding) {
    const { dst, projectRoot, fills } = m.onboarding;
    const rendered = renderOnboarding(readFileSync(ONBOARDING_SKELETON, "utf-8"), fills);
    const outPath = projectRoot ? join(outRoot, dst) : join(treeRoot, dst);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(dst, Buffer.from(rendered, "utf-8"), harnessDir, m.rulesRename, harnessKind));
  }

  // 2c. Emit the relocated method ("memory") tree at the workspace root
  //     (dist/<name>/aidlc/spaces/default/memory/). MUST run before compile —
  //     the compile step's loadRules resolves rules_in_context from this tree
  //     (AIDLC_RULES_DIR points there below), so it has to exist first.
  const memoryDir = join(outRoot, MEMORY_DST);
  emitMemory(outRoot, harnessDir, m.rulesRename, harnessKind);

  // 2d. Emit the active-space cursor (aidlc/active-space -> "default") — part of
  //     the shipped shell so a fresh copy resolves the default space with no
  //     ceremony (SEED). Outside <harnessDir>, like the memory tree.
  emitActiveSpace(outRoot);

  // 2e. Engine-only-install self-heal: bundle the SAME method content INSIDE the
  //     engine dir at <harnessDir>/tools/data/memory-seed/, so an engine-only
  //     install (no sibling aidlc/ shell) can self-heal — the first /aidlc copies
  //     it out via ensureWorkspaceDirs. Inside <harnessDir>, so the generated
  //     root inventory byte-diffs it under --check.
  emitMemorySeed(treeRoot, harnessDir, m.rulesRename, harnessKind);

  // 3. Compile the stage graph into the assembled tree (writes harness-correct
  //    stage-graph.json + scope-grid.json). compileStageGraph() bootstraps each
  //    stage's number + name from the EXISTING stage-graph.json (the
  //    "computed-not-authored" seed contract — stage-definition.md), so seed the
  //    assembled tree with the committed dist JSON before compiling. Compile is
  //    idempotent on that seed: it re-derives every other field from the YAML
  //    and rewrites harness-correct paths, reproducing the committed JSON
  //    byte-for-byte. The seed is the only authored datum in the compiled file.
  seedCompiledData(treeRoot, seedFrom);
  // Point loadRules at the emitted method tree via AIDLC_RULES_DIR so
  // rules_in_context is populated at compile time. The method now lives at the
  // workspace-root aidlc/spaces/default/memory/ (NOT inside <harnessDir>), so
  // every harness — claude included — needs the seam set; the resolver's own
  // default would resolve relative to the in-tree tools/ dir, which points at
  // the same place, but the assembled tmp tree under --check makes the explicit
  // override the robust choice. The renameRulesInCompiledData backstop still
  // runs for renamed-rules harnesses to normalize any residual <dir>/rules/
  // prose-path that a future code path might emit (guarded no-op today).
  runTool(treeRoot, harnessDir, ["tools/aidlc-graph.ts", "compile"], memoryDir);
  if (m.rulesRename) renameRulesInCompiledData(treeRoot, harnessDir, m.rulesRename);

  // 3b. Emit tools/data/harness.json — the runtime's open-set source of truth
  //     for the rules-subdir rename. rulesSubdir() (aidlc-lib.ts) reads it so a
  //     real install of a rename-rules harness resolves its rule dir with ZERO
  //     core edits (the rename is manifest data, not a hardcoded map). Derived
  //     purely from the manifest, so unseeded; written into the same tools/data/
  //     the compile step just created, hence walked + byte-diffed by --check
  //     like any other generated file.
  writeHarnessData(treeRoot, m);

  // 4. Generate runners by composing aidlc-runner-gen's CLIs against the
  //    assembled tree (write + scopes). AIDLC_HARNESS_DIR steers harnessDir()
  //    so generated prose names the correct dir; AIDLC_SRC roots the tree.
  //    Codex skips this — it ships no <harnessDir>/skills/; emit() composes the
  //    whole skill set into .agents/skills/ instead.
  if (!m.skipRunnerGen) {
    runTool(treeRoot, harnessDir, ["tools/aidlc-runner-gen.ts", "write"]);
    runTool(treeRoot, harnessDir, ["tools/aidlc-runner-gen.ts", "scopes"]);
  }

  // 5. Per-shell emissions (codex only today). These may live outside
  //    <harnessDir> (e.g. .agents/skills/ and root AGENTS.md); the generated
  //    root inventory includes them automatically.
  if (m.emit) {
    m.emit({
      repoRoot: REPO_ROOT,
      coreRoot: CORE_ROOT,
      harnessRoot: harnessSrcRoot,
      distRoot: outRoot,
      harnessDir,
      substituteToken: (s: string) => substituteToken(s, harnessDir),
      tierCap: TIER_CAP,
    });
  }
  return [...walk(outRoot)];
}

// Run an in-tree tool (bun <treeRoot>/<rel> ...) with the harness env seams set
// so the tool resolves the assembled tree and interpolates the right harness dir.
// `rulesDirAbs` (absolute) points loadRules at the emitted method tree
// (dist/<name>/aidlc/spaces/default/memory/) so rules_in_context is populated at
// compile time — every harness needs it now that the method lives at the
// workspace root, not inside <harnessDir>.
function runTool(
  treeRoot: string,
  harnessDir: string,
  args: string[],
  rulesDirAbs?: string | null,
): void {
  const toolPath = join(treeRoot, args[0]);
  const rest = args.slice(1);
  const env: Record<string, string> = {
    ...process.env,
    AIDLC_SRC: treeRoot,
    AIDLC_HARNESS_DIR: harnessDir,
  };
  if (rulesDirAbs) env.AIDLC_RULES_DIR = rulesDirAbs;
  const res = spawnSync("bun", [toolPath, ...rest], {
    cwd: treeRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    console.error(`packager: \`bun ${args.join(" ")}\` failed in ${treeRoot}`);
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
    process.exit(1);
  }
}

// Defense-in-depth backstop: rewrite any residual "<harnessDir>/rules/" →
// "<harnessDir>/<rulesRename>/" in the compiled JSON path strings. Since the
// rulesSubdir() seam landed, compile (run under AIDLC_HARNESS_DIR) emits the
// renamed segment directly, so this normally matches nothing (guarded by the
// `out !== s` check). It stays as a safety net in case a future code path emits
// a literal "rules" segment that bypasses the seam. Slash-anchored, so it can
// only touch the rules path family.
function renameRulesInCompiledData(treeRoot: string, harnessDir: string, rulesRename: string): void {
  for (const rel of COMPILED_DATA) {
    const p = join(treeRoot, rel);
    if (!existsSync(p)) continue;
    const s = readFileSync(p, "utf-8");
    const out = s.replaceAll(`${harnessDir}/rules/`, `${harnessDir}/${rulesRename}/`);
    if (out !== s) writeFileSync(p, out);
  }
}

function loadManifest(name: string): HarnessManifest {
  const mod = require(join(HARNESS_ROOT, name, "manifest.ts")) as { default: HarnessManifest };
  return mod.default;
}

// ---------------------------------------------------------------------------
// write mode: regenerate dist/<name> in place (clean-sweep).
// ---------------------------------------------------------------------------
function writeHarness(name: string): void {
  const m = loadManifest(name);
  const distDir = join(REPO_ROOT, "dist", name);
  const treeRoot = join(distDir, m.harnessDir);
  // Stash the committed compiled-data seed before the clean sweep so compile
  // can bootstrap its number/name mappings (the seed survives the regenerate).
  // When a manifest renames its harnessDir, treeRoot does not exist yet. Read
  // the canonical Claude seed before sweeping dist/<name>/ as a fallback; for
  // the Claude harness that fallback lives inside the root about to be removed.
  const seedStash = mkdtempSync(join(tmpdir(), `aidlc-seed-${name}-`));
  try {
    const seedRoots = [treeRoot, join(REPO_ROOT, "dist", "claude", ".claude")];
    for (const rel of COMPILED_DATA) {
      const src = seedRoots.map((root) => join(root, rel)).find(existsSync);
      if (src) {
        const dst = join(seedStash, rel);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst);
      }
    }
    // dist/<name>/ is one generated root. Sweep that root, not selected
    // subdirectories, so removed/renamed project-root outputs cannot linger.
    // Siblings at dist/ (plugins, specifications, and unrelated assets) remain
    // outside this harness-owned boundary.
    if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
    buildTree(m, distDir, seedStash);
    console.log(`[${name}] regenerated dist/${name}/${m.harnessDir}`);
  } finally {
    rmSync(seedStash, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// check mode: build into a temp dir, diff byte-for-byte vs committed dist/<name>.
// ---------------------------------------------------------------------------
function checkHarness(name: string): string[] {
  const m = loadManifest(name);
  const committedDistRoot = join(REPO_ROOT, "dist", name);
  const committedTreeRoot = join(committedDistRoot, m.harnessDir);
  const tmp = mkdtempSync(join(tmpdir(), `aidlc-pkg-${name}-`));
  let problems: string[] = [];
  try {
    // Seed compile from the committed tree (untouched under --check).
    const generatedFiles = buildTree(m, tmp, committedTreeRoot);
    // The whole harness distribution is generated, not just <harnessDir>.
    // Diffing its root makes every generated file part of the same
    // bidirectional contract: missing/modified root onboarding and config are
    // caught, and outputs removed or renamed in a manifest become ORPHANs.
    problems = diffTrees(tmp, committedDistRoot, name, generatedFiles);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`[${name}] --check: ${problems.length === 0 ? "OK" : `${problems.length} problem(s)`}`);
  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);

// `package.ts codex trust --project <abs-dir> [--hooks-json <abs-path>]` —
// print the codex hook-trust entries with <PROJECT_DIR> substituted, for the
// installer to paste into $CODEX_HOME/config.toml (the trust-seed.toml recipe).
if (argv[0] === "codex" && argv[1] === "trust") {
  const usage =
    "usage: package.ts codex trust --project <abs-dir> [--hooks-json <abs-path>]";
  const failTrustArgs = (reason: string): never => {
    console.error(`codex trust: ${reason}`);
    console.error(usage);
    process.exit(1);
  };
  const fullyQualifiedOnEitherPlatform = (path: string): boolean => {
    const startsAsUnc = path.startsWith("\\\\") || path.startsWith("//");
    if (startsAsUnc) {
      return /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path);
    }
    return posix.isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path);
  };
  let project: string | null = null;
  let hooksJson: string | null = null;
  const trustArgs = argv.slice(2);
  for (let i = 0; i < trustArgs.length; i += 2) {
    const flag = trustArgs[i];
    const value = trustArgs[i + 1];
    if (flag !== "--project" && flag !== "--hooks-json") {
      failTrustArgs(`unknown argument "${flag}"`);
    }
    if (!value || value.startsWith("--")) {
      failTrustArgs(`${flag} requires an absolute path`);
    }
    if (!fullyQualifiedOnEitherPlatform(value)) {
      failTrustArgs(`${flag} must be a fully qualified absolute path`);
    }
    if (flag === "--project") {
      if (project !== null) failTrustArgs("--project may be specified only once");
      project = value;
    } else {
      if (hooksJson !== null) failTrustArgs("--hooks-json may be specified only once");
      hooksJson = value;
    }
  }
  const resolvedProject = project ?? failTrustArgs("--project is required");
  const { trustEntries } = require(join(HARNESS_ROOT, "codex", "emit.ts")) as {
    trustEntries: (project: string, hooksJson?: string) => string;
  };
  console.log(trustEntries(resolvedProject, hooksJson ?? undefined));
  process.exit(0);
}

const PLUGINS_ROOT = join(REPO_ROOT, "plugins");

function discoverPluginNames(): string[] {
  if (!existsSync(PLUGINS_ROOT)) return [];
  const names = readdirSync(PLUGINS_ROOT)
    .filter((n) => existsSync(join(PLUGINS_ROOT, n, ".aidlc-plugin", "plugin.json")))
    .sort();
  // `aidlc` and `aidlc-*` are core's namespace: `aidlc` is the implicit core
  // plugin in selection, and an `aidlc-<x>` plugin's runner dirs land on core
  // runner paths (runner-gen uses the bare slug for plugin stages but
  // `aidlc-<slug>` for core), silently clobbering them.
  for (const n of names) {
    if (n === "aidlc" || n.startsWith("aidlc-")) {
      throw new Error(
        `plugins/${n}: plugin names must not be "aidlc" or start with "aidlc-" (reserved for core; an aidlc-<x> plugin collides with core runner paths). Rename the plugin directory.`
      );
    }
  }
  return names;
}

// Per-harness plugin projection descriptor, DERIVED from each harness's own
// manifest rather than a hardcoded map — so a new harness added per the
// one-core-many-harnesses promise automatically gets a plugin projection instead
// of being silently skipped (the omission class that lost kiro-ide in round 1).
// harnessLeaf = manifest.harnessDir; manifestDir + kind come from the manifest's
// optional `plugin` block, defaulting to "<harnessDir>-plugin" + "store".
type PluginTarget = { manifestDir: string; harnessLeaf: string; kind: "store" | "kiro" };
function pluginTargetFor(harnessName: string): PluginTarget | null {
  if (!existsSync(join(HARNESS_ROOT, harnessName, "manifest.ts"))) return null;
  const m = loadManifest(harnessName);
  const harnessLeaf = m.harnessDir;
  const manifestDir = m.plugin?.manifestDir ?? `${harnessLeaf}-plugin`;
  const kind = m.plugin?.kind ?? "store";
  return { manifestDir, harnessLeaf, kind };
}

// Render ONE plugin's projection for ONE harness into `outDir`. Pure builder —
// no logging, no dist-path assumptions — so both the write path (into dist/) and
// the --check path (into a temp dir, then byte-compare) call it identically.
function buildPluginProjection(pluginName: string, harnessName: string, outDir: string): void {
  const pluginSrc = join(PLUGINS_ROOT, pluginName);
  const manifestPath = join(pluginSrc, ".aidlc-plugin", "plugin.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    // Name the plugin and the file, not a raw JSON.parse stack that reads as
    // a packager crash - one plugin's bad manifest should be identifiable.
    throw new Error(
      `plugins/${pluginName}: cannot parse ${relative(REPO_ROOT, manifestPath)}: ${e instanceof Error ? e.message : String(e)}. Fix the manifest JSON.`
    );
  }
  const version = manifest.version || "0.0.1";
  const author = manifest.author || { name: "AIDLC" };
  const description = manifest.description || "";
  const target = pluginTargetFor(harnessName);
  if (!target) throw new Error(`no plugin target for harness "${harnessName}" (missing manifest)`);
  const { manifestDir, harnessLeaf, kind } = target;
  const templateHooks = join(REPO_ROOT, "scripts", "plugin-hooks-template");
  // Primitive content copied verbatim into the host plugin projection. Core
  // scope files keep the `aidlc-` prefix; plugin scope files use
  // `<plugin>-<name>.md` instead, with frontmatter `name` equal to the stem.
  // Plugin agent files follow `<plugin>-<role>-agent.md` with the same stem =
  // frontmatter-name convention.
  const contentDirs = ["stages", "sensors", "tools", "contributions", "scopes", "agents", "knowledge"];

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. Host-native manifest (.claude-plugin / .codex-plugin / .kiro-plugin).
  const hostManifestDir = join(outDir, manifestDir);
  mkdirSync(hostManifestDir, { recursive: true });
  writeFileSync(
    join(hostManifestDir, "plugin.json"),
    JSON.stringify({ name: `aidlc-${pluginName}`, version, description, author }, null, 2) + "\n"
  );

  // 2. Marketplace catalogue entry.
  writeFileSync(
    join(hostManifestDir, "marketplace.json"),
    JSON.stringify({
      name: "aidlc-plugins",
      owner: author,
      description: "AIDLC plugin catalogue.",
      plugins: [{ name: `aidlc-${pluginName}`, source: ".", version, description }],
    }, null, 2) + "\n"
  );

  // 3. The one bun compose hook + per-harness wiring. The hook command's only
  //    shell job is finding bun on a bare PATH (PATH, then ~/.bun/bin); all
  //    compose logic is in compose.ts. Claude populates CLAUDE_PLUGIN_ROOT,
  //    Codex PLUGIN_ROOT; AIDLC_HARNESS_DIR targets the right harness tree.
  const hooksDir = join(outDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  for (const f of readdirSync(templateHooks)) cpSync(join(templateHooks, f), join(hooksDir, f));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansions
  const rootExpr = harnessName === "claude" ? "${CLAUDE_PLUGIN_ROOT}" : "${PLUGIN_ROOT}";
  // Resolve bun on a bare PATH (PATH, then ~/.bun/bin). If neither is executable,
  // exit 0 with a note rather than running a non-existent binary — the pre-fold
  // compose.sh skipped gracefully, and a hard 127 would fire on every SessionStart
  // (including non-AIDLC projects that merely have the plugin installed). S1.
  const bunExpr =
    'BUN=$(command -v bun 2>/dev/null || true); ' +
    '[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"; ' +
    '[ -z "$BUN" ] && { echo "aidlc plugin compose: bun not found, skipping" >&2; exit 0; }';
  const command = `sh -c '${bunExpr}; AIDLC_HARNESS_DIR=${harnessLeaf} "$BUN" "${rootExpr}/hooks/compose.ts"'`;

  if (kind === "kiro") {
    writeFileSync(
      join(hooksDir, "aidlc-plugin-compose.kiro.hook"),
      JSON.stringify({
        version: "1.0.0",
        enabled: true,
        name: `aidlc-${pluginName}-compose`,
        description: `Composes the ${pluginName} AIDLC plugin on first interaction.`,
        when: { type: "promptSubmit" },
        // biome-ignore lint/suspicious/noThenProperty: required Kiro hook schema field
        then: { type: "runCommand", command },
      }, null, 2) + "\n"
    );
  } else {
    writeFileSync(
      join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{
            hooks: [{ type: "command", command, statusMessage: `AIDLC ${pluginName}: composing plugin` }],
          }],
        },
      }, null, 2) + "\n"
    );
  }

  // 4. Copy plugin content verbatim (stages keep number/name/plugin/when).
  // walk() is recursive, so nested phase dirs and knowledge/<agent-slug>/ trees
  // are preserved without special cases.
  for (const dir of contentDirs) {
    const srcDir = join(pluginSrc, dir);
    if (!existsSync(srcDir)) continue;
    for (const file of walk(srcDir)) {
      const outPath = join(outDir, dir, relative(srcDir, file));
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, readFileSync(file));
    }
  }
}

// Which harnesses get a projection = every built harness with a manifest (each
// derives a plugin target). Derived, so a new harness is covered automatically.
function pluginHarnessesFor(harnesses: string[]): string[] {
  return harnesses.filter((h) => pluginTargetFor(h) !== null);
}

function emitPlugins(harnesses: string[]): void {
  for (const pluginName of discoverPluginNames()) {
    for (const harnessName of pluginHarnessesFor(harnesses)) {
      buildPluginProjection(pluginName, harnessName, join(REPO_ROOT, "dist", "plugins", pluginName, harnessName));
      console.log(`[plugin:${pluginName}] emitted dist/plugins/${pluginName}/${harnessName}/`);
    }
  }
}

// --check for plugins: build each projection into a temp dir and byte-compare
// against the committed dist/plugins/ tree — the same drift guard writeHarness
// gets, closing the gap where a hand-edited plugin dist passed CI silently.
// `full` = this is a whole-repo check (every harness), so the top-level orphan
// sweep is meaningful; a NAMED single-harness check (`package.ts codex --check`)
// passes false, since the other harnesses' committed projections are not orphans
// then — they're simply out of this run's scope.
function checkPlugins(harnesses: string[], full: boolean): string[] {
  const problems: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "aidlc-pkg-plugins-"));
  const plugins = discoverPluginNames();
  try {
    for (const pluginName of plugins) {
      for (const harnessName of pluginHarnessesFor(harnesses)) {
        const committed = join(REPO_ROOT, "dist", "plugins", pluginName, harnessName);
        const built = join(tmp, pluginName, harnessName);
        buildPluginProjection(pluginName, harnessName, built);
        problems.push(...diffTrees(built, committed, `plugins/${pluginName}/${harnessName}`));
      }
    }
    // Top-level orphan sweep (whole-repo check only): a plugin dir deleted from
    // plugins/ (or a stray harness subdir the build no longer emits) leaves an
    // unguarded committed dist/plugins/<name>/ tree the per-plugin loop never
    // visits. Flag any committed plugin/harness dir with no live source.
    if (full) {
      const distPlugins = join(REPO_ROOT, "dist", "plugins");
      const liveHarnesses = new Set(pluginHarnessesFor(harnesses));
      if (existsSync(distPlugins)) {
        for (const name of readdirSync(distPlugins)) {
          if (!plugins.includes(name)) {
            problems.push(`ORPHAN in dist: plugins/${name}/ (no plugins/${name}/ source — delete the committed tree)`);
            continue;
          }
          for (const h of readdirSync(join(distPlugins, name))) {
            if (!liveHarnesses.has(h)) {
              problems.push(`ORPHAN in dist: plugins/${name}/${h}/ (no such harness — delete the committed tree)`);
            }
          }
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

// `package.ts plugin build <plugin> <harness> <outDir>` — render ONE plugin
// projection into an arbitrary dir. The target-dir seam that lets t188 (and any
// caller) exercise the real emitter WITHOUT touching the committed dist/plugins/
// trees — writeHarness/emitPlugins rmSync + rewrite dist, which a parallel test
// tier must never do (it masks drift and races sibling tests). Pure builder call.
if (argv[0] === "plugin" && argv[1] === "build") {
  const rest = argv.slice(2).filter((a) => a !== "--force");
  const force = argv.includes("--force");
  const [pluginName, harnessName, outDir] = rest;
  if (!pluginName || !harnessName || !outDir) {
    console.error("usage: package.ts plugin build <plugin> <harness> <outDir> [--force]");
    process.exit(1);
  }
  // Proper usage errors, never a raw ENOENT/rmSync stack (round-3).
  // Reserved-name check FIRST so the error names the real problem even when
  // the directory doesn't exist yet (same rule discoverPluginNames enforces).
  if (pluginName === "aidlc" || pluginName.startsWith("aidlc-")) {
    console.error(`plugin name "${pluginName}" is reserved: names must not be "aidlc" or start with "aidlc-" (an aidlc-<x> plugin collides with core runner paths). Rename the plugin.`);
    process.exit(1);
  }
  if (!discoverPluginNames().includes(pluginName)) {
    console.error(`unknown plugin "${pluginName}" (have: ${discoverPluginNames().join(", ") || "none"})`);
    process.exit(1);
  }
  const target = pluginTargetFor(harnessName);
  if (!target) {
    console.error(`unknown plugin harness "${harnessName}" (have: ${discoverHarnessNames().join(", ")})`);
    process.exit(1);
  }
  // outDir GUARD: buildPluginProjection rmSync's outDir first, so refuse a
  // non-empty dir that is not itself a prior projection unless --force —
  // `plugin build test-pro claude .` must not wipe cwd.
  // Strip trailing separators BEFORE resolving: `lstatSync("<link>/")` resolves
  // THROUGH a symlink (so a trailing-slash symlink outDir bypassed the symlink
  // refusal below and wiped the target — merge-review ask #2).
  const outArg = outDir.replace(/[/\\]+$/, "") || outDir;
  const resolvedOut = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
  // A symlink path entry (including a BROKEN one, which existsSync reports as
  // false because it follows the link) would slip past the existsSync guard and
  // make mkdirSync throw a raw EEXIST stack. lstatSync sees the link itself —
  // refuse any symlink outDir with a proper usage error (round-6).
  let outLstat: ReturnType<typeof statSync> | null = null;
  try { outLstat = lstatSync(resolvedOut); } catch { outLstat = null; }
  if (outLstat?.isSymbolicLink()) {
    console.error(`refusing to build into "${outDir}" — it is a symlink; point at a real directory path.`);
    process.exit(1);
  }
  if (existsSync(resolvedOut)) {
    // A FILE (not a directory) outDir would make readdirSync throw a raw ENOTDIR
    // stack — give a proper usage error instead (the round-3 guard's promise).
    if (!statSync(resolvedOut).isDirectory()) {
      console.error(`refusing to build into "${outDir}" — it is a file, not a directory.`);
      process.exit(1);
    }
    if (readdirSync(resolvedOut).length > 0) {
      // A prior projection is overwritable; anything else needs --force. The
      // marker is NOT just "a .claude-plugin/ dir exists" — every real Claude
      // plugin has one, so that false-positive let `plugin build ... .` wipe a
      // FOREIGN plugin checkout silently (merge-review ask #1). Require the
      // marker's plugin.json to parse AND carry an `aidlc-`-prefixed name (what
      // our own projections emit), so only a genuine AIDLC projection qualifies.
      const isPriorProjection = (() => {
        try {
          const mf = join(resolvedOut, target.manifestDir, "plugin.json");
          if (!existsSync(mf)) return false;
          const m = JSON.parse(readFileSync(mf, "utf-8"));
          return typeof m?.name === "string" && m.name.startsWith("aidlc-");
        } catch { return false; }
      })();
      if (!isPriorProjection && !force) {
        console.error(
          `refusing to build into non-empty "${outDir}" — it is not a prior AIDLC plugin projection ` +
          `(no ${target.manifestDir}/plugin.json with an aidlc- name). Pass --force to overwrite, or point at a fresh/empty dir.`
        );
        process.exit(1);
      }
    }
  }
  buildPluginProjection(pluginName, harnessName, resolvedOut);
  process.exit(0);
}

const check = argv.includes("--check");
const named = argv.find((a) => !a.startsWith("--"));
// Default targets are DISCOVERED from harness/ (one manifest = one harness); a
// named target builds just that one.
const targets = named ? [named] : discoverHarnessNames();

if (named && !existsSync(join(HARNESS_ROOT, named, "manifest.ts"))) {
  console.error(
    `unknown harness "${named}" (have: ${discoverHarnessNames().join(", ") || "none"})`,
  );
  process.exit(1);
}

if (check) {
  let problems: string[] = [];
  for (const n of targets) problems = problems.concat(checkHarness(n));
  // drift-guard dist/plugins/ too; the top-level orphan sweep runs only on a
  // whole-repo check (no named target), never a single-harness one.
  problems = problems.concat(checkPlugins(targets, !named));
  if (problems.length > 0) {
    console.error(`\npackage --check FAILED (${problems.length} problem(s)):`);
    for (const p of problems.slice(0, 40)) console.error("  " + p);
    process.exit(1);
  }
  console.log("package --check: all harness trees in sync with core/ + harness/.");
} else {
  for (const n of targets) writeHarness(n);
  // Emit plugin projections (the hybrid: per-harness host plugins from plugins/<name>/)
  emitPlugins(targets);
}
