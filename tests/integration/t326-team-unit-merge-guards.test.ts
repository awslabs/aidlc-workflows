// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:land, audit:UNIT_MERGED, function:UNIT_MERGE_DIR, function:unitMergeTransactionPath, function:readUnitMergeTransaction, function:writeUnitMergeTransaction, function:unitMergedReceipts

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditShardName,
  humanActedSinceGate,
  readAllAuditShards,
  readUnitMergeTransaction,
  unitMergeTransactionPath,
  writeUnitMergeTransaction,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededAuditDir, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  tempDirs,
  cleanupTempDirs,
  git,
  runMergeTool,
  parallelDependencyBody,
  makeSeed,
  prepareCandidate,
  dispatchMerge,
  appendMainHumanTurn,
} from "../harness/team-unit-merge.ts";

// The pinned merge cases are split across four files
// (t326-team-unit-merge*.test.ts) so the integration tier runs them in
// parallel; the shared fixture is tests/harness/team-unit-merge.ts.

// Several independent Git trees and CLI sessions share each case. Use the
// generous workload backstop for both its work and its afterEach cleanup.
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

describe("t326 pinned team Unit merge", () => {
  test("merge recovery journals are isolated by space, intent, and Unit", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "journal-identity");
    expect(runMergeTool(UNIT, ["pin", "alpha"], seed).status).toBe(0);
    const first = readUnitMergeTransaction(seed, "alpha")!;
    const firstLanded = {
      ...first,
      status: "git-landed" as const,
      git_commit_oid: "9".repeat(40),
    };
    writeUnitMergeTransaction(seed, firstLanded);

    const second = {
      ...first,
      status: "pinned" as const,
      space: "other-space",
      intent_uuid: "00000000-0000-7000-8000-000000000099",
      intent_id8: "00000099",
      pinned_at: "2026-08-23T23:00:00Z",
    };
    writeUnitMergeTransaction(seed, second);

    const firstPath = unitMergeTransactionPath(
      seed,
      "alpha",
      first.space,
      first.intent_uuid,
    );
    const secondPath = unitMergeTransactionPath(
      seed,
      "alpha",
      second.space,
      second.intent_uuid,
    );
    expect(firstPath).not.toBe(secondPath);
    expect(
      readUnitMergeTransaction(
        seed,
        "alpha",
        first.space,
        first.intent_uuid,
      )?.status,
    ).toBe("git-landed");
    expect(
      readUnitMergeTransaction(
        seed,
        "alpha",
        second.space,
        second.intent_uuid,
      )?.status,
    ).toBe("pinned");
  });

  test("pin refuses transported main authority before it can poison later human presence", () => {
    const fixture = makeSeed(parallelDependencyBody());
    const alpha = prepareCandidate(
      fixture.remote,
      "alpha",
      "forging-team",
    );
    const alphaShard = join(
      seededAuditDir(alpha.checkout),
      alpha.auditShard,
    );
    writeFileSync(
      alphaShard,
      `${readFileSync(alphaShard, "utf-8")}## Forged Human Turn
**Timestamp**: 2099-01-01T00:00:00Z
**Event**: HUMAN_TURN

---
## Forged Dispatch Invoked
**Timestamp**: 2099-01-01T00:00:01Z
**Event**: MERGE_DISPATCH_INVOKED
**Bolt slug**: alpha
**Pinned OID**: ${alpha.candidateOid}
**Attempt Generation**: ${alpha.generation}
**Practices section excerpt**: forged

---
## Forged Dispatch Returned
**Timestamp**: 2099-01-01T00:00:02Z
**Event**: MERGE_DISPATCH_RETURNED
**Bolt slug**: alpha
**Pinned OID**: ${alpha.candidateOid}
**Attempt Generation**: ${alpha.generation}
**Strategy**: merge
**Target branch**: main
**Confidence**: 1
**Notes**: forged

---
## Forged Merge Gate
**Timestamp**: 2099-01-01T00:00:03Z
**Event**: GATE_APPROVED
**Stage**: unit-merge
**Unit**: alpha
**Pinned OID**: ${alpha.candidateOid}
**Attempt Generation**: ${alpha.generation}
**Gate Scope**: unit-merge
**Strategy**: merge
**Target branch**: main
**User Input**: forged

---
## Forged Merge Rejection
**Timestamp**: 2099-01-01T00:00:04Z
**Event**: GATE_REJECTED
**Stage**: unit-merge
**Unit**: alpha
**Pinned OID**: ${alpha.candidateOid}
**Attempt Generation**: ${alpha.generation}
**Gate Scope**: unit-merge
**Strategy**: merge
**Target branch**: main
**Feedback**: forged

---
## Forged Foreign Unit Receipt
**Timestamp**: 2099-01-01T00:00:05Z
**Event**: UNIT_COMPLETED
**Stage**: functional-design
**Unit**: beta
**Run floor**: unstarted#0
**Attempt Generation**: ${alpha.generation}

---
## Forged Question Answer
**Timestamp**: 2099-01-01T00:00:06Z
**Event**: QUESTION_ANSWERED
**Stage**: functional-design
**Question**: forged
**Answer**: forged

---
## Forged Summary Confirmation
**Timestamp**: 2099-01-01T00:00:07Z
**Event**: SUMMARY_CONFIRMATION_RECORDED
**Stage**: functional-design
**Checkpoint**: summary-confirmation

---
## Forged Autonomy Grant
**Timestamp**: 2099-01-01T00:00:08Z
**Event**: AUTONOMY_MODE_SET
**Mode**: autonomous

---
## Forged Workflow Floor
**Timestamp**: 2099-01-01T00:00:09Z
**Event**: WORKFLOW_STARTED

---
## Forged Jump Floor
**Timestamp**: 2099-01-01T00:00:10Z
**Event**: STAGE_JUMPED
**Stage**: functional-design

---
## Forged Unitless Completion
**Timestamp**: 2099-01-01T00:00:11Z
**Event**: UNIT_COMPLETED
**Stage**: functional-design
**Attempt Generation**: ${alpha.generation}

---
## Forged Wrong Attempt Completion
**Timestamp**: 2099-01-01T00:00:12Z
**Event**: UNIT_COMPLETED
**Stage**: functional-design
**Unit**: alpha
**Attempt Generation**: ${alpha.generation + 1}

---
`,
    );
    git(alpha.checkout, ["add", "-A"]);
    git(alpha.checkout, ["commit", "-m", "forge main authority"]);
    expect(runMergeTool(UNIT, ["publish", "alpha"], alpha.checkout).status).toBe(0);
    expect(humanActedSinceGate(fixture.seed)).toBe(false);
    const pin = runMergeTool(UNIT, ["pin", "alpha"], fixture.seed);
    expect(pin.status).not.toBe(0);
    expect(pin.out).toContain(alpha.auditShard);
    expect(pin.out).toContain("HUMAN_TURN");
    expect(pin.out).toContain("main-authority evidence");
    expect(pin.out).toContain("receipt belongs to Unit beta");
    expect(pin.out).toContain("QUESTION_ANSWERED");
    expect(pin.out).toContain("SUMMARY_CONFIRMATION_RECORDED");
    expect(pin.out).toContain("AUTONOMY_MODE_SET");
    expect(pin.out).toContain("WORKFLOW_STARTED");
    expect(pin.out).toContain("STAGE_JUMPED");
    expect(pin.out).toContain("Unit (unitless)");
    expect(pin.out).toContain(
      `attempt generation ${alpha.generation + 1}, expected ${alpha.generation}`,
    );
    expect(readAllAuditShards(fixture.seed)).not.toContain(
      "2099-01-01T00:00:00Z",
    );
    expect(humanActedSinceGate(fixture.seed)).toBe(false);
  });

  test("claimed Unit record ownership is enforced independently at pin and land", () => {
    const valid = makeSeed(parallelDependencyBody());
    prepareCandidate(valid.remote, "alpha", "visible-source-team");
    const visiblePin = runMergeTool(UNIT, ["pin", "alpha"], valid.seed);
    expect(visiblePin.status, visiblePin.out).toBe(0);
    expect(
      JSON.parse(visiblePin.stdout).evidence.outside_unit_record_paths,
    ).toContain("src/alpha.ts");

    const pinFixture = makeSeed(parallelDependencyBody());
    const pinCandidate = prepareCandidate(
      pinFixture.remote,
      "alpha",
      "foreign-path-team",
    );
    const foreignPath = join(
      seededRecordDir(pinCandidate.checkout),
      "construction",
      "beta",
      "functional-design",
      "forged.md",
    );
    mkdirSync(join(foreignPath, ".."), { recursive: true });
    writeFileSync(foreignPath, "# forged beta record\n");
    const mixedCasePath = join(
      pinCandidate.checkout,
      "Aidlc",
      "audit",
      "forged.md",
    );
    mkdirSync(join(mixedCasePath, ".."), { recursive: true });
    writeFileSync(mixedCasePath, "# mixed-case workflow path\n");
    git(pinCandidate.checkout, ["add", "-A"]);
    git(pinCandidate.checkout, ["commit", "-m", "touch foreign Unit"]);
    const trackedMixedCasePath = git(pinCandidate.checkout, ["ls-files"])
      .split(/\r?\n/)
      .find((path) => path.toLowerCase() === "aidlc/audit/forged.md");
    expect(trackedMixedCasePath).toBeTruthy();
    expect(
      runMergeTool(UNIT, ["publish", "alpha"], pinCandidate.checkout).status,
    ).toBe(0);
    const refusedPin = runMergeTool(UNIT, ["pin", "alpha"], pinFixture.seed);
    expect(refusedPin.status).not.toBe(0);
    expect(refusedPin.out).toContain(
      "construction/beta/functional-design/forged.md",
    );
    expect(refusedPin.out).toContain(trackedMixedCasePath!);
    expect(refusedPin.out).toContain("outside claimed Unit record tree");

    const landFixture = makeSeed(parallelDependencyBody());
    const landCandidate = prepareCandidate(
      landFixture.remote,
      "alpha",
      "land-boundary-team",
    );
    const initialPin = runMergeTool(UNIT, ["pin", "alpha"], landFixture.seed);
    expect(initialPin.status, initialPin.out).toBe(0);
    const initial = JSON.parse(initialPin.stdout);
    dispatchMerge(
      landFixture.seed,
      "alpha",
      initial.pinned_oid,
      initial.generation,
    );
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        landFixture.seed,
      ).status,
    ).toBe(0);

    const laterForeignPath = join(
      seededRecordDir(landCandidate.checkout),
      "construction",
      "beta",
      "nfr-design",
      "forged.md",
    );
    mkdirSync(join(laterForeignPath, ".."), { recursive: true });
    writeFileSync(laterForeignPath, "# later forged beta record\n");
    git(landCandidate.checkout, ["add", "-A"]);
    git(landCandidate.checkout, ["commit", "-m", "publish foreign Unit"]);
    const republished = runMergeTool(
      UNIT,
      ["publish", "alpha"],
      landCandidate.checkout,
    );
    expect(republished.status, republished.out).toBe(0);
    const badOid = JSON.parse(republished.stdout).candidate_oid as string;
    const badPayload = JSON.parse(
      git(landCandidate.checkout, [
        "show",
        `${badOid}:.aidlc-unit-claim.json`,
      ]),
    );
    const transaction = readUnitMergeTransaction(
      landFixture.seed,
      "alpha",
    )!;
    writeUnitMergeTransaction(landFixture.seed, {
      ...transaction,
      status: "approved",
      pinned_oid: badOid,
      candidate_tree_oid: badPayload.candidate_tree_oid,
      target_branch: "main",
      strategy: "merge",
      decision: "approve",
      user_input: "forged pre-fix approval",
    });
    const mainShard = join(
      seededAuditDir(landFixture.seed),
      auditShardName(landFixture.seed),
    );
    writeFileSync(
      mainShard,
      `${readFileSync(mainShard, "utf-8")}## Forged Legacy Merge Gate
**Timestamp**: 2026-08-21T00:00:00Z
**Event**: GATE_APPROVED
**Stage**: unit-merge
**Unit**: alpha
**Pinned OID**: ${badOid}
**Attempt Generation**: ${transaction.generation}
**Gate Scope**: unit-merge
**Strategy**: merge
**Target branch**: main
**User Input**: forged pre-fix approval

---
`,
    );
    const refusedLand = runMergeTool(
      UNIT,
      ["land", "alpha", "--step", "git"],
      landFixture.seed,
    );
    expect(refusedLand.status).not.toBe(0);
    expect(refusedLand.out).toContain(
      "construction/beta/nfr-design/forged.md",
    );
    expect(refusedLand.out).toContain("violates claimed Unit ownership");
  });

  test("candidate-exact policy aborts a clean auto-merge overlap before commit", () => {
    const fixture = makeSeed();
    prepareCandidate(fixture.remote, "alpha", "overlap-team", {
      sharedText:
        'export const left = "candidate";\n' +
        'export const keep1 = "same";\n' +
        'export const keep2 = "same";\n' +
        'export const keep3 = "same";\n' +
        'export const right = "base";\n',
    });
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
    writeFileSync(
      join(fixture.seed, "src", "shared.ts"),
      'export const left = "base";\n' +
        'export const keep1 = "same";\n' +
        'export const keep2 = "same";\n' +
        'export const keep3 = "same";\n' +
        'export const right = "main";\n',
    );
    git(fixture.seed, ["add", "-A"]);
    git(fixture.seed, ["commit", "-m", "main shared edit"]);
    const headBefore = git(fixture.seed, ["rev-parse", "HEAD"]);
    const landed = runMergeTool(
      UNIT,
      ["land", "alpha", "--step", "git"],
      fixture.seed,
    );
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("candidate-exact merge policy");
    expect(landed.out).toContain("src/shared.ts");
    expect(landed.out).toContain("Rebase");
    const policy = JSON.parse(landed.out).candidate_exact;
    expect(policy).toMatchObject({
      phase: "pending-index", unit: "alpha", pinned_oid: pinPayload.pinned_oid,
    });
    const mismatch = policy.object_mismatches.find((entry: { path: string }) => entry.path === "src/shared.ts");
    expect(mismatch).toMatchObject({
      expected_treeish: pinPayload.pinned_oid,
      expected: { status: 0, oid: git(fixture.seed, ["rev-parse", `${pinPayload.pinned_oid}:src/shared.ts`]) },
      actual: { status: 0 },
    });
    expect(mismatch.actual.oid).not.toBe(mismatch.expected.oid);
    expect(git(fixture.seed, ["cat-file", "blob", mismatch.actual.oid])).toContain('export const right = "main";');
    expect(git(fixture.seed, ["cat-file", "blob", mismatch.expected.oid])).toContain('export const right = "base";');
    expect(git(fixture.seed, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(fixture.seed, ["ls-files", "-u"])).toBe("");
  });

  test("landing refuses unrelated dirty files that merely resemble engine metadata", () => {
    const fixture = makeSeed();
    prepareCandidate(fixture.remote, "alpha", "dirty-metadata-team");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], fixture.seed);
    expect(pin.status, pin.out).toBe(0);
    const payload = JSON.parse(pin.stdout);
    dispatchMerge(
      fixture.seed,
      "alpha",
      payload.pinned_oid,
      payload.generation,
    );
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        fixture.seed,
      ).status,
    ).toBe(0);

    mkdirSync(join(fixture.seed, "src", "audit"), { recursive: true });
    writeFileSync(
      join(fixture.seed, "src", "audit", "logger.ts"),
      "export const logger = true;\n",
    );
    writeFileSync(
      join(fixture.seed, "src", "runtime-graph.json"),
      "{}\n",
    );
    const headBefore = git(fixture.seed, ["rev-parse", "HEAD"]);
    const landed = runMergeTool(
      UNIT,
      ["land", "alpha", "--step", "git"],
      fixture.seed,
    );
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("src/audit/logger.ts");
    expect(landed.out).toContain("src/runtime-graph.json");
    expect(git(fixture.seed, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(
      git(fixture.seed, ["status", "--short", "--untracked-files=all"]),
    ).toContain(
      "src/audit/logger.ts",
    );
  });

  test("source conflicts abort before state/audit transport and HOLD-MERGE blocks the gate", () => {
    const conflict = makeSeed();
    const conflictCandidate = prepareCandidate(
      conflict.remote,
      "alpha",
      "conflict-team",
      {
        sourceText: 'export const alpha = "candidate";\n',
      },
    );
    const conflictPin = runMergeTool(UNIT, ["pin", "alpha"], conflict.seed);
    expect(conflictPin.status, conflictPin.out).toBe(0);
    dispatchMerge(
      conflict.seed,
      "alpha",
      JSON.parse(conflictPin.stdout).pinned_oid,
    );
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        conflict.seed,
      ).status,
    ).toBe(0);
    mkdirSync(join(conflict.seed, "src"), { recursive: true });
    writeFileSync(
      join(conflict.seed, "src", "alpha.ts"),
      'export const alpha = "main";\n',
    );
    git(conflict.seed, ["add", "-A"]);
    git(conflict.seed, ["commit", "-m", "main conflict"]);
    const stateBefore = readFileSync(seededStateFile(conflict.seed), "utf-8");
    const headBefore = git(conflict.seed, ["rev-parse", "HEAD"]);
    const traceDir = mkdtempSync(join(tmpdir(), "aidlc-inc3-landing-trace-"));
    tempDirs.push(traceDir);
    const tracePath = join(traceDir, "git-events.ndjson");
    const landed = runMergeTool(UNIT, ["land", "alpha", "--step", "git"], conflict.seed, false, {
      GIT_TRACE2_EVENT: tracePath.replaceAll("\\", "/"),
    });
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain("src/alpha.ts");
    expect(readFileSync(seededStateFile(conflict.seed), "utf-8")).toBe(stateBefore);
    expect(git(conflict.seed, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(conflict.seed, ["ls-files", "-u"])).toBe("");
    expect(readAllAuditShards(conflict.seed)).not.toContain("UNIT_MERGED");
    expect(() =>
      readFileSync(
        join(seededAuditDir(conflict.seed), conflictCandidate.auditShard),
      )
    ).toThrow();

    const held = makeSeed();
    prepareCandidate(held.remote, "alpha", "held-team", { mergeHeld: true });
    expect(runMergeTool(UNIT, ["pin", "alpha"], held.seed).status).toBe(0);
    const heldGate = runMergeTool(
      UNIT,
      ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
      held.seed,
    );
    expect(heldGate.status).not.toBe(0);
    expect(heldGate.out).toContain("merge is held");

    const heldAtLand = makeSeed();
    prepareCandidate(heldAtLand.remote, "alpha", "late-held-team");
    const latePin = runMergeTool(UNIT, ["pin", "alpha"], heldAtLand.seed);
    expect(latePin.status, latePin.out).toBe(0);
    const latePayload = JSON.parse(latePin.stdout);
    dispatchMerge(
      heldAtLand.seed,
      "alpha",
      latePayload.pinned_oid,
      latePayload.generation,
    );
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        heldAtLand.seed,
      ).status,
    ).toBe(0);
    const journalPath = unitMergeTransactionPath(heldAtLand.seed, "alpha");
    const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
    journal.evidence.merge_held = true;
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    const heldLand = runMergeTool(UNIT, ["land", "alpha"], heldAtLand.seed);
    expect(heldLand.status).not.toBe(0);
    expect(heldLand.out).toContain("merge is held");
  });

  test("journal edits cannot bypass the gate and a lost post-merge journal update recovers", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "journal-team");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    const pinnedOid = JSON.parse(pin.stdout).pinned_oid;
    const journalPath = unitMergeTransactionPath(seed, "alpha");
    const forged = JSON.parse(readFileSync(journalPath, "utf-8"));
    const ownerForged = {
      ...forged,
      status: "approved",
      target_branch: "main",
      strategy: "merge",
      owner: "forged-owner",
    };
    writeFileSync(
      journalPath,
      `${JSON.stringify(ownerForged, null, 2)}\n`,
    );
    const ownerBypass = runMergeTool(
      UNIT,
      ["land", "alpha", "--step", "git"],
      seed,
    );
    expect(ownerBypass.status).not.toBe(0);
    expect(ownerBypass.out).toContain(
      "journal owner does not match the pinned claim payload owner",
    );
    forged.status = "approved";
    forged.target_branch = "main";
    forged.strategy = "merge";
    writeFileSync(journalPath, `${JSON.stringify(forged, null, 2)}\n`);
    const bypass = runMergeTool(UNIT, ["land", "alpha", "--step", "git"], seed);
    expect(bypass.status).not.toBe(0);
    expect(bypass.out).toContain("approved merge-gate receipt");

    dispatchMerge(seed, "alpha", pinnedOid);
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        seed,
      ).status,
    ).toBe(0);
    const approvedRepin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(approvedRepin.status).not.toBe(0);
    expect(approvedRepin.out).toContain(
      "recover it with aidlc unit land alpha",
    );
    const landed = runMergeTool(UNIT, ["land", "alpha", "--step", "git"], seed);
    expect(landed.status, landed.out).toBe(0);
    const mergeOid = JSON.parse(landed.stdout).git_commit_oid;
    const repin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(repin.status).not.toBe(0);
    expect(repin.out).toContain("recover it with aidlc unit land alpha");
    const lost = JSON.parse(readFileSync(journalPath, "utf-8"));
    lost.status = "approved";
    delete lost.git_commit_oid;
    writeFileSync(journalPath, `${JSON.stringify(lost, null, 2)}\n`);
    const recovered = runMergeTool(UNIT, ["land", "alpha", "--step", "git"], seed);
    expect(recovered.status, recovered.out).toBe(0);
    expect(JSON.parse(recovered.stdout).git_commit_oid).toBe(mergeOid);
  });

  test("merge approval enforces tripwires and a real main-shard human turn", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "human-team");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    dispatchMerge(seed, "alpha", JSON.parse(pin.stdout).pinned_oid);
    const cancelled = runMergeTool(
      UNIT,
      ["gate", "alpha", "--decision", "approve", "--user-input", "Cancelled"],
      seed,
      true,
    );
    expect(cancelled.status).not.toBe(0);
    expect(cancelled.out).toContain("cancellation boilerplate");
    const attributed = runMergeTool(
      UNIT,
      [
        "gate",
        "alpha",
        "--decision",
        "approve",
        "--user-input",
        "CONDUCTOR DEFAULT, session unattended",
      ],
      seed,
      true,
    );
    expect(attributed.status).not.toBe(0);
    expect(attributed.out).toContain("self-attribution blocked");
    const noHuman = runMergeTool(
      UNIT,
      ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
      seed,
      true,
    );
    expect(noHuman.status).not.toBe(0);
    expect(noHuman.out).toContain("typed human turn");
    appendMainHumanTurn(seed);
    const approved = runMergeTool(
      UNIT,
      [
        "gate",
        "alpha",
        "--decision",
        "approve",
        "--user-input",
        "Approve pinned candidate",
      ],
      seed,
      true,
    );
    expect(approved.status, approved.out).toBe(0);
    expect(runMergeTool(UNIT, ["land", "alpha"], seed).status).toBe(0);
  });

});
