// aidlc-includes.ts — the harness-native rule-include re-pointer.
//
// The AIDLC method (the layered practice files org/team/project + phase rules)
// lives ONCE at the workspace root under aidlc/spaces/<space>/memory/. Each
// harness reads it via its OWN native include, evaluated by the CLI *before*
// AIDLC's engine runs:
//   • Claude — an @-import stub at <harness>/rules/aidlc.md naming each method file.
//   • Kiro CLI — a `resources` glob in each agents/*.json.
//   • Kiro IDE: an always-included steering file holding the memory text
//     (Kiro IDE does not expand file references in steering; see
//     kiroIdeSteering below).
//   • Codex — the AIDLC_RULES_DIR env var in config.toml.
//   • opencode — the `instructions` glob in the project-root opencode.json.
//   • Cursor — standing + phase read pointers in <harness>/rules/*.mdc.
//
// These surfaces stay COMMITTED (each carries load-bearing engine wiring beyond
// the include — Kiro's agent JSON holds the conductor prompt + hook block,
// Codex's config.toml holds model/provider/sandbox config — so they cannot be
// gitignored+generated without a fresh-clone chicken-and-egg). They ship pointed
// at the `default` space. `repointHarnessIncludes(projectDir, space)` does a
// SURGICAL in-place rewrite of ONLY the `aidlc/spaces/<X>/memory` pointer
// segment, leaving every other byte untouched. The one exception is Kiro IDE's
// steering file, which carries no wiring: it is gitignored and written whole
// from the memory files.
//
// It runs at two moments: bootstrap (first `/aidlc` / --doctor / SessionStart —
// idempotent no-op when the pointer already matches the active space) and on a
// `/aidlc space <name>` switch (rewrites the pointer to the new space). At the
// `default` space the rewrite is a byte-identical no-op, so a single-team user's
// committed tree never dirties — only a multi-space switch produces a local
// (uncommitted, per-user) modification, driven by the gitignored `active-space`
// cursor.
//
// Why rewrite-in-place and not a symlink: a spike proved Kiro's resources glob
// will not walk a symlinked root (plain `find` doesn't follow symlinks) and
// Windows cannot portably create links — both DEAD. Plain file writes are the
// only Windows-safe, Kiro-walkable mechanism. The CLI re-reads the rewritten
// file on the next turn (spike-verified live on Claude + Kiro).
//
// This is the ONLY runtime writer of these surfaces. Best-effort per surface:
// a surface whose source can't be read/parsed is skipped, never corrupted — and
// since the includes are committed, a failed rewrite leaves the prior (valid)
// pointer in place, recoverable by re-running.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  assertProjectionPathHasNoSymlinks,
  jsonEntriesIsSafe,
  managedBlockIsSafe,
  mergeBlock,
  mergeJsonEntries,
  type ProjectionDescriptor,
  readRootIntegrations,
  type RootIntegration,
  rootBlockPath,
  unionBlocks,
} from "./aidlc-distribution.ts";
import { activeSpace, harnessDir, sessionsDir, writeFileAtomic } from "./aidlc-lib.ts";
import { discoverProjectHarnesses, runtimeHarnessName } from "./aidlc-runtime-paths.ts";

/** Workspace-relative POSIX memory path for a space: `aidlc/spaces/<space>/memory`.
 *  POSIX separators — these strings live in include files read identically on
 *  every OS. */
function spaceMemoryRel(space: string): string {
  return `aidlc/spaces/${space}/memory`;
}

// A prior-space memory path inside a Claude @-line: `@<dots>/aidlc/spaces/<X>/memory/<file>`.
// Captures the leading `@` + any relative `../` prefix (group 1) and the file
// sub-path under memory/ (group 2) so only the `spaces/<X>` segment is swapped.
const CLAUDE_AT_LINE = /^(@(?:\.\.\/)*)aidlc\/spaces\/[^/]+\/memory\/(.+)$/;

