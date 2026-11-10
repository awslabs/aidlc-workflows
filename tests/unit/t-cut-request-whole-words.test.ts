// covers: function:takePersonsOwnLine, function:wholeMessageText, function:readRequestFile, function:fittingQuote
//
// A message longer than the record keeps reaches the work whole (#3741). The human-turn hook keeps a message's first
// MESSAGE_TEXT_MAX_CHARS characters and marks the record cut; on Kiro the agent then runs a bare `next` (the
// first-step note says the message is on record), and the engine took the request from the cut record: a
// 29,902-character spec became a 7,989-character request, and nothing said so. Every tool measured hands the hook the
// whole message (30,000 to 100,000 characters), so the store keeps a typed prompt's whole text beside a record it cut
// (messages/<id>.txt, up to REQUEST_MAX_BYTES) and a bare `next` takes the person's line from it: nothing on screen,
// no step for the agent. Only with no whole copy does the agent get one step (send the words through the request file),
// and only when neither has the words does the person read one line. Driven over each host's real human-turn hook (the
// kiro-ide tree is the one Kiro CLI v3 and Kiro IDE install) and the real engine. No long text is an argument past
// what a Windows command line holds (32,767 characters): it reaches the hook as a stdin file and `next` as a file.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";
import { DISPATCHER, type Directive, env, exec, type Harness, next, projectAt, say, SESSION } from "../harness/aidlc-input-corpus.ts";
import {
  forgetMessage,
  MESSAGE_TEXT_MAX_CHARS,
  pruneExpiredMessages,
  REQUEST_MAX_BYTES,
  saveMessage,
  wholeMessageText,
} from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { CUT_MESSAGE_PERSON_LINE, requestPreview } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";

setDefaultTimeout(240_000);

const REQUEST_FILE = "aidlc/.aidlc-request-text/request.txt";
const LAST = "Late decisions: these override anything above, and the ledger ships with no sync.";
const STEP_REFUSED = "could not send its next step";

// About `size` characters of a spec in numbered sections with line breaks, ending with LAST; nothing in it reads as a
// flag or a plan's name.
function spec(size: number): string {
  const parts: string[] = ["Tally: a command-line task ledger for small teams."];
  for (let i = 1; parts.join("\n").length < size - LAST.length - 120; i++) {
    parts.push(`Section ${i}. The ledger keeps every task a team adds, with its owner, its due day and its notes, and a teammate can read the list at any time.`);
  }
  parts.push(LAST);
  return parts.join("\n");
}
// The same in Japanese: three bytes a character.
function japaneseSpec(size: number): string {
  const parts: string[] = ["タリー: 小さなチームのためのタスク台帳。"];
  for (let i = 1; parts.join("\n").length < size - 40; i++) {
    parts.push(`第${i}節。台帳はチームが加えたすべてのタスクを、担当者と期日とメモと一緒に記録し、誰でもいつでも一覧を読める。`);
  }
  parts.push("最後の決定: これまでのすべてに優先する。");
  return parts.join("\n");
}

const sha = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");
// The words alone, whatever spacing runs between them: the tests that use it check every word arrives; "a taken line
// keeps the person's line breaks" checks the spacing.
const spaced = (text: string): string => text.replace(/\s+/g, " ").trim();
const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});
async function project(state: Parameters<typeof projectAt>[0]): Promise<string> {
  const proj = await projectAt(state);
  projects.push(proj);
  return proj;
}

interface Question { id: string; origin: string; text: string; createdAt: string }
function questions(proj: string): Question[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as Question)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
const newest = (proj: string): Question | undefined => questions(proj).at(-1);
const messagesDir = (proj: string): string => join(proj, "aidlc", ".aidlc-sessions", "messages");
const copies = (proj: string): string[] =>
  existsSync(messagesDir(proj)) ? readdirSync(messagesDir(proj)).filter((name) => name.endsWith(".txt")) : [];
// A record with no whole copy beside it, as one kept before copies were: the fallback's ground.
function dropCopies(proj: string): void {
  for (const name of copies(proj)) rmSync(join(messagesDir(proj), name));
}

