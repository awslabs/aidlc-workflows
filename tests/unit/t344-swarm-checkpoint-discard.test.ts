// covers: subcommand:aidlc-swarm:prepare, subcommand:aidlc-swarm:check, subcommand:aidlc-swarm:finalize,
// subcommand:aidlc-bolt:start, subcommand:aidlc-worktree:merge,
// subcommand:aidlc-bolt:abort, subcommand:aidlc-worktree:discard, audit:WORKTREE_DISCARDED,
// subcommand:aidlc-bolt:swarm-checkpoint, function:validateCodeGenerationForkApproval,
// function:captureCodeGenerationDiscardApproval, function:codeGenerationDiscardedBase,
// audit:SWARM_STARTED, audit:BOLT_STARTED

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  boltName, legacyBoltName, legacyWorktreePath, auditBlockField, boltSlugForUnit,
  readPlanApprovalReceipt,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  bindCodeGenerationWorktreeApproval, evaluateCodeGenerationApproval,
  readCodeGenerationWorktreeSourceBaseline,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  fixtureIntentId8, seededAuditDir, seededStateFile,
} from "../harness/fixtures.ts";
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import {
  approvalSnapshot,
  approveGroupedPlans,
  approveNativeCheckpoint,
  checkReviewFinalizeAndLand,
  cleanupCheckpointFixtures,
  discarded,
  fixture,
  git,
  interruptAfterBoltStart,
  nativeCheckpointRevision,
  nextDirective,
  prepare,
  retryAndDiscard,
  runCheckpointTool,
  starts,
  swarm,
  writeUnitSource,
  wt,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

describe("t344 explicit swarm checkpoint re-entry", () => {
  test("native discard after a peer landing recreates a provenance-bound legacy Bolt's approved baseline in the intent namespace", () => {
    const pd = fixture(["alpha", "beta"]);
    const interrupted = interruptAfterBoltStart(pd, false);
    expect(interrupted.code, `${interrupted.out}\n${interrupted.err}`).toBe(2);
    const id8 = fixtureIntentId8(pd);
    const currentName = boltName(id8, "alpha");
    // Convert the real unbound fork to a pre-upgrade fixture BEFORE delegation,
    // whose provenance digest binds the exact WORKTREE_CREATED block.
    const oldName = legacyBoltName("alpha");
    const legacy = legacyWorktreePath(pd, "alpha");
    git(wt(pd), ["branch", "-m", oldName]);
    git(pd, ["worktree", "move", wt(pd), legacy]);
    const metadataPath = join(legacy, ".aidlc", "worktree-meta.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
    delete metadata.intentId8;
    delete metadata.branch;
    writeFileSync(metadataPath, JSON.stringify(metadata));
    for (const project of [pd, legacy]) {
      const auditDir = seededAuditDir(project);
      for (const shard of readdirSync(auditDir)) {
        if (!shard.endsWith(".md")) continue;
        const path = join(auditDir, shard);
        writeFileSync(path, readFileSync(path, "utf-8").replaceAll(currentName, oldName));
      }
    }
    writeFileSync(seededStateFile(legacy), readFileSync(seededStateFile(legacy), "utf-8").replaceAll(currentName, oldName));
    bindCodeGenerationWorktreeApproval(pd, legacy, "alpha");
    const approved = evaluateCodeGenerationApproval(legacy, { unit: "alpha" });
    expect(approved.ok, approved.reason).toBe(true);
    const baseline = git(legacy, ["rev-parse", "HEAD"]);
    const peer = prepare(pd, ["beta"]);
    expect(peer.code, `${peer.out}\n${peer.err}`).toBe(0);
    writeUnitSource(pd, "beta", 2);
    checkReviewFinalizeAndLand(pd, { beta: 2 });
    const landedHead = git(pd, ["rev-parse", "HEAD"]);
    expect(landedHead).not.toBe(baseline);
    writeFileSync(join(legacy, "src", "alpha.ts"), "export const alpha = 99;\n");
    const removed = runCheckpointTool(pd, "tools/aidlc-worktree.ts", ["discard", "--slug", "alpha", "--project-dir", pd]);
    expect(removed.code, `${removed.out}\n${removed.err}`).toBe(0);
    expect(existsSync(legacy)).toBe(false);
    const approvedBase = auditBlockField(discarded(pd, "alpha").at(-1)!.block, "Approval Source Commit");
    expect(approvedBase).toBe(baseline);
    const recreated = prepare(pd);
    expect(recreated.code, `${recreated.out}\n${recreated.err}`).toBe(0);
    expect(git(wt(pd), ["symbolic-ref", "--short", "HEAD"])).toBe(currentName);
    expect(git(wt(pd), ["rev-parse", "HEAD"])).toBe(baseline);
    expect(JSON.parse(readFileSync(join(wt(pd), ".aidlc", "worktree-meta.json"), "utf-8")).baseCommit).toBe(baseline);
    expect(readFileSync(join(wt(pd), "src", "alpha.ts"), "utf-8")).toBe("export const alpha = 1;\n");
    expect(readFileSync(join(wt(pd), "src", "beta.ts"), "utf-8")).toBe("export const beta = 1;\n");
    expect(git(pd, ["rev-parse", "HEAD"])).toBe(landedHead);
    expect(readFileSync(join(pd, "src", "beta.ts"), "utf-8")).toBe("export const beta = 2;\n");
    expect(evaluateCodeGenerationApproval(wt(pd), { unit: "alpha" })).toMatchObject({
      ok: true, approvalFingerprint: approved.approvalFingerprint,
    });
  });

  test("failed initial fork preserves source and releases registration so discard then retry works", () => {
    const executable = process.platform === "win32"
      ? `"${process.execPath.replaceAll('"', '""')}"`
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const check = `${executable} -e "require('fs').writeFileSync('.aidlc/unbound-check-ran','executed')"`;
    const pd = fixture(["alpha"], check);
    const failed = interruptAfterBoltStart(pd, false);
    expect(failed.code, `${failed.out}\n${failed.err}`).toBe(2);
    expect(failed.out).toContain("aidlc-worktree discard");
    expect(readFileSync(join(wt(pd), "src", "alpha.ts"), "utf-8")).toContain("alpha = 1");
    expect(readFileSync(seededStateFile(pd), "utf-8")).toContain("**Bolt Refs**: [empty list]");
    const marker = join(wt(pd), ".aidlc", "unbound-check-ran");
    expect(existsSync(marker)).toBe(false);
    const refused = swarm(pd, ["check", "alpha", "--check-cmd", check]);
    expect(refused.code, `${refused.out}\n${refused.err}`).not.toBe(0);
    expect(`${refused.out}\n${refused.err}`).toMatch(/approval|delegat/i);
    expect(existsSync(marker)).toBe(false);
    const discarded = runCheckpointTool(pd, "tools/aidlc-worktree.ts", ["discard", "--slug", "alpha", "--project-dir", pd]);
    expect(discarded.code, discarded.err).toBe(0);
    const retried = prepare(pd);
    expect(retried.code, `${retried.out}\n${retried.err}`).toBe(0);
    const allowed = swarm(pd, ["check", "alpha", "--check-cmd", check]);
    expect(allowed.code, `${allowed.out}\n${allowed.err}`).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe("executed");
  });

  test.each(["individual", "grouped"])("native Retry can discard and reprepare a landed checkpoint revision with the same %s approval", (mode) => {
    const units = mode === "grouped" ? ["alpha", "beta"] : ["alpha"];
    const pd = nativeCheckpointRevision(units, mode === "grouped");
    const approvals = new Map(units.map((unit) => [unit, approvalSnapshot(pd, unit)]));
    const approvedHead = git(wt(pd), ["rev-parse", "HEAD"]);
    const parentHead = git(pd, ["rev-parse", "HEAD"]);
    const peerStarts = starts(pd, "beta").length;
    for (let cycle = 1; cycle <= 2; cycle++) {
      writeUnitSource(pd, "alpha", 90 + cycle);
      if (cycle === 2) {
        git(wt(pd), ["add", "src/alpha.ts"]);
        git(wt(pd), ["commit", "-qm", "abandoned Unit implementation"]);
        expect(git(wt(pd), ["rev-parse", "HEAD"])).not.toBe(approvedHead);
      }
      const beforeStarts = starts(pd).length;
      retryAndDiscard(pd, "alpha", cycle);
      const next = nextDirective(pd);
      expect(next).toMatchObject({ kind: "invoke-swarm", units, resume_existing: true });
      const retried = prepare(pd, units, true);
      expect(retried.code, `${retried.out}\n${retried.err}`).toBe(0);
      expect(starts(pd)).toHaveLength(beforeStarts + 1);
      expect(git(wt(pd), ["rev-parse", "HEAD"])).toBe(approvedHead);
      expect(readFileSync(join(wt(pd), "src/alpha.ts"), "utf-8")).toBe("export const alpha = 2;\n");
      expect(git(pd, ["rev-parse", "HEAD"])).toBe(parentHead);
      for (const unit of units) {
        const saved = approvals.get(unit)!;
        expect(readPlanApprovalReceipt(pd, saved.key)).toEqual(saved.parentReceipt);
        const receipt = readPlanApprovalReceipt(wt(pd, unit), saved.key);
        expect(receipt?.delegation?.parentReceiptSha256).toBe(saved.childReceipt.delegation!.parentReceiptSha256);
        expect(evaluateCodeGenerationApproval(wt(pd, unit), { unit }).ok).toBe(true);
        if (unit !== "alpha") expect(receipt).toEqual(saved.childReceipt);
      }
      expect(starts(pd, "beta")).toHaveLength(peerStarts);
      expect(nextDirective(pd)).not.toHaveProperty("resume_existing");
    }
    for (const unit of units) writeUnitSource(pd, unit, 3);
    checkReviewFinalizeAndLand(pd, Object.fromEntries(units.map((unit) => [unit, 3])));
    approveNativeCheckpoint(pd, units);
  });

  test.each(["initial preparation", "checkpoint revision"])("native discard after a grouped peer lands preserves beta's approved commit and running gamma during %s", (phase) => {
    const units = ["alpha", "beta", "gamma"];
    const isRevision = phase === "checkpoint revision";
    const pd = isRevision ? nativeCheckpointRevision(units, true) : fixture(units);
    if (!isRevision) {
      approveGroupedPlans(pd, units, "initial-discard-partial");
      const prepared = prepare(pd, units);
      expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    }
    const approvals = new Map(units.map((unit) => [unit, approvalSnapshot(pd, unit)]));
    const betaBase = git(wt(pd, "beta"), ["rev-parse", "HEAD"]);
    const betaBaseSources = new Map(units.map((unit) =>
      [unit, git(pd, ["show", `${betaBase}:src/${unit}.ts`])]));
    const betaBaseline = readCodeGenerationWorktreeSourceBaseline(wt(pd, "beta"), "beta");
    expect(betaBaseline).not.toBeNull();
    const gamma = wt(pd, "gamma");
    const gammaStarts = starts(pd, "gamma").length;
    const gammaHead = git(gamma, ["rev-parse", "HEAD"]);
    writeUnitSource(pd, "gamma", 5);
    writeFileSync(join(gamma, ".aidlc", "pending-note.txt"), "Keep gamma's pending work\n");
    const gammaSource = readFileSync(join(gamma, "src/gamma.ts"));
    const gammaState = readFileSync(seededStateFile(gamma));
    writeUnitSource(pd, "alpha", 3);
    checkReviewFinalizeAndLand(pd, { alpha: 3 });
    const landedHead = git(pd, ["rev-parse", "HEAD"]);
    expect(landedHead).not.toBe(betaBase);
    const unchangedPeers = () => {
      expect(git(pd, ["rev-parse", "HEAD"])).toBe(landedHead);
      expect(readFileSync(join(pd, "src/alpha.ts"), "utf-8")).toBe("export const alpha = 3;\n");
      expect(existsSync(wt(pd, "alpha"))).toBe(false);
      expect(git(gamma, ["rev-parse", "HEAD"])).toBe(gammaHead);
      expect(readFileSync(join(gamma, "src/gamma.ts"))).toEqual(gammaSource);
      expect(readFileSync(seededStateFile(gamma))).toEqual(gammaState);
      expect(readFileSync(join(gamma, ".aidlc", "pending-note.txt"), "utf-8")).toBe("Keep gamma's pending work\n");
      expect(starts(pd, "gamma")).toHaveLength(gammaStarts);
      for (const unit of units) {
        const saved = approvals.get(unit)!;
        expect(readPlanApprovalReceipt(pd, saved.key)).toEqual(saved.parentReceipt);
      }
      const savedGamma = approvals.get("gamma")!;
      expect(readPlanApprovalReceipt(gamma, savedGamma.key)).toEqual(savedGamma.childReceipt);
      expect(evaluateCodeGenerationApproval(gamma, { unit: "gamma" }).ok).toBe(true);
    };
    unchangedPeers();
    for (let cycle = 1; cycle <= 2; cycle++) {
      const betaStarts = starts(pd, "beta").length;
      writeUnitSource(pd, "beta", 90 + cycle);
      retryAndDiscard(pd, "beta", cycle);
      unchangedPeers();
      const next = nextDirective(pd);
      expect(next).toMatchObject({ kind: "invoke-swarm", units: ["beta", "gamma"] });
      if (isRevision) expect(next.resume_existing).toBe(true);
      else expect(next).not.toHaveProperty("resume_existing");
      const retried = prepare(pd, isRevision ? ["beta", "gamma"] : ["beta"], isRevision);
      expect(retried.code, `${retried.out}\n${retried.err}`).toBe(0);
      expect(starts(pd, "beta")).toHaveLength(betaStarts + 1);
      const beta = wt(pd, "beta");
      expect(git(beta, ["rev-parse", "HEAD"])).toBe(betaBase);
      expect(readCodeGenerationWorktreeSourceBaseline(beta, "beta")).toEqual(betaBaseline);
      for (const unit of units) {
        expect(readFileSync(join(beta, "src", `${unit}.ts`), "utf-8").trim()).toBe(betaBaseSources.get(unit)!);
      }
      const savedBeta = approvals.get("beta")!;
      const receipt = readPlanApprovalReceipt(beta, savedBeta.key);
      expect(receipt?.batch).toEqual(savedBeta.childReceipt.batch);
      expect(receipt?.delegation?.parentReceiptSha256).toBe(savedBeta.childReceipt.delegation!.parentReceiptSha256);
      expect(evaluateCodeGenerationApproval(beta, { unit: "beta" }).ok).toBe(true);
      unchangedPeers();
      expect(nextDirective(pd)).not.toHaveProperty("resume_existing");
    }
    writeUnitSource(pd, "beta", 4);
    checkReviewFinalizeAndLand(pd, { beta: 4, gamma: 5 });
    expect(readFileSync(join(pd, "src/alpha.ts"), "utf-8")).toBe("export const alpha = 3;\n");
    for (const unit of units) {
      const saved = approvals.get(unit)!;
      expect(readPlanApprovalReceipt(pd, saved.key)).toEqual(saved.parentReceipt);
    }
    approveNativeCheckpoint(pd, units);
  });

  test.each(["no discard", "older creation discard", "other Unit discard"])(
    "raw Git removal is not authorized recovery with %s evidence",
    (evidence) => {
      const units = evidence === "other Unit discard" ? ["alpha", "beta"] : ["alpha"];
      const pd = nativeCheckpointRevision(units, units.length > 1);
      if (evidence === "older creation discard") {
        retryAndDiscard(pd, "alpha");
        expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm", resume_existing: true });
        const recreated = prepare(pd, units, true);
        expect(recreated.code, `${recreated.out}\n${recreated.err}`).toBe(0);
      } else if (evidence === "other Unit discard") {
        retryAndDiscard(pd, "beta");
      }
      const beforeDiscards = discarded(pd, "alpha");
      const beforeStarts = starts(pd).length;
      const parentHead = git(pd, ["rev-parse", "HEAD"]);
      const approval = approvalSnapshot(pd, "alpha");
      git(pd, ["worktree", "remove", "--force", wt(pd)]);
      git(pd, ["branch", "-D", boltName(fixtureIntentId8(pd), boltSlugForUnit("alpha"))]);
      nextDirective(pd);
      const refused = prepare(pd, ["alpha"], true);
      expect(refused.code, `${refused.out}\n${refused.err}`).not.toBe(0);
      expect(`${refused.out}\n${refused.err}`).toMatch(/discard|creation|landing|missing worktree/i);
      expect(existsSync(wt(pd))).toBe(false);
      expect(starts(pd)).toHaveLength(beforeStarts);
      expect(discarded(pd, "alpha")).toEqual(beforeDiscards);
      expect(git(pd, ["rev-parse", "HEAD"])).toBe(parentHead);
      expect(readPlanApprovalReceipt(pd, approval.key)).toEqual(approval.parentReceipt);
    },
  );
});
