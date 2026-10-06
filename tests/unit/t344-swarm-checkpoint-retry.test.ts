// covers: subcommand:aidlc-swarm:prepare, subcommand:aidlc-swarm:check, subcommand:aidlc-swarm:finalize,
// subcommand:aidlc-bolt:start, subcommand:aidlc-worktree:merge,
// subcommand:aidlc-worktree:discard, audit:WORKTREE_DISCARDED,
// subcommand:aidlc-bolt:swarm-checkpoint, function:validateCodeGenerationForkApproval,
// function:captureCodeGenerationDiscardApproval, function:codeGenerationDiscardedBase,
// audit:SWARM_STARTED, audit:BOLT_STARTED

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  worktreePath, auditBlockField, boltSlugForUnit, createIntent, readAuditShardEvents,
  readPlanApprovalReceipt, recordDir, resolveWorkflowSelection, setActiveIntentCursor,
  setField, workspaceSourceListing, writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  beginCodeGeneration, codeGenerationRecordDir, evaluateCodeGenerationApproval,
  resolveCodeGenerationAuthority, readCodeGenerationWorktreeSourceBaseline,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  fixtureIntentId8, AIDLC_SRC, runOrchestrateNext, seededStateFile,
} from "../harness/fixtures.ts";
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import {
  approveGroupedPlans,
  approvePlan,
  CHECK,
  checkpointChoice,
  checkReviewFinalizeAndLand,
  cleanupCheckpointFixtures,
  completeOld,
  fixture,
  git,
  interruptAfterBoltStart,
  nextDirective,
  plan,
  prepare,
  publish,
  reject,
  reviewRevisedSource,
  runCheckpointTool,
  STAGE,
  starts,
  SUBMODULE_SOURCE,
  submoduleRepos,
  swarm,
  writeUnitSource,
  wt,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

describe("t344 explicit swarm checkpoint re-entry", () => {
  test.each([
    [["prepare", "--batch", "1", "--units", "alpha", "--base", "main"]],
    [["check", "alpha"]],
    [["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]],
  ] as string[][][])("%s refuses an intent selector outside the active workflow without changing either record", (args: string[]) => {
    const pd = fixture();
    const ambient = resolveWorkflowSelection(pd);
    const other = createIntent(pd, "other", ambient.space, "feature", undefined, "t344-other-intent");
    setActiveIntentCursor(pd, ambient.intent!, ambient.space);
    const beforeAudit = readAuditShardEvents(pd, ambient.intent!, ambient.space);
    const beforeState = readFileSync(seededStateFile(pd));
    const otherStatePath = join(other.recordDir, "aidlc-state.md");
    const otherState = readFileSync(otherStatePath);

    const refused = swarm(pd, [...args, "--intent", other.dirName]);

    expect(refused.code, `${refused.out}\n${refused.err}`).not.toBe(0);
    expect(JSON.parse(refused.err)).toEqual({
      error: `swarm commands follow the session's active workflow (${ambient.space}/${ambient.intent}); switch to ${other.space}/${other.dirName} instead of passing --intent/--space`,
    });
    expect(readAuditShardEvents(pd, ambient.intent!, ambient.space)).toEqual(beforeAudit);
    expect(readAuditShardEvents(pd, other.dirName, other.space)).toEqual([]);
    expect(readFileSync(seededStateFile(pd))).toEqual(beforeState);
    expect(readFileSync(otherStatePath)).toEqual(otherState);
    expect(existsSync(wt(pd))).toBe(false);
    expect(existsSync(worktreePath(pd, fixtureIntentId8(pd, other.dirName, other.space), "alpha"))).toBe(false);
  });

  test.each(["checkpoints", "legacy autonomy"])("dirty approved parent preflight leaves no orphan for %s and commit then retry works", (policy) => {
    const pd = fixture();
    if (policy === "legacy autonomy") {
      let state = readFileSync(seededStateFile(pd), "utf-8");
      state = setField(state, "Construction Checkpoints", "disabled");
      state = setField(state, "Construction Autonomy Mode", "autonomous");
      writeFileSync(seededStateFile(pd), state);
      publish(pd, ["alpha"]);
    }
    writeFileSync(join(pd, "src", "skeleton.ts"), "export const skeleton = true;\n");
    approvePlan(pd, "alpha", "dirty-parent");
    const refused = prepare(pd);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("before creating worktrees");
    expect(refused.err).toMatch(/commit/i);
    expect(existsSync(wt(pd))).toBe(false);
    expect(starts(pd)).toHaveLength(0);
    git(pd, ["add", "src/skeleton.ts"]);
    git(pd, ["commit", "-qm", "approved skeleton baseline"]);
    const retried = prepare(pd);
    expect(retried.code, `${retried.out}\n${retried.err}`).toBe(0);
    expect(readFileSync(join(wt(pd), "src", "skeleton.ts"), "utf-8")).toContain("skeleton = true");
    expect(evaluateCodeGenerationApproval(wt(pd), { unit: "alpha" }).ok).toBe(true);
  });

  test("interrupted resume after the real Bolt fork retries the same revision without losing its archive", () => {
    const pd = fixture();
    completeOld(pd);
    const child = wt(pd);
    const originalPlan = readFileSync(join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md"), "utf-8");
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const failed = interruptAfterBoltStart(pd, true);
    expect(failed.code, `${failed.out}\n${failed.err}`).toBe(2);
    expect(failed.out).toContain("resume Bolt start failed");
    const archive = JSON.parse(failed.out).units[0].archive_path;
    expect(readFileSync(join(archive, "plan.md"), "utf-8")).toBe(originalPlan);
    expect(nextDirective(pd)).toMatchObject({
      kind: "invoke-swarm", units: ["alpha"], resume_existing: true,
    });
    const recovered = prepare(pd, ["alpha"], true);
    expect(recovered.code, `${recovered.out}\n${recovered.err}`).toBe(0);
    expect(readFileSync(join(archive, "plan.md"), "utf-8")).toBe(originalPlan);
    expect(readdirSync(join(archive, "attempts")).length).toBeGreaterThan(0);
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(true);
    const continued = nextDirective(pd);
    expect(continued).toMatchObject({ kind: "invoke-swarm", units: ["alpha"] });
    expect(continued).not.toHaveProperty("resume_existing");
    const startedCount = starts(pd).length;
    expect(prepare(pd, ["alpha"], true).code).toBe(0);
    expect(starts(pd)).toHaveLength(startedCount);
  });

  test("an earlier stage's checkpoint rejection does not block fresh prepare or finalize", () => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    const discarded = runCheckpointTool(pd, "tools/aidlc-worktree.ts", ["discard", "--slug", "alpha", "--project-dir", pd]);
    expect(discarded.code, discarded.err).toBe(0);
    const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
    publish(pd, ["alpha"]);
    approvePlan(pd, "alpha", "new-stage");
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    writeFileSync(join(wt(pd), "src", "alpha.ts"), "export const alpha = 3;\n");
    reviewRevisedSource(pd);
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha",
      "--claimed", "alpha", "--check-cmd", "git diff --check"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
  });

  test.each(["individual", "grouped"])("native source landing and batch Request Changes can revise work with %s Plan Approval", (approvalMode) => {
    const units = approvalMode === "grouped" ? ["alpha", "beta"] : ["alpha"];
    const pd = fixture(units);
    if (approvalMode === "grouped") approveGroupedPlans(pd, units, "initial-group");
    const initial = prepare(pd, units);
    expect(initial.code, `${initial.out}\n${initial.err}`).toBe(0);
    const finalizeAndLand = (value: number) => {
      for (const unit of units) {
        writeFileSync(join(wt(pd, unit), "src", `${unit}.ts`), `export const ${unit} = ${value};\n`);
        reviewRevisedSource(pd, unit);
      }
      const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", units.join(","),
        "--claimed", units.join(","), "--check-cmd", "git diff --check"]);
      expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
      for (const unit of units) {
      const merged = runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
        "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
      ]);
      expect(merged.code, `${merged.out}\n${merged.err}`).toBe(0);
      expect(existsSync(wt(pd, unit))).toBe(false);
      expect(readFileSync(join(pd, "src", `${unit}.ts`), "utf-8")).toContain(`${unit} = ${value}`);
      }
    };
    finalizeAndLand(2);
    const next = () => {
      const result = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), pd, [], {
        cwd: pd, env: { ...process.env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
      });
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
    const checkpoint = next();
    expect(checkpoint.code, checkpoint.err).toBe(0);
    expect(JSON.parse(checkpoint.out).swarm_checkpoint, checkpoint.out).toBeTruthy();
    if (approvalMode === "grouped") {
      for (const unit of units) {
        const approval = evaluateCodeGenerationApproval(pd, { unit });
        expect(approval.ok, approval.reason).toBe(true);
      }
    }
    checkpointChoice(pd, units, "Request Changes");
    const rejected = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
      "swarm-checkpoint", "--action", "reject", "--batch", "1", "--units", units.join(","),
      "--session", "t344-checkpoint",
      "--user-input", "Request Changes", "--reason", "Please revise alpha", "--project-dir", pd,
    ]);
    expect(rejected.code, `${rejected.out}\n${rejected.err}`).toBe(0);
    const revision = next();
    expect(revision.code, revision.err).toBe(0);
    // The plans are still the ones approved before the checkpoint, so the
    // engine sends them back with the person's words before asking again.
    expect(JSON.parse(revision.out)).toMatchObject({
      kind: "invoke-swarm", units, resume_existing: true,
      plan_approval: {
        status: "plan",
        units: units.map((unit) => ({ unit, status: "revise", feedback: "Please revise alpha" })),
      },
    });
    if (approvalMode === "grouped") approveGroupedPlans(pd, units, "landed-revision");
    else approvePlan(pd, "alpha", "landed-revision");
    const prepared = prepare(pd, units, true);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    expect(JSON.parse(prepared.out).units[0].resumed).toBe(true);
    expect(readFileSync(join(wt(pd), "src", "alpha.ts"), "utf-8")).toContain("alpha = 2");
    finalizeAndLand(3);
    const afterRevision = next();
    expect(afterRevision.code, afterRevision.err).toBe(0);
    expect(JSON.parse(afterRevision.out).swarm_checkpoint, afterRevision.out).toBeTruthy();
    checkpointChoice(pd, units, "Approve");
    const approved = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
      "swarm-checkpoint", "--action", "approve", "--batch", "1", "--units", units.join(","),
      "--session", "t344-checkpoint",
      "--user-input", "Approve", "--project-dir", pd,
    ]);
    expect(approved.code, `${approved.out}\n${approved.err}`).toBe(0);
    // Keep the full tracked workflow fixture required by native receipt transfer.
    // Two landing/review cycles need a larger outer case budget on Windows.
  });

  test.each(["initial batch", "prepared checkpoint revision"])("partial native landing continues the preserved worker and grouped receipt for %s", (phase) => {
    const units = ["alpha", "beta"];
    const pd = fixture(units);
    approveGroupedPlans(pd, units, "partial-native-group");
    const prepared = prepare(pd, units);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const land = (unit: string) => runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
      "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
    ]);
    const next = () => nextDirective(pd);
    const isRevision = phase === "prepared checkpoint revision";
    if (isRevision) {
      for (const unit of units) {
        writeFileSync(join(wt(pd, unit), "src", `${unit}.ts`), `export const ${unit} = 2;\n`);
        reviewRevisedSource(pd, unit);
      }
      const completed = swarm(pd, ["finalize", "--batch", "1", "--units", units.join(","),
        "--claimed", units.join(","), "--check-cmd", "git diff --check"]);
      expect(completed.code, `${completed.out}\n${completed.err}`).toBe(0);
      for (const unit of units) {
        const merged = land(unit);
        expect(merged.code, `${merged.out}\n${merged.err}`).toBe(0);
        expect(existsSync(wt(pd, unit))).toBe(false);
      }
      expect(next()).toMatchObject({
        kind: "run-stage", swarm_checkpoint: { batch: 1, units, ready: true, approved: false },
      });
      checkpointChoice(pd, units, "Request Changes");
      const rejected = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
        "swarm-checkpoint", "--action", "reject", "--batch", "1", "--units", units.join(","),
        "--session", "t344-checkpoint",
        "--user-input", "Request Changes", "--reason", "Please revise both units", "--project-dir", pd,
      ]);
      expect(rejected.code, `${rejected.out}\n${rejected.err}`).toBe(0);
      expect(next()).toMatchObject({ kind: "invoke-swarm", units, resume_existing: true });
      approveGroupedPlans(pd, units, "partial-native-revision");
      // Plan Approval alone does not finish revision preparation.
      expect(next()).toMatchObject({ kind: "invoke-swarm", units, resume_existing: true });
      const revision = prepare(pd, units, true);
      expect(revision.code, `${revision.out}\n${revision.err}`).toBe(0);
      expect(JSON.parse(revision.out).units).toMatchObject([
        { unit: "alpha", resumed: true }, { unit: "beta", resumed: true },
      ]);
    }
    const beta = wt(pd, "beta");
    const authority = resolveCodeGenerationAuthority(beta, { unit: "beta" });
    const key = {
      targetId: authority.targetId, runFloor: authority.runFloor,
      fingerprint: evaluateCodeGenerationApproval(beta, { unit: "beta" }).approvalFingerprint!,
    };
    const parentReceipt = readPlanApprovalReceipt(pd, key)!;
    const workerReceipt = readPlanApprovalReceipt(beta, key)!;
    expect(workerReceipt.batch!.members.map((member) => member.unit)).toEqual(units);
    expect(workerReceipt.delegation!.parentReceiptSha256).toBeTruthy();
    const betaStarts = starts(pd, "beta").length;
    const unchangedAuthority = () => {
      expect(readPlanApprovalReceipt(pd, key)).toEqual(parentReceipt);
      expect(readPlanApprovalReceipt(beta, key)).toEqual(workerReceipt);
      expect(starts(pd, "beta")).toHaveLength(betaStarts);
    };
    const preparedDirective = next();
    expect(preparedDirective).toMatchObject({ kind: "invoke-swarm", units });
    expect(preparedDirective).not.toHaveProperty("resume_existing");
    unchangedAuthority();
    // Pending work predates the other member's source merge and must survive
    // resume in the existing worktree, without another prepare or approval.
    const alphaValue = isRevision ? 4 : 2;
    writeFileSync(join(beta, "src", "beta.ts"), "export const beta = 3;\n");
    writeFileSync(join(wt(pd, "alpha"), "src", "alpha.ts"), `export const alpha = ${alphaValue};\n`);
    reviewRevisedSource(pd, "alpha");
    const alpha = swarm(pd, ["finalize", "--batch", "1", "--units", units.join(","),
      "--claimed", "alpha", "--check-cmd", "git diff --check"]);
    expect(alpha.code, `${alpha.out}\n${alpha.err}`).toBe(2);
    expect(JSON.parse(alpha.out)).toMatchObject({
      converged: 1, failed: 1, merge_failures: [],
      units: [
        { unit: "alpha", status: "converged" },
        { unit: "beta", status: "failed" },
      ],
    });
    expect(readAuditShardEvents(pd).some((row) => row.event === "BOLT_FAILED" &&
      auditBlockField(row.block, "Bolt slug") === boltSlugForUnit("beta"))).toBe(true);
    const landedAlpha = land("alpha");
    expect(landedAlpha.code, `${landedAlpha.out}\n${landedAlpha.err}`).toBe(0);
    expect(existsSync(wt(pd, "alpha"))).toBe(false);
    expect(readFileSync(join(pd, "src", "alpha.ts"), "utf-8")).toContain(`alpha = ${alphaValue}`);
    for (let repeat = 0; repeat < 2; repeat++) {
      const pending = next();
      expect(pending).toMatchObject({ kind: "invoke-swarm", units: ["beta"] });
      expect(pending).not.toHaveProperty("resume_existing");
      unchangedAuthority();
    }
    const parentApproval = evaluateCodeGenerationApproval(pd, { unit: "beta" });
    expect(parentApproval.ok, parentApproval.reason).toBe(true);
    const approval = evaluateCodeGenerationApproval(beta, { unit: "beta" });
    expect(approval.ok, approval.reason).toBe(true);
    expect(readCodeGenerationWorktreeSourceBaseline(beta, "beta")).not.toBeNull();
    const began = runCheckpointTool(beta, "tools/aidlc-testing-posture.ts", ["begin", "--unit", "beta"]);
    expect(began.code, `${began.out}\n${began.err}`).toBe(0);
    unchangedAuthority();
    expect(readFileSync(join(beta, "src", "beta.ts"), "utf-8")).toContain("beta = 3");
    const ran = swarm(pd, ["check", "beta"]);
    expect(ran.code, `${ran.out}\n${ran.err}`).toBe(0);
    reviewRevisedSource(pd, "beta");
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "beta",
      "--claimed", "beta"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    unchangedAuthority();
    const landedBeta = land("beta");
    expect(landedBeta.code, `${landedBeta.out}\n${landedBeta.err}`).toBe(0);
    expect(existsSync(beta)).toBe(false);
    expect(readFileSync(join(pd, "src", "alpha.ts"), "utf-8")).toContain(`alpha = ${alphaValue}`);
    expect(readFileSync(join(pd, "src", "beta.ts"), "utf-8")).toContain("beta = 3");
    expect(next()).toMatchObject({
      kind: "run-stage", swarm_checkpoint: { batch: 1, units, ready: true, approved: false },
    });
    expect(readPlanApprovalReceipt(pd, key)).toEqual(parentReceipt);
    for (const unit of units) {
      const current = evaluateCodeGenerationApproval(pd, { unit });
      expect(current.ok, current.reason).toBe(true);
    }
    checkpointChoice(pd, units, "Approve");
    const approved = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
      "swarm-checkpoint", "--action", "approve", "--batch", "1", "--units", units.join(","),
      "--session", "t344-checkpoint",
      "--user-input", "Approve", "--project-dir", pd,
    ]);
    expect(approved.code, `${approved.out}\n${approved.err}`).toBe(0);
    expect(JSON.parse(approved.out).approved).toBe(true);
  });

  test("resumes the current rejected Unit with fresh authority and preserves source, history, and peers", () => {
    const pd = fixture(["alpha", "beta"]);
    completeOld(pd, ["alpha", "beta"]);
    const child = wt(pd);
    const planPath = join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md");
    const oldPlan = readFileSync(planPath, "utf-8");
    const oldState = readFileSync(seededStateFile(child), "utf-8");
    const head = git(child, ["rev-parse", "HEAD"]);
    writeFileSync(join(child, "src", "alpha.ts"), "export const alpha = 2; // preserved work\n");
    // The retained source is actually covered by the newly reviewed baseline.
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2; // preserved work\n");
    writeFileSync(join(child, ".aidlc", "private-note.txt"), "unfinished user notes\n");
    const peerState = readFileSync(seededStateFile(wt(pd, "beta")), "utf-8");
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const resumed = prepare(pd, ["alpha"], true);
    expect(resumed.code, `${resumed.out}\n${resumed.err}`).toBe(0);
    const unit = JSON.parse(resumed.out).units[0];
    expect(unit.resumed).toBe(true);
    expect(unit.worktree_path).toBe(child);
    expect(readFileSync(join(unit.archive_path, "plan.md"), "utf-8")).toBe(oldPlan);
    expect(readFileSync(join(unit.archive_path, "state.md"), "utf-8")).toBe(oldState);
    expect(readdirSync(join(unit.archive_path, "audit")).length).toBeGreaterThan(0);
    expect(readFileSync(join(child, "src", "alpha.ts"), "utf-8")).toContain("preserved work");
    expect(readFileSync(join(child, ".aidlc", "private-note.txt"), "utf-8")).toContain("unfinished user notes");
    expect(git(child, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(seededStateFile(wt(pd, "beta")), "utf-8")).toBe(peerState);
    expect(starts(pd)).toHaveLength(2);
    expect(starts(pd, "beta")).toHaveLength(1);
    expect(readFileSync(planPath, "utf-8")).toBe(readFileSync(join(codeGenerationRecordDir(pd, "alpha"), "code-generation-plan.md"), "utf-8"));
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(true);
    expect(() => beginCodeGeneration(child, { unit: "alpha" })).not.toThrow();
    const repeat = prepare(pd, ["alpha"], true);
    expect(repeat.code, repeat.err).toBe(0);
    expect(starts(pd)).toHaveLength(2);
  });

  test("ordinary prepare creates worktrees and still refuses an existing directory", () => {
    const pd = fixture();
    const first = prepare(pd);
    expect(first.code, `${first.out}\n${first.err}`).toBe(0);
    expect(JSON.parse(first.out).units[0].worktree_path).toBe(wt(pd));
    const second = prepare(pd);
    expect(second.code).toBe(2);
    expect(second.out).toContain("already exists");
    expect(starts(pd)).toHaveLength(1);
  });

  test("no checkpoint rejection means no implicit reuse", () => {
    const pd = fixture();
    completeOld(pd);
    const before = readFileSync(seededStateFile(wt(pd)), "utf-8");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("Request Changes");
    expect(readFileSync(seededStateFile(wt(pd)), "utf-8")).toBe(before);
    expect(starts(pd)).toHaveLength(1);
  });

  test("rejection requires a fresh human-backed Plan Approval before any re-fork", () => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    const before = readFileSync(seededStateFile(wt(pd)), "utf-8");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("approved Code Generation plan");
    expect(readFileSync(seededStateFile(wt(pd)), "utf-8")).toBe(before);
    expect(starts(pd)).toHaveLength(1);
  });

  test("unreviewed dirty source is refused before any re-fork and remains intact", () => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const child = wt(pd);
    const source = join(child, "src", "alpha.ts");
    writeFileSync(source, "export const alpha = 99; // private WIP\n");
    writeFileSync(join(child, ".aidlc", "private-note.txt"), "keep this note\n");
    const beforeState = readFileSync(seededStateFile(child), "utf-8");
    const beforePlan = readFileSync(join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md"), "utf-8");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("dirty or untracked source");
    expect(readFileSync(source, "utf-8")).toContain("private WIP");
    expect(readFileSync(join(child, ".aidlc", "private-note.txt"), "utf-8")).toBe("keep this note\n");
    expect(readFileSync(seededStateFile(child), "utf-8")).toBe(beforeState);
    expect(readFileSync(join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md"), "utf-8")).toBe(beforePlan);
    expect(existsSync(join(recordDir(child)!, ".aidlc-swarm-resumes"))).toBe(false);
    expect(starts(pd)).toHaveLength(1);
  });

  test("a clean worktree fast-forwards to approved parent source and retains ignored notes", () => {
    const pd = fixture(["alpha", "beta"], "git diff --quiet -- src/beta.ts");
    completeOld(pd, ["alpha", "beta"]);
    const child = wt(pd);
    const oldHead = git(child, ["rev-parse", "HEAD"]);
    writeFileSync(join(child, ".aidlc", "private-note.txt"), "keep this note\n");
    writeFileSync(join(pd, "src", "beta.ts"), "export const beta = 2;\n");
    git(pd, ["add", "src/beta.ts"]);
    git(pd, ["commit", "-qm", "approved peer source"]);
    const parentHead = git(pd, ["rev-parse", "HEAD"]);
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    expect(git(child, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(git(child, ["merge-base", "--is-ancestor", oldHead, parentHead])).toBe("");
    expect(readFileSync(join(child, "src", "beta.ts"), "utf-8")).toBe("export const beta = 2;\n");
    expect(readFileSync(join(child, ".aidlc", "private-note.txt"), "utf-8")).toBe("keep this note\n");
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(true);
    // The synchronized peer is baseline source, not a write attributed to alpha.
    writeFileSync(join(child, "src", "alpha.ts"), "export const alpha = 3;\n");
    reviewRevisedSource(pd);
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha", "--check-cmd", "git diff --quiet -- src/beta.ts"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
  });

  test("initial prepare retains grouped parent authority and a changed peer plan invalidates the child", () => {
    const pd = fixture(["alpha", "beta"]);
    const units = ["alpha", "beta"].map((unit) => ({ unit, questionsFile: plan(pd, unit, "group") }));
    const file = join(recordDir(pd)!, "group-plan.json");
    writeFileSync(file, JSON.stringify({ batch: "group", units }));
    const identity = ["--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval", "--batch-file", "group-plan.json", "--session", "group"];
    const decision = runCheckpointTool(pd, "tools/aidlc-log.ts", [
      "decision", ...identity, "--decision", "Approve both plans?", "--options", "Approve Plans,Request Changes",
    ]);
    expect(decision.code, decision.err).toBe(0);
    const human = runCheckpointTool(pd, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"], {
      hook_event_name: "UserPromptSubmit", session_id: "group", prompt: "Approve Plans",
    });
    expect(human.code).toBe(0);
    for (const entry of units) {
      writeFileSync(entry.questionsFile, readFileSync(entry.questionsFile, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
    }
    const answer = runCheckpointTool(pd, "tools/aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plans"]);
    expect(answer.code, answer.err).toBe(0);
    const result = prepare(pd, ["alpha", "beta"]);
    expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    const child = wt(pd);
    const approval = evaluateCodeGenerationApproval(child, { unit: "alpha" });
    expect(approval.ok, approval.reason).toBe(true);
    const authority = resolveCodeGenerationAuthority(child, { unit: "alpha" });
    const receipt = readPlanApprovalReceipt(child, {
      targetId: authority.targetId, runFloor: authority.runFloor, fingerprint: approval.approvalFingerprint!,
    })!;
    expect(receipt.batch!.members).toHaveLength(2);
    // The fixture uses portable slashes; delegation stores the native real path.
    expect(receipt.delegation!.parentProjectDir).toBe(realpathSync(pd));
    const childPlan = join(codeGenerationRecordDir(child, "alpha"), "code-generation-plan.md");
    const approvedPlan = readFileSync(childPlan, "utf-8");
    appendFileSync(childPlan, "\nUnapproved child plan change.\n");
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(false);
    expect(() => readCodeGenerationWorktreeSourceBaseline(child, "alpha")).toThrow("Delegated plan");
    writeFileSync(childPlan, approvedPlan);
    appendFileSync(join(codeGenerationRecordDir(pd, "beta"), "code-generation-plan.md"), "\nChanged reviewed peer plan.\n");
    expect(evaluateCodeGenerationApproval(child, { unit: "alpha" }).ok).toBe(false);
  });

  test.each(["intentRecord", "swarmUnit", "swarmBatch", "repoSelector"])("refuses foreign %s provenance without changing files", (field) => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const file = join(wt(pd), ".aidlc", "worktree-meta.json");
    const meta = JSON.parse(readFileSync(file, "utf-8"));
    meta[field] = "foreign";
    writeFileSync(file, JSON.stringify(meta));
    const before = readFileSync(seededStateFile(wt(pd)), "utf-8");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("provenance");
    expect(readFileSync(seededStateFile(wt(pd)), "utf-8")).toBe(before);
    expect(starts(pd)).toHaveLength(1);
  });

  test("an old stage attempt cannot be relabeled by resume", () => {
    const pd = fixture();
    completeOld(pd);
    reject(pd);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, pd);
    publish(pd, ["alpha"]);
    approvePlan(pd, "alpha", "new-attempt");
    const result = prepare(pd, ["alpha"], true);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("current");
    expect(starts(pd)).toHaveLength(1);
  });

  test("finalize requires the resumed boundary, then checks and merges the revised work", () => {
    const executable = process.platform === "win32"
      ? `"${process.execPath.replaceAll('"', '""')}"`
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const check = `${executable} -e "if (!require('fs').readFileSync('src/alpha.ts','utf8').includes('alpha = 3')) process.exit(1)"`;
    const pd = fixture(["alpha"], check);
    completeOld(pd);
    reject(pd);
    approvePlan(pd, "alpha", "revised");
    const args = ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha", "--check-cmd", check];
    const stale = swarm(pd, args);
    expect(stale.code).toBe(2);
    expect(stale.out).toContain("no stamped SWARM_STARTED");
    const resumed = prepare(pd, ["alpha"], true);
    expect(resumed.code, resumed.err).toBe(0);
    writeFileSync(join(wt(pd), "src", "alpha.ts"), "export const alpha = 3;\n");
    reviewRevisedSource(pd);
    const finalized = swarm(pd, args);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(JSON.parse(finalized.out).units[0].status).toBe("converged");
    const start = readAuditShardEvents(pd).filter((row) => row.event === "SWARM_STARTED").at(-1)!;
    expect(auditBlockField(start.block, "Resumed")).toBe("true");
    expect(JSON.parse(auditBlockField(start.block, "Resume revisions")!).alpha).toBeTruthy();
  });
});

