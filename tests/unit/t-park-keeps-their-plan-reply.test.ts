// covers: subcommand:aidlc-orchestrate:park, function:withdrawPlanApprovalReplies, function:planApprovalKeptReplyWaits
//
// A park takes back only the message that asked for it from the open code plan
// question. Seen live on Claude Code: with the plan question open, the person
// typed what to change, the agent asked in its own question box whether to
// change the plan now or stop, and the person picked the stop; the park then
// dropped the latest reply the plan question kept, which was their change, so
// the next chat asked "Approve the code plan?" with nothing of it. The
// conductor's own park (no --person-asked) dropped their "1" the same way.
// The stop is the person's latest turn in this chat, in the order the turns
// came, also in a team clone whose teammate's shard sorts after this one.
//
// Spawns the real engine and Claude Code's own human-turn hook.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, seededAuditShard } from "../harness/fixtures.ts";
import { buildState, DISPATCHER, env, exec, next, ORCHESTRATE, say, SESSION } from "../harness/aidlc-input-corpus.ts";
import { planApprovalKeptReplyWaits } from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const CHANGE = "use a Map for the titles in step 2 instead of an array";
const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

async function planQuestionOpen(): Promise<string> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  await buildState(proj, "plan-question-open");
  return proj;
}

// The replies the open code plan question keeps, in order.
function kept(proj: string): string[] {
  const files = [...new Bun.Glob("**/ask-*.json").scanSync({ cwd: proj, dot: true })];
  return files.flatMap((file) =>
    (JSON.parse(readFileSync(join(proj, file), "utf-8")).replies ?? []).map((reply: { text: string }) => reply.text));
}

// A pick in the agent's own question box (Claude Code's AskUserQuestion).
async function pick(proj: string, question: string, options: string[], chosen: string): Promise<void> {
  const asked = [{ question, header: "Next", multiSelect: false, options: options.map((label) => ({ label, description: "" })) }];
  const hook = await exec([process.execPath, DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    env: env(proj),
    input: JSON.stringify({
      hook_event_name: "PostToolUse", session_id: SESSION, cwd: proj, tool_name: "AskUserQuestion",
      tool_input: { questions: asked }, tool_response: { questions: asked, answers: { [question]: chosen } },
    }),
  });
  expect(hook.status, `${hook.stdout}${hook.stderr}`).toBe(0);
}

async function park(proj: string, args: string[] = []): Promise<void> {
  const parked = await exec([process.execPath, ORCHESTRATE, "park", ...args, "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(parked.status, `${parked.stdout}${parked.stderr}`).toBe(0);
  expect(JSON.parse(parked.stdout).kind, parked.stdout).toBe("parked");
  const unparked = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-state.ts"), "unpark", "--project-dir", proj],
    { cwd: proj, env: env(proj) });
  expect(unparked.status, `${unparked.stdout}${unparked.stderr}`).toBe(0);
}

describe("a park takes back only the message that asked for it", () => {
  test("a stop picked in the agent's own question box leaves the change they typed before it", async () => {
    const proj = await planQuestionOpen();
    await say(proj, CHANGE, "claude");
    await pick(proj, "What would you like to do with the plan?", ["Revise the plan now", "Stop here for today"],
      "Stop here for today");
    await park(proj, ["--person-asked"]);
    expect(kept(proj)).toEqual([CHANGE]);
    expect(planApprovalKeptReplyWaits(proj)).toBe(true);
  });

  test("a stop they typed is taken back, and their reply before it stays", async () => {
    const proj = await planQuestionOpen();
    await say(proj, CHANGE, "claude");
    await say(proj, "let's stop here for today", "claude");
    await park(proj, ["--person-asked"]);
    expect(kept(proj)).toEqual([CHANGE]);
  });

  test("in a team clone, a teammate's shard that sorts after this one does not stand in for the stop", async () => {
    const proj = await planQuestionOpen();
    await say(proj, CHANGE, "claude");
    await say(proj, "let's stop here for today", "claude");
    const mine = seededAuditShard(proj);
    writeFileSync(join(dirname(mine), `zz-teammate-${basename(mine)}`), [
      "## HUMAN_TURN", "**Timestamp**: 2026-01-01T00:00:01Z", "**Event**: HUMAN_TURN",
      "**Session**: 01995000-7a11-7000-8000-0000000000aa", "**Origin**: person",
      "**Source**: typed", "**Message Id**: aaaaaaaa", "", "---", "",
    ].join("\n"));
    await park(proj, ["--person-asked"]);
    expect(kept(proj)).toEqual([CHANGE]);
  });

  test("the conductor's own park leaves their reply for the plan question", async () => {
    const proj = await planQuestionOpen();
    await say(proj, "1", "claude");
    await park(proj);
    expect(kept(proj)).toEqual(["1"]);
    const answer = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage",
      "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan", "--project-dir", proj],
      { cwd: proj, env: env(proj) });
    expect(answer.status, `${answer.stdout}${answer.stderr}`).toBe(0);
    expect((await next(proj, [])).directive?.kind).toBe("run-stage");
  });
});
