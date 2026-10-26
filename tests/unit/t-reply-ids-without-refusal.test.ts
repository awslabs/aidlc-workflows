// covers: hook:aidlc-record-human-turn, subcommand:aidlc-orchestrate:next
// covers: function:openQuestionReplyDirective, function:openPlanQuestionReplyDirective
//
// The agent learns the id of the person's message without meeting a refusal
// first, and never from their words. On the work, the human-turn hook's line
// to the agent names the message it just kept, on the hosts that hand that line
// to the agent alone (Claude Code, Codex, Kiro CLI); Kiro IDE draws a chat card
// for each command hook, unmeasured for what it shows, so there, as on Copilot,
// the steps carry the ids. A check the person asks in chat to change with
// nothing waiting on them needs the id too, or the setter refuses the first
// call in engine words before the retry lands (nightly 2026-10-25, 9 of 9 chat
// requests on Claude Code). A chat on finished work gets no line.
// The steps `next` prints for a reply
// at an open question name this chat's replies by id and time, oldest first.
// And the step for a reply at the agent's own open question carries the
// question as it was asked, with its choices: in a second Claude Code chat
// "/aidlc postgres" answered an open question, the step handed no question, the
// agent sent the words on as new work and asked "What should I do?", and
// nothing was recorded (nightly 2026-10-22). Now the agent records the answer,
// nothing is routed, and the next step moves on.
//
// Mechanism: function - the shipped hook through each host's adapter, `next`,
// and `log answer` on the answers corpus fixtures; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  type AnswersItem, SESSION, STAGE, buildQuestion, env, exec, next, recordByAgent, say,
} from "../harness/aidlc-answers-corpus.ts";
import { DISPATCHER, buildState } from "../harness/aidlc-input-corpus.ts";
import { cleanupTestProject, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});
const OTHER_CHAT = "01995000-7a11-7000-8000-00000000e00b";
const QUESTION = "Which database should the to-do app use?";

function project(): string {
  const proj = setupIntegrationProject();
  projects.push(proj);
  return proj;
}

const turns = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN");
const latestId = (proj: string) => auditBlockField(turns(proj).at(-1)!.block, "Message Id")!;
const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);

/** A chat opening on the project: the shipped session-start hook, as Claude Code runs it. */
async function opens(proj: string, session: string): Promise<void> {
  const opened = await exec([process.execPath, join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "session-start"], {
    cwd: proj, env: { ...env(proj, { session }), CLAUDE_PROJECT_DIR: proj },
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: session, source: "startup", cwd: proj }),
  });
  expect(opened.status, opened.stderr).toBe(0);
}

async function answer(proj: string, details: string, session = SESSION) {
  return exec([process.execPath, join(proj, ".claude", "tools", "aidlc-log.ts"), "answer", "--stage", STAGE,
    "--details", details], { cwd: proj, env: env(proj, { session }) });
}

