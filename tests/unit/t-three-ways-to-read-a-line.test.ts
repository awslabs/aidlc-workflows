// covers: function:parseNextFlags, subcommand:aidlc-orchestrate:next, function:classifyTerminalCommand,
// function:isReadOnlyNextArgv
//
// Three ways to read what the person typed after `/aidlc`, decided by the one
// parse. EXACT: every token read under the grammar, and any free words marked as
// theirs (`--`, or a plan named with a colon); it acts. WORDS: the parse read
// nothing, so it is a request. Anything else goes to the agent as one reading
// step carrying their whole line and the exact command for each reading, and
// nothing is created, switched, jumped, dropped or refused before the agent has
// read it.
//
// Before this, five shapes of ordinary line were acted on without anyone reading
// them: a reply to the engine's own plan offer became a new request (so "yes"
// asked the same offer again, for work called "yes", a loop the person could sit
// in); a bare plan word was peeled off their sentence, so "classic car rental
// website" lost its first word; a leading noun with their sentence after it was
// run as a workspace or plugin command, so "intent is to build a notes app"
// switched records; and a value a flag's table does not hold ended the turn.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  classifyTerminalCommand,
  hooksHealthDir,
  isReadOnlyNextArgv,
  splitKiroCommandArgs,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { parseNextFlags } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const SESSION = "01995000-7a11-7000-8000-000000001b01";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function env(proj: string): NodeJS.ProcessEnv {
  return {
    ...testGuardEnvironment(process.env, "production"),
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
}

interface Emitted {
  kind?: string;
  ask_type?: string;
  message?: string;
  narration?: string;
  question?: string;
  confirm_command?: string;
  compose_command?: string;
  scope_commands?: Array<{ scope: string; command: string }>;
}

function next(proj: string, args: string[] = []): { d: Emitted; out: string } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: env(proj) });
  expect(result.directive, result.out).not.toBeNull();
  return { d: result.directive as unknown as Emitted, out: result.out };
}

/** No work yet; the person's chat runs AI-DLC's hooks. */
function emptyProject(): string {
  const proj = createTestProject();
  created.push(proj);
  removeWorkspaceRecord(proj);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return proj;
}

/** Work already under way in this chat. */
function openWork(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj),
    readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8"), "utf-8");
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return proj;
}

/** Every question the engine kept a copy of, by id. */
function questions(proj: string): Array<{ id: string; text: string; origin: string }> {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as { id: string; text: string; origin: string });
}

const activeIntent = (proj: string) => {
  const path = join(proj, "aidlc", "spaces", "default", "intents", "active-intent");
  return existsSync(path) ? readFileSync(path, "utf-8").trim() : "";
};

// ---------------------------------------------------------------------------
// A reply to one of the engine's own questions answers it, and never becomes
// a new request
// ---------------------------------------------------------------------------

describe("their reply to the plan offer reaches that offer", () => {
  test.each(["yes", "go ahead", "1"])("%j after the compose offer is not a request named that", (reply) => {
    const proj = emptyProject();
    const offer = next(proj, ["build a small notes app for my team"]);
    expect(offer.d.ask_type, offer.out).toBe("compose-offer");
    const asked = questions(proj);
    expect(asked.length).toBe(1);

    const answered = next(proj, splitKiroCommandArgs(reply));
    // Not the same offer again, and never an offer about their reply.
    expect(String(answered.d.question ?? ""), answered.out).not.toContain(reply);
    expect(answered.d.kind, answered.out).toBe("print");
    expect(answered.d.narration, answered.out).toBeUndefined();
    // It carries that question's own commands, by its id.
    expect(String(answered.d.message)).toContain(asked[0].id);
    // And nothing new was asked of them.
    expect(questions(proj).length).toBe(1);
    cleanupTestProject(created.pop());
  });

  test("their yes after a named-plan offer carries that offer's confirm command", () => {
    const proj = emptyProject();
    const offer = next(proj, ["fix the login crash when the session expires"]);
    expect(offer.d.ask_type, offer.out).toBe("scope-confirm");
    const asked = questions(proj);
    const answered = next(proj, ["yes"]);
    expect(answered.d.kind, answered.out).toBe("print");
    expect(String(answered.d.message)).toContain(asked[0].id);
    expect(String(answered.d.message)).toContain("--scope");
  });

  test("a different request after the offer still reaches the plan offer for it", () => {
    const proj = emptyProject();
    expect(next(proj, ["build a small notes app for my team"]).d.ask_type).toBe("compose-offer");
    const other = next(proj, ["actually, build the CSV export instead"]);
    // The agent is told both readings, so neither their answer nor a new
    // request is lost; the new request still reaches an offer of its own.
    expect(other.d.kind, other.out).toBe("print");
    expect(String(other.d.message)).toContain("--");
    const fresh = next(proj, ["--", "build the CSV export"]);
    expect(fresh.d.kind, fresh.out).toBe("ask");
    expect(String(fresh.d.question)).toContain("build the CSV export");
  });
});

// ---------------------------------------------------------------------------
// A bare plan word is ambiguous with their first word
// ---------------------------------------------------------------------------

