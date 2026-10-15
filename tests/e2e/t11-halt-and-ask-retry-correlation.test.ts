// covers: subcommand:aidlc-worktree:info, subcommand:aidlc-bolt:fail
//
// Retry-then-fail must NOT mutate the rendered worktree path:
// `aidlc-worktree info --slug r` must return the SAME path across multiple
// BOLT_FAILED emissions for the same slug, with exactly ONE WORKTREE_CREATED
// in the audit (Retry re-runs in place; the test does NOT call `aidlc-worktree
// create` again on retry).
//
// Flow:
//   create worktree (slug r) → fail #1 → info → fail #2 (same slug, no new
//   create) → info → assert path identical + audit invariants.
//
// MECHANISM: every observable is taken at the PROCESS boundary.
// `aidlc-worktree info` parses the latest WORKTREE_CREATED audit
// block, writes JSON to STDOUT via console.log, and process.exit(1)s on a
// miss (aidlc-worktree.ts). `aidlc-bolt fail` emits a BOLT_FAILED
// audit row through appendAuditEntry (aidlc-bolt.ts). `aidlc-worktree
// create` runs REAL `git worktree add` after the audit-of-intent emit
// (aidlc-worktree.ts). The retry-in-place invariant + the on-disk
// audit accumulation are genuine side-effects of running the real binaries
// against real git; an in-process twin would lose the process-exit seam and
// the multi-spawn audit-accumulation contract. So SPAWN the real tools via
// spawnSync(BUN, [TOOL, ...]) and assert on the audit shard bytes + the info
// JSON.
//
// FIXTURE: aidlc-worktree.ts asserts it runs from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts) and runs real git, so the
// case needs an ACTUAL git repo on `main` with one commit plus a per-intent
// record. setupWorktreeFixture (tests/harness/fixtures.ts) builds exactly that;
// the tools are spawned with cwd = the fixture so `git rev-parse
// --show-toplevel` resolves to the main checkout. cleanupWorktreeFixture
// prunes the child worktree then rm -rf's the parent. Nothing is written under
// tests/fixtures/**.
//
// The two info reads + the create happen once in beforeAll, so the
// retry-in-place sequence is exercised as one staged run (no per-test re-fork
// that would mask a re-create regression).

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { worktreePath } from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  fixtureIntentId8,
  seededAuditDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", cwd], { timeout: remainingOperationTimeoutMs(NATIVE_FIXTURE_SETUP_TIMEOUT_MS),
    cwd,
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const wtPath = (p: string): string =>
  worktreePath(p, fixtureIntentId8(p), SLUG);
const auditText = (p: string): string => {
  const dir = seededAuditDir(p);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
};

function eventCount(p: string, event: string): number {
  return auditText(p)
    .split("\n")
    .filter((l) => l === `**Event**: ${event}`).length;
}

function infoPath(res: CliResult): string {
  return JSON.parse(res.stdout.trim()).path as string;
}

let fixture: string;
let info1: CliResult;
let info2: CliResult;

beforeAll(() => {
  fixture = setupWorktreeFixture();
  // Put the selected intent in Construction for the retry lifecycle.
  writeFileSync(seededStateFile(fixture), "- **Current Stage**: code-generation\n", "utf-8");

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

  // --- Retry semantics: re-run inside the EXISTING worktree; the test does NOT
  //     call `aidlc-worktree create` again on retry. Failure 2: same slug, same
  //     worktree. ---
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
    expect(info1.status).toBe(0);
    const p1 = infoPath(info1);
    expect(p1).toBe(wtPath(fixture));
  });

  test("2: info returns the SAME path across retry attempts [.sh test 2]", () => {
    // Retry must not mutate the rendered worktree path. Parse both JSONs and
    // compare .path directly.
    expect(info2.status).toBe(0);
    expect(infoPath(info1)).toBe(infoPath(info2));
  });

  test("3: exactly one WORKTREE_CREATED event (retry does not re-create) [.sh test 3]", () => {
    expect(eventCount(fixture, "WORKTREE_CREATED")).toBe(1);
  });

  test("4: two BOLT_FAILED events (one per retry attempt) [.sh test 4]", () => {
    expect(eventCount(fixture, "BOLT_FAILED")).toBe(2);
  });

  test("5: worktree preserved on disk across multiple failures [.sh test 5]", () => {
    // Preservation invariant: the original worktree survives every retry;
    // failure (halt-and-ask default) never tears the worktree down.
    expect(existsSync(wtPath(fixture))).toBe(true);
  });

  test("6: Bolt slug field on every emit (1 WORKTREE_CREATED + 2 BOLT_FAILED) [.sh test 6]", () => {
    // Every halt-and-ask-correlation emit (the WORKTREE_CREATED + both BOLT_FAILED)
    // carries `**Bolt slug**: r` for doctor/AUQ correlation. Match the exact field
    // line, not a loose `.*r$` regex that could also match a Worktree path ending
    // in the slug.
    const slugLines = auditText(fixture)
      .split("\n")
      .filter((l) => l === `**Bolt slug**: ${SLUG}`).length;
    expect(slugLines).toBe(3);
  });
});
