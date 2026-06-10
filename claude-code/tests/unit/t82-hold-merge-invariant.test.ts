// covers: subcommand:aidlc-bolt:hold-merge, subcommand:aidlc-bolt:release-merge, subcommand:aidlc-bolt:complete
//
// t82 — aidlc-bolt.ts HOLD-MERGE invariant tooling (v0.4.0 milestone 13 post-merge
// fold-in). Migrated from tests/unit/t82-hold-merge-invariant.sh (TAP plan 10).
//
// Mechanism: cli. Every assertion is a process-boundary contract:
//   - `hold-merge` / `release-merge` mutate the per-Bolt FORKED state file at
//     <proj>/.aidlc/worktrees/bolt-<slug>/aidlc-docs/aidlc-state.md and print a
//     JSON envelope to stdout, then return (handleHoldMerge / handleReleaseMerge,
//     aidlc-bolt.ts:587-601).
//   - `complete --merge` refuses with process.exit(1) + a {ok:false,
//     reason:"merge-held", ...} envelope when the marker is set (failJson,
//     aidlc-bolt.ts:336-343,868-888), and proceeds (exit 0) once released.
//   - the refusal path must NOT emit BOLT_COMPLETED into main audit.md.
// The setup itself (`start --worktree --slug`) FANS OUT to sibling tools
// (aidlc-state fork / aidlc-audit audit-fork / aidlc-runtime fragment-fork via
// spawnSibling, :222-284) to materialise the forked state file — that multi-
// process fork chain plus the process.exit refusal seam is exactly what an
// in-process import twin would lose, so this is spawned end-to-end (the same
// `bun "$TOOL" ...` the .sh ran). spawnCount = all.
//
// Source under test (dist/claude/.claude/tools/aidlc-bolt.ts):
//   :587 handleHoldMerge(args)    -> setMergeHeld(pd, slug, true);
//                                     console.log({slug, merge_held:true})
//   :595 handleReleaseMerge(args) -> setMergeHeld(pd, slug, false);
//                                     console.log({slug, merge_held:false})
//   :621 setMergeHeld(pd, slug, held) -> errors (exit 1 via error()) when the
//        forked state file is absent (:622-627); else setOrInsertField under
//        "## Project Information" writes `- **Merge-Held**: true|false`.
//   :336 handleComplete: if (isMergeHeld(pd, slug)) failJson("complete-merge",
//        slug, "merge-held", "...run `aidlc-bolt release-merge --slug <slug>`
//        before retrying.") — refusal fires BEFORE the BOLT_COMPLETED emit
//        (:354), so no audit row is written on refusal.
//   :613 isMergeHeld -> getField(content, "Merge-Held") === "true".
//
// Forked-state-file path is worktreePath(pd,slug)/aidlc-docs/aidlc-state.md
// where worktreePath = <pd>/.aidlc/worktrees/bolt-<slug> (aidlc-lib.ts:148).
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test):
//   .sh T1  hold-merge sets Merge-Held: true   -> "hold-merge sets `- **Merge-Held**: true` in forked state"
//   .sh T2  release-merge clears to false      -> "release-merge sets `- **Merge-Held**: false` in forked state"
//   .sh T3  hold-merge stdout carries slug      -> "hold-merge stdout envelope carries slug + merge_held:true"
//   .sh T4  release-merge stdout merge_held:false -> "release-merge stdout envelope reports merge_held:false"
//   .sh T5  complete --merge non-zero when held -> "complete --merge refuses with exit 1 when held"
//   .sh T6  refusal reason=merge-held           -> "complete --merge refusal envelope reports reason=merge-held"
//   .sh T7  refusal detail names release-merge  -> "complete --merge refusal detail names release-merge"
//   .sh T8  no BOLT_COMPLETED under refusal      -> "complete --merge refusal does NOT emit BOLT_COMPLETED"
//   .sh T9  complete --merge proceeds after release -> "complete --merge proceeds (exit 0) after release-merge"
//   .sh T10 hold-merge errors when forked state absent -> "hold-merge errors (exit 1) when forked state absent"
//
// STRONGER than the .sh where cheap: T3 asserts the parsed envelope object
// ({slug, merge_held:true}) not just a substring; idempotency of hold-merge /
// release-merge (the .sh's prose pin "second call same outcome") is also
// exercised inside T1/T2 setup implicitly and asserted explicitly in T1.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();

const BUN = process.execPath; // the bun running this test
const TOOL = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const STATE_FIXTURE = join(FIXTURES_DIR, "state-construction.md");

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

