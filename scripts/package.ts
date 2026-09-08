#!/usr/bin/env bun
// scripts/package.ts — THE build entry for the one-core-N-harnesses layout.
//
//   bun scripts/package.ts            regenerate dist/{claude,kiro,kiro-ide,codex}
//   bun scripts/package.ts --check     determinism guard (exit 1 on mismatch)
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
//      uniform for all shipped harnesses).
//   5. EMIT via harness/<name>/emit.ts if the manifest declares one (codex only
//      today: config.toml, hooks.json, trust-seed, agent TOMLs, .agents/skills).
//   6. REFRESH generated stage/scope table regions in the assembled orchestrator
//      skill from the just-compiled graph and scope grid.
//
// THE TRANSFORM CLASS (T5 — the only permitted text transform): the harness-dir
// token. core/ prose carries {{HARNESS_DIR}}; here it becomes `.claude`/`.kiro`/
// `.codex`. Truthful carve-outs in core (workspace-detection's 3-dir list, the
// `$CLAUDE_PROJECT_DIR on Claude Code` note) never carried the token, so they
// pass through untouched.
//
// --check builds the complete copy-channel, native-release, and plugin
// projections twice in independent temp roots, then compares them byte for
// byte. It never reads dist/ or dist-release/, so it works from a fresh clone
// and fails CI only when the generator is nondeterministic.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { HarnessManifest } from "./manifest-types.ts";
import {
  absorbReviewerKnowledge,
  agentNameFromPath,
  injectDelegatedKnowledgePreflight,
  reviewerAgentSet,
} from "./agent-knowledge.ts";
import { renderOnboarding } from "./onboarding.ts";
import {
  buildPluginProjection as emitPluginProjection,
  type PluginTarget,
  type PluginTargetTable,
} from "../core/tools/aidlc-plugin-emit.ts";
import {
  type Harness,
  readEnvCap,
  readMemoryCap,
  type Tier,
} from "../core/tools/aidlc-tiers.ts";
import {
  agentTiersFromAuthoredDirectory,
  modelAgentName,
  resolveModelPolicy,
  serializeAgentTiers,
  writeKiroAgentSurface,
  writeKiroCliSurface,
  writeMarkdownAgentSurface,
} from "../core/tools/aidlc-model-policy.ts";
import {
  scanNamespaceInvocations,
  TRUSTED_COMMAND_PREFIX,
  TRUSTED_ROUTE_NAMESPACE,
  trustedCommand,
} from "../core/tools/aidlc-command.ts";
import { ROUTES } from "../core/tools/aidlc.ts";
import { AIDLC_VERSION } from "../core/tools/aidlc-version.ts";
import { sha256Bytes } from "../core/tools/aidlc-distribution.ts";
import { AIDLC_SETTINGS_SCHEMA } from "../core/tools/aidlc-settings.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_ROOT = join(REPO_ROOT, "core");
const HARNESS_ROOT = join(REPO_ROOT, "harness");

// The pack-time tier cap, resolved ONCE for the whole build: the
// AIDLC_TIER_CAP env var (per-invocation) beats the persistent space-memory
// `tier_cap:` frontmatter key (core/memory org.md -> team.md -> project.md,
// last writer wins). The env var applies to WRITE runs only - a one-shot
// build knob. Under --check it is IGNORED: the determinism guard measures the
// repository-defined projection, and a stray AIDLC_TIER_CAP in a CI or test
// runner's environment must not alter either build. The memory cap travels
// with the repo, so it applies in both modes and keeps write and check
// consistent. The diagnostic below names the active cap and mode.
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
const INVOKE_TOKEN = /\{\{INVOKE\}\}/g;
const TOOL_PREFIX_TOKEN = /\{\{TOOL_PREFIX\}\}/g;
const TRUSTED_NAMESPACE_TOKEN = /\{\{TRUSTED_NAMESPACE\}\}/g;
// Matched by PREFIX (mirroring aidlc-init.ts's marker scan): the begin marker
// embeds the harness-projected invocation, so its tail varies per channel.
const GENERATED_SKILL_REGIONS = [
  {
    verb: "stage-table",
    begin: "<!-- BEGIN: compiled stage graph via ",
    end: "<!-- END: compiled stage graph -->",
  },
  {
    verb: "scope-table",
    begin: "<!-- BEGIN: compiled scope grid via ",
    end: "<!-- END: compiled scope grid -->",
  },
] as const;

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
// Transform: the ONE class. Token substitution on authored prose and the
// TypeScript invocation seam; compiled JSON is regenerated per tree.
// ---------------------------------------------------------------------------
function substituteInvocationTokens(
  s: string,
  harnessDir: string,
  invoke = `bun ${harnessDir}/tools/aidlc.ts`,
): string {
  const toolPrefix = invoke === "aidlc" ? `${TRUSTED_COMMAND_PREFIX} ` : `bun ${harnessDir}/tools/`;
  return s
    .replace(INVOKE_TOKEN, invoke)
    .replace(TOOL_PREFIX_TOKEN, toolPrefix)
    .replace(TRUSTED_NAMESPACE_TOKEN, TRUSTED_ROUTE_NAMESPACE);
}

