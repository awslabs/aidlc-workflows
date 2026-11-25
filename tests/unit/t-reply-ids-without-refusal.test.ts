// covers: hook:aidlc-record-human-turn, subcommand:aidlc-orchestrate:next
// covers: function:openQuestionReplyDirective, function:openPlanQuestionReplyDirective, function:namedMessageWords
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
// The id handed to `next` where a request's id goes is read as that message's
// words handed on, the reading `/aidlc <words>` gets, so a reply at a stop goes
// on without "That question is no longer available" and their typing it again
// with /aidlc in front.
//
// Mechanism: function - the shipped hook through each host's adapter, `next`,
// and `log answer` on the answers corpus fixtures; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { readQuestion } from "../../dist/claude/.claude/tools/aidlc-question-store.ts";
import {
  type AnswersItem, SESSION, STAGE, buildQuestion, env, exec, next, pick, recordByAgent, say,
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
      // The production guard profile sets the switch's variable to 0, which
      // outranks the file, so the line says the recording landed and does not
      // turn the check off here.
      expect(env(proj).AIDLC_DISABLE_REVIEWER_SCOPE_HOOK).toBe("0");
      expect(JSON.parse(readFileSync(join(proj, "aidlc.settings.local.json"), "utf-8")).flags.bypasses)
        .toContain("AIDLC_DISABLE_REVIEWER_SCOPE_HOOK");
      expect(here.stdout).toContain(
        "is recorded off for this project, but AIDLC_DISABLE_REVIEWER_SCOPE_HOOK is set to something other than 1",
      );
      expect(here.stdout).toContain("so the recording does not turn the check off");
      const policy = await run(["engine", "config", "set", "guard-policy", "relaxed", "--message",
        await ask("stop asking me to re-approve when files change")]);
      expect(policy.status, policy.stdout + policy.stderr).toBe(0);
      expect(policy.stdout).toContain("is relaxed for this piece of work");
    });
  }

  // On finished work the message is this chat's turn (standingPersonTurn), so
  // a chat that took part hears its id too (#3608).
  test("under autonomous Construction a typed message gets the line too, and so does one on finished work", async () => {
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
    // No turn is written there; the id is the kept message's, which the record's turns never name.
    const kept = /on record as ([0-9a-f]{8}):/.exec(outside.stdout)?.[1];
    expect(kept, outside.stdout).toBeDefined();
    expect(turns(other).some((row) => auditBlockField(row.block, "Message Id") === kept)).toBe(false);
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

// The agent hands the id the hook's line gave it to `next` where a request's
// id goes. The id names their message, so `next` reads its words as the agent
// handing them on, the reading `/aidlc <words>` gets, never a flag of their
// line: a jump or a setting typed with it ran once, by the line's own command.
describe("t-reply-ids-without-refusal: the line's id handed to next as a request's reads the message's words", () => {
  const WORDS = "looks good, but call the export button Download";
  const GONE = "That question is no longer available; please describe the work again.";
  const DECISIONS = ["GATE_APPROVED", "GATE_REJECTED", "QUESTION_ANSWERED", "DECISION_RECORDED"];
  // What two runs of one step differ by: the ids minted, the project folder, the times kept.
  const shape = (proj: string, out: { directive: Record<string, unknown> | null }): string =>
    JSON.stringify(out.directive)
      .split(proj).join("<proj>")
      .replace(/\b[0-9a-f]{8}\b/g, "<id>")
      .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<at>");
  const at = async (state: string): Promise<string> => {
    const proj = project();
    if (state === "stage-question" || state === "stage-gate") await buildQuestion(proj, state);
    else await buildState(proj, state as Parameters<typeof buildState>[1]);
    // The person replies after what the state kept, as in any chat: the store keeps whole seconds, and two
    // messages of one second sort by their random ids, so a reply in the same second can read as the older line.
    await Bun.sleep(1001 - (Date.now() % 1000));
    return proj;
  };
  // The id of the message one turn kept.
  const kept = async (proj: string, send: () => Promise<unknown>): Promise<string> => {
    const before = new Set(listMessages(proj).map((message) => message.id));
    await send();
    const ids = listMessages(proj).map((message) => message.id).filter((id) => !before.has(id));
    expect(ids).toHaveLength(1);
    return ids[0];
  };
  // `/aidlc <words>` as the person types it, then the skill's first command.
  const typed = async (state: string, line: string): Promise<string> => {
    const proj = await at(state);
    await say(proj, line, "claude");
    return shape(proj, await next(proj, ["--entry"]));
  };
  const handed = async (state: string, prompt: string, beside: string[] = []) => {
    const proj = await at(state);
    const id = await kept(proj, () => say(proj, prompt, "claude"));
    return { proj, id, step: await next(proj, [...beside, "--request", id]) };
  };

  for (const state of ["fresh", "routing-question-open", "plan-offer-open", "work-open", "stage-question", "stage-gate"]) {
    test(`${state}: the reply's id prints the step /aidlc with its words prints`, async () => {
      const proj = await at(state);
      const id = await kept(proj, () => say(proj, WORDS, "claude"));
      const gate = state === "stage-gate" ? readFileSync(seededStateFile(proj), "utf-8") : null;
      const decided = DECISIONS.map((event) => rows(proj, event).length);
      const step = await next(proj, ["--request", id]);
      expect(step.out).not.toContain(GONE);
      expect(step.directive, step.out).not.toBeNull();
      expect(shape(proj, step)).toBe(await typed(state, `/aidlc ${WORDS}`));
      if (gate !== null) {
        // Read, never decided: the gate still waits and nothing is recorded as their answer.
        expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(gate);
        expect(DECISIONS.map((event) => rows(proj, event).length)).toEqual(decided);
      }
    });
  }

  test("their words go on as they typed them, quote marks and spacing kept", async () => {
    const words = 'rename the export button to "Download"  and keep the icon';
    const { proj, step } = await handed("fresh", words);
    const id = /--request ([0-9a-f]{8})/.exec(String(step.directive?.message ?? ""))?.[1];
    expect(id, step.out).toBeDefined();
    expect(readQuestion(proj, id as string)?.text).toBe(words);
  });

  test("a jump typed with the words ran once, by its own line: the id hands on the words and the work stays put", async () => {
    const proj = await at("work-open");
    const id = await kept(proj, () => say(proj, `/aidlc --stage ${STAGE} ${WORDS}`, "claude"));
    await next(proj, ["--entry"]);
    const after = readFileSync(seededStateFile(proj), "utf-8");
    const jumps = rows(proj, "STAGE_JUMPED").length;
    const step = await next(proj, ["--request", id]);
    expect(step.out).not.toContain(GONE);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(after);
    expect(rows(proj, "STAGE_JUMPED")).toHaveLength(jumps);
  });

  test("a reply the record kept cut goes on whole from its copy, and with no copy kept says the question is gone", async () => {
    // Past the record's cut a typed prompt is kept whole beside it, up to the request cap; past the cap only its
    // first part is kept, and a part never goes on as their words.
    const long = `${"keep every column of the export, ".repeat(300)}and call the button Download`;
    const { proj, step } = await handed("fresh", long);
    const id = /--request ([0-9a-f]{8})/.exec(String(step.directive?.message ?? ""))?.[1];
    expect(id, step.out.slice(0, 400)).toBeDefined();
    expect(readQuestion(proj, id as string)?.text).toBe(long);
    const over = await handed("fresh", "keep every column. ".repeat(8000));
    expect(over.step.directive).toMatchObject({ kind: "error", message: GONE });
  });

  test("a question-box answer's id hands on the words it carried", async () => {
    const item = {
      question: "stage-question", input: "PostgreSQL",
      picker: { question: QUESTION, options: ["PostgreSQL", "SQLite", "Other"], answer: "PostgreSQL" },
    } as unknown as AnswersItem;
    const proj = await at("stage-question");
    const id = await kept(proj, () => pick(proj, item, "claude"));
    const step = await next(proj, ["--request", id]);
    expect(step.out).not.toContain(GONE);
    const twin = await at("stage-question");
    await pick(twin, item, "claude");
    expect(shape(proj, step)).toBe(shape(twin, await next(twin, ["PostgreSQL"])));
  });

  test("the agent's own flags beside the id give way to the message's words", async () => {
    const { proj, step } = await handed("work-open", WORDS, ["--scope", "bugfix"]);
    expect(step.out).not.toContain(GONE);
    const alone = await handed("work-open", WORDS);
    expect(shape(proj, step)).toBe(shape(alone.proj, alone.step));
  });

  test("an id that names no request and no words of theirs still says the question is gone", async () => {
    const lines = [WORDS, "/aidlc --depth minimal", "/aidlc --request deadbeef looks good"];
    for (const [index, line] of lines.entries()) {
      const { proj, id } = await handed("work-open", line);
      const named = index === 0 ? "deadbeef" : id;
      const step = await next(proj, ["--request", named]);
      expect(step.directive, `${line}: ${step.out}`).toMatchObject({ kind: "error", message: GONE });
    }
  });
});
