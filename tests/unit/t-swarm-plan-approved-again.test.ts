// covers: subcommand:aidlc-testing-posture:verify, subcommand:aidlc-swarm:prepare, function:evaluateCodeGenerationApproval
//
// After the side-by-side build started, the person changes one Unit's plan and approves it again. That Unit's
// prepared build still holds the earlier plan, so its own check refuses. The refusal names the step that hands the
// build the approved plan (prepare again for that Unit, which transfers it to the existing build), and before the
// approval, the question that collects it first; with plan approval off, that the plan is built without asking. The
// steps it names, run as written, let the build go on under every Guard Policy, in a batch rebuilt after a checkpoint
// send-back too. The same plan approved again names no prepare step: prepare hands nothing over for it.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  approvePlan, checkReviewFinalizeAndLand, cleanupCheckpointFixtures, fixture, nativeCheckpointRevision, nextDirective,
  plan, prepare, runCheckpointTool, swarm, writeUnitSource, wt,
} from "../harness/swarm-checkpoint.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const UNITS = ["alpha", "beta"];

function verifyInBuild(pd: string, unit: string): { code: number | null; ok: boolean; reason: string } {
  const child = wt(pd, unit);
  const result = runCheckpointTool(child, "tools/aidlc-testing-posture.ts", ["verify", "--unit", unit, "--project-dir", child]);
  const parsed = JSON.parse(result.out) as { execution_allowed: boolean; reason: string };
  return { code: result.code, ok: parsed.execution_allowed, reason: parsed.reason };
}

// The prepare command a refusal names, run as written from the project's main folder.
function runNamedPrepare(pd: string, reason: string) {
  const named = reason.match(/`([^`]*\bprepare --batch [^`]*)`/);
  expect(named, reason).not.toBeNull();
  return swarm(pd, ["prepare", ...named![1].replace(/^.*\bprepare /, "").split(" ")]);
}

function changedAndPrepared(): string {
  const pd = fixture(UNITS);
  const prepared = prepare(pd, UNITS);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  expect(verifyInBuild(pd, "alpha").ok).toBe(true);
  plan(pd, "alpha", "revised");
  expect(nextDirective(pd)).toMatchObject({ kind: "ask", stage: "code-generation" });
  return pd;
}

// The person's "Approve Plan" to the question the engine asked, recorded as their turn and the ask's answer.
function approveAgain(pd: string): void {
  appendAuditEntry("SESSION_STARTED", { Session: "approved-again", Source: "t-swarm-plan-approved-again" }, pd);
  const human = runCheckpointTool(pd, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: "approved-again", prompt: "Approve Plan",
  });
  expect(human.code, human.err).toBe(0);
  const answer = runCheckpointTool(pd, "tools/aidlc-log.ts", [
    "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
    "--session", "approved-again",
  ]);
  expect(answer.code, `${answer.out}\n${answer.err}`).toBe(0);
  expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm" });
}

test("a plan approved again mid-build: the build's check names prepare for that Unit, and that step hands it the plan", () => {
  const pd = changedAndPrepared();
  approveAgain(pd);
  const refused = verifyInBuild(pd, "alpha");
  expect(refused.code).toBe(2);
  expect(refused.ok).toBe(false);
  expect(refused.reason).toContain("The plan for alpha was approved again after its build was prepared");
  expect(refused.reason).toContain("prepare --batch 1 --units alpha`");
  expect(refused.reason).toContain("which hands this build the approved plan or says why it cannot yet");
  expect(refused.reason).not.toContain("orchestrate");
  expect(verifyInBuild(pd, "beta").ok).toBe(true);
  const handed = runNamedPrepare(pd, refused.reason);
  expect(handed.code, `${handed.out}\n${handed.err}`).toBe(0);
  expect(JSON.parse(handed.out).units).toEqual([
    expect.objectContaining({ unit: "alpha", ok: true, retained: true, approval_transferred: true }),
  ]);
  expect(verifyInBuild(pd, "alpha").ok).toBe(true);
  const childPlan = readFileSync(join(codeGenerationRecordDir(wt(pd, "alpha"), "alpha"), "code-generation-plan.md"), "utf-8");
  expect(childPlan).toContain("revised");
});