function substituteToken(
  s: string,
  harnessDir: string,
  invoke = `bun ${harnessDir}/tools/aidlc.ts`,
): string {
  return substituteInvocationTokens(s.replace(HARNESS_TOKEN, harnessDir), harnessDir, invoke);
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
// harness's own session/config default applies for that harness/tier
// combination. When every key is omitted the `tier:` line is dropped without
// a replacement.
function projectTierFrontmatter(
  s: string,
  srcPath: string,
  harness: Harness,
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
  const disallowedMatches = [
    ...fm.matchAll(/^disallowedTools:\s*(.*?)\s*$/gm),
  ];
  if (
    harness === "kiro" &&
    (disallowedMatches.length !== 1 ||
      !/^task$/i.test(disallowedMatches[0][1].trim()))
  ) {
    throw new Error(
      `${srcPath}: kiro projection requires exactly one disallowedTools: Task line.`,
    );
  }
  if (harness === "kiro") {
    // Kiro's native agent surface rejects unknown frontmatter keys: project the
    // authored disallowedTools line out before the model-policy rewrite.
    const newFm = fm
      .split(/\r?\n/)
      .filter((line) => !/^disallowedTools:/.test(line))
      .join("\n");
    // Function replacement: a literal `$&`/`$'` in frontmatter must not be
    // interpreted as a replacement pattern.
    s = s.replace(m[0], () => `---\n${newFm}\n---\n`);
  }
  const effective = resolveModelPolicy(
    null,
    modelAgentName(srcPath),
    tier as Tier,
    harness,
    TIER_CAP,
  );
  return writeMarkdownAgentSurface(s, effective, {
    effortKey: harness === "opencode" ? "variant" : "effort",
  });
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
  const effective = resolveModelPolicy(
    null,
    modelAgentName(name),
    tier as Tier,
    "kiro",
    TIER_CAP,
  );
  return Buffer.from(
    writeKiroAgentSurface(content.toString("utf-8"), effective),
    "utf-8",
  );
}

// Merge the tier-derived chat.modelDefaults entries into an authored Kiro
// settings/cli.json: one entry per distinct pinned Kiro model, carrying the
// highest sharing tier's effort (the collapse rule - kiroModelDefaults()).
// Authored entries (the orchestrator's opus-4.8 -> xhigh) are preserved and
// join the same higher-effort collapse on collision. CLI-only: the Kiro IDE
// ignores cli.json.
function projectKiroCliJson(content: Buffer): Buffer {
  return Buffer.from(
    writeKiroCliSurface(content.toString("utf-8"), [], TIER_CAP),
    "utf-8",
  );
}

function transform(
  srcPath: string,
  content: Buffer,
  harnessDir: string,
  rulesRename: string | null,
  harness?: Harness,
  invoke = `bun ${harnessDir}/tools/aidlc.ts`,
): Buffer {
  if (srcPath.endsWith(".md")) {
    // Reviewer knowledge absorption runs FIRST (on the raw core text) so the
    // token substitution below covers the absorbed prose like any core .md.
    let s = content.toString("utf-8");
    const agentName = agentNameFromPath(srcPath);
    if (agentName) {
      s = absorbReviewerKnowledge(s, agentName, CORE_ROOT);
      s = injectDelegatedKnowledgePreflight(s, agentName, harnessDir);
    }
    s = substituteToken(s, harnessDir, invoke);
    s = applyRulesRename(s, harnessDir, rulesRename);
    if (harness) s = projectTierFrontmatter(s, srcPath, harness);
    // Cursor, opencode, and Copilot persona bodies are mutable active-space
    // pointers. Ship their memory references on the default seed so the first
    // startup's repointHarnessIncludes(project, "default") is byte-identical;
    // later space switches still rewrite the same concrete segment in place.
    const posixPath = srcPath.split(sep).join("/");
    if (
      (harness === "cursor" || harness === "opencode" || harness === "copilot") &&
      posixPath.includes("/agents/") &&
      posixPath.endsWith("-agent.md")
    ) {
      s = s.replaceAll("aidlc/spaces/<active-space>/memory/", "aidlc/spaces/default/memory/");
    }
    return Buffer.from(s, "utf-8");
  }
  if (srcPath.endsWith(".ts")) {
    return Buffer.from(
      substituteInvocationTokens(content.toString("utf-8"), harnessDir, invoke),
      "utf-8",
    );
  }
  if (/\.(?:hook|json|toml)$/.test(srcPath)) {
    return Buffer.from(
      substituteToken(content.toString("utf-8"), harnessDir, invoke),
      "utf-8",
    );
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
  const added = new Set<string>();
  for (const line of lines) {
    if (/^\s/.test(line)) continue;
    const key = line.split(":")[0]?.trim();
    if (!key || !/^[A-Za-z_][\w-]*$/.test(key)) {
      throw new Error(
        `frontmatterAdditions: line "${line}" for ${file} does not start with a YAML key.`,
      );
    }
    if (added.has(key)) {
      throw new Error(
        `frontmatterAdditions: ${file} declares "${key}:" more than once in additions.`,
      );
    }
    added.add(key);
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

// Byte-diff two independently built trees. The caller supplies a stable
// projection prefix so diagnostics never expose temp-directory names.
function diffTrees(
  first: string,
  second: string,
  relPrefix: string,
): string[] {
  const problems: string[] = [];
  const firstFiles = new Set<string>();
  const files = existsSync(first) ? [...walk(first)] : [];
  for (const f of files) {
    const rel = relative(first, f);
    firstFiles.add(rel);
    const counterpart = join(second, rel);
    if (!existsSync(counterpart)) {
      problems.push(`MISSING in second build: ${relPrefix}/${rel}`);
    } else if (!readFileSync(f).equals(readFileSync(counterpart))) {
      problems.push(`DIFFERS between builds: ${relPrefix}/${rel}`);
    }
  }
  if (existsSync(second)) {
    for (const f of walk(second)) {
      const rel = relative(second, f);
      if (firstFiles.has(rel)) continue;
      problems.push(`ONLY in second build: ${relPrefix}/${rel}`);
    }
  }
  return problems;
}

// The two compiled-data files regenerated into every tree. The rename backstop
// below scans both after compile.
const COMPILED_DATA = ["tools/data/stage-graph.json", "tools/data/scope-grid.json"];

// The packager-emitted harness descriptor (vision T1 open-set seam): the
// runtime reads tools/data/harness.json to learn this harness's rules-subdir
// without a hardcoded map. Derived from the manifest, written into every tree.
const HARNESS_DATA = "tools/data/harness.json";
const AGENT_TIERS_DATA = "tools/data/agent-tiers.json";
const SETTINGS_SCHEMA_DATA = "tools/data/aidlc-settings.schema.json";
const STAMP_DATA = "tools/data/aidlc-stamp.json";
const PROJECTION_DATA = "tools/data/aidlc-projection.json";

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

// The plugin authoring validator must run from a copied distribution with no
// framework checkout. Ship the compose hook's source of truth beside the tool
// so a vendored hooks/compose.ts can be byte-compared offline.
const PLUGIN_HOOKS_TEMPLATE_SRC = join(
  REPO_ROOT,
  "scripts",
  "plugin-hooks-template",
);
const PLUGIN_HOOKS_TEMPLATE_DST = join(
  "tools",
  "data",
  "plugin-hooks-template",
);
const PLUGIN_TARGETS_DST = join("tools", "data", "plugin-targets.json");
const PLUGIN_AUTHORING_CONTEXT_DST = join(
  "tools",
  "data",
  "plugin-authoring-context.json",
);

// The active-space CURSOR shipped as part of the workspace shell (SEED). It
// lives at aidlc/active-space (ABOVE spaces/, not inside memory/) and holds the
// name of the space the next /aidlc resolves against. Ships pointed at the
// always-present "default" space so a fresh copy resolves with zero ceremony.
// NOTE: it is GITIGNORED in the user's workspace (a per-user session cursor,
// vision 5.1 - teammates legitimately point at different spaces at once), yet
// dist must SHIP it as part of the shell. The two reconcile: the projected
// .gitignore ignores aidlc/active-space for the END USER; a clone's first
// SessionStart or active-intent write atomically recreates the missing pointer
// and keeps it untracked. The local dist root itself is ignored.
const ACTIVE_SPACE_REL = join("aidlc", "active-space");
const ACTIVE_SPACE_VALUE = "default\n";

// Write tools/data/harness.json from manifest data. The runtime reads the
// rules-subdir and any host-native generated-runner frontmatter from this
// open-set descriptor. Pretty-printed + trailing newline keeps output
// diff-friendly and stable under --check.
function writeHarnessData(treeRoot: string, m: HarnessManifest): void {
  // A FRESH object, deliberately: the runtime READER tolerates unknown keys, but
  // this writer alone decides what ships. Anything hand-added to a local
  // harness.json is erased on the next build, so a new configuration field has
  // to be added HERE to exist at all.
  const data: Record<string, unknown> = {
    schemaVersion: 1,
    distribution: m.name,
    productName: m.productName,
    configNextStep: m.configNextStep,
    name: m.name,
    harnessDir: m.harnessDir,
    rulesSubdir: m.rulesRename ?? "rules",
    ...(m.runnerFrontmatterAdditions?.length
      ? { runnerFrontmatterAdditions: m.runnerFrontmatterAdditions }
      : {}),
  };
  // Emitted only when a manifest sets it, so the three-field output stays
  // byte-identical for every harness that does not -- which is all of them today.
  if (m.documentExtractors) data.documentExtractors = m.documentExtractors;
  const dst = join(treeRoot, HARNESS_DATA);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, `${JSON.stringify(data, null, 2)}\n`);
}

function writeAgentTiersData(treeRoot: string): void {
  const dst = join(treeRoot, AGENT_TIERS_DATA);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(
    dst,
    serializeAgentTiers(agentTiersFromAuthoredDirectory(join(CORE_ROOT, "agents"))),
  );
}

function writeSettingsSchemaData(treeRoot: string): void {
  const dst = join(treeRoot, SETTINGS_SCHEMA_DATA);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, `${JSON.stringify(AIDLC_SETTINGS_SCHEMA, null, 2)}\n`);
}

function writeProjectionData(outRoot: string, treeRoot: string, m: HarnessManifest): void {
  const rootIntegrationPaths = new Set(m.rootIntegrations.map((item) => item.path));
  if (rootIntegrationPaths.size !== m.rootIntegrations.length) {
    throw new Error(`[${m.name}] duplicate root integration path`);
  }
  for (const integration of m.rootIntegrations) {
    if (!existsSync(join(outRoot, integration.path))) {
      throw new Error(`[${m.name}] root integration is not projected: ${integration.path}`);
    }
  }
  const managedDirectories = readdirSync(outRoot)
    .filter((entry) => statSync(join(outRoot, entry)).isDirectory())
    .filter((entry) => !rootIntegrationPaths.has(entry))
    .sort();
  const allowedTopLevel = new Set([
    ...managedDirectories,
    ...m.rootIntegrations.map((item) => item.path.split("/")[0]),
  ]);
  const unclassified = readdirSync(outRoot)
    .filter((entry) => !allowedTopLevel.has(entry))
    .sort();
  if (unclassified.length > 0) {
    throw new Error(`[${m.name}] unclassified projection entries: ${unclassified.join(", ")}`);
  }
  const rootIntegrations = m.rootIntegrations.map((integration) => {
    if (integration.policy !== "managed-block") return integration;
    const currentHash = sha256Bytes(readFileSync(join(outRoot, integration.path)));
    return {
      ...integration,
      legacySignatures: {
        ...integration.legacySignatures,
        wholeFileHashes: [
          ...new Set([
            ...(integration.legacySignatures?.wholeFileHashes ?? []),
            currentHash,
          ]),
        ],
      },
    };
  });
  const projection = {
    schemaVersion: 1,
    distribution: m.name,
    productName: m.productName,
    configNextStep: m.configNextStep,
    harnessDir: m.harnessDir,
    managedDirectories,
    rootIntegrations,
  };
  const stamp = {
    schemaVersion: 1,
    frameworkVersion: AIDLC_VERSION,
    distribution: m.name,
    harnessDir: m.harnessDir,
  };
  mkdirSync(join(treeRoot, "tools", "data"), { recursive: true });
  writeFileSync(join(treeRoot, PROJECTION_DATA), `${JSON.stringify(projection, null, 2)}\n`);
  writeFileSync(join(treeRoot, STAMP_DATA), `${JSON.stringify(stamp, null, 2)}\n`);
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
  harness: Harness,
  invoke: string,
): void {
  const srcDir = join(CORE_ROOT, MEMORY_SRC);
  if (!existsSync(srcDir)) return;
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    const outPath = join(outRoot, MEMORY_DST, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(file, readFileSync(file), harnessDir, rulesRename, harness, invoke));
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
  harness: Harness,
  invoke: string,
): void {
  const srcDir = join(CORE_ROOT, MEMORY_SRC);
  if (!existsSync(srcDir)) return;
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    const outPath = join(treeRoot, MEMORY_SEED_DST, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, transform(file, readFileSync(file), harnessDir, rulesRename, harness, invoke));
  }
}

function emitPluginAuthoringData(treeRoot: string): void {
  for (const file of walk(PLUGIN_HOOKS_TEMPLATE_SRC)) {
    const outPath = join(
      treeRoot,
      PLUGIN_HOOKS_TEMPLATE_DST,
      relative(PLUGIN_HOOKS_TEMPLATE_SRC, file),
    );
    mkdirSync(dirname(outPath), { recursive: true });
    cpSync(file, outPath);
  }
  const targetsPath = join(treeRoot, PLUGIN_TARGETS_DST);
  mkdirSync(dirname(targetsPath), { recursive: true });
  writeFileSync(
    targetsPath,
    `${JSON.stringify(pluginTargets(), null, 2)}\n`,
  );
  const contextPath = join(treeRoot, PLUGIN_AUTHORING_CONTEXT_DST);
  const agents = [...walk(join(CORE_ROOT, "agents"))]
    .filter((file) => file.endsWith("-agent.md"))
    .map((file) => basename(file, ".md"))
    .sort();
  const stages = [...walk(join(CORE_ROOT, "aidlc-common", "stages"))]
    .filter((file) => file.endsWith(".md"))
    .map((file) => basename(file, ".md"))
    .sort();
  writeFileSync(
    contextPath,
    `${JSON.stringify({ agents, stages }, null, 2)}\n`,
  );
}

// Emit the active-space CURSOR (aidlc/active-space -> "default") into the dist
// tree, as part of the workspace shell (SEED). Lives at the dist root beside
// the harness dir (dist/<name>/aidlc/active-space), OUTSIDE <harnessDir>, like
// the memory tree and projectRoot harness files. Harness-neutral: same pointer
// value for every harness (the resolver follows it identically). The projected
// .gitignore ignores this path for the END USER's workspace.
function emitActiveSpace(outRoot: string): void {
  const outPath = join(outRoot, ACTIVE_SPACE_REL);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, ACTIVE_SPACE_VALUE);
}

