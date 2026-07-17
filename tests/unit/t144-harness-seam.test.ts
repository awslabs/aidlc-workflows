// t144-codex-harness-seam: harnessDir()/resolveProjectDir ladder across all
// three harness dirs (.claude / .kiro / .codex).
//
// covers: function:harnessDir, function:resolveProjectDir, function:rulesSubdir, file:tools/aidlc-lib.ts
//
// WHAT. MR-1 of the dist/codex port widens the kiro harness seam with
// ".codex": HARNESS_DIRS = [".claude", ".kiro", ".codex"]. This test pins the
// documented resolution ladder for BOTH seam functions, for all three dirs:
//   harnessDir():        AIDLC_HARNESS_DIR env → script-path derivation
//                        (<project>/<harness>/tools) → CWD probe (.claude
//                        first) → ".claude" fallback.
//   resolveProjectDir(): explicit arg → CLAUDE_PROJECT_DIR → script-path
//                        suffix strip (per harness dir) → CWD-with-marker →
//                        cwd.
// The codex tree does not exist yet (it lands in MR-3); these cases prove the
// seam is a pure superset by exercising lib copies placed in synthetic
// .codex trees — exactly how the packaged dist/codex/.codex/tools will sit.
//
// WHY A SUBPROCESS PER CASE. harnessDir() caches its derivation per process
// (env is read fresh, derivation is not), and the suite's own cwd has a
// .claude dir — in-process assertions would race other tests' env. Each case
// spawns a fresh bun with a controlled cwd/env, mirroring how the tools are
// really invoked. (Same idiom as kiro's t141.)

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const CLAUDE_LIB = join(CLAUDE_TOOLS, "aidlc-lib.ts");

// Materialize a minimal <root>/<harness>/tools/ tree carrying the real lib
// (plus its sibling imports) so script-path derivation sees the genuine shipped
// layout for that harness dir. The packager emits tools/data/harness.json per
// tree ({"rulesSubdir": ...}); we mirror that here so rulesSubdir() reads the
// open-set descriptor exactly as it would in a real install. Pass a rulesSubdir
// to drive ANY harness — including a synthetic 4th (e.g. .gemini) — proving the
// runtime needs zero edits to support a new harness.
function libInHarnessTree(root: string, harness: string, rulesSubdir?: string): string {
  const toolsDir = join(root, harness, "tools");
  mkdirSync(join(toolsDir, "data"), { recursive: true });
  for (const sibling of ["aidlc-lib.ts", "aidlc-graph.ts", "aidlc-runtime-paths.ts", "aidlc-stage-schema.ts", "aidlc-version.ts"]) {
    cpSync(join(CLAUDE_TOOLS, sibling), join(toolsDir, sibling));
  }
  // Seed the compiled-data files (stage-graph/scope-grid) from claude — they are
  // harness-independent for the lib's purposes — then overwrite harness.json
  // with this harness's real descriptor.
  cpSync(join(CLAUDE_TOOLS, "data"), join(toolsDir, "data"), { recursive: true });
  writeFileSync(
    join(toolsDir, "data", "harness.json"),
    `${JSON.stringify({ harnessDir: harness, rulesSubdir: rulesSubdir ?? "rules" }, null, 2)}\n`,
  );
  return join(toolsDir, "aidlc-lib.ts");
}

function evalLib(
  libPath: string,
  expr: string,
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): string {
  const r = spawnSync(
    "bun",
    ["-e", `import { harnessDir, resolveProjectDir, rulesSubdir } from ${JSON.stringify(libPath)}; console.log(${expr});`],
    {
      encoding: "utf-8",
      cwd: opts.cwd ?? REPO_ROOT,
      env: {
        ...process.env,
        AIDLC_HARNESS_DIR: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        ...opts.env,
      } as NodeJS.ProcessEnv,
    },
  );
  expect(r.status).toBe(0);
  return (r.stdout ?? "").trim();
}

