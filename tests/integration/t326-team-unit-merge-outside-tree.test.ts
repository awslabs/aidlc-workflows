// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seededAuditDir, seededRecordDir } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

// Pin refuses a candidate that changes a record outside the claimed Unit's
// construction/<unit>/ tree. Publish still publishes it and names those records
// with the way out, once it has put back the shared records AI-DLC itself writes
// (the stages' diaries, the other teams' audit shards), which are not a change
// the team made.

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

function claimTip(checkout: string): string {
  const { claim_ref } = JSON.parse(
    readFileSync(join(checkout, "aidlc", ".aidlc-unit-scope.json"), "utf-8"),
  ) as { claim_ref: string };
  return git(checkout, ["ls-remote", "origin", claim_ref]).split(/\s+/)[0] ?? "";
}

describe("t326 pinned team Unit merge: a record outside the Unit's tree", () => {
  test("publish names an Inception artifact the Unit changed, and pin takes the Unit once it is taken out", () => {
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-team");
    const published = claimTip(candidate.checkout);
    const summary = join(
      seededRecordDir(candidate.checkout),
      "inception",
      "contract-design",
      "contract-summary.md",
    );
    mkdirSync(dirname(summary), { recursive: true });
    writeFileSync(summary, "# contract-summary\n\nchanged by alpha\n");
    git(candidate.checkout, ["add", "-A"]);
    git(candidate.checkout, ["commit", "-m", "alpha edits the contract summary"]);

    const warned = runMergeTool(UNIT, ["publish", "alpha"], candidate.checkout);
    expect(warned.status, warned.out).toBe(0);
    const reply = JSON.parse(warned.stdout) as PublishReply;
    expect(reply.published).toBe(true);
    expect(reply.records_outside_unit_tree).toEqual([
      summary.slice(candidate.checkout.length + 1).replaceAll("\\", "/"),
    ]);
    expect(reply.records_outside_unit_tree_note).toContain("is changed on main");
    expect(reply.records_outside_unit_tree_note).toContain("publish again");
    expect(claimTip(candidate.checkout)).not.toBe(published);
    const refusedPin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(refusedPin.status).not.toBe(0);
    expect(refusedPin.out).toContain("outside claimed Unit record tree");
    // Pin says the same next step as publish's note, in the same words.
    const nextStep = reply.records_outside_unit_tree_note!.replace(
      "Pin will refuse this candidate: ",
      "",
    );
    expect(nextStep).toContain("git checkout origin/main -- <path>");
    expect(refusedPin.out).toContain(`${nextStep[0].toUpperCase()}${nextStep.slice(1)}`);

    git(candidate.checkout, ["rm", "-q", "--", summary]);
    git(candidate.checkout, ["commit", "-m", "leave the contract summary to main"]);
    const republished = runMergeTool(UNIT, ["publish", "alpha"], candidate.checkout);
    expect(republished.status, republished.out).toBe(0);
    expect((JSON.parse(republished.stdout) as PublishReply).records_outside_unit_tree).toBeUndefined();
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });

  test("publish names no shared diary or audit shard it puts back as main has it", () => {
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-team");
    const record = seededRecordDir(candidate.checkout);
    appendFileSync(join(record, "construction", "functional-design", "memory.md"), "\nalpha's note\n");
    const mainShard = git(candidate.checkout, [
      "ls-tree", "--name-only", "origin/main", `${relativeAuditDir(candidate.checkout)}/`,
    ]).split("\n").find((path) => path && !path.endsWith(candidate.auditShard));
    expect(mainShard, "main carries an audit shard besides the Unit's own").toBeTruthy();
    appendFileSync(join(candidate.checkout, mainShard!), "\n# alpha's stray row\n");
    git(candidate.checkout, ["add", "-A"]);
    git(candidate.checkout, ["commit", "-m", "alpha's diary and a shared shard"]);

    const republished = runMergeTool(UNIT, ["publish", "alpha"], candidate.checkout);
    expect(republished.status, republished.out).toBe(0);
    expect((JSON.parse(republished.stdout) as PublishReply).records_outside_unit_tree).toBeUndefined();
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });
});

type PublishReply = {
  published: boolean;
  records_outside_unit_tree?: string[];
  records_outside_unit_tree_note?: string;
};

function relativeAuditDir(checkout: string): string {
  return seededAuditDir(checkout).slice(checkout.length + 1).replaceAll("\\", "/");
}