// ---------------------------------------------------------------------------
// Build one harness tree into `outRoot` (the dist/<name> dir). Returns the full
// generated-file inventory rooted there, including project-root files beside
// <harnessDir> (onboarding/config, workspace memory, emitted skills, and so on).
// ---------------------------------------------------------------------------
function buildTree(
  m: HarnessManifest,
  outRoot: string,
  invoke = `bun ${m.harnessDir}/tools/aidlc.ts`,
): string[] {
  const harnessDir = m.harnessDir;
  const treeRoot = join(outRoot, harnessDir);
  // Every harness projects onto ONE of the five flavors the tier module
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
      let out = transform(
        file,
        readFileSync(file),
        harnessDir,
        m.rulesRename,
        harnessKind,
        invoke,
      );
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
    let out = transform(
      srcPath,
      readFileSync(srcPath),
      harnessDir,
      m.rulesRename,
      harnessKind,
      invoke,
    );
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
    writeFileSync(
      outPath,
      transform(
        dst,
        Buffer.from(rendered, "utf-8"),
        harnessDir,
        m.rulesRename,
        harnessKind,
        invoke,
      ),
    );
  }

  // 2c. Emit the relocated method ("memory") tree at the workspace root
  //     (dist/<name>/aidlc/spaces/default/memory/). MUST run before compile —
  //     the compile step's loadRules resolves rules_in_context from this tree
  //     (AIDLC_RULES_DIR points there below), so it has to exist first.
  const memoryDir = join(outRoot, MEMORY_DST);
  emitMemory(outRoot, harnessDir, m.rulesRename, harnessKind, invoke);

  // 2d. Emit the active-space cursor (aidlc/active-space -> "default") — part of
  //     the shipped shell so a fresh copy resolves the default space with no
  //     ceremony (SEED). Outside <harnessDir>, like the memory tree.
  emitActiveSpace(outRoot);

  // 2e. Engine-only-install self-heal: bundle the SAME method content INSIDE the
  //     engine dir at <harnessDir>/tools/data/memory-seed/, so an engine-only
  //     install (no sibling aidlc/ shell) can self-heal — the first /aidlc copies
  //     it out via ensureWorkspaceDirs. Inside <harnessDir>, so the generated
  //     root inventory byte-diffs it under --check.
  emitMemorySeed(treeRoot, harnessDir, m.rulesRename, harnessKind, invoke);

  // 2f. Bundle plugin authoring data beside the standalone validator/builder:
  //     hook source bytes plus the manifest-derived target table.
  emitPluginAuthoringData(treeRoot);

  // 3. Compile the stage graph into the assembled tree (writes harness-correct
  //    stage-graph.json + scope-grid.json). compileStageGraph() bootstraps each
  //    stage's number from the authored dependency graph and any display-name
  //    override from stage frontmatter. No generated tree is a build input.
  // Point loadRules at the emitted method tree via AIDLC_RULES_DIR so
  // rules_in_context is populated at compile time. The method now lives at the
  // workspace-root aidlc/spaces/default/memory/ (NOT inside <harnessDir>), so
  // every harness — claude included — needs the seam set; the resolver's own
  // default would resolve relative to the in-tree tools/ dir, which points at
  // the same place, but the assembled tmp tree under --check makes the explicit
  // override the robust choice. The renameRulesInCompiledData backstop still
  // runs for renamed-rules harnesses to normalize any residual <dir>/rules/
  // prose-path that a future code path might emit (guarded no-op today).
  runTool(treeRoot, harnessDir, m.name, ["tools/aidlc-graph.ts", "compile"], memoryDir);
  if (m.rulesRename) renameRulesInCompiledData(treeRoot, harnessDir, m.rulesRename);

  // 3b. Emit tools/data/harness.json — the runtime's open-set source of truth
  //     for the rules-subdir rename. rulesSubdir() (aidlc-lib.ts) reads it so a
  //     real install of a rename-rules harness resolves its rule dir with ZERO
  //     core edits (the rename is manifest data, not a hardcoded map). Derived
  //     purely from the manifest, so unseeded; written into the same tools/data/
  //     the compile step just created, hence walked + byte-diffed by --check
  //     like any other generated file.
  writeHarnessData(treeRoot, m);
  writeAgentTiersData(treeRoot);
  writeSettingsSchemaData(treeRoot);

  // 4. Generate runners by composing aidlc-runner-gen's CLIs against the
  //    assembled tree (write + scopes). AIDLC_HARNESS_DIR steers harnessDir()
  //    so generated prose names the correct dir; AIDLC_SRC roots the tree.
  //    Codex skips this — it ships no <harnessDir>/skills/; emit() composes the
  //    whole skill set into .agents/skills/ instead.
  if (!m.skipRunnerGen) {
    runTool(treeRoot, harnessDir, m.name, ["tools/aidlc-runner-gen.ts", "write"]);
    runTool(treeRoot, harnessDir, m.name, ["tools/aidlc-runner-gen.ts", "scopes"]);
  }

  // 5. Per-shell emissions (codex only today). These may live outside
  //    <harnessDir> (e.g. .agents/skills/ and root AGENTS.md); the generated
  //    root inventory includes them automatically.
  if (m.emit) {
    m.emit({
      repoRoot: REPO_ROOT,
      coreRoot: CORE_ROOT,
      harnessRoot: harnessSrcRoot,
      harnessName: m.name,
      distRoot: outRoot,
      harnessDir,
      trustedRouteNamespace: TRUSTED_ROUTE_NAMESPACE,
      substituteToken: (s: string) => substituteToken(s, harnessDir, invoke),
      tierCap: TIER_CAP,
    });
  }
  writeProjectionData(outRoot, treeRoot, m);

  // 6. Generated table regions are build products, not authored prose. Refresh
  //    them only after emit(), because Codex and Copilot place the orchestrator
  //    skill outside <harnessDir>/skills/.
  refreshGeneratedSkillRegions(outRoot, treeRoot, harnessDir, m);
  return [...walk(outRoot)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteKiroNativeAllowlists(outRoot: string, m: HarnessManifest): void {
  if (m.tierFlavor !== "kiro") return;
  const agentsDir = join(outRoot, m.harnessDir, "agents");
  for (const file of walk(agentsDir)) {
    if (file.endsWith(".md")) {
      // Kiro IDE persona surfaces carry a YAML shell allowlist; the native
      // channel replaces the bun tool glob with the aidlc command prefix.
      const value = readFileSync(file, "utf-8");
      const rewritten = value.replaceAll(
        `- "bun ${m.harnessDir}/tools/aidlc-*"`,
        `- "${trustedCommand("*")}"`,
      );
      if (rewritten !== value) writeFileSync(file, rewritten);
      continue;
    }
    if (!file.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(file, "utf-8")) as {
      toolsSettings?: {
        execute_bash?: {
          allowedCommands?: unknown;
        };
      };
    };
    const allowed = value.toolsSettings?.execute_bash?.allowedCommands;
    if (!Array.isArray(allowed)) continue;
    const rewritten = allowed.map((command) =>
      typeof command === "string" &&
        command.startsWith("bun ") &&
        command.includes(`${m.harnessDir.replace(".", "\\.")}/tools/`)
        ? trustedCommand(".*")
        : command
    );
    value.toolsSettings!.execute_bash!.allowedCommands = [...new Set(rewritten)];
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }
}

function rewriteClaudeNativePermissions(outRoot: string, m: HarnessManifest): void {
  if (m.tierFlavor !== "claude") return;
  const settingsPath = join(outRoot, m.harnessDir, "settings.json");
  const value = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
    permissions?: { allow?: unknown };
  };
  const allow = value.permissions?.allow;
  if (!Array.isArray(allow)) throw new Error("[claude] settings.json has no permissions.allow list");
  value.permissions!.allow = [
    ...allow.filter((entry) =>
      entry !== "Bash" &&
      !(typeof entry === "string" && entry.startsWith("Bash(bun "))
    ),
    `Bash(${trustedCommand("*")})`,
  ];
  writeFileSync(settingsPath, `${JSON.stringify(value, null, 2)}\n`);
}

