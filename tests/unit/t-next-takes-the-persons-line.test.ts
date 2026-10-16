// t-next-takes-the-persons-line: on a workspace with no work yet, `next` reads
// the person's own `/aidlc` line when the agent's command carries none of it.
//
// Measured on Kiro IDE 1.2.37 with a new chat left on Kiro's Default agent: the
// skill reaches that agent as a 1,731-character preview, so its first engine
// command was a bare `next` or a `next --scope bugfix` it picked itself. The
// engine answered that empty command (an error naming two ways to start, or a
// creation with no words), the plan was picked for the person and, on main,
// their words left the record (`**Project**: [Project description]`). The
// human-turn hook had already kept their line as it arrived (the message
// record), so `next` now reads that line exactly as if the agent had passed it:
// the plan question for words alone, creation for a plan they named, the reply
// reading while a plan question is open. Nothing reads meaning: the entry word,
// the words and the flags are the engine's own parse of the person's text.
//
// With work open, the same line is read by the agent's first step after it
// when that step carries none of it: measured on Claude Code (t176, 2 of 20 on
// main b9c3e9000f), the agent's first command after `/aidlc "<new work>"` was
// `next --resume`, and the open work's stage came back with their request gone.
//
// Spawns the real engine and each host's own human-turn hook (the Kiro IDE
// adapter, the Kiro CLI and Codex adapters and the Claude Code dispatcher), as
// tests/unit/t-message-record does.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  proposalFollowUp,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  buildState,
  copilotSkillPrompt,
  type Directive,
  env,
  exec,
  type Harness,
  ORCHESTRATE,
  type RunOptions,
  say,
  SECOND_SESSION,
} from "../harness/aidlc-input-corpus.ts";
import { saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { sessionPidMapDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { parseNextFlags } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";

type Record = Parameters<typeof saveMessage>[1];
/** The record the hook would have written for `/aidlc <words>` in `session`, with no hook run. */
function recordOf(session: string): Record {
  return {
    session, at: new Date().toISOString(), source: "prompt", text: LINE, picker: null, words: WORDS,
    settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
  };
}

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const LINE = "/aidlc fix the greeter: it prints hello instead of greeting the person by name";
const WORDS = "fix the greeter: it prints hello instead of greeting the person by name";
const NO_STATE = "No workflow state found";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

/** A project the framework has never run in: no state file anywhere. */
function fresh(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  return proj;
}

/** `next` as the agent runs it, with the host's own engine tree. */
async function next(
  proj: string,
  harness: Harness,
  args: string[],
  opts: RunOptions & { noSession?: true } = {},
): Promise<{ directive: Directive; out: string }> {
  const tool = harness === "claude"
    ? ORCHESTRATE
    : join(proj, harness === "copilot" ? ".aidlc" : harness === "codex" ? ".codex" : ".kiro", "tools", "aidlc-orchestrate.ts");
  const runEnv = env(proj, opts);
  if (opts.noSession) delete runEnv.AIDLC_SESSION_OVERRIDE;
  const res = await exec([process.execPath, tool, "next", "--project-dir", proj, ...args], { cwd: proj, env: runEnv });
  const out = `${res.stdout}${res.stderr}`;
  let directive: Directive = {};
  try {
    directive = JSON.parse(res.stdout.trim()) as Directive;
  } catch {
    // The caller reports the raw output.
  }
  // The agent's proposal step follows the plan proposal print, as it does live.
  const proposal = proposalFollowUp(directive);
  return proposal === null ? { directive, out } : next(proj, harness, proposal, opts);
}

function questionFiles(proj: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

const requestId = (text: string): string | undefined => /--request ([0-9a-f]{8})/.exec(text)?.[1];

describe("next takes the person's own /aidlc line when the agent's command carries none of it", () => {
  for (const harness of ["kiro-ide", "claude"] as Harness[]) {
    test(`${harness}: a bare next after "/aidlc <words>" asks the plan question for those words`, async () => {
      const proj = fresh();
      await say(proj, LINE, harness);
      const { directive, out } = await next(proj, harness, []);
      expect(directive.kind, out).toBe("ask");
      expect(directive.ask_type).toBe("scope-confirm");
      expect(directive.question ?? "").toContain(WORDS);
      expect(directive.proposed_scope).toBe("bugfix");
      // The request the line was kept under (the agent's proposal step) and the
      // plan question derived from it: the words were taken once.
      expect(questionFiles(proj)).toHaveLength(2);
    });
  }

  test("kiro-ide: a scope the agent named on its own gives way to the person's words", async () => {
    const proj = fresh();
    await say(proj, LINE, "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "bugfix"]);
    expect(directive.kind, out).toBe("ask");
    expect(directive.ask_type).toBe("scope-confirm");
    expect(directive.question ?? "").toContain(WORDS);
  });

  // #2355: a plan typed alone is the person's pick with nothing yet to build:
  // the agent passes it on (the adapter names no first step for a plan alone),
  // and Kiro IDE's own engine tree asks them what it is for and creates nothing.
  test("kiro-ide: `/aidlc workshop` passed on by the agent asks what the work is for and creates nothing", async () => {
    const proj = fresh();
    await say(proj, "/aidlc workshop", "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["workshop"]);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "").not.toContain("intent create");
    expect(directive.message ?? "").toContain("next --scope workshop -- <their words>");
    expect((directive as { narration?: string }).narration, out).toBe(
      "I'll use the workshop plan. What should I work on? Tell me in your own words and I'll start it.",
    );
    expect(questionFiles(proj)).toHaveLength(0);
  });

  // The answer as Kiro IDE's agent sends it: their words, quotes and all, as
  // one argument after the delimiter, or through the request file the skill
  // names for words a Windows shell could change. Either way the work starts on
  // the plan they picked with their words exactly as written.
  test("kiro-ide: the answer to `/aidlc workshop`, with quotes in the words, starts workshop with every character kept", async () => {
    const words = `the "Sign in" button says it's locked`;
    for (const form of ["argument", "request-file"] as const) {
      const proj = fresh();
      await say(proj, "/aidlc workshop", "kiro-ide");
      const step = await next(proj, "kiro-ide", ["workshop"]);
      expect(step.directive.message ?? "", step.out).toContain("next --scope workshop -- <their words>");
      let args = ["--scope", "workshop", "--", words];
      if (form === "request-file") {
        mkdirSync(join(proj, "aidlc", ".aidlc-request-text"), { recursive: true });
        writeFileSync(join(proj, "aidlc", ".aidlc-request-text", "request.txt"), words, "utf-8");
        args = ["--scope", "workshop", "--request-file", "aidlc/.aidlc-request-text/request.txt"];
      }
      const { directive, out } = await next(proj, "kiro-ide", args);
      expect(directive.kind, `${form}: ${out}`).toBe("print");
      expect(directive.message ?? "", form).toContain("intent create --scope workshop --request");
      const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
      const texts = questionFiles(proj).map((name) => (JSON.parse(readFileSync(join(dir, name), "utf-8")) as { text: string }).text);
      expect(texts, form).toEqual([words]);
    }
  });

  test("kiro-ide: the explicit forms are untouched: --scope with the words after -- still creates the plan the person named", async () => {
    const proj = fresh();
    await say(proj, `/aidlc bugfix: ${WORDS}`, "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "bugfix", "--", WORDS]);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "").toContain("intent create --scope bugfix --request");
  });

  test("kiro-ide: a plan the person named wins over a different one the agent names, words kept", async () => {
    const proj = fresh();
    await say(proj, `/aidlc express: ${WORDS}`, "kiro-ide");
    const bare = await next(proj, "kiro-ide", []);
    expect(bare.directive.kind, bare.out).toBe("print");
    expect(bare.directive.message ?? "").toContain("intent create --scope express --request");
    const named = await next(proj, "kiro-ide", ["--scope", "bugfix"]);
    expect(named.directive.kind, named.out).toBe("print");
    expect(named.directive.message ?? "").toContain("intent create --scope express --request");
    expect(named.directive.message ?? "").not.toContain("--scope bugfix");
  });

  test("kiro-ide: a plan word that opens the person's sentence gets the same two readings as typed words", async () => {
    const proj = fresh();
    await say(proj, `/aidlc express ${WORDS}`, "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "bugfix"]);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "").toContain("`express` is the name of a plan and also the first word");
    expect(directive.message ?? "").toContain(`next --scope express -- '${WORDS}'`);
    expect(directive.message ?? "").toContain(`next -- 'express ${WORDS}'`);
    expect(questionFiles(proj)).toHaveLength(0);
  });

  test("kiro-ide: `/aidlc bugfix fix the login` with a bare next reads both ways, and the pick creates bugfix with no question", async () => {
    // The Kiro IDE first-step path (the adapter names a bare `next` for a line
    // of words): the engine takes the person's recorded line whole, names both
    // readings, and the agent's pick creates for the words after the plan.
    const proj = fresh();
    await say(proj, "/aidlc bugfix fix the login", "kiro-ide");
    const read = await next(proj, "kiro-ide", []);
    expect(read.directive.kind, read.out).toBe("print");
    expect(read.directive.message ?? "").toContain("`bugfix` is the name of a plan and also the first word");
    expect(read.directive.message ?? "").toContain("next --scope bugfix -- 'fix the login'");
    expect(read.directive.message ?? "").toContain("next -- 'bugfix fix the login'");
    expect(questionFiles(proj)).toHaveLength(0);
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "bugfix", "--", "fix the login"]);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "").toContain("intent create --scope bugfix --request");
    const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
    const texts = questionFiles(proj).map((name) => (JSON.parse(readFileSync(join(dir, name), "utf-8")) as { text: string }).text);
    expect(texts).toEqual(["fix the login"]);
  });

  test("kiro-ide: the person's answer to the open plan question goes through the same reading as typed words", async () => {
    const proj = fresh();
    await say(proj, LINE, "kiro-ide");
    const asked = await next(proj, "kiro-ide", []);
    expect(asked.directive.kind, asked.out).toBe("ask");
    const id = requestId(String(asked.directive.confirm_command ?? ""));
    expect(id).toBeDefined();
    // The record keeps a message's time to the second; the reply lands in a later one, as a typed reply does.
    await Bun.sleep(1100);
    await say(proj, "/aidlc go ahead", "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", []);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "").toContain("has not answered the plan question");
    expect(directive.message ?? "").toContain(`--request ${id}`);
    expect(directive.message ?? "").toContain("go ahead");
    expect(questionFiles(proj)).toHaveLength(2); // the proposal step's request and the plan question; the reply adds none
  });

  test("kiro-ide: the question's own confirm command then creates the work for that request", async () => {
    const proj = fresh();
    await say(proj, LINE, "kiro-ide");
    const asked = await next(proj, "kiro-ide", []);
    const id = requestId(String(asked.directive.confirm_command ?? ""));
    expect(id, asked.out).toBeDefined();
    // The person goes ahead with the plan.
    await say(proj, "1", "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "bugfix", "--request", id!]);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "").toContain(`intent create --scope bugfix --request ${id}`);
  });

  test("kiro-ide: a line with no words leaves today's error", async () => {
    const proj = fresh();
    await say(proj, "/aidlc --status", "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", []);
    expect(directive.kind, out).toBe("error");
    expect(directive.message ?? "").toContain(NO_STATE);
  });

  test("kiro-ide: a reply in plain words (no entry word) leaves today's error", async () => {
    const proj = fresh();
    await say(proj, "yes", "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", []);
    expect(directive.kind, out).toBe("error");
    expect(directive.message ?? "").toContain(NO_STATE);
  });

  test("kiro-ide: another chat's line is not taken", async () => {
    const proj = fresh();
    // This chat's own turn (so the hooks are known to run), then a record of another chat's line, later.
    await say(proj, "/aidlc --status", "kiro-ide");
    saveMessage(proj, recordOf(SECOND_SESSION));
    const { directive, out } = await next(proj, "kiro-ide", []);
    expect(directive.kind, out).toBe("error");
    expect(directive.message ?? "").toContain(NO_STATE);
  });

  test("kiro-ide: the Stop hook's read-only probe learns the directive and asks nothing", async () => {
    const proj = fresh();
    await say(proj, LINE, "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", [], { env: { AIDLC_STOP_HOOK_PROBE: "1" } });
    expect(directive.kind, out).toBe("error");
    expect(directive.message ?? "").toContain(NO_STATE);
    expect(questionFiles(proj)).toHaveLength(0);
  });

  // Copilot CLI hands `/aidlc <words>` to the hook as the skill's own text with the words filled in; the adapter records the
  // line rebuilt from it (tests/unit/t-copilot-skill-line), and the agent's bare `next` (measured 5 of 5 on 1.0.95) reads it.
  test("copilot: the slash line arrives as the host's skill wrapper, and a bare next asks the plan question for the words", async () => {
    const proj = fresh();
    const said = await say(proj, copilotSkillPrompt(proj, WORDS), "copilot");
    expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
    const { directive, out } = await next(proj, "copilot", []);
    expect(directive.kind, out).toBe("ask");
    expect(directive.ask_type).toBe("scope-confirm");
    expect(directive.question ?? "").toContain(WORDS);
    expect(directive.proposed_scope).toBe("bugfix");
    expect(questionFiles(proj)).toHaveLength(2); // the proposal step's request and the plan question it derived
  });

  test("copilot: a wrapper that is not our skill file byte for byte is recorded as delivered, and leaves today's error", async () => {
    const proj = fresh();
    const said = await say(proj, copilotSkillPrompt(proj, WORDS).replace("## Welcome", "## Welcome!"), "copilot");
    expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
    const { directive, out } = await next(proj, "copilot", []);
    expect(directive.kind, out).toBe("error");
    expect(directive.message ?? "").toContain(NO_STATE);
  });

  test("claude: a next --resume the agent sends on a workspace with no work asks the plan question for the words", async () => {
    const proj = fresh();
    await say(proj, LINE, "claude");
    const { directive, out } = await next(proj, "claude", ["--resume"]);
    expect(directive.kind, out).toBe("ask");
    expect(directive.ask_type).toBe("scope-confirm");
    expect(directive.question ?? "").toContain(WORDS);
  });

  test("claude: with no chat identity no record is read", async () => {
    const proj = fresh();
    await say(proj, LINE, "claude");
    // The hook ran (so the hooks are known to run); its session pid map is gone, and the agent's shell names no chat.
    rmSync(sessionPidMapDir(proj), { recursive: true, force: true });
    const { directive, out } = await next(proj, "claude", [], { noSession: true });
    expect(directive.kind, out).toBe("error");
    expect(directive.message ?? "").toContain(NO_STATE);
  });
});

// #2401, measured on Kiro IDE 1.3.0 on Windows: the hook kept the person's line,
// but the agent passed its own rewording behind a flag it made up, and the
// engine started the work under that. With no work yet, words that are none of
// the readings of their line give way to it; one of those readings is kept. The
// settings the agent read from their words are its reading and stay; a plan it
// named beside words that are not a whole reading gives way to the line's own,
// so the person picks it at the plan question.
describe("with no work yet, the agent's own wording gives way to the person's /aidlc line", () => {
  const THEIRS = `I want to build "Northwind Mini Bank", a small demo of a bank's core money handling. Keep the customer's own accounts apart.`;
  const AGENTS = "--description Northwind Mini Bank: a small demo of a banks core money handling. Keep the customers own accounts apart.";

  // The words are the line as a bare `next` reads it: the engine's one parse,
  // which keeps the apostrophes and reads the double quotes as quoting.
  test("kiro-ide: next --scope classic '<the agent's rewording>' asks the plan question for the person's words", async () => {
    const proj = fresh();
    const said = await say(proj, `/aidlc ${THEIRS}`, "kiro-ide");
    expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "classic", AGENTS]);
    expect(directive.kind, out).toBe("ask");
    expect(out).not.toContain("intent create --scope classic");
    expect(out).not.toContain("--description");
    const texts = questionTexts(proj);
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).toContain("a bank's core money handling. Keep the customer's own accounts");
  });

  // The engine cannot tell a plan the agent read from one it made up, so with
  // words that are not a whole reading, the plan is the person's at the question.
  test("kiro-ide: a plan the agent names beside part of their words is the person's to pick, with every word", async () => {
    const line = "Please use the classic plan for a notes app";
    const proj = fresh();
    await say(proj, `/aidlc ${line}`, "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "classic", "--", "a notes app"]);
    expect(directive.kind, out).toBe("ask");
    expect(out).not.toContain("intent create --scope classic");
    expect(questionTexts(proj)).toContain(line);
  });

  test("kiro-ide: their whole words under a plan they never named are not a reading: the plan is theirs to pick", async () => {
    const proj = fresh();
    await say(proj, "/aidlc build a notes app", "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "classic", "--", "build a notes app"]);
    expect(directive.kind, out).toBe("ask");
    expect(out).not.toContain("intent create --scope classic");
    expect(questionTexts(proj)).toContain("build a notes app");
  });

  test("kiro-ide: a setting the agent forwards with its paraphrase keeps every word of the person's line", async () => {
    const words = "add a description field to the signup form";
    const proj = fresh();
    await say(proj, `/aidlc --plan-approval off ${words}`, "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--plan-approval", "off", "--", "signup description field"]);
    expect(directive.kind, out).toBe("ask");
    expect(directive.question ?? "", out).toContain(words);
    expect(questionTexts(proj)).not.toContain("signup description field");
  });

  test("kiro-ide: words a flag `next` does not take was folded out of are not their line whole: it comes back", async () => {
    const proj = fresh();
    await say(proj, "/aidlc --details build a notes app", "kiro-ide");
    const shortened = parseNextFlags(["--details", "build", "a", "notes", "app"]).intent ?? "";
    expect(shortened.length).toBeGreaterThan(0);
    const { directive, out } = await next(proj, "kiro-ide", ["--", shortened]);
    expect(directive.message ?? "", out).toContain("does not take `--details");
    expect(questionFiles(proj)).toHaveLength(0);
  });

  test("kiro-ide: words that are one reading of the line are the agent's pick, kept as passed", async () => {
    for (const args of [["--", "bugfix fix the login"], ["--scope", "bugfix", "--", "fix the login"]]) {
      const proj = fresh();
      await say(proj, "/aidlc bugfix fix the login", "kiro-ide");
      const { directive, out } = await next(proj, "kiro-ide", args);
      expect(directive.message ?? "", args.join(" ")).not.toContain("is the name of a plan and also the first word");
      expect(questionTexts(proj), `${args.join(" ")}: ${out}`).toContain(args[args.length - 1]);
    }
  });

  test("kiro-ide: the last words of the line under a plan the agent picked are not a reading: their words whole are", async () => {
    const proj = fresh();
    await say(proj, "/aidlc Build a demo bank named Northwind Mini Bank", "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "classic", "--", "Northwind Mini Bank"]);
    expect(directive.kind, out).toBe("ask");
    expect(out).not.toContain("intent create --scope classic");
    const texts = questionTexts(proj);
    expect(texts).toContain("Build a demo bank named Northwind Mini Bank");
    expect(texts).not.toContain("Northwind Mini Bank");
  });

  test("kiro-ide: a plan the person typed wins over the one the agent read, with their words", async () => {
    const proj = fresh();
    await say(proj, `/aidlc bugfix: ${WORDS}`, "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "classic", "--", "fix the greeter"]);
    expect(directive.message ?? "", out).toContain("intent create --scope bugfix --request");
    expect(out).not.toContain("intent create --scope classic");
    expect(questionTexts(proj)).toContain(WORDS);
  });

  test("kiro-ide: a check switch the agent forwards with its paraphrase keeps the switch and their words", async () => {
    const proj = fresh();
    await say(proj, `/aidlc --guard.review-freeze off ${WORDS}`, "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide",
      ["--scope", "classic", "--guard.review-freeze", "off", "--", "fix the greeter"]);
    expect(directive.kind, out).toBe("ask");
    expect(out).not.toContain("intent create --scope classic");
    expect(out).toContain("--guard.review-freeze off");
    expect(questionTexts(proj)).toContain(WORDS);
    expect(questionTexts(proj)).not.toContain("fix the greeter");
  });

  test("kiro-ide: a stage the agent read in their words stays beside the stages their line typed", async () => {
    const proj = fresh();
    await say(proj, `/aidlc bugfix --skip deployment-pipeline,deployment-execution ${WORDS}, and include functional design`,
      "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "bugfix", "--skip",
      "deployment-pipeline,deployment-execution", "--add", "functional-design", "--", "fix the greeter"]);
    const message = directive.message ?? "";
    expect(message, out).toContain("intent create --scope bugfix --request");
    expect(message, out).toContain("functional-design");
    expect(message, out).toContain("deployment-pipeline");
    expect(questionTexts(proj)).not.toContain("fix the greeter");
  });

  test("kiro-ide: a tail of a plan word's task is not that reading: the line's reading step comes back", async () => {
    const proj = fresh();
    await say(proj, "/aidlc bugfix fix the login", "kiro-ide");
    const { directive, out } = await next(proj, "kiro-ide", ["--scope", "bugfix", "--", "the login"]);
    expect(directive.message ?? "", out).toContain("`bugfix` is the name of a plan and also the first word");
    expect(questionFiles(proj)).toHaveLength(0);
  });

  test("kiro-ide: with work open the agent's words are left as today", async () => {
    const proj = await workOpen();
    await say(proj, NEW_LINE, "kiro-ide");
    const { out } = await next(proj, "kiro-ide", ["--", "something the person never typed"]);
    expect(out).not.toContain(NEW_WORK);
  });
});

// Work is open (a bug fix at Requirements Analysis, or t176's widget feature at
// Feasibility) and the person types new work after the entry word.
const NEW_WORK = "build a standalone Python CLI that scrapes NOAA weather data and writes it to a SQLite database";
const NEW_LINE = `/aidlc "${NEW_WORK}"`;
const READING = "the person's words may ask to redo";

/** A project with work open: the corpus's work-open state (a bug fix at Requirements Analysis). */
async function workOpen(): Promise<string> {
  const proj = fresh();
  await buildState(proj, "work-open");
  return proj;
}

function questionTexts(proj: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  return questionFiles(proj).map((name) => (JSON.parse(readFileSync(join(dir, name), "utf-8")) as { text: string }).text);
}

/** The open work's own step: its rules part or its stage, never a reading of words. */
function isTheWorksStep(directive: Directive): boolean {
  return directive.kind === "load-steering" || directive.kind === "run-stage";
}

describe("with work open, the agent's first step after `/aidlc <words>` reads the line when it carries none of it", () => {
  for (const harness of ["claude", "codex", "kiro", "kiro-ide"] as Harness[]) {
    test(`${harness}: next --resume after "/aidlc <new work>" gets the reading of their words, not the open stage`, async () => {
      const proj = await workOpen();
      const said = await say(proj, harness === "codex" ? NEW_LINE.replace(/^\/aidlc/, "$aidlc") : NEW_LINE, harness);
      expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
      const { directive, out } = await next(proj, harness, ["--resume"]);
      expect(directive.kind, out).toBe("print");
      expect(directive.message ?? "", out).toContain(READING);
      expect(questionTexts(proj)).toEqual([NEW_WORK]);
    });
  }

  // A team clone: each clone writes its own committed audit shard, and the
  // shards are read in filename order, so a teammate's shard can sort after
  // this clone's. Their turn is still the latest row of this clone's shard.
  test("claude: in a team clone whose teammate's shard sorts after this clone's, next --resume still reads the line", async () => {
    const proj = await workOpen();
    const audit = join(seededRecordDir(proj), "audit");
    mkdirSync(audit, { recursive: true });
    writeFileSync(join(audit, "zz-teammate-0123456789abcdef.md"), [
      "# AI-DLC Audit Log", "", "## Session Start", "**Timestamp**: 2026-10-01T09:00:00Z", "**Event**: SESSION_STARTED",
      "**Source**: startup", "**Session**: 01995000-7a11-7000-8000-00000000d0ff", "", "---", "",
    ].join("\n"), "utf-8");
    await say(proj, NEW_LINE, "claude");
    const { directive, out } = await next(proj, "claude", ["--resume"]);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "", out).toContain(READING);
    expect(questionTexts(proj)).toEqual([NEW_WORK]);
  });

  test("claude: a bare next as the first step reads the line the same way", async () => {
    const proj = await workOpen();
    await say(proj, NEW_LINE, "claude");
    const { directive, out } = await next(proj, "claude", []);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "", out).toContain(READING);
    expect(questionTexts(proj)).toEqual([NEW_WORK]);
  });

  // The recorded miss (t176 run 8 on main b9c3e9000f), replayed: the widget
  // feature at Feasibility, the line exactly as Claude Code delivered it, the
  // agent's `next --resume`, then the step the reading names for new work.
  test("claude: the t176 miss replayed: next --resume, then the reading's own step, asks where the new work belongs", async () => {
    const proj = fresh();
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8"), "utf-8");
    await say(proj, NEW_LINE, "claude");
    const read = await next(proj, "claude", ["--resume"]);
    expect(read.directive.kind, read.out).toBe("print");
    const id = requestId(String(read.directive.message ?? ""));
    expect(id, read.out).toBeDefined();
    const { directive, out } = await next(proj, "claude", ["--request", id!, "--propose", "classic"]);
    expect(directive.kind, out).toBe("ask");
    expect(directive.ask_type).toBe("new-work-routing");
    expect(directive.question ?? "").toContain(NEW_WORK);
  });

  test("claude: a bare /aidlc re-entry still resumes the open work", async () => {
    const proj = await workOpen();
    await say(proj, "/aidlc", "claude");
    const { directive, out } = await next(proj, "claude", ["--resume"]);
    expect(isTheWorksStep(directive), out).toBe(true);
    expect(questionFiles(proj)).toHaveLength(0);
  });

  test("claude: after the agent passed the words itself, a bare next or next --resume is the work's own step", async () => {
    const proj = await workOpen();
    await say(proj, NEW_LINE, "claude");
    const passed = await next(proj, "claude", [NEW_WORK]);
    expect(passed.directive.message ?? "", passed.out).toContain(READING);
    for (const args of [[], ["--resume"]]) {
      const { directive, out } = await next(proj, "claude", args);
      expect(isTheWorksStep(directive), `${args.join(" ")}: ${out}`).toBe(true);
    }
    expect(questionTexts(proj)).toEqual([NEW_WORK]);
  });

  test("claude: a line taken once is not taken again: \"carry on\", then the bare next the reading names, is the work's own step", async () => {
    const proj = await workOpen();
    await say(proj, "/aidlc carry on", "claude");
    const taken = await next(proj, "claude", ["--resume"]);
    expect(taken.directive.message ?? "", taken.out).toContain(READING);
    const { directive, out } = await next(proj, "claude", []);
    expect(isTheWorksStep(directive), out).toBe(true);
    expect(questionTexts(proj)).toEqual(["carry on"]);
  });

  test("claude: once something is recorded after their line, a bare next is the work's own step", async () => {
    const proj = await workOpen();
    await say(proj, NEW_LINE, "claude");
    const logged = await exec([
      process.execPath, join(AIDLC_SRC, "tools", "aidlc-log.ts"), "decision", "--project-dir", proj,
      "--stage", "requirements-analysis", "--decision", "Where does the new work go?", "--options", "Here,Separate",
    ], { cwd: proj, env: env(proj) });
    expect(logged.status, `${logged.stdout}${logged.stderr}`).toBe(0);
    const { directive, out } = await next(proj, "claude", []);
    expect(isTheWorksStep(directive), out).toBe(true);
    expect(questionFiles(proj)).toHaveLength(0);
  });

  test("claude: a line of settings alone, then next --resume, names the setter as a bare next does", async () => {
    const proj = await workOpen();
    await say(proj, "/aidlc --depth minimal", "claude");
    const bare = await next(proj, "claude", []);
    expect(bare.directive.kind, bare.out).toBe("print");
    const proj2 = await workOpen();
    await say(proj2, "/aidlc --depth minimal", "claude");
    const resumed = await next(proj2, "claude", ["--resume"]);
    expect(resumed.directive.kind, resumed.out).toBe("print");
    expect(resumed.directive.message, resumed.out).toBe(bare.directive.message);
  });

  // The code plan answered by an exact pick in the line: the hook records the
  // answer, `next` with their words says so and names a bare `next`, and that
  // bare `next` carries the answer out instead of reading the line again.
  for (const pick of ["Approve Plan", "1"]) {
    test(`claude: "/aidlc ${pick}" at the plan question: the bare next after the engine's print is not the same print`, async () => {
      const proj = fresh();
      await buildState(proj, "plan-question-open");
      await Bun.sleep(1100);
      await say(proj, `/aidlc ${pick}`, "claude");
      const first = await next(proj, "claude", [pick]);
      const second = await next(proj, "claude", []);
      expect(second.out, `first: ${first.out}`).not.toBe(first.out);
      const third = await next(proj, "claude", []);
      expect(third.directive.message ?? "", `second: ${second.out}`).not.toBe(first.directive.message ?? "");
    });
  }
});

// The entry word alone over work in hand: the chat-start context no longer
// tells the agent to turn it into `next --resume`, so the agent runs `next`
// with what was typed (nothing), and the recorded line decides: it picks the
// work back up, as `--resume` does, whichever the agent sent.
const PICK_UP = "Picking up where we left off, at ";

/** `next` as the agent runs it, its rules parts continued to the step they lead to. */
async function stepAfter(proj: string, harness: Harness, args: string[]): Promise<{ directive: Directive; out: string }> {
  let step = await next(proj, harness, args);
  const tool = harness === "claude"
    ? ORCHESTRATE
    : join(proj, harness === "copilot" ? ".aidlc" : harness === "codex" ? ".codex" : ".kiro", "tools", "aidlc-orchestrate.ts");
  for (let parts = 0; parts < 20 && step.directive.kind === "load-steering" && typeof step.directive.receipt === "string"; parts++) {
    const res = await exec([process.execPath, tool, "continue", step.directive.receipt, "--project-dir", proj], { cwd: proj, env: env(proj) });
    const out = `${res.stdout}${res.stderr}`;
    let directive: Directive = {};
    try {
      directive = JSON.parse(res.stdout.trim()) as Directive;
    } catch {
      // The caller reports the raw output.
    }
    step = { directive, out };
  }
  return step;
}

describe("the entry word alone over work in hand picks the work back up, whichever first next the agent sends", () => {
  for (const harness of ["claude", "codex", "kiro", "kiro-ide", "copilot"] as Harness[]) {
    test(`${harness}: "/aidlc" alone, then a bare next, picks the work up as --resume does`, async () => {
      const proj = await workOpen();
      const line = harness === "codex" ? "$aidlc" : harness === "copilot" ? copilotSkillPrompt(proj, "") : "/aidlc";
      const said = await say(proj, line, harness);
      expect(said.status, `${said.stdout}${said.stderr}`).toBe(0);
      const { directive, out } = await stepAfter(proj, harness, []);
      expect(directive.kind, out).toBe("run-stage");
      expect(directive.narration ?? "", out).toStartWith(PICK_UP);
    });
  }

  test("claude: \"/aidlc\" alone, then next --resume, is the same pick-up", async () => {
    const proj = await workOpen();
    await say(proj, "/aidlc", "claude");
    const { directive, out } = await stepAfter(proj, "claude", ["--resume"]);
    expect(directive.kind, out).toBe("run-stage");
    expect(directive.narration ?? "", out).toStartWith(PICK_UP);
  });

  test("claude: once something is recorded after \"/aidlc\", a bare next is the work's own step with no pick-up line", async () => {
    const proj = await workOpen();
    await say(proj, "/aidlc", "claude");
    const logged = await exec([
      process.execPath, join(AIDLC_SRC, "tools", "aidlc-log.ts"), "decision", "--project-dir", proj,
      "--stage", "requirements-analysis", "--decision", "How should the questions be answered?", "--options", "Guide me,Chat",
    ], { cwd: proj, env: env(proj) });
    expect(logged.status, `${logged.stdout}${logged.stderr}`).toBe(0);
    const { directive, out } = await stepAfter(proj, "claude", []);
    expect(directive.kind, out).toBe("run-stage");
    expect(directive.narration ?? "", out).not.toContain(PICK_UP);
  });

  test("claude: \"/aidlc\" alone with no work yet leaves today's answer", async () => {
    const proj = fresh();
    await say(proj, "/aidlc", "claude");
    const { directive, out } = await next(proj, "claude", []);
    expect(directive.kind, out).toBe("error");
    expect(directive.message ?? "").toContain(NO_STATE);
  });
});

// The reading of the person's words over one piece of open work names that
// work, so the agent compares their words with what is open instead of
// guessing: measured on Claude Code (2 of 40 runs), the agent took new work for
// the open work's subject and carried it on.
describe("the reading of words over one piece of open work names it", () => {
  test("claude: the agent passes the words: the reading names the open work", async () => {
    const proj = await workOpen();
    await say(proj, NEW_LINE, "claude");
    const { directive, out } = await next(proj, "claude", [NEW_WORK]);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "", out).toStartWith('Work is in progress on "Todo app bug fix", and the person\'s words may ask to redo');
  });

  test("claude: the agent sends next --resume: the line it reads gets the same reading, naming the open work", async () => {
    const proj = fresh();
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8"), "utf-8");
    await say(proj, NEW_LINE, "claude");
    const { directive, out } = await next(proj, "claude", ["--resume"]);
    expect(directive.kind, out).toBe("print");
    expect(directive.message ?? "", out).toContain('Work is in progress on "Test widget feature for e-commerce platform"');
  });
});
