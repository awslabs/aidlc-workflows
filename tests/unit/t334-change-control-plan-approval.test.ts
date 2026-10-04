// covers: function:codeGenerationPlanApprovalQuestionEvidence, function:recordPlanApprovalReceipt,
// function:beginCodeGeneration, function:evaluateCodeGenerationApproval,
// function:recordAcceptedChanges, function:changeAlreadyAccepted,
// function:writeWorkspaceSourceSnapshot, function:readWorkspaceSourceSnapshot,
// function:workspaceSourceChangedPaths, function:sourceListingChangedPaths,
// subcommand:aidlc-log:decision, subcommand:aidlc-log:answer,
// subcommand:aidlc-testing-posture:fingerprint, subcommand:aidlc-testing-posture:begin,
// hook:aidlc-plan-approval-guard, audit:CHANGE_ACCEPTED, function:workerBrief,
// function:codeGenerationExecutionAllowed, subcommand:aidlc-testing-posture:brief,
// subcommand:aidlc-testing-posture:verify, audit:GUARD_STOOD_ASIDE
//
// t334 - Guard Policy at the Plan Approval checkpoint. The plan binds to the
// workspace source it was written against. When that source moves while the
// human is about to approve (the recorded decision and answer), `strict`
// refuses with the remedy and `relaxed` records one CHANGE_ACCEPTED row naming
// the files, tells the human once, and re-baselines the recorded source. Once
// the human approved, other code moving is never a reason to ask again on any
// policy: generation start records one row, says once which files moved, and
// builds. The content members (plan, instructions, Testing Contract) must still
// match when recording the human's answer. After approval, a lowered
// plan-approval fence permits changed content through the hook, begin, and
// brief without rewriting the human's approval. An enabled fence still requires
// current approval.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField,
  readAuditShardEvents,
  readPlanApprovalReceipt,
  sessionsDir,
  workspaceSourceFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  parseTestingContract,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPostureFromSections,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  seededAuditShard,
  seededRecordDir,
} from "../harness/fixtures.ts";
import {
  acceptedRows,
  answer,
  approvalRows,
  begin,
  brief,
  BUN,
  changeNotices,
  cleanupChangeControlProjects,
  createProject,
  decide,
  driftNotice,
  GUARD,
  hookDrops,
  humanTurn,
  type Mode,
  movedNotice,
  nonErrorEvents,
  plannedSourceTag,
  POSTURE,
  presentPlan,
  receiptFiles,
  recordFiles,
  runChangeControlTool,
  startSession,
} from "../harness/change-control-plan-approval.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterAll(cleanupChangeControlProjects, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