function rewriteCursorNativePermissions(outRoot: string, m: HarnessManifest): void {
  if (m.tierFlavor !== "cursor") return;
  const cliPath = join(outRoot, m.harnessDir, "cli.json");
  const value = JSON.parse(readFileSync(cliPath, "utf-8")) as {
    permissions?: { allow?: unknown };
  };
  const allow = value.permissions?.allow;
  if (!Array.isArray(allow)) throw new Error("[cursor] cli.json has no permissions.allow list");
  value.permissions!.allow = [
    ...allow.filter((entry) => entry !== "Shell(bun)"),
    `Shell(${trustedCommand("*")})`,
  ];
  writeFileSync(cliPath, `${JSON.stringify(value, null, 2)}\n`);
}

function rewriteNativeOnboarding(value: string): string {
  return value
    .replace(
      /^- \*\*bun\*\*:.*$/gm,
      "- **Runtime**: Framework commands run through `aidlc`; keep that command and its runtime available.",
    )
    .replace(
      /^- \*\*Hook permissions\*\*:.*$/gm,
      "- **Hook permissions**: Framework hooks run through the self-contained `aidlc` binary. No separate script runtime or executable bits are required.",
    )
    .replace(
      /^- \*\*Permissions\*\*:.*$/gm,
      `- **Permissions**: the \`aidlc\` agent pre-approves only the native \`${TRUSTED_COMMAND_PREFIX}\` command prefix and its listed read-only tools; everything else prompts.`,
    )
    .replace(
      /TypeScript, run via bun/g,
      "TypeScript sources invoked through the self-contained `aidlc` runtime",
    )
    .replace(
      /pre-approves ONLY `bun \.kiro\/tools\/\*` shell commands/g,
      `pre-approves only \`${TRUSTED_COMMAND_PREFIX}\` shell commands`,
    )
    .replace(
      /pre-allows the deterministic core's exact command prefixes — `bun \.codex\/tools\/`, `bun \.codex\/hooks\/`, and/g,
      `pre-allows the deterministic core's \`${TRUSTED_COMMAND_PREFIX}\` command prefix and`,
    )
    .replace(
      /^\*\*CWD drift warning\*\*: If a stage runs `cd` in Bash.*$/gm,
      "**CWD drift warning**: Native release commands resolve `aidlc` from `PATH`, so changing directories does not change the engine path. Keep project-relative file arguments anchored to the project root, or run `cd` commands in subshells: `(cd subdir && npm install)`.",
    );
}

