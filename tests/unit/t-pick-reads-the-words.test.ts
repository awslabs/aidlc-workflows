// covers: subcommand:aidlc-orchestrate:next, function:saveReadingQuestion
//
// t-pick-reads-the-words: in a chat where no work is selected (a teammate's
// clone, where the selection is git-ignored), the words the person typed reach
// the piece of work the agent then picks for them. Measured on Claude Code
// (5 of 5, SDK drive): `/aidlc redo reverse engineering, ...` in a clone got
// the reading step for unselected work, the agent picked the one piece
// (`next --pick`, directly or through the pick question), the engine named a
// bare `next` after the switch, and Requirements Analysis carried on: the redo
// never happened and nobody was asked. Now, whenever the reading step kept
// this chat's latest message for the piece picked, the pick step writes those
// words, exactly as kept, to a file of its own in the request folder and names
// `next --request-file <that file>` after the switch, so the words get the
// reading they get with that work selected (go on, redo, jump, start fresh, an
// answer to what is open) with no shell on the way: a line break, a quote or a
// character cmd.exe reads comes through as typed. Nothing else changes:
// another chat's words, a later message, parked work and a pick with no words
// before it keep the step they had.
//
// Spawns the real engine and Claude Code's own human-turn hook, as
// tests/unit/t-next-takes-the-persons-line does.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject, createOrchestrationTestProject, intentsDirOf } from "../harness/fixtures.ts";
import {
  buildState, DISPATCHER, type Directive, env, exec, next, type RunOptions, SECOND_SESSION, say,
} from "../harness/aidlc-input-corpus.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const WORDS = "redo reverse engineering, the scan missed the src/legacy folder";
const PIECE = "fixture-8000000000000001";
const READING = "the person's words may ask to redo";
// The step after the switch, as the pick step names it.
const THEN = /then run `[^`]* next( --resume| --request-file \S+| -- [^`]+)?` and follow what it returns/;
const REQUEST_FILE = /^--request-file (aidlc\/\.aidlc-request-text\/[^/\s]+)$/;

/** A teammate's clone of a bug fix at Requirements Analysis: the record is there, the git-ignored selection is not. */
async function clone(state: "work-open" | "parked" | "gate-open" = "work-open"): Promise<string> {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  await buildState(proj, state);
  rmSync(join(intentsDirOf(proj, "default"), "active-intent"), { force: true });
  return proj;
}

/** The person's `/aidlc <words>`, then the agent's first step: the reading for work none is selected for. */
async function typed(proj: string, words: string, opts: RunOptions = {}): Promise<Directive> {
  const said = await say(proj, `/aidlc ${words}`, "claude", opts);
  expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
  const { directive, out } = await next(proj, [words], opts);
  expect(directive?.kind, out).toBe("print");
  expect(String(directive?.message), out).toContain("none is selected in this chat");
  return directive!;
}

/** The step after the switch the pick step names: "" for a bare `next`. */
function stepAfterSwitch(d: Directive | null): string {
  const message = String(d?.message ?? "");
  expect(message).toContain(`intent switch ${PIECE}`);
  const then = THEN.exec(message);
  expect(then, message).not.toBeNull();
  return then?.[1]?.trim() ?? "";
}

/** The file the step after the switch reads the words from, and what it holds. */
function carried(proj: string, step: string): { file: string; words: string } {
  const file = REQUEST_FILE.exec(step)?.[1];
  expect(file, step).toBeDefined();
  return { file: file!, words: readFileSync(join(proj, file!), "utf-8") };
}

function questionTexts(proj: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".json"))
      .map((name) => (JSON.parse(readFileSync(join(dir, name), "utf-8")) as { text: string }).text)
    : [];
}

