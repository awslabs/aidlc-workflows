// covers: subcommand:aidlc-log:decision, subcommand:aidlc-log:answer, audit:PLAN_APPROVAL_RECORDED, function:recordPlanApprovalHumanResponse, function:withdrawPlanApprovalResponse
//
// The ways a conductor can stall at the Code Generation Plan Approval gate,
// driven through the same commands the stage file tells it to run
// (`testing-posture render` / `fingerprint`, `log decision` / `answer`, and the
// human-turn hook). Each path hits its refusal, then does exactly what that
// refusal says, and must reach a recorded approval. A refusal that does not
// name its next step is the stall this file exists to catch.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import {
  planApprovalChallengeRelativePath,
  readAuditShardEvents,
  readPlanApprovalResponse,
  stateDigest,
  workspaceSourceFingerprint,
  workspaceSourceState,
  writeActiveDirectiveMarker,
} from "../../core/tools/aidlc-lib.ts";
import {
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
} from "../../core/tools/aidlc-testing-posture.ts";
import {
  cleanupTestProject,
  REPO_ROOT,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DIST_ROOT = join(REPO_ROOT, "dist", "claude", ".claude");
const projects: string[] = [];
const QUESTION = "Approve this exact Code Generation plan?";
const DECISION_TAIL = ["--decision", QUESTION, "--options", "Approve Plan,Request Changes"];
// Blank the hook-injected override so a runner launched from a harness shell
// cannot lend these projects its own session.
const NO_SESSION_OVERRIDE = { AIDLC_SESSION_OVERRIDE: "", AIDLC_SESSION_OVERRIDE_SOURCE: "" };

afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop()!);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

interface Run { code: number; out: string; err: string }

function spawn(args: string[], project: string, stdin?: string, env: Record<string, string> = {}): Run {
  const result = Bun.spawnSync([BUN, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...NO_SESSION_OVERRIDE, ...env },
    ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

// Refusals arrive as one JSON line on stderr. Match the decoded text so quotes
// and backslashes compare as the conductor reads them.
function refusal(run: Run): string {
  const line = run.err.trim().split(/\r?\n/).reverse().find((entry) => entry.startsWith("{"));
  if (!line) return run.err;
  const parsed = JSON.parse(line) as { error?: string };
  return parsed.error ?? run.err;
}

const posture = (project: string, ...args: string[]) =>
  spawn([join(DIST_ROOT, "tools", "aidlc-testing-posture.ts"), ...args, "--project-dir", project], project);
const log = (project: string, ...args: string[]) =>
  spawn([join(DIST_ROOT, "tools", "aidlc-log.ts"), ...args], project);
const human = (project: string, session: string, prompt: string) =>
  spawn(
    [join(DIST_ROOT, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
    project,
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  );
// A native AskUserQuestion reply: the questions the conductor put in the
// picker, and the human's answer (a picked label or their own typed text).
interface PickerQuestion { question: string; labels: string[]; answer: string | string[]; multiSelect?: boolean }
const picker = (project: string, session: string, ...questions: PickerQuestion[]) => {
  const asked = questions.map(({ question, labels, multiSelect = false }) => ({
    question, header: "Plan", multiSelect, options: labels.map((label) => ({ label, description: label })),
  }));
  return spawn(
    [join(DIST_ROOT, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"],
    project,
    JSON.stringify({
      hook_event_name: "PostToolUse", session_id: session, tool_name: "AskUserQuestion",
      tool_input: { questions: asked },
      tool_response: { questions: asked, answers: Object.fromEntries(questions.map((q) => [q.question, q.answer])) },
    }),
  );
};
const approvalPicker = (answer: string | string[]): PickerQuestion =>
  ({ question: QUESTION, labels: ["Approve Plan (Recommended)", "Request Changes"], answer });

function createProject(session: string): string {
  const project = setupIntegrationProject({ withState: "state-brownfield-feature.md" });
  projects.push(project);
  const statePath = join(seededRecordDir(project), "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
    .replace(/^- \[[ xSR?-]\] code-generation(\s+\u2014\s+)EXECUTE$/m, "- [-] code-generation$1EXECUTE");
  writeFileSync(statePath, state, "utf-8");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "base.ts"), "export const base = 1;\n");
  expect(workspaceSourceState(project)).not.toBeNull();
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "--", "src"],
    ["commit", "-qm", "baseline"],
  ]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect(git.exitCode, git.stderr.toString()).toBe(0);
  }
  expect(workspaceSourceFingerprint(project)).not.toBeNull();
  writeActiveDirectiveMarker(project, {
    kind: "run-stage",
    stage: "code-generation",
    state_sha256: stateDigest(state),
  });
  appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: session }, project);
  return project;
}

