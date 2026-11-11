// covers: function:subagentInflightMarkerPath, function:markSubagentInflight
//
// t-subagent-inflight-ignored - the background-helper ledger stays out of git.
// While a helper the agent sent in the background runs, the dispatch hook keeps
// a ledger entry for it. The ledger lives in AI-DLC's git-ignored sessions
// folder, so `git status` never lists it and a `git add -A` at that moment
// cannot commit it, with the ignore block every harness ships. A ledger an
// older version left at its old place (`aidlc/.aidlc-subagent-inflight`, which
// no shipped block ignores) is taken in by the next locked read: a malformed
// one is dropped, so it never stops a new dispatch from being recorded.
//
// Mechanism: none. In-process ledger calls against temp projects, with git run
// on each one to ask whether the shipped ignore block covers the ledger.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  markSubagentInflight,
  sessionsDir,
  subagentInflightMarkerPath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// Where earlier releases kept the ledger.
const OLD_PLACE = (proj: string): string => join(proj, "aidlc", ".aidlc-subagent-inflight");

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function project(): string {
  const proj = createTestProject();
  created.push(proj);
  return proj;
}

function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "" };
}

function ledgerEntries(proj: string): Array<{ sessionId: string | null; startedAtMs: number }> {
  return (JSON.parse(readFileSync(subagentInflightMarkerPath(proj), "utf-8")) as {
    entries: Array<{ sessionId: string | null; startedAtMs: number }>;
  }).entries;
}

describe("t-subagent-inflight-ignored: the background-helper ledger stays out of git", () => {
  test("the ledger lives in aidlc/.aidlc-sessions/ and every harness's shipped ignore block keeps it out of git", () => {
    expect(HARNESS_MATRIX.length).toBeGreaterThanOrEqual(7);
    for (const { name: harness } of HARNESS_MATRIX) {
      const proj = project();
      expect(git(proj, ["init", "-q"]).status, `${harness}: git init`).toBe(0);
      writeFileSync(
        join(proj, ".gitignore"),
        readFileSync(join(REPO_ROOT, "dist", harness, ".gitignore"), "utf-8"),
        "utf-8",
      );

      expect(markSubagentInflight(proj, "helper-session"), harness).toBe(true);
      const ledger = subagentInflightMarkerPath(proj);
      expect(existsSync(ledger), harness).toBe(true);
      expect(relative(sessionsDir(proj), ledger).startsWith(".."), `${harness}: ${ledger}`).toBe(false);
      expect(existsSync(OLD_PLACE(proj)), harness).toBe(false);

      const shown = relative(proj, ledger).replaceAll("\\", "/");
      expect(git(proj, ["check-ignore", "-q", shown]).status, `${harness}: ${shown} is ignored`).toBe(0);
      const listed = git(proj, ["status", "--porcelain", "--untracked-files=all"]).stdout
        .split("\n")
        .filter((line) => line.includes("inflight"));
      expect(listed, `${harness}: git status`).toEqual([]);
    }
  });

  test("a malformed ledger an older version left at the old place is dropped, and a new dispatch is recorded", () => {
    const proj = project();
    mkdirSync(join(proj, "aidlc"), { recursive: true });
    writeFileSync(OLD_PLACE(proj), "{malformed", "utf-8");

    expect(markSubagentInflight(proj, "helper-session")).toBe(true);
    expect(existsSync(OLD_PLACE(proj))).toBe(false);
    expect(ledgerEntries(proj).map((entry) => entry.sessionId)).toEqual(["helper-session"]);
  });
});