describe("t334 (1) relaxed accepts source drift at the checkpoint record and re-baselines the tag", () => {
  test("drift between the fingerprint and the decision is recorded once, told once, and the tag moves", () => {
    const project = createProject("relaxed");
    const questions = presentPlan(project);
    const planned = plannedSourceTag(questions);
    writeFileSync(join(project, "src", "drifted.ts"), "export const drifted = 1;\n");
    startSession(project, "relaxed-decision");

    const decision = decide(project, questions, "relaxed-decision");
    expect(decision.code, decision.stderr).toBe(0);
    expect(changeNotices(decision.stdout)).toEqual([driftNotice("1 file", "src/drifted.ts")]);
    const rebaselined = plannedSourceTag(questions);
    expect(rebaselined).not.toBe(planned);

    const rows = acceptedRows(project);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Stage")).toBe("code-generation");
    expect(auditBlockField(rows[0].block, "Unit")).toBeNull();
    expect(auditBlockField(rows[0].block, "Checkpoint")).toBe("plan-approval");
    expect(auditBlockField(rows[0].block, "Changed")).toBe("src/drifted.ts");
    expect(auditBlockField(rows[0].block, "Recorded")).toBe(planned);
    expect(auditBlockField(rows[0].block, "Current")).toBe(rebaselined);

    // The approval then completes against the re-baselined source and generation begins.
    humanTurn(project, "relaxed-decision");
    const answered = answer(project, questions, "relaxed-decision");
    expect(answered.code, answered.stderr).toBe(0);
    expect(changeNotices(answered.stdout)).toEqual([]);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
    const started = begin(project);
    expect(started.code, started.stderr).toBe(0);
    expect(changeNotices(started.stdout)).toEqual([]);
    expect(acceptedRows(project)).toHaveLength(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t334 (1b) a decision refused for its session records no accepted drift", () => {
  // The session is checked before the evidence records accepted drift and
  // re-baselines, so the refused command leaves nothing behind but its
  // best-effort ERROR_LOGGED row, and the retry still tells the human which
  // files changed.
  for (const mode of ["relaxed", "off"] as const) {
    test(`${mode}: an invalid --session adds no audit row but the error row and leaves the questions file and snapshots unchanged`, () => {
      const project = createProject(mode);
      const questions = presentPlan(project);
      writeFileSync(join(project, "src", "drifted.ts"), "export const drifted = 1;\n");
      startSession(project, `${mode}-refused`);
      const events = nonErrorEvents(project);
      const questionsText = readFileSync(questions, "utf-8");
      const files = recordFiles(project);

      const refused = decide(project, questions, "sessionless:0123456789abcdef");
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("is the placeholder owner");
      expect(nonErrorEvents(project)).toEqual(events);
      expect(readFileSync(questions, "utf-8")).toBe(questionsText);
      expect(recordFiles(project)).toEqual(files);

      const retried = decide(project, questions, `${mode}-refused`);
      expect(retried.code, retried.stderr).toBe(0);
      expect(changeNotices(retried.stdout)).toEqual([driftNotice("1 file", "src/drifted.ts")]);
      expect(acceptedRows(project)).toHaveLength(1);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});

describe("t334 (2) relaxed accepts source drift at the answer and certifies the source found", () => {
  test("off accepts the same drift at the decision with the same one line and one row", () => {
    const project = createProject("off");
    const questions = presentPlan(project);
    const planned = plannedSourceTag(questions);
    writeFileSync(join(project, "src", "drifted.ts"), "export const drifted = 1;\n");
    startSession(project, "off-decision");
    const decision = decide(project, questions, "off-decision");
    expect(decision.code, decision.stderr).toBe(0);
    expect(changeNotices(decision.stdout)).toEqual([driftNotice("1 file", "src/drifted.ts")]);
    expect(plannedSourceTag(questions)).not.toBe(planned);
    const rows = acceptedRows(project);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Checkpoint")).toBe("plan-approval");
    expect(auditBlockField(rows[0].block, "Changed")).toBe("src/drifted.ts");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("drift between the decision and the answer records once; the receipt carries the new source and generation begins", () => {
    const project = createProject("relaxed");
    const questions = presentPlan(project);
    const planned = plannedSourceTag(questions);
    startSession(project, "relaxed-answer");
    expect(decide(project, questions, "relaxed-answer").code).toBe(0);
    humanTurn(project, "relaxed-answer");
    writeFileSync(join(project, "src", "late.ts"), "export const late = 1;\n");
    writeFileSync(join(project, "src", "base.ts"), "export const base = 2;\n");

    const answered = answer(project, questions, "relaxed-answer");
    expect(answered.code, answered.stderr).toBe(0);
    expect(changeNotices(answered.stdout)).toEqual([driftNotice("2 files", "src/base.ts, src/late.ts")]);
    // The tag is what the human saw; the receipt is what generation compares against.
    expect(plannedSourceTag(questions)).toBe(planned);
    const rows = acceptedRows(project);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Changed")).toBe("src/base.ts, src/late.ts");
    expect(auditBlockField(rows[0].block, "Recorded")).toBe(planned);

    const approval = evaluateCodeGenerationApproval(project, { unit: null });
    expect(approval.ok).toBe(true);
    const authority = resolveCodeGenerationAuthority(project, { unit: null });
    const receipt = readPlanApprovalReceipt(project, {
      targetId: authority.targetId,
      runFloor: authority.runFloor,
      fingerprint: approval.approvalFingerprint!,
    });
    expect(receipt?.certifiedSourceSha256).toBe(auditBlockField(rows[0].block, "Current") ?? "");
    expect(receipt?.plannedSourceSha256).toBe(planned);

    const started = begin(project);
    expect(started.code, started.stderr).toBe(0);
    expect(changeNotices(started.stdout)).toEqual([]);
    expect(acceptedRows(project)).toHaveLength(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t334 (3) relaxed accepts source drift at generation start and re-baselines the receipt", () => {
  test("drift after approval is accepted once through the shipped begin and dispatch guard", () => {
    const project = createProject("relaxed");
    const questions = presentPlan(project);
    startSession(project, "relaxed-begin");
    expect(decide(project, questions, "relaxed-begin").code).toBe(0);
    humanTurn(project, "relaxed-begin");
    expect(answer(project, questions, "relaxed-begin").code).toBe(0);
    const approval = evaluateCodeGenerationApproval(project, { unit: null });
    expect(approval.ok).toBe(true);
    writeFileSync(join(project, "src", "after.ts"), "export const after = 1;\n");

    // The dispatch guard re-checks the source; under relaxed it stays current.
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
    expect(acceptedRows(project)).toHaveLength(0);

    const guard = runChangeControlTool(
      [BUN, GUARD],
      project,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "aidlc-developer-agent",
          prompt: `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: sha256:${"0".repeat(64)}`,
        },
        cwd: project,
      }),
    );
    // Whatever the dispatch marker check decides, the accepted drift is the
    // same row: the hook's generation start recorded it once.
    const rowsAfterGuard = acceptedRows(project);
    const started = begin(project);
    expect(started.code, started.stderr).toBe(0);
    const rows = acceptedRows(project);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Changed")).toBe("src/after.ts");
    expect(auditBlockField(rows[0].block, "Details")).toBe(movedNotice("1 file", "src/after.ts"));
    const noticed = rowsAfterGuard.length === 1 ? guard.stdout : started.stdout;
    expect(noticed).toContain("1 file changed since this plan was approved: src/after.ts.");
    const authority = resolveCodeGenerationAuthority(project, { unit: null });
    const receipt = readPlanApprovalReceipt(project, {
      targetId: authority.targetId,
      runFloor: authority.runFloor,
      fingerprint: approval.approvalFingerprint!,
    });
    expect(receipt?.status).toBe("generation");
    expect(receipt?.certifiedSourceSha256).toBe(auditBlockField(rows[0].block, "Current") ?? "");
    // Generation has begun; the same change is never reported again.
    expect(begin(project).code).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
    expect(acceptedRows(project)).toHaveLength(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t334 (4) strict refuses drift before the answer, in the human's words, and builds after it", () => {
  test("drift before the answer refuses and names the file; re-presenting completes it", () => {
    const project = createProject("strict");
    const questions = presentPlan(project);
    startSession(project, "strict-answer");
    expect(decide(project, questions, "strict-answer").code).toBe(0);
    humanTurn(project, "strict-answer");
    writeFileSync(join(project, "src", "drifted.ts"), "export const drifted = 1;\n");
    const refused = answer(project, questions, "strict-answer");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(
      JSON.stringify({
        error:
          "1 file changed since this plan was approved: src/drifted.ts. Look them over and approve the plan again to continue.",
      }),
    );
    expect(refused.stderr).toContain(
      JSON.stringify({ remedy: "Re-run the fingerprint command and re-present the plan." }),
    );
    expect(acceptedRows(project)).toHaveLength(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);

    const again = presentPlan(project);
    startSession(project, "strict-again");
    expect(decide(project, again, "strict-again").code).toBe(0);
    humanTurn(project, "strict-again");
    expect(answer(project, again, "strict-again").code).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The floor re-baseline with NO receipt in play: the planned source went
  // stale between the fingerprint and the decision. Strict refuses the decision
  // itself (nothing is minted), and re-running the fingerprint command is the
  // whole recovery: it re-captures the source and the presentation completes.
  test("drift between the fingerprint and the decision refuses the decision; re-fingerprinting recovers without a receipt", () => {
    const project = createProject("strict");
    const questions = presentPlan(project);
    const planned = plannedSourceTag(questions);
    writeFileSync(join(project, "src", "early.ts"), "export const early = 1;\n");
    startSession(project, "strict-decision");
    const refused = decide(project, questions, "strict-decision");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("1 file changed since this plan was approved: src/early.ts.");
    expect(refused.stderr).toContain(
      JSON.stringify({ remedy: "Re-run the fingerprint command and re-present the plan." }),
    );
    // Nothing moved on disk: the tag is still the stale one, no challenge, no receipt, no row.
    expect(plannedSourceTag(questions)).toBe(planned);
    const runtimeDir = join(sessionsDir(project), "plan-approval");
    expect(existsSync(runtimeDir) ? readdirSync(runtimeDir) : []).toEqual([]);
    expect(acceptedRows(project)).toHaveLength(0);

    const again = presentPlan(project);
    expect(plannedSourceTag(again)).not.toBe(planned);
    expect(decide(project, again, "strict-decision").code).toBe(0);
    humanTurn(project, "strict-decision");
    expect(answer(project, again, "strict-decision").code).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("drift after approval builds under strict too, naming the file once", () => {
    const project = createProject("strict");
    const questions = presentPlan(project);
    startSession(project, "strict-begin");
    expect(decide(project, questions, "strict-begin").code).toBe(0);
    humanTurn(project, "strict-begin");
    expect(answer(project, questions, "strict-begin").code).toBe(0);
    writeFileSync(join(project, "src", "late.ts"), "export const late = 1;\n");
    // The approval is about the plan; other code moving does not withdraw it.
    const approval = evaluateCodeGenerationApproval(project, { unit: null });
    expect(approval.ok).toBe(true);
    const started = begin(project);
    expect(started.code, started.stderr).toBe(0);
    expect(changeNotices(started.stdout)).toEqual([movedNotice("1 file", "src/late.ts")]);
    const rows = acceptedRows(project);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Changed")).toBe("src/late.ts");
    const authority = resolveCodeGenerationAuthority(project, { unit: null });
    expect(
      readPlanApprovalReceipt(project, {
        targetId: authority.targetId,
        runFloor: authority.runFloor,
        fingerprint: approval.approvalFingerprint!,
      })?.status,
    ).toBe("generation");
    // Said once: a second start reports nothing new.
    expect(changeNotices(begin(project).stdout)).toEqual([]);
    expect(acceptedRows(project)).toHaveLength(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t334 (5) changed content or prompt before the answer cannot be recorded as human approval", () => {
  const settings: Array<{ mode: Mode; fence?: "off" }> = [
    { mode: "strict" },
    { mode: "relaxed" },
    { mode: "off" },
    { mode: "strict", fence: "off" },
  ];
  for (const { mode, fence } of settings) {
    const setting = `${mode}${fence ? " with guard.plan-approval off" : ""}`;
    test(`an answer to edited plan, instructions, or Testing Contract is refused under ${setting}`, () => {
      const project = createProject(mode, fence);
      const questions = presentPlan(project);
      startSession(project, `content-${mode}`);
      expect(decide(project, questions, `content-${mode}`).code).toBe(0);
      humanTurn(project, `content-${mode}`);
      const dir = codeGenerationRecordDir(project, null);
      const plan = join(dir, "code-generation-plan.md");
      const original = readFileSync(plan, "utf-8");
      writeFileSync(plan, original.replace("- [ ] Implement", "- [ ] Implement differently"));
      const planEdit = answer(project, questions, `content-${mode}`);
      expect(planEdit.code).not.toBe(0);
      expect(planEdit.stderr).toContain("Plan Approval fingerprint does not match");
      writeFileSync(plan, original);

      const instructions = join(dir, "unit-test-instructions.md");
      const originalInstructions = readFileSync(instructions, "utf-8");
      writeFileSync(instructions, `${originalInstructions}\nRun twice.\n`);
      const instructionsEdit = answer(project, questions, `content-${mode}`);
      expect(instructionsEdit.code).not.toBe(0);
      expect(instructionsEdit.stderr).toContain("Plan Approval fingerprint does not match");
      writeFileSync(instructions, originalInstructions);

      writeFileSync(plan, original.replace('"version": 1', '"version": 1, "note": "edited"'));
      const contractEdit = answer(project, questions, `content-${mode}`);
      expect(contractEdit.code).not.toBe(0);
      expect(contractEdit.stderr).toMatch(/Testing Contract|fingerprint does not match/);
      expect(acceptedRows(project)).toHaveLength(0);
      expect(approvalRows(project)).toHaveLength(0);
      expect(receiptFiles(project)).toEqual({});
      expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`an answer to a changed approval prompt is refused under ${setting}`, () => {
      const project = createProject(mode, fence);
      const questions = presentPlan(project);
      const session = `prompt-${mode}-${fence ?? "default"}`;
      startSession(project, session);
      const decision = decide(project, questions, session);
      expect(decision.code, decision.stderr).toBe(0);
      humanTurn(project, session);
      writeFileSync(
        questions,
        readFileSync(questions, "utf-8").replace(
          "A. Approve Plan",
          "The approval now includes additional deployment work.\nA. Approve Plan",
        ),
      );
      const refused = answer(project, questions, session);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("actual offered choice from this prompt and session");
      expect(refused.stderr).toContain("The pending question was presented for a different plan or attempt");
      expect(approvalRows(project)).toHaveLength(0);
      expect(receiptFiles(project)).toEqual({});
      expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});

describe("t334 (6) F16: lowered fences allow post-approval content edits without inventing approval", () => {
  const settings: Array<{ mode: Mode; fence?: "on" | "off"; lowered: boolean }> = [
    { mode: "strict", lowered: false },
    { mode: "relaxed", lowered: true },
    { mode: "off", lowered: true },
    { mode: "strict", fence: "off", lowered: true },
    { mode: "relaxed", fence: "on", lowered: false },
    { mode: "off", fence: "on", lowered: false },
  ];

  for (const { mode, fence, lowered } of settings) {
    for (const member of ["plan", "test instructions", "Testing Contract"] as const) {
      const setting = `${mode}${fence ? ` with guard.plan-approval ${fence}` : ""}`;
      test(`${setting} ${lowered ? "permits" : "blocks"} ${member} edits after a real approval`, () => {
        const project = createProject(mode, fence);
        const questions = presentPlan(project);
        const session = `f16-${mode}-${fence ?? "default"}-${member.replaceAll(" ", "-")}`;
        startSession(project, session);
        const decision = decide(project, questions, session);
        expect(decision.code, decision.stderr).toBe(0);
        humanTurn(project, session);
        const answered = answer(project, questions, session);
        expect(answered.code, answered.stderr).toBe(0);

        const approval = evaluateCodeGenerationApproval(project, { unit: null });
        expect(approval.ok, approval.reason).toBe(true);
        const authority = resolveCodeGenerationAuthority(project, { unit: null });
        const receiptKey = {
          targetId: authority.targetId,
          runFloor: authority.runFloor,
          fingerprint: approval.approvalFingerprint!,
        };
        const receipt = readPlanApprovalReceipt(project, receiptKey);
        if (!receipt) throw new Error("The fixture did not record its real Plan Approval receipt");
        expect(receipt?.status).toBe("approved");
        expect(receipt?.choice).toBe("Approve Plan");
        expect(receipt?.session).toBe(session);
        expect(receipt?.override).toBeUndefined();
        const receiptsBefore = receiptFiles(project);
        expect(Object.keys(receiptsBefore)).toHaveLength(1);
        const approvalsBefore = approvalRows(project);
        expect(approvalsBefore).toHaveLength(1);
        const questionsBefore = readFileSync(questions, "utf-8");

        // Approve first, then change exactly one content member. The contract
        // edit remains valid JSON with its own correct hash, so it exercises
        // changed testing requirements rather than a broken contract parser.
        const dir = codeGenerationRecordDir(project, null);
        const planPath = join(dir, "code-generation-plan.md");
        const instructionsPath = join(dir, "unit-test-instructions.md");
        const planBefore = readFileSync(planPath, "utf-8");
        const instructionsBefore = readFileSync(instructionsPath, "utf-8");
        let changedText: string;
        let contractHash = approval.contractHash!;
        if (member === "plan") {
          changedText = "- [ ] Implement the revised behavior";
          writeFileSync(planPath, planBefore.replace("- [ ] Implement", changedText));
        } else if (member === "test instructions") {
          changedText = "Run the revised unit test suite twice.";
          writeFileSync(instructionsPath, `${instructionsBefore}\n${changedText}\n`);
        } else {
          const contract = parseTestingContract(planBefore);
          expect(contract).not.toBeNull();
          changedText = "Run the revised unit test suite twice.";
          const changedContract = resolveTestingPostureFromSections(
            { project: changedText },
            {
              scope: contract!.scope,
              testStrategy: contract!.test_strategy,
              projectType: contract!.project_type,
            },
          );
          contractHash = changedContract.contract_sha256;
          expect(contractHash).not.toBe(contract!.contract_sha256);
          writeFileSync(
            planPath,
            planBefore.replace(renderTestingContract(contract!), renderTestingContract(changedContract)),
          );
          expect(parseTestingContract(readFileSync(planPath, "utf-8"))).toEqual(changedContract);
        }
        const currentPlan = readFileSync(planPath, "utf-8");
        const currentInstructions = readFileSync(instructionsPath, "utf-8");
        if (member === "test instructions") {
          expect(currentPlan).toBe(planBefore);
          expect(currentInstructions).not.toBe(instructionsBefore);
        } else {
          expect(currentPlan).not.toBe(planBefore);
          expect(currentInstructions).toBe(instructionsBefore);
        }

        const assertApprovalUnchanged = () => {
          // Continuing by policy is not a new Approve Plan answer. Only the
          // original receipt's execution status may advance to generation;
          // every approval field and its audit row remain unchanged.
          expect(readFileSync(questions, "utf-8")).toBe(questionsBefore);
          expect(Object.keys(receiptFiles(project))).toEqual(Object.keys(receiptsBefore));
          const currentReceipt = readPlanApprovalReceipt(project, receiptKey);
          if (!currentReceipt) throw new Error("Continuation removed the original Plan Approval receipt");
          expect(currentReceipt?.status).toMatch(/^(approved|generation)$/);
          expect(currentReceipt).toEqual({
            ...receipt,
            status: lowered ? currentReceipt.status : "approved",
          });
          expect(approvalRows(project)).toEqual(approvalsBefore);
          const current = evaluateCodeGenerationApproval(project, { unit: null });
          expect(current.ok, current.reason).toBe(false);
          expect(current.reason).toMatch(/fingerprint does not match|Testing Contract/);
        };
        assertApprovalUnchanged();

        // verify exposes execution permission separately from approval
        // currentness; the lowered policy must not turn stale content into ok.
        const checkVerification = () => {
          const verified = runChangeControlTool(
            [BUN, POSTURE, "verify", "--stage-level", "--project-dir", project],
            project,
          );
          expect(verified.code, verified.stderr).toBe(lowered ? 0 : 2);
          const result = JSON.parse(verified.stdout);
          expect(result.ok).toBe(false);
          expect(result.execution_allowed).toBe(lowered);
          if (lowered) {
            expect(result.reason).toContain("without a new approval");
            expect(result.approval_reason).toMatch(/fingerprint does not match|Testing Contract/);
          } else {
            expect(result.reason).toMatch(/fingerprint does not match|Testing Contract/);
          }
          assertApprovalUnchanged();
        };
        checkVerification();
        expect(readPlanApprovalReceipt(project, receiptKey)?.status).toBe("approved");

        const stoodAsideRows = () => readAuditShardEvents(project).filter(
          (entry) => entry.event === "GUARD_STOOD_ASIDE" &&
            auditBlockField(entry.block, "Guard") === "plan-approval",
        );
        const checkHook = (tool: "Write" | "Task", input: Record<string, string>) => {
          const rowsBefore = stoodAsideRows().length;
          const guarded = runChangeControlTool([BUN, GUARD], project, JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: tool,
            tool_input: input,
            session_id: session,
            cwd: project,
          }));
          expect(
            guarded.code,
            `${guarded.stderr}\n${guarded.stdout}\n${hookDrops(project)}`,
          ).toBe(lowered ? 0 : 2);
          if (lowered) {
            expect(guarded.stdout).toContain("Continuing past the plan-approval check");
            expect(guarded.stderr).not.toContain('"ask_type":"guard-recovery"');
            const rows = stoodAsideRows();
            expect(rows).toHaveLength(rowsBefore + 1);
            const row = rows[rows.length - 1];
            expect(auditBlockField(row.block, "Stage")).toBe("code-generation");
            expect(auditBlockField(row.block, "Tool")).toBe(tool);
            expect(auditBlockField(row.block, "Details")).toContain(
              tool === "Write" ? "<project-dir>/src/base.ts" : "aidlc-developer-agent",
            );
          } else {
            expect(guarded.stderr).toMatch(/fingerprint does not match|Testing Contract/);
            expect(guarded.stdout).not.toContain("Continuing past");
            expect(stoodAsideRows()).toHaveLength(0);
          }
          assertApprovalUnchanged();
        };

        // Test an actual workspace write target; the hook is consulted without
        // performing the write, so this case contains no source-drift confound.
        checkHook("Write", {
          file_path: join(project, "src", "base.ts"),
          content: "export const base = 2;\n",
        });

        // A brief must work before begin as well as at worker dispatch. Use its
        // real current-contract marker instead of a deliberately invalid marker.
        const beforeBrief = stoodAsideRows().length;
        const handoff = brief(project);
        if (lowered) {
          expect(handoff.code, handoff.stderr).toBe(0);
          expect(handoff.stdout).toContain("AIDLC-STAGE: code-generation");
          expect(handoff.stdout).toContain(`AIDLC-TESTING-CONTRACT: ${contractHash}`);
          expect(handoff.stdout).toContain(changedText);
          expect(handoff.stdout).toContain(currentInstructions);
          expect(handoff.stdout).toContain("## Current plan (plan-approval fence off)");
          expect(handoff.stdout).toContain("## Current unit-test instructions");
          expect(handoff.stdout).not.toContain("## Approved plan");
          expect(handoff.stdout).not.toContain("## Approved unit-test instructions");
          expect(handoff.stderr).toContain("Continuing past the plan-approval check");
          expect(stoodAsideRows()).toHaveLength(beforeBrief + 1);
          const row = stoodAsideRows()[beforeBrief];
          expect(auditBlockField(row.block, "Tool")).toBe("testing-posture brief");
          expect(auditBlockField(row.block, "Stage")).toBe("code-generation");
        } else {
          expect(handoff.code).not.toBe(0);
          expect(handoff.stderr).toMatch(/fingerprint does not match|Testing Contract/);
          expect(handoff.stdout).toBe("");
          expect(stoodAsideRows()).toHaveLength(0);
        }
        assertApprovalUnchanged();
        checkHook("Task", {
          subagent_type: "aidlc-developer-agent",
          prompt: lowered ? handoff.stdout :
            `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: ${contractHash}\n\n${currentPlan}\n${currentInstructions}`,
        });

        const beforeBegin = stoodAsideRows().length;
        const started = begin(project);
        if (lowered) {
          expect(started.code, started.stderr).toBe(0);
          expect(JSON.parse(started.stdout.trim().split("\n").pop() ?? "{}").status).toBe("generation");
          const notices = changeNotices(started.stdout);
          expect(notices).toHaveLength(1);
          expect(notices[0]).toContain("Continuing past the plan-approval check");
          expect(stoodAsideRows()).toHaveLength(beforeBegin + 1);
          const row = stoodAsideRows()[beforeBegin];
          expect(auditBlockField(row.block, "Tool")).toBe("testing-posture begin");
          expect(auditBlockField(row.block, "Stage")).toBe("code-generation");
        } else {
          expect(started.code).not.toBe(0);
          expect(started.stderr).toMatch(/fingerprint does not match|Testing Contract/);
          expect(stoodAsideRows()).toHaveLength(0);
        }
        assertApprovalUnchanged();
        expect(readPlanApprovalReceipt(project, receiptKey)?.status).toBe(lowered ? "generation" : "approved");
        checkVerification();
        expect(acceptedRows(project)).toHaveLength(0);
        expect(readFileSync(join(project, "src", "base.ts"), "utf-8")).toBe("export const base = 1;\n");
        const blockedRows = readAuditShardEvents(project).filter(
          (entry) => entry.event === "PLAN_APPROVAL_BLOCKED",
        );
        expect(blockedRows).toHaveLength(lowered ? 0 : 2);
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }
  }

  test("a lowered fence still needs executable contract fields, not just a valid digest", () => {
    const project = createProject("off");
    const questions = presentPlan(project);
    const session = "f16-invalid-contract-shape";
    startSession(project, session);
    expect(decide(project, questions, session).code).toBe(0);
    humanTurn(project, session);
    expect(answer(project, questions, session).code).toBe(0);
    const approvalsBefore = approvalRows(project);
    const receiptsBefore = receiptFiles(project);
    const planPath = join(codeGenerationRecordDir(project, null), "code-generation-plan.md");
    const plan = readFileSync(planPath, "utf-8");
    const contract = parseTestingContract(plan)!;
    const body = { version: 1 };
    const malformed = {
      ...body,
      contract_sha256: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
    };
    writeFileSync(planPath, plan.replace(
      renderTestingContract(contract),
      `## Testing Contract\n\n\`\`\`json\n${JSON.stringify(malformed, null, 2)}\n\`\`\`\n`,
    ));
    expect(parseTestingContract(readFileSync(planPath, "utf-8"))).not.toBeNull();
    const verified = runChangeControlTool([BUN, POSTURE, "verify", "--stage-level", "--project-dir", project], project);
    expect(verified.code).toBe(2);
    expect(JSON.parse(verified.stdout).execution_allowed).toBe(false);
    expect(JSON.parse(verified.stdout).reason).toContain("Repair");
    expect(begin(project).code).not.toBe(0);
    expect(brief(project).code).not.toBe(0);
    expect(approvalRows(project)).toEqual(approvalsBefore);
    expect(receiptFiles(project)).toEqual(receiptsBefore);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t334 F20 combined content and source changes", () => {
  for (const mode of ["relaxed", "off", "strict"] as const) {
    for (const route of ["begin", "dispatch", "write"] as const) {
      test(`${mode} ${route} records source drift without approving changed content`, () => {
        const project = createProject(mode, mode === "strict" ? "off" : undefined);
        const questions = presentPlan(project);
        const session = `combined-${mode}-${route}`;
        startSession(project, session);
        expect(decide(project, questions, session).code).toBe(0);
        humanTurn(project, session);
        expect(answer(project, questions, session).code).toBe(0);
        const approval = evaluateCodeGenerationApproval(project, { unit: null });
        expect(approval.ok, approval.reason).toBe(true);
        const authority = resolveCodeGenerationAuthority(project, { unit: null });
        const key = {
          targetId: authority.targetId, runFloor: authority.runFloor,
          fingerprint: approval.approvalFingerprint!,
        };
        const original = readPlanApprovalReceipt(project, key)!;
        const approvals = approvalRows(project);
        const receipts = receiptFiles(project);
        const originalQuestions = readFileSync(questions, "utf-8");
        const dir = codeGenerationRecordDir(project, null);
        const planPath = join(dir, "code-generation-plan.md");
        const plan = readFileSync(planPath, "utf-8");
        if (route === "begin") {
          writeFileSync(planPath, `${plan}\n- [ ] Implement the revised behavior.\n`);
        } else if (route === "dispatch") {
          writeFileSync(join(dir, "unit-test-instructions.md"), "# Revised tests\n\nVerify the new behavior twice.\n");
        } else {
          const contract = parseTestingContract(plan)!;
          const changed = resolveTestingPostureFromSections({ project: "Verify the new behavior twice." }, {
            scope: contract.scope, testStrategy: contract.test_strategy, projectType: contract.project_type,
          });
          writeFileSync(planPath, plan.replace(renderTestingContract(contract), renderTestingContract(changed)));
        }
        writeFileSync(join(project, "src", "changed.ts"), "export const changed = true;\n");
        const source = workspaceSourceFingerprint(project);
        if (source === null) throw new Error("Combined-drift fixture source must be bindable");
        expect(source).not.toBe(original.certifiedSourceSha256);

        const verified = runChangeControlTool([BUN, POSTURE, "verify", "--stage-level", "--project-dir", project], project);
        expect(verified.code, verified.stderr).toBe(0);
        expect(JSON.parse(verified.stdout)).toMatchObject({ ok: false, execution_allowed: true });
        expect(JSON.parse(verified.stdout).change_notices).toHaveLength(1);
        expect(JSON.parse(verified.stdout).change_notices[0]).toContain("src/changed.ts");
        expect(acceptedRows(project)).toHaveLength(0);
        expect(receiptFiles(project)).toEqual(receipts);

        let output: string;
        if (route === "begin") {
          const result = begin(project);
          expect(result.code, result.stderr).toBe(0);
          output = result.stdout;
        } else {
          const handoff = brief(project);
          expect(handoff.code, handoff.stderr).toBe(0);
          const result = runChangeControlTool([BUN, GUARD], project, JSON.stringify({
            hook_event_name: "PreToolUse", session_id: session, cwd: project,
            tool_name: route === "dispatch" ? "Task" : "Write",
            tool_input: route === "dispatch"
              ? { subagent_type: "aidlc-developer-agent", prompt: handoff.stdout }
              : { file_path: join(project, "src", "base.ts"), content: "export const base = 2;\n" },
          }));
          expect(result.code, `${result.stderr}\n${hookDrops(project)}`).toBe(0);
          output = result.stdout;
        }
        expect(output).toContain("1 file changed since this plan was approved: src/changed.ts.");
        const rows = acceptedRows(project);
        expect(rows).toHaveLength(1);
        expect(auditBlockField(rows[0].block, "Changed")).toBe("src/changed.ts");
        expect(auditBlockField(rows[0].block, "Current")).toBe(source);
        expect(readPlanApprovalReceipt(project, key)).toEqual({
          ...original, certifiedSourceSha256: source, status: "generation",
        });
        expect(approvalRows(project)).toEqual(approvals);
        expect(readFileSync(questions, "utf-8")).toBe(originalQuestions);
        expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
        expect(begin(project).code).toBe(0);
        expect(acceptedRows(project)).toHaveLength(1);
        const repeated = runChangeControlTool([BUN, POSTURE, "verify", "--stage-level", "--project-dir", project], project);
        expect(repeated.code, repeated.stderr).toBe(0);
        expect(JSON.parse(repeated.stdout).change_notices).toBeUndefined();
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }
  }
});

describe("t334 F20 provenance failures do not reopen or bypass the lowered approval fence", () => {
  const unbindable = { AIDLC_TEST_SOURCE_MAX_ENTRIES: "1" };
  for (const mode of ["relaxed", "off", "strict"] as const) {
    for (const edited of [false, true]) {
      test(`${mode}, content ${edited ? "edited" : "unchanged"}: unbindable source blocks execution until repaired`, () => {
        const project = createProject(mode, mode === "strict" ? "off" : undefined);
        const questions = presentPlan(project);
        const session = `unbound-${mode}-${edited}`;
        startSession(project, session);
        expect(decide(project, questions, session).code).toBe(0);
        humanTurn(project, session);
        expect(answer(project, questions, session).code).toBe(0);
        const originalQuestions = readFileSync(questions, "utf-8");
        const approvals = approvalRows(project);
        const receipts = receiptFiles(project);
        const statePath = join(seededRecordDir(project), "aidlc-state.md");
        const state = readFileSync(statePath, "utf-8");
        const plan = join(codeGenerationRecordDir(project, null), "code-generation-plan.md");
        if (edited) writeFileSync(plan, `${readFileSync(plan, "utf-8")}\n- [ ] Revised work.\n`);
        const handoff = brief(project);
        expect(handoff.code, handoff.stderr).toBe(0);

        const verified = runChangeControlTool([BUN, POSTURE, "verify", "--stage-level", "--project-dir", project], project, undefined, unbindable);
        expect(verified.code, verified.stderr).toBe(2);
        expect(JSON.parse(verified.stdout)).toMatchObject({ ok: false, execution_allowed: false });
        expect(JSON.parse(verified.stdout).reason).toContain("workspace source cannot be bound");
        expect(JSON.parse(verified.stdout).reason).not.toContain("approve the plan again");
        for (const command of ["begin", "brief"]) {
          const result = runChangeControlTool([BUN, POSTURE, command, "--stage-level", "--project-dir", project], project, undefined, unbindable);
          expect(result.code).not.toBe(0);
          expect(result.stderr).toContain("workspace source cannot be bound");
          expect(result.stdout).toBe("");
        }
        for (const [tool, input] of [
          ["Write", { file_path: join(project, "src/base.ts"), content: "export const base = 2;\n" }],
          ["Task", { subagent_type: "aidlc-developer-agent", prompt: handoff.stdout }],
        ] as const) {
          const guarded = runChangeControlTool([BUN, GUARD], project, JSON.stringify({
            hook_event_name: "PreToolUse", session_id: session, cwd: project,
            tool_name: tool, tool_input: input,
          }), unbindable);
          expect(guarded.code, `${guarded.stdout}\n${guarded.stderr}`).toBe(2);
          expect(guarded.stderr).toContain("CODE_GENERATION_PROVENANCE_UNAVAILABLE");
          expect(guarded.stderr).toContain("workspace source cannot be bound");
          expect(guarded.stdout).not.toContain("Continuing past");
          expect(guarded.stderr).not.toContain('"ask_type":"guard-recovery"');
        }
        expect(receiptFiles(project)).toEqual(receipts);
        expect(approvalRows(project)).toEqual(approvals);
        expect(acceptedRows(project)).toHaveLength(0);
        expect(readFileSync(questions, "utf-8")).toBe(originalQuestions);
        expect(readFileSync(statePath, "utf-8")).toBe(state);
        // Repairing the source walk (removing the test-only budget fault) lets
        // the same approval continue; no new human turn or answer is issued.
        const resumed = begin(project);
        expect(resumed.code, resumed.stderr).toBe(0);
        expect(readFileSync(statePath, "utf-8")).toBe(state);
        expect(readFileSync(questions, "utf-8")).toBe(originalQuestions);
        expect(approvalRows(project)).toEqual(approvals);
        expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(!edited);
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }
  }

  const permissionFaultUnavailable = process.platform === "win32" || process.getuid?.() === 0;
  for (const fault of ["audit", "receipt"] as const) {
    for (const edited of [false, true]) {
      test.skipIf(permissionFaultUnavailable)(`${fault} publication failure blocks ${edited ? "edited" : "unchanged"} content without changing the approval setting`, () => {
        const project = createProject("off");
        const questions = presentPlan(project);
        const session = `publication-${fault}-${edited}`;
        startSession(project, session);
        expect(decide(project, questions, session).code).toBe(0);
        humanTurn(project, session);
        expect(answer(project, questions, session).code).toBe(0);
        const receipts = receiptFiles(project);
        const approvals = approvalRows(project);
        const originalQuestions = readFileSync(questions, "utf-8");
        const statePath = join(seededRecordDir(project), "aidlc-state.md");
        const state = readFileSync(statePath, "utf-8");
        const plan = join(codeGenerationRecordDir(project, null), "code-generation-plan.md");
        if (edited) writeFileSync(plan, `${readFileSync(plan, "utf-8")}\n- [ ] Revised work.\n`);
        const handoff = brief(project);
        expect(handoff.code, handoff.stderr).toBe(0);
        writeFileSync(join(project, "src/changed.ts"), "export const changed = true;\n");
        const path = fault === "audit" ? seededAuditShard(project) : join(sessionsDir(project), "plan-approval");
        const mode = statSync(path).mode & 0o777;
        chmodSync(path, fault === "audit" ? 0o444 : 0o555);
        try {
          const blockedBegin = begin(project);
          expect(blockedBegin.code, `${blockedBegin.stdout}\n${blockedBegin.stderr}`).not.toBe(0);
          if (fault === "audit" && edited) {
            // The brief's stand-aside row is the lowered fence's own account,
            // not approval evidence: the brief still hands over the edited plan
            // and says the row was not recorded. The start above still refuses,
            // because the source change it carries must be recorded.
            const unrecordedBrief = brief(project);
            expect(unrecordedBrief.code, unrecordedBrief.stderr).toBe(0);
            expect(unrecordedBrief.stdout.split("\n")[0]).toBe("AIDLC-STAGE: code-generation");
            expect(unrecordedBrief.stderr).toContain("Not recorded in the audit trail, which was busy or could not be written");
          }
          for (const [tool, input] of [
            ["Write", { file_path: join(project, "src/base.ts"), content: "export const base = 2;\n" }],
            ["Task", { subagent_type: "aidlc-developer-agent", prompt: handoff.stdout }],
          ] as const) {
            const guarded = runChangeControlTool([BUN, GUARD], project, JSON.stringify({
              hook_event_name: "PreToolUse", session_id: session, cwd: project,
              tool_name: tool, tool_input: input,
            }));
            expect(guarded.code, `${guarded.stdout}\n${guarded.stderr}`).toBe(2);
            expect(guarded.stderr).toContain("CODE_GENERATION_PROVENANCE_UNAVAILABLE");
            expect(guarded.stderr).not.toContain('"ask_type":"guard-recovery"');
            expect(guarded.stdout).not.toContain("Continuing past");
          }
          expect(receiptFiles(project)).toEqual(receipts);
          expect(approvalRows(project)).toEqual(approvals);
          expect(readFileSync(statePath, "utf-8")).toBe(state);
        } finally {
          chmodSync(path, mode);
        }
        const resumed = begin(project);
        expect(resumed.code, resumed.stderr).toBe(0);
        expect(resumed.stdout).toContain("src/changed.ts");
        expect(acceptedRows(project)).toHaveLength(1);
        expect(readFileSync(questions, "utf-8")).toBe(originalQuestions);
        expect(approvalRows(project)).toEqual(approvals);
        expect(readFileSync(statePath, "utf-8")).toBe(state);
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }
  }
});

describe("t334 F21 executable obligations remain required under lowered fences", () => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]));
    }
    return value;
  };
  const invalidObligations: Array<[string, (obligations: Record<string, unknown>) => void]> = [
    ["missing strategy", (value) => { delete value.strategy; }],
    ["invalid strategy", (value) => { value.strategy = "none"; }],
    ["contradictory strategy", (value) => { value.strategy = "comprehensive"; }],
    ["empty strategy obligations", (value) => { value.strategy_volume = []; }],
    ["blank strategy obligation", (value) => { value.strategy_volume = ["Run tests.", "  "]; }],
    ["empty scope floor", (value) => { value.scope_floor = []; }],
    ["blank scope obligation", (value) => { value.scope_floor = ["\t"]; }],
  ];
  for (const mode of ["relaxed", "off"] as const) {
    test.each(invalidObligations)(`${mode} refuses %s without changing approval`, (_name, mutate) => {
      const project = createProject(mode);
      const questions = presentPlan(project);
      const session = `obligations-${mode}`;
      startSession(project, session);
      expect(decide(project, questions, session).code).toBe(0);
      humanTurn(project, session);
      expect(answer(project, questions, session).code).toBe(0);
      const approvals = approvalRows(project);
      const receipts = receiptFiles(project);
      const planPath = join(codeGenerationRecordDir(project, null), "code-generation-plan.md");
      const plan = readFileSync(planPath, "utf-8");
      const original = parseTestingContract(plan)!;
      const { contract_sha256: _hash, ...body } = original;
      const obligations: Record<string, unknown> = { ...body.obligations };
      mutate(obligations);
      const changedBody = { ...body, obligations };
      const changed = {
        ...changedBody,
        contract_sha256: `sha256:${createHash("sha256").update(JSON.stringify(canonical(changedBody))).digest("hex")}`,
      };
      writeFileSync(planPath, plan.replace(renderTestingContract(original),
        `## Testing Contract\n\n\`\`\`json\n${JSON.stringify(changed, null, 2)}\n\`\`\`\n`));
      expect(parseTestingContract(readFileSync(planPath, "utf-8"))).not.toBeNull();
      const verified = runChangeControlTool([BUN, POSTURE, "verify", "--stage-level", "--project-dir", project], project);
      expect(verified.code).toBe(2);
      expect(JSON.parse(verified.stdout)).toMatchObject({ ok: false, execution_allowed: false });
      expect(JSON.parse(verified.stdout).reason).toContain("Repair");
      expect(begin(project).code).not.toBe(0);
      expect(brief(project).code).not.toBe(0);
      expect(approvalRows(project)).toEqual(approvals);
      expect(receiptFiles(project)).toEqual(receipts);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