interface BoltResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn `bun aidlc-bolt.ts <args> --project-dir <proj>`, capture 2>&1. */
function bolt(proj: string, args: string[]): BoltResult {
  const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", proj], {
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/**
 * setup_forked_project (t82:34-44): a construction-state project with a
 * forked Bolt at <slug> ready for hold-merge tests. `start --worktree --slug`
 * fans out to state-fork / audit-fork / fragment-fork, materialising the
 * forked state file. Returns the project dir (registered for teardown).
 */
function setupForkedProject(slug: string): string {
  const proj = createTestProject();
  projects.push(proj);
  seedStateFile(proj, STATE_FIXTURE);
  seedAuditFile(proj);
  mkdirSync(join(proj, ".aidlc", "worktrees", `bolt-${slug}`), {
    recursive: true,
  });
  const r = bolt(proj, [
    "start",
    "--name",
    `Bolt${slug}`,
    "--batch",
    "1",
    "--worktree",
    "--slug",
    slug,
  ]);
  // Guard the precondition the .sh assumed implicitly: the fork chain succeeded
  // and the forked state file now exists. A broken fixture must fail loudly
  // here, not as a misleading red in a downstream behavioural assertion.
  expect(r.status).toBe(0);
  expect(existsSync(forkedState(proj, slug))).toBe(true);
  return proj;
}

/** The per-Bolt forked state file the hold-merge marker is written into. */
function forkedState(proj: string, slug: string): string {
  return join(
    proj,
    ".aidlc",
    "worktrees",
    `bolt-${slug}`,
    "aidlc-docs",
    "aidlc-state.md",
  );
}

describe("t82 aidlc-bolt HOLD-MERGE invariant (migrated from t82-hold-merge-invariant.sh, plan 10)", () => {
  test("hold-merge sets `- **Merge-Held**: true` in forked state [.sh T1]", () => {
    const proj = setupForkedProject("hm1");
    const r1 = bolt(proj, ["hold-merge", "--slug", "hm1"]);
    expect(r1.status).toBe(0);
    const body = readFileSync(forkedState(proj, "hm1"), "utf-8");
    // Same line the .sh grepped: `^- \*\*Merge-Held\*\*: true`.
    expect(body.split("\n").some((l) => l === "- **Merge-Held**: true")).toBe(
      true,
    );
    // STRONGER than the .sh: hold-merge is idempotent (prose pin "second call
    // same outcome"). A re-run stays exit 0 with the marker still true and no
    // duplicate field line.
    const r2 = bolt(proj, ["hold-merge", "--slug", "hm1"]);
    expect(r2.status).toBe(0);
    const body2 = readFileSync(forkedState(proj, "hm1"), "utf-8");
    const trueLines = body2
      .split("\n")
      .filter((l) => l === "- **Merge-Held**: true").length;
    expect(trueLines).toBe(1);
  }, 30000);

  test("release-merge sets `- **Merge-Held**: false` in forked state [.sh T2]", () => {
    const proj = setupForkedProject("hm2");
    expect(bolt(proj, ["hold-merge", "--slug", "hm2"]).status).toBe(0);
    const rel = bolt(proj, ["release-merge", "--slug", "hm2"]);
    expect(rel.status).toBe(0);
    const body = readFileSync(forkedState(proj, "hm2"), "utf-8");
    // Same line the .sh grepped: `^- \*\*Merge-Held\*\*: false`.
    expect(body.split("\n").some((l) => l === "- **Merge-Held**: false")).toBe(
      true,
    );
    expect(body.includes("- **Merge-Held**: true")).toBe(false);
  }, 30000);

  test("hold-merge stdout envelope carries slug + merge_held:true [.sh T3]", () => {
    const proj = setupForkedProject("hm3");
    const r = bolt(proj, ["hold-merge", "--slug", "hm3"]);
    expect(r.status).toBe(0);
    // .sh: assert_contains "$OUT" '"slug":"hm3"'. STRONGER: parse the JSON line
    // and assert the full envelope shape, not a substring.
    const line = r.out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("{") && l.includes('"slug"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string);
    expect(parsed).toEqual({ slug: "hm3", merge_held: true });
  }, 30000);

  test("release-merge stdout envelope reports merge_held:false [.sh T4]", () => {
    const proj = setupForkedProject("hm4");
    const r = bolt(proj, ["release-merge", "--slug", "hm4"]);
    expect(r.status).toBe(0);
    // .sh: assert_contains "$OUT" '"merge_held":false'. STRONGER: full shape.
    expect(r.out.replace(/\s/g, "")).toContain('"merge_held":false');
    const line = r.out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("{") && l.includes('"merge_held"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string);
    expect(parsed).toEqual({ slug: "hm4", merge_held: false });
  }, 30000);

  test("complete --merge refuses with exit 1 when held [.sh T5]", () => {
    const proj = setupForkedProject("hm5");
    expect(bolt(proj, ["hold-merge", "--slug", "hm5"]).status).toBe(0);
    const r = bolt(proj, [
      "complete",
      "--name",
      "Hm5",
      "--batch",
      "1",
      "--merge",
      "--slug",
      "hm5",
    ]);
    // .sh: assert_eq "$RC" "1".
    expect(r.status).toBe(1);
  }, 30000);

  test("complete --merge refusal envelope reports reason=merge-held [.sh T6]", () => {
    const proj = setupForkedProject("hm6");
    expect(bolt(proj, ["hold-merge", "--slug", "hm6"]).status).toBe(0);
    const r = bolt(proj, [
      "complete",
      "--name",
      "Hm6",
      "--batch",
      "1",
      "--merge",
      "--slug",
      "hm6",
    ]);
    expect(r.status).toBe(1);
    // .sh: assert_contains "$OUT" '"reason":"merge-held"'. STRONGER: the parsed
    // failJson envelope is {ok:false, slug, stage:"complete-merge",
    // reason:"merge-held", detail:...}.
    const line = r.out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("{") && l.includes('"reason"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("merge-held");
    expect(parsed.slug).toBe("hm6");
    expect(parsed.stage).toBe("complete-merge");
  }, 30000);

  test("complete --merge refusal detail names release-merge [.sh T7]", () => {
    const proj = setupForkedProject("hm7");
    expect(bolt(proj, ["hold-merge", "--slug", "hm7"]).status).toBe(0);
    const r = bolt(proj, [
      "complete",
      "--name",
      "Hm7",
      "--batch",
      "1",
      "--merge",
      "--slug",
      "hm7",
    ]);
    expect(r.status).toBe(1);
    // .sh: assert_contains "$OUT" "release-merge".
    expect(r.out).toContain("release-merge");
  }, 30000);

  test("complete --merge refusal does NOT emit BOLT_COMPLETED [.sh T8]", () => {
    const proj = setupForkedProject("hm8");
    expect(bolt(proj, ["hold-merge", "--slug", "hm8"]).status).toBe(0);
    const r = bolt(proj, [
      "complete",
      "--name",
      "Hm8",
      "--batch",
      "1",
      "--merge",
      "--slug",
      "hm8",
    ]);
    expect(r.status).toBe(1);
    // §6-E: the refusal path's negative event-suppression contract. The .sh
    // grepped main audit.md for `^**Event**: BOLT_COMPLETED`. The refusal fires
    // BEFORE the BOLT_COMPLETED emit (aidlc-bolt.ts:336 < :354), so no such row
    // exists in main audit.md.
    const audit = readFileSync(join(proj, "aidlc-docs", "audit.md"), "utf-8");
    expect(
      audit.split("\n").some((l) => l === "**Event**: BOLT_COMPLETED"),
    ).toBe(false);
  }, 30000);

  test("complete --merge proceeds (exit 0) after release-merge [.sh T9]", () => {
    const proj = setupForkedProject("hm9");
    expect(bolt(proj, ["hold-merge", "--slug", "hm9"]).status).toBe(0);
    expect(bolt(proj, ["release-merge", "--slug", "hm9"]).status).toBe(0);
    const r = bolt(proj, [
      "complete",
      "--name",
      "Hm9",
      "--batch",
      "1",
      "--merge",
      "--slug",
      "hm9",
    ]);
    // .sh: assert_eq "$RC" "0" — the hold is cleared, the full merge pipeline
    // (state-merge / audit-merge / fragment-merge) runs to completion.
    expect(r.status).toBe(0);
    // Positive complement to T8: now that the hold lifted, BOLT_COMPLETED IS in
    // main audit.md (the merge pipeline ran).
    const audit = readFileSync(join(proj, "aidlc-docs", "audit.md"), "utf-8");
    expect(
      audit.split("\n").some((l) => l === "**Event**: BOLT_COMPLETED"),
    ).toBe(true);
  }, 60000);

  test("hold-merge errors (exit 1) when forked state absent [.sh T10]", () => {
    // No setup_forked_project here: a plain construction project with NO
    // per-Bolt fork for the slug. setMergeHeld -> forkedStateFilePath returns
    // null -> error() exits 1 (aidlc-bolt.ts:622-627).
    const proj = createTestProject();
    projects.push(proj);
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const r = bolt(proj, ["hold-merge", "--slug", "nonexistent"]);
    // .sh: assert_eq "$RC" "1".
    expect(r.status).toBe(1);
    // STRONGER than the .sh (which only checked the exit code): the error
    // message names the missing forked state file and the start command that
    // would create it.
    expect(r.out).toContain("nonexistent");
  }, 30000);
});
