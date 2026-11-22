// covers: function:withTypedSpacing, function:splitKiroCommandArgs, hook:aidlc-record-human-turn
// covers: subcommand:aidlc-orchestrate:next
//
// Live on Kiro CLI (Windows Server, then Linux): the person typed a request
// quoting their own symptom string with two spaces after each word,
// "Hello,  World!  Again". Kiro hands the prompt hook the words with the double
// quotes gone and the spaces kept; the word split then joined the words again
// with one space, so the message record, the plan question and every audit
// Request kept "Hello, World! Again", and the product-lead reviewer told the
// person their own symptom string was wrong. Their spacing is now kept as
// typed, on the record and on the request the work is created from, on every
// harness: an unquoted run of spaces on Claude Code is kept the same way. The
// words themselves never change, and any gap other than spaces and tabs (a
// line break, a no-break space) stays one plain space, as before.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  followProposal,
  removeWorkspaceRecord,
  REPO_ROOT,
  runOrchestrateNext,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  auditBlockField,
  hooksHealthDir,
  personsWordsText,
  readAuditShardEvents,
  splitKiroCommandArgs,
  withTypedSpacing,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c5a1";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function env(proj: string): NodeJS.ProcessEnv {
  return {
    ...testGuardEnvironment(process.env, "production"),
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
}

function emptyProject(): string {
  const proj = createTestProject();
  created.push(proj);
  removeWorkspaceRecord(proj);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return proj;
}

function kiroProject(): string {
  const proj = emptyProject();
  cpSync(join(REPO_ROOT, "dist", "kiro", ".kiro"), join(proj, ".kiro"), { recursive: true });
  return proj;
}

function fire(proj: string, args: string[], payload: Record<string, unknown>, extra: NodeJS.ProcessEnv = {}): void {
  const fired = spawnSync(BUN, args, {
    cwd: proj,
    input: JSON.stringify({ session_id: SESSION, cwd: proj, ...payload }),
    env: { ...env(proj), USER_PROMPT: undefined, ...extra },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(fired.status, `${fired.stdout}${fired.stderr}`).toBe(0);
}

// The person's line as Kiro CLI hands it to its prompt hook.
function kiroSays(proj: string, prompt: string): void {
  fire(proj, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "verb-intercept"],
    { hook_event_name: "userPromptSubmit", prompt }, { CLAUDE_PROJECT_DIR: undefined });
}

// The call the hook told the agent to run, as the shell hands it to the engine.
function latchedArgs(proj: string): string[] {
  const latch = JSON.parse(readFileSync(join(proj, "aidlc", ".aidlc-forwarding-latch"), "utf-8")) as { args: string[] };
  return latch.args;
}

function next(proj: string, args: string[]): { d: Record<string, unknown>; out: string } {
  const options = { env: env(proj) };
  const result = followProposal(runOrchestrateNext(ORCHESTRATE, proj, args, options), ORCHESTRATE, proj, options);
  expect(result.directive, result.out).not.toBeNull();
  return { d: result.directive as unknown as Record<string, unknown>, out: result.out };
}

function questionCopies(proj: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => String((JSON.parse(readFileSync(join(dir, name), "utf-8")) as { text?: unknown }).text ?? ""));
}

const SYMPTOM = "Hello,  World!  Again";

