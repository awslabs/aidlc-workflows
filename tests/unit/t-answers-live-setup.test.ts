// covers: file:tests/harness/aidlc-answers-corpus.ts
//
// What the live answers check can set up in a fresh chat, the way a person meets it. A question the agent asked in
// chat is not shown again by a bare `/aidlc`, so only its replies typed with `/aidlc` are driven live. A verification
// command or Construction policy answer is bound to the chat that asked, and guard recovery's fixture cannot be met,
// so those are not driven live at all. And the open work carrying on after a routing reply is counted from that reply,
// not from the rows the chat writes as it opens.
//
// Mechanism: function - the live pool over the corpus, and the engine's own steps on the fixtures (the human-turn
// hook, the session-start hook, `next`); no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { listIntents, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  ANSWERS, ASKED_IN_CHAT, NOT_LIVE, SESSION, buildQuestion, env, exec, liveReply, next, say, workCarriedOn,
} from "../harness/aidlc-answers-corpus.ts";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});
const OTHER_CHAT = "01995000-7a11-7000-8000-00000000e002";
/** A chat opening on the project: the shipped session-start hook, as Claude Code runs it. */
async function opens(proj: string, session: string): Promise<void> {
  const opened = await exec([process.execPath, join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "session-start"], {
    cwd: proj, env: { ...env(proj, { session }), CLAUDE_PROJECT_DIR: proj },
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: session, source: "startup", cwd: proj }),
  });
  expect(opened.status, opened.stderr).toBe(0);
}
/** A scratch project on the shipped Claude Code tree, as the live drive sets one up. */
function project(): string {
  const proj = setupIntegrationProject();
  projects.push(proj);
  return proj;
}

describe("the live answers check in a fresh chat", () => {
  test("a question asked in chat is driven live only by its /aidlc replies, and the chat-bound ones and guard recovery not at all", () => {
    const live = (question: string) => ANSWERS.filter((item) => item.question === question && liveReply(item)).map((item) => item.via);
    for (const question of ASKED_IN_CHAT) expect(live(question).every((via) => via === "aidlc"), question).toBe(true);
    expect(live("verification-command")).toEqual([]);
    expect(live("construction-policy")).toEqual([]);
    expect(live("stage-question")).toEqual(["aidlc"]);
    expect(live("learnings")).toEqual([]);
    for (const question of NOT_LIVE) expect(live(question), question).toEqual([]);
    // Every other question keeps every reply.
    const others = ANSWERS.filter((item) => !ASKED_IN_CHAT.has(item.question) && !NOT_LIVE.has(item.question));
    expect(others.every(liveReply)).toBe(true);
  });

  test("a bare /aidlc in a fresh chat resumes the stage without the open chat question; with words it hands the question back", async () => {
    // If a bare re-entry ever shows the open question, the chat replies of these questions can be driven live again.
    const proj = project();
    await buildQuestion(proj, "stage-question");
    await say(proj, "/aidlc", "claude");
    const bare = await next(proj, []);
    expect(bare.directive?.kind).toBe("run-stage");
    await say(proj, "/aidlc PostgreSQL", "claude");
    const words = await next(proj, ["PostgreSQL"]);
    expect(words.directive?.kind).toBe("print");
    expect(String(words.directive?.message ?? "")).toContain("has a question you asked that the person has not answered yet");
  });

  // If a new chat can ever record these answers, their /aidlc replies can be driven live again.
  for (const [question, stage, flags] of [
    ["verification-command", "code-generation", ["--command", "npm test"]],
    ["construction-policy", "functional-design", ["--field", "Construction Execution", "--value", "swarm"]],
  ] as const) {
    test(`a ${question} answer is recorded only from the chat that asked it`, async () => {
      const answer = async (session: string) => {
        const proj = project();
        await buildQuestion(proj, question);
        if (session !== SESSION) await opens(proj, session);
        await say(proj, "/aidlc 2", "claude", { session });
        await next(proj, ["2"], { session });
        return exec([process.execPath, join(proj, ".claude", "tools", "aidlc-log.ts"), "answer", "--stage", stage, "--checkpoint", question,
          ...flags, "--details", "Request Changes"], { cwd: proj, env: env(proj, { session }) });
      };
      expect((await answer(SESSION)).status).toBe(0);
      const elsewhere = await answer(OTHER_CHAT);
      expect(elsewhere.status).toBe(1);
      expect(elsewhere.stdout + elsewhere.stderr).toContain("Session exists in the current workflow");
    });
  }

  test("the work carrying on after a routing reply is counted from the reply, not from the chat's opening rows", async () => {
    const proj = project();
    await buildQuestion(proj, "routing");
    const start = readAuditShardEvents(proj).length;
    const records = listIntents(proj).length;
    // The chat opens: the shipped session-start hook writes its row before the person says anything.
    await opens(proj, SESSION);
    await say(proj, "/aidlc fix the login", "claude");
    const read = await next(proj, ["fix", "the", "login"]);
    const request = /--request ([0-9a-f]+)/.exec(String(read.directive?.message ?? ""))?.[1];
    expect(request).toBeDefined();
    const asked = await next(proj, ["--request", request!, "--propose", "bugfix"]);
    expect(asked.directive?.kind).toBe("ask");
    expect(readAuditShardEvents(proj).slice(start).map((row) => row.event)).toContain("SESSION_STARTED");
    // The person replies now: nothing has carried on yet, though rows were written since the drive began.
    const reply = readAuditShardEvents(proj).length;
    expect(workCarriedOn(proj, records, reply)).toBe(false);
    expect(workCarriedOn(proj, records, start)).toBe(true);
    await say(proj, "1", "claude");
    expect(workCarriedOn(proj, records, reply)).toBe(false);
    appendAuditEntry("STAGE_STARTED", { Stage: "requirements-analysis" }, proj);
    expect(workCarriedOn(proj, records, reply)).toBe(true);
  });
});
