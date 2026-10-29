// covers: subcommand:aidlc-unit:pin, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:land, function:candidateReviewCoverageProjection
//
// A team Unit's person approved NFR Design at its gate over a review that
// stayed NOT-READY, and the gate took that approval; pin then refused the
// Unit for want of a READY review and named no next step (#3309). Pin counts a
// stage whose last review is followed by the person's approval of it, lists it
// apart from the READY ones, and where it still refuses for a review it names
// the stage and the person's step in the checkout that claimed the Unit.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactFilename,
  loadStageGraphAll,
  reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededAuditDir, seededRecordDir } from "../harness/fixtures.ts";
import {
  UNIT,
  auditBlock,
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  prepareCandidate,
  reviewAuditExtras,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const STAGE = "nfr-design";
const nfrDesign = loadStageGraphAll().find((stage) => stage.slug === STAGE)!;

type Candidate = ReturnType<typeof prepareCandidate>;

function shardPath(candidate: Candidate): string {
  return join(seededAuditDir(candidate.checkout), candidate.auditShard);
}

function publishAgain(candidate: Candidate, message: string): void {
  git(candidate.checkout, ["add", "-A"]);
  git(candidate.checkout, ["commit", "-m", message]);
  const published = runMergeTool(UNIT, ["publish", "alpha"], candidate.checkout);
  expect(published.status, published.out).toBe(0);
}

// NFR Design's review as prepareCandidate wrote it (READY, iteration 1), made
// NOT-READY as the reviewer left it: its record and its completion say so, and
// the person's approval of the stage still follows it in the shard.
function reviewLeftNotReady(candidate: Candidate, label: string): void {
  const fingerprint = reviewArtifactFingerprint(candidate.checkout, nfrDesign, "alpha") as string;
  const nonce = `${label}:alpha:${candidate.generation}:${STAGE}`;
  const ready = reviewAuditExtras(candidate.checkout, STAGE, "alpha", nfrDesign.reviewer!, fingerprint, nonce);
  const notReady = reviewAuditExtras(
    candidate.checkout, STAGE, "alpha", nfrDesign.reviewer!, fingerprint, nonce, { verdict: "NOT-READY" },
  );
  const shard = readFileSync(shardPath(candidate), "utf-8");
  expect(shard).toContain(ready.completion);
  writeFileSync(shardPath(candidate), shard.replace(ready.completion, notReady.completion));
}

function appendRows(candidate: Candidate, rows: string): void {
  writeFileSync(shardPath(candidate), readFileSync(shardPath(candidate), "utf-8") + rows);
}

describe("t326 pin and a stage approved over an open review concern", () => {
  test("the person's approval after a NOT-READY review counts, and the gate and land take it", () => {
    const fixture = makeSeed();
    const candidate = prepareCandidate(fixture.remote, "alpha", "approved-team");
    reviewLeftNotReady(candidate, "approved-team");
    publishAgain(candidate, "NFR Design approved over its review's concern");

    const pin = runMergeTool(UNIT, ["pin", "alpha"], fixture.seed);
    expect(pin.status, pin.out).toBe(0);
    const evidence = JSON.parse(pin.stdout).evidence;
    expect(evidence.reviewers_expected).toContain(STAGE);
    expect(evidence.reviewers_ready).not.toContain(STAGE);
    expect(evidence.reviewers_approved_over_concerns).toEqual([STAGE]);

    gateAndLand(fixture.seed, "alpha");
  });

  test("a READY Unit's pinned evidence names no stage approved over a concern", () => {
    const fixture = makeSeed();
    prepareCandidate(fixture.remote, "alpha", "ready-team");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], fixture.seed);
    expect(pin.status, pin.out).toBe(0);
    const evidence = JSON.parse(pin.stdout).evidence;
    expect(evidence.reviewers_ready).toEqual(evidence.reviewers_expected);
    expect("reviewers_approved_over_concerns" in evidence).toBe(false);
  });

  test("a NOT-READY review after the approval, with no approval after it, still refuses and names the person's step", () => {
    const fixture = makeSeed();
    const candidate = prepareCandidate(fixture.remote, "alpha", "again-team");
    // The person asked for another look once the stage was approved, and the
    // reviewer left a concern open.
    const fingerprint = reviewArtifactFingerprint(candidate.checkout, nfrDesign, "alpha") as string;
    const again = reviewAuditExtras(
      candidate.checkout, STAGE, "alpha", nfrDesign.reviewer!, fingerprint,
      `again-team:alpha:${candidate.generation}:${STAGE}:again`, { verdict: "NOT-READY", iteration: 2 },
    );
    appendRows(
      candidate,
      auditBlock("REVIEW_REQUESTED", "alpha", candidate.generation, STAGE, again.request) +
        auditBlock("REVIEW_COMPLETED", "alpha", candidate.generation, STAGE, again.completion),
    );
    publishAgain(candidate, "NFR Design reviewed again after its approval");

    const pin = runMergeTool(UNIT, ["pin", "alpha"], fixture.seed);
    expect(pin.status).not.toBe(0);
    expect(pin.out).toContain(
      "NFR Design has no review that stands for it as published: in the checkout where again-team claimed " +
        "alpha (not this one), have it reviewed again, then publish alpha again.",
    );
    expect(pin.out).not.toContain("READY receipts");
  });

  test("a change to the stage's documents after the approval over a concern refuses", () => {
    const fixture = makeSeed();
    const candidate = prepareCandidate(fixture.remote, "alpha", "changed-team");
    reviewLeftNotReady(candidate, "changed-team");
    const name = artifactFilename(nfrDesign.produces![0]);
    const document = join(seededRecordDir(candidate.checkout), "construction", "alpha", STAGE, name);
    writeFileSync(document, `${readFileSync(document, "utf-8")}\nchanged after approval\n`);
    appendRows(
      candidate,
      auditBlock(
        "ARTIFACT_UPDATED", "alpha", candidate.generation, STAGE,
        `**File**: construction/alpha/${STAGE}/${name}\n`,
      ),
    );
    publishAgain(candidate, "NFR Design changed after its approval");

    const pin = runMergeTool(UNIT, ["pin", "alpha"], fixture.seed);
    expect(pin.status).not.toBe(0);
    expect(pin.out).toContain("NFR Design has no review that stands for it as published");
  });
});