const recordDir = (project: string) => codeGenerationRecordDir(project, null);
const planPath = (project: string) => join(recordDir(project), "code-generation-plan.md");
const questionsPath = (project: string) => join(recordDir(project), "code-generation-questions.md");

// Step 2: the plan carries the complete `## Testing Contract` block from `render`.
function writePlan(project: string, contractBlock: string, extra = ""): void {
  mkdirSync(recordDir(project), { recursive: true });
  writeFileSync(planPath(project), `# Plan\n\n${contractBlock}\n## Steps\n\n- [ ] Implement\n${extra}`);
  writeFileSync(
    join(recordDir(project), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\n## Command\n\n`bun test unit.test.ts`\n",
  );
}

// Step 3: record both tags the fingerprint command printed, then the options.
function writeQuestions(project: string, tags: string): void {
  const lines = tags.split(/\r?\n/).filter((line) => line.startsWith("["));
  expect(lines.some((line) => line.startsWith("[Approval Fingerprint]:"))).toBe(true);
  writeFileSync(
    questionsPath(project),
    ["## Plan Approval", ...lines, "A. Approve Plan", "B. Request Changes", "[Answer]:", ""].join("\n"),
  );
}

function markAnswered(project: string, answer = "Approve Plan"): void {
  const path = questionsPath(project);
  writeFileSync(path, readFileSync(path, "utf-8").replace(/\[Answer\]:[^\n]*$/m, answer ? `[Answer]: ${answer}` : "[Answer]:"));
}

const identity = (project: string, session?: string) => [
  "--stage", "code-generation", "--checkpoint", "plan-approval",
  "--questions-file", questionsPath(project),
  ...(session === undefined ? [] : ["--session", session]),
  "--stage-level",
];

const fingerprint = (project: string, ...extra: string[]) => posture(project, "fingerprint", "--stage-level", ...extra);
const decide = (project: string, session?: string) => log(project, "decision", ...identity(project, session), ...DECISION_TAIL);
const answer = (project: string, session: string, details = "Approve Plan") =>
  log(project, "answer", ...identity(project, session), "--details", details);

function expectApproved(project: string): void {
  expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(true);
  expect(readAuditShardEvents(project).some((row) => row.event === "PLAN_APPROVAL_RECORDED")).toBe(true);
}

// The happy path every recovery must rejoin: fingerprint, present, human
// answers with an offered choice, record it.
function presentAndApprove(project: string, session: string): void {
  const tags = fingerprint(project);
  expect(tags.code, tags.err).toBe(0);
  writeQuestions(project, tags.out);
  const presented = decide(project, session);
  expect(presented.code, presented.err).toBe(0);
  expect(human(project, session, "Approve Plan").code).toBe(0);
  markAnswered(project);
  const recorded = answer(project, session);
  expect(recorded.code, recorded.err).toBe(0);
  expectApproved(project);
}

describe("Plan Approval recovery paths: every refusal names a step that works", () => {
  test("baseline: the documented sequence records an approval", () => {
    const session = "recovery-baseline";
    const project = createProject(session);
    const rendered = posture(project, "render");
    expect(rendered.code, rendered.err).toBe(0);
    writePlan(project, rendered.out);
    presentAndApprove(project, session);
  });

  test("a Testing Contract pasted while render was still writing is refused at fingerprint, and pasting the complete block recovers", () => {
    const session = "recovery-partial-contract";
    const project = createProject(session);
    const rendered = posture(project, "render");
    expect(rendered.code, rendered.err).toBe(0);
    writePlan(project, rendered.out.slice(0, Math.floor(rendered.out.length / 2)));

    const refused = fingerprint(project);
    expect(refused.code).not.toBe(0);
    // The refusal names what is wrong with the plan, before any human is asked.
    expect(refusal(refused)).toContain("Testing Contract");

    writePlan(project, rendered.out);
    presentAndApprove(project, session);
  });

  test("a plan that changes after fingerprinting is refused at decision, and re-running the fingerprint recovers", () => {
    const session = "recovery-late-change";
    const project = createProject(session);
    const rendered = posture(project, "render");
    writePlan(project, rendered.out);
    const tags = fingerprint(project);
    expect(tags.code, tags.err).toBe(0);
    writeQuestions(project, tags.out);
    // A late paste or rewrite of the plan after its fingerprint was recorded.
    writePlan(project, rendered.out, "- [ ] Add the late step\n");

    const refused = decide(project, session);
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).toContain("Re-run the fingerprint command");
    expect(readAuditShardEvents(project).some((row) => row.event === "DECISION_RECORDED")).toBe(false);

    presentAndApprove(project, session);
  });

  test("a missing --session that cannot be resolved names the argument, and passing it recovers", () => {
    const session = "recovery-missing-session";
    const project = createProject(session);
    writePlan(project, posture(project, "render").out);
    const tags = fingerprint(project);
    writeQuestions(project, tags.out);

    const refused = decide(project);
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).toContain("--session <the SessionStart id>");

    const presented = decide(project, session);
    expect(presented.code, presented.err).toBe(0);
    expect(human(project, session, "Approve Plan").code).toBe(0);
    markAnswered(project);
    const recorded = answer(project, session);
    expect(recorded.code, recorded.err).toBe(0);
    expectApproved(project);
  });

  test("a conductor that records a paraphrase of the choice is told the valid choices, and the exact label recovers", () => {
    const session = "recovery-paraphrase";
    const project = createProject(session);
    writePlan(project, posture(project, "render").out);
    writeQuestions(project, fingerprint(project).out);
    expect(decide(project, session).code).toBe(0);
    expect(human(project, session, "Approve Plan").code).toBe(0);
    markAnswered(project);

    const refused = answer(project, session, "Approved");
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).toContain('Valid choices are "Approve Plan" or "Request Changes"');

    const recorded = answer(project, session, "Approve Plan");
    expect(recorded.code, recorded.err).toBe(0);
    expectApproved(project);
  });

  // The human answers in their own words. The hook reads the reply, tells the
  // conductor what it recorded, and leaves the question open only when the
  // meaning is unclear.
  function presented(session: string): string {
    const project = createProject(session);
    writePlan(project, posture(project, "render").out);
    writeQuestions(project, fingerprint(project).out);
    expect(decide(project, session).code).toBe(0);
    return project;
  }
  // Typed replies carry the notice as additionalContext; picker replies carry
  // it as PostToolUse hookSpecificOutput.
  const noticeOf = (run: Run): string =>
    run.out.split(/\r?\n/).filter((line) => line.startsWith("{"))
      .map((line) => {
        const parsed = JSON.parse(line) as {
          additionalContext?: string; hookSpecificOutput?: { additionalContext?: string };
        };
        return parsed.additionalContext ?? parsed.hookSpecificOutput?.additionalContext ?? "";
      })
      .join("\n");
  const recordedChoice = (project: string, session: string) => readPlanApprovalResponse(project, session)?.choice ?? null;
  function expectRecordsApproval(project: string, session: string): void {
    markAnswered(project);
    const recorded = answer(project, session);
    expect(recorded.code, recorded.err).toBe(0);
    expectApproved(project);
  }

  test("a plain yes in the approval picker is recorded at once, and the conductor is told", () => {
    const session = "recovery-picker-yes";
    const project = presented(session);
    const reply = picker(project, session, approvalPicker("looks good, go ahead"));
    expect(reply.code).toBe(0);
    expect(noticeOf(reply)).toContain('read as "Approve Plan"');
    expectRecordsApproval(project, session);
  });

  test("a plain yes typed in chat asks for one confirming reply, and a typed 1 records it", () => {
    const session = "recovery-typed-yes";
    const project = presented(session);
    const reply = human(project, session, "looks good, go ahead");
    expect(noticeOf(reply)).toContain("cannot be tied to this plan");
    expect(recordedChoice(project, session)).toBeNull();
    expect(noticeOf(human(project, session, "1"))).toContain('read as "Approve Plan"');
    expectRecordsApproval(project, session);
  });

  test("a reply that asks for a change is recorded as Request Changes, never approval", () => {
    const session = "recovery-change-request";
    const project = presented(session);
    const reply = human(project, session, "looks good but rename the handler");
    expect(noticeOf(reply)).toContain('read as "Request Changes"');
    markAnswered(project);
    const refused = answer(project, session, "Approve Plan");
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).toContain('recorded as "Request Changes"; record that choice instead');
    markAnswered(project, "Request Changes");
    const changes = answer(project, session, "Request Changes");
    expect(changes.code, changes.err).toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
  });

  test("an unclear reply records nothing, and one follow-up answered with 1 recovers", () => {
    const session = "recovery-unclear";
    const project = presented(session);
    expect(noticeOf(human(project, session, "hmm, not sure"))).toContain("Ask one short follow-up");
    markAnswered(project);
    const refused = answer(project, session);
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).toContain('Nothing the human said has been recorded as a choice yet: ask again ("1" to approve');
    // The follow-up needs no second presentation: the question is still open.
    expect(noticeOf(human(project, session, "1"))).toContain('read as "Approve Plan"');
    const recorded = answer(project, session);
    expect(recorded.code, recorded.err).toBe(0);
    expectApproved(project);
  });

  test("a question records nothing, and the answer after it counts", () => {
    const session = "recovery-question";
    const project = presented(session);
    expect(noticeOf(human(project, session, "what does step 3 do?"))).toContain("asked a question");
    expect(noticeOf(human(project, session, "ok thanks, approved"))).toContain('read as "Approve Plan"');
    expectRecordsApproval(project, session);
  });

  test("a typed guard switch or slash command is not read as a reply", () => {
    const session = "recovery-guard-switch";
    const project = presented(session);
    expect(noticeOf(human(project, session, "/aidlc config set guard.plan-approval off"))).not.toContain("AIDLC Plan Approval:");
    expect(noticeOf(human(project, session, "/aidlc --status"))).not.toContain("AIDLC Plan Approval:");
    expect(recordedChoice(project, session)).toBeNull();
  });

  test("an approval the human then leaves unclear is withdrawn until they choose again", () => {
    const session = "recovery-withdrawn";
    const project = presented(session);
    human(project, session, "1");
    expect(recordedChoice(project, session)).toBe("Approve Plan");
    expect(noticeOf(human(project, session, "hmm, let me read it later"))).toContain("Ask one short follow-up");
    expect(recordedChoice(project, session)).toBeNull();
    markAnswered(project);
    expect(answer(project, session).code).not.toBe(0);
    human(project, session, "1");
    const recorded = answer(project, session);
    expect(recorded.code, recorded.err).toBe(0);
    expectApproved(project);
  });

  test("a thanks or a question after approving keeps the approval", () => {
    const session = "recovery-thanks-after";
    const project = presented(session);
    human(project, session, "1");
    human(project, session, "thanks!");
    human(project, session, "what happens next?");
    expect(recordedChoice(project, session)).toBe("Approve Plan");
    expectRecordsApproval(project, session);
  });

  test("taking an approval back withdraws it", () => {
    const session = "recovery-scratch-that";
    const project = presented(session);
    for (const takeBack of ["scratch that", "I take that back", "withdraw my approval", "retract my approval"]) {
      human(project, session, "1");
      expect(recordedChoice(project, session)).toBe("Approve Plan");
      human(project, session, takeBack);
      expect(recordedChoice(project, session), takeBack).not.toBe("Approve Plan");
    }
    markAnswered(project);
    expect(answer(project, session).code).not.toBe(0);
  });

  test("a question after Request Changes leaves the change request standing", () => {
    const session = "recovery-question-after-no";
    const project = presented(session);
    human(project, session, "no");
    human(project, session, "what does step 3 do?");
    expect(recordedChoice(project, session)).toBe("Request Changes");
  });

  test("a challenge recorded before prompt digests still pairs the approval picker", () => {
    const session = "recovery-no-digest";
    const project = presented(session);
    const path = join(project, planApprovalChallengeRelativePath(project, session));
    const challenge = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    delete challenge.promptDigest;
    writeFileSync(path, `${JSON.stringify(challenge, null, 2)}\n`);
    expect(noticeOf(picker(project, session, approvalPicker("Approve Plan")))).toContain('read as "Approve Plan"');
    expectRecordsApproval(project, session);
  });

  test("surrounding whitespace in the picker question still pairs it", () => {
    const session = "recovery-question-whitespace";
    const project = presented(session);
    expect(noticeOf(picker(project, session, { ...approvalPicker("yes"), question: `${QUESTION}\n` })))
      .toContain('read as "Approve Plan"');
    expectRecordsApproval(project, session);
  });

  test("where the harness hides the notice, reply reports what the hook recorded", () => {
    const session = "recovery-reply-read";
    const project = presented(session);
    const reply = () => posture(project, "reply", "--session", session);
    expect(reply().out).toContain("nothing the human said has been recorded as a choice yet");
    // A question the human asked is answered before approval is asked again.
    expect(reply().out).toContain("If they asked a question, answer it");
    human(project, session, "rename the handler");
    expect(reply().out).toContain('read as "Request Changes"');
    human(project, session, "approved");
    const read = reply();
    expect(read.code, read.err).toBe(0);
    expect(read.out).toContain('read as "Approve Plan"');
    expectRecordsApproval(project, session);
    // Once the receipt spends the challenge, nothing is pending.
    expect(reply().out).toContain("no Plan Approval question is pending");
  });

  test("presenting the same plan again keeps the answer the human already gave", () => {
    const session = "recovery-represent";
    const project = presented(session);
    expect(noticeOf(human(project, session, "Approve Plan"))).toContain('read as "Approve Plan"');
    const again = decide(project, session);
    expect(again.code, again.err).toBe(0);
    expect(recordedChoice(project, session)).toBe("Approve Plan");
    expectRecordsApproval(project, session);
  });
});

