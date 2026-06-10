// covers: subcommand:aidlc-runtime:fragment-fork, subcommand:aidlc-runtime:fragment-merge
//
// bun:test port of tests/unit/t96-runtime-fragment-primitives.sh (TAP plan 14),
// mechanism = cli. Faithful migration, not a rewrite: every .sh assertion is a
// PROCESS-boundary contract (exit code + stdout JSON + stderr text), so each is
// ported as a spawnSync of the real CLI rather than a weaker .none import-twin.
//
// SPAWN vs IN-PROCESS split: ALL 14 .sh assertions cross the process boundary —
// the .sh asserts on $? (exit code), captured stdout, and captured stderr of
// `bun aidlc-runtime.ts [--project-dir <pd>] <subcommand> ...`. There are NO
// pure-function assertions in the source (the byte-equal-copy and hash checks
// are done by reading files / shasum AFTER the spawn, observing the tool's
// side-effects, not by calling a function in-process). So this is a pure .cli
// file with zero in-process function units. As a .cli-mechanism file it
// legitimately credits the `aidlc-runtime fragment-fork` + `aidlc-runtime
// fragment-merge` subcommand units (minMechanism: cli) that a .none twin could
// not.
//
// Surface mirrored 1:1 from the .sh:
//   T1  fragment-fork happy path: byte-equal copy + JSON envelope + matching hash + source_present:true
//   T2  fragment-fork source-absent: writes empty graph, source_present:false
//   T3  fragment-fork one-shot guard: second invocation errors + leaves fragment unchanged
//   T4  fragment-fork worktree-missing guard: actionable message
//   T5  fragment-fork slug-validation: --slug required
//   T6  fragment-fork slug-validation: invalid regex rejection (BOLT_SLUG_REGEX)
//   T7  fragment-merge happy: unlinks fragment + JSON envelope + matching pre-unlink hash
//   T8  fragment-merge idempotent: status:fragment-absent + exit 0
//   T9  fragment-merge slug-validation: --slug required
//   T10 fragment-merge slug-validation: invalid regex rejection
//   T11 fragment-merge worktree-missing: defensive fragment-absent
//   T12 --help lists both subcommands with orchestration context
//   T13 unknown subcommand error path
//   T14 --project-dir plumbing (B1): pre-strip in spawnSibling-style invocation order
//
// FIXTURE DISCIPLINE: each case builds a self-contained temp project via
// createTestProject() + seedStateFile() (the .ts analogues of the .sh's
// make_project, which cp'd state-construction.md into aidlc-docs/) and removes
// it after. The runtime-graph.json + .aidlc/worktrees/bolt-<slug>/ layout is
// test-specific so it is written inline (the .sh wrote it inline too). NOTHING
// is written under tests/fixtures/**.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject, seedStateFile } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "tools",
  "aidlc-runtime.ts",
);

// Mirrors the .sh's GRAPH literal — the exact bytes written to main
// runtime-graph.json so the source-hash assertion has a known expected value.
const GRAPH =
  '{"workflow_id":"t96-1","scope":"feature","started_at":"2026-05-28T10:00:00Z","stages":[]}';

// --- per-case temp project harness ----------------------------------------

let projDir = "";

// make_project analogue (t96-runtime-fragment-primitives.sh:68-86):
//   - fresh temp project with aidlc-docs/aidlc-state.md seeded from
//     state-construction.md (createTestProject + seedStateFile).
//   - mainGraph !== null  -> write main aidlc-docs/runtime-graph.json bytes.
//   - slug !== null       -> pre-create .aidlc/worktrees/bolt-<slug>/aidlc-docs/
//     and byte-copy main state into it (simulating what state-fork populates).
function makeProject(slug: string | null, mainGraph: string | null): string {
  const proj = createTestProject();
  seedStateFile(proj, "state-construction.md");
  if (mainGraph !== null) {
    writeFileSync(join(proj, "aidlc-docs", "runtime-graph.json"), mainGraph);
  }
  if (slug !== null) {
    const wtDocs = join(proj, ".aidlc", "worktrees", `bolt-${slug}`, "aidlc-docs");
    mkdirSync(wtDocs, { recursive: true });
    // state-fork byte-copies main state to worktree — simulate that.
    writeFileSync(
      join(wtDocs, "aidlc-state.md"),
      readFileSync(join(proj, "aidlc-docs", "aidlc-state.md")),
    );
  }
  return proj;
}

// wt_fragment_path analogue (t96:88-90).
function wtFragmentPath(proj: string, slug: string): string {
  return join(proj, ".aidlc", "worktrees", `bolt-${slug}`, "aidlc-docs", "runtime-graph.json");
}

