// covers: subcommand:aidlc-orchestrate:next
//
// When a claimed Unit is complete and approved in the checkout that claimed it,
// the notice says where each step left is taken: publish there, then pin, gate
// and land from a checkout of the project that holds no Unit claim (pin refuses
// a claimed checkout), then pull main there to free it. Both shapes of a
// claimed checkout read the same words, and neither is sent to "unscoped main"
// or "the main checkout": in the project's own checkout that claimed the Unit
// (#3282) the person is already in the project's main checkout.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  appendMainHumanTurn,
  cleanupTempDirs,
  clone,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const DONE =
  'Unit "alpha" is complete and approved in this checkout. Commit the completed candidate and run ' +
  "`aidlc unit publish alpha` here; then pin, gate and land it from a checkout of this project that holds no " +
  "Unit claim (a fresh clone of it). Once it lands, pull main here and this checkout is free again.";

// The claimed checkout with alpha worked through every stage and published,
// Current Stage where the walk leaves it (the Unit's last stage).
function doneIn(checkout: string): Record<string, unknown> {
  writeFileSync(
    seededStateFile(checkout),
    readFileSync(seededStateFile(checkout), "utf-8")
      .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"),
  );
  return nextDirective(checkout);
}

describe("a claimed Unit's end-of-Unit notice says where the rest is done", () => {
  test("in the project's own checkout that claimed the Unit", () => {
    const { seed: lead, remote } = makeSeed();
    // The lead's own checkout: its shard is on main, where Inception ran.
    appendMainHumanTurn(lead);
    git(lead, ["add", "-A"]);
    git(lead, ["commit", "-m", "lead inception audit"]);
    git(lead, ["push", "origin", "main"]);
    prepareCandidate(remote, "alpha", "lead", { checkout: lead });
    expect(doneIn(lead)).toMatchObject({ kind: "notice", message: DONE, unit: "alpha" });
    // What it says is so: this checkout does not pin, a checkout with no claim does.
    expect(runMergeTool(UNIT, ["pin", "alpha"], lead).out).toContain("Unit pinning must run from an unscoped main checkout.");
    const pinned = runMergeTool(UNIT, ["pin", "alpha"], clone(remote, "fresh"));
    expect(pinned.status, pinned.out).toBe(0);
  });

  test("in a team's own clone", () => {
    const { remote } = makeSeed();
    const { checkout } = prepareCandidate(remote, "alpha", "team-a");
    expect(doneIn(checkout)).toMatchObject({ kind: "notice", message: DONE, unit: "alpha" });
  });
});