describe("t-reply-ids-without-refusal: the hook's line names the kept message", () => {
  for (const harness of ["claude", "codex", "kiro"] as const) {
    test(`${harness}: at an open question the line names the message and none of its words`, async () => {
      const proj = project();
      await buildQuestion(proj, "stage-question");
      const said = await say(proj, "postgres, it is what we run", harness);
      expect(said.status, said.stderr).toBe(0);
      const id = latestId(proj);
      expect(said.stdout).toContain(`on record as ${id}`);
      expect(said.stdout).not.toContain("postgres, it is what we run");
    });
  }

  for (const harness of ["copilot", "kiro-ide"] as const) {
    test(`${harness}: the person may see what its adapter hands on, so no id line; the step names the ids instead`, async () => {
      const proj = project();
      await buildQuestion(proj, "stage-question");
      const said = await say(proj, "postgres, it is what we run", harness);
      expect(said.status, said.stderr).toBe(0);
      expect(said.stdout).not.toContain("on record as");
    });
  }

  test("at an open gate the line names the message too", async () => {
    const proj = project();
    await buildQuestion(proj, "stage-gate");
    const said = await say(proj, "looks good, approve", "claude");
    expect(said.stdout).toContain(`on record as ${latestId(proj)}`);
  });

  test("a command line or an unattended run has no line; once the question is answered, the next message still does", async () => {
    const proj = project();
    await buildQuestion(proj, "stage-question");
    const command = await say(proj, "/aidlc --status", "claude");
    expect(command.stdout).not.toContain("on record as");
    const unattended = await say(proj, "postgres", "claude", { env: { AIDLC_UNATTENDED: "1" } });
    expect(unattended.stdout).not.toContain("on record as");
    await say(proj, "postgres", "claude");
    const recorded = await answer(proj, "PostgreSQL");
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const after = await say(proj, "thanks", "claude");
    expect(after.stdout).toContain(`on record as ${latestId(proj)}`);
    expect(after.stdout).not.toContain("thanks");
  });

  for (const harness of ["claude", "codex", "kiro"] as const) {
    test(`${harness}: a guard change asked in chat with nothing open lands on the first call, naming the message the line gave`, async () => {
      const proj = project();
      await buildState(proj, "work-open");
      const run = (args: string[]) => exec([process.execPath, DISPATCHER, ...args], { cwd: proj, env: env(proj) });
      const ask = async (words: string): Promise<string> => {
        const said = await say(proj, words, harness);
        expect(said.status, said.stderr).toBe(0);
        const id = /on record as ([^:\s]+):/.exec(said.stdout)?.[1];
        expect(id, said.stdout).toBe(latestId(proj));
        expect(said.stdout).not.toContain(words);
        return id as string;
      };
      const work = await run(["engine", "config", "set", "guard.review-freeze", "off", "--message",
        await ask("turn the review freeze check off")]);
      expect(work.status, work.stdout + work.stderr).toBe(0);
      expect(work.stdout).toContain("is off for this piece of work");
      const here = await run(["config", "flags", "--bypass", "AIDLC_DISABLE_REVIEWER_SCOPE_HOOK", "--local", "--yes",
        "--message", await ask("turn the reviewer read scope check off for this project")]);
      expect(here.status, here.stdout + here.stderr).toBe(0);
      expect(here.stdout).toContain("Recorded AIDLC_DISABLE_REVIEWER_SCOPE_HOOK");
      const policy = await run(["engine", "config", "set", "guard-policy", "relaxed", "--message",
        await ask("stop asking me to re-approve when files change")]);
      expect(policy.status, policy.stdout + policy.stderr).toBe(0);
      expect(policy.stdout).toContain("is relaxed for this piece of work");
    });
  }

  test("under autonomous Construction a typed message gets the line too; on finished work there is none", async () => {
    const proj = project();
    await buildState(proj, "work-open");
    const state = seededStateFile(proj);
    writeFileSync(state, readFileSync(state, "utf-8").replace(/^(- \*\*Current Stage\*\*:.*)$/m,
      "$1\n- **Construction Autonomy Mode**: autonomous"), "utf-8");
    expect(readFileSync(state, "utf-8")).toContain("- **Construction Autonomy Mode**: autonomous");
    const autonomous = await say(proj, "turn plan approval back on", "claude");
    expect(autonomous.stdout).toContain(`on record as ${latestId(proj)}`);
    const other = project();
    await buildState(other, "finished");
    const outside = await say(other, "turn the review freeze check off", "claude");
    expect(outside.status, outside.stderr).toBe(0);
    expect(outside.stdout).not.toContain("on record as");
  });
});

