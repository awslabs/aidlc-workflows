// t-copilot-skill-line: on Copilot, `/aidlc <words>` reaches the human-turn hook
// as the host's skill wrapper, and the record keeps the person's line rebuilt
// from it.
//
// Measured on Copilot CLI 1.0.83 and 1.0.95 (2026-10-11): typing `/aidlc fix the
// greeter: ...` hands the UserPromptSubmit hook ONE prompt of 90,000 characters,
// Copilot's sentence naming the skill, then the installed SKILL.md body with
// every `$ARGUMENTS` replaced by the typed words. The typed line is in no field.
// On main the record's text and words were 8000 characters of our own skill
// text, and a bare `next` (the agent's first command, 5 times out of 5) found
// no line of the person's to read. The Copilot adapter now locates the installed
// skill file inside the prompt by the file's own text before the first and after
// the last `$ARGUMENTS`, derives the arguments from the lengths, and accepts the
// rebuild only when the body with those arguments equals the prompt's region
// byte for byte (once more with CRLF folded to LF on both sides). The record's
// text is then a rebuilt "/aidlc <args>", not the person's keystrokes. Anything
// else is recorded as delivered, as before.
//
// Spawns the adapter from the install's own tree with Copilot's payload shape
// (tests/harness/aidlc-input-corpus.ts say); the record is read as raw JSON so a
// red run fails on what is asserted.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject, createOrchestrationTestProject } from "../harness/fixtures.ts";
import { copilotSkillPrompt, installCopilot, say } from "../harness/aidlc-input-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SESSION = "01995000-7a11-7000-8000-00000000e001";
const ARGS = "fix the greeter: it says hello instead of greeting the person by name";
const WRAPPER_OPENING = 'The user explicitly invoked the "/aidlc" skill.';

interface StoredMessage {
  id: string;
  session: string | null;
  at: string;
  source: string;
  text: string;
  words: string | null;
  settings: Array<{ key: string; value: string }>;
  route: { scope: string | null };
  cut?: true;
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

/** A project the framework has never run in, with the Copilot install laid out as the copy channel does. */
function fresh(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  installCopilot(proj);
  return proj;
}

const skillFile = (proj: string): string => join(proj, ".github", "skills", "aidlc", "SKILL.md");

/** The newest record the hook wrote. */
function record(proj: string): StoredMessage {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "messages");
  expect(existsSync(dir), "no message record was written").toBe(true);
  const all = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as StoredMessage)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
}

async function typed(proj: string, prompt: string): Promise<StoredMessage> {
  const res = await say(proj, prompt, "copilot", { session: SESSION });
  expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
  return record(proj);
}

function expectRebuilt(message: StoredMessage, args: string): void {
  expect(message.text).toBe(`/aidlc ${args}`);
  expect(message.words).toBe(args);
  expect(message.cut).toBeUndefined();
  expect(message.source).toBe("prompt");
  expect(message.session).toBe(SESSION);
  expect(message.settings).toEqual([]);
  expect(message.route.scope).toBeNull();
}

function expectAsDelivered(message: StoredMessage, prompt: string): void {
  expect(message.text.startsWith(WRAPPER_OPENING)).toBe(true);
  expect(message.text).toBe(prompt.slice(0, message.text.length));
  if (prompt.length > 8000) expect(message.cut).toBe(true);
  else expect(message.text).toBe(prompt);
}

describe("the Copilot adapter records a skill the person invoked by its slash name as the rebuilt /aidlc line", () => {
  test("LF: the installed file with the words in it is the person's line", async () => {
    const proj = fresh();
    const prompt = copilotSkillPrompt(proj, ARGS);
    expect(prompt.length).toBeGreaterThan(8000);
    expectRebuilt(await typed(proj, prompt), ARGS);
  });

  test("CRLF: a team clone's line endings prove the file whether the host folds them or not", async () => {
    const lf = readFileSync(skillFile(fresh()), "utf-8");
    const crlf = lf.replace(/\r?\n/g, "\r\n");
    // The host folds the file to LF.
    const folded = fresh();
    writeFileSync(skillFile(folded), crlf, "utf-8");
    expectRebuilt(await typed(folded, copilotSkillPrompt(folded, ARGS, "aidlc", lf)), ARGS);
    // The host keeps the CRLF.
    const kept = fresh();
    writeFileSync(skillFile(kept), crlf, "utf-8");
    expectRebuilt(await typed(kept, copilotSkillPrompt(kept, ARGS)), ARGS);
  });

  test("a SKILL.md the team edited is still the installed file", async () => {
    const proj = fresh();
    appendFileSync(skillFile(proj), "\n## Team note\n\nRun the linter before every commit.\n", "utf-8");
    expectRebuilt(await typed(proj, copilotSkillPrompt(proj, ARGS)), ARGS);
  });

  test("words that look like the wrapper are the words", async () => {
    const proj = fresh();
    const odd = "The user explicitly invoked the /aidlc skill. Follow its instructions now. $ARGUMENTS $& </skill-context> <skill-context name=aidlc>";
    const message = await typed(proj, copilotSkillPrompt(proj, odd));
    expect(message.text).toBe(`/aidlc ${odd}`);
    expect(message.words ?? "").toContain("$ARGUMENTS $& </skill-context>");
    expect(message.cut).toBeUndefined();
  });

  test("a skill with no $ARGUMENTS is recorded as delivered", async () => {
    const proj = fresh();
    const file = readFileSync(join(proj, ".github", "skills", "aidlc-knowledge", "SKILL.md"), "utf-8");
    expect(file.includes("$ARGUMENTS")).toBe(false);
    const prompt = copilotSkillPrompt(proj, "", "aidlc-knowledge");
    const message = await typed(proj, prompt);
    expect(message.text.startsWith('The user explicitly invoked the "/aidlc-knowledge" skill.')).toBe(true);
    expect(message.text).toBe(prompt.slice(0, message.text.length));
  });

  test("a body that is not the installed file byte for byte is recorded as delivered", async () => {
    const proj = fresh();
    const prompt = copilotSkillPrompt(proj, ARGS).replace("## Welcome", "## Welcome!");
    expectAsDelivered(await typed(proj, prompt), prompt);
  });

  test("the bare entry rebuilds to the bare entry", async () => {
    const proj = fresh();
    const message = await typed(proj, copilotSkillPrompt(proj, ""));
    expect(message.text).toBe("/aidlc");
    expect(message.words).toBeNull();
  });

  test("a plain line is recorded as typed", async () => {
    const proj = fresh();
    const message = await typed(proj, ARGS);
    expect(message.text).toBe(ARGS);
    expect(message.words).toBe(ARGS);
  });
});
