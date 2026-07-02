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
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { HarnessManifest } from "./manifest-types.ts";
import { renderOnboarding } from "./onboarding.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_ROOT = join(REPO_ROOT, "core");
const HARNESS_ROOT = join(REPO_ROOT, "harness");
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

function transform(
  srcPath: string,
  content: Buffer,
  harnessDir: string,
  rulesRename: string | null,
): Buffer {
  if (srcPath.endsWith(".md")) {
    let s = substituteToken(content.toString("utf-8"), harnessDir);
    s = applyRulesRename(s, harnessDir, rulesRename);
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
// carry no {{HARNESS_DIR}} token). Returns the absolute paths it wrote so
// checkHarness can byte-diff them (they live OUTSIDE <harnessDir>, like the
// projectRoot harness files). Same source + destination for every harness — the
// method is harness-neutral; the per-harness native include is what differs.
function emitMemory(outRoot: string, harnessDir: string, rulesRename: string | null): string[] {
  const srcDir = join(CORE_ROOT, MEMORY_SRC);
  const written: string[] = [];
  if (!existsSync(srcDir)) return written;
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    const outPath = join(outRoot, MEMORY_DST, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(file, readFileSync(file), harnessDir, rulesRename));
    written.push(outPath);
  }
  return written;
}

// Engine-only-install self-heal: emit the SAME core/memory/ tree a SECOND time,
// INSIDE the engine dir at <treeRoot>/tools/data/memory-seed/, so an engine-only
// install carries the method content with it (the first /aidlc copies it out via
// ensureWorkspaceDirs/frameworkMemorySeedDir). Mirrors emitMemory's transform
// (a no-op on the neutral method files) but writes into treeRoot (the harness
// engine dir), so the normal in-harness walk + byte-diff covers it — no
// outsideHarness bookkeeping needed. Same source as emitMemory, different dst.
function emitMemorySeed(treeRoot: string, harnessDir: string, rulesRename: string | null): void {
  const srcDir = join(CORE_ROOT, MEMORY_SRC);
  if (!existsSync(srcDir)) return;
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    const outPath = join(treeRoot, MEMORY_SEED_DST, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(file, readFileSync(file), harnessDir, rulesRename));
  }
}

// Emit the active-space CURSOR (aidlc/active-space -> "default") into the dist
// tree, as part of the workspace shell (SEED). Lives at the dist root beside
// the harness dir (dist/<name>/aidlc/active-space), OUTSIDE <harnessDir>, like
// the memory tree and projectRoot harness files. Returns the absolute path it
// wrote so checkHarness can byte-diff + orphan-scan it. Harness-neutral: same
// pointer value for every harness (the resolver follows it identically). The
// dist .gitignore ignores this path for the END USER's workspace; OUR repo
// commits the shipped pointer via git add -f on the seed commit (see the
// ACTIVE_SPACE_REL note).
function emitActiveSpace(outRoot: string): string {
  const outPath = join(outRoot, ACTIVE_SPACE_REL);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, ACTIVE_SPACE_VALUE);
  return outPath;
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
// Build one harness tree into `outRoot` (the dist/<name> dir). Returns the set
// of paths the copy+generate steps produced, for the orphan scan.
// `seedFrom` is the committed <harnessDir> tree the compiled-data seed is read
// from (the same tree under --check; a pre-sweep stash under write).
// ---------------------------------------------------------------------------
function buildTree(m: HarnessManifest, outRoot: string, seedFrom: string): string[] {
  const harnessDir = m.harnessDir;
  const treeRoot = join(outRoot, harnessDir);
  // Out-of-harness paths the build produced (memory tree + any emit output),
  // returned for checkHarness's byte-diff of files OUTSIDE <harnessDir>.
  const outsideHarness: string[] = [];

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
      let out = transform(file, readFileSync(file), harnessDir, m.rulesRename);
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
  //    inside <harnessDir>/.
  const harnessSrcRoot = join(HARNESS_ROOT, m.name);
  for (const { src, dst, projectRoot } of m.harnessFiles) {
    const srcPath = join(harnessSrcRoot, src);
    if (!existsSync(srcPath)) continue;
    const outPath = projectRoot ? join(outRoot, dst) : join(treeRoot, dst);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(srcPath, readFileSync(srcPath), harnessDir, m.rulesRename));
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
    writeFileSync(outPath, transform(dst, Buffer.from(rendered, "utf-8"), harnessDir, m.rulesRename));
  }

  // 2c. Emit the relocated method ("memory") tree at the workspace root
  //     (dist/<name>/aidlc/spaces/default/memory/). MUST run before compile —
  //     the compile step's loadRules resolves rules_in_context from this tree
  //     (AIDLC_RULES_DIR points there below), so it has to exist first.
  const memoryDir = join(outRoot, MEMORY_DST);
  outsideHarness.push(...emitMemory(outRoot, harnessDir, m.rulesRename));

  // 2d. Emit the active-space cursor (aidlc/active-space -> "default") — part of
  //     the shipped shell so a fresh copy resolves the default space with no
  //     ceremony (SEED). Outside <harnessDir>, like the memory tree.
  outsideHarness.push(emitActiveSpace(outRoot));

  // 2e. Engine-only-install self-heal: bundle the SAME method content INSIDE the
  //     engine dir at <harnessDir>/tools/data/memory-seed/, so an engine-only
  //     install (no sibling aidlc/ shell) can self-heal — the first /aidlc copies
  //     it out via ensureWorkspaceDirs. Inside <harnessDir>, so the in-harness
  //     walk byte-diffs it under --check (no outsideHarness entry).
  emitMemorySeed(treeRoot, harnessDir, m.rulesRename);

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
  runTool(treeRoot, ["tools/aidlc-graph.ts", "compile"], memoryDir);
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
    runTool(treeRoot, ["tools/aidlc-runner-gen.ts", "write"]);
    runTool(treeRoot, ["tools/aidlc-runner-gen.ts", "scopes"]);
  }

  // 5. Per-shell emissions (codex only today). Returns the absolute paths it
  //    wrote, so the caller can byte-diff emit-owned files that live OUTSIDE
  //    <harnessDir> (e.g. .agents/skills/, the root AGENTS.md) under --check.
  if (m.emit) {
    outsideHarness.push(
      ...m.emit({
        repoRoot: REPO_ROOT,
        coreRoot: CORE_ROOT,
        harnessRoot: harnessSrcRoot,
        distRoot: outRoot,
        harnessDir,
        substituteToken: (s: string) => substituteToken(s, harnessDir),
        check: false,
      }).written,
    );
  }
  return outsideHarness;
}