function projectNativeRootIntegrations(outRoot: string, m: HarnessManifest): void {
  const additions = m.nativeRootIntegrations ?? [];
  if (additions.length === 0) return;
  const descriptorPath = join(outRoot, m.harnessDir, PROJECTION_DATA);
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8")) as {
    rootIntegrations: Array<Record<string, unknown>>;
  };
  const paths = new Set(descriptor.rootIntegrations.map((item) => String(item.path)));
  for (const addition of additions) {
    const { src, content, ...integration } = addition;
    if (paths.has(integration.path)) {
      throw new Error(`[${m.name}] duplicate release root integration path: ${integration.path}`);
    }
    const destination = join(outRoot, integration.path);
    mkdirSync(dirname(destination), { recursive: true });
    if (content !== undefined) {
      writeFileSync(destination, content);
    } else {
      const source = join(HARNESS_ROOT, m.name, src);
      if (!existsSync(source) || !lstatSync(source).isFile()) {
        throw new Error(`[${m.name}] release root integration source is missing: ${src}`);
      }
      cpSync(source, destination);
    }
    descriptor.rootIntegrations.push(integration);
    paths.add(integration.path);
  }
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
}

function projectedNamespaceInvocationViolations(
  file: string,
  value: string,
): string[] {
  return scanNamespaceInvocations(file, value, ROUTES)
    .filter((invocation) => invocation.source === "aidlc" && !invocation.resolves)
    .map((invocation) =>
      `${file}:${invocation.line}: unresolvable projected namespace invocation "${invocation.command}"`
    );
}

