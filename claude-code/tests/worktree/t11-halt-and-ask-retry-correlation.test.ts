// covers: subcommand:aidlc-worktree:info, subcommand:aidlc-bolt:fail
//
// CLI-contract port of tests/worktree/t11-halt-and-ask-retry-correlation.sh
// (TAP plan 6), mechanism = cli. The .sh pins the round-4 final-pass-critic
// concern that retry-then-fail must NOT mutate the rendered worktree path:
// `aidlc-worktree info --slug r` must return the SAME path across multiple
// BOLT_FAILED emissions for the same slug, with exactly ONE WORKTREE_CREATED
// in the audit (Retry re-runs in place per SKILL.md's per-Bolt loop — the
// orchestrator does NOT call `aidlc-worktree create` again on retry).
//
// Flow (mirrors the .sh setup at l34-72):
//   create worktree (slug r) → fail #1 → info → fail #2 (same slug, no new
//   create) → info → assert path identical + audit invariants.
//
// MECHANISM: this is a .cli twin — every observable is taken at the PROCESS
// boundary. `aidlc-worktree info` parses the latest WORKTREE_CREATED audit
// block, writes JSON to STDOUT via console.log, and process.exit(1)s on a
// miss (aidlc-worktree.ts:672-723). `aidlc-bolt fail` emits a BOLT_FAILED
// audit row through appendAuditEntry (aidlc-bolt.ts:457-483). `aidlc-worktree
// create` runs REAL `git worktree add` after the audit-of-intent emit
// (aidlc-worktree.ts:156-214). The retry-in-place invariant + the on-disk
// audit accumulation are genuine side-effects of running the real binaries
// against real git; an in-process twin would lose the process-exit seam and
// the multi-spawn audit-accumulation contract. So SPAWN the real tools via
// spawnSync(BUN, [TOOL, ...]) and assert on the audit.md bytes + the info JSON.
//
// FIXTURE: aidlc-worktree.ts asserts it runs from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts:162) and runs real git, so the
// case needs an ACTUAL git repo on `main` with one commit plus an aidlc-docs/
// dir. setupWorktreeFixture (tests/harness/fixtures.ts) builds exactly that;
// the tools are spawned with cwd = the fixture so `git rev-parse
// --show-toplevel` resolves to the main checkout. cleanupWorktreeFixture
// prunes the child worktree then rm -rf's the parent. Nothing is written under
// tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named expect):
//   .sh test 1 (l42) first info hit returns a path
//        -> "1: first info hit returns a path" (STRONGER: JSON .path is a
//           non-empty string ending in .../bolt-r, not just substring `"path":`)
//   .sh test 2 (l52) info returns the SAME path across retry attempts
//        -> "2: info returns the SAME path across retry attempts" (same: PATH1
//           === PATH2, parsed from JSON not sed)
//   .sh test 3 (l57) exactly one WORKTREE_CREATED event
//        -> "3: exactly one WORKTREE_CREATED event (retry does not re-create)"
//   .sh test 4 (l63) two BOLT_FAILED events
//        -> "4: two BOLT_FAILED events (one per retry attempt)"
//   .sh test 5 (l66) worktree preserved across multiple failures
//        -> "5: worktree preserved on disk across multiple failures"
//   .sh test 6 (l72) Bolt slug field on every emit (1 WORKTREE_CREATED + 2
//        BOLT_FAILED = 3 `**Bolt slug**: r` lines)
//        -> "6: Bolt slug field on every emit (1 WORKTREE_CREATED + 2 BOLT_FAILED)"
//
// 6 .sh asserts -> 6 test() cases. The two info reads + the create happen once
// in beforeAll so the retry-in-place sequence is exercised exactly as the .sh
// staged it (no per-test re-fork that would mask a re-create regression).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const WT_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const BOLT_TOOL = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");

