// covers: file:tools/aidlc-unit.ts
//
// A clone stamps a receipt after the Unit's own send-back with a run floor
// numbered among every send-back of its stages, main's earlier ones too. Pin
// reads the receipts against main's rows, so it must count main's send-backs
// as the clone did.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditShardName } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededAuditDir } from "../harness/fixtures.ts";
import {
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  prepareCandidate,
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

const LANDED_ROW = "| alpha | alpha-team | [x] | [x] | [x] | [x] | [x] | [x] | [x] |";

describe("pin counts main's earlier send-backs in a Unit's run floor", () => {
  // A gate sent back on main earlier counts toward the floor of the Unit's own
  // send-back: the clone counted it, so pin must too.
  test("receipts after the Unit's own send-back count main's earlier send-backs in their floor", () => {
    const { seed, remote } = makeSeed();
    startWorkflowOnMain(seed);
    const stages = "functional-design, nfr-requirements, nfr-design, infrastructure-design, code-generation";
    appendFileSync(
      join(seededAuditDir(seed), "main-workflow.md"),
      `\n## Gate Rejected\n**Timestamp**: 2026-08-20T00:00:00Z\n**Event**: GATE_REJECTED\n` +
        `**Stage**: functional-design\n**Gate Stages**: ${stages}\n**User Input**: Request Changes\n\n---\n`,
    );
    git(seed, ["commit", "-am", "main's gate sent back"]);
    git(seed, ["push", "origin", "main"]);
    const sentBack = "2026-08-20T00:30:00Z";
    prepareCandidate(remote, "alpha", "alpha-team", {
      afterClaim: (checkout) => {
        appendFileSync(
          join(seededAuditDir(checkout), auditShardName(checkout)),
          `## Gate Rejected\n**Timestamp**: ${sentBack}\n**Event**: GATE_REJECTED\n**Stage**: functional-design\n` +
            `**Unit**: alpha\n**Run floor**: ${STARTED_FLOOR}\n**Attempt Generation**: 1\n` +
            `**Gate Scope**: unit-end\n**Gate Stages**: ${stages}\n**User Input**: Request Changes\n\n---\n`,
        );
      },
      runFloor: `GATE_REJECTED:${sentBack}#2`,
    });
    gateAndLand(seed, "alpha");
    expect(unitProgressRow(seed, "alpha")).toBe(LANDED_ROW);
  });
});
