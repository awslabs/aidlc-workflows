// covers: function:frameworkMemorySeedDir
//
// t-memory-seed — the ENGINE-ONLY-INSTALL self-heal (deterministic, no-LLM,
// no-network). Pins the additive fallback that recovers a user who copies ONLY
// the harness engine dir (e.g. dist/kiro/.kiro/) but NOT the sibling aidlc/
// workspace shell. Normally the shell (aidlc/spaces/default/memory/) ships as a
// SIBLING of the engine dir, so a complete dist/ copy already carries the method
// tree. When it is absent, the first /aidlc — which routes through the engine's
// intent-birth → ensureWorkspaceDirs — seeds aidlc/spaces/default/memory/ from a
// copy the packager bundled INSIDE the engine at tools/data/memory-seed/
// (resolved by frameworkMemorySeedDir, mirroring frameworkTemplatesDir/DATA_DIR).
//
// Three contracts land here:
//   (a) THE BUNDLE: the packager emitted the method seed INSIDE the shipped
//       engine dir, and frameworkMemorySeedDir() resolves to it (in-process, the
//       `none` floor — a pure relative-to-DATA_DIR path).
//   (b) THE SELF-HEAL: a temp project with NO aidlc/ shell (engine-only install)
//       gains a populated aidlc/spaces/default/memory/ after the first birth.
//   (c) IDEMPOTENCY: a project whose default memory tree ALREADY exists (a normal
//       install that copied aidlc/) is left byte-unchanged — the existsSync guard
//       skips the seed, so a committed tree never churns.
//
// MECHANISM. (a) imports frameworkMemorySeedDir in-process from the shipped dist
// tree (the `none` floor for an exported lib fn). (b)/(c) SPAWN the real engine
// CLI (`aidlc-utility.ts intent-birth`) so the actual first-run path — birth →
// ensureWorkspaceDirs → the guarded cpSync — is exercised end-to-end, with the
// seed resolved relative to the SPAWNED tool's own location (DATA_DIR). Zero
// tokens, zero network.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { frameworkMemorySeedDir } from "../../dist/claude/.claude/tools/aidlc-graph.ts";

const BUN = process.execPath; // the bun running this test
const UTILITY = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
// The seed bundled INSIDE the shipped Claude engine dir (tools/data/memory-seed/).
const BUNDLED_SEED = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "data",
  "memory-seed",
);
// Where ensureWorkspaceDirs lands the default-space method tree.
const DEFAULT_MEMORY_REL = join("aidlc", "spaces", "default", "memory");

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkTemp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `aidlc-tseed-${tag}-`));
  tempDirs.push(d);
  return d;
}

/** Birth the first intent into a project via the real engine CLI — the first-run
 *  path that flows through ensureWorkspaceDirs (where the self-heal seed fires).
 *  frameworkMemorySeedDir resolves relative to the SPAWNED tool's location, so the
 *  bundled seed under dist/claude/.claude/tools/data/memory-seed/ is the source. */
function birth(projectDir: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    BUN,
    [UTILITY, "intent-birth", "--scope", "poc", "--arguments", "x", "--project-dir", projectDir],
    { encoding: "utf-8" },
  );
}

describe("t-memory-seed engine-only-install self-heal", () => {
  // === (a) THE BUNDLE ======================================================
  test("a: frameworkMemorySeedDir resolves to the engine-bundled seed, which ships in dist", () => {
    const seed = frameworkMemorySeedDir();
    // Defaults to DATA_DIR/memory-seed relative to THIS test's import of the
    // shipped Claude tool — i.e. the bundled seed under that tree.
    expect(seed).toBe(BUNDLED_SEED);
    // The seed shipped, with real method content (not just an empty dir).
    expect(existsSync(join(BUNDLED_SEED, "org.md"))).toBe(true);
    expect(readFileSync(join(BUNDLED_SEED, "org.md"), "utf-8").length).toBeGreaterThan(0);
    // And the nested per-phase method file ships too (the whole core/memory/ tree).
    expect(existsSync(join(BUNDLED_SEED, "phases", "construction.md"))).toBe(true);
  });

  // === (b) THE SELF-HEAL ===================================================
  test("b: an engine-only install (NO aidlc/ shell) gains a populated default memory tree on first birth", () => {
    // A bare temp project — the engine-only-install shape: no sibling aidlc/ shell,
    // so the default-space method tree is ABSENT before the first /aidlc.
    const proj = mkTemp("heal");
    const defaultMemory = join(proj, DEFAULT_MEMORY_REL);
    expect(existsSync(defaultMemory), "default memory absent before birth").toBe(false);

    const res = birth(proj);
    expect(res.status, `intent-birth failed: ${res.stdout}\n${res.stderr}`).toBe(0);

    // The self-heal seeded the default-space method tree from the engine bundle.
    const orgMd = join(defaultMemory, "org.md");
    expect(existsSync(orgMd), "org.md seeded into default memory").toBe(true);
    const body = readFileSync(orgMd, "utf-8");
    expect(body.length, "seeded org.md has real content").toBeGreaterThan(0);
    // Byte-for-byte the engine bundle (it is a recursive copy, no transform).
    expect(body).toBe(readFileSync(join(BUNDLED_SEED, "org.md"), "utf-8"));
    // The nested per-phase method file was copied recursively too.
    expect(existsSync(join(defaultMemory, "phases", "construction.md"))).toBe(true);
  });

  // === (c) IDEMPOTENCY =====================================================
  test("c: an existing default memory tree is left byte-unchanged (guard skips the seed)", () => {
    // A normal install that copied aidlc/: the default memory tree already exists.
    // Plant a sentinel so we can prove the seed did NOT overwrite it.
    const proj = mkTemp("idemp");
    const defaultMemory = join(proj, DEFAULT_MEMORY_REL);
    mkdirSync(defaultMemory, { recursive: true });
    const sentinel = "SENTINEL-DO-NOT-OVERWRITE\n";
    const orgMd = join(defaultMemory, "org.md");
    writeFileSync(orgMd, sentinel, "utf-8");

    const res = birth(proj);
    expect(res.status, `intent-birth failed: ${res.stdout}\n${res.stderr}`).toBe(0);

    // The existsSync guard skipped the seed — the sentinel survives byte-for-byte,
    // so a committed/hand-edited default tree never churns.
    expect(readFileSync(orgMd, "utf-8")).toBe(sentinel);
  });
});
