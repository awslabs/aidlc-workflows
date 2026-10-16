// covers: subcommand:aidlc-bolt:hold-merge, subcommand:aidlc-bolt:release-merge, subcommand:aidlc-bolt:complete
//
// t82 - aidlc-bolt.ts HOLD-MERGE invariant tooling.
//
// Mechanism: cli. Every assertion is a process-boundary contract:
//   - `hold-merge` / `release-merge` mutate the per-Bolt FORKED state file at
//     the intent-scoped worktree's mirrored record and print a
//     JSON envelope to stdout, then return (handleHoldMerge / handleReleaseMerge,
//     aidlc-bolt.ts).
//   - `complete --merge` refuses with process.exit(1) + a {ok:false,
//     reason:"merge-held", ...} envelope when the marker is set (failJson,
//     aidlc-bolt.ts), and proceeds (exit 0) once released.
//   - the refusal path must NOT emit BOLT_COMPLETED into the main audit shards.
// The setup itself (`start --worktree --slug`) FANS OUT to sibling tools
// (aidlc-state fork / aidlc-audit audit-fork / aidlc-runtime fragment-fork via
// spawnSibling) to materialise the forked state file - that multi-process fork
// chain plus the process.exit refusal seam is exactly what an in-process
// import twin would lose, so this is spawned end-to-end.
//
// Source under test (dist/claude/.claude/tools/aidlc-bolt.ts):
//   handleHoldMerge(args)    -> setMergeHeld(pd, slug, true);
//                                     console.log({slug, merge_held:true})
//   handleReleaseMerge(args) -> setMergeHeld(pd, slug, false);
//                                     console.log({slug, merge_held:false})
//   setMergeHeld(pd, slug, held) -> errors (exit 1 via error()) when the
//        forked state file is absent; else, when the value changes,
//        setOrInsertField under "## Project Information" writes
//        `- **Merge-Held**: true|false`.
//   handleComplete: if (isMergeHeld(pd, slug)) failJson("complete-merge",
//        slug, "merge-held", "...run `aidlc-bolt release-merge --slug <slug>`
//        before retrying.") - refusal fires BEFORE the BOLT_COMPLETED emit,
//        so no audit row is written on refusal.
//   isMergeHeld -> getField(content, "Merge-Held") === "true".
//
// Forked state lives in the per-intent record mirrored below worktreePath(pd,id8,slug).
//
// T3 asserts the parsed envelope object ({slug, merge_held:true});
// idempotency of hold-merge / release-merge (second call same outcome) is
// also exercised inside T1/T2 setup implicitly and asserted explicitly in T1.