// Every backticked `next` a step names, as the arguments after `next`.
function namedNexts(directive: Directive | null): string[][] {
  const message = String(directive?.message ?? "");
  return [...message.matchAll(/`[^`]*aidlc-orchestrate\.ts next([^`]*)`/g)]
    .map((match) => match[1].trim().split(/\s+/).filter(Boolean));
}
const namesRequestFile = (directive: Directive | null): boolean =>
  namedNexts(directive).some((args) => args.includes(REQUEST_FILE));
function wholeWordsStep(directive: Directive | null): string[] {
  expect(directive?.kind, JSON.stringify(directive)).toBe("print");
  expect(directive?.narration, "the step is the agent's: nothing for the person").toBeUndefined();
  const withFile = namedNexts(directive).find((args) => args.includes(REQUEST_FILE));
  expect(withFile, String(directive?.message)).toBeDefined();
  return withFile as string[];
}
function writeRequest(proj: string, text: string): void {
  mkdirSync(join(proj, "aidlc", ".aidlc-request-text"), { recursive: true });
  writeFileSync(join(proj, ...REQUEST_FILE.split("/")), text, "utf-8");
}
const lineCount = (...steps: Array<Directive | null>): number =>
  steps.map((step) => JSON.stringify(step ?? {}).split(CUT_MESSAGE_PERSON_LINE).length - 1).reduce((a, b) => a + b, 0);
// The plan proposal step's own command, then the question it returns.
async function proposed(proj: string, proposal: Directive | null): Promise<Directive | null> {
  const id = /--request ([0-9a-f]{8})/.exec(String(proposal?.message))?.[1];
  expect(id, String(proposal?.message)).toBeDefined();
  return (await next(proj, ["--propose", "feature", "--request", id as string])).directive;
}

describe("a message longer than the record keeps reaches the work whole, with nothing said (#3741)", () => {
  for (const harness of ["kiro-ide", "claude", "codex"] as Harness[]) {
    test(`${harness}: after a 30,000-character paste a bare next takes the whole request`, async () => {
      const proj = await project("fresh");
      const words = spec(30_000);
      await say(proj, `${harness === "codex" ? "$aidlc" : "/aidlc"} ${words}`, harness);
      expect(copies(proj), "the whole text is kept beside its record").toHaveLength(1);
      const first = await next(proj, []);
      expect(first.directive?.kind).toBe("print");
      expect(String(first.directive?.message)).toContain("propose");
      expect(namesRequestFile(first.directive), "no step for the agent").toBe(false);
      expect(sha(spaced((newest(proj) as Question).text)), "every word of the paste").toBe(sha(spaced(words)));
      expect(lineCount(first.directive, await proposed(proj, first.directive)), "nothing for the person").toBe(0);
    });
  }

  for (const size of [60_000, 100_000]) {
    test(`a ${size.toLocaleString("en-US")}-character paste is taken whole too`, async () => {
      const proj = await project("fresh");
      const words = spec(size);
      await say(proj, `/aidlc ${words}`, "kiro-ide");
      const first = await next(proj, []);
      expect(String(first.directive?.message)).toContain("propose");
      expect(sha(spaced((newest(proj) as Question).text))).toBe(sha(spaced(words)));
    });
  }

  test("a 30,000-character paste in Japanese (about 90,000 bytes) is taken whole", async () => {
    const proj = await project("fresh");
    const words = japaneseSpec(30_000);
    expect(Buffer.byteLength(words, "utf-8")).toBeGreaterThan(64 * 1024);
    await say(proj, `/aidlc ${words}`, "kiro-ide");
    await next(proj, []);
    expect(sha(spaced((newest(proj) as Question).text))).toBe(sha(spaced(words)));
  });

  test("a long plain reply while a stage question is open reaches the stage whole", async () => {
    const proj = await project("stage-question-asked");
    const words = spec(30_000);
    await say(proj, words, "kiro-ide");
    const step = await next(proj, []);
    expect(namesRequestFile(step.directive)).toBe(false);
    expect(sha((newest(proj) as Question).text), "the reply kept as typed, trimmed").toBe(sha(words.trim()));
  });

  test("with work open, `next` and `next --resume` keep the whole words, and the routing question fits its step", async () => {
    for (const args of [[], ["--resume"]]) {
      const proj = await project("work-open");
      const words = spec(30_000);
      await say(proj, `/aidlc ${words}`, "kiro-ide");
      const first = await next(proj, args);
      expect(first.out, args.join(" ")).not.toContain(STEP_REFUSED);
      expect(sha(spaced((newest(proj) as Question).text)), args.join(" ")).toBe(sha(spaced(words)));
      const id = /--request ([0-9a-f]{8})/.exec(String(first.directive?.message))?.[1];
      expect(id, String(first.directive?.message)).toBeDefined();
      const asked = await next(proj, ["--request", id as string]);
      expect(asked.out, "the routing question is sent").not.toContain(STEP_REFUSED);
    }
  });

  test("the agent's own --scope gives way to the person's whole line", async () => {
    const proj = await project("fresh");
    const words = spec(30_000);
    await say(proj, `/aidlc ${words}`, "kiro-ide");
    await next(proj, ["--scope", "bugfix"]);
    expect(sha(spaced((newest(proj) as Question).text))).toBe(sha(spaced(words)));
  });

  test("tailoring a plan for a whole 30,000-character request fits its step", async () => {
    const proj = await project("fresh");
    await say(proj, `/aidlc compose ${spec(30_000)}`, "kiro-ide");
    const step = await next(proj, []);
    expect(step.out).not.toContain(STEP_REFUSED);
    expect(namesRequestFile(step.directive), "no step for the agent").toBe(false);
  });

  for (const [label, words] of [
    ["70,000 characters", spec(70_000)],
    ["25,000 characters in Japanese", japaneseSpec(25_000)],
  ] as Array<[string, string]>) {
    test(`a plan word before ${label}: the reading step fits, and its files carry every word`, async () => {
      const proj = await project("fresh");
      await say(proj, `/aidlc bugfix ${words}`, "kiro-ide");
      const step = await next(proj, []);
      expect(step.out).not.toContain(STEP_REFUSED);
      const afterPlan = namedNexts(step.directive).find((args) => args.includes("--request-file") && args.includes("--scope"));
      expect(afterPlan, String(step.directive?.message)).toBeDefined();
      const file = (afterPlan as string[])[(afterPlan as string[]).indexOf("--request-file") + 1];
      expect(spaced(readFileSync(join(proj, ...file.split("/")), "utf-8"))).toBe(spaced(words));
      // The command it names runs: the file is within the one request size.
      const ran = await next(proj, afterPlan as string[]);
      expect(ran.out).not.toContain("could not read the request");
      expect(ran.directive?.kind).not.toBe("error");
    });
  }

  test("an agent that passes a plan word and 20,000 characters itself gets a reading step that fits", async () => {
    const proj = await project("fresh");
    const words = spec(20_000);
    await say(proj, `/aidlc bugfix ${words}`, "claude");
    const step = await next(proj, ["bugfix", words]);
    expect(step.out).not.toContain(STEP_REFUSED);
    expect(step.directive?.kind).toBe("print");
  });

  test("a request file between 64 KiB and REQUEST_MAX_BYTES is read whole", async () => {
    const proj = await project("fresh");
    const words = japaneseSpec(30_000);
    // Their own message is the same words (an agent's words never replace a short line of theirs).
    await say(proj, `/aidlc ${words}`, "kiro-ide");
    expect(Buffer.byteLength(words, "utf-8")).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(words, "utf-8")).toBeLessThan(REQUEST_MAX_BYTES);
    writeRequest(proj, words);
    const sent = await next(proj, ["--request-file", REQUEST_FILE]);
    expect(sent.out).not.toContain("could not read the request");
    expect(sha((newest(proj) as Question).text)).toBe(sha(words));
  });

  test("a paste the record keeps whole is taken by a bare next as before", async () => {
    const proj = await project("fresh");
    const words = spec(7_000);
    await say(proj, `/aidlc ${words}`, "kiro-ide");
    expect(copies(proj), "no copy for a record that is whole").toEqual([]);
    const first = await next(proj, []);
    expect(String(first.directive?.message)).toContain("propose");
    expect(sha(spaced((newest(proj) as Question).text))).toBe(sha(spaced(words)));
  });
});