function rewriteNativeInvocations(
  outRoot: string,
  m: HarnessManifest,
  copyRoot: string,
): void {
  projectNativeRootIntegrations(outRoot, m);
  const harnessDir = escapeRegExp(m.harnessDir);
  const delegateNames = [
    "audit",
    "bolt",
    "graph",
    "init",
    "jump",
    "learnings",
    "lifecycle",
    "log",
    "orchestrate",
    "runner-gen",
    "runtime",
    "sensor",
    "sensor-claim-sources",
    "sensor-linter",
    "sensor-required-sections",
    "sensor-type-check",
    "sensor-upstream-coverage",
    "state",
    "swarm",
    "utility",
    "validate",
    "worktree",
    "workspace-sync",
  ].join("|");
  const projectPrefix = String.raw`(?:"?(?:\$\{?CLAUDE_PROJECT_DIR\}?/)?`;
  const suffix = `"?)`;
  const toolPattern = new RegExp(
    String.raw`\bbun\s+${projectPrefix}${harnessDir}/tools/aidlc(?:-([a-z0-9-]+))?\.ts${suffix}`,
    "gi",
  );
  const hookPattern = new RegExp(
    String.raw`\bbun\s+${projectPrefix}${harnessDir}/hooks/aidlc-([a-z0-9-]+)\.ts${suffix}`,
    "gi",
  );
  const bareToolPattern = new RegExp(
    String.raw`\bbun\s+aidlc-(${delegateNames})\.ts`,
    "gi",
  );
  const bareToolCheck = new RegExp(bareToolPattern.source, "i");
  for (const file of walk(outRoot)) {
    if (!/\.(?:md|json|toml|hook|ts)$/.test(file)) continue;
    let value = readFileSync(file, "utf-8");
    const escapedJsonHook = new RegExp(
      String.raw`\bbun\s+\\"\$CLAUDE_PROJECT_DIR/${harnessDir}/hooks/aidlc-([a-z0-9-]+)\.ts\\"`,
      "gi",
    );
    value = value.replace(escapedJsonHook, (_match, hook: string) =>
      hook === "statusline" ? trustedCommand("statusline") : trustedCommand(`hook ${hook}`)
    );
    // Direct utility verbs whose dispatcher route lives under the `workspace`
    // noun: rewrite verb-aware BEFORE the generic tool rewrite would emit the
    // retired `engine utility` alias.
    const workspaceUtilityPattern = new RegExp(
      String.raw`\bbun\s+${projectPrefix}${harnessDir}/tools/aidlc-utility\.ts${suffix}\s+(codekb-path|codekb-scope-diff|codekb-snapshot|codekb-publish|project-description|document-input)\b`,
      "gi",
    );
    value = value.replace(
      workspaceUtilityPattern,
      (_match, verb: string) =>
        `${trustedCommand("workspace")} ${verb === "codekb-path" ? "codekb" : verb}`,
    );
    value = value.replace(toolPattern, (_match, delegate: string | undefined) =>
      delegate ? trustedCommand(delegate) : TRUSTED_COMMAND_PREFIX
    );
    value = value.replace(
      bareToolPattern,
      (_match, delegate: string) => trustedCommand(delegate),
    );
    value = value.replace(hookPattern, (_match, hook: string) => {
      if (hook === "kiro-adapter" || hook === "codex-adapter") {
        return trustedCommand(`adapter ${m.name}`);
      }
      if (hook === "statusline") return trustedCommand("statusline");
      return trustedCommand(`hook ${hook}`);
    });
    value = value.replaceAll(
      `"bun \\\\${m.harnessDir}/tools/.*"`,
      `"${trustedCommand(".*")}"`,
    );
    value = value.replaceAll(
      `"bun \\\\$\\\\{?KIRO_PROJECT_DIR\\\\}?/${m.harnessDir}/tools/.*"`,
      `"${trustedCommand(".*")}"`,
    );
    value = substituteInvocationTokens(value, m.harnessDir, "aidlc");
    value = rewriteNativeOnboarding(value);
    writeFileSync(file, value);
  }
  rewriteKiroNativeAllowlists(outRoot, m);
  rewriteClaudeNativePermissions(outRoot, m);
  rewriteCursorNativePermissions(outRoot, m);
  if (m.tierFlavor === "codex") {
    const { emitDefaultRules, emitTrustSeed } = require(
      join(HARNESS_ROOT, m.name, "emit.ts"),
    ) as {
      emitDefaultRules: (
        harnessDir: string,
        invoke: string,
        trustedNamespace: string,
      ) => string;
      emitTrustSeed: (
        harnessDir: string,
        harnessName: string,
        invoke: string,
        trustedNamespace: string,
      ) => string;
    };
    writeFileSync(
      join(outRoot, m.harnessDir, "rules", "default.rules"),
      emitDefaultRules(m.harnessDir, "aidlc", TRUSTED_ROUTE_NAMESPACE),
    );
    writeFileSync(
      join(outRoot, m.harnessDir, "trust-seed.toml"),
      emitTrustSeed(m.harnessDir, m.name, "aidlc", TRUSTED_ROUTE_NAMESPACE),
    );
  }
  const descriptorPath = join(outRoot, m.harnessDir, PROJECTION_DATA);
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf-8")) as {
    managedDirectories: string[];
    legacyManagedFileHashes?: Record<string, string[]>;
  };
  const legacyManagedFileHashes: Record<string, string[]> = {};
  for (const directory of descriptor.managedDirectories) {
    const releaseDirectory = join(outRoot, directory);
    if (!existsSync(releaseDirectory)) continue;
    for (const file of walk(releaseDirectory)) {
      const rel = relative(outRoot, file).split(sep).join("/");
      const copy = join(copyRoot, rel);
      if (!existsSync(copy) || !lstatSync(copy).isFile()) continue;
      const releaseHash = sha256Bytes(readFileSync(file));
      const copyHash = sha256Bytes(readFileSync(copy));
      if (releaseHash !== copyHash) legacyManagedFileHashes[rel] = [copyHash];
    }
  }
  const descriptorRel = `${m.harnessDir}/${PROJECTION_DATA}`.split(sep).join("/");
  const copyDescriptor = join(copyRoot, descriptorRel);
  if (existsSync(copyDescriptor)) {
    legacyManagedFileHashes[descriptorRel] = [
      sha256Bytes(readFileSync(copyDescriptor)),
    ];
  }
  if (Object.keys(legacyManagedFileHashes).length > 0) {
    descriptor.legacyManagedFileHashes = legacyManagedFileHashes;
  } else {
    delete descriptor.legacyManagedFileHashes;
  }
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  const leftovers: string[] = [];
  for (const file of walk(outRoot)) {
    if (!/\.(?:md|json|toml|hook|ts)$/.test(file)) continue;
    const value = readFileSync(file, "utf-8");
    for (const token of ["{{INVOKE}}", "{{TOOL_PREFIX}}"]) {
      if (value.includes(token)) {
        leftovers.push(`${relative(outRoot, file)}: unexpanded ${token}`);
      }
    }
    if (new RegExp(String.raw`\bbun\s+[^\n]*${harnessDir}/(?:tools|hooks)/aidlc`).test(value)) {
      leftovers.push(`${relative(outRoot, file)}: bun invocation survived native projection`);
    }
    if (bareToolCheck.test(value)) {
      leftovers.push(`${relative(outRoot, file)}: bare bun invocation survived native projection`);
    }
    if (/\baidlc\s+engine\s+(?:utility|runner-gen)\b/.test(value)) {
      leftovers.push(`${relative(outRoot, file)}: retired engine alias survived native projection`);
    }
    leftovers.push(
      ...projectedNamespaceInvocationViolations(relative(outRoot, file), value),
    );
    if (
      relative(outRoot, file).split(sep).join("/").includes("/agents/") &&
      /"allowedCommands"\s*:\s*\[[\s\S]*?"bun [^"]*tools\//.test(value)
    ) {
      leftovers.push(`${relative(outRoot, file)}: bun allowlist survived native projection`);
    }
  }
  if (leftovers.length > 0) {
    throw new Error(`[${m.name}] native invocation projection failed:\n${leftovers.join("\n")}`);
  }
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
  harnessName: string,
  args: string[],
  rulesDirAbs?: string | null,
): string {
  const toolPath = join(treeRoot, args[0]);
  const rest = args.slice(1);
  const env: Record<string, string> = {
    ...process.env,
    AIDLC_SRC: treeRoot,
    AIDLC_HARNESS_DIR: harnessDir,
    AIDLC_HARNESS_NAME: harnessName,
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
  return res.stdout ?? "";
}

function assembledOrchestratorSkill(
  outRoot: string,
  manifest: HarnessManifest,
): string {
  const rel = manifest.orchestratorSkillPath ??
    join(manifest.harnessDir, "skills", "aidlc", "SKILL.md");
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new Error(
      `packager: ${manifest.name} orchestratorSkillPath must stay within its dist root: ${rel}`,
    );
  }
  const skillPath = join(outRoot, rel);
  if (!existsSync(skillPath)) {
    throw new Error(
      `packager: ${manifest.name} orchestrator SKILL.md not found at ${skillPath}`,
    );
  }
  return skillPath;
}

