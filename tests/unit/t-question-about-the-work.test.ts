// covers: subcommand:aidlc-orchestrate:next, function:reentryReplyDirective, function:teamWordsReplyDirective,
// function:finishedWorkReading, function:workQuestionReading
//
// t-question-about-the-work: a question about where the work stands, typed with /aidlc beside work in progress (open,
// parked, a second chat, team mode) or beside finished work, gets a reading step that names the status command for the
// answer and no other command, beside the readings it had. Measured at main 2b895ee31: the step had no reading for a
// question, so its only fit was the request reading, whose `next --request` asks the person where their words belong
// ("Part of the active work" then runs the stage and drops the question); live on Claude Code with Sonnet 4.5 the
// agent ran the stage on open work, unparked and ran parked work, or ended on a continue, jump or start-fresh menu.
// The step is a print: running `next` with the words starts, unparks and moves nothing.
//
// Spawns the real engine and the Claude Code human-turn hook, as tests/unit/t-resume-reads-the-words does.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { FIXTURES_DIR, cleanupTestProject, createOrchestrationTestProject, intentsDirOf, seededStateFile } from "../harness/fixtures.ts";
import {
  buildState, type Directive, exec, next, type RunOptions, SECOND_SESSION, say, UTILITY,
} from "../harness/aidlc-input-corpus.ts";
import { getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const QUESTION = "how far along are we?";
const PIECE = "fixture-8000000000000001";
const STATUS = /`[^`]*\bengine status`/;
const STATUS_OF_PIECE = new RegExp(`\`[^\`]*\\bengine status --intent ${PIECE}\``);
const NOTHING_ELSE = "run no other command";

async function at(state: "work-open" | "parked" | "second-chat" | "finished", edit?: (proj: string) => void): Promise<string> {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  await buildState(proj, state);
  edit?.(proj);
  return proj;
}

async function asked(proj: string, opts: RunOptions = {}): Promise<Directive | null> {
  await say(proj, `/aidlc ${QUESTION}`, "claude", opts);
  const before = readAuditShardEvents(proj).length;
  const stage = getField(readFileSync(seededStateFile(proj), "utf-8"), "Current Stage");
  const step = await next(proj, [QUESTION], opts);
  expect(step.directive?.kind, step.out).toBe("print");
  // The reading step moves nothing: no stage started, nothing unparked, the stage where it was.
  const moved = readAuditShardEvents(proj).slice(before).map((row) => row.event)
    .filter((event) => event === "STAGE_STARTED" || event === "WORKFLOW_UNPARKED" || event === "STAGE_COMPLETED");
  expect(moved, step.out).toEqual([]);
  expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Current Stage")).toBe(stage);
  return step.directive;
}

describe("t-question-about-the-work: a question about where the work stands is answered from the status", () => {
  test("open work: the reading names the status command and no other command, beside the request reading", async () => {
    const proj = await at("work-open");
    const message = String((await asked(proj))?.message);
    expect(message).toMatch(STATUS);
    expect(message).toContain(NOTHING_ELSE);
    // Words about other work still go to the question about where they belong.
    expect(message).toMatch(/`[^`]* next --request [0-9a-f]{8}`/);
  });

  test("parked work: the same reading, and the work stays parked", async () => {
    const proj = await at("parked");
    const message = String((await asked(proj))?.message);
    expect(message).toMatch(STATUS);
    expect(message).toContain(NOTHING_ELSE);
    expect(readAuditShardEvents(proj).map((row) => row.event)).toContain("WORKFLOW_PARKED");
  });

  test("a second chat on the same work: the same reading", async () => {
    const proj = await at("second-chat");
    const message = String((await asked(proj, { session: SECOND_SESSION }))?.message);
    expect(message).toMatch(STATUS);
    expect(message).toContain(NOTHING_ELSE);
  });

  test("team mode: the team reading names the status command too", async () => {
    const proj = await at("work-open", (p) => {
      const file = seededStateFile(p);
      writeFileSync(file, readFileSync(file, "utf-8").replace(
        /^(- \*\*Current Stage\*\*:.*)$/m, "$1\n- **Unit Ownership**: team",
      ), "utf-8");
    });
    const message = String((await asked(proj))?.message);
    expect(message).toContain("the person's words may only ask for it to go on");
    expect(message).toMatch(STATUS);
    expect(message).toContain(NOTHING_ELSE);
  });

  test("finished work selected in this chat: the finished reading names the status command", async () => {
    const proj = await at("finished");
    const message = String((await asked(proj))?.message);
    expect(message).toContain("is finished");
    expect(message).toMatch(STATUS);
    expect(message).toContain(NOTHING_ELSE);
  });

  test("finished work not selected in this chat: the status of that work by its record, never a switch to it", async () => {
    const proj = await at("finished", (p) => rmSync(join(intentsDirOf(p, "default"), "active-intent"), { force: true }));
    const message = String((await asked(proj))?.message);
    expect(message).toContain("it is not selected in this chat");
    expect(message).toMatch(STATUS_OF_PIECE);
    expect(message).toContain(NOTHING_ELSE);
  });

  test("several finished pieces, none selected: the status that lists them all, so a question about all of them is answered", async () => {
    const proj = await at("finished");
    const second = await exec(
      [process.execPath, UTILITY, "intent-create", "--scope", "bugfix", "--arguments", "fix the export timeout", "--label", "export",
        "--project-dir", proj],
      { cwd: proj, env: { ...process.env } },
    );
    expect(second.status, `${second.stdout}${second.stderr}`).toBe(0);
    const intents = intentsDirOf(proj, "default");
    const completed = readFileSync(join(FIXTURES_DIR, "state-completed.md"), "utf-8");
    for (const dir of readdirSync(intents)) {
      const state = join(intents, dir, "aidlc-state.md");
      if (dir !== PIECE && existsSync(state)) writeFileSync(state, completed, "utf-8");
    }
    rmSync(join(intents, "active-intent"), { force: true });
    const message = String((await asked(proj))?.message);
    expect(message).toContain("finished work, none selected in this chat");
    expect(message).toMatch(STATUS);
    expect(message).not.toContain("engine status --intent");
    expect(message).toContain(NOTHING_ELSE);
  });
});
