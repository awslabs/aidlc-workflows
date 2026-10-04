// aidlc-includes.ts — the harness-native rule-include re-pointer.
//
// The AIDLC method (the layered practice files org/team/project + phase rules)
// lives ONCE at the workspace root under aidlc/spaces/<space>/memory/. Each
// harness reads it via its OWN native include, evaluated by the CLI *before*
// AIDLC's engine runs:
//   • Claude — an @-import stub at <harness>/rules/aidlc.md naming each method file.
//   • Kiro CLI — a `resources` glob in each agents/*.json.
//   • Kiro IDE — an always-included steering file with live file references.
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
// segment, leaving every other byte untouched. Identical treatment for all
// harnesses. No file is created, regenerated whole, or special-cased.
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
// This is the ONLY runtime writer into the harness dir. Best-effort per surface:
// a surface whose source can't be read/parsed is skipped, never corrupted — and
// since the includes are committed, a failed rewrite leaves the prior (valid)
// pointer in place, recoverable by re-running.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import {
  assertProjectionPathHasNoSymlinks,
  managedBlockIsSafe,
  mergeBlock,
  type ProjectionDescriptor,
  type RootIntegration,
  rootBlockPath,
  unionBlocks,
} from "./aidlc-distribution.ts";
import { activeSpace, harnessDir, writeFileAtomic } from "./aidlc-lib.ts";
import { discoverProjectHarnesses } from "./aidlc-runtime-paths.ts";

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
    // agents; live file references carry the exact active memory files.
    const steeringPath = join(
      harnessRoot,
      "steering",
      "aidlc-active-memory.md",
    );
    if (existsSync(steeringPath)) {
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
    for (const integration of Array.isArray(descriptor.rootIntegrations) ? descriptor.rootIntegrations : []) {
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
  return written;
}