// run_runtime analogue (t96:94-100): invoke with --project-dir BEFORE the
// subcommand (the spawnSibling order the pre-strip handles), capture stdout +
// stderr + exit code separately so individual assertions read the same field
// the .sh read ($RUNTIME_OUT / $RUNTIME_ERR / $RUNTIME_RC).
function runRuntime(
  proj: string,
  ...args: string[]
): { rc: number; out: string; err: string } {
  const res = spawnSync(BUN, [TOOL, "--project-dir", proj, ...args], {
    encoding: "utf-8",
    cwd: proj,
  });
  return { rc: res.status ?? -1, out: res.stdout ?? "", err: res.stderr ?? "" };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  cleanupTestProject(projDir);
  projDir = "";
});

// --- 1. fragment-fork happy path ------------------------------------------
describe("t96 fragment-fork happy path", () => {
  test("byte-equal copy + JSON envelope + matching hash + source_present:true", () => {
    projDir = makeProject("auth", GRAPH);
    const wtFrag = wtFragmentPath(projDir, "auth");
    const expectedHash = createHash("sha256").update(GRAPH).digest("hex");

    const r = runRuntime(projDir, "fragment-fork", "--slug", "auth");

    expect(r.rc).toBe(0);
    expect(existsSync(wtFrag)).toBe(true);
    // diff -q main vs fragment: byte-equal copy.
    expect(readFileSync(wtFrag)).toEqual(
      readFileSync(join(projDir, "aidlc-docs", "runtime-graph.json")),
    );
    expect(r.out).toContain('"status":"fragment-forked"');
    expect(r.out).toContain('"slug":"auth"');
    expect(r.out).toContain(`"source_runtime_graph_hash":"${expectedHash}"`);
    expect(r.out).toContain('"source_present":true');
  });
});

// --- 2. fragment-fork source-absent (no main runtime-graph) ---------------
describe("t96 fragment-fork source-absent", () => {
  test("writes empty graph, source_present:false", () => {
    projDir = makeProject("cart", null); // no main graph
    const wtFrag = wtFragmentPath(projDir, "cart");

    const r = runRuntime(projDir, "fragment-fork", "--slug", "cart");

    expect(r.rc).toBe(0);
    expect(existsSync(wtFrag)).toBe(true);
    expect(r.out).toContain('"status":"fragment-forked"');
    expect(r.out).toContain('"source_present":false');
    // empty graph has `"stages": []` (pretty-printed by writeEmptyGraph).
    expect(readFileSync(wtFrag, "utf-8")).toContain('"stages": []');
  });
});

// --- 3. fragment-fork one-shot guard --------------------------------------
describe("t96 fragment-fork one-shot guard", () => {
  test("second invocation errors + leaves existing fragment unchanged", () => {
    projDir = makeProject("auth", GRAPH);
    const wtFrag = wtFragmentPath(projDir, "auth");

    runRuntime(projDir, "fragment-fork", "--slug", "auth"); // first ok
    const preHash = sha256File(wtFrag);
    const r = runRuntime(projDir, "fragment-fork", "--slug", "auth"); // second errors
    const postHash = sha256File(wtFrag);

    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("fragment already exists");
    expect(r.err).toContain("refusing to overwrite");
    expect(preHash).toBe(postHash);
  });
});

// --- 4. fragment-fork worktree-missing guard ------------------------------
describe("t96 fragment-fork worktree-missing guard", () => {
  test("errors with actionable message", () => {
    projDir = makeProject(null, GRAPH); // no worktree dir
    const r = runRuntime(projDir, "fragment-fork", "--slug", "nonexistent");

    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("worktree directory not found");
    expect(r.err).toContain("run aidlc-worktree create first");
  });
});

// --- 5. fragment-fork slug-validation: missing flag -----------------------
describe("t96 fragment-fork slug-validation: --slug required", () => {
  test("errors when --slug omitted", () => {
    projDir = makeProject("auth", GRAPH);
    const r = runRuntime(projDir, "fragment-fork");

    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("--slug <slug> required");
  });
});

// --- 6. fragment-fork slug-validation: invalid regex ----------------------
describe("t96 fragment-fork slug-validation: regex rejection", () => {
  test("rejects a slug failing BOLT_SLUG_REGEX", () => {
    projDir = makeProject("auth", GRAPH);
    const r = runRuntime(projDir, "fragment-fork", "--slug", "BAD!");

    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("Invalid Bolt slug");
  });
});

