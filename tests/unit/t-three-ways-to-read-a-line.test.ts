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
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  followProposal,
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
  // The agent's proposal step follows the plan proposal print, as it does live.
  const options = { env: env(proj) };
  const result = followProposal(runOrchestrateNext(ORCHESTRATE, proj, args, options), ORCHESTRATE, proj, options);
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
    // The request the words were kept under (the agent's proposal step) and the
    // plan question derived from it.
    expect(questions(proj).length).toBe(2);
    const offerId = /--request ([0-9a-f]{8})/.exec(String(offer.d.compose_command))?.[1];
    expect(offerId, offer.out).toBeDefined();

    const answered = next(proj, splitKiroCommandArgs(reply));
    // Not the same offer again, and never an offer about their reply.
    expect(String(answered.d.question ?? ""), answered.out).not.toContain(reply);
    expect(answered.d.kind, answered.out).toBe("print");
    expect(answered.d.narration, answered.out).toBeUndefined();
    // It carries that question's own commands, by its id.
    expect(String(answered.d.message)).toContain(offerId!);
    // And nothing new was asked of them.
    expect(questions(proj).length).toBe(2);
    cleanupTestProject(created.pop());
  });

  test("their yes after a named-plan offer carries that offer's confirm command", () => {
    const proj = emptyProject();
    const offer = next(proj, ["fix the login crash when the session expires"]);
    expect(offer.d.ask_type, offer.out).toBe("scope-confirm");
    const offerId = /--request ([0-9a-f]{8})/.exec(String(offer.d.confirm_command))?.[1];
    expect(offerId, offer.out).toBeDefined();
    const answered = next(proj, ["yes"]);
    expect(answered.d.kind, answered.out).toBe("print");
    expect(String(answered.d.message)).toContain(offerId!);
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
// A plan's name typed first is the person's pick of it, however many words
// follow (Arden 2026-10-12: the two-word cutoff is gone)
// ---------------------------------------------------------------------------

describe("a plan word at the start of their sentence", () => {
  test("with words after it, that plan acts for those words, and nothing is asked of them", () => {
    const proj = emptyProject();
    const { d, out } = next(proj, ["bugfix", "Fix", "duplicate", "todos"]);
    expect(d.kind, out).toBe("print");
    expect(d.ask_type, out).toBeUndefined();
    // The creation print for the plan they named; their words travel by request id.
    expect(String(d.message)).toContain("intent create --scope bugfix --request");
    expect(questions(proj).map((q) => q.text)).toEqual(["Fix duplicate todos"]);
    // Nothing is created by the print itself.
    expect(activeIntent(proj)).toBe("");
  });

  test("a plan's name first is their pick; the delimiter marks the first word as theirs", () => {
    const proj = emptyProject();
    const { d, out } = next(proj, ["classic", "car", "rental", "website"]);
    expect(d.kind, out).toBe("print");
    expect(String(d.message)).toContain("intent create --scope classic --request");
    expect(questions(proj).map((q) => q.text)).toEqual(["car rental website"]);
    // Marked as theirs, every word stays their request and no plan is picked.
    const asked = next(proj, ["--", "classic car rental website"]);
    expect(asked.d.kind, asked.out).toBe("ask");
    expect(String(asked.d.question)).toContain("classic car rental website");
  });

  test("a plan word alone still acts, and so does the colon form", () => {
    // A plan word alone acts: the engine's own way of acting on it is the print
    // that names the creation command for that plan, never a reading step.
    const alone = next(emptyProject(), ["bugfix"]);
    expect(String(alone.d.message), alone.out).toContain("--scope bugfix");
    expect(parseNextFlags(["bugfix"]).readingStep, alone.out).toBeUndefined();
    expect(parseNextFlags(["bugfix"]).positionalScope).toBe("bugfix");
    const colon = parseNextFlags(["bugfix:", "Fix duplicate todos"]);
    expect(colon.positionalScope).toBe("bugfix");
    expect(colon.intent).toBe("Fix duplicate todos");
    expect(colon.readingStep).toBeUndefined();
  });

  test("the three ways a harness hands that line over read the same", () => {
    // Arden 2026-10-12: the plan's name first is the pick and the words after
    // it the request, split into tokens, quoted whole (Kiro IDE's PowerShell),
    // or the plan in its own argument with the request in one more.
    const line = "classic car rental website";
    const split = splitKiroCommandArgs(line);
    for (const argv of [split, [line], ["classic", "car rental website"]]) {
      const parsed = parseNextFlags([...argv]);
      expect(parsed.readingStep, JSON.stringify(argv)).toBeUndefined();
      expect(parsed.positionalScope, JSON.stringify(argv)).toBe("classic");
      expect(parsed.intent, JSON.stringify(argv)).toBe("car rental website");
      // No seam runs it as a command or a read-only mode, in any form.
      expect(classifyTerminalCommand([...argv]), JSON.stringify(argv)).toBeNull();
      expect(isReadOnlyNextArgv(argv), JSON.stringify(argv)).toBe(false);
    }
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
// A step that names commands for someone to run never puts the person's own
// text in one as bare shell syntax
// ---------------------------------------------------------------------------

describe("their own words in a command the step names are one quoted argument", () => {
  const shellish = [
    "classic car rental; rm -rf /tmp/aidlc-should-not-run",
    "classic rental `whoami` site",
    "classic rental $(id) site",
    "bugfix fix the \"login\" crash && echo no",
  ];
  test.each(shellish)("%j: the plan acts, and the words travel by request id, never inside a command", (line) => {
    const proj = emptyProject();
    const argv = splitKiroCommandArgs(line);
    const words = argv.slice(1).join(" ");
    const { d, out } = next(proj, argv);
    expect(d.kind, out).toBe("print");
    const message = String(d.message);
    // The creation print for the plan they named carries their request by id:
    // no separator, substitution or redirection of theirs is syntax in it.
    expect(message, out).toContain(`intent create --scope ${argv[0]} --request`);
    expect(message, out).not.toContain(words);
    // Their words are kept whole, and nothing ran.
    expect(questions(proj).map((q) => q.text)).toEqual([words]);
    expect(activeIntent(proj)).toBe("");
    cleanupTestProject(created.pop());
  });

  test("a reply while the plan question is open quotes their words too", () => {
    const proj = emptyProject();
    expect(next(proj, ["build a small notes app for my team"]).d.ask_type).toBe("compose-offer");
    const { d, out } = next(proj, splitKiroCommandArgs("yes; rm -rf /tmp/aidlc-should-not-run"));
    expect(d.kind, out).toBe("print");
    expect(String(d.message)).toContain("-- 'yes; rm -rf /tmp/aidlc-should-not-run'");
  });
});

// ---------------------------------------------------------------------------
// Two chats, two questions: a reply never answers the one the person
// cannot see
// ---------------------------------------------------------------------------

describe("a reply reaches no question but the one in front of them", () => {
  test("with a question open in another chat too, their words stay their request", () => {
    const proj = emptyProject();
    // The first chat's offer, then a second chat's offer for its own request.
    const first = next(proj, ["build a small notes app for my team"]);
    expect(first.d.ask_type, first.out).toBe("compose-offer");
    // The second chat names a plan, which is a line this engine reads exactly,
    // so it gets its own question however many are already open.
    const second = runOrchestrateNext(ORCHESTRATE, proj, ["--scope", "poc", "build the CSV export"], {
      env: { ...env(proj), AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-000000001b02" },
    });
    // The first chat's proposal step and the plan question derived from it, then the second chat's own question.
    const asked = questions(proj);
    expect(asked.length, second.out).toBe(3);

    // A reply in the first chat must not carry the second question's id, and
    // must not start or compose the work that question asked about.
    const answered = next(proj, ["yes"]);
    const message = String(answered.d.message ?? "");
    const question = String(answered.d.question ?? "");
    expect(answered.d.kind, answered.out).toBe("print");
    for (const stored of asked) {
      expect(message, `named ${stored.id}`).not.toContain(stored.id);
    }
    // It says which it cannot tell, and points at the question the agent itself
    // asked, so their reply still reaches that one and nothing starts here.
    expect(message).toContain("as that question still stands in your own chat");
    expect(`${message}${question}`).not.toContain("CSV export");
    expect(activeIntent(proj)).toBe("");
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