describe("t-reply-ids-without-refusal: the reply steps name ids and times, and the open question as it was asked", () => {
  test("the open-question step names this chat's replies oldest first, with their times, and never their words", async () => {
    const proj = project();
    await buildQuestion(proj, "stage-question");
    await say(proj, "hmm, thinking", "claude");
    const first = latestId(proj);
    await say(proj, "/aidlc postgres please", "claude");
    const second = latestId(proj);
    const step = await next(proj, ["postgres please"]);
    const message = String(step.directive?.message ?? "");
    expect(message).toContain(`"${QUESTION}"`);
    expect(message).toContain('"PostgreSQL"');
    const ids = message.indexOf(first);
    expect(ids, message).toBeGreaterThan(-1);
    expect(message.indexOf(second)).toBeGreaterThan(ids);
    expect(message).toContain("add `--message <id>` to the `log answer`");
    expect(message).not.toContain("postgres please");
    expect(message).not.toContain("hmm, thinking");
  });

  test("the plan-question step names the replies by id and time", async () => {
    const proj = project();
    await buildQuestion(proj, "code-plan");
    await say(proj, "/aidlc looks fine, build it", "claude");
    const id = latestId(proj);
    const step = await next(proj, ["looks fine, build it"]);
    const message = String(step.directive?.message ?? "");
    expect(message).toContain("The code plan question is open");
    expect(message).toContain(id);
    expect(message).not.toContain("looks fine, build it");
  });

  // Nightly 2026-10-22 (M15), a second Claude Code chat.
  test("a second chat's '/aidlc postgres' is read against the question it answers and recorded, nothing routed", async () => {
    const proj = project();
    await buildQuestion(proj, "stage-question");
    await opens(proj, OTHER_CHAT);
    await say(proj, "/aidlc postgres", "claude", { session: OTHER_CHAT });
    const id = latestId(proj);
    const step = await next(proj, ["postgres"], { session: OTHER_CHAT });
    expect(step.directive?.kind).toBe("print");
    const message = String(step.directive?.message ?? "");
    expect(message).toContain(`"${QUESTION}"`);
    expect(message).toContain('"PostgreSQL"');
    expect(message).toContain(id);
    // The agent reads "postgres" as the first choice and records it.
    const recorded = await answer(proj, "PostgreSQL", OTHER_CHAT);
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const answered = rows(proj, "QUESTION_ANSWERED").at(-1)!;
    expect(auditBlockField(answered.block, "Message Id")).toBe(id);
    expect(auditBlockField(answered.block, "Person Reply")).toBe("postgres");
    expect(rows(proj, "REQUEST_ROUTED")).toHaveLength(0);
    // No loop: the next step is not the same question again.
    const after = await next(proj, [], { session: OTHER_CHAT });
    expect(String(after.directive?.message ?? "")).not.toContain("has a question you asked that the person has not answered yet");
    expect(rows(proj, "REQUEST_ROUTED")).toHaveLength(0);
  });
});

describe("t-reply-ids-without-refusal: a checkpoint's row and a routing row name the messages they stand on", () => {
  for (const question of ["unit-checkpoint", "batch-checkpoint"] as const) {
    for (const [choice, words] of [["Approve", "approve it"], ["Request Changes", "rename the alpha handler"]] as const) {
      test(`${question}: ${choice} recorded with no --message names the reply it stands on`, async () => {
        const proj = project();
        await buildQuestion(proj, question);
        await say(proj, words, "claude");
        const id = latestId(proj);
        const item = { question, input: words, expected: { end: { parked: false } } } as unknown as AnswersItem;
        const done = await recordByAgent(proj, item, choice);
        expect(done?.exec.status, `${done?.exec.stdout}${done?.exec.stderr}`).toBe(0);
        const row = rows(proj, choice === "Approve" ? "GATE_APPROVED" : "GATE_REJECTED").at(-1)!;
        expect(auditBlockField(row.block, "Message Id")).toBe(id);
      });
    }
  }

  test("words sent to separate new work: the routing row names the reply it stands on", async () => {
    const proj = project();
    await buildQuestion(proj, "stage-question");
    await say(proj, "/aidlc also handle an empty list", "claude");
    const request = latestId(proj);
    const read = await next(proj, ["also handle an empty list"]);
    const ask = /`[^`]* next (--request [0-9a-f]{8})`/.exec(String(read.directive?.message ?? ""))?.[1];
    expect(ask, read.out).toBeDefined();
    const routing = await next(proj, (ask as string).split(" "));
    expect(routing.directive?.ask_type, routing.out).toBe("new-work-routing");
    await say(proj, "2", "claude");
    const reply = latestId(proj);
    const command = String((routing.directive as Record<string, unknown> | null)?.new_intent_command ?? "");
    await next(proj, command.replace(/^.* next /, "").split(" "));
    const routed = rows(proj, "REQUEST_ROUTED");
    expect(routed).toHaveLength(1);
    expect(auditBlockField(routed[0].block, "Message Id")).toBe(reply);
    expect(reply).not.toBe(request);
  });
});
