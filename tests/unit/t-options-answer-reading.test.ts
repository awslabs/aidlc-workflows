// covers: function:openQuestionAnswer, function:personsWordsKept, function:blockingSensorPicks
// covers: function:hasBlockingSensorOverrideAuthorization, function:blockingSensorOverrideReport
// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-log:answer
// covers: hook:aidlc-review-freeze
//
// A question with choices records the choice the agent read from the person's reply, with their own words kept beside
// it (Arden 2026-10-24). Live on Codex the blocking check ("Fix findings" / "Override blocking sensors") was shown
// again after a resume, the step said to record `--details '<their exact reply>'`, the agent recorded "fix them first",
// the pick (read from Details as a number or a label) was no pick, the review freeze refused the fix, and the record
// ended with a Request Changes at a gate the person never saw. Now the step at an open question with choices lists
// them and asks for the one the agent read (`--details '<their choice>'`), wherever the human-turn hook keeps the
// person's words for this chat; Person Reply and Message Id keep what they typed. Where nothing keeps their words
// (hooks off), the step is the one from before and their reply itself goes in Details, so it is on the row either
// way; with no human turn on record that plain answer then needs the presence switch, which the hooks-off case sets.
// A question with no choices keeps the reply step. The pick is read from the agent's reading, never from their words.
//
// After an Override blocking sensors pick the gate is still shut, and live on Codex the step's bare `next` handed back
// the stage itself: the agent's edit of the reviewed document met the review freeze, and the person read a recovery
// question about a check they never touched instead of their gate. While the pick stands (the state tool's own test),
// `next` names the report that carries it; a Request Changes or a later question on the stage spends it, and Fix
// findings is the stage's own work.
//
// Mechanism: function. The shipped human-turn hook, `next`, the `log answer` command the step names (its placeholder
// filled the way a reader fills it), and the shipped review-freeze hook, over a real record; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, blockingSensorPicks, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { STAGE, buildQuestion } from "../harness/aidlc-answers-corpus.ts";
import { LOG, ORCHESTRATE, SESSION, env, exec, next, say, type Exec } from "../harness/aidlc-input-corpus.ts";
import {
  AIDLC_SRC, FIXTURES_DIR, cleanupTestProject, createOrchestrationTestProject, recordArtifactWriteViaHook, seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});
function project(): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  return proj;
}

const CHOICES = "its choices are 1. Fix findings and 2. Override blocking sensors; record the choice they made, as you " +
  "read it from their reply, with";
const READING = "--details '<their choice>'";
const RAW = "--details '<their exact reply>'";
const REPLY = "fix them first";
const NO_HOOK = { env: { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" } };

const requirements = (proj: string) => join(seededRecordDir(proj), "inception", STAGE, "requirements.md");
const answers = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "QUESTION_ANSWERED");
const latestTurnId = (proj: string) =>
  auditBlockField(readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1)!.block, "Message Id");

/** The step's own `log answer` command, its placeholder filled as a reader fills it: the choice it read, or the reply. */
async function followStep(proj: string, message: string, read: string, reply: string, opts = {}): Promise<Exec> {
  const command = /`([^`]*aidlc-log\.ts answer --stage [^`]*)`/.exec(message)?.[1];
  expect(command, message).toBeDefined();
  const filled = (command as string).replace("'<their choice>'", `'${read}'`).replace("'<their exact reply>'", `'${reply}'`);
  const argv = (filled.match(/'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^'|'$/g, ""));
  expect(argv[0]).toBe("bun");
  // The step names the tool in the project's own tree (`.claude/tools/...`); this project runs the shipped one.
  const tool = join(dirname(AIDLC_SRC), argv[1]);
  return exec([process.execPath, tool, ...argv.slice(2), "--project-dir", proj], { cwd: proj, env: env(proj, opts) });
}

/** The agent's edit of the reviewed document, through the shipped review-freeze hook: its exit code. */
async function freeze(proj: string): Promise<number> {
  const ran = await exec([process.execPath, join(AIDLC_SRC, "hooks", "aidlc-review-freeze.ts")], {
    cwd: proj,
    env: env(proj),
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: requirements(proj) }, cwd: proj }),
  });
  return ran.status;
}

