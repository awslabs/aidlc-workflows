// aidlc-includes.ts — the harness-native rule-include re-pointer.
//
// The AIDLC method (the layered practice files org/team/project + phase rules)
// lives ONCE at the workspace root under aidlc/spaces/<space>/memory/. Each
// harness reads it via its OWN native include, evaluated by the CLI *before*
// AIDLC's engine runs:
//   • Claude — an @-import stub at <harness>/rules/aidlc.md naming each method file.
//   • Kiro / Kiro-IDE — a `resources` glob in each agents/*.json.
//   • Codex — the AIDLC_RULES_DIR env var in config.toml.
//   • opencode — the `instructions` glob in the project-root opencode.json.
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeSpace, harnessDir, writeFileAtomic } from "./aidlc-lib.ts";

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
  const next = raw.replace(
    /aidlc\/spaces\/[^/]+\/memory\//g,
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

  if (harness === ".kiro") {
    // Kiro / Kiro-IDE — rewrite each agents/*.json that carries a memory glob.
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
    // opencode (engine dir .aidlc): opencode reads the project-root
    // opencode.json/jsonc, whose `instructions` glob is the method include.
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
    // on-demand reads. Keep both aligned with the active-space cursor.
    for (const relDir of [join(".aidlc", "agents"), join(".opencode", "agents")]) {
      const agentsDir = join(projectDir, relDir);
      if (!existsSync(agentsDir)) continue;
      for (const name of readdirSync(agentsDir).sort()) {
        if (!name.endsWith(".md")) continue;
        const p = join(agentsDir, name);
        const raw = readSafe(p);
        if (raw === null) continue;
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