import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { worktreePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  fixtureIntentId8,
  AIDLC_SRC,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedAuditFile,
  seedStateFile,
  seededAuditDir,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

resetAidlcEnv();

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const STATE_FIXTURE = join(FIXTURES_DIR, "state-construction.md");

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

interface BoltResult {
  status: number;
  out: string; // combined stdout+stderr
}

function bolt(proj: string, args: string[]): BoltResult {
  const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/**
 * A construction-state project with a forked Bolt at <slug> ready for
 * hold-merge tests. `start --worktree --slug` fans out to state-fork /
 * audit-fork / fragment-fork, materialising the forked state file. Returns the
 * project dir (registered for teardown).
 */
function setupForkedProject(slug: string): string {
  const proj = createTestProject();
  projects.push(proj);
  seedStateFile(proj, STATE_FIXTURE);
  seedAuditFile(proj);
  mkdirSync(worktreePath(proj, fixtureIntentId8(proj), slug), {
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
  // Guard the precondition: the fork chain succeeded and the forked state file
  // exists. A broken fixture must fail loudly here, not as a misleading red in a
  // downstream behavioural assertion.
  expect(r.status).toBe(0);
  expect(existsSync(forkedState(proj, slug))).toBe(true);
  return proj;
}

/** The per-Bolt forked state file the hold-merge marker is written into — the
 *  worktree mirror carries the SAME relative record dir as the main checkout
 *  (aidlc/spaces/default/intents/<record>/aidlc-state.md), not flat aidlc-docs/. */
function forkedState(proj: string, slug: string): string {
  return join(worktreePath(proj, fixtureIntentId8(proj), slug), "aidlc",
  "spaces",
  DEFAULT_SPACE,
  "intents",
  DEFAULT_RECORD_DIR,
  "aidlc-state.md",);
}

/** Concatenate every main audit shard (audit/*.md) - the tools write into the
 *  shard seedAuditFile seeded (the fixture pins the clone id), so one read
 *  covers both. */
function readAudit(proj: string): string {
  const dir = seededAuditDir(proj);
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
}

describe("t82 aidlc-bolt HOLD-MERGE invariant (migrated from t82-hold-merge-invariant.sh, plan 10)", () => {
  test("hold-merge sets `- **Merge-Held**: true` in forked state [.sh T1]", () => {
    const proj = setupForkedProject("hm1");
    const r1 = bolt(proj, ["hold-merge", "--slug", "hm1"]);
    expect(r1.status).toBe(0);
    const body = readFileSync(forkedState(proj, "hm1"), "utf-8");
    expect(body.split("\n").some((l) => l === "- **Merge-Held**: true")).toBe(
      true,
    );
    // hold-merge is idempotent (second call same outcome). A re-run stays exit 0
    // with the marker still true and no duplicate field line.
    const r2 = bolt(proj, ["hold-merge", "--slug", "hm1"]);
    expect(r2.status).toBe(0);
    const body2 = readFileSync(forkedState(proj, "hm1"), "utf-8");
    const trueLines = body2
      .split("\n")
      .filter((l) => l === "- **Merge-Held**: true").length;
    expect(trueLines).toBe(1);
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

  test("release-merge sets `- **Merge-Held**: false` in forked state [.sh T2]", () => {
    const proj = setupForkedProject("hm2");
    expect(bolt(proj, ["hold-merge", "--slug", "hm2"]).status).toBe(0);
    const rel = bolt(proj, ["release-merge", "--slug", "hm2"]);
    expect(rel.status).toBe(0);
    const body = readFileSync(forkedState(proj, "hm2"), "utf-8");
    expect(body.split("\n").some((l) => l === "- **Merge-Held**: false")).toBe(
      true,
    );
    expect(body.includes("- **Merge-Held**: true")).toBe(false);
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

  test("hold-merge stdout envelope carries slug + merge_held:true [.sh T3]", () => {
    const proj = setupForkedProject("hm3");
    const r = bolt(proj, ["hold-merge", "--slug", "hm3"]);
    expect(r.status).toBe(0);
    const line = r.out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("{") && l.includes('"slug"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string);
    expect(parsed).toEqual({ slug: "hm3", merge_held: true });
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

  test("release-merge stdout envelope reports merge_held:false [.sh T4]", () => {
    const proj = setupForkedProject("hm4");
    const r = bolt(proj, ["release-merge", "--slug", "hm4"]);
    expect(r.status).toBe(0);
    expect(r.out.replace(/\s/g, "")).toContain('"merge_held":false');
    const line = r.out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("{") && l.includes('"merge_held"'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string);
    expect(parsed).toEqual({ slug: "hm4", merge_held: false });
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

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
    expect(r.status).toBe(1);
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

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
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

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
    expect(r.out).toContain("release-merge");
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

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
    // Section 6-E: the refusal path's negative event-suppression contract. The
    // refusal fires BEFORE the BOLT_COMPLETED emit (aidlc-bolt.ts handleComplete),
    // so no such row exists in the main audit shards.
    const audit = readAudit(proj);
    expect(
      audit.split("\n").some((l) => l === "**Event**: BOLT_COMPLETED"),
    ).toBe(false);
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

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
    // The hold is cleared, the full merge pipeline (state-merge / audit-merge /
    // fragment-merge) runs to completion.
    expect(r.status).toBe(0);
    // Positive complement to T8: now that the hold lifted, BOLT_COMPLETED IS in
    // main audit shards (the merge pipeline ran).
    const audit = readAudit(proj);
    expect(
      audit.split("\n").some((l) => l === "**Event**: BOLT_COMPLETED"),
    ).toBe(true);
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

  test("hold-merge errors (exit 1) when forked state absent [.sh T10]", () => {
    // No setupForkedProject here: a plain construction project with NO
    // per-Bolt fork for the slug. setMergeHeld -> forkedState returns
    // null -> error() exits 1 (aidlc-bolt.ts).
    const proj = createTestProject();
    projects.push(proj);
    seedStateFile(proj, STATE_FIXTURE);
    seedAuditFile(proj);
    const r = bolt(proj, ["hold-merge", "--slug", "nonexistent"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("nonexistent");
  }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
});