// Run an in-tree tool (bun <treeRoot>/<rel> ...) with the harness env seams set
// so the tool resolves the assembled tree and interpolates the right harness dir.
// `rulesDirAbs` (absolute) points loadRules at the emitted method tree
// (dist/<name>/aidlc/spaces/default/memory/) so rules_in_context is populated at
// compile time — every harness needs it now that the method lives at the
// workspace root, not inside <harnessDir>.
function runTool(treeRoot: string, args: string[], rulesDirAbs?: string | null): void {
  const toolPath = join(treeRoot, args[0]);
  const rest = args.slice(1);
  const harnessDir = treeRoot.endsWith(".kiro")
    ? ".kiro"
    : treeRoot.endsWith(".codex")
      ? ".codex"
      : ".claude";
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
  const seedStash = mkdtempSync(join(tmpdir(), `aidlc-seed-${name}-`));
  try {
    for (const rel of COMPILED_DATA) {
      const src = join(treeRoot, rel);
      if (existsSync(src)) {
        const dst = join(seedStash, rel);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst);
      }
    }
    // Clean sweep the harness dir so removed core files don't linger.
    if (existsSync(treeRoot)) rmSync(treeRoot, { recursive: true, force: true });
    // Also sweep the workspace-root method tree (dist/<name>/aidlc/) so a
    // removed/renamed memory file (e.g. a dropped phase rule) doesn't linger
    // beside the freshly emitted one — the harness-dir sweep above misses it.
    const memoryRoot = join(distDir, "aidlc");
    if (existsSync(memoryRoot)) rmSync(memoryRoot, { recursive: true, force: true });
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
  const committed = join(REPO_ROOT, "dist", name, m.harnessDir);
  const tmp = mkdtempSync(join(tmpdir(), `aidlc-pkg-${name}-`));
  const problems: string[] = [];
  try {
    // Seed compile from the committed tree (untouched under --check).
    const emitWritten = buildTree(m, tmp, committed);
    const builtRoot = join(tmp, m.harnessDir);
    // Built → committed: MISSING / DIFFERS.
    const builtFiles = new Set<string>();
    for (const f of walk(builtRoot)) {
      const rel = relative(builtRoot, f);
      builtFiles.add(rel);
      const want = readFileSync(f);
      const committedPath = join(committed, rel);
      if (!existsSync(committedPath)) problems.push(`MISSING in dist: ${name}/${m.harnessDir}/${rel}`);
      else if (!readFileSync(committedPath).equals(want))
        problems.push(`DIFFERS: ${name}/${m.harnessDir}/${rel}`);
    }
    // Committed → built: ORPHAN (a committed file the build didn't produce).
    if (existsSync(committed)) {
      for (const f of walk(committed)) {
        const rel = relative(committed, f);
        if (builtFiles.has(rel)) continue;
        if (m.authoredExempt.some((re) => re.test(rel))) continue;
        problems.push(`ORPHAN in dist: ${name}/${m.harnessDir}/${rel}`);
      }
    }
    // Project-root harness files (e.g. dist/<name>/AGENTS.md) live OUTSIDE the
    // harness dir — diff each explicitly (built into tmp/<dst> vs dist/<name>/<dst>).
    const committedDistRoot = join(REPO_ROOT, "dist", name);
    for (const { dst, projectRoot } of m.harnessFiles) {
      if (!projectRoot) continue;
      const built = readFileSync(join(tmp, dst));
      const committedPath = join(committedDistRoot, dst);
      if (!existsSync(committedPath)) problems.push(`MISSING in dist: ${name}/${dst}`);
      else if (!readFileSync(committedPath).equals(built)) problems.push(`DIFFERS: ${name}/${dst}`);
    }
    // Emit-owned files OUTSIDE <harnessDir> (codex: .agents/skills/, root
    // AGENTS.md). buildTree returns their tmp paths; diff each against committed.
    const emitOutsideHarness = emitWritten.filter((p) => !p.startsWith(join(tmp, m.harnessDir) + "/"));
    const committedEmitSet = new Set<string>();
    for (const builtPath of emitOutsideHarness) {
      const rel = relative(tmp, builtPath);
      committedEmitSet.add(rel);
      const committedPath = join(committedDistRoot, rel);
      if (!existsSync(committedPath)) problems.push(`MISSING in dist: ${name}/${rel}`);
      else if (!readFileSync(committedPath).equals(readFileSync(builtPath)))
        problems.push(`DIFFERS: ${name}/${rel}`);
    }
    // Orphan scan over out-of-harness dirs the build owns (codex emit's
    // .agents/; the method tree at aidlc/). committedEmitSet holds every
    // out-of-harness file the build produced (emit output + the memory tree), so
    // a committed file under these roots that the build DIDN'T produce is a
    // stale orphan — e.g. a removed phase rule still committed under
    // dist/<name>/aidlc/spaces/default/memory/phases/.
    for (const sub of [".agents", "aidlc"]) {
      const dir = join(committedDistRoot, sub);
      if (!existsSync(dir)) continue;
      for (const f of walk(dir)) {
        const rel = relative(committedDistRoot, f);
        if (!committedEmitSet.has(rel)) problems.push(`ORPHAN in dist: ${name}/${rel}`);
      }
    }
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
  const pIdx = argv.indexOf("--project");
  if (pIdx === -1 || !argv[pIdx + 1]) {
    console.error("usage: package.ts codex trust --project <abs-dir> [--hooks-json <abs-path>]");
    process.exit(1);
  }
  const hIdx = argv.indexOf("--hooks-json");
  const { trustEntries } = require(join(HARNESS_ROOT, "codex", "emit.ts")) as {
    trustEntries: (project: string, hooksJson?: string) => string;
  };
  console.log(trustEntries(argv[pIdx + 1], hIdx !== -1 ? argv[hIdx + 1] : undefined));
  process.exit(0);
}

const check = argv.includes("--check");
const named = argv.find((a) => !a.startsWith("--"));
// Default targets are DISCOVERED from harness/ (one manifest = one harness); a
// named target builds just that one.
const targets = named ? [named] : discoverHarnessNames();

// Only build harnesses that actually have a manifest. Discovery already
// guarantees this, so the filter only matters for an explicit named target that
// lacks a manifest — surface that as a skip rather than a crash.
const present = targets.filter((n) => existsSync(join(HARNESS_ROOT, n, "manifest.ts")));
const absent = targets.filter((n) => !present.includes(n));
if (absent.length > 0) console.log(`(skipping harness(es) without a manifest: ${absent.join(", ")})`);

if (check) {
  let problems: string[] = [];
  for (const n of present) problems = problems.concat(checkHarness(n));
  if (problems.length > 0) {
    console.error(`\npackage --check FAILED (${problems.length} problem(s)):`);
    for (const p of problems.slice(0, 40)) console.error("  " + p);
    process.exit(1);
  }
  console.log("package --check: all harness trees in sync with core/ + harness/.");
} else {
  for (const n of present) writeHarness(n);
}