const SLUG = "r";

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(tool: string, args: string[], cwd: string): CliResult {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", cwd], {
    cwd,
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");
const wtPath = (p: string): string =>
  join(p, ".aidlc", "worktrees", `bolt-${SLUG}`);
const auditText = (p: string): string =>
  existsSync(auditPath(p)) ? readFileSync(auditPath(p), "utf-8") : "";

/** Count audit blocks emitting `event` — `**Event**: <event>` lines. */
function eventCount(p: string, event: string): number {
  return auditText(p)
    .split("\n")
    .filter((l) => l === `**Event**: ${event}`).length;
}

/** Parse the `path` field out of `aidlc-worktree info`'s JSON stdout. */
function infoPath(res: CliResult): string {
  return JSON.parse(res.stdout.trim()).path as string;
}

let fixture: string;
let info1: CliResult;
let info2: CliResult;

beforeAll(() => {
  fixture = setupWorktreeFixture();

  // --- Setup: create the worktree once (the only WORKTREE_CREATED). ---
  const created = run(
    WT_TOOL,
    ["create", "--slug", SLUG, "--base", "main"],
    fixture,
  );
  expect(created.status).toBe(0);

  // --- Failure 1 + info read #1 ---
  run(
    BOLT_TOOL,
    ["fail", "--name", "Retry Bolt", "--slug", SLUG, "--error", "first failure"],
    fixture,
  );
  info1 = run(WT_TOOL, ["info", "--slug", SLUG], fixture);

  // --- Retry semantics: re-run inside the EXISTING worktree. The
  //     orchestrator does NOT call `aidlc-worktree create` again on retry
  //     (SKILL.md per-Bolt loop). Failure 2: same slug, same worktree. ---
  run(
    BOLT_TOOL,
    ["fail", "--name", "Retry Bolt", "--slug", SLUG, "--error", "second failure"],
    fixture,
  );
  info2 = run(WT_TOOL, ["info", "--slug", SLUG], fixture);
});

afterAll(() => {
  cleanupWorktreeFixture(fixture);
});

describe("t11 halt-and-ask retry correlation (migrated from t11-halt-and-ask-retry-correlation.sh, plan 6)", () => {
  test("1: first info hit returns a path [.sh test 1]", () => {
    // .sh: assert_contains "$INFO1" '"path":'. STRONGER — info exited 0 and
    // its JSON .path is a non-empty string resolving the slug's worktree.
    expect(info1.status).toBe(0);
    const p1 = infoPath(info1);
    expect(typeof p1).toBe("string");
    expect(p1.length).toBeGreaterThan(0);
    expect(p1.endsWith(join(".aidlc", "worktrees", `bolt-${SLUG}`))).toBe(true);
  });

  test("2: info returns the SAME path across retry attempts [.sh test 2]", () => {
    // The round-4 final-pass-critic concern: retry must not mutate the
    // rendered worktree path. Parse both JSONs and compare .path directly.
    expect(info2.status).toBe(0);
    expect(infoPath(info1)).toBe(infoPath(info2));
  });

  test("3: exactly one WORKTREE_CREATED event (retry does not re-create) [.sh test 3]", () => {
    // .sh: grep -c "Event.*WORKTREE_CREATED" == 1.
    expect(eventCount(fixture, "WORKTREE_CREATED")).toBe(1);
  });

  test("4: two BOLT_FAILED events (one per retry attempt) [.sh test 4]", () => {
    // .sh: grep -c "Event.*BOLT_FAILED" == 2.
    expect(eventCount(fixture, "BOLT_FAILED")).toBe(2);
  });

  test("5: worktree preserved on disk across multiple failures [.sh test 5]", () => {
    // .sh: assert_dir_exists .aidlc/worktrees/bolt-r — preservation invariant:
    // failure (halt-and-ask default) never tears the worktree down.
    expect(existsSync(wtPath(fixture))).toBe(true);
  });

  test("6: Bolt slug field on every emit (1 WORKTREE_CREATED + 2 BOLT_FAILED) [.sh test 6]", () => {
    // .sh: grep -c "Bolt slug.*r$" == 3 — every halt-and-ask-correlation emit
    // (the WORKTREE_CREATED + both BOLT_FAILED) carries `**Bolt slug**: r` for
    // doctor/AUQ correlation. STRONGER — match the exact field line, not a
    // loose `.*r$` regex that could also match a `Worktree path` ending in
    // `bolt-r`.
    const slugLines = auditText(fixture)
      .split("\n")
      .filter((l) => l === `**Bolt slug**: ${SLUG}`).length;
    expect(slugLines).toBe(3);
  });
});