/** Rewrite every method @-import line in a Claude stub to the given space,
 *  preserving the relative prefix, the named file, the comment header, and all
 *  non-@ lines verbatim. Returns null when nothing changed (already on `space`).*/
function repointClaudeStub(raw: string, space: string): string | null {
  const rel = spaceMemoryRel(space);
  let changed = false;
  const out = raw
    .split("\n")
    .map((line) => {
      const m = line.match(CLAUDE_AT_LINE);
      if (!m) return line;
      const next = `${m[1]}${rel}/${m[2]}`;
      if (next !== line) changed = true;
      return next;
    })
    .join("\n");
  return changed ? out : null;
}

/** Rewrite the memory glob in a Kiro agent JSON's `resources` array to the given
 *  space, preserving every other entry (skill://…, file://AGENTS.md) and every
 *  other field. Parse→edit→re-serialize (NOT string replace) so the round-trip
 *  is structural. Returns null when there is no memory glob or it already matches.
 */
function repointKiroAgentResources(raw: string, space: string): string | null {
  const json = JSON.parse(raw) as { resources?: unknown };
  if (!Array.isArray(json.resources)) return null;
  const target = `file://${spaceMemoryRel(space)}/**/*.md`;
  let changed = false;
  const rewritten = json.resources.map((r) => {
    if (typeof r === "string" && /^file:\/\/aidlc\/spaces\/[^/]+\/memory\/\*\*\/\*\.md$/.test(r)) {
      if (r !== target) changed = true;
      return target;
    }
    return r;
  });
  if (!changed) return null;
  json.resources = rewritten;
  // Two-space indent + trailing newline matches the authored agent JSON shape.
  return `${JSON.stringify(json, null, 2)}\n`;
}

// --- Kiro IDE: the memory text in the always-included steering file ----------
//
// Kiro IDE does not expand `#[[file:...]]` references in steering (measured on
// 1.2.4, #2023): a reference file gives the chat seven literal lines and none of
// the rules. Inline text does reach it, captured once when the chat starts and
// kept through summaries and reloads. So the steering file holds the active
// space's memory TEXT, written here from the memory files (the only source; a
// person edits those, never this file). It is gitignored and written again at
// each session start, on a space switch, and by `next` once the files changed.
// A memory too large to put in every chat keeps the reference form, and the
// engine then sends the rules with each step, as it does on every tool.

export const KIRO_IDE_STEERING = ".kiro/steering/aidlc-active-memory.md";

// The rule layers, in the order the memory resolver applies them; any other
// Markdown file beside them or under phases/ follows, sorted.
const MEMORY_LAYERS = [
  "org.md",
  "team.md",
  "project.md",
  "phases/ideation.md",
  "phases/inception.md",
  "phases/construction.md",
  "phases/operation.md",
];

// Inline text past this size would sit in every chat and every helper's
// context; the reference form is written instead.
const KIRO_IDE_INLINE_MAX_BYTES = 64 * 1024;

const KIRO_IDE_STEERING_HEAD = [
  "---",
  "inclusion: always",
  "---",
  "",
  "# AI-DLC Active Memory",
  "",
];

function memoryLayerFiles(memoryDir: string): string[] {
  const extra = (sub: string): string[] => {
    try {
      return readdirSync(join(memoryDir, sub), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => (sub ? `${sub}/${entry.name}` : entry.name))
        .filter((rel) => !MEMORY_LAYERS.includes(rel))
        .sort();
    } catch {
      return [];
    }
  };
  return [...MEMORY_LAYERS, ...extra(""), ...extra("phases")]
    .filter((rel) => {
      try {
        return lstatSync(join(memoryDir, rel)).isFile();
      } catch {
        return false;
      }
    });
}

function kiroIdeReferenceSteering(space: string): string {
  return [
    ...KIRO_IDE_STEERING_HEAD,
    "The following live workspace files are the active AI-DLC method and policy",
    "layers. They apply to the conductor and delegated agents.",
    "",
    ...MEMORY_LAYERS.map((rel) => `#[[file:${spaceMemoryRel(space)}/${rel}]]`),
    "",
  ].join("\n");
}

