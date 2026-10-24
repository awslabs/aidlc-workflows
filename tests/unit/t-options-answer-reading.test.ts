// covers: function:openQuestionAnswer, function:personsWordsKept, function:blockingSensorPicks
// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:answer, hook:aidlc-review-freeze
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
// Mechanism: function. The shipped human-turn hook, `next`, the `log answer` command the step names (its placeholder
// filled the way a reader fills it), and the shipped review-freeze hook, over a real record; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, blockingSensorPicks, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { STAGE, buildQuestion } from "../harness/aidlc-answers-corpus.ts";
import { LOG, SESSION, env, exec, next, say, type Exec } from "../harness/aidlc-input-corpus.ts";
import {
  AIDLC_SRC, FIXTURES_DIR, cleanupTestProject, createOrchestrationTestProject, seededRecordDir, seededStateFile,
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