// The conductor writes the questions and the picker labels. A reply counts for
// the plan only when it answers the recorded approval question, so nothing the
// conductor asks alongside or instead of it can be spent as approval.
describe("Plan Approval replies bind to the recorded question", () => {
  function presented(session: string): string {
    const project = createProject(session);
    writePlan(project, posture(project, "render").out);
    writeQuestions(project, fingerprint(project).out);
    expect(decide(project, session).code).toBe(0);
    return project;
  }
  const noticeOf = (run: Run): string =>
    run.out.split(/\r?\n/).filter((line) => line.startsWith("{"))
      .map((line) => (JSON.parse(line) as { hookSpecificOutput?: { additionalContext?: string } })
        .hookSpecificOutput?.additionalContext ?? "")
      .join("\n");
  function expectNothingSpendable(project: string, session: string): void {
    expect(readPlanApprovalResponse(project, session)).toBeNull();
    markAnswered(project);
    const refused = answer(project, session);
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).toContain("Nothing the human said has been recorded as a choice yet");
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
  }

  test("a yes to a different picker question is not approval", () => {
    const session = "bind-other-question";
    const project = presented(session);
    const reply = picker(project, session,
      { question: "Also run the linter after generation?", labels: ["Yes", "No"], answer: "Yes" });
    expect(noticeOf(reply)).toContain("was not the recorded Plan Approval question");
    expectNothingSpendable(project, session);
  });

  test("the approval question reworded in the picker is not approval", () => {
    const session = "bind-reworded";
    const project = presented(session);
    picker(project, session,
      { question: "Ready to start coding?", labels: ["Approve Plan", "Request Changes"], answer: "Approve Plan" });
    expectNothingSpendable(project, session);
  });

  test("a picker that adds options to the approval question is not approval", () => {
    const session = "bind-extra-option";
    const project = presented(session);
    picker(project, session,
      { question: QUESTION, labels: ["Approve Plan", "Request Changes", "Skip review"], answer: "Approve Plan" });
    expectNothingSpendable(project, session);
  });

  test("a picker that shows Request Changes first is not the recorded question, so 1 cannot invert", () => {
    const session = "bind-reversed-order";
    const project = presented(session);
    picker(project, session, { question: QUESTION, labels: ["Request Changes", "Approve Plan"], answer: "1" });
    expectNothingSpendable(project, session);
  });

  test("a multi-select approval picker is not a single choice, whichever pick comes first", () => {
    const session = "bind-multi-select";
    const project = presented(session);
    picker(project, session,
      { ...approvalPicker(["Approve Plan", "Request Changes"]), multiSelect: true });
    expectNothingSpendable(project, session);
  });

  test("a plain yes to a picker asking some other recorded question only asks for confirmation", () => {
    const session = "bind-other-decision-text";
    const project = createProject(session);
    writePlan(project, posture(project, "render").out);
    writeQuestions(project, fingerprint(project).out);
    const other = "Delete the temp branch when generation finishes?";
    const presented = log(project, "decision", ...identity(project, session),
      "--decision", other, "--options", "Approve Plan,Request Changes");
    expect(presented.code, presented.err).toBe(0);
    const reply = picker(project, session, { question: other, labels: ["Approve Plan", "Request Changes"], answer: "yes" });
    expect(noticeOf(reply)).toContain("cannot be tied to this plan");
    expectNothingSpendable(project, session);
  });

  test("rewording the question after Request Changes cannot turn a plain yes into approval", () => {
    const session = "bind-reword-flip";
    const project = presented(session);
    human(project, session, "no");
    const other = "Also run the linter after generation?";
    expect(log(project, "decision", ...identity(project, session),
      "--decision", other, "--options", "Approve Plan,Request Changes").code).toBe(0);
    picker(project, session, { question: other, labels: ["Approve Plan", "Request Changes"], answer: "sure" });
    expect(readPlanApprovalResponse(project, session)?.choice).toBe("Request Changes");
    markAnswered(project);
    expect(answer(project, session).code).not.toBe(0);
    expect(evaluateCodeGenerationApproval(project, { unit: null }).ok).toBe(false);
  });

  test("a picker asking several questions records none of them as approval", () => {
    const session = "bind-multi-question";
    const project = presented(session);
    picker(project, session,
      { question: "Keep the temp branch?", labels: ["Yes", "No"], answer: "Yes" },
      approvalPicker("Approve Plan"));
    expectNothingSpendable(project, session);
  });

  test("decision refuses labels other than Approve Plan and Request Changes, before recording anything", () => {
    const session = "bind-custom-labels";
    const project = createProject(session);
    writePlan(project, posture(project, "render").out);
    writeQuestions(project, fingerprint(project).out);
    const refused = log(project, "decision", ...identity(project, session), "--decision", QUESTION, "--options", "Yes,No");
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).toContain('Plan Approval decision offers exactly "Approve Plan,Request Changes"');
    expect(readAuditShardEvents(project).some((row) => row.event === "DECISION_RECORDED")).toBe(false);
  });

  test("presenting again after Request Changes keeps it, and a later typed ok does not replace it", () => {
    const session = "bind-represent-no";
    const project = presented(session);
    human(project, session, "no");
    expect(decide(project, session).code).toBe(0);
    human(project, session, "ok");
    expect(readPlanApprovalResponse(project, session)?.choice).toBe("Request Changes");
    markAnswered(project);
    const refused = answer(project, session);
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).toContain('recorded as "Request Changes"');
  });

  test("a plan changed after the human approved says so, not that nothing was recorded", () => {
    const session = "bind-plan-drift";
    const project = presented(session);
    human(project, session, "Approve Plan");
    writePlan(project, posture(project, "render").out, "- [ ] Late step\n");
    markAnswered(project);
    const refused = answer(project, session);
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).not.toContain("Nothing the human said has been recorded");
    expect(refusal(refused)).toContain("Re-run the fingerprint command");
  });
});

