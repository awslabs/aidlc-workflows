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
// Spawns the real engine and each host's own human-turn hook (the Kiro IDE
// adapter and the Claude Code dispatcher), as tests/unit/t-message-record does.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createOrchestrationTestProject, proposalFollowUp } from "../harness/fixtures.ts";
import {
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

type Record = Parameters<typeof saveMessage>[1];
/** The record the hook would have written for `/aidlc <words>` in `session`, with no hook run. */
function recordOf(session: string): Record {
  return {
    session, at: new Date().toISOString(), source: "prompt", text: LINE, picker: null, words: WORDS,
    settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null }, applied: [],
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
    : join(proj, harness === "copilot" ? ".aidlc" : ".kiro", "tools", "aidlc-orchestrate.ts");
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

  test("kiro-ide: the explicit forms are untouched: --scope with the words after -- still creates", async () => {
    const proj = fresh();
    await say(proj, LINE, "kiro-ide");
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