function refreshGeneratedSkillRegions(
  outRoot: string,
  treeRoot: string,
  harnessDir: string,
  manifest: HarnessManifest,
): void {
  const skillPath = assembledOrchestratorSkill(outRoot, manifest);
  let body = readFileSync(skillPath, "utf-8").replace(/\r\n/g, "\n");

  for (const region of GENERATED_SKILL_REGIONS) {
    const rendered = runTool(
      treeRoot,
      harnessDir,
      manifest.name,
      ["tools/aidlc-utility.ts", region.verb],
    ).trimEnd();
    const beginIdx = body.indexOf(region.begin);
    const endIdx = body.indexOf(region.end);
    if (beginIdx === -1 && endIdx === -1) continue;
    if (
      beginIdx === -1 ||
      endIdx === -1 ||
      endIdx < beginIdx ||
      body.lastIndexOf(region.begin) !== beginIdx ||
      body.lastIndexOf(region.end) !== endIdx
    ) {
      throw new Error(
        `packager: malformed ${region.verb} markers in ${skillPath}`,
      );
    }
    body =
      body.slice(0, beginIdx) +
      rendered +
      body.slice(endIdx + region.end.length);
  }

  writeFileSync(skillPath, body, "utf-8");
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
  // dist/<name>/ is one generated root. Sweep that root, not selected
  // subdirectories, so removed/renamed project-root outputs cannot linger.
  // Siblings at dist/ (plugins and unrelated local assets) remain outside this
  // harness-owned boundary.
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  buildTree(m, distDir);
  console.log(`[${name}] regenerated dist/${name}/${m.harnessDir}`);
}

function writeReleaseHarness(name: string): void {
  const m = loadManifest(name);
  const releaseDir = join(REPO_ROOT, "dist-release", name);
  const copyRoot = join(REPO_ROOT, "dist", name);
  if (existsSync(releaseDir)) rmSync(releaseDir, { recursive: true, force: true });
  buildTree(m, releaseDir, "aidlc");
  rewriteNativeInvocations(releaseDir, m, copyRoot);
  console.log(`[${name}] regenerated dist-release/${name}/${m.harnessDir}`);
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
    trustEntries: (
      project: string,
      hooksJson: string | undefined,
      harnessDir: string,
      harnessName: string,
      invoke: string,
      trustedNamespace: string,
    ) => string;
  };
  console.log(
    trustEntries(
      resolvedProject,
      hooksJson ?? undefined,
      ".codex",
      "codex",
      "aidlc",
      TRUSTED_ROUTE_NAMESPACE,
    ),
  );
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

