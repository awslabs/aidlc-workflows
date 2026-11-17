// covers: subcommand:aidlc-swarm:check, subcommand:aidlc-swarm:finalize
//
// A side-by-side Unit's check runs the project's approved command under a time
// limit: 30 minutes unless --timeout-ms sets another. A run the limit stops is
// said as stopped, with the flag that gives it longer, never as a failing
// project check: once by `check`, and once by `finalize` for a Unit claimed as
// converged. A limit that is not a whole number of milliseconds is refused.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupCheckpointFixtures, fixture, prepare, reviewRevisedSource, swarm, wt,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

// A check that takes a few seconds in either shell checkConverged picks
// (cmd.exe on Windows, bash elsewhere), then passes on the Unit's code.
const SLOW = process.platform === "win32"
  ? "ping -n 4 127.0.0.1 > NUL && git diff --check"
  : "sleep 3 && git diff --check";
const LIMIT = "500";

function prepared(): string {
  const pd = fixture(["alpha"], SLOW);
  const result = prepare(pd);
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  writeFileSync(join(wt(pd), "src", "alpha.ts"), "export const alpha = 2;\n");
  return pd;
}

describe("a side-by-side Unit's check under its time limit", () => {
  test("check says a run its limit stopped was stopped, and takes a longer limit", () => {
    const pd = prepared();
    const stopped = swarm(pd, ["check", "alpha", "--timeout-ms", LIMIT]);
    expect(stopped.code, `${stopped.out}\n${stopped.err}`).toBe(1);
    const verdict = JSON.parse(stopped.out.trim());
    expect(verdict).toMatchObject({ unit: "alpha", converged: false, tampered: false, reason: "error" });
    expect(verdict.detail).toContain("the check command was stopped after 500 ms, before it finished");
    expect(verdict.detail).toContain("so this is no verdict on the Unit's code");
    expect(verdict.detail).toContain("run check again with --timeout-ms <milliseconds>");

    for (const bad of ["0", "abc", "1.5", "2147483648"]) {
      const refused = swarm(pd, ["check", "alpha", "--timeout-ms", bad]);
      expect(refused.code, bad).not.toBe(0);
      expect(`${refused.out}${refused.err}`, bad)
        .toContain("--timeout-ms must be an integer between 1 and 2147483647 milliseconds.");
    }

    const passed = swarm(pd, ["check", "alpha"]);
    expect(passed.code, `${passed.out}\n${passed.err}`).toBe(0);
    expect(JSON.parse(passed.out.trim())).toMatchObject({ unit: "alpha", converged: true, reason: null });
    expect(passed.out).not.toContain("detail");
  });

  test("finalize says a re-verify its limit stopped was stopped", () => {
    const pd = prepared();
    reviewRevisedSource(pd);
    const finalized = swarm(pd, [
      "finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha", "--timeout-ms", LIMIT,
    ]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).not.toBe(0);
    const row = JSON.parse(finalized.out).units[0];
    expect(row).toMatchObject({ unit: "alpha", status: "failed", reason: "error" });
    expect(row.detail).toBe(
      "claimed converged, but on re-verify the check command was stopped after 500 ms, before it finished, " +
        "so this is no verdict on the Unit's code; run finalize again with --timeout-ms <milliseconds> to give it longer",
    );
  });
});
