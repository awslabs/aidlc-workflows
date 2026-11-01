// covers: subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land
//
// A claimed clone stamps every receipt with the run floor it reads from the
// whole audit record: the workflow's own rows on main (WORKFLOW_STARTED among
// them) and its own. The Unit's candidate carries only its own shard, so pin
// must read the receipts against the record this checkout holds, not against
// the transported rows alone.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { seededAuditDir } from "../harness/fixtures.ts";
import {
  UNIT,
  approveMerge,
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const STARTED_AT = "2026-08-19T23:00:00Z";
// The floor a clone reads once the record carries the workflow's start.
const STARTED_FLOOR = `WORKFLOW_STARTED:${STARTED_AT}#1`;

// Every real record carries its workflow's start on main; the fixture seed
// does not, so the floor it implies is the one of a record with no rows.
function startWorkflowOnMain(seed: string): void {
  writeFileSync(
    join(seededAuditDir(seed), "main-workflow.md"),
    `## Workflow Started\n**Timestamp**: ${STARTED_AT}\n**Event**: WORKFLOW_STARTED\n` +
      "**Stage**: functional-design\n\n---\n",
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "workflow started"]);
  git(seed, ["push", "origin", "main"]);
}

describe("pin reads receipts against the run floor of the whole audit record", () => {
  test("receipts stamped with the record's run floor pin, gate and land", () => {
    const { seed, remote } = makeSeed();
    startWorkflowOnMain(seed);
    prepareCandidate(remote, "alpha", "alpha-team", { runFloor: STARTED_FLOOR });
    gateAndLand(seed, "alpha");
    expect(unitProgressRow(seed, "alpha")).toBe(
      "| alpha | alpha-team | [x] | [x] | [x] | [x] | [x] | [x] | [x] |",
    );
  });

  test("receipts below the record's run floor are not evidence", () => {
    const { seed, remote } = makeSeed();
    startWorkflowOnMain(seed);
    // Stamped as if the record had never started: below the floor main holds.
    prepareCandidate(remote, "alpha", "alpha-team");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status).not.toBe(0);
    expect(pin.out).toContain("UNIT_COMPLETED receipts");
  });

  test("a stray audit file in the landing checkout is named as that at land", () => {
    const { seed, remote } = makeSeed();
    startWorkflowOnMain(seed);
    prepareCandidate(remote, "alpha", "alpha-team", { runFloor: STARTED_FLOOR });
    approveMerge(seed, "alpha");
    // A later workflow start would move the floor the evidence is read against.
    writeFileSync(
      join(seededAuditDir(seed), "stray.md"),
      "## Workflow Started\n**Timestamp**: 2026-08-19T23:30:00Z\n**Event**: WORKFLOW_STARTED\n" +
        "**Stage**: functional-design\n\n---\n",
    );
    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("requires a clean source worktree");
    expect(landed.out).toContain("stray.md");
  });
});
