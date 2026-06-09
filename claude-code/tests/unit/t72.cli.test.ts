// covers: subcommand:aidlc-worktree:info
//
// SPIKE (WF-D): bun:test port of tests/unit/t72-worktree-info.sh (TAP plan 10),
// mechanism = cli. This is the consistency play the user asked for — replace the
// .sh with a .test.ts of EQUAL fidelity by spawning the real CLI via
// node:child_process, rather than a weaker .none import-twin.
//
// t72 is a pure CLI-contract test: `aidlc-worktree info --slug <s> --project-dir <p>`
// reads aidlc-docs/audit.md, scans WORKTREE_CREATED blocks end-to-start, and emits
// JSON on a hit / exits non-zero with a stderr message on miss-or-malformed. The
// contract under test is the PROCESS boundary (exit code + stdout JSON + stderr
// text), so it stays a spawn — calling handleInfo() in-process would lose the
// exit-code and stderr-stream half of the contract. As a .cli-mechanism file it
// legitimately credits the `aidlc-worktree info` subcommand unit (minMechanism:
// cli) that a .none twin could not.
//
// FIXTURE DISCIPLINE: each case writes a fresh audit.md under mkdtempSync(tmpdir())
// and removes it after. NOTHING is written under tests/fixtures/**.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath; // the bun running this test
const TOOL = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "tools",
  "aidlc-worktree.ts",
);

// --- per-case temp project harness ----------------------------------------
let projDir = "";
function writeAudit(content: string): void {
  mkdirSync(join(projDir, "aidlc-docs"), { recursive: true });
  writeFileSync(join(projDir, "aidlc-docs", "audit.md"), `${content}\n`, "utf-8");
}
function runInfo(slug: string): { rc: number; out: string } {
  // Combine stdout+stderr like the .sh's `2>&1`, and run with cwd=projDir +
  // --project-dir (the .sh passed both; --project-dir is the authoritative seam).
  const res = spawnSync(BUN, [TOOL, "info", "--slug", slug, "--project-dir", projDir], {
    encoding: "utf-8",
    cwd: projDir,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}
beforeEach(() => {
  projDir = mkdtempSync(join(tmpdir(), "t72-cli-"));
});
afterEach(() => {
  if (projDir) rmSync(projDir, { recursive: true, force: true });
  projDir = "";
});

// --- Tests 1-4: hit returns expected JSON shape and field values ----------
describe("t72 info: hit returns expected JSON", () => {
  beforeEach(() => {
    writeAudit(`# AI-DLC Audit Log

## Worktree Created
**Timestamp**: 2026-05-18T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-onboarding
**Worktree path**: /tmp/proj/.aidlc/worktrees/bolt-onboarding
**Branch name**: bolt-onboarding
**Base branch**: main

---`);
  });

  test("info exits 0 on hit", () => {
    expect(runInfo("bolt-onboarding").rc).toBe(0);
  });
  test("info JSON includes slug", () => {
    expect(runInfo("bolt-onboarding").out).toContain('"slug":"bolt-onboarding"');
  });
  test("info JSON includes path", () => {
    expect(runInfo("bolt-onboarding").out).toContain(
      '"path":"/tmp/proj/.aidlc/worktrees/bolt-onboarding"',
    );
  });
  test("info JSON includes branch_name", () => {
    expect(runInfo("bolt-onboarding").out).toContain('"branch_name":"bolt-onboarding"');
  });
});

// --- Tests 5-6: multiple WORKTREE_CREATED for same slug -> most-recent -----
describe("t72 info: most-recent block on duplicate slug", () => {
  beforeEach(() => {
    writeAudit(`# AI-DLC Audit Log

## Worktree Created
**Timestamp**: 2026-05-18T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-x
**Worktree path**: /tmp/old-path
**Branch name**: bolt-x
**Base branch**: main

---

## Worktree Created
**Timestamp**: 2026-05-18T11:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-x
**Worktree path**: /tmp/new-path
**Branch name**: bolt-x
**Base branch**: main

---`);
  });

  test("info exits 0 with multiple matching blocks", () => {
    expect(runInfo("bolt-x").rc).toBe(0);
  });
  test("info returns most-recent path (end-to-start scan)", () => {
    expect(runInfo("bolt-x").out).toContain('"path":"/tmp/new-path"');
  });
});

// --- Tests 7-8: missing slug exits non-zero with stderr message -----------
describe("t72 info: missing slug", () => {
  beforeEach(() => {
    writeAudit(`# AI-DLC Audit Log

## Worktree Created
**Timestamp**: 2026-05-18T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-other
**Worktree path**: /tmp/other
**Branch name**: bolt-other
**Base branch**: main

---`);
  });

  test("info exits non-zero on missing slug", () => {
    expect(runInfo("bolt-missing").rc).not.toBe(0);
  });
  test("info stderr names the missing slug", () => {
    expect(runInfo("bolt-missing").out).toContain(
      "no WORKTREE_CREATED audit entry for slug bolt-missing",
    );
  });
});

// --- Tests 9-10: malformed block (missing Worktree path) exits non-zero ---
describe("t72 info: malformed block", () => {
  beforeEach(() => {
    writeAudit(`# AI-DLC Audit Log

## Worktree Created
**Timestamp**: 2026-05-18T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-broken
**Branch name**: bolt-broken
**Base branch**: main

---`);
  });

  test("info exits non-zero on malformed block (missing Worktree path)", () => {
    expect(runInfo("bolt-broken").rc).not.toBe(0);
  });
  test("info stderr flags malformed block", () => {
    expect(runInfo("bolt-broken").out).toContain("malformed WORKTREE_CREATED block");
  });
});