test("a plan changed mid-build and not approved yet: the build's check names the question first, then prepare", () => {
  const pd = changedAndPrepared();
  const refused = verifyInBuild(pd, "alpha");
  expect(refused.code).toBe(2);
  expect(refused.reason).toContain("The plan for alpha changed after its build was prepared and is not approved yet");
  expect(refused.reason).toMatch(/orchestrate[^`]* next`/);
  expect(refused.reason).toContain("prepare --batch 1 --units alpha`");
  // Prepare before the approval is refused by prepare itself, so the order the refusal gives is the one that works.
  const early = runNamedPrepare(pd, refused.reason);
  expect(early.code).not.toBe(0);
  expect(`${early.out}\n${early.err}`).toContain("explicitly approved Code Generation plan");
});

// With plan approval off for the work the changed plan is built without asking: the refusal says so, never that the
// person approved it, and the step it names hands the build the current plan.
test("plan approval off: a plan changed mid-build is said as built without asking, and the named step hands it over", () => {
  const pd = fixture(UNITS);
  const prepared = prepare(pd, UNITS);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  const state = seededStateFile(pd);
  writeFileSync(state, readFileSync(state, "utf-8")
    .replace("- **Change Control**: strict\n", "- **Change Control**: strict\n- **Plan Approval**: off (set by you)\n"));
  expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm" });
  plan(pd, "alpha", "revised");
  expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm" });
  const refused = verifyInBuild(pd, "alpha");
  expect(refused.code).toBe(2);
  expect(refused.reason).toContain("plan approval is off for this work");
  expect(refused.reason).not.toContain("approved again");
  const handed = runNamedPrepare(pd, refused.reason);
  expect(handed.code, `${handed.out}\n${handed.err}`).toBe(0);
  expect(JSON.parse(handed.out).units).toEqual([
    expect.objectContaining({ unit: "alpha", ok: true, approval_transferred: true }),
  ]);
  expect(verifyInBuild(pd, "alpha").ok).toBe(true);
});

// A lowered Guard Policy changes none of it: the changed plan is asked for again, and once the person approves it
// the step the refusal names hands it to the build.
test.each(["relaxed", "off"])("Guard Policy %s: the steps a plan changed mid-build names are the ones that let it go on", (policy) => {
  const pd = fixture(UNITS, undefined, false, null, policy);
  const prepared = prepare(pd, UNITS);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  plan(pd, "alpha", "revised");
  const refused = verifyInBuild(pd, "alpha");
  expect(refused.reason).toContain("is not approved yet");
  expect(refused.reason).not.toContain("approved again");
  expect(nextDirective(pd)).toMatchObject({ kind: "ask", ask_type: "plan-approval", unit: "alpha" });
  approveAgain(pd);
  const handed = runNamedPrepare(pd, verifyInBuild(pd, "alpha").reason);
  expect(handed.code, `${handed.out}\n${handed.err}`).toBe(0);
  expect(verifyInBuild(pd, "alpha").ok).toBe(true);
});

// After a checkpoint send-back the build was resumed. A plan approved again in that build is handed to it by the
// step the refusals name, in order (prepare, then prepare --resume-existing), as for a build prepared in this
// attempt; a second run hands nothing over, and the batch then lands with the plan the person approved last.
test("a plan approved again in a resumed checkpoint revision: the steps the refusals name hand it to the build", () => {
  const pd = nativeCheckpointRevision(UNITS, false);
  plan(pd, "alpha", "third");
  expect(nextDirective(pd)).toMatchObject({ kind: "ask", stage: "code-generation" });
  approveAgain(pd);
  const refused = verifyInBuild(pd, "alpha");
  expect(refused.reason).toContain("which hands this build the approved plan or says why it cannot yet");
  const named = runNamedPrepare(pd, refused.reason);
  expect(named.code).not.toBe(0);
  expect(`${named.out}\n${named.err}`).toContain("Re-run prepare with --resume-existing");
  const handed = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--resume-existing"]);
  expect(handed.code, `${handed.out}\n${handed.err}`).toBe(0);
  expect(JSON.parse(handed.out).units).toEqual([
    expect.objectContaining({ unit: "alpha", ok: true, resumed: true, approval_transferred: true }),
  ]);
  expect(verifyInBuild(pd, "alpha").ok).toBe(true);
  const childPlan = readFileSync(join(codeGenerationRecordDir(wt(pd, "alpha"), "alpha"), "code-generation-plan.md"), "utf-8");
  expect(childPlan).toContain("third");
  const again = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--resume-existing"]);
  expect(again.code, `${again.out}\n${again.err}`).toBe(0);
  expect(JSON.parse(again.out).units[0].approval_transferred).toBeUndefined();
  for (const unit of UNITS) writeUnitSource(pd, unit, 3);
  checkReviewFinalizeAndLand(pd, { alpha: 3, beta: 3 });
});

// A resumed build already holds work of its own (the worker wrote source before the plan changed), so the approved
// plan cannot be handed to it in place. Its line names only the way that works there: set the work aside (it is parked
// and can be restored) and prepare again, which builds the plan the person approved.
test("a resumed build with work of its own: the line names the way that works, and that way builds the approved plan", () => {
  const pd = nativeCheckpointRevision(UNITS, false);
  writeUnitSource(pd, "alpha", 4);
  plan(pd, "alpha", "third");
  expect(nextDirective(pd)).toMatchObject({ kind: "ask", stage: "code-generation" });
  approveAgain(pd);
  const kept = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--resume-existing"]);
  expect(kept.code).toBe(2);
  const [row] = JSON.parse(kept.out).units as Array<{ ok: boolean; error: string }>;
  expect(row.ok).toBe(false);
  expect(row.error).toContain("The build and its work are kept.");
  expect(row.error).toContain("set this Unit's current work aside (abort and discard it)");
  expect(row.error).not.toContain("land it as it is");
  const aborted = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "abort", "--name", "alpha", "--slug", "alpha", "--reason", "set aside for the plan approved again", "--discard", "--project-dir", pd,
  ]);
  expect(aborted.code, `${aborted.out}\n${aborted.err}`).toBe(0);
  const rebuilt = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--resume-existing"]);
  expect(rebuilt.code, `${rebuilt.out}\n${rebuilt.err}`).toBe(0);
  expect(verifyInBuild(pd, "alpha").ok).toBe(true);
  const childPlan = readFileSync(join(codeGenerationRecordDir(wt(pd, "alpha"), "alpha"), "code-generation-plan.md"), "utf-8");
  expect(childPlan).toContain("third");
});