describe("t144 codex harness seam — harnessDir + resolveProjectDir ladder ×3 dirs", () => {
  test("1: harnessDir derives each harness dir from its script path", () => {
    expect(evalLib(CLAUDE_LIB, "harnessDir()")).toBe(".claude");
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "t144-")));
    try {
      for (const h of [".kiro", ".codex"]) {
        const lib = libInHarnessTree(join(tmp, h.slice(1)), h);
        expect(evalLib(lib, "harnessDir()")).toBe(h);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("2: AIDLC_HARNESS_DIR env seam overrides derivation for every dir", () => {
    for (const h of [".claude", ".kiro", ".codex"]) {
      expect(evalLib(CLAUDE_LIB, "harnessDir()", { env: { AIDLC_HARNESS_DIR: h } })).toBe(h);
    }
  });

  test("3: CWD probe finds .codex when script-path derivation misses; .claude wins when both exist", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "t144-")));
    try {
      // Lib copied OUTSIDE any harness tree → derivation misses → CWD probe.
      const libCopy = join(tmp, "aidlc-lib.ts");
      for (const sibling of ["aidlc-lib.ts", "aidlc-graph.ts", "aidlc-runtime-paths.ts", "aidlc-stage-schema.ts", "aidlc-version.ts"]) {
        cpSync(join(CLAUDE_TOOLS, sibling), join(tmp, sibling));
      }
      cpSync(join(CLAUDE_TOOLS, "data"), join(tmp, "data"), { recursive: true });
      mkdirSync(join(tmp, ".codex"));
      expect(evalLib(libCopy, "harnessDir()", { cwd: tmp })).toBe(".codex");
      // Precedence: .claude beats .codex when both are present.
      mkdirSync(join(tmp, ".claude"));
      expect(evalLib(libCopy, "harnessDir()", { cwd: tmp })).toBe(".claude");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("4: resolveProjectDir strips <harness>/tools for every harness dir", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "t144-")));
    try {
      for (const h of [".claude", ".kiro", ".codex"]) {
        const root = join(tmp, h.slice(1));
        const lib = libInHarnessTree(root, h);
        expect(evalLib(lib, "resolveProjectDir()", { cwd: tmp })).toBe(root);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("5: resolveProjectDir CWD-marker rung accepts a .codex marker", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "t144-")));
    try {
      // Lib outside any harness tree → suffix strip misses → CWD marker rung.
      const libCopy = join(tmp, "aidlc-lib.ts");
      for (const sibling of ["aidlc-lib.ts", "aidlc-graph.ts", "aidlc-runtime-paths.ts", "aidlc-stage-schema.ts", "aidlc-version.ts"]) {
        cpSync(join(CLAUDE_TOOLS, sibling), join(tmp, sibling));
      }
      cpSync(join(CLAUDE_TOOLS, "data"), join(tmp, "data"), { recursive: true });
      const project = join(tmp, "proj");
      mkdirSync(join(project, ".codex"), { recursive: true });
      expect(evalLib(libCopy, "resolveProjectDir()", { cwd: project })).toBe(project);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("6: explicit arg and CLAUDE_PROJECT_DIR outrank the harness rungs", () => {
    expect(evalLib(CLAUDE_LIB, 'resolveProjectDir("/explicit/dir")')).toBe("/explicit/dir");
    expect(
      evalLib(CLAUDE_LIB, "resolveProjectDir()", { env: { CLAUDE_PROJECT_DIR: "/from/env" } }),
    ).toBe("/from/env");
    const canonicalTmp = realpathSync(tmpdir());
    expect(
      evalLib(CLAUDE_LIB, 'resolveProjectDir("relative/project")', { cwd: canonicalTmp }),
    ).toBe(join(canonicalTmp, "relative/project"));
    expect(
      evalLib(CLAUDE_LIB, "resolveProjectDir()", {
        cwd: canonicalTmp,
        env: { AIDLC_PROJECT_DIR: "relative/project" },
      }),
    ).toBe(join(canonicalTmp, "relative/project"));
  });

  // rulesSubdir() is the companion seam: the AIDLC markdown rule layers live
  // under a per-harness subdirectory (.claude/rules, .kiro/steering,
  // .codex/aidlc-rules). The .ts tools are byte-copied across all trees, so a
  // runtime rule path MUST resolve the segment through this seam — a hardcoded
  // "rules" targets a dir that does not exist on a rename-rules harness (the
  // CRIT-2 practices-promote / learnings / loadRules bug this fixed). The rename
  // is OPEN-SET: the packager emits it into tools/data/harness.json per tree, so
  // rulesSubdir() reads THAT (not a hardcoded map) — a real install of any
  // harness resolves correctly with zero core edits.
  test("7: rulesSubdir reads the per-tree harness.json descriptor for each harness dir", () => {
    // Claude's shipped tree (harness.json says "rules"), derived via script path.
    expect(evalLib(CLAUDE_LIB, "rulesSubdir()")).toBe("rules");
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "t144-")));
    try {
      const expected: Record<string, string> = { ".kiro": "steering", ".codex": "aidlc-rules" };
      for (const h of [".kiro", ".codex"]) {
        const lib = libInHarnessTree(join(tmp, h.slice(1)), h, expected[h]);
        expect(evalLib(lib, "rulesSubdir()")).toBe(expected[h]);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The open-set proof: a synthetic 4th harness (.gemini) the runtime has never
  // heard of — not in KNOWN_HARNESS_DIRS, not in the dev-fallback map — resolves
  // its dir AND its renamed rules subdir purely from the shipped layout +
  // harness.json, with NO env seams and ZERO edits to aidlc-lib.ts. This is the
  // T1 "harness #N = one harness/ dir + one manifest row, zero core edits"
  // tenet, made executable.
  test("7b: a brand-new 4th harness (.gemini) resolves dir + rules with zero core edits", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "t144-")));
    try {
      const lib = libInHarnessTree(join(tmp, "gemini"), ".gemini", "gemini-rules");
      // harnessDir derived open-set from the script path (basename of grandparent).
      expect(evalLib(lib, "harnessDir()")).toBe(".gemini");
      // rulesSubdir read from the emitted harness.json — no hardcoded entry exists.
      expect(evalLib(lib, "rulesSubdir()")).toBe("gemini-rules");
      // resolveProjectDir strips "<harness>/tools" for the unknown dir too.
      expect(evalLib(lib, "resolveProjectDir()")).toBe(join(tmp, "gemini"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("8: rulesSubdir honors AIDLC_HARNESS_DIR and the AIDLC_RULES_SUBDIR override", () => {
    // The AIDLC_HARNESS_DIR test seam pins the harness without a tree on disk and
    // out-ranks any shipped harness.json (so "pretend .kiro" yields "steering").
    expect(evalLib(CLAUDE_LIB, "rulesSubdir()", { env: { AIDLC_HARNESS_DIR: ".kiro" } })).toBe("steering");
    expect(evalLib(CLAUDE_LIB, "rulesSubdir()", { env: { AIDLC_HARNESS_DIR: ".codex" } })).toBe("aidlc-rules");
    // ...and the explicit AIDLC_RULES_SUBDIR override wins (fixture seam).
    expect(
      evalLib(CLAUDE_LIB, "rulesSubdir()", {
        env: { AIDLC_HARNESS_DIR: ".kiro", AIDLC_RULES_SUBDIR: "custom-rules" },
      }),
    ).toBe("custom-rules");
  });
});
