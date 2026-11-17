// covers: subcommand:aidlc-orchestrate:next, function:openFrontQuestion, function:planProposalDirective, function:newestRequestReplaces
//
// A new /aidlc request typed while an earlier request's plan question still
// waits, with no work started, is the one the work plans from and records
// (#3609). Live on Kiro CLI 3.1.0 on Windows Server: the person quit at the plan
// question, typed the whole request in a new chat, and the agent's step said a
// plan question waits without saying what for; it showed one it made up, and
// Express started the first chat's words. On Claude Code the newer words were
// planned and recorded, but the earlier request's question stayed open and met
// the person's next words during the work. The agent still reads whether their
// words answer the question; the engine names the waiting request, keeps the
// newer words as one chat keeps them, marks the earlier request replaced and
// says once that the newer one is used. Driven over the real human-turn hook,
// the real engine and the real creation step.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createOrchestrationTestProject, proposalFollowUp } from "../harness/fixtures.ts";
import {
  DISPATCHER,
  type Directive,
  env,
  exec,
  type Harness,
  next as engineNext,
  say,
  SECOND_SESSION,
  SESSION,
} from "../harness/aidlc-input-corpus.ts";
import { auditBlockField, getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SHORT = "build a small greeter command-line tool";
const FULLER =
  `build a small greeter command-line tool that prints "Hello, <name>!" and copes with names like O'Brien & Smith. Keep it simple!`;
const WAITS = "has not answered the plan question";
const NEWER = "I've used your newer request";
const lineFor = (words: string): string => `${NEWER}: "${words}".`;

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function fresh(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  return proj;
}

// The record keeps a message's time to the second: a reply lands in a later one.
const later = (): Promise<void> => Bun.sleep(1100);

/** `next` as the agent runs it, with the host's own engine tree. */
async function next(proj: string, harness: Harness, session: string, args: string[]): Promise<Directive> {
  if (harness === "claude") {
    const r = await engineNext(proj, args, { session });
    expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
    return r.directive as Directive;
  }
  const tool = join(proj, ".kiro", "tools", "aidlc-orchestrate.ts");
  const r = await exec([process.execPath, tool, "next", "--project-dir", proj, ...args], { cwd: proj, env: env(proj, { session }) });
  try {
    return JSON.parse(r.stdout.trim()) as Directive;
  } catch {
    throw new Error(`no directive: ${r.stdout}${r.stderr}`);
  }
}

/** The agent's plan for a proposal step (express, as the agent proposes for these words), or the step itself. */
async function proposed(proj: string, harness: Harness, session: string, step: Directive): Promise<Directive> {
  const follow = proposalFollowUp(step, "express");
  return follow === null ? step : next(proj, harness, session, follow);
}

/**
 * The person types `/aidlc <words>` in `session` and the agent runs `next` with
 * them as `argv` (Claude Code's one argument by default), or bare on Kiro IDE,
 * where the engine takes their line from the record.
 */
async function asks(proj: string, session: string, words: string, opts: { harness?: Harness; argv?: string[] } = {}): Promise<Directive> {
  const harness = opts.harness ?? "claude";
  const said = await say(proj, `/aidlc ${words}`, harness, { session });
  expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
  const argv = opts.argv ?? (harness === "kiro-ide" ? [] : [words]);
  return proposed(proj, harness, session, await next(proj, harness, session, argv));
}

/** The agent's reading that the words are a request: the waiting step's own command for their newest words. */
async function newestReading(proj: string, session: string, waiting: Directive, harness: Harness = "claude"): Promise<Directive> {
  expect(waiting.kind, JSON.stringify(waiting).slice(0, 300)).toBe("print");
  expect(String(waiting.message)).toContain(WAITS);
  const file = /next --request-file (\S+?)`/.exec(String(waiting.message))?.[1];
  expect(file, String(waiting.message)).toBeDefined();
  return proposed(proj, harness, session, await next(proj, harness, session, ["--request-file", file as string]));
}

/** The engine's commands, from a step's `next` on. */
const argsOf = (command: unknown): string[] => String(command).replace(/^.*? next /, "").split(" ");

/** The person picks the plan question's go-ahead in `session`, and the agent runs the creation it returns. */
async function picks(proj: string, session: string, question: Directive, harness: Harness = "claude"): Promise<void> {
  expect(question.kind, JSON.stringify(question).slice(0, 300)).toBe("ask");
  await later();
  await say(proj, "Go ahead with the express plan", harness, { session });
  creates(proj, session, await next(proj, harness, session, argsOf(question.confirm_command)));
}

/** The creation step `next` hands the agent, run as the agent runs it. */
function creates(proj: string, session: string, step: Directive): void {
  const command = /Run `[^`]*?engine (intent create [^`]*)`/.exec(String(step.message))?.[1];
  expect(command, JSON.stringify(step).slice(0, 400)).toBeDefined();
  const args = (command as string).replace("<2-3 word kebab essence>", "the-work").split(" ")
    .map((arg) => arg.replace(/^["'](.*)["']$/, "$1"));
  const r = spawnSync(process.execPath, [DISPATCHER, "engine", ...args, "--project-dir", proj], {
    cwd: proj, env: env(proj, { session }), encoding: "utf-8",
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

/** Where the work's record keeps its request: the description, the Project line, the Workflow Start's Request. */
function recorded(proj: string): { description: string; project: string; started: Array<string | null> } {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const dir = readdirSync(intents).find((name) => existsSync(join(intents, name, "project-description.json"))) ?? "";
  return {
    description: JSON.parse(readFileSync(join(intents, dir, "project-description.json"), "utf-8")) as string,
    project: getField(readFileSync(join(intents, dir, "aidlc-state.md"), "utf-8"), "Project") ?? "",
    started: readAuditShardEvents(proj).filter((row) => row.event === "WORKFLOW_STARTED")
      .map((row) => auditBlockField(row.block, "Request")),
  };
}

/** The lines a step has the agent say to the person that announce the newer request. */
const newerLines = (step: Directive): string[] =>
  ((step.change_notices as string[] | undefined) ?? []).filter((line) => line.startsWith(NEWER));

/** The question copies the engine keeps. */
function questions(proj: string): Array<{ id: string; text: string; replacedBy?: string }> {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")))
    : [];
}

/** The person's next /aidlc words once the work is under way, as the agent hands them over. */
async function wordsDuringWork(proj: string, session: string): Promise<Directive> {
  await later();
  await say(proj, "/aidlc also add a --shout flag", "claude", { session });
  return next(proj, "claude", session, ["also add a --shout flag"]);
}

describe("t-newest-request-wins: the newest request is the one the work plans from and records", () => {
  test("a fuller request typed in a new chat while the first one's plan question waits", async () => {
    const proj = fresh();
    expect((await asks(proj, SESSION, SHORT)).kind).toBe("ask");
    await later();
    const waiting = await asks(proj, SECOND_SESSION, FULLER);
    // The step names the request the waiting question was for: the new chat never saw it.
    expect(String(waiting.message)).toContain(`${WAITS} they were asked about "${SHORT}"`);
    expect(String(waiting.message)).toContain(`which keeps every word of theirs (${JSON.stringify(FULLER)})`);
    const question = await newestReading(proj, SECOND_SESSION, waiting);
    expect(question.kind, JSON.stringify(question).slice(0, 300)).toBe("ask");
    expect(String(question.question)).toContain(`for: "${FULLER}"`);
    expect(newerLines(question)).toEqual([lineFor(FULLER)]);
    await picks(proj, SECOND_SESSION, question);
    expect(recorded(proj)).toEqual({ description: FULLER, project: FULLER, started: [`/aidlc ${FULLER}`] });
    // The replaced request's question never meets the person's words again.
    const during = await wordsDuringWork(proj, SECOND_SESSION);
    expect(JSON.stringify(during)).not.toContain(WAITS);
  });

  test("the plan question shown again for the newer request says the line no second time", async () => {
    const proj = fresh();
    await asks(proj, SESSION, SHORT);
    await later();
    const question = await newestReading(proj, SECOND_SESSION, await asks(proj, SECOND_SESSION, FULLER));
    expect(newerLines(question)).toEqual([lineFor(FULLER)]);
    const root = questions(proj).find((q) => q.text === FULLER && q.id !== question.question_id)?.id;
    expect(root, JSON.stringify(questions(proj))).toBeDefined();
    const again = await next(proj, "claude", SECOND_SESSION, ["--propose", "express", "--request", root as string]);
    expect(again.kind, JSON.stringify(again).slice(0, 300)).toBe("ask");
    expect(newerLines(again)).toEqual([]);
  });

  test("a different request in the same chat at the waiting question is the newest too", async () => {
    const proj = fresh();
    await asks(proj, SESSION, SHORT);
    await later();
    const other = "add a word counter to the notes page";
    const question = await newestReading(proj, SESSION, await asks(proj, SESSION, other));
    expect(newerLines(question)).toEqual([lineFor(other)]);
    await picks(proj, SESSION, question);
    expect(recorded(proj).description).toBe(other);
  });

  // The engine records the words and never compares them: the same request
  // typed again is the newest one too.
  test("the same words typed again in a new chat take the waiting request's place too", async () => {
    const proj = fresh();
    await asks(proj, SESSION, SHORT);
    await later();
    const question = await newestReading(proj, SECOND_SESSION, await asks(proj, SECOND_SESSION, SHORT));
    expect(question.kind).toBe("ask");
    expect(newerLines(question)).toEqual([lineFor(SHORT)]);
  });

  test("the newer request with a plan named starts at once, says the line, and the replaced question stays gone", async () => {
    const proj = fresh();
    await asks(proj, SESSION, SHORT);
    await later();
    // `/aidlc express <words>`: the agent gives the plan's name its own argument.
    const step = await asks(proj, SECOND_SESSION, `express ${FULLER}`, { argv: ["express", FULLER] });
    creates(proj, SECOND_SESSION, step);
    expect(recorded(proj).description).toBe(FULLER);
    const first = await next(proj, "claude", SECOND_SESSION, []);
    expect(newerLines(first)).toEqual([lineFor(FULLER)]);
    expect(JSON.stringify(await wordsDuringWork(proj, SECOND_SESSION))).not.toContain(WAITS);
  });

  // /aidlc-init with only a description hands it on as new work (`next --new-intent`).
  test("the newer request started with /aidlc-init takes the waiting one's place too", async () => {
    const proj = fresh();
    await asks(proj, SESSION, SHORT);
    await later();
    await say(proj, `/aidlc-init ${FULLER}`, "claude", { session: SECOND_SESSION });
    const question = await proposed(proj, "claude", SECOND_SESSION, await next(proj, "claude", SECOND_SESSION, ["--new-intent", FULLER]));
    expect(newerLines(question), JSON.stringify(question).slice(0, 400)).toEqual([lineFor(FULLER)]);
    await picks(proj, SECOND_SESSION, question);
    expect(recorded(proj).description).toBe(FULLER);
    expect(JSON.stringify(await wordsDuringWork(proj, SECOND_SESSION))).not.toContain(WAITS);
  });

  // Archived work is no work in hand: the request after it gets the fresh plan step.
  test("with only archived work here, the newer request takes the waiting one's place too", async () => {
    const proj = fresh();
    await picks(proj, SESSION, await asks(proj, SESSION, "an old notes app"));
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const old = readdirSync(intents).find((name) => name.endsWith("-the-work")) ?? "";
    const archived = spawnSync(process.execPath, [DISPATCHER, "engine", "intent", "archive", old, "--project-dir", proj], {
      cwd: proj, env: env(proj, { session: SESSION }), encoding: "utf-8",
    });
    expect(archived.status, `${archived.stdout}${archived.stderr}`).toBe(0);
    await later();
    await asks(proj, SESSION, SHORT);
    await later();
    const question = await newestReading(proj, SECOND_SESSION, await asks(proj, SECOND_SESSION, FULLER));
    expect(newerLines(question)).toEqual([lineFor(FULLER)]);
    await picks(proj, SECOND_SESSION, question);
    expect(JSON.stringify(await wordsDuringWork(proj, SECOND_SESSION))).not.toContain(WAITS);
  });

  test("the newer request sent to a tailored plan marks the waiting one replaced and says the line", async () => {
    const proj = fresh();
    await asks(proj, SESSION, SHORT);
    await later();
    await say(proj, `/aidlc compose ${FULLER}`, "claude", { session: SECOND_SESSION });
    const dispatch = await next(proj, "claude", SECOND_SESSION, ["compose", FULLER]);
    expect(questions(proj).filter((q) => q.text === SHORT).every((q) => q.replacedBy !== undefined), JSON.stringify(questions(proj)))
      .toBe(true);
    expect(newerLines(dispatch), JSON.stringify(dispatch).slice(0, 400)).toEqual([lineFor(FULLER)]);
  });
});

describe("t-newest-request-wins: the newer words are kept as one chat keeps them", () => {
  // Quote marks, an apostrophe, an ampersand, two spaces and a Windows line break.
  const WHOLE = `a greeter that prints "Hello,  <name>!"\r\nand copes with O'Brien & Smith. Keep it simple!`;

  async function oneChat(argv: string[] | undefined, harness: Harness): Promise<ReturnType<typeof recorded>> {
    const proj = fresh();
    await picks(proj, SESSION, await asks(proj, SESSION, WHOLE, { harness, argv }), harness);
    return recorded(proj);
  }

  test.each([
    ["Claude Code, one argument", "claude" as Harness, [WHOLE]],
    ["one argument per word, as Kiro CLI hands them over", "claude" as Harness, WHOLE.split(/\s+/)],
    ["Kiro IDE, a bare next that takes the line from the record", "kiro-ide" as Harness, undefined],
  ])("%s", async (_shape, harness, argv) => {
    const alone = await oneChat(argv, harness);
    const proj = fresh();
    await asks(proj, SESSION, SHORT, { harness, argv: harness === "kiro-ide" ? undefined : [SHORT] });
    await later();
    const question = await newestReading(proj, SECOND_SESSION, await asks(proj, SECOND_SESSION, WHOLE, { harness, argv }), harness);
    await picks(proj, SECOND_SESSION, question, harness);
    const newer = recorded(proj);
    expect(newer).toEqual(alone);
    expect(newer.description).toContain(`"Hello,  <name>!"`);
    expect(newer.description).toContain("O'Brien & Smith");
    expect(JSON.stringify(newer)).not.toContain("\\r");
  });
});