test("a plan changed in a resumed checkpoint revision and not approved yet is not handed to the build", () => {
  const pd = nativeCheckpointRevision(UNITS, false);
  plan(pd, "alpha", "third");
  const refused = swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--resume-existing"]);
  expect(refused.code).not.toBe(0);
  expect(`${refused.out}\n${refused.err}`).toContain("explicitly approved Code Generation plan");
  expect(verifyInBuild(pd, "alpha").ok).toBe(false);
  const childPlan = readFileSync(join(codeGenerationRecordDir(wt(pd, "alpha"), "alpha"), "code-generation-plan.md"), "utf-8");
  expect(childPlan).not.toContain("third");
});

// The same plan approved again (only the source it was planned against moved) is no plan prepare hands over, so the
// check names no prepare step there: it keeps the sentence it always had, rather than a step that changes nothing.
test("the same plan approved again after the main folder's code moved names no prepare step", () => {
  const pd = fixture(UNITS);
  const prepared = prepare(pd, UNITS);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  writeFileSync(join(pd, "src", "peer.ts"), "export const peer = 1;\n");
  approvePlan(pd, "alpha");
  const refused = verifyInBuild(pd, "alpha");
  expect(refused.code).toBe(2);
  expect(refused.reason).toBe("Protected parent Plan Approval or the delegated worktree baseline is no longer current.");
});