/** The steering file Kiro IDE should hold for `space`, and the memory files
 *  (project-relative) whose exact text it carries. `inlined` is empty when the
 *  text cannot be inlined (a file that is not UTF-8, or a memory too large). */
export function kiroIdeSteering(projectDir: string, space: string): { text: string; inlined: string[] } {
  const rel = spaceMemoryRel(space);
  const memoryDir = join(projectDir, ...rel.split("/"));
  const parts: string[] = [];
  const inlined: string[] = [];
  let bytes = 0;
  for (const file of memoryLayerFiles(memoryDir)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(memoryDir, file)));
    } catch {
      return { text: kiroIdeReferenceSteering(space), inlined: [] };
    }
    bytes += Buffer.byteLength(text, "utf-8");
    if (bytes > KIRO_IDE_INLINE_MAX_BYTES) return { text: kiroIdeReferenceSteering(space), inlined: [] };
    parts.push(`<memory-file path="${rel}/${file}">\n${text}${text.endsWith("\n") ? "" : "\n"}</memory-file>\n`);
    inlined.push(`${rel}/${file}`);
  }
  if (inlined.length === 0) return { text: kiroIdeReferenceSteering(space), inlined: [] };
  return {
    text: [
      ...KIRO_IDE_STEERING_HEAD,
      `<!-- AI-DLC writes this file from ${rel}/ for every chat. Do not edit it: edit those files instead. -->`,
      "",
      "The text of each file below is the active AI-DLC method and policy layers. They apply to the",
      "conductor and delegated agents.",
      "",
      parts.join("\n"),
    ].join("\n"),
    inlined,
  };
}

// The tree Kiro IDE (and Kiro CLI v3) runs; the Kiro CLI 2.0 tree shares `.kiro`.
function kiroIdeTree(projectDir: string): boolean {
  try {
    return runtimeHarnessName(projectDir, ".kiro") === "kiro-ide";
  } catch {
    return false;
  }
}

/** Write Kiro IDE's steering file for `space` when it differs from the memory
 *  files now. Returns whether it wrote. A no-op outside the Kiro IDE tree. */
export function refreshKiroIdeSteering(projectDir: string, space: string): boolean {
  if (!kiroIdeTree(projectDir)) return false;
  const path = join(projectDir, ...KIRO_IDE_STEERING.split("/"));
  const { text } = kiroIdeSteering(projectDir, space);
  if (readSafe(path) === text) return false;
  try {
    assertProjectionPathHasNoSymlinks(projectDir, KIRO_IDE_STEERING);
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, text);
    return true;
  } catch {
    // The chat gets the rules with each step instead.
    return false;
  }
}

// The steering file was committed before it carried the memory text. Git keeps
// tracking it after the .gitignore line lands, so every memory edit shows it
// as changed. Asked once per clone.
const TRACKED_STEERING_ASKED = "kiro-ide-steering-tracked-asked";

/** The one line the session start gives the agent when this clone's git still
 *  tracks Kiro IDE's steering file, or "" (also once it was asked, outside the
 *  Kiro IDE tree, or with no git). */
export function trackedKiroIdeSteeringAsk(projectDir: string): string {
  if (!kiroIdeTree(projectDir)) return "";
  const marker = join(sessionsDir(projectDir), TRACKED_STEERING_ASKED);
  if (existsSync(marker)) return "";
  const listed = spawnSync("git", ["ls-files", "--error-unmatch", "--", KIRO_IDE_STEERING], {
    cwd: projectDir,
    stdio: "ignore",
    timeout: 5000,
    windowsHide: true,
  });
  // 0 tracked, 1 not tracked; anything else (no repository yet) asks later.
  if (listed.error || (listed.status !== 0 && listed.status !== 1)) return "";
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileAtomic(marker, `${new Date().toISOString()}\n`);
  } catch {
    // Not asked rather than asked in every chat.
    return "";
  }
  if (listed.status !== 0) return "";
  return "ASK ONCE: after you answer the person's message, ask them this in their language: " +
    `"Your repo tracks ${KIRO_IDE_STEERING}, which AI-DLC now rebuilds for each chat. ` +
    'Do you want me to stop tracking it? Your memory files stay as they are." ' +
    `On yes, run \`git rm --cached -- ${KIRO_IDE_STEERING}\` (the file stays on disk) and say it is done. ` +
    "On no, leave it. Do not ask again.";
}

