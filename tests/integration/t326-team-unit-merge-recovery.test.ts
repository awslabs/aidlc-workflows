// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:land, subcommand:aidlc-unit:merge-status, subcommand:aidlc-state:fold-unit-merge, audit:UNIT_MERGED, function:UNIT_MERGE_DIR, function:readUnitMergeTransaction, function:unitMergedReceipts

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactFilename,
  loadStageGraphAll,
  readAllAuditShards,
  readUnitMergeTransaction,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { deriveTeamUnitProgressModel } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { seededAuditDir, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  STATE,
  cleanupTempDirs,
  git,
  runMergeTool,
  parallelDependencyBody,
  makeSeed,
  clone,
  auditBlock,
  prepareCandidate,
  completeUnitOnMain,
  dispatchMerge,
  appendMainHumanTurn,
  gateAndLand,
  nextDirective,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

// The pinned merge cases are split across four files
// (t326-team-unit-merge*.test.ts) so the integration tier runs them in
// parallel; the shared fixture is tests/harness/team-unit-merge.ts.

// Several independent Git trees and CLI sessions share each case. Use the
// generous workload backstop for both its work and its afterEach cleanup.
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

describe("t326 pinned team Unit merge", () => {
  test("one human turn cannot approve two Unit merge gates", () => {
    const fixture = makeSeed(parallelDependencyBody());
    prepareCandidate(fixture.remote, "alpha", "alpha-human");
    prepareCandidate(fixture.remote, "beta", "beta-human");
    const alphaPin = runMergeTool(UNIT, ["pin", "alpha"], fixture.seed);
    const betaPin = runMergeTool(UNIT, ["pin", "beta"], fixture.seed);
    expect(alphaPin.status, alphaPin.out).toBe(0);
    expect(betaPin.status, betaPin.out).toBe(0);
    const alphaPayload = JSON.parse(alphaPin.stdout);
    const betaPayload = JSON.parse(betaPin.stdout);
    dispatchMerge(
      fixture.seed,
      "alpha",
      alphaPayload.pinned_oid,
      alphaPayload.generation,
    );
    dispatchMerge(
      fixture.seed,
      "beta",
      betaPayload.pinned_oid,
      betaPayload.generation,
    );
    appendMainHumanTurn(fixture.seed);
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        fixture.seed,
        true,
      ).status,
    ).toBe(0);
    const second = runMergeTool(
      UNIT,
      ["gate", "beta", "--decision", "approve", "--user-input", "Approve"],
      fixture.seed,
      true,
    );
    expect(second.status).not.toBe(0);
    expect(second.out).toContain("typed human turn");
  });

  test("a release after git landing has one explicit recovery and never crosses into a successor", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "release-race-team");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    const pinPayload = JSON.parse(pin.stdout);
    dispatchMerge(seed, "alpha", pinPayload.pinned_oid);
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        seed,
      ).status,
    ).toBe(0);
    expect(runMergeTool(UNIT, ["land", "alpha", "--step", "git"], seed).status).toBe(0);
    const releaseMain = clone(remote, "release-race-main");
    expect(runMergeTool(UNIT, ["release", "alpha"], releaseMain).status).toBe(0);
    const folded = runMergeTool(UNIT, ["land", "alpha", "--step", "state"], seed);
    expect(folded.status).not.toBe(0);
    expect(folded.out).toContain("--accept-released-attempt");
    expect(readAllAuditShards(seed)).not.toContain("**Event**: UNIT_MERGED");
    const directFold = runMergeTool(
      STATE,
      [
        "fold-unit-merge",
        "--unit",
        "alpha",
        "--pinned-oid",
        pinPayload.pinned_oid,
        "--generation",
        String(pinPayload.generation),
      ],
      seed,
      false,
      { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
    );
    expect(directFold.status).not.toBe(0);
    expect(directFold.out).toContain("no land-bound claim authorization");

    const accepted = runMergeTool(
      UNIT,
      [
        "land",
        "alpha",
        "--step",
        "state",
        "--accept-released-attempt",
        "--user-input",
        "I inspected the landed commit and accept completing this tombstoned attempt",
      ],
      seed,
      true,
    );
    expect(accepted.status).not.toBe(0);
    expect(accepted.out).toContain("fresh typed human turn");
    appendMainHumanTurn(seed);
    const acceptedWithHuman = runMergeTool(
      UNIT,
      [
        "land",
        "alpha",
        "--step",
        "state",
        "--accept-released-attempt",
        "--user-input",
        "I inspected the landed commit and accept completing this tombstoned attempt",
      ],
      seed,
      true,
    );
    expect(acceptedWithHuman.status, acceptedWithHuman.out).toBe(0);
    const acceptedTransaction = readUnitMergeTransaction(seed, "alpha")!;
    expect(acceptedTransaction.released_after_git?.tombstone_generation).toBe(
      pinPayload.generation + 1,
    );
    expect(readAllAuditShards(seed)).toContain(
      "**Recovery**: unit-merge-released-attempt",
    );
    expect(readAllAuditShards(seed)).toContain("**Event**: UNIT_MERGED");
    const finalizedRisk = runMergeTool(
      UNIT,
      ["land", "alpha", "--step", "audit"],
      seed,
    );
    expect(finalizedRisk.status, finalizedRisk.out).toBe(0);

    const successor = makeSeed();
    prepareCandidate(
      successor.remote,
      "alpha",
      "release-successor-team",
    );
    const successorPin = runMergeTool(UNIT, ["pin", "alpha"], successor.seed);
    expect(successorPin.status, successorPin.out).toBe(0);
    const successorPayload = JSON.parse(successorPin.stdout);
    dispatchMerge(
      successor.seed,
      "alpha",
      successorPayload.pinned_oid,
    );
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        successor.seed,
      ).status,
    ).toBe(0);
    expect(
      runMergeTool(UNIT, ["land", "alpha", "--step", "git"], successor.seed).status,
    ).toBe(0);
    const successorRelease = clone(successor.remote, "successor-release-main");
    expect(runMergeTool(UNIT, ["release", "alpha"], successorRelease).status).toBe(0);
    const replacement = clone(successor.remote, "successor-claimant");
    expect(
      runMergeTool(
        UNIT,
        ["claim", "alpha", "--team", "successor-claimant"],
        replacement,
      ).status,
    ).toBe(0);
    const refusedSuccessor = runMergeTool(
      UNIT,
      [
        "land",
        "alpha",
        "--step",
        "state",
        "--accept-released-attempt",
        "--user-input",
        "I inspected the landed commit",
      ],
      successor.seed,
    );
    expect(refusedSuccessor.status).not.toBe(0);
    expect(refusedSuccessor.out).toContain("moved or changed attempt");

    const finalized = makeSeed();
    prepareCandidate(
      finalized.remote,
      "alpha",
      "release-after-state-team",
    );
    const finalizedPin = runMergeTool(UNIT, ["pin", "alpha"], finalized.seed);
    expect(finalizedPin.status, finalizedPin.out).toBe(0);
    dispatchMerge(
      finalized.seed,
      "alpha",
      JSON.parse(finalizedPin.stdout).pinned_oid,
    );
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        finalized.seed,
      ).status,
    ).toBe(0);
    expect(
      runMergeTool(UNIT, ["land", "alpha", "--step", "git"], finalized.seed).status,
    ).toBe(0);
    expect(
      runMergeTool(UNIT, ["land", "alpha", "--step", "state"], finalized.seed).status,
    ).toBe(0);
    const lateReleaseMain = clone(finalized.remote, "late-release-main");
    expect(runMergeTool(UNIT, ["release", "alpha"], lateReleaseMain).status).toBe(0);
    const audit = runMergeTool(
      UNIT,
      ["land", "alpha", "--step", "audit"],
      finalized.seed,
    );
    expect(audit.status, audit.out).toBe(0);
    expect(JSON.parse(audit.stdout).status).toBe("complete");
  });

  test("state fold binds to live main columns after skip drift", () => {
    const fixture = makeSeed();
    prepareCandidate(fixture.remote, "alpha", "skip-drift-team");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], fixture.seed);
    expect(pin.status, pin.out).toBe(0);
    const pinPayload = JSON.parse(pin.stdout);
    dispatchMerge(
      fixture.seed,
      "alpha",
      pinPayload.pinned_oid,
      pinPayload.generation,
    );
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        fixture.seed,
      ).status,
    ).toBe(0);
    expect(
      runMergeTool(UNIT, ["land", "alpha", "--step", "git"], fixture.seed).status,
    ).toBe(0);
    writeFileSync(
      seededStateFile(fixture.seed),
      readFileSync(seededStateFile(fixture.seed), "utf-8").replace(
        "- [ ] nfr-requirements",
        "- [S] nfr-requirements",
      ),
    );
    expect(
      runMergeTool(UNIT, ["land", "alpha", "--step", "state"], fixture.seed).status,
    ).toBe(0);
    const foldedState = readFileSync(seededStateFile(fixture.seed), "utf-8");
    const header = foldedState
      .split(/\r?\n/)
      .find((line) => line.startsWith("| unit |")) ?? "";
    expect(header).not.toContain("nfr-requirements");
    const rowCells = unitProgressRow(fixture.seed, "alpha")
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    expect(rowCells.slice(2)).toEqual(
      rowCells.slice(2).map(() => "[x]"),
    );
    expect(
      runMergeTool(UNIT, ["land", "alpha", "--step", "audit"], fixture.seed).status,
    ).toBe(0);
  });

  test("dormancy leaves solo and claim-less workflows without merge transactions", () => {
    const { seed } = makeSeed();
    const before = readFileSync(seededStateFile(seed), "utf-8");
    const auditBefore = readAllAuditShards(seed);
    const refsBefore = git(seed, ["show-ref"]);
    expect(nextDirective(seed)).toMatchObject({ kind: "run-stage" });
    expect(readFileSync(seededStateFile(seed), "utf-8")).toBe(before);
    expect(readAllAuditShards(seed)).toBe(auditBefore);
    expect(git(seed, ["show-ref"])).toBe(refsBefore);
    expect(
      runMergeTool(UNIT, ["merge-status", "alpha"], seed).stdout.trim(),
    ).toBe("null");

    const solo = makeSeed();
    writeFileSync(
      seededStateFile(solo.seed),
      readFileSync(seededStateFile(solo.seed), "utf-8").replace(
        "- **Unit Ownership**: team",
        "- **Unit Ownership**: solo",
      ),
    );
    const soloBefore = readFileSync(seededStateFile(solo.seed), "utf-8");
    const soloAuditBefore = readAllAuditShards(solo.seed);
    const soloRefsBefore = git(solo.seed, ["show-ref"]);
    expect(nextDirective(solo.seed)).toMatchObject({ kind: "run-stage" });
    expect(readFileSync(seededStateFile(solo.seed), "utf-8")).toBe(soloBefore);
    expect(readAllAuditShards(solo.seed)).toBe(soloAuditBefore);
    expect(git(solo.seed, ["show-ref"])).toBe(soloRefsBefore);
    expect(
      runMergeTool(UNIT, ["merge-status", "alpha"], solo.seed).stdout.trim(),
    ).toBe("null");

    const claimed = makeSeed();
    const claimedCheckout = clone(claimed.remote, "claim-only");
    expect(
      runMergeTool(
        UNIT,
        ["claim", "alpha", "--team", "claim-only"],
        claimedCheckout,
      ).status,
    ).toBe(0);
    const claimOnlyModel = deriveTeamUnitProgressModel(
      claimedCheckout,
      readFileSync(seededStateFile(claimedCheckout), "utf-8"),
    );
    expect(claimOnlyModel.section).toBe(
      `## Unit Progress
<!-- Derived, engine-owned projection; routing ignores hand edits. -->
| unit | owner | functional-design | nfr-requirements | nfr-design | infrastructure-design | code-generation | gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| skeleton | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| alpha | claim-only | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| beta | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |`,
    );
    expect(claimOnlyModel.section).not.toContain("merged");
    writeFileSync(
      seededStateFile(claimed.seed),
      readFileSync(seededStateFile(claimed.seed), "utf-8").replace(
        "| alpha | - |",
        "| alpha | claim-only |",
      ),
    );
    expect(runMergeTool(UNIT, ["release", "alpha"], claimed.seed).status).toBe(0);
    const releasedModel = deriveTeamUnitProgressModel(
      claimed.seed,
      readFileSync(seededStateFile(claimed.seed), "utf-8"),
    );
    expect(releasedModel.section).toContain("| alpha | - |");
    expect(releasedModel.section).not.toContain("merged");

    const releasedPinned = makeSeed();
    prepareCandidate(
      releasedPinned.remote,
      "alpha",
      "released-pinned-team",
    );
    expect(runMergeTool(UNIT, ["pin", "alpha"], releasedPinned.seed).status).toBe(0);
    writeFileSync(
      seededStateFile(releasedPinned.seed),
      readFileSync(seededStateFile(releasedPinned.seed), "utf-8").replace(
        "| alpha | - |",
        "| alpha | released-pinned-team |",
      ),
    );
    const releasePinnedMain = clone(
      releasedPinned.remote,
      "released-pinned-main",
    );
    expect(runMergeTool(UNIT, ["release", "alpha"], releasePinnedMain).status).toBe(0);
    expect(runMergeTool(UNIT, ["status"], releasedPinned.seed).status).toBe(0);
    const releasedPinnedModel = deriveTeamUnitProgressModel(
      releasedPinned.seed,
      readFileSync(seededStateFile(releasedPinned.seed), "utf-8"),
    );
    expect(releasedPinnedModel.section).toContain("| alpha | - |");
    expect(releasedPinnedModel.section).toContain("| gate | merged |");
  });

  test("a completed unclaimed main-built row is merged by definition", () => {
    const fixture = makeSeed(parallelDependencyBody());
    prepareCandidate(fixture.remote, "alpha", "alpha-team");
    gateAndLand(fixture.seed, "alpha");
    writeFileSync(
      seededStateFile(fixture.seed),
      readFileSync(seededStateFile(fixture.seed), "utf-8").replace(
        "- **Unit Gate Rhythm**: per-stage",
        "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on",
      ),
    );
    completeUnitOnMain(fixture.seed, "beta");
    const model = deriveTeamUnitProgressModel(
      fixture.seed,
      readFileSync(seededStateFile(fixture.seed), "utf-8"),
    );
    expect(
      model.section.split("\n").find((line) => line.startsWith("| beta |")),
    ).toBe("| beta | - | [x] | [x] | [x] | [x] | [x] | [x] | [x] |");
    expect(Object.values(model.stageStates)).toEqual(
      Object.values(model.stageStates).map(() => "completed"),
    );
    expect(nextDirective(fixture.seed)).toMatchObject({
      kind: "run-stage",
      stage: "build-and-test",
    });
    expect(unitProgressRow(fixture.seed, "beta")).toBe(
      "| beta | - | [x] | [x] | [x] | [x] | [x] | [x] | [x] |",
    );
  });

  test("hand-edited all-complete cells cannot merge or skip a claimed Unit", () => {
    const fixture = makeSeed(parallelDependencyBody());
    prepareCandidate(fixture.remote, "alpha", "alpha-grid-team");
    gateAndLand(fixture.seed, "alpha");
    git(fixture.seed, ["push", "origin", "main"]);

    const beta = clone(fixture.remote, "beta-grid-team");
    expect(
      runMergeTool(UNIT, ["claim", "beta", "--team", "beta-grid-team"], beta).status,
    ).toBe(0);
    writeFileSync(
      seededStateFile(beta),
      readFileSync(seededStateFile(beta), "utf-8")
        .replace(
          "- **Unit Gate Rhythm**: per-stage",
          "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on",
        )
        .replace(
          /^\| beta \|.*$/m,
          "| beta | - | [x] | [x] | [x] | [x] | [x] | [x] | [x] |",
        ),
    );
    const model = deriveTeamUnitProgressModel(
      beta,
      readFileSync(seededStateFile(beta), "utf-8"),
    );
    expect(model.mergedUnits.has("beta")).toBe(false);
    expect(
      model.section.split("\n").find((line) => line.startsWith("| beta |")),
    ).toBe("| beta | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |");
    expect(nextDirective(beta)).toMatchObject({
      kind: "run-stage",
      stage: "functional-design",
      unit: "beta",
    });
  });

  test("gate and land fail closed offline and recover when registry access returns", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "offline-team");
    const offlinePin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(offlinePin.status, offlinePin.out).toBe(0);
    dispatchMerge(seed, "alpha", JSON.parse(offlinePin.stdout).pinned_oid);
    git(seed, [
      "remote",
      "set-url",
      "origin",
      join(seed, "dead-remote"),
    ]);
    const gate = runMergeTool(
      UNIT,
      ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
      seed,
    );
    expect(gate.status).not.toBe(0);
    expect(gate.out).toContain("fail closed");
    expect(gate.out).toContain("may have been tombstoned");
    git(seed, ["remote", "set-url", "origin", remote]);
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        seed,
      ).status,
    ).toBe(0);
    git(seed, [
      "remote",
      "set-url",
      "origin",
      join(seed, "dead-remote"),
    ]);
    const offlineLand = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(offlineLand.status).not.toBe(0);
    expect(offlineLand.out).toContain("fail closed");
    git(seed, ["remote", "set-url", "origin", remote]);
    const land = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(land.status, land.out).toBe(0);
    expect(readAllAuditShards(seed)).toContain("**Event**: UNIT_MERGED");
  });

  test("pin refuses incomplete rows and receipts outside a new team shard", () => {
    const rowFixture = makeSeed();
    const rowCandidate = prepareCandidate(
      rowFixture.remote,
      "alpha",
      "row-team",
    );
    writeFileSync(
      seededStateFile(rowCandidate.checkout),
      readFileSync(seededStateFile(rowCandidate.checkout), "utf-8").replace(
        "| alpha | row-team | [x] |",
        "| alpha | row-team | [ ] |",
      ),
    );
    git(rowCandidate.checkout, ["add", "-A"]);
    git(rowCandidate.checkout, ["commit", "-m", "damage progress row"]);
    expect(runMergeTool(UNIT, ["publish", "alpha"], rowCandidate.checkout).status).toBe(0);
    const badRow = runMergeTool(UNIT, ["pin", "alpha"], rowFixture.seed);
    expect(badRow.status).not.toBe(0);
    expect(badRow.out).toContain("functional-design");
    expect(badRow.out).toContain("is not complete");

    const shardFixture = makeSeed();
    const shardCandidate = prepareCandidate(
      shardFixture.remote,
      "alpha",
      "shard-team",
    );
    const teamShard = join(
      seededAuditDir(shardCandidate.checkout),
      shardCandidate.auditShard,
    );
    const skeletonShard = join(
      seededAuditDir(shardCandidate.checkout),
      "skeleton.md",
    );
    writeFileSync(
      skeletonShard,
      `${readFileSync(skeletonShard, "utf-8")}${readFileSync(teamShard, "utf-8")}`,
    );
    rmSync(teamShard);
    git(shardCandidate.checkout, ["add", "-A"]);
    git(shardCandidate.checkout, ["commit", "-m", "reuse main audit shard"]);
    expect(
      runMergeTool(UNIT, ["publish", "alpha"], shardCandidate.checkout).status,
    ).toBe(0);
    const badShard = runMergeTool(UNIT, ["pin", "alpha"], shardFixture.seed);
    expect(badShard.status).not.toBe(0);
    expect(badShard.out).toContain("inherited audit shard");

    const journalFixture = makeSeed();
    const journalCandidate = prepareCandidate(
      journalFixture.remote,
      "alpha",
      "journal-file-team",
    );
    const forcedJournalDir = join(
      journalCandidate.checkout,
      "aidlc",
      ".aidlc-unit-merges",
    );
    const forcedJournal = join(forcedJournalDir, "forged.json");
    mkdirSync(forcedJournalDir, { recursive: true });
    writeFileSync(forcedJournal, "{}\n");
    git(
      journalCandidate.checkout,
      ["add", "-f", "aidlc/.aidlc-unit-merges/forged.json"],
    );
    git(journalCandidate.checkout, ["commit", "-m", "force merge journal"]);
    expect(
      runMergeTool(UNIT, ["publish", "alpha"], journalCandidate.checkout).status,
    ).toBe(0);
    const journalPin = runMergeTool(UNIT, ["pin", "alpha"], journalFixture.seed);
    expect(journalPin.status).not.toBe(0);
    expect(journalPin.out).toContain("engine merge journals");
  });

  test("wave-built candidate fingerprints are validated from the pinned tree", () => {
    const fixture = makeSeed();
    prepareCandidate(
      fixture.remote,
      "alpha",
      "wave-team",
      { wave: true },
    );
    const pin = runMergeTool(UNIT, ["pin", "alpha"], fixture.seed);
    expect(pin.status, pin.out).toBe(0);
  });

  test("pin refuses later rejection, stale reviewer content, and stale Plan Approval", () => {
    const rejectedFixture = makeSeed();
    const rejected = prepareCandidate(
      rejectedFixture.remote,
      "alpha",
      "rejected-team",
    );
    writeFileSync(
      join(seededAuditDir(rejected.checkout), rejected.auditShard),
      `${
        readFileSync(
          join(seededAuditDir(rejected.checkout), rejected.auditShard),
          "utf-8",
        )
      }${
        auditBlock(
          "GATE_REJECTED",
          "alpha",
          rejected.generation,
          "functional-design",
          "**Gate Scope**: per-stage\n**Gate Stages**: functional-design\n",
        )
      }`,
    );
    git(rejected.checkout, ["add", "-A"]);
    git(rejected.checkout, ["commit", "-m", "reject completed stage"]);
    expect(runMergeTool(UNIT, ["publish", "alpha"], rejected.checkout).status).toBe(0);
    const rejectedPin = runMergeTool(UNIT, ["pin", "alpha"], rejectedFixture.seed);
    expect(rejectedPin.status).not.toBe(0);
    expect(rejectedPin.out).toContain("team gate approvals");

    const reviewFixture = makeSeed();
    const reviewed = prepareCandidate(
      reviewFixture.remote,
      "alpha",
      "review-team",
    );
    const reviewerStage = loadStageGraphAll().find(
      (stage) =>
        stage.reviewer &&
        [
          "functional-design",
          "nfr-requirements",
          "nfr-design",
          "infrastructure-design",
          "code-generation",
        ].includes(stage.slug),
    )!;
    const reviewerArtifact = join(
      seededRecordDir(reviewed.checkout),
      "construction",
      "alpha",
      reviewerStage.slug,
      artifactFilename(reviewerStage.produces![0]),
    );
    writeFileSync(
      reviewerArtifact,
      `${readFileSync(reviewerArtifact, "utf-8")}\nchanged after review\n`,
    );
    writeFileSync(
      join(seededAuditDir(reviewed.checkout), reviewed.auditShard),
      `${
        readFileSync(
          join(seededAuditDir(reviewed.checkout), reviewed.auditShard),
          "utf-8",
        )
      }${
        auditBlock(
          "ARTIFACT_UPDATED",
          "alpha",
          reviewed.generation,
          reviewerStage.slug,
          `**File**: construction/alpha/${reviewerStage.slug}/${
            artifactFilename(reviewerStage.produces![0])
          }\n`,
        )
      }`,
    );
    git(reviewed.checkout, ["add", "-A"]);
    git(reviewed.checkout, ["commit", "-m", "stale reviewer evidence"]);
    expect(runMergeTool(UNIT, ["publish", "alpha"], reviewed.checkout).status).toBe(0);
    const reviewPin = runMergeTool(UNIT, ["pin", "alpha"], reviewFixture.seed);
    expect(reviewPin.status).not.toBe(0);
    expect(reviewPin.out).toContain("reviewer READY receipts");
    expect(reviewPin.out).toContain(`reviewer READY receipts (${reviewerStage.slug})`);

    const planFixture = makeSeed();
    const planned = prepareCandidate(
      planFixture.remote,
      "alpha",
      "plan-team",
    );
    const auditPath = join(
      seededAuditDir(planned.checkout),
      planned.auditShard,
    );
    const audit = readFileSync(auditPath, "utf-8");
    writeFileSync(
      auditPath,
      audit.replace(
        /(\*\*Event\*\*: PLAN_APPROVAL_RECORDED[\s\S]*?\*\*Approval Fingerprint\*\*: )sha256:(?:v[23]:)?[0-9a-f]{64}/,
        `$1sha256:${"0".repeat(64)}`,
      ),
    );
    git(planned.checkout, ["add", "-A"]);
    git(planned.checkout, ["commit", "-m", "stale plan approval"]);
    expect(runMergeTool(UNIT, ["publish", "alpha"], planned.checkout).status).toBe(0);
    const planPin = runMergeTool(UNIT, ["pin", "alpha"], planFixture.seed);
    expect(planPin.status).not.toBe(0);
    expect(planPin.out).toContain("Plan Approval fingerprint");
  });
});
