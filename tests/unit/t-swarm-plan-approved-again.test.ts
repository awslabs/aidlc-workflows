// covers: subcommand:aidlc-testing-posture:verify, subcommand:aidlc-swarm:prepare, function:evaluateCodeGenerationApproval
//
// After the side-by-side build started, the person changes one Unit's plan and approves it again. That Unit's
// prepared build still holds the earlier plan, so its own check refuses. The refusal names the step that hands the
// build the approved plan (prepare again for that Unit, which transfers it to the existing build), and before the
// approval, the question that collects it first; the steps it names, run as written, let the build go on, under every
// Guard Policy.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  cleanupCheckpointFixtures, fixture, nextDirective, plan, prepare, runCheckpointTool, swarm, wt,
} from "../harness/swarm-checkpoint.ts";
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