describe("the whole copy is kept and removed with its record", () => {
  const message = {
    session: SESSION, at: new Date().toISOString(), source: "prompt" as const, picker: null, settings: [],
    route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
  };
  function store(): string {
    const proj = createTestProject();
    projects.push(proj);
    return proj;
  }
  const cut = (proj: string, whole: string, at = message.at) =>
    saveMessage(proj, { ...message, at, text: whole.slice(0, MESSAGE_TEXT_MAX_CHARS), words: whole.slice(0, MESSAGE_TEXT_MAX_CHARS), cut: true }, whole);

  test("kept up to REQUEST_MAX_BYTES, not one byte over, and never for a whole record", () => {
    const proj = store();
    const atCap = "a".repeat(REQUEST_MAX_BYTES);
    const kept = cut(proj, atCap);
    expect(String(wholeMessageText(proj, kept))).toBe(atCap);
    const over = cut(proj, "a".repeat(REQUEST_MAX_BYTES + 1));
    expect(wholeMessageText(proj, over)).toBeNull();
    const whole = saveMessage(proj, { ...message, text: "short", words: "short" }, "short");
    expect(wholeMessageText(proj, whole)).toBeNull();
    expect(copies(proj)).toEqual([`${kept.id}.txt`]);
  });

  test("forgetting a message removes its copy; age removes it with the record", () => {
    const proj = store();
    const forgotten = cut(proj, spec(20_000));
    forgetMessage(proj, forgotten.id);
    expect(copies(proj)).toEqual([]);
    // A record past its day goes with the store's next write (saveMessage prunes after it writes), copy first.
    const kept = cut(proj, spec(20_000));
    const old = cut(proj, spec(20_000), new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
    expect(copies(proj)).toEqual([`${kept.id}.txt`]);
    expect(existsSync(join(messagesDir(proj), `${old.id}.json`))).toBe(false);
    pruneExpiredMessages(proj);
    expect(copies(proj)).toEqual([`${kept.id}.txt`]);
  });
});

describe("with no whole copy, the agent's one step, and the person's line only when neither has the words", () => {
  test("a bare next asks the agent for the whole words through the request file, and they are used", async () => {
    const proj = await project("fresh");
    const words = spec(30_000);
    await say(proj, `/aidlc ${words}`, "kiro-ide");
    dropCopies(proj);
    const step = (await next(proj, [])).directive;
    const command = wholeWordsStep(step);
    expect(command).toEqual(["--request-file", REQUEST_FILE]);
    expect(String(step?.message)).toContain("the plan, command word and flags they typed stay on the command as shown.");
    expect(questions(proj), "nothing kept from the cut copy").toEqual([]);
    writeRequest(proj, words);
    const sent = await next(proj, command);
    expect(sha((newest(proj) as Question).text)).toBe(sha(words));
    expect(lineCount(sent.directive, await proposed(proj, sent.directive))).toBe(0);
  });

  test("an agent that comes back with no words goes ahead from the kept part, and the person is told once", async () => {
    const proj = await project("fresh");
    await say(proj, `/aidlc ${spec(30_000)}`, "kiro-ide");
    dropCopies(proj);
    wholeWordsStep((await next(proj, [])).directive);
    const again = await next(proj, []);
    expect(namesRequestFile(again.directive), "the step does not come back").toBe(false);
    expect((newest(proj) as Question).text).not.toContain(LAST);
    const question = await proposed(proj, again.directive);
    expect(question?.kind).toBe("ask");
    expect(lineCount(again.directive, question), "said once, with the plan question").toBe(1);
    // With the plan question open a further bare `next` takes nothing from the line, so the line is not said again.
    const third = await next(proj, []);
    expect(namesRequestFile(third.directive)).toBe(false);
    expect(lineCount(third.directive)).toBe(0);
  });

  test("a paste over REQUEST_MAX_BYTES: no copy, and a request file that large goes ahead from the kept part, said once", async () => {
    const proj = await project("fresh");
    const words = spec(140_000);
    expect(Buffer.byteLength(words, "utf-8")).toBeGreaterThan(REQUEST_MAX_BYTES);
    await say(proj, `/aidlc ${words}`, "kiro-ide");
    expect(copies(proj)).toEqual([]);
    const command = wholeWordsStep((await next(proj, [])).directive);
    writeRequest(proj, words);
    const sent = await next(proj, command);
    expect(sent.directive?.kind, sent.out).not.toBe("error");
    expect(sent.out).not.toContain("Send your request again");
    expect(existsSync(join(proj, ...REQUEST_FILE.split("/"))), "the file is spent").toBe(false);
    expect(lineCount(sent.directive, await proposed(proj, sent.directive))).toBe(1);
  });

  test("an over-cap request file with no step waiting keeps its refusal, word for word", async () => {
    const proj = await project("fresh");
    await say(proj, "/aidlc build a ledger", "kiro-ide");
    writeRequest(proj, spec(140_000));
    const sent = await next(proj, ["--request-file", REQUEST_FILE]);
    expect(sent.directive?.kind).toBe("error");
    expect(String(sent.directive?.message)).toContain(`AI-DLC could not read the request in ${REQUEST_FILE}. Send your request again.`);
  });

  test("a mark that cannot be kept never brings the step back: next goes ahead at once", async () => {
    const proj = await project("fresh");
    const segment = SESSION.replace(/[^A-Za-z0-9._-]+/g, "-");
    mkdirSync(join(proj, "aidlc", ".aidlc-sessions", "plan-approval", `line-handed-out-${segment}.json`), { recursive: true });
    await say(proj, `/aidlc ${spec(30_000)}`, "kiro-ide");
    dropCopies(proj);
    const first = await next(proj, []);
    expect(namesRequestFile(first.directive), first.out).toBe(false);
    expect(lineCount(first.directive, await proposed(proj, first.directive))).toBe(1);
  });

  test("the step's command carries the plan, verb and settings the person typed", async () => {
    for (const [typed, expected] of [
      ["compose ", [["compose", "--request-file", REQUEST_FILE]]],
      ["bugfix: ", [["bugfix", "--request-file", REQUEST_FILE]]],
      ["--depth minimal ", [["--depth", "minimal", "--request-file", REQUEST_FILE]]],
      ["bugfix ", [["--scope", "bugfix", "--request-file", REQUEST_FILE], ["--request-file", REQUEST_FILE]]],
    ] as Array<[string, string[][]]>) {
      const proj = await project("fresh");
      await say(proj, `/aidlc ${typed}${spec(30_000)}`, "kiro-ide");
      dropCopies(proj);
      const step = (await next(proj, [])).directive;
      wholeWordsStep(step);
      expect(namedNexts(step).filter((args) => args.includes("--request-file")), `${typed}: ${String(step?.message)}`).toEqual(expected);
    }
  });

  test("a long plain reply with no copy gets the same step", async () => {
    const proj = await project("stage-question-asked");
    await say(proj, spec(30_000), "kiro-ide");
    dropCopies(proj);
    const step = (await next(proj, [])).directive;
    expect(wholeWordsStep(step)).toEqual(["--request-file", REQUEST_FILE]);
    expect(String(step?.message)).toContain("whole reply");
  });
});

// A line taken from the person's message keeps their line breaks (the one reading, requestAsTyped, and its fallback
// withTypedSpacing): the stored request and project-description.json hold the spec as pasted, the plan question's
// preview reads its line breaks as spaces, and the state's Project line and the audit row stay one line.
describe("a taken line keeps the person's line breaks", () => {
  const END = "END-OF-SPEC: these late decisions override anything above.";
  // A markdown spec with a code block (indented lines, double quotes) and `paragraphs` long paragraphs:
  // markdownSpec(3) is 1,510 characters, markdownSpec(30) is 10,387.
  function markdownSpec(paragraphs: number): string {
    const para = (n: number) =>
      `Paragraph ${n}. The ledger keeps every task a team adds, with its owner, its due day and its notes, and anyone ` +
      "on the team can read the whole list at any time from any machine; a task that is done stays in the list, marked " +
      "done, so the team can look back at what it finished and when, and the list never loses a task it was given.";
    return [
      "# Tally: a command-line task ledger for small teams", "", "## Why", para(1), para(2), para(3), "",
      "## What it keeps", "- a title for every task, never blank", "- an owner, who can be changed later",
      "- a due day, which can be left empty", "- notes, as long as the team likes", "", "## How it adds a task",
      "```ts", "export function add(tasks: string[], title: string): string[] {", "    if (title.trim() === \"\") {",
      "        throw new Error(\"a task needs a title\");", "    }", "    return [...tasks, title];", "}", "```", "",
      "## More", ...Array.from({ length: Math.max(0, paragraphs - 3) }, (_, i) => para(i + 4)), "", "## Late decisions", END,
    ].join("\n");
  }
  const CODE_LINE = "        throw new Error(\"a task needs a title\");";

  // Through the plan question to the work, as a person picks the plan offered; returns the work's record folder.
  async function created(proj: string, proposal: Directive | null): Promise<{ record: string; question: Directive | null }> {
    const question = await proposed(proj, proposal);
    await say(proj, "go ahead with that plan", "kiro-ide");
    const confirm = String((question as Record<string, unknown>)?.confirm_command ?? "").replace(/^.*aidlc-orchestrate\.ts next /, "").split(" ");
    const made = await next(proj, confirm);
    const create = /`bun [^`]*aidlc\.ts engine intent create ([^`]*)`/.exec(String(made.directive?.message ?? ""));
    expect(create, String(made.directive?.message)).not.toBeNull();
    const args = (create as RegExpExecArray)[1].replace("'<2-3 word kebab essence>'", "tally-ledger").split(" ");
    const ran = await exec([process.execPath, DISPATCHER, "engine", "intent", "create", ...args, "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readdirSync(intents).find((name) => !name.startsWith(".") && name.includes("tally")) as string);
    return { record, question };
  }

  for (const [label, words] of [["1,510", markdownSpec(3)], ["10,387", markdownSpec(30)]] as Array<[string, string]>) {
    test(`a ${label}-character markdown spec is stored, and the work made, as pasted`, async () => {
      expect(words.length.toLocaleString("en-US")).toBe(label);
      const proj = await project("fresh");
      await say(proj, `/aidlc ${words}`, "kiro-ide");
      const first = await next(proj, []);
      expect((newest(proj) as Question).text, "the stored request").toBe(words);
      expect((newest(proj) as Question).text).toContain(CODE_LINE);
      const { record, question } = await created(proj, first.directive);
      // The plan question's preview: the start of the request, its line breaks read as spaces.
      const asked = String((question as Record<string, unknown>)?.question ?? "");
      expect(asked).toContain("# Tally: a command-line task ledger for small teams ## Why Paragraph 1.");
      const description = JSON.parse(readFileSync(join(record, "project-description.json"), "utf-8")) as unknown;
      expect(JSON.stringify(description)).toContain(JSON.stringify(words).slice(1, -1));
      const projectLine = /^- \*\*Project\*\*: (.*)$/m.exec(readFileSync(join(record, "aidlc-state.md"), "utf-8"));
      expect(projectLine?.[1] ?? "", "the state's Project line stays one line").toContain(END);
      const audit = readdirSync(join(record, "audit")).map((name) => readFileSync(join(record, "audit", name), "utf-8")).join("\n");
      const request = /^\*\*Request\*\*: (.*)$/m.exec(audit.slice(audit.indexOf("WORKFLOW_STARTED")));
      expect(request?.[1] ?? "", "the audit row's Request is one line").toStartWith("/aidlc # Tally");
      expect(request?.[1] ?? "", "the audit row's Request is one line").toContain(END);
    });
  }

  test("the record's words keep the line breaks", async () => {
    const proj = await project("fresh");
    // The record reads an `/aidlc` line's words as arguments, so a quote typed in it is a quote to that reading;
    // the lines with none (the indented ones of the code block among them) are the spec's lines as typed.
    const words = markdownSpec(3).split("\n").filter((line) => !line.includes("\"")).join("\n");
    await say(proj, `/aidlc ${words}`, "kiro-ide");
    const record = readdirSync(messagesDir(proj)).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(messagesDir(proj), name), "utf-8")) as { words: string | null })[0];
    expect(record.words).toBe(words);
  });

  test("the preview reads a long run of spaces in one pass", () => {
    // A pasted table or terminal output can carry a long run of spaces; the plan question quotes the request at once.
    const request = `## Tally\nbuild a ledger${" ".repeat(100_000)}for small teams`;
    const started = performance.now();
    const preview = requestPreview(request);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(preview).toBe(`## Tally build a ledger${" ".repeat(217)}...`);
  });

  test("a flag typed on a later line is still read as the flag", async () => {
    const proj = await project("fresh");
    await say(proj, "/aidlc build a task ledger\nfor small teams\n--depth minimal", "kiro-ide");
    const record = readdirSync(messagesDir(proj)).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(messagesDir(proj), name), "utf-8")) as { settings: Array<{ key: string; value: string }>; words: string })[0];
    expect(record.settings).toEqual([{ key: "depth", value: "minimal" }]);
    await next(proj, []);
    expect((newest(proj) as Question).text).toBe("build a task ledger\nfor small teams");
  });

  test("a plan word before a multi-line spec: the reading step's files hold its lines", async () => {
    const proj = await project("fresh");
    const words = markdownSpec(3);
    await say(proj, `/aidlc bugfix ${words}`, "kiro-ide");
    const step = await next(proj, []);
    const afterPlan = namedNexts(step.directive).find((args) => args.includes("--request-file") && args.includes("--scope"));
    expect(afterPlan, String(step.directive?.message)).toBeDefined();
    const file = (afterPlan as string[])[(afterPlan as string[]).indexOf("--request-file") + 1];
    expect(readFileSync(join(proj, ...file.split("/")), "utf-8")).toBe(words);
  });
});