async function switchTo(proj: string, opts: RunOptions = {}): Promise<void> {
  const r = await exec([process.execPath, DISPATCHER, "engine", "intent", "switch", PIECE, "--project-dir", proj], {
    cwd: proj, env: env(proj, opts),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

// A message keeps whole seconds; a reply comes in a later one, as a person's does.
const laterSecond = (): Promise<void> => Bun.sleep(1100);

/** The record's audit rows, every shard. */
const auditRows = (proj: string): number => readAuditShardEvents(proj).length;

describe("the words that led to a pick are read against the piece picked", () => {
  test("the reading step's own pick: after the switch, their words get the reading the selected work gives", async () => {
    const proj = await clone();
    await typed(proj, WORDS);
    const picked = await next(proj, ["--pick", PIECE]);
    const { file, words } = carried(proj, stepAfterSwitch(picked.directive));
    expect(words).toBe(WORDS);
    await switchTo(proj);
    const rows = auditRows(proj);
    const read = await next(proj, ["--request-file", file]);
    expect(read.directive?.kind, read.out).toBe("print");
    expect(String(read.directive?.message), read.out).toContain(READING);
    expect(String(read.directive?.message), read.out).toContain('Work is in progress on "Todo app bug fix"');
    // Reading the words again records nothing of theirs a second time.
    expect(auditRows(proj)).toBe(rows);
    // The file is spent once read.
    expect(existsSync(join(proj, file))).toBe(false);
    // Their line is not taken a third time: the bare `next` after the reading is the work's own step.
    const goOn = await next(proj, []);
    expect(goOn.directive?.kind, goOn.out).toBe("run-stage");
  });

  test("through the pick question the agent answered in the same turn: the same words come back", async () => {
    const proj = await clone();
    await typed(proj, WORDS);
    const ask = await next(proj, []);
    expect(ask.directive?.ask_type, ask.out).toBe("intent-pick");
    const command = (ask.directive?.select_commands as Array<{ selector: string; command: string }>)[0];
    expect(command.selector).toBe(PIECE);
    const picked = await next(proj, command.command.replace(/^.* next /, "").split(" "));
    expect(carried(proj, stepAfterSwitch(picked.directive)).words, picked.out).toBe(WORDS);
  });

  // Measured on Claude Code 2.1.310: the agent put their words after the name, and the refusal of that command
  // ended the turn with the redo undone. The engine's own copy is what rides on.
  test("the agent adds their words after the name: the same step, never a refusal", async () => {
    const proj = await clone();
    await typed(proj, WORDS);
    for (const tail of [[WORDS], ["--", WORDS], ["redo", "it"]]) {
      const picked = await next(proj, ["--pick", PIECE, ...tail]);
      expect(picked.directive?.kind, picked.out).toBe("print");
      expect(carried(proj, stepAfterSwitch(picked.directive)).words, picked.out).toBe(WORDS);
    }
    // A flag after the name is still the agent's slip, named to it.
    const flagged = await next(proj, ["--pick", PIECE, "--scope", "bugfix"]);
    expect(flagged.directive?.kind, flagged.out).toBe("error");
  });

  // Quotes, an apostrophe, the characters cmd.exe reads, and a line break: the words the reading kept are the words
  // the picked work reads, character for character.
  for (const [label, words] of [
    ["quotes and an apostrophe", `redo reverse engineering, the "legacy" scan missed Sam's folder`],
    ["cmd.exe's characters", "redo reverse engineering: src/legacy & src/old at 100% <both> | ^now"],
    ["a line break", "redo reverse engineering\nthe scan missed the src/legacy folder"],
  ] as const) {
    test(`words with ${label} reach the picked work as typed`, async () => {
      const proj = await clone();
      await typed(proj, words);
      const picked = await next(proj, ["--pick", PIECE]);
      const kept = carried(proj, stepAfterSwitch(picked.directive));
      expect(kept.words).toBe(words);
      await switchTo(proj);
      const read = await next(proj, ["--request-file", kept.file]);
      expect(String(read.directive?.message), read.out).toContain(READING);
      expect(questionTexts(proj).filter((text) => text === words).length).toBe(2);
    });
  }

  test("parked work picked that way still picks up through --resume", async () => {
    // Parked in another chat; this one never joined it.
    const proj = await clone("parked");
    const here: RunOptions = { session: SECOND_SESSION };
    await typed(proj, WORDS, here);
    const picked = await next(proj, ["--pick", PIECE], here);
    expect(stepAfterSwitch(picked.directive), picked.out).toBe("--resume");
  });
});

// A fresh clone at a stage gate (shown in another chat), the person's `/aidlc approve`: the pick hands it to the
// gate's own reading; whether it counts as their approval stays the gate's rule.
describe("an approval typed before the pick gets the gate's reading", () => {
  const GATE = 'Stage "requirements-analysis" is waiting for the person\'s approval';
  test("the agent picks in the same turn: after the switch, the gate's reading of their word", async () => {
    const proj = await clone("gate-open");
    const here: RunOptions = { session: SECOND_SESSION };
    await typed(proj, "approve", here);
    const picked = await next(proj, ["--pick", PIECE], here);
    const kept = carried(proj, stepAfterSwitch(picked.directive));
    expect(kept.words).toBe("approve");
    await switchTo(proj, here);
    const read = await next(proj, ["--request-file", kept.file], here);
    expect(String(read.directive?.message), read.out).toContain(GATE);
  });

  test("the person picks in a new message: the gate is shown again, as it was", async () => {
    const proj = await clone("gate-open");
    const here: RunOptions = { session: SECOND_SESSION };
    await typed(proj, "approve", here);
    const ask = await next(proj, [], here);
    expect(ask.directive?.ask_type, ask.out).toBe("intent-pick");
    await laterSecond();
    await say(proj, "1", "claude", here);
    const picked = await next(proj, ["--pick", PIECE], here);
    expect(stepAfterSwitch(picked.directive), picked.out).toBe("");
  });
});

describe("a pick with no words of this message before it keeps the bare next", () => {
  test("the person answers the pick question in a new message: their earlier words are not this message's", async () => {
    const proj = await clone();
    await typed(proj, WORDS);
    const ask = await next(proj, []);
    expect(ask.directive?.ask_type, ask.out).toBe("intent-pick");
    await laterSecond();
    await say(proj, "1", "claude");
    const picked = await next(proj, ["--pick", PIECE]);
    expect(stepAfterSwitch(picked.directive), picked.out).toBe("");
  });

  test("words typed in another chat are not this chat's", async () => {
    const proj = await clone();
    await typed(proj, WORDS);
    const other: RunOptions = { session: SECOND_SESSION };
    await say(proj, "/aidlc", "claude", other);
    const picked = await next(proj, ["--pick", PIECE], other);
    expect(stepAfterSwitch(picked.directive), picked.out).toBe("");
  });

  test("the pick question for `/aidlc` alone", async () => {
    const proj = await clone();
    await say(proj, "/aidlc", "claude");
    const picked = await next(proj, ["--pick", PIECE]);
    expect(stepAfterSwitch(picked.directive), picked.out).toBe("");
  });

  test("the where-does-it-go question's own answer, after the person went ahead with a plan", async () => {
    const proj = await clone();
    const reading = await typed(proj, WORDS);
    const id = /next --request ([0-9a-f]{8})/.exec(String(reading.message))?.[1];
    expect(id).toBeDefined();
    const offer = await next(proj, ["--propose", "bugfix", "--request", id!]);
    expect(offer.directive?.ask_type, offer.out).toBe("scope-confirm");
    await laterSecond();
    await say(proj, "go ahead", "claude");
    const routing = await next(proj, String(offer.directive?.confirm_command).replace(/^.* next /, "").split(" "));
    expect(routing.directive?.ask_type, routing.out).toBe("new-work-routing");
    await laterSecond();
    await say(proj, "1", "claude");
    const part = (routing.directive?.choices as Array<{ label: string; command?: string }>)
      .find((choice) => choice.label === "Part of existing work");
    expect(part?.command, routing.out).toContain(`next --pick ${PIECE}`);
    const picked = await next(proj, ["--pick", PIECE]);
    expect(stepAfterSwitch(picked.directive), picked.out).toBe("");
  });
});