// Per-harness plugin projection descriptors are derived from manifests once,
// consumed directly by the checkout emitter, and emitted into every tools/data
// bundle for the standalone builder. Manifests remain the single source.
let pluginTargetCache: PluginTargetTable | null = null;
function pluginTargets(): PluginTargetTable {
  if (pluginTargetCache) return pluginTargetCache;
  pluginTargetCache = {};
  for (const harnessName of discoverHarnessNames()) {
    const manifest = loadManifest(harnessName);
    const installRoots = new Set<string>([
      manifest.harnessDir,
      "aidlc",
    ]);
    const addTopLevel = (path: string): void => {
      const top = path.split(/[\\/]/).filter(Boolean)[0];
      if (top) installRoots.add(top);
    };
    for (const file of manifest.harnessFiles) {
      if (file.projectRoot) addTopLevel(file.dst);
    }
    if (manifest.onboarding?.projectRoot) {
      addTopLevel(manifest.onboarding.dst);
    }
    if (manifest.orchestratorSkillPath) {
      addTopLevel(manifest.orchestratorSkillPath);
    }
    for (const root of manifest.plugin?.installRoots ?? []) {
      addTopLevel(root);
    }
    pluginTargetCache[harnessName] = {
      harnessName: manifest.name,
      manifestDir:
        manifest.plugin?.manifestDir ??
        `${manifest.harnessDir}-plugin`,
      harnessLeaf: manifest.harnessDir,
      kind: manifest.plugin?.kind ?? "store",
      installRoots: [...installRoots].sort(),
    };
  }
  return pluginTargetCache;
}

function pluginTargetFor(harnessName: string): PluginTarget | null {
  return pluginTargets()[harnessName] ?? null;
}

function buildRepositoryPluginProjection(
  pluginName: string,
  harnessName: string,
  outDir: string,
  outputBoundary = REPO_ROOT,
): void {
  const target = pluginTargetFor(harnessName);
  if (!target) {
    throw new Error(
      `no plugin target for harness "${harnessName}" (missing manifest)`,
    );
  }
  emitPluginProjection({
    pluginRoot: join(PLUGINS_ROOT, pluginName),
    target,
    outDir,
    outputBoundary,
    templateHooksDir: PLUGIN_HOOKS_TEMPLATE_SRC,
    reviewerAgents: reviewerAgentSet(CORE_ROOT),
  });
}

// Which harnesses get a projection = every built harness with a manifest (each
// derives a plugin target). Derived, so a new harness is covered automatically.
function pluginHarnessesFor(harnesses: string[]): string[] {
  return harnesses.filter((h) => pluginTargetFor(h) !== null);
}

function emitPlugins(
  harnesses: string[],
  distRoot = join(REPO_ROOT, "dist"),
  log = true,
): void {
  for (const pluginName of discoverPluginNames()) {
    for (const harnessName of pluginHarnessesFor(harnesses)) {
      buildRepositoryPluginProjection(
        pluginName,
        harnessName,
        join(distRoot, "plugins", pluginName, harnessName),
        distRoot,
      );
      if (log) {
        console.log(`[plugin:${pluginName}] emitted dist/plugins/${pluginName}/${harnessName}/`);
      }
    }
  }
}

function removeUnexpectedGeneratedEntries(
  root: string,
  expected: ReadonlySet<string>,
): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (!expected.has(name)) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  }
}

function cleanWriteOutputs(harnesses: string[], fullBuild: boolean): void {
  const distRoot = join(REPO_ROOT, "dist");
  const releaseRoot = join(REPO_ROOT, "dist-release");
  if (fullBuild) {
    removeUnexpectedGeneratedEntries(
      distRoot,
      new Set([...harnesses, "plugins"]),
    );
    removeUnexpectedGeneratedEntries(releaseRoot, new Set(harnesses));
    rmSync(join(distRoot, "plugins"), { recursive: true, force: true });
    return;
  }

  for (const pluginName of discoverPluginNames()) {
    for (const harnessName of pluginHarnessesFor(harnesses)) {
      rmSync(
        join(distRoot, "plugins", pluginName, harnessName),
        { recursive: true, force: true },
      );
    }
  }
}

function buildCheckPass(root: string, harnesses: string[]): void {
  const distRoot = join(root, "dist");
  const releaseRoot = join(root, "dist-release");
  for (const name of harnesses) {
    const manifest = loadManifest(name);
    const copyRoot = join(distRoot, name);
    const nativeRoot = join(releaseRoot, name);
    buildTree(manifest, copyRoot);
    buildTree(manifest, nativeRoot, "aidlc");
    rewriteNativeInvocations(nativeRoot, manifest, copyRoot);
  }
  emitPlugins(harnesses, distRoot, false);
}

function checkPackageDeterminism(harnesses: string[]): string[] {
  const first = mkdtempSync(join(tmpdir(), "aidlc-package-check-a-"));
  const second = mkdtempSync(join(tmpdir(), "aidlc-package-check-b-"));
  try {
    buildCheckPass(first, harnesses);
    buildCheckPass(second, harnesses);
    return [
      ...diffTrees(join(first, "dist"), join(second, "dist"), "dist"),
      ...diffTrees(
        join(first, "dist-release"),
        join(second, "dist-release"),
        "dist-release",
      ),
    ];
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
}

// `package.ts plugin build <plugin> <harness> <outDir>` — render ONE plugin
// projection into an arbitrary dir. The target-dir seam that lets t188 (and any
// caller) exercise the real emitter WITHOUT touching the local dist/plugins/
// trees — writeHarness/emitPlugins rmSync + rewrite dist, which a parallel test
// tier must never do (it races sibling tests). Pure builder call.
if (argv[0] === "plugin" && argv[1] === "build") {
  const [pluginName, harnessName, outDir, ...extra] = argv.slice(2);
  if (
    !pluginName ||
    !harnessName ||
    !outDir ||
    extra.length > 0 ||
    [pluginName, harnessName, outDir].some((arg) => arg.startsWith("-"))
  ) {
    console.error("usage: package.ts plugin build <plugin> <harness> <outDir>");
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
  const outArg = outDir.replace(/[/\\]+$/, "") || outDir;
  const resolvedOut = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
  try {
    buildRepositoryPluginProjection(
      pluginName,
      harnessName,
      resolvedOut,
      resolvedOut,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
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
  const problems = checkPackageDeterminism(targets);
  if (problems.length > 0) {
    console.error(`\npackage --check FAILED (${problems.length} problem(s)):`);
    for (const p of problems.slice(0, 40)) console.error("  " + p);
    process.exit(1);
  }
  console.log(
    `package --check: deterministic across two independent build(s) ` +
      `for ${targets.join(", ")}.`,
  );
} else {
  cleanWriteOutputs(targets, named === undefined);
  for (const n of targets) {
    writeHarness(n);
    writeReleaseHarness(n);
  }
  // Emit plugin projections (the hybrid: per-harness host plugins from plugins/<name>/)
  emitPlugins(targets);
}