describe("a plan word at the start of their sentence", () => {
  test("with words after it, the agent is told both readings and nothing is created", () => {
    const proj = emptyProject();
    const { d, out } = next(proj, ["bugfix", "Fix", "duplicate", "todos"]);
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    expect(d.ask_type, out).toBeUndefined();
    // The plan reading, and their words reading, each as a command to run.
    expect(String(d.message)).toContain("--scope bugfix");
    expect(String(d.message)).toContain("Fix duplicate todos");
    expect(String(d.message)).toContain("--");
    // Nothing was created and nothing was asked of them.
    expect(activeIntent(proj)).toBe("");
    expect(questions(proj).length).toBe(0);
  });

  test("their own first word is never spent as a plan name", () => {
    const proj = emptyProject();
    const { d, out } = next(proj, ["classic", "car", "rental", "website"]);
    expect(d.kind, out).toBe("print");
    expect(String(d.message)).toContain("classic car rental website");
    // One re-run marked as theirs keeps every word.
    const asked = next(proj, ["--", "classic car rental website"]);
    expect(asked.d.kind, asked.out).toBe("ask");
    expect(String(asked.d.question)).toContain("classic car rental website");
  });

  test("a plan word alone still acts, and so does the colon form", () => {
    const alone = next(emptyProject(), ["bugfix"]);
    expect(alone.d.kind, alone.out).not.toBe("print");
    expect(parseNextFlags(["bugfix"]).positionalScope).toBe("bugfix");
    const colon = parseNextFlags(["bugfix:", "Fix duplicate todos"]);
    expect(colon.positionalScope).toBe("bugfix");
    expect(colon.intent).toBe("Fix duplicate todos");
    expect(colon.readingStep).toBeUndefined();
  });

  test("a plan named by its flag with a clean tail of their words still acts", () => {
    const parsed = parseNextFlags(["--scope", "bugfix", "fix", "the", "login", "crash"]);
    expect(parsed.scope).toBe("bugfix");
    expect(parsed.intent).toBe("fix the login crash");
    expect(parsed.readingStep).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A noun of the engine's with their sentence after it
// ---------------------------------------------------------------------------

describe("a word that is also one of the engine's nouns", () => {
  test.each([
    ["intent is to build a notes app", "intent"],
    ["space is where we keep the specs", "space"],
    ["plugin is confusing", "plugin"],
  ])("%j is read by the agent, not run as a command", (line, noun) => {
    const proj = openWork();
    const before = activeIntent(proj);
    const { d, out } = next(proj, splitKiroCommandArgs(line));
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    // Their whole line, and the way to keep it as theirs.
    expect(String(d.message)).toContain(line);
    expect(String(d.message)).toContain("--");
    expect(String(d.message)).toContain(noun);
    // Nothing switched.
    expect(activeIntent(proj)).toBe(before);
    cleanupTestProject(created.pop());
  });

  test("the noun's own commands still act", () => {
    expect(parseNextFlags(["intent", "list"]).workspaceCommand).toBeDefined();
    expect(parseNextFlags(["intent", "list"]).readingStep).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A value the flag's table does not hold
// ---------------------------------------------------------------------------

describe("a flag the engine takes with a value it does not", () => {
  test.each([
    ["--plan-approval", "off.", "on|off"],
    ["--depth", "banana", "minimal|standard|comprehensive"],
  ])("%s %s is a reading step naming what is valid", (flag, value, valid) => {
    const proj = emptyProject();
    const { d, out } = next(proj, [flag, value]);
    // A print the agent acts on, not an error that ends the turn.
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    expect(String(d.message)).toContain(valid);
    expect(String(d.message)).toContain("--");
    cleanupTestProject(created.pop());
  });

  test("the value it does hold still acts", () => {
    expect(parseNextFlags(["--depth", "minimal"]).depth).toBe("minimal");
    expect(parseNextFlags(["--depth", "minimal"]).readingStep).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The seams that act before any agent reads
// ---------------------------------------------------------------------------

describe("the prompt-time seams read the same three ways", () => {
  const readingOrWords = [
    "intent is to build a notes app",
    "space is where we keep the specs",
    "plugin is confusing",
    "bugfix Fix duplicate todos",
    "classic car rental website",
    "fix the login crash",
    "add a --verbose flag to the CLI",
  ];
  test.each(readingOrWords)("%j is neither terminal nor read-only at the seam", (line) => {
    const argv = splitKiroCommandArgs(line);
    expect(classifyTerminalCommand(argv), line).toBeNull();
    expect(isReadOnlyNextArgv(argv), line).toBe(false);
  });

  test("a command of the engine's own is still terminal at the seam", () => {
    expect(classifyTerminalCommand(splitKiroCommandArgs("intent list"))).not.toBeNull();
    expect(isReadOnlyNextArgv(splitKiroCommandArgs("--status"))).toBe(true);
  });

  test("one quoted argument reads the same as the split form", () => {
    for (const line of ["--doctor --export", "intent is to build a notes app", "--status"]) {
      const split = splitKiroCommandArgs(line);
      expect(classifyTerminalCommand([line]) === null, `quoted: ${line}`)
        .toBe(classifyTerminalCommand(split) === null);
      expect(isReadOnlyNextArgv([line]), `quoted: ${line}`).toBe(isReadOnlyNextArgv(split));
    }
  });

  test("the delimiter is honoured by the seams, as it is by the parser", () => {
    // Their words after `--` are theirs, whatever token they contain.
    expect(isReadOnlyNextArgv(splitKiroCommandArgs("-- add a --config flag"))).toBe(false);
    expect(classifyTerminalCommand(splitKiroCommandArgs("-- intent is the word"))).toBeNull();
  });
});