describe("t-newest-request-wins: what stays as it was", () => {
  test("one chat, one request: the plan question as ever, with no line", async () => {
    const proj = fresh();
    const question = await asks(proj, SESSION, FULLER);
    expect(question.kind).toBe("ask");
    expect(newerLines(question)).toEqual([]);
    expect(questions(proj).some((q) => q.replacedBy !== undefined)).toBe(false);
  });

  test("a request after work has started keeps today's path: nothing is replaced and no line is said", async () => {
    const proj = fresh();
    await picks(proj, SESSION, await asks(proj, SESSION, SHORT));
    await later();
    const step = await asks(proj, SECOND_SESSION, FULLER);
    expect(JSON.stringify(step)).not.toContain(WAITS);
    expect(JSON.stringify(step)).not.toContain(NEWER);
    expect(questions(proj).some((q) => q.replacedBy !== undefined)).toBe(false);
  });

  test("the replaced request answered in its own chat still starts it: the person's pick, never refused", async () => {
    const proj = fresh();
    const first = await asks(proj, SESSION, SHORT);
    await later();
    await newestReading(proj, SECOND_SESSION, await asks(proj, SECOND_SESSION, FULLER));
    await picks(proj, SESSION, first);
    expect(recorded(proj).description).toBe(SHORT);
  });

  test("/aidlc words that answer the waiting question still answer it", async () => {
    const proj = fresh();
    const first = await asks(proj, SESSION, SHORT);
    await later();
    const waiting = await asks(proj, SECOND_SESSION, "go ahead with express");
    expect(String(waiting.message)).toContain(WAITS);
    // The agent reads an answer and runs the question's own command.
    creates(proj, SECOND_SESSION, await next(proj, "claude", SECOND_SESSION, argsOf(first.confirm_command)));
    expect(recorded(proj).description).toBe(SHORT);
    expect(questions(proj).some((q) => q.replacedBy !== undefined)).toBe(false);
  });
});
