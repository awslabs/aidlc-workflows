// covers: subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land
//
// A claimed clone stamps every receipt with the run floor it reads from the
// whole audit record: the workflow's own rows on main (WORKFLOW_STARTED among
// them) and its own. The Unit's candidate carries only its own shard, so pin
// must read the receipts against main's record as the commit it reads holds
// it, not against the transported rows alone.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  tempDirs,
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


  // A jump on main is a new attempt for each stage it reaches (stageJumpReaches):
  // its Target and every stage after it. The clone reads the same once it pulls.
  function jumpOnMain(seed: string, target: string): void {
    const at = "2026-08-20T02:00:00Z";
    writeFileSync(
      join(seededAuditDir(seed), "main-jump.md"),
      `## Stage Jump\n**Timestamp**: ${at}\n**Event**: STAGE_JUMPED\n**Direction**: BACKWARD\n` +
        `**Source**: ci-pipeline\n**Target**: ${target}\n**Scope**: feature\n\n---\n` +
        `## Stage Started\n**Timestamp**: ${at}\n**Event**: STAGE_STARTED\n**Stage**: ${target}\n\n---\n`,
    );
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", `jump to ${target}`]);
    git(seed, ["push", "origin", "main"]);
  }

  test("a jump on main back to one of the Unit's stages makes that stage owed again", () => {
    const { seed, remote } = makeSeed();
    startWorkflowOnMain(seed);
    prepareCandidate(remote, "alpha", "alpha-team", { runFloor: STARTED_FLOOR });
    jumpOnMain(seed, "code-generation");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status).not.toBe(0);
    expect(pin.out).toContain("UNIT_COMPLETED receipts");
  });

  test("a jump on main that reaches none of the Unit's stages leaves its receipts", () => {
    const { seed, remote } = makeSeed();
    startWorkflowOnMain(seed);
    prepareCandidate(remote, "alpha", "alpha-team", { runFloor: STARTED_FLOOR });
    jumpOnMain(seed, "build-and-test");
    gateAndLand(seed, "alpha");
    expect(unitProgressRow(seed, "alpha")).toBe(
      "| alpha | alpha-team | [x] | [x] | [x] | [x] | [x] | [x] | [x] |",
    );
  });

  test("a land stopped between its merge and its commit finishes when run again", async () => {
    const { seed, remote } = makeSeed();
    startWorkflowOnMain(seed);
    prepareCandidate(remote, "alpha", "alpha-team", { runFloor: STARTED_FLOOR });
    const { pinnedOid } = approveMerge(seed, "alpha");
    // The merge commit's hook holds the first land until it is stopped; the
    // re-run's commit goes through.
    const marks = mkdtempSync(join(tmpdir(), "aidlc-mid-merge-"));
    tempDirs.push(marks);
    const mark = (name: string) => join(marks, name).replaceAll("\\", "/");
    const hook = join(seed, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      "#!/bin/sh\n" +
        '[ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ] || exit 0\n' +
        `[ -f "${mark("merging")}" ] && exit 0\n` +
        `: > "${mark("merging")}"\n` +
        `while [ ! -f "${mark("go")}" ]; do sleep 0.1; done\n` +
        `: > "${mark("done")}"\n` +
        "exit 1\n",
    );
    chmodSync(hook, 0o755);
    const first = Bun.spawn([process.execPath, UNIT, "land", "alpha", "--project-dir", seed], {
      cwd: seed,
      env: {
        ...process.env,
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
        AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
        AIDLC_SKIP_ARTIFACT_GUARD: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    const waitFor = async (done: () => boolean, what: string) => {
      const deadline = Date.now() + 60_000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(50);
      }
    };
    await waitFor(() => existsSync(join(marks, "merging")), "the merge commit");
    first.kill("SIGKILL");
    await first.exited;
    writeFileSync(join(marks, "go"), "");
    await waitFor(() => existsSync(join(marks, "done")), "the hook to let go");
    await waitFor(() => !existsSync(join(seed, ".git", "index.lock")), "git to let go of the index");
    expect(git(seed, ["rev-parse", "MERGE_HEAD"])).toBe(pinnedOid);

    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status, landed.out).toBe(0);
    git(seed, ["merge-base", "--is-ancestor", pinnedOid, "HEAD"]);
    expect(unitProgressRow(seed, "alpha")).toBe(
      "| alpha | alpha-team | [x] | [x] | [x] | [x] | [x] | [x] | [x] |",
    );
  });
});