describe("Kiro CLI: a request is recorded with the person's spacing as typed", () => {
  test("the message record, the plan question and the work's Request keep the double spaces", () => {
    const proj = kiroProject();
    const request = `the slug for ${SYMPTOM} comes out as hello---world---again, fix it`;
    kiroSays(proj, `/aidlc ${request}`);
    const records = listMessages(proj);
    expect(records.length, JSON.stringify(records)).toBe(1);
    expect(personsWordsText(records[0].text)).toBe(`/aidlc ${request}`);
    expect(records[0].words && personsWordsText(records[0].words)).toBe(request);
    const { d, out } = next(proj, latchedArgs(proj));
    expect(d.kind, out).toBe("ask");
    expect(String(d.question), out).toContain(request);
    const copies = questionCopies(proj);
    expect(copies.length, out).toBeGreaterThan(0);
    for (const copy of copies) expect(copy).toBe(request);
    // The person picks the plan, as in the live run ("1"), and the work starts from the question's words.
    kiroSays(proj, "1");
    const confirm = String(d.confirm_command);
    const picked = runOrchestrateNext(ORCHESTRATE, proj, splitKiroCommandArgs(confirm.slice(confirm.indexOf(" next ") + 6)),
      { env: env(proj) });
    const create = /`bun \S+aidlc\.ts (engine intent create [^`]+)`/.exec(String(picked.directive?.message ?? ""));
    expect(create, picked.out).not.toBeNull();
    const made = spawnSync(BUN, [DISPATCHER, ...splitKiroCommandArgs(create![1].replace(/"<[^>]+>"/, "slug-spacing"))], {
      cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
    const started = readAuditShardEvents(proj).filter((row) => row.event === "WORKFLOW_STARTED");
    expect(started.length, picked.out).toBeGreaterThan(0);
    for (const row of started) expect(auditBlockField(row.block, "Request")).toBe(`/aidlc ${request}`);
  });

  test("with a flag-shaped word in the request, the agent's re-run behind -- keeps the spacing too", () => {
    const proj = kiroProject();
    const request = `the slug for ${SYMPTOM} comes out wrong, and add a --max-length option`;
    kiroSays(proj, `/aidlc ${request}`);
    const words = listMessages(proj)[0].words;
    expect(words && personsWordsText(words)).toBe(request);
    const args = latchedArgs(proj);
    const first = runOrchestrateNext(ORCHESTRATE, proj, args, { env: env(proj) });
    expect(first.directive?.kind, first.out).toBe("print");
    expect(String((first.directive as { message?: unknown }).message)).toContain("--max-length");
    const { d, out } = next(proj, ["--", ...args]);
    expect(d.kind, out).toBe("ask");
    const copies = questionCopies(proj);
    expect(copies.length, out).toBeGreaterThan(0);
    for (const copy of copies) expect(copy).toBe(request);
  });
});

describe("every harness: an unquoted run of spaces between words is kept", () => {
  test("Claude Code: /aidlc fix  the  login  page records the words with their spacing", () => {
    const proj = emptyProject();
    fire(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
      { hook_event_name: "UserPromptSubmit", prompt: "/aidlc fix  the  login  page" }, { CLAUDE_PROJECT_DIR: proj });
    const records = listMessages(proj);
    expect(records.length, JSON.stringify(records)).toBe(1);
    expect(records[0].words && personsWordsText(records[0].words)).toBe("fix  the  login  page");
  });

  test("Claude Code: a plan named by flag whose name opens the request keeps the request's own spacing", () => {
    const proj = emptyProject();
    fire(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
      { hook_event_name: "UserPromptSubmit", prompt: "/aidlc --scope bugfix  bugfix bugfix  is broken" },
      { CLAUDE_PROJECT_DIR: proj });
    const records = listMessages(proj);
    expect(records.length, JSON.stringify(records)).toBe(1);
    expect(records[0].words && personsWordsText(records[0].words)).toBe("bugfix bugfix  is broken");
  });
});

describe("withTypedSpacing: only the separators take what was typed", () => {
  test("words that stood next to each other take the whitespace between them", () => {
    expect(withTypedSpacing("Hello, World! Again", `${SYMPTOM}`)).toBe(SYMPTOM);
    expect(withTypedSpacing("a b\tc", "a  b\t\tc")).toBe("a  b\t\tc");
    // A quoted token keeps its own spaces and lines up whole; the quotes are the split's to drop.
    expect(withTypedSpacing("say Hello,  World! now", `say   "Hello,  World!"  now`)).toBe("say   Hello,  World!  now");
  });

  test("a gap that is not spaces and tabs stays one plain space, as the split hands it on", () => {
    // A no-break space pasted from a document reads as a plain space (the input corpus, cu03-w).
    expect(withTypedSpacing("fix the login", "fix\u00a0the  login")).toBe("fix the  login");
    expect(withTypedSpacing("fix this and that", "fix  this\nand  that")).toBe("fix  this and  that");
    expect(withTypedSpacing("fix this and that", "fix this \r\n and that")).toBe("fix this and that");
  });

  test("the spacing comes only from the one stretch of the line that spells the words side by side", () => {
    // A plan named by flag whose name opens the request: the stretch is the request's own words.
    expect(withTypedSpacing("feature flags", "--scope feature feature  flags")).toBe("feature  flags");
    // The gap typed between the flag's value and the request is no gap between the request's words.
    expect(withTypedSpacing("bugfix bugfix is broken", "--scope bugfix  bugfix bugfix is broken"))
      .toBe("bugfix bugfix is broken");
    expect(withTypedSpacing("fix the bug", "--plan-approval  off  fix  the  bug")).toBe("fix  the  bug");
    expect(withTypedSpacing("fix the bug", "fix  the  bug  --plan-approval off")).toBe("fix  the  bug");
    // Two stretches that spell the words with different spacing, or a flag between the words: the join's space.
    expect(withTypedSpacing("a a", "--scope a  a a")).toBe("a a");
    expect(withTypedSpacing("add it now", "add  --depth minimal  it  now")).toBe("add it now");
  });

  test("the words never change: a token lines up only whole, and text that does not line up comes back as it is", () => {
    expect(withTypedSpacing("fixa", "fix  a")).toBe("fixa");
    expect(withTypedSpacing("fix a", "fixa")).toBe("fix a");
    // An agent's rewording (the accents it dropped) is its own text: nothing changes.
    expect(withTypedSpacing("la pagina de la panaderia", "la  página  de  la  panadería")).toBe("la pagina de la panaderia");
    expect(withTypedSpacing("something else entirely", "fix  the  bug")).toBe("something else entirely");
    expect(withTypedSpacing("", "fix  it")).toBe("");
    for (const [words, raw] of [
      ["Hello, World! Again", SYMPTOM], ["fix this and that", "fix  this\nand  that"], ["x y", "x\u00a0\u00a0y"],
    ] as const) {
      expect(withTypedSpacing(words, raw).split(/\s+/)).toEqual(words.split(/\s+/));
    }
  });

  test("the split hands on the same tokens as before", () => {
    expect(splitKiroCommandArgs(`say   "Hello,  World!"  now`)).toEqual(["say", "Hello,  World!", "now"]);
    expect(splitKiroCommandArgs(SYMPTOM)).toEqual(["Hello,", "World!", "Again"]);
    expect(splitKiroCommandArgs(String.raw`C:\path\to  one\ two it's`)).toEqual([String.raw`C:\path\to`, "one two", "it's"]);
  });
});
