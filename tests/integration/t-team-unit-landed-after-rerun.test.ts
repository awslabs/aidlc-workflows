// covers: subcommand:aidlc-unit:status, subcommand:aidlc-unit:claim, function:completedUnits
//
// A lead who goes back to an Inception stage and runs Inception forward again
// starts every Construction stage anew: a landed team Unit's UNIT_COMPLETED
// receipts fall below each stage's new run floor, so main's Unit Progress shows
// its stage and gate cells empty while its merged cell stays [x]. The Unit is
// still on main, so the Units that wait on it open, and it is not claimable
// again as a fresh attempt. A Unit that was claimed and never landed is not
// made complete.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveTeamUnitProgressModel } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { readStateFile } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, seededAuditDir, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const STARTED_AT = "2026-08-19T23:00:00Z";
const STARTED_FLOOR = `WORKFLOW_STARTED:${STARTED_AT}#1`;

function commitAndPush(seed: string, message: string): void {
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", message]);
  git(seed, ["push", "origin", "main"]);
}

// alpha lands; beta waits on alpha. The fixture's skeleton is built on main
// without a claim, so a re-run hands it back to main's own walk; it is kept off
// these Units' path (no walking skeleton, nothing depends on it).
const DEPENDENCIES = `# Unit dependencies

\`\`\`yaml
units:
  - name: skeleton
    depends_on: []
  - name: alpha
    depends_on: []
  - name: beta
    depends_on: [alpha]
\`\`\`
`;

function alphaLanded(): { seed: string; remote: string } {
  const { seed, remote } = makeSeed(DEPENDENCIES);
  const statePath = seededStateFile(seed);
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace(
      "- **Unit Ownership**: team\n",
      "- **Unit Ownership**: team\n- **Skeleton Stance**: off\n",
    ),
  );
  writeFileSync(
    join(seededAuditDir(seed), "main-workflow.md"),
    `## Workflow Started\n**Timestamp**: ${STARTED_AT}\n**Event**: WORKFLOW_STARTED\n` +
      "**Stage**: functional-design\n\n---\n",
  );
  commitAndPush(seed, "workflow started");
  prepareCandidate(remote, "alpha", "alpha-team", { runFloor: STARTED_FLOOR });
  gateAndLand(seed, "alpha");
  git(seed, ["push", "origin", "main"]);
  return { seed, remote };
}

// Back to requirements-analysis and forward again: the jump reaches every
// stage after its target, and the delivery-planning approval starts the first
// Unit stage again. The Unit plan's approval rewrites main's Unit Progress
// from the record, as `report --result approved` for units-generation does.
function rerunInception(seed: string): void {
  writeFileSync(
    join(seededAuditDir(seed), "main-rerun.md"),
    "## Stage Jump\n**Timestamp**: 2026-08-20T02:00:00Z\n**Event**: STAGE_JUMPED\n**Direction**: BACKWARD\n" +
      "**Source**: functional-design\n**Target**: requirements-analysis\n**Scope**: feature\n\n---\n" +
      "## Stage Started\n**Timestamp**: 2026-08-20T02:00:00Z\n**Event**: STAGE_STARTED\n**Stage**: requirements-analysis\n\n---\n" +
      "## Stage Started\n**Timestamp**: 2026-08-20T03:00:00Z\n**Event**: STAGE_STARTED\n**Stage**: functional-design\n\n---\n",
  );
  const model = deriveTeamUnitProgressModel(seed, readStateFile(seed));
  const payload = Buffer.from(
    JSON.stringify({ section: model.section, stage_states: model.stageStates }),
  ).toString("base64url");
  const refreshed = runMergeTool(STATE, ["refresh-unit-progress", "--payload", payload], seed, false, {
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  });
  expect(refreshed.status, refreshed.out).toBe(0);
  commitAndPush(seed, "inception run again");
}

function status(checkout: string): {
  claimable: string[];
  claimed: Array<{ unit: string }>;
  waiting: Array<{ unit: string; blockedBy: string[] }>;
} {
  const result = runMergeTool(UNIT, ["status"], checkout);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout);
}

describe("a landed team Unit stays complete when Inception is run again", () => {
  test("the Units that wait on it open, and a team can claim them", () => {
    const { seed, remote } = alphaLanded();
    rerunInception(seed);
    // The record as the report found it: the landed Unit's cells empty, merged kept.
    expect(unitProgressRow(seed, "alpha")).toBe(
      "| alpha | alpha-team | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [x] |",
    );
    const overview = status(seed);
    expect(overview.claimable).toContain("beta");
    expect(overview.claimable).not.toContain("alpha");
    expect(overview.waiting).toEqual([]);

    // The landed Unit is still not claimable as a fresh attempt.
    const other = clone(remote, "alpha-again");
    const again = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team"], other);
    expect(again.status).not.toBe(0);
    expect(again.out).toContain("already complete");

    const team = clone(remote, "beta-team");
    const claimed = runMergeTool(UNIT, ["claim", "beta", "--team", "beta-team"], team);
    expect(claimed.status, claimed.out).toBe(0);
  });

  test("a Unit that was claimed and never landed is not made complete by the re-run", () => {
    const { seed, remote } = makeSeed(DEPENDENCIES);
    const statePath = seededStateFile(seed);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace(
        "- **Unit Ownership**: team\n",
        "- **Unit Ownership**: team\n- **Skeleton Stance**: off\n",
      ),
    );
    writeFileSync(
      join(seededAuditDir(seed), "main-workflow.md"),
      `## Workflow Started\n**Timestamp**: ${STARTED_AT}\n**Event**: WORKFLOW_STARTED\n` +
        "**Stage**: functional-design\n\n---\n",
    );
    commitAndPush(seed, "workflow started");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team"], clone(remote, "alpha-team"));
    expect(claimed.status, claimed.out).toBe(0);
    git(seed, ["pull", "--ff-only"]);
    rerunInception(seed);
    const overview = status(seed);
    expect(overview.claimed.map((claim) => claim.unit)).toEqual(["alpha"]);
    expect(overview.claimable).not.toContain("beta");
    expect(overview.waiting).toEqual([{ unit: "beta", blockedBy: ["alpha"] }]);
  });

  test("a Unit plan run again without the landed Unit reads its status", () => {
    const { seed } = alphaLanded();
    rerunInception(seed);
    writeFileSync(
      join(seededRecordDir(seed), "inception", "units-generation", "unit-of-work-dependency.md"),
      DEPENDENCIES.replace("  - name: alpha\n    depends_on: []\n", "").replace("[alpha]", "[]"),
    );
    commitAndPush(seed, "plan without alpha");
    const overview = status(seed);
    expect(overview.claimable).toContain("beta");
    expect(overview.claimable).not.toContain("alpha");
  });
});