/** The blocking question open on a stage that is running, with nothing of the person's on record: the chat opened
 * through the session-start hook, and no prompt hook kept a turn. */
async function blockingQuestionNoHook(proj: string): Promise<void> {
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
  const opened = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "session-start"], {
    cwd: proj, env: env(proj),
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: SESSION, source: "startup", cwd: proj }),
  });
  expect(opened.status, opened.stderr).toBe(0);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  const logged = await exec([process.execPath, LOG, "decision", "--stage", STAGE, "--decision", "Blocking gate sensor failure",
    "--options", "Fix findings,Override blocking sensors", "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(logged.status, logged.stdout + logged.stderr).toBe(0);
}

describe("t-options-answer-reading: an options question records the agent's reading beside the person's words", () => {
  test("shown again after a resume, fix them first is recorded as Fix findings beside their words, and the fix goes through the freeze", async () => {
    const proj = project();
    await buildQuestion(proj, "stage-gate-sensor-failure");
    expect(await freeze(proj)).toBe(2);
    await say(proj, "/aidlc", "claude");
    const shown = await next(proj, ["--resume"]);
    const message = String(shown.directive?.message ?? "");
    expect(message).toContain("Show it to them again");
    expect(message).toContain(CHOICES);
    expect(message).toContain(READING);
    expect(message).not.toContain(RAW);

    await say(proj, REPLY, "claude");
    const id = latestTurnId(proj);
    const recorded = await followStep(proj, message, "Fix findings", REPLY);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const row = answers(proj).at(-1)!.block;
    expect(auditBlockField(row, "Details")).toBe("Fix findings");
    expect(auditBlockField(row, "Person Reply")).toBe(REPLY);
    expect(auditBlockField(row, "Message Id")).toBe(id);
    expect(await freeze(proj)).toBe(0);
  });

  test("their words passed to next while the question is open get the same step", async () => {
    const proj = project();
    await buildQuestion(proj, "stage-gate-sensor-failure");
    await say(proj, `/aidlc ${REPLY}`, "claude");
    const read = await next(proj, [REPLY]);
    const message = String(read.directive?.message ?? "");
    expect(message).toContain("Read their reply. If it answers that question, its choices are 1. Fix findings");
    expect(message).toContain(READING);
    expect(message).not.toContain(RAW);
    const recorded = await followStep(proj, message, "Fix findings", REPLY);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const row = answers(proj).at(-1)!.block;
    expect(auditBlockField(row, "Details")).toBe("Fix findings");
    expect(auditBlockField(row, "Person Reply")).toBe(REPLY);
  });

  test("with no hook keeping their words, both steps keep their exact reply, and it goes in Details", async () => {
    const proj = project();
    await blockingQuestionNoHook(proj);
    const read = await next(proj, [REPLY]);
    const replyStep = String(read.directive?.message ?? "");
    expect(replyStep).toContain("Read their reply.");
    expect(replyStep).toContain(RAW);
    expect(replyStep).not.toContain("its choices are");

    const shown = await next(proj, ["--resume"]);
    const message = String(shown.directive?.message ?? "");
    expect(message).toContain("Show it to them again");
    expect(message).toContain(RAW);
    expect(message).not.toContain("its choices are");
    const recorded = await followStep(proj, message, "Fix findings", REPLY, NO_HOOK);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const row = answers(proj).at(-1)!.block;
    expect(auditBlockField(row, "Details")).toBe(REPLY);
    expect(auditBlockField(row, "Person Reply")).toBeNull();
  });

  test("a question with no choices keeps the reply step", async () => {
    const proj = project();
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
    await say(proj, "/aidlc", "claude");
    const logged = await exec([process.execPath, LOG, "decision", "--stage", STAGE, "--decision", "What should the app be called?",
      "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(logged.status, logged.stdout + logged.stderr).toBe(0);
    const shown = await next(proj, ["--resume"]);
    const message = String(shown.directive?.message ?? "");
    expect(message).toContain("What should the app be called?");
    expect(message).toContain(RAW);
    expect(message).not.toContain("its choices are");
  });

  // One reply answers every question its menu asked (`log answers` pairs it with each), so one choice in Details
  // would stand for all of them: with several open, their whole reply goes in Details, as before.
  test("several questions with choices open for one menu keep the reply step", async () => {
    const proj = project();
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
    await say(proj, "/aidlc", "claude");
    for (const [decision, options] of [["Which database should the to-do app use?", "PostgreSQL,MySQL"],
      ["How should people sign in?", "OAuth,Basic"]]) {
      const logged = await exec([process.execPath, LOG, "decision", "--stage", STAGE, "--decision", decision,
        "--options", options, "--project-dir", proj], { cwd: proj, env: env(proj) });
      expect(logged.status, logged.stdout + logged.stderr).toBe(0);
    }
    const shown = await next(proj, ["--resume"]);
    expect(String(shown.directive?.message ?? "")).toContain(RAW);
    await say(proj, "/aidlc postgres, and oauth", "claude");
    const read = await next(proj, ["postgres, and oauth"]);
    const message = String(read.directive?.message ?? "");
    expect(message).toContain("Read their reply.");
    expect(message).toContain(RAW);
    expect(message).not.toContain("its choices are");
  });

  // Kiro IDE 1.0.242 hands the prompt hook an empty prompt: the turn has its message record, with no text in it, so
  // nothing will keep the words of the reply to come.
  test("a host that hands the hook no prompt text keeps the reply step for the question shown again", async () => {
    const proj = project();
    await buildQuestion(proj, "stage-gate-sensor-failure");
    const said = await say(proj, "", "kiro-ide");
    expect(said.status, said.stderr).toBe(0);
    expect(latestTurnId(proj)).not.toBeNull();
    const shown = await next(proj, ["--resume"]);
    const message = String(shown.directive?.message ?? "");
    expect(message).toContain("Show it to them again");
    expect(message).toContain(RAW);
    expect(message).not.toContain("its choices are");
  });

  test("the pick comes from the agent's reading, never from the person's words", async () => {
    const proj = project();
    await buildQuestion(proj, "stage-gate-sensor-failure");
    // They typed the label itself, and the agent recorded something else: the record's reading decides.
    await say(proj, "Fix findings", "claude");
    const recorded = await exec([process.execPath, LOG, "answer", "--stage", STAGE, "--details", "let me think about it",
      "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    expect(auditBlockField(answers(proj).at(-1)!.block, "Person Reply")).toBe("Fix findings");
    expect(blockingSensorPicks(readAuditShardEvents(proj), STAGE).size).toBe(0);
    expect(await freeze(proj)).toBe(2);
  });
});

const OVERRIDE_REPORT = 'report --stage requirements-analysis --result awaiting-approval --override-blocking-sensors ' +
  '--user-input "Override blocking sensors"';

/** The blocking question shown again after a resume, and the person's reply recorded as the choice the agent read. */
async function pickedAfterResume(proj: string, read: string, reply: string): Promise<void> {
  await buildQuestion(proj, "stage-gate-sensor-failure");
  await say(proj, "/aidlc", "claude");
  const shown = await next(proj, ["--resume"]);
  await say(proj, reply, "claude");
  const recorded = await followStep(proj, String(shown.directive?.message ?? ""), read, reply);
  expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
}

/** The report a step names, run as the agent runs it, in the shipped tree. */
async function runReport(proj: string, message: string): Promise<Exec> {
  const command = /`([^`]*aidlc-orchestrate\.ts report [^`]*)`/.exec(message)?.[1];
  expect(command, message).toBeDefined();
  const argv = ((command as string).match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^["']|["']$/g, ""));
  return exec([process.execPath, join(dirname(AIDLC_SRC), argv[1]), ...argv.slice(2), "--project-dir", proj],
    { cwd: proj, env: env(proj) });
}

describe("t-options-answer-reading: after Override blocking sensors, next opens the person's gate", () => {
  test("after Override blocking sensors is recorded, next names the override report and the gate opens with no recovery question", async () => {
    const proj = project();
    await pickedAfterResume(proj, "Override blocking sensors", "just approve it");
    const step = await next(proj, []);
    expect(step.directive?.kind, step.out).toBe("print");
    const message = String(step.directive?.message ?? "");
    expect(message).toContain(OVERRIDE_REPORT);
    expect(message).toContain("show the gate with what it returns");

    const reported = await runReport(proj, message);
    const out = reported.stdout + reported.stderr;
    expect(reported.status, out).toBe(0);
    expect(out).not.toContain('"ask_type":"guard-recovery"');
    expect(out).toContain("Requirements Analysis is ready for your review");
    expect(readAuditShardEvents(proj).at(-1)?.event, out).toBe("STAGE_AWAITING_APPROVAL");
  });

  test("Request Changes at the review freeze's recovery question spends the pick, and next hands back the stage", async () => {
    const proj = project();
    await pickedAfterResume(proj, "Override blocking sensors", "just approve it");
    // The agent edits the reviewed document anyway: the freeze refuses it and asks the person which way to go on.
    expect(await freeze(proj)).toBe(2);
    const recovery = await next(proj, []);
    expect(recovery.directive?.ask_type, recovery.out).toBe("guard-recovery");
    const feedback = "add a rule for titles made only of spaces";
    await say(proj, `1, ${feedback}`, "claude");
    const rejected = await exec([process.execPath, ORCHESTRATE, "report", "--stage", STAGE, "--result", "rejected",
      "--user-input", "Request Changes", "--reason", feedback, "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(rejected.status, rejected.stdout + rejected.stderr).toBe(0);
    const after = await next(proj, []);
    expect(after.out).not.toContain("--override-blocking-sensors");
    expect(after.directive?.kind, after.out).toBe("run-stage");
  });

  test("Fix findings hands back the stage, with no override named", async () => {
    const proj = project();
    await pickedAfterResume(proj, "Fix findings", REPLY);
    const step = await next(proj, []);
    expect(step.directive?.kind, step.out).toBe("run-stage");
    expect(step.out).not.toContain("--override-blocking-sensors");
  });

  test("an override report refused for another reason, with nothing answered since, gets the same step again", async () => {
    const proj = project();
    await pickedAfterResume(proj, "Override blocking sensors", "just approve it");
    const first = await next(proj, []);
    const message = String(first.directive?.message ?? "");
    expect(message).toContain(OVERRIDE_REPORT);
    // The confirmed summary changes before the report: the report refuses on it, not on the override.
    const questions = join(seededRecordDir(proj), "inception", STAGE, `${STAGE}-questions.md`);
    writeFileSync(questions, readFileSync(questions, "utf-8").replace("Should a blank title be refused?",
      "Should a blank or whitespace-only title be refused?"), "utf-8");
    recordArtifactWriteViaHook(proj, questions, "Edit");
    const refused = await runReport(proj, message);
    expect(refused.stdout + refused.stderr).toContain("SUMMARY_CONTENT_STALE");
    const again = await next(proj, []);
    expect(again.directive?.kind, again.out).toBe("print");
    expect(String(again.directive?.message ?? "")).toBe(message);

    // Their pick at that recovery question, carried out, is a later question on the stage: it spends the override.
    await say(proj, "1", "claude");
    const picked = await exec([process.execPath, LOG, "answer", "--stage", STAGE, "--checkpoint", "guard-recovery",
      "--details", "reconfirm-summary", "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(picked.stdout, picked.stderr).toContain('"recorded":"reconfirm-summary"');
    writeFileSync(questions, readFileSync(questions, "utf-8").replace("[Answer]: Looks correct\n", "[Answer]: \n"), "utf-8");
    recordArtifactWriteViaHook(proj, questions, "Edit");
    const asked = await exec([process.execPath, LOG, "decision", "--checkpoint", "summary-confirmation", "--stage", STAGE,
      "--questions-file", questions, "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes",
      "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(asked.status, asked.stdout + asked.stderr).toBe(0);
    const spent = await next(proj, []);
    expect(spent.out).not.toContain("--override-blocking-sensors");
  });
});