describe("t344 Bolt worktrees carry the main checkout's submodules (#1352)", () => {
  test("prepare sets the submodule up in the worktree, and landing leaves the main checkout's submodule as it was", () => {
    const pd = fixture(["alpha"], CHECK, true);
    const registered = git(pd, ["config", "--get", "submodule.vendor/sub.url"]);
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    expect(readFileSync(join(wt(pd), "vendor", "sub", "lib.ts"), "utf-8")).toBe(SUBMODULE_SOURCE);
    writeUnitSource(pd, "alpha", 2);
    checkReviewFinalizeAndLand(pd, { alpha: 2 });
    expect(readFileSync(join(pd, "vendor", "sub", "lib.ts"), "utf-8")).toBe(SUBMODULE_SOURCE);
    expect(git(pd, ["config", "--get", "submodule.vendor/sub.url"])).toBe(registered);
    expect(git(pd, ["submodule", "status"])).toMatch(/^[0-9a-f]{40,64} vendor\/sub/);
  });

  test("a change left inside the worktree's submodule is refused, not lost", () => {
    const pd = fixture(["alpha"], CHECK, true);
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const edited = join(wt(pd), "vendor", "sub", "lib.ts");
    writeFileSync(edited, "export const lib = 2;\n");
    writeUnitSource(pd, "alpha", 2);
    const checked = swarm(pd, ["check", "alpha"]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, "alpha");
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code).not.toBe(0);
    expect(finalized.out).toContain("source manifest (vendor/sub/lib.ts)");
    const merged = runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
      "merge", "--slug", boltSlugForUnit("alpha"), "--target", "main", "--strategy", "squash", "--project-dir", pd,
    ]);
    expect(merged.code).not.toBe(0);
    expect(existsSync(wt(pd))).toBe(true);
    expect(readFileSync(edited, "utf-8")).toBe("export const lib = 2;\n");
    expect(readFileSync(join(pd, "vendor", "sub", "lib.ts"), "utf-8")).toBe(SUBMODULE_SOURCE);
  });

  test("an ordinary Bolt worktree with a submodule lands through the plain worktree removal", () => {
    const pd = fixture(["alpha"], CHECK, true);
    const registered = git(pd, ["config", "--get", "submodule.vendor/sub.url"]);
    const created = runCheckpointTool(pd, "tools/aidlc-worktree.ts", ["create", "--slug", "plain", "--base", "main", "--project-dir", pd]);
    expect(created.code, `${created.out}\n${created.err}`).toBe(0);
    const path = JSON.parse(created.out).worktree_path as string;
    expect(readFileSync(join(path, "vendor", "sub", "lib.ts"), "utf-8")).toBe(SUBMODULE_SOURCE);
    writeFileSync(join(path, "src", "plain.ts"), "export const plain = 1;\n");
    git(path, ["add", "src/plain.ts"]);
    git(path, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "plain"]);
    const merged = runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
      "merge", "--slug", "plain", "--target", "main", "--strategy", "squash", "--project-dir", pd,
    ]);
    expect(merged.code, `${merged.out}\n${merged.err}`).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(pd, "src", "plain.ts"), "utf-8")).toBe("export const plain = 1;\n");
    expect(readFileSync(join(pd, "vendor", "sub", "lib.ts"), "utf-8")).toBe(SUBMODULE_SOURCE);
    expect(git(pd, ["config", "--get", "submodule.vendor/sub.url"])).toBe(registered);
  });

  test("a submodule whose name holds '=' is set up from the main checkout's copy, never its configured URL", () => {
    const pd = fixture(["alpha"], CHECK, true);
    const sub = mkdtempSync(join(tmpdir(), "t344-submodule-eq-"));
    submoduleRepos.push(sub);
    git(sub, ["init", "-q"]);
    writeFileSync(join(sub, "eq.ts"), "export const eq = 1;\n");
    git(sub, ["add", "-A"]);
    git(sub, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "eq"]);
    git(pd, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "--name", "x=y", sub, "vendor/eq"]);
    git(pd, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "equals-named submodule"]);
    git(pd, ["config", "submodule.x=y.url", join(sub, "does-not-exist")]);
    const created = runCheckpointTool(pd, "tools/aidlc-worktree.ts", ["create", "--slug", "eq", "--base", "main", "--project-dir", pd]);
    expect(created.code, `${created.out}\n${created.err}`).toBe(0);
    const path = JSON.parse(created.out).worktree_path as string;
    expect(readFileSync(join(path, "vendor", "eq", "eq.ts"), "utf-8")).toBe("export const eq = 1;\n");
    expect(realpathSync(git(join(path, "vendor", "eq"), ["remote", "get-url", "origin"])))
      .toBe(realpathSync(join(pd, "vendor", "eq")));
  });

  test("a branch left in the worktree's submodule copy keeps the worktree and lands nothing", () => {
    const pd = fixture(["alpha"], CHECK, true);
    const created = runCheckpointTool(pd, "tools/aidlc-worktree.ts", ["create", "--slug", "plain", "--base", "main", "--project-dir", pd]);
    expect(created.code, `${created.out}\n${created.err}`).toBe(0);
    const path = JSON.parse(created.out).worktree_path as string;
    const copy = join(path, "vendor", "sub");
    const recorded = git(copy, ["rev-parse", "HEAD"]);
    git(copy, ["checkout", "-q", "-b", "scratch"]);
    writeFileSync(join(copy, "lib.ts"), "export const lib = 9;\n");
    git(copy, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qam", "private work"]);
    git(copy, ["tag", "keep"]);
    git(copy, ["checkout", "-q", "--detach", recorded]);
    writeFileSync(join(path, "src", "plain.ts"), "export const plain = 1;\n");
    git(path, ["add", "src/plain.ts"]);
    git(path, ["-c", "user.name=AI-DLC Tests", "-c", "user.email=tests@example.com", "commit", "-qm", "plain"]);
    const before = git(pd, ["rev-parse", "HEAD"]);
    const merged = runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
      "merge", "--slug", "plain", "--target", "main", "--strategy", "squash", "--project-dir", pd,
    ]);
    expect(merged.code).not.toBe(0);
    expect(`${merged.out}${merged.err}`).toContain("has work the main checkout's copy does not have (scratch, keep)");
    expect(git(pd, ["rev-parse", "HEAD"])).toBe(before);
    expect(existsSync(path)).toBe(true);
    expect(git(copy, ["rev-parse", "--verify", "scratch"])).toMatch(/^[0-9a-f]{40,64}$/);
  });
});