/** Rewrite live memory references in Kiro IDE's always-included steering file. */
function repointKiroSteeringReferences(raw: string, space: string): string | null {
  const target = spaceMemoryRel(space);
  const next = raw.replace(
    /(#\[\[file:)aidlc\/spaces\/[^/]+\/memory\//g,
    `$1${target}/`,
  );
  return next === raw ? null : next;
}

/** Rewrite the AIDLC_RULES_DIR value in a Codex config.toml to the given space's
 *  memory dir, preserving the rest of the file verbatim. Returns null when the
 *  line is absent or already correct. */
function repointCodexConfig(raw: string, space: string): string | null {
  const target = spaceMemoryRel(space);
  const re = /(AIDLC_RULES_DIR\s*=\s*")aidlc\/spaces\/[^"]*\/memory(")/;
  if (!re.test(raw)) return null;
  const next = raw.replace(re, `$1${target}$2`);
  return next === raw ? null : next;
}

/** Rewrite the method glob in an opencode.json/jsonc `instructions` array to
 *  the given space, preserving comments, trailing commas, and every byte
 *  outside the one matching string. Returns null when there is no method glob
 *  or it already matches. */
function repointOpencodeInstructions(raw: string, space: string): string | null {
  const target = `${spaceMemoryRel(space)}/**/*.md`;
  const next = raw.replace(
    /(")aidlc\/spaces\/[^/"]+\/memory\/\*\*\/\*\.md(")/g,
    `$1${target}$2`,
  );
  return next === raw ? null : next;
}

/** Rewrite active-space memory paths in an opencode persona body. */
function repointOpencodeAgentMemory(raw: string, space: string): string | null {
  // <space>-style documentation placeholders are never space names.
  const next = raw.replace(
    /aidlc\/spaces\/(?!<)[^/]+\/memory\//g,
    `${spaceMemoryRel(space)}/`,
  );
  return next === raw ? null : next;
}

/** Surgically repoint a single committed include file to `space` using `rewrite`,
 *  writing atomically only when the content changes. Records the workspace-
 *  relative path in `written`. Absent / unreadable / malformed → skipped (the
 *  committed prior pointer stays valid). */
function repointFile(
  absPath: string,
  relPath: string,
  raw: string,
  space: string,
  rewrite: (raw: string, space: string) => string | null,
  written: string[],
): void {
  let next: string | null;
  try {
    next = rewrite(raw, space);
  } catch {
    return; // malformed source → leave it untouched, never corrupt
  }
  if (next !== null) {
    writeFileAtomic(absPath, next);
    written.push(relPath);
  }
}

/** Surgically repoint the active harness's native rule include(s) at the given
 *  space's method tree (`aidlc/spaces/<space>/memory/`). Idempotent — a no-op
 *  when the surfaces already point at `space` (so a `default`-cursor single-team
 *  user never dirties the committed tree). Touches ONLY the surfaces of the
 *  harness resolved from `harnessDir()`.
 *
 *  Returns the workspace-relative paths it actually rewrote (for --doctor /
 *  audit / tests). Pass an explicit `space` to bypass the cursor; omitted → the
 *  active-space cursor (`activeSpace(projectDir)`, cursorless → `default`). */
export function repointHarnessIncludes(projectDir: string, space?: string): string[] {
  const sp = space ?? activeSpace(projectDir);
  const harness = harnessDir(); // ".claude" | ".kiro" | ".codex" | open-set
  const harnessRoot = join(projectDir, harness);
  const written: string[] = [];

  if (harness === ".claude") {
    const stubPath = join(harnessRoot, "rules", "aidlc.md");
    if (existsSync(stubPath)) {
      const raw = readSafe(stubPath);
      if (raw !== null) {
        repointFile(stubPath, join(harness, "rules", "aidlc.md"), raw, sp, repointClaudeStub, written);
      }
    }
    return written;
  }

  if (harness === ".cursor") {
    // Cursor — every .cursor/rules/*.mdc method pointer lists plain paths
    // (Cursor rules have no @-import expansion); rewrite the space segment in
    // each one. The persona files in .cursor/agents/ carry active-space memory
    // paths in their bodies exactly like opencode's.
    const rulesDir = join(harnessRoot, "rules");
    if (existsSync(rulesDir)) {
      for (const name of readdirSync(rulesDir).sort()) {
        if (!name.endsWith(".mdc")) continue;
        const p = join(rulesDir, name);
        const raw = readSafe(p);
        if (raw === null) continue;
        repointFile(
          p,
          join(harness, "rules", name),
          raw,
          sp,
          repointOpencodeAgentMemory,
          written,
        );
      }
    }
    const agentsDir = join(harnessRoot, "agents");
    if (existsSync(agentsDir)) {
      for (const name of readdirSync(agentsDir).sort()) {
        if (!name.endsWith(".md")) continue;
        const p = join(agentsDir, name);
        const raw = readSafe(p);
        if (raw === null) continue;
        repointFile(
          p,
          join(harness, "agents", name),
          raw,
          sp,
          repointOpencodeAgentMemory,
          written,
        );
      }
    }
    return written;
  }

  if (harness === ".kiro") {
    // Kiro CLI compatibility surface: rewrite each agents/*.json memory glob.
    const agentsDir = join(harnessRoot, "agents");
    if (existsSync(agentsDir)) {
      for (const name of readdirSync(agentsDir).sort()) {
        if (!name.endsWith(".json")) continue;
        const p = join(agentsDir, name);
        const raw = readSafe(p);
        if (raw === null) continue;
        repointFile(p, join(harness, "agents", name), raw, sp, repointKiroAgentResources, written);
      }
    }
    // Kiro IDE binding surface: workspace steering is inherited by delegated
    // agents, and it carries the active memory text itself (see
    // kiroIdeSteering above).
    if (refreshKiroIdeSteering(projectDir, sp)) {
      written.push(join(harness, "steering", "aidlc-active-memory.md"));
      return written;
    }
    const steeringPath = join(
      harnessRoot,
      "steering",
      "aidlc-active-memory.md",
    );
    if (!kiroIdeTree(projectDir) && existsSync(steeringPath)) {
      const raw = readSafe(steeringPath);
      if (raw !== null) {
        repointFile(
          steeringPath,
          join(harness, "steering", "aidlc-active-memory.md"),
          raw,
          sp,
          repointKiroSteeringReferences,
          written,
        );
      }
    }
    return written;
  }

  if (harness === ".codex") {
    const configPath = join(harnessRoot, "config.toml");
    if (existsSync(configPath)) {
      const raw = readSafe(configPath);
      if (raw !== null) {
        repointFile(configPath, join(harness, "config.toml"), raw, sp, repointCodexConfig, written);
      }
    }
    return written;
  }

  if (harness === ".aidlc") {
    // Two harnesses ship the .aidlc runtime dir; both include surfaces are
    // probed (each rewriter no-ops when its surface carries no method
    // pointer, so the branches compose without a flavor probe).
    // Copilot: the project-root AGENTS.md's @-import lines are the method
    // include (both Copilot surfaces expand @-imports; live-verified).
    const agentsMdPath = join(projectDir, "AGENTS.md");
    if (existsSync(agentsMdPath)) {
      const raw = readSafe(agentsMdPath);
      if (raw !== null) {
        repointFile(agentsMdPath, "AGENTS.md", raw, sp, repointClaudeStub, written);
      }
    }
    // opencode: the project-root opencode.json/jsonc `instructions` glob.
    const jsonPath = join(projectDir, "opencode.json");
    const jsoncPath = join(projectDir, "opencode.jsonc");
    for (const [configPath, relPath] of [
      [jsonPath, "opencode.json"],
      [jsoncPath, "opencode.jsonc"],
    ] as const) {
      if (!existsSync(configPath)) continue;
      const raw = readSafe(configPath);
      if (raw !== null) {
        repointFile(
          configPath,
          relPath,
          raw,
          sp,
          repointOpencodeInstructions,
          written,
        );
      }
    }
    // Inline and native persona bodies carry explicit method paths for
    // on-demand reads. Keep every surface aligned with the active-space
    // cursor: the inline twins (.aidlc/agents), opencode's native subagents
    // (.opencode/agents), and Copilot's native custom agents
    // (.github/agents — the copies dispatched delegations actually load).
    for (const relDir of [
      join(".aidlc", "agents"),
      join(".opencode", "agents"),
      join(".github", "agents"),
    ]) {
      const agentsDir = join(projectDir, relDir);
      if (!existsSync(agentsDir)) continue;
      // .github/ is SHARED with user content on the Copilot harness, so touch
      // only aidlc-named core personas or plugin-owned personas there. The
      // AIDLC-owned engine/native dirs may contain plugin agents whose names
      // intentionally lack the aidlc prefix.
      const sharedGithubDir = relDir === join(".github", "agents");
      for (const name of readdirSync(agentsDir).sort()) {
        if (!name.endsWith(".md")) continue;
        const p = join(agentsDir, name);
        const raw = readSafe(p);
        if (raw === null) continue;
        if (
          sharedGithubDir &&
          !name.startsWith("aidlc-") &&
          !/^plugin:\s*[a-z][a-z0-9-]*\s*$/m.test(raw)
        ) {
          continue;
        }
        repointFile(
          p,
          join(relDir, name),
          raw,
          sp,
          repointOpencodeAgentMemory,
          written,
        );
      }
    }
    return written;
  }

  // Unknown / future harness with no native include known here — nothing to do.
  return written;
}

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// --- AI-DLC's part of the team's root files ---------------------------------
//
// A copy runtime leaves the team's .gitignore and AGENTS.md out (a copy would
// replace them) and ships AI-DLC's part of each in root-blocks. Where config
// never ran (no harness in the project has its install record), this adds that
// part with config's own rule, at the same two moments as the includes: after
// the team's content, or as the whole file when there is none. A part that is
// exactly what a release shipped is brought up to date; a part the team
// changed, and every file config or the Cursor installer manages, is left as
// it is. Best-effort: a file that cannot be read or merged is skipped, never
// corrupted, and nothing outside the project is read or written.
export function addRootBlocks(projectDir: string): string[] {
  const written: string[] = [];
  const parts = new Map<string, {
    integration: RootIntegration;
    contributors: Array<{ distribution: string; text: string }>;
    legacy: Set<string>;
    configured: boolean;
  }>();
  // AI-DLC's part of a team's JSON file (opencode.json), from root-blocks.
  const entryParts = new Map<string, { distribution: string; text: string; configured: boolean }>();
  let harnesses: ReturnType<typeof discoverProjectHarnesses>;
  try {
    harnesses = discoverProjectHarnesses(projectDir);
  } catch {
    return written;
  }
  for (const harness of harnesses) {
    const data = join(harness.root, "tools", "data");
    let descriptor: ProjectionDescriptor;
    try {
      descriptor = JSON.parse(readFileSync(join(data, "aidlc-projection.json"), "utf-8")) as ProjectionDescriptor;
      if (descriptor.harnessDir !== harness.harnessDir || descriptor.distribution !== harness.distribution) continue;
    } catch {
      continue;
    }
    const configured = existsSync(join(data, "aidlc-manifest.json"));
    const integrations = readRootIntegrations(descriptor.rootIntegrations);
    for (const integration of (Array.isArray(integrations) ? integrations : []) as RootIntegration[]) {
      if (integration?.policy === "json-entries" && jsonEntriesIsSafe(integration)) {
        const partPath = rootBlockPath(harness.root, integration);
        try {
          assertProjectionPathHasNoSymlinks(projectDir, relative(projectDir, partPath).split(sep).join("/"));
        } catch {
          continue;
        }
        const text = readSafe(partPath);
        const known = entryParts.get(integration.path);
        if (text !== null && (!known || harness.distribution.localeCompare(known.distribution) < 0)) {
          entryParts.set(integration.path, { distribution: harness.distribution, text, configured: configured || Boolean(known?.configured) });
        } else if (known) {
          known.configured ||= configured;
        }
        continue;
      }
      // Config's own check on a managed block: a path inside the project and a
      // plain marker, and no symlink on the way to the copy in root-blocks.
      if (integration?.policy !== "managed-block" || !managedBlockIsSafe(integration)) continue;
      const blockPath = rootBlockPath(harness.root, integration);
      try {
        assertProjectionPathHasNoSymlinks(projectDir, relative(projectDir, blockPath).split(sep).join("/"));
      } catch {
        continue;
      }
      const text = readSafe(blockPath);
      if (text === null) continue;
      const part = parts.get(integration.path) ?? {
        integration,
        contributors: [],
        legacy: new Set<string>(),
        configured: false,
      };
      part.contributors.push({ distribution: harness.distribution, text });
      for (const hash of integration.legacySignatures?.wholeFileHashes ?? []) part.legacy.add(hash);
      part.configured ||= configured;
      parts.set(integration.path, part);
    }
  }
  for (const [path, part] of parts) {
    if (part.configured) continue;
    const shipped = part.integration.shared === "union"
      ? unionBlocks(part.contributors)
      : [...part.contributors].sort((left, right) => left.distribution.localeCompare(right.distribution))[0].text;
    const target = join(projectDir, path);
    let current = "";
    try {
      assertProjectionPathHasNoSymlinks(projectDir, path);
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) continue;
      if (stat) {
        const bytes = readFileSync(target);
        current = bytes.toString("utf-8");
        if (!Buffer.from(current, "utf-8").equals(bytes)) continue;
      }
    } catch {
      continue;
    }
    // A file the Cursor installer manages already holds AI-DLC's part, under
    // that installer's own markers; it stays the installer's to update.
    if (/^(?:# |<!-- )BEGIN AIDLC [A-Z]+/m.test(current)) continue;
    const merged = mergeBlock(path, current, shipped, part.integration.marker || basename(path), [...part.legacy]);
    if (merged.error || merged.value === undefined || merged.value === current) continue;
    if (merged.currentHash && !merged.currentBlockShipped) continue;
    try {
      assertProjectionPathHasNoSymlinks(projectDir, path);
      writeFileAtomic(target, merged.value);
      written.push(path);
    } catch {
      // Leave the file as it was; the next session or config tries again.
    }
  }
  for (const [path, part] of entryParts) {
    if (part.configured) continue;
    const target = join(projectDir, path);
    let current = "";
    try {
      assertProjectionPathHasNoSymlinks(projectDir, path);
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.size > MAX_ENTRY_FILE_BYTES)) continue;
      if (stat) {
        const bytes = readFileSync(target);
        current = bytes.toString("utf-8");
        if (!Buffer.from(current, "utf-8").equals(bytes)) continue;
      }
    } catch {
      continue;
    }
    // With no record, only entries that name AI-DLC's own folders are read
    // as AI-DLC's; the team's keys and values stay theirs.
    const merged = mergeJsonEntries(current, part.text, { kind: "none" });
    if ("conflict" in merged || merged.text === current) continue;
    try {
      assertProjectionPathHasNoSymlinks(projectDir, path);
      writeFileAtomic(target, merged.text);
      written.push(path);
    } catch {
      // Leave the file as it was; the next session or config tries again.
    }
  }
  return written;
}

// A team settings file this large is not one AI-DLC adds its part to at session start.
const MAX_ENTRY_FILE_BYTES = 1024 * 1024;