describe("Plan Approval recovery paths: a human edit", () => {
  test("a human edit while the question is pending is refused, and following each refusal's remedy recovers", () => {
    const session = "recovery-human-edit";
    const project = createProject(session);
    const rendered = posture(project, "render");
    writePlan(project, rendered.out);
    writeQuestions(project, fingerprint(project).out);
    expect(decide(project, session).code).toBe(0);
    // The human edits the plan in their own editor, then approves.
    writePlan(project, rendered.out, "- [ ] The human's added step\n");
    expect(human(project, session, "Approve Plan").code).toBe(0);
    markAnswered(project);

    const refused = answer(project, session);
    expect(refused.code).not.toBe(0);
    expect(refusal(refused)).toContain("Re-run the fingerprint command");

    // Re-running the fingerprint with the answer still recorded names its own
    // next step instead of silently regenerating.
    const standing = fingerprint(project);
    expect(standing.code).not.toBe(0);
    expect(refusal(standing)).toContain("--reapprove");

    const reapproved = fingerprint(project, "--reapprove");
    expect(reapproved.code, reapproved.err).toBe(0);
    writeQuestions(project, reapproved.out);
    const presented = decide(project, session);
    expect(presented.code, presented.err).toBe(0);
    expect(human(project, session, "Approve Plan").code).toBe(0);
    markAnswered(project);
    const recorded = answer(project, session);
    expect(recorded.code, recorded.err).toBe(0);
    expectApproved(project);
  });
});