// --- 7. fragment-merge happy path -----------------------------------------
describe("t96 fragment-merge happy path", () => {
  test("unlinks fragment + JSON envelope + matching pre-unlink hash", () => {
    projDir = makeProject("auth", GRAPH);
    runRuntime(projDir, "fragment-fork", "--slug", "auth"); // set up the fragment
    const wtFrag = wtFragmentPath(projDir, "auth");
    const preHash = sha256File(wtFrag);

    const r = runRuntime(projDir, "fragment-merge", "--slug", "auth");

    expect(r.rc).toBe(0);
    expect(existsSync(wtFrag)).toBe(false);
    expect(r.out).toContain('"status":"fragment-merged"');
    expect(r.out).toContain('"slug":"auth"');
    expect(r.out).toContain(`"fragment_runtime_graph_hash":"${preHash}"`);
  });
});

// --- 8. fragment-merge fragment-absent (idempotent) -----------------------
describe("t96 fragment-merge idempotent", () => {
  test("status:fragment-absent + exit 0 when fragment never created", () => {
    projDir = makeProject("auth", GRAPH);
    // Fragment never created (no fragment-fork). Worktree dir exists.
    const r = runRuntime(projDir, "fragment-merge", "--slug", "auth");

    expect(r.rc).toBe(0);
    expect(r.out).toContain('"status":"fragment-absent"');
    expect(r.out).toContain('"slug":"auth"');
  });
});

// --- 9. fragment-merge slug-validation: missing flag ----------------------
describe("t96 fragment-merge slug-validation: --slug required", () => {
  test("errors when --slug omitted", () => {
    projDir = makeProject("auth", GRAPH);
    const r = runRuntime(projDir, "fragment-merge");

    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("--slug <slug> required");
  });
});

// --- 10. fragment-merge slug-validation: invalid regex --------------------
describe("t96 fragment-merge slug-validation: regex rejection", () => {
  test("rejects a slug failing BOLT_SLUG_REGEX", () => {
    projDir = makeProject("auth", GRAPH);
    const r = runRuntime(projDir, "fragment-merge", "--slug", "BAD!");

    expect(r.rc).not.toBe(0);
    expect(r.err).toContain("Invalid Bolt slug");
  });
});

// --- 11. fragment-merge worktree-missing → defensive fragment-absent ------
describe("t96 fragment-merge worktree-missing", () => {
  test("defensive fragment-absent when worktree dir is absent", () => {
    projDir = makeProject(null, GRAPH); // no worktree dir
    const r = runRuntime(projDir, "fragment-merge", "--slug", "nonexistent");

    expect(r.rc).toBe(0);
    expect(r.out).toContain('"status":"fragment-absent"');
  });
});

// --- 12. --help lists both new subcommands --------------------------------
describe("t96 --help listing", () => {
  test("lists fragment-fork + fragment-merge with orchestration context", () => {
    // Help path takes no project; spawn the tool directly with --help and
    // combine stdout+stderr like the .sh's `2>&1`.
    const res = spawnSync(BUN, [TOOL, "--help"], { encoding: "utf-8" });
    const helpOut = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    expect(helpOut).toContain("fragment-fork --slug");
    expect(helpOut).toContain("fragment-merge --slug");
    expect(helpOut).toContain("Called by aidlc-bolt");
  });
});

// --- 13. unknown subcommand error -----------------------------------------
describe("t96 unknown subcommand", () => {
  test("falls through to error path", () => {
    const res = spawnSync(BUN, [TOOL, "frabglo"], { encoding: "utf-8" });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

    expect(out).toContain("Unknown subcommand: frabglo");
  });
});

// --- 14. --project-dir plumbing (B1 from milestone 11 plan) ----------------------
describe("t96 --project-dir plumbing (B1)", () => {
  test("pre-strip works in spawnSibling-style invocation order", () => {
    // Verify the spawnSibling-style invocation order works:
    //   bun aidlc-runtime.ts --project-dir <pd> fragment-fork --slug <slug>
    // (--project-dir BEFORE the subcommand, mirroring spawnSibling at
    // aidlc-bolt.ts:79-103). runRuntime already injects --project-dir first.
    projDir = makeProject("auth", GRAPH);
    const wtFrag = wtFragmentPath(projDir, "auth");
    const r = runRuntime(projDir, "fragment-fork", "--slug", "auth");

    expect(r.rc).toBe(0);
    expect(existsSync(wtFrag)).toBe(true);
    expect(r.out).toContain('"status":"fragment-forked"');
  });
});
