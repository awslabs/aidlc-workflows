// covers: function:takePersonsOwnLine, function:planNamedReply, function:planQuestionChoice,
// function:planSentBesideWaitingRequest, function:planOrWaitingRequestStep
//
// The request a piece of work is recorded with is the person's own words. Live
// on opencode in Spanish: the person typed "/aidlc quiero agregar un modo oscuro
// a la página de la panadería, con un botón ...", the agent passed the words to
// `next` without their accents, and the work's description, its Project line
// and every audit Request kept the agent's copy, while the message record kept
// what they typed. The agent's command still routes as passed; the engine's own
// parse of their /aidlc line says which of its words are the request. Driven
// over the real hook, the real engine and the real creation step.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  resetAidlcEnv,
  runOrchestrateNext,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  auditBlockField,
  getField,
  readAuditShardEvents,
  splitKiroCommandArgs,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { parseNextFlags, requestAsTyped } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-0000000000d1";
const TYPED = "quiero agregar un modo oscuro a la página de la panadería, con un botón para cambiarlo";
const RETYPED = "quiero agregar un modo oscuro a la pagina de la panaderia, con un boton para cambiarlo";

function env(): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
  delete e.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete e.AIDLC_SESSION_OVERRIDE_SOURCE;
  return e;
}

// The words a printed step hands on: the request file its `command` names.
function handedOn(proj: string, message: string | undefined, command: string): string {
  const named = new RegExp(`${command} --request-file (aidlc/\\.aidlc-request-text/[^ \`]+)`).exec(String(message));
  expect(named, String(message)).not.toBeNull();
  return readFileSync(join(proj, ...named![1].split("/")), "utf-8");
}

// What the person types, through the real UserPromptSubmit route every harness uses.
function says(proj: string, prompt: string): void {
  const r = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...env(), CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, r.stderr).toBe(0);
}

function next(proj: string, args: string[]): { kind?: string; message?: string } {
  const r = runOrchestrateNext(ORCHESTRATE, proj, args, { cwd: proj, env: env() });
  expect(r.directive, r.out).not.toBeNull();
  return r.directive as { kind?: string; message?: string };
}

// The creation step `next` hands the agent for a plan the person named, run as
// the agent runs it.
function create(proj: string, step: { message?: string }): void {
  const command = String(step.message).match(/Run `[^`]*?engine (intent create [^`]*)`/)?.[1];
  expect(command, String(step.message)).toBeDefined();
  const args = (command as string).replace("<2-3 word kebab essence>", "the-work").split(" ")
    .map((arg) => arg.replace(/^["'](.*)["']$/, "$1"));
  const r = spawnSync(BUN, [DISPATCHER, "engine", ...args, "--project-dir", proj], {
    cwd: proj, env: env(), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

// Where the work's record keeps its request: the description, the Project line, the audit's Request.
function recorded(proj: string): { description: string; project: string; requests: string[] } {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const dir = readdirSync(intents).find((name) => existsSync(join(intents, name, "project-description.json"))) ?? "";
  return {
    description: JSON.parse(readFileSync(join(intents, dir, "project-description.json"), "utf-8")) as string,
    project: getField(readFileSync(join(intents, dir, "aidlc-state.md"), "utf-8"), "Project") ?? "",
    requests: readAuditShardEvents(proj).map((row) => auditBlockField(row.block, "Request")).filter((value): value is string => value !== null),
  };
}

describe("the request is recorded in the person's own words", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createOrchestrationTestProject();
  });
  afterEach(() => cleanupTestProject(proj));

  test("a request the agent passes retyped, with the plan they named, is recorded as they typed it", () => {
    says(proj, `/aidlc poc ${TYPED}`);
    create(proj, next(proj, ["poc", RETYPED]));
    const record = recorded(proj);
    expect(record.description).toBe(TYPED);
    expect(record.project).toBe(TYPED);
    expect(record.requests.length).toBeGreaterThan(0);
    for (const request of record.requests) expect(request).toBe(`/aidlc ${TYPED}`);
  });

  test("with no plan named, the plan step quotes the person's own words", () => {
    says(proj, `/aidlc ${TYPED}`);
    const step = next(proj, [RETYPED]);
    expect(step.kind).toBe("print");
    expect(step.message).toContain(`The person asked for new work: "${TYPED}"`);
    expect(step.message).not.toContain(RETYPED);
  });

  // #2401, live on Kiro IDE: the person named no plan, and the agent read one
  // from their words and passed its own rewording under it. The plan stays the
  // agent's call; the request is their whole line, not the rewording.
  test("with no plan named, a plan the agent reads routes as passed and the request is their whole line", () => {
    says(proj, `/aidlc I want to build "Northwind Mini Bank", a small demo of a bank's core money handling`);
    create(proj, next(proj, ["--scope", "classic", "--", "Northwind Mini Bank: a small demo of a banks core money handling"]));
    const theirs = `I want to build "Northwind Mini Bank", a small demo of a bank's core money handling`;
    const record = recorded(proj);
    expect(record.description).toBe(theirs);
    expect(record.project).toBe(theirs);
  });

  test("with no plan named, a tail of their words under a plan the agent picked is not the request", () => {
    says(proj, "/aidlc Build a demo bank named Northwind Mini Bank");
    create(proj, next(proj, ["--scope", "classic", "--", "Northwind Mini Bank"]));
    expect(recorded(proj).description).toBe("Build a demo bank named Northwind Mini Bank");
  });

  // The plan's name typed before the task routes on that plan: the request is
  // the rest of the line, as they typed it.
  test("a plan named first, the agent routing on it: the request is the rest of their line", () => {
    says(proj, "/aidlc classic Build a Notes App");
    create(proj, next(proj, ["classic", "build a notes app"]));
    expect(recorded(proj).description).toBe("Build a Notes App");
  });

  // A first word that is also a plan's name, kept in the request by the agent:
  // the whole line is the request, and the reading step carries it as typed.
  test("a plan's name the agent keeps in the request: the reading step carries their whole line", () => {
    says(proj, "/aidlc classic Bike Rental Shop");
    const step = next(proj, ["classic bike rental shop"]);
    expect(handedOn(proj, step.message, "next")).toBe("classic Bike Rental Shop");
    expect(handedOn(proj, step.message, "next --scope classic")).toBe("Bike Rental Shop");
    expect(step.message).not.toContain("bike rental shop");
  });

  test("over work in hand, their line still the latest row: the question that asks where it belongs quotes it", () => {
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    says(proj, `/aidlc ${TYPED}`);
    const step = next(proj, [RETYPED]);
    const id = String(step.message).match(/--request ([0-9a-f]{8})/)?.[1];
    expect(id, String(step.message)).toBeDefined();
    const routing = JSON.stringify(next(proj, ["--request", id as string]));
    expect(routing).toContain(`You said: \\"${TYPED}\\"`);
    expect(routing).not.toContain(RETYPED);
  });

  test("the step that answers the request by its id carries their own words", () => {
    says(proj, `/aidlc ${TYPED}`);
    const step = next(proj, [RETYPED]);
    const id = String(step.message).match(/--request ([0-9a-f]{8})/)?.[1];
    expect(id).toBeDefined();
    const again = next(proj, ["--request", id as string, "--propose", "poc"]);
    expect(JSON.stringify(again)).toContain(TYPED);
  });
});

// Live on Claude Code: the person's request quoted an empty argument, which was
// the bug itself, and the plan question and the work's record dropped the quote
// marks. The request is their line as they typed it, quote marks included.
describe("the request keeps the quote marks the person typed", () => {
  const SLUGIT = `slugit "" prints an empty line, it should print the usage error and exit 2`;
  const SAVE = `fix the "Save" button, it saves nothing`;
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createOrchestrationTestProject();
  });
  afterEach(() => cleanupTestProject(proj));

  test("with no plan named, the plan question quotes their line with its quote marks", () => {
    says(proj, `/aidlc ${SLUGIT}`);
    const step = next(proj, [SLUGIT]);
    expect(step.message).toContain(`The person asked for new work: "${SLUGIT}"`);
    const id = String(step.message).match(/--request ([0-9a-f]{8})/)?.[1];
    expect(id, String(step.message)).toBeDefined();
    const question = next(proj, ["--request", id as string, "--propose", "bugfix"]) as { question?: string };
    expect(question.question, JSON.stringify(question)).toContain(`plan for: "${SLUGIT}"`);
  });

  // Live on opencode: a quoted phrase with a space in it.
  test("with no plan named, a quoted phrase inside the request keeps its quote marks", () => {
    const typed = `parseDuration throws on "1h 30m" (with a space) and on "45s"`;
    says(proj, `/aidlc ${typed}`);
    expect(next(proj, [typed]).message).toContain(`The person asked for new work: "${typed}"`);
  });

  test("with no plan named, the work the agent starts is recorded with their quote marks", () => {
    says(proj, `/aidlc ${SAVE}`);
    create(proj, next(proj, ["--scope", "bugfix", "--", "fix the Save button, it saves nothing"]));
    const record = recorded(proj);
    expect(record.description).toBe(SAVE);
    expect(record.project).toBe(SAVE);
    expect(record.requests.length).toBeGreaterThan(0);
    for (const request of record.requests) expect(request).toBe(`/aidlc ${SAVE}`);
  });

  test("a plan named first, the agent routing on it: the rest of their line keeps its quote marks", () => {
    says(proj, `/aidlc bugfix ${SLUGIT}`);
    create(proj, next(proj, ["bugfix", SLUGIT]));
    expect(recorded(proj).description).toBe(SLUGIT);
  });

  test("a plan named first, a request that ends in an empty argument keeps it", () => {
    const typed = `slugit should reject ""`;
    says(proj, `/aidlc bugfix ${typed}`);
    create(proj, next(proj, ["bugfix", typed]));
    expect(recorded(proj).description).toBe(typed);
  });

  test("a plan's name opening their request, the agent routing on no plan: the whole line keeps an ending empty argument", () => {
    says(proj, `/aidlc bugfix slugit should reject ""`);
    const step = next(proj, [`bugfix slugit should reject ""`]);
    expect(handedOn(proj, step.message, "next")).toBe(`bugfix slugit should reject ""`);
  });

  test("a plan named by its flag: the request keeps its quote marks", () => {
    says(proj, `/aidlc --scope bugfix ${SAVE}`);
    create(proj, next(proj, ["--scope", "bugfix", SAVE]));
    expect(recorded(proj).description).toBe(SAVE);
  });

  test("the agent runs next with nothing: the line it takes keeps its quote marks", () => {
    says(proj, `/aidlc ${SAVE}`);
    expect(next(proj, []).message).toContain(`The person asked for new work: "${SAVE}"`);
  });

  test("the request is the stretch of their line the parse read as it, as typed", () => {
    const cases: Array<[string, string | null]> = [
      [`"" prints an empty line`, `"" prints an empty line`],
      [`slugit prints ""`, `slugit prints ""`],
      [`--plan-approval off ${SAVE}`, SAVE],
      [`${SAVE} --plan-approval off`, SAVE],
      [`-- ${SAVE}`, SAVE],
      [`bugfix: ${SLUGIT}`, SLUGIT],
      [`fix  the\t"Save"\nbutton`, `fix  the\t"Save"\nbutton`],
      [`fix the\r\n\u00a0\u00a0"Save" button`, `fix the\n  "Save" button`],
      // Escapes are the person's characters too.
      [String.raw`say \"hi\" and one\ two`, String.raw`say \"hi\" and one\ two`],
      // One argument is that argument: the quotes around it only made it one.
      [`classic 'fix the "Save" button'`, `fix the "Save" button`],
      // Two stretches spell it: no reading of the line wins.
      ["--scope a a", null],
    ];
    for (const [typed, request] of cases) {
      const said = parseNextFlags(splitKiroCommandArgs(typed)).intent;
      expect(said, typed).toBeDefined();
      expect(requestAsTyped(said as string, typed), typed).toBe(request);
    }
  });
});

describe("the agent's words stay where the line is not the person's request", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createOrchestrationTestProject();
  });
  afterEach(() => cleanupTestProject(proj));

  test("a plain message last, not an /aidlc line", () => {
    says(proj, TYPED);
    const step = next(proj, [RETYPED]);
    expect(step.message).toContain(`The person asked for new work: "${RETYPED}"`);
  });

  test("a line naming another plan than the agent's call", () => {
    says(proj, `/aidlc poc ${TYPED}`);
    create(proj, next(proj, ["bugfix", RETYPED]));
    expect(recorded(proj).description).toBe(RETYPED);
  });

  // A flag they mistyped is not taken by `next`, which hands the agent the
  // correction; the agent's corrected call carries the request without it, and
  // that stays the request, not their line with the mistyped flag in it.
  test("a flag they mistyped, which the agent corrected", () => {
    says(proj, "/aidlc --plan-aprroval off add the export");
    const reading = next(proj, ["--plan-aprroval", "off", "add", "the", "export"]);
    expect(reading.kind, JSON.stringify(reading)).toBe("print");
    const step = next(proj, ["--plan-approval", "off", "add the export"]);
    expect(JSON.stringify(step)).not.toContain("--plan-aprroval");
    expect(step.message).toContain('"add the export"');
  });

  // Over work in hand their line is the request only while their turn is still
  // the record's latest row, as when the agent passes nothing.
  test("over work in hand, a row recorded since their line", () => {
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    says(proj, `/aidlc ${TYPED}`);
    appendAuditEntry("ERROR_LOGGED", { Details: "a row since their line" }, proj);
    const step = next(proj, [RETYPED]);
    const id = String(step.message).match(/--request ([0-9a-f]{8})/)?.[1];
    expect(id, String(step.message)).toBeDefined();
    expect(JSON.stringify(next(proj, ["--request", id as string]))).toContain(RETYPED);
  });
});

// AI-DLC's first command no longer carries the person's words (`next --entry`,
// the Claude Code skill's step 1): the engine reads their typed line from its
// own record. Where it has none (the hooks off, a run nobody attends, a chat
// whose latest message is no `/aidlc` line, no chat at all), only the agent has
// their words, and the step it gets has it hand them over in the request file.
// Whichever way, no command the skill or the engine has the agent run holds a
// word they typed: only the command, flags as typed, and the file's path.
describe("AI-DLC's first command carries none of the person's words", () => {
  const REQUEST = 'Fix the bug where formatPrice(0) returns an empty string instead of "$0.00"';
  const FILE = "aidlc/.aidlc-request-text/request.txt";
  const RUN = "bun .claude/tools/aidlc-orchestrate.ts next";
  const NO_LINE_STEP = "AI-DLC has no copy of what the person typed in this chat. Write the words of their request, " +
    `exactly as they typed them, with your file tool to \`${FILE}\`, then run \`${RUN} --request-file ${FILE}\` and ` +
    "follow what it returns. Only their words go in the file: the plan, command word and flags they typed stay on " +
    "the command, before `--request-file`. When they typed nothing after the entry word, run " +
    `\`${RUN}\` with nothing after it and follow what it returns.`;
  const UNATTENDED = { AIDLC_UNATTENDED: "1" };
  const NO_CHAT = { AIDLC_SESSION_OVERRIDE: undefined };
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createOrchestrationTestProject();
  });
  afterEach(() => cleanupTestProject(proj));

  // The chat's env with `extra` on top; a key set to undefined is not there at all.
  function envWith(extra: Record<string, string | undefined>): Record<string, string | undefined> {
    const e = { ...env(), ...extra };
    for (const [key, value] of Object.entries(extra)) if (value === undefined) delete e[key];
    return e;
  }
  function run(args: string[], extra: Record<string, string | undefined> = {}, at = proj): { kind?: string; message?: string } {
    const r = runOrchestrateNext(ORCHESTRATE, at, args, { cwd: at, env: envWith(extra) });
    expect(r.directive, r.out).not.toBeNull();
    return r.directive as { kind?: string; message?: string };
  }
  function typed(prompt: string, extra: Record<string, string | undefined> = {}, at = proj, chat = SESSION): void {
    const r = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
      cwd: at,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: chat, prompt }),
      env: { ...envWith(extra), CLAUDE_PROJECT_DIR: at, AIDLC_PROJECT_DIR: at },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(r.status, r.stderr).toBe(0);
  }
  // The step followed: their words in the file, what else they typed on the command.
  function handOver(flags: string[], extra: Record<string, string | undefined> = {}): { kind?: string; message?: string } {
    mkdirSync(join(proj, "aidlc", ".aidlc-request-text"), { recursive: true });
    writeFileSync(join(proj, ...FILE.split("/")), REQUEST, "utf-8");
    return run([...flags, "--request-file", FILE], extra);
  }
  // Every command a step names for the agent: each span in backticks of every
  // string it carries that runs AI-DLC's own tool.
  function commands(step: unknown): string[] {
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(step);
    return strings.flatMap((text) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]))
      .filter((span) => /^(?:bun |aidlc )/.test(span));
  }
  function holdsNoneOfTheirWords(step: unknown): void {
    const named = commands(step);
    expect(named.length, JSON.stringify(step)).toBeGreaterThan(0);
    for (const command of named) {
      for (const word of ["formatPrice", "empty string", "$0.00"]) expect(command, JSON.stringify(step)).not.toContain(word);
    }
  }
  const sameStep = (step: unknown): string => JSON.stringify(step).replace(/--request [0-9a-f]{8}/g, "--request <id>");
  const openWork = (): void => seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));

  test("after their typed /aidlc line, it is the bare next, which takes that line", () => {
    typed(`/aidlc ${REQUEST}`);
    const step = run(["--entry"]);
    expect(step.message).toContain(`The person asked for new work: "${REQUEST}"`);
    holdsNoneOfTheirWords(step);
    const bare = createOrchestrationTestProject();
    try {
      typed(`/aidlc ${REQUEST}`, {}, bare);
      expect(sameStep(run([], {}, bare))).toBe(sameStep(step));
    } finally {
      cleanupTestProject(bare);
    }
  });

  test("after their typed /aidlc line over work in hand, it is the bare next, which takes that line", () => {
    openWork();
    typed(`/aidlc ${REQUEST}`);
    const step = run(["--entry"]);
    holdsNoneOfTheirWords(step);
    const bare = createOrchestrationTestProject();
    try {
      seedStateFile(bare, join(FIXTURES_DIR, "state-mid-ideation.md"));
      typed(`/aidlc ${REQUEST}`, {}, bare);
      expect(sameStep(run([], {}, bare))).toBe(sameStep(step));
    } finally {
      cleanupTestProject(bare);
    }
    const kept = String(step.message).match(/next --request ([0-9a-f]{8})/)?.[1];
    expect(JSON.stringify(run(["--request", kept as string]))).toContain(JSON.stringify(REQUEST).slice(1, -1));
  });

  test("after /aidlc alone, it is the bare next", () => {
    typed("/aidlc");
    const step = run(["--entry"]);
    expect(step.message).not.toBe(NO_LINE_STEP);
    const bare = createOrchestrationTestProject();
    try {
      typed("/aidlc", {}, bare);
      expect(sameStep(run([], {}, bare))).toBe(sameStep(step));
    } finally {
      cleanupTestProject(bare);
    }
  });

  // `next` as the agent runs it through the dispatcher, the project's own folder read as <proj>.
  function dispatched(args: string[], extra: Record<string, string | undefined> = {}, at = proj): { kind?: string; message?: string } {
    const r = spawnSync(BUN, [DISPATCHER, "engine", "orchestrate", "next", "--project-dir", at, ...args], {
      cwd: at, env: envWith(extra), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.split(at).join("<proj>")) as { kind?: string; message?: string };
  }
  // The same command in two projects set up alike: `next --entry` with `args` after it in one, `args` alone in the other.
  function enteredAndPassed(
    args: string[], setUp: (at: string) => void, extra: Record<string, string | undefined> = {},
  ): Array<{ kind?: string; message?: string }> {
    const entered = createOrchestrationTestProject();
    const passed = createOrchestrationTestProject();
    try {
      setUp(entered);
      setUp(passed);
      return [dispatched(["--entry", ...args], extra, entered), dispatched(args, extra, passed)];
    } finally {
      cleanupTestProject(entered);
      cleanupTestProject(passed);
    }
  }

  // What the agent puts after `--entry` (their line copied there, a flag of theirs) is not read where their line is
  // on record: the engine reads that line, so each kind gives what the line after next gives.
  const KINDS: Array<[string, string]> = [
    ["words", REQUEST], ["words with a plan flag", `--scope bugfix ${REQUEST}`], ["a flag alone", "--status"],
    ["a flag with a value", "--config trust"], ["a jump", "--stage reverse-engineering"],
    ["a command word", "intent list"], ["a plugin command", "plugin list --json"], ["a plan's name", "bugfix"],
  ];
  for (const work of ["fresh", "over work in hand"] as const) {
    test(`with their line on record, ${work}: what the agent put after it gives what that line after next gives, through the dispatcher`, () => {
      for (const [kind, line] of KINDS) {
        const [entered, passed] = enteredAndPassed(splitKiroCommandArgs(line), (at) => {
          if (work === "over work in hand") seedStateFile(at, join(FIXTURES_DIR, "state-mid-inception.md"));
          typed(`/aidlc ${line}`, {}, at);
        });
        expect(shape(entered), kind).toBe(shape(passed));
      }
    });
  }

  // Their line, not the agent's copy of it: `intent list` on record, the agent quoting it as one token after
  // `--entry` (as an agent did live), which run as passed would be new work called "intent list".
  for (const work of ["fresh", "over work in hand"] as const) {
    test(`with their line on record, ${work}: an agent's copy that reads otherwise is not what runs`, () => {
      const [entered, passed] = enteredAndPassed(["intent list"], (at) => {
        if (work === "over work in hand") seedStateFile(at, join(FIXTURES_DIR, "state-mid-inception.md"));
        typed("/aidlc intent list", {}, at);
      });
      const listed = createOrchestrationTestProject();
      try {
        if (work === "over work in hand") seedStateFile(listed, join(FIXTURES_DIR, "state-mid-inception.md"));
        typed("/aidlc intent list", {}, listed);
        expect(shape(entered)).toBe(shape(dispatched(["intent", "list"], {}, listed)));
      } finally {
        cleanupTestProject(listed);
      }
      expect(shape(entered)).not.toBe(shape(passed));
    });
  }

  // Where no line of theirs is on record, what the agent put after `--entry` is the command, run as it runs without
  // it: the request file it names is read, a status is a status.
  for (const work of ["fresh", "over work in hand"] as const) {
    test(`in a run nobody attends, ${work}: what the agent put after it runs as that command does, the request file read`, () => {
      for (const args of [["--request-file", FILE], ["--scope", "bugfix", "--request-file", FILE], ["--status"], ["--", REQUEST]]) {
        const [entered, passed] = enteredAndPassed(args, (at) => {
          if (work === "over work in hand") seedStateFile(at, join(FIXTURES_DIR, "state-mid-inception.md"));
          mkdirSync(join(at, "aidlc", ".aidlc-request-text"), { recursive: true });
          writeFileSync(join(at, ...FILE.split("/")), REQUEST, "utf-8");
        }, UNATTENDED);
        expect(shape(entered), args.join(" ")).toBe(shape(passed));
        if (work === "fresh" && args[0] === "--request-file") expect(JSON.stringify(entered)).toContain(JSON.stringify(REQUEST).slice(1, -1));
      }
    });
  }

  // Whether a line of theirs is on record is asked without reading the record: reading it brings a record from an
  // older State Version up to date, which a status never does.
  test("a status put after it over a record from an older State Version, a plain message last: the record stays as the status leaves it", () => {
    const path = seededStateFile(proj);
    const older = readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
      .replace(/^- \*\*State Version\*\*: .*$/m, "- **State Version**: 7");
    writeFileSync(path, older, "utf-8");
    typed("please look at the price formatting");
    expect(dispatched(["--entry", "--status"]).message).toStartWith("Run `bun .claude/tools/aidlc.ts engine status`");
    expect(readFileSync(path, "utf-8")).toBe(older);
    expect(readAuditShardEvents(proj).filter((row) => row.event === "STATE_UPGRADED")).toHaveLength(0);
  });

  // The restart line that names the kept request is t-hooks-off-step's, over an installed tree.
  test("with the hooks off, it hands the request file, and the hooks step it leads to holds none of their words", () => {
    const step = run(["--entry"]);
    expect(step).toEqual({ kind: "print", message: NO_LINE_STEP });
    holdsNoneOfTheirWords(step);
    const stopped = handOver([]);
    expect(stopped.message).toStartWith("Do not run AI-DLC's hook scripts yourself");
    holdsNoneOfTheirWords(stopped);
  });

  for (const [state, extra, before] of [
    ["in a run nobody attends", UNATTENDED, (prompt: string) => typed(prompt, UNATTENDED)],
    ["when the skill started with no typed line", {}, (prompt: string) => typed(prompt.replace(/^\/aidlc /, ""))],
    ["with no chat to read", NO_CHAT, (prompt: string) => typed(prompt)],
  ] as const) {
    for (const work of ["fresh", "over work in hand"] as const) {
      test(`${state}, ${work}: it hands the request file, and their words go on from it`, () => {
        if (work === "over work in hand") openWork();
        before(`/aidlc ${REQUEST}`);
        const step = run(["--entry"], extra);
        expect(step).toEqual({ kind: "print", message: NO_LINE_STEP });
        holdsNoneOfTheirWords(step);
        const followed = handOver([], extra);
        holdsNoneOfTheirWords(followed);
        // Over work in hand the engine keeps their words for the question where they belong.
        const kept = String(followed.message).match(/next --request ([0-9a-f]{8})/)?.[1];
        const theirs = work === "fresh" ? followed : run(["--request", kept as string], extra);
        expect(JSON.stringify(theirs)).toContain(JSON.stringify(REQUEST).slice(1, -1));
        holdsNoneOfTheirWords(theirs);
      });
    }
  }

  test("a flag they typed beside their words stays on the command, and only their words are in the file", () => {
    typed(`/aidlc --scope bugfix ${REQUEST}`, UNATTENDED);
    expect(run(["--entry"], UNATTENDED)).toEqual({ kind: "print", message: NO_LINE_STEP });
    const created = handOver(["--scope", "bugfix"], UNATTENDED);
    expect(created.message).toContain("intent create --scope bugfix --request ");
    holdsNoneOfTheirWords(created);
  });

  // A reply typed in plain chat while AI-DLC waits on a question that reads the words as they were passed: the
  // engine hands it on from its record as the one argument the agent would have passed, so it meets what those words
  // meet, never a new request made of the reply.
  const OTHER_CHAT = "01995000-7a11-7000-8000-0000000000d2";
  const THIRD_CHAT = "01995000-7a11-7000-8000-0000000000d3";
  // The record keeps whole seconds, and no person replies within the second they typed their line, so the reply
  // lands in a later one.
  function laterSecond(): void {
    const second = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === second) Bun.sleepSync(25);
  }
  type PlanQuestion = { kind?: string; scope_commands?: Array<{ scope: string; command: string }> };
  // The plan question for their request, proposing `plan` (`compose`: the tailored-plan offer), with `settings`
  // typed before the request.
  function planQuestionOpen(settings = "", plan = "bugfix"): PlanQuestion {
    typed(`/aidlc ${settings}${REQUEST}`);
    const id = String(run([]).message).match(/--request ([0-9a-f]{8})/)?.[1];
    const ask = run(["--propose", plan, "--request", id as string]);
    expect(ask.kind).toBe("ask");
    laterSecond();
    return ask as PlanQuestion;
  }
  // The arguments of the command the plan question gave for `plan`.
  function choiceFor(ask: PlanQuestion, plan: string): string[] {
    const command = ask.scope_commands?.find((row) => row.scope === plan)?.command;
    expect(command, JSON.stringify(ask)).toBeDefined();
    return (command as string).replace(`${RUN} `, "").split(" ");
  }
  // What the step of that command gives where a plan's name took the reply: the same, and the request it starts,
  // handed to an agent that may never have seen the question, to name the work and say which request it started.
  function startedBy(ask: PlanQuestion, plan: string, extra: Record<string, string | undefined> = {}): { kind?: string; message?: string } {
    const own = run(choiceFor(ask, plan), extra);
    expect(own.message).toContain(" Replace `--label`");
    const starts = ` This starts the request the plan question asked about: "${REQUEST}". Say in your own words which request it starts.`;
    return { ...own, message: String(own.message).replace(" Replace `--label`", `${starts} Replace \`--label\``) };
  }
  // The plan question for their request asked as separate new work beside the work in hand (the routing question's
  // separate-work answer, then the plan proposed), in a later second than anything before it.
  function newWorkPlanQuestion(): PlanQuestion {
    typed(`/aidlc ${REQUEST}`);
    const kept = String(run([]).message).match(/next --request ([0-9a-f]{8})/)?.[1];
    const routing = run(["--request", kept as string]) as { choices?: Array<{ label: string; command?: string }> };
    const separate = routing.choices?.find((choice) => choice.label === "Separate new piece of work")?.command;
    expect(separate, JSON.stringify(routing)).toBeDefined();
    laterSecond();
    typed("2");
    const id = String(run((separate as string).replace(`${RUN} `, "").split(" ")).message).match(/--propose <plan> --request ([0-9a-f]{8})/)?.[1];
    // The agent proposes in a later second than the routing answer, as a live run does.
    laterSecond();
    const ask = run(["--propose", "bugfix", "--request", id as string]) as PlanQuestion;
    expect(ask.kind).toBe("ask");
    laterSecond();
    return ask;
  }
  // The work in hand's own stage question, asked now: the stage started and its question logged.
  function stageQuestionOpen(): void {
    appendAuditEntry("STAGE_STARTED", { Stage: "feasibility" }, proj);
    const asked = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-log.ts"), "decision", "--stage", "feasibility",
      "--decision", "Which shape should the first cut take?", "--options", "poc,mvp", "--project-dir", proj], {
      cwd: proj, env: envWith({}), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(asked.status, `${asked.stdout}${asked.stderr}`).toBe(0);
    laterSecond();
  }
  function routingQuestionOpen(): void {
    openWork();
    typed(`/aidlc ${REQUEST}`);
    const id = String(run([]).message).match(/next --request ([0-9a-f]{8})/)?.[1];
    expect(JSON.stringify(run(["--request", id as string]))).toContain("You said:");
    laterSecond();
  }
  // Work another chat started, two pieces by default, none selected in this one.
  function workHereNotSelected(labels = ["price fix", "tax rounding"]): void {
    removeWorkspaceRecord(proj);
    for (const label of labels) {
      const r = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "intent-create", "--scope", "bugfix",
        "--label", label, "--arguments", `fix the ${label}`, "--project-dir", proj], {
        cwd: proj, env: envWith({ AIDLC_SESSION_OVERRIDE: OTHER_CHAT }), encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    }
    rmSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), { force: true });
    laterSecond();
  }

  test("a plain reply while the plan question waits goes to that question, with its own commands", () => {
    planQuestionOpen();
    typed("Go ahead");
    const step = run(["--entry"]);
    expect(step.message).toStartWith("The person has not answered the plan question they were asked about");
    expect(handedOn(proj, step.message, "next")).toBe("Go ahead");
    holdsNoneOfTheirWords(step);
    for (const command of commands(step)) expect(command).not.toContain("Go ahead");
  });

  test("a plain reply while the routing question waits goes to that question, with its own commands", () => {
    routingQuestionOpen();
    typed("2");
    const step = run(["--entry"]);
    expect(step.message).toStartWith("The person has not answered the question about where their words belong");
    expect(handedOn(proj, step.message, "next")).toBe("2");
    holdsNoneOfTheirWords(step);
  });

  test("a plain message with work here and none selected gets the reading that comes before any question", () => {
    workHereNotSelected();
    typed(REQUEST);
    const step = run(["--entry"]);
    expect(step.kind, JSON.stringify(step).slice(0, 300)).toBe("print");
    expect(step.message).toContain("and none is selected in this chat. Read the person's words.");
    holdsNoneOfTheirWords(step);
    const kept = String(step.message).match(/next --request ([0-9a-f]{8})/)?.[1];
    expect(JSON.stringify(run(["--request", kept as string]))).toContain(JSON.stringify(REQUEST).slice(1, -1));
  });

  // A plan's name alone is the plan question's answer: it starts the request that question asked about, on that
  // plan, as the question's own command for it does, and nobody is asked what to work on.
  for (const plan of ["bugfix", "express"]) {
    test(`${plan} alone as the reply while the plan question waits starts its request on ${plan}, as that choice's command does`, () => {
      const ask = planQuestionOpen();
      typed(plan);
      const step = run(["--entry"]);
      expect(step).toEqual(startedBy(ask, plan));
      expect(step.message).toContain(`intent create --scope ${plan} --request `);
      holdsNoneOfTheirWords(step);
      create(proj, step);
      expect(recorded(proj).description).toBe(REQUEST);
    });
  }

  test("a plan's name alone as the reply from a second chat starts the request the question asked about, and the step names it", () => {
    const ask = planQuestionOpen();
    const second = { AIDLC_SESSION_OVERRIDE: OTHER_CHAT };
    typed("feature", second, proj, OTHER_CHAT);
    const step = run(["--entry"], second);
    expect(step).toEqual(startedBy(ask, "feature", second));
    expect(step.message).toContain(`This starts the request the plan question asked about: "${REQUEST}".`);
    create(proj, step);
    expect(recorded(proj).description).toBe(REQUEST);
  });

  // The settings ride every plan; a stage change only the plans that have that stage, as their rows carry it.
  for (const [plan, takes] of [["feature", true], ["bugfix", false]] as const) {
    test(`${plan} alone as the reply carries what its row carries of the settings and stage changes typed with the request`, () => {
      const ask = planQuestionOpen("--depth minimal --skip market-research ");
      typed(plan);
      const step = run(["--entry"]);
      expect(step).toEqual(startedBy(ask, plan));
      expect(step.message).toContain("--depth minimal");
      expect(String(step.message).includes("--skip market-research")).toBe(takes);
    });
  }

  test("a plan's name alone as the reply to the tailored-plan offer starts the request on that plan", () => {
    const ask = planQuestionOpen("", "compose");
    typed("bugfix");
    expect(run(["--entry"])).toEqual(startedBy(ask, "bugfix"));
  });

  test("a plan's name alone as the reply to the plan question for new work beside work in hand starts that new work", () => {
    openWork();
    const ask = newWorkPlanQuestion();
    typed("express");
    const step = run(["--entry"]);
    expect(step).toEqual(startedBy(ask, "express"));
    expect(step.message).toContain("intent create --scope express --request ");
  });

  // The plan question asked after the work's own question is the one on top: the plan's name typed from a new chat
  // answers it, whether the work waits at its approval or on its stage's question.
  test("a plan's name alone from a new chat, the plan question asked while the work waits at its approval, starts that new work", () => {
    openWork();
    const path = seededStateFile(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace("- [-] feasibility", "- [?] feasibility"), "utf-8");
    appendAuditEntry("STAGE_STARTED", { Stage: "feasibility" }, proj);
    appendAuditEntry("STAGE_AWAITING_APPROVAL", { Stage: "feasibility" }, proj);
    laterSecond();
    const ask = newWorkPlanQuestion();
    const second = { AIDLC_SESSION_OVERRIDE: OTHER_CHAT };
    typed("express", second, proj, OTHER_CHAT);
    const step = run(["--entry"], second);
    expect(step).toEqual(startedBy(ask, "express", second));
    expect(step.message).toContain("intent create --scope express --request ");
  });

  test("a plan's name alone from a new chat, the plan question asked after the work's own stage question, starts that new work", () => {
    openWork();
    stageQuestionOpen();
    const ask = newWorkPlanQuestion();
    const second = { AIDLC_SESSION_OVERRIDE: OTHER_CHAT };
    typed("poc", second, proj, OTHER_CHAT);
    const step = run(["--entry"], second);
    expect(step).toEqual(startedBy(ask, "poc", second));
    expect(step.message).toContain("intent create --scope poc --request ");
  });

  test("a plan's name alone from a new chat, the plan question asked beside finished work, starts that new work", () => {
    seedStateFile(proj, join(FIXTURES_DIR, "state-completed.md"));
    typed(`/aidlc ${REQUEST}`);
    const id = String(run(["--entry"]).message).match(/--propose <plan> --request ([0-9a-f]{8})/)?.[1];
    expect(id).toBeDefined();
    laterSecond();
    const ask = run(["--propose", "bugfix", "--request", id as string]) as PlanQuestion;
    expect(ask.kind).toBe("ask");
    laterSecond();
    const second = { AIDLC_SESSION_OVERRIDE: OTHER_CHAT };
    typed("express", second, proj, OTHER_CHAT);
    const step = run(["--entry"], second);
    expect(step).toEqual(startedBy(ask, "express", second));
    expect(step.message).toContain("intent create --scope express --request ");
  });

  test("a plan's name typed before the plan question was asked meets what that choice's command meets", () => {
    typed(`/aidlc ${REQUEST}`);
    const id = String(run([]).message).match(/--request ([0-9a-f]{8})/)?.[1];
    laterSecond();
    typed("bugfix");
    laterSecond();
    const ask = run(["--propose", "bugfix", "--request", id as string]) as PlanQuestion;
    const step = run(["--entry"]);
    expect(step).toEqual(run(choiceFor(ask, "bugfix")));
    expect(step.message).toStartWith("Nothing was started: the person has not answered the plan question yet");
  });

  // Where the line is not the plan question's answer by its shape alone, or which question it answers cannot be told,
  // it reaches `next` as the arguments it came as, and planNamedReply takes no part: the agent's own `next <plan>`, an
  // /aidlc line of it, a plan's name and more words, an older request's plan question still kept, a routing question
  // open, a question the work asked after the plan question.
  test("the agent passing a plan's name, or an /aidlc line of it, while the plan question waits still asks what the work is for", () => {
    planQuestionOpen();
    typed("bugfix");
    expect(run(["bugfix"]).message).toStartWith("The person picked the `bugfix` plan");
    laterSecond();
    typed("/aidlc bugfix");
    expect(run(["--entry"]).message).toStartWith("The person picked the `bugfix` plan");
  });

  test("a plan's name and more words as the reply while the plan question waits gets the step that reads both ways", () => {
    planQuestionOpen();
    typed("bugfix please");
    expect(run(["--entry"]).message).toStartWith("`bugfix` is the name of a plan and also the first word of what the person typed");
  });

  test("a plan's name alone while an older request's plan question is still kept picks neither request", () => {
    planQuestionOpen();
    typed("/aidlc add a shout option that prints the greeting in capitals");
    const newer = run(["--entry"]);
    const other = String(newer.message).match(/next (--request-file \S+?)`/)?.[1];
    expect(other, String(newer.message)).toBeDefined();
    const id = String(run((other as string).split(" ")).message).match(/--request ([0-9a-f]{8})/)?.[1];
    expect(run(["--propose", "bugfix", "--request", id as string]).kind).toBe("ask");
    laterSecond();
    typed("bugfix");
    expect(run(["--entry"]).message).toStartWith("The person picked the `bugfix` plan");
  });

  test("a plan's name alone while a question the work asked after the plan question waits gets what that name passed by the agent gets", () => {
    openWork();
    newWorkPlanQuestion();
    stageQuestionOpen();
    const second = { AIDLC_SESSION_OVERRIDE: OTHER_CHAT };
    typed("poc", second, proj, OTHER_CHAT);
    const step = run(["--entry"], second);
    expect(JSON.stringify(step)).not.toContain("intent create");
    expect(sameStep(step)).toBe(sameStep(run(["poc"], second)));
  });

  test("a plan's name alone while the routing question waits gets what that name passed by the agent gets", () => {
    routingQuestionOpen();
    typed("bugfix");
    const step = run(["--entry"]);
    expect(JSON.stringify(step)).not.toContain("intent create");
    expect(sameStep(step)).toBe(sameStep(run(["bugfix"])));
  });

  // With no work selected, a new chat is asked which work to carry on, by the work's names. A plan's name that is
  // also one of those names answers either question, so it goes on as passed; any other plan's name answers the plan
  // question.
  for (const [reply, picks] of [["security-patch", true], ["express", false]] as const) {
    test(`${reply} alone from a new chat shown the work to pick, ${picks ? "the name of listed work" : "naming no listed work"}, while another chat's plan question waits ${picks ? "gets what that name passed by the agent gets" : "starts that request"}`, () => {
      workHereNotSelected(["security patch", "tax rounding"]);
      const ask = newWorkPlanQuestion();
      const third = { AIDLC_SESSION_OVERRIDE: THIRD_CHAT };
      typed("/aidlc", third, proj, THIRD_CHAT);
      expect(JSON.stringify(run(["--entry"], third))).toContain("Pick one to carry on.");
      laterSecond();
      typed(reply, third, proj, THIRD_CHAT);
      const step = run(["--entry"], third);
      if (picks) {
        expect(JSON.stringify(step)).not.toContain("intent create");
        expect(sameStep(step)).toBe(sameStep(run([reply], third)));
      } else {
        expect(step).toEqual(startedBy(ask, reply, third));
      }
    });
  }

  // A plan's name the agent sends as a switch while the plan question for separate new work is the question on top of
  // the work in hand may pick the plan for that request or ask for the work to move: the agent gets one step that
  // reads which, with that question's own command for the plan and the switch, and the work keeps its plan until one
  // of them runs. A --scope typed on the person's own line, and one sent with no plan question on top, switch at once.
  const SWITCH = "Run `bun .claude/tools/aidlc.ts engine scope change --scope express` to change scope";
  const WORK = "Test widget feature for e-commerce platform";
  function readsWhich(ask: PlanQuestion): { kind: string; message: string } {
    return {
      kind: "print",
      message: `This command names the \`express\` plan for the work on "${WORK}" (on the \`feature\` plan), while the ` +
        `person's separate request "${REQUEST}" still waits for its plan: a plan's name here may pick the plan for that ` +
        "request or ask for this work to move. Read what they meant. To start that request on the `express` plan, run " +
        `\`${RUN} ${choiceFor(ask, "express").join(" ")}\` and follow what it returns. For the work on "${WORK}" to move ` +
        `to the \`express\` plan, run \`${RUN} --scope express\` again: it now moves the work; follow what it returns. ` +
        "If you cannot tell which they meant, ask them once in plain words, then run the command for their answer.",
    };
  }
  const scopeNow = (): string => getField(readFileSync(seededStateFile(proj), "utf-8"), "Scope") ?? "";
  const SECOND = { AIDLC_SESSION_OVERRIDE: OTHER_CHAT };

  test("a plan's name the agent sends as a switch while the plan question for new work waits gets the step that reads which, and the work keeps its plan", () => {
    openWork();
    const ask = newWorkPlanQuestion();
    typed("express", SECOND, proj, OTHER_CHAT);
    expect(run(["--scope", "express"], SECOND)).toEqual(readsWhich(ask));
    expect(scopeNow()).toBe("feature");
    // The request's own command starts that request; the switch, sent again, switches without the step.
    expect(run(choiceFor(ask, "express"), SECOND).message).toContain("intent create --scope express --request ");
    expect(run(["--scope", "express"], SECOND).message).toStartWith(SWITCH);
  });

  test("after the person answers the agent's one question, the switch sent again gets the step once more, then switches", () => {
    openWork();
    const ask = newWorkPlanQuestion();
    typed("express", SECOND, proj, OTHER_CHAT);
    expect(run(["--scope", "express"], SECOND)).toEqual(readsWhich(ask));
    laterSecond();
    typed("move the widget work to express", SECOND, proj, OTHER_CHAT);
    expect(run(["--scope", "express"], SECOND)).toEqual(readsWhich(ask));
    expect(run(["--scope", "express"], SECOND).message).toStartWith(SWITCH);
  });

  test("a plan's name the agent sends as a switch over finished work while the plan question for new work waits gets the step that reads which", () => {
    seedStateFile(proj, join(FIXTURES_DIR, "state-completed.md"));
    typed(`/aidlc ${REQUEST}`);
    const id = String(run(["--entry"]).message).match(/--propose <plan> --request ([0-9a-f]{8})/)?.[1];
    expect(id).toBeDefined();
    laterSecond();
    const ask = run(["--propose", "bugfix", "--request", id as string]) as PlanQuestion;
    expect(ask.kind).toBe("ask");
    laterSecond();
    typed("express", SECOND, proj, OTHER_CHAT);
    expect(run(["--scope", "express"], SECOND)).toEqual(readsWhich(ask));
  });

  // Their own line: /aidlc --scope, run as the first command or sent by the agent itself; and the plan's name on
  // their /aidlc line, which the record keeps as the same plan.
  for (const [line, first] of [["/aidlc --scope express", ["--entry"]], ["/aidlc --scope express", ["--scope", "express"]], ["/aidlc express", ["--scope", "express"]]] as const) {
    test(`their own ${line} while the plan question for new work waits switches at once (next ${first.join(" ")})`, () => {
      openWork();
      newWorkPlanQuestion();
      typed(line, SECOND, proj, OTHER_CHAT);
      expect(run([...first], SECOND).message).toStartWith(SWITCH);
    });
  }

  test("a plan's name the agent sends with a setting while the plan question for new work waits switches at once, with the setting", () => {
    openWork();
    newWorkPlanQuestion();
    typed("express", SECOND, proj, OTHER_CHAT);
    expect(run(["--scope", "express", "--depth", "minimal"], SECOND).message).toContain("engine scope change --scope express --depth minimal");
  });

  test("a plan's name the agent sends as a switch with no plan question on top, or after the work's own question, switches at once", () => {
    openWork();
    typed("express");
    expect(run(["--scope", "express"]).message).toStartWith(SWITCH);
    newWorkPlanQuestion();
    stageQuestionOpen();
    typed("express", SECOND, proj, OTHER_CHAT);
    expect(run(["--scope", "express"], SECOND).message).toStartWith(SWITCH);
  });

  test("a plan's name the agent passes alone while the plan question for new work waits keeps the step that reads it", () => {
    openWork();
    newWorkPlanQuestion();
    typed("express", SECOND, proj, OTHER_CHAT);
    expect(run(["express"], SECOND).message).toStartWith("The person typed the name of the `express` plan with no words about the work");
  });

  // Only a reply AI-DLC holds whole goes on: a reply the record cut keeps the step, where the agent writes it.
  test("a plain reply past the record's length while the plan question waits keeps the step", () => {
    planQuestionOpen();
    typed(`Go ahead, and ${"keep the receipt layout as it is. ".repeat(300)}`);
    expect(run(["--entry"])).toEqual({ kind: "print", message: NO_LINE_STEP });
  });

  // A line of tokens alone (a flag, a verb, a plan's name, a setting, a jump): the record keeps no words for it, and
  // the first command runs it as the agent passing it after next did, fresh and over work in hand.
  const shape = (step: { kind?: string; stage?: unknown; narration?: unknown; message?: string; question?: unknown }) =>
    sameStep({ kind: step.kind, stage: step.stage, narration: step.narration, message: step.message, question: step.question });
  const ALONE: Array<[string, string[]]> = [
    ["--status", ["--status"]], ["intent list", ["intent", "list"]], ["bugfix", ["bugfix"]],
    ["--plan-approval off", ["--plan-approval", "off"]], ["--stage reverse-engineering", ["--stage", "reverse-engineering"]],
  ];
  for (const [line, argv] of ALONE) {
    for (const work of ["fresh", "over work in hand"] as const) {
      test(`/aidlc ${line}, ${work}: the first command gives what that line after next gives`, () => {
        const passed = createOrchestrationTestProject();
        try {
          if (work === "over work in hand") {
            seedStateFile(proj, join(FIXTURES_DIR, "state-mid-inception.md"));
            seedStateFile(passed, join(FIXTURES_DIR, "state-mid-inception.md"));
          }
          typed(`/aidlc ${line}`);
          typed(`/aidlc ${line}`, {}, passed);
          expect(shape(run(["--entry"]))).toBe(shape(run(argv, {}, passed)));
        } finally {
          cleanupTestProject(passed);
        }
      });
    }
  }

  // Over finished work the human-turn hook writes no turn row in the record, so a jump, a plan, a setting or plain
  // words typed there run as the agent passing them after next did, and a status as it does.
  const FINISHED: Array<[string, string[]]> = [
    ["--stage code-generation", ["--stage", "code-generation"]], ["--scope bugfix", ["--scope", "bugfix"]],
    ["--plan-approval off", ["--plan-approval", "off"]], ["--status", ["--status"]],
    ["also add a note about rounding to the README", ["also add a note about rounding to the README"]],
  ];
  for (const [line, argv] of FINISHED) {
    test(`/aidlc ${line} over finished work: the first command gives what that line after next gives`, () => {
      const passed = createOrchestrationTestProject();
      try {
        seedStateFile(proj, join(FIXTURES_DIR, "state-completed.md"));
        seedStateFile(passed, join(FIXTURES_DIR, "state-completed.md"));
        typed(`/aidlc ${line}`);
        typed(`/aidlc ${line}`, {}, passed);
        const step = run(["--entry"]);
        expect(step.kind).not.toBe("done");
        expect(shape(step)).toBe(shape(run(argv, {}, passed)));
      } finally {
        cleanupTestProject(passed);
      }
    });
  }

  // Their words over finished work are taken once: the mark is the only bound there, so a later first command before
  // their next message answers as a bare next does.
  test("plain words over finished work: taken once, then a later first command answers that the work is done", () => {
    seedStateFile(proj, join(FIXTURES_DIR, "state-completed.md"));
    typed("/aidlc also add a note about rounding to the README");
    expect(run(["--entry"]).kind).not.toBe("done");
    expect(run(["--entry"]).kind).toBe("done");
  });

  // A paste too long to keep whole, over finished work: the step for it writes the mark itself, so both of its ways
  // go ahead from the part AI-DLC kept, as they do over work in hand, and the person is told.
  const PASTE = "keep the receipt layout as it is and ".repeat(4000).trim();
  for (const way of ["their words in the request file", "next again"] as const) {
    test(`a paste too long to keep whole over finished work: ${way} goes ahead from the part kept`, () => {
      seedStateFile(proj, join(FIXTURES_DIR, "state-completed.md"));
      typed(`/aidlc ${PASTE}`);
      expect(run(["--entry"]).message).toContain("the work goes ahead from the part AI-DLC kept");
      let step: { kind?: string; message?: string };
      if (way === "next again") {
        step = run([]);
      } else {
        mkdirSync(join(proj, "aidlc", ".aidlc-request-text"), { recursive: true });
        writeFileSync(join(proj, ...FILE.split("/")), PASTE, "utf-8");
        step = run(["--request-file", FILE]);
      }
      expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("print");
      expect(step.message).toContain("is finished");
      expect(JSON.stringify(step)).toContain("AI-DLC kept only the first");
    });
  }

  // With no work yet no row follows their turn, so the handed-out mark alone keeps a later first command from picking
  // the plan again.
  test("/aidlc bugfix, fresh: the plan once, then a later first command goes on as a bare next does", () => {
    typed("/aidlc bugfix");
    const first = run(["--entry"]);
    const again = run(["--entry"]);
    expect(shape(again)).not.toBe(shape(first));
    expect(shape(again)).toBe(shape(run([])));
  });

  // Read before anything reads the command: a status asked over work in hand leaves a record git left conflicted as
  // the status does, untouched.
  test("/aidlc --status over a conflicted record of work in hand: the first command leaves the record as the status does", () => {
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-inception.md"));
    const path = seededStateFile(proj);
    const conflicted = readFileSync(path, "utf-8").replace(
      /^(- \*\*Current Stage\*\*: .*)$/m, "<<<<<<< ours\n$1\n=======\n$1\n>>>>>>> theirs",
    );
    writeFileSync(path, conflicted, "utf-8");
    typed("/aidlc --status");
    expect(run(["--entry"]).message).toStartWith("Run `bun .claude/tools/aidlc.ts engine status`");
    expect(readFileSync(path, "utf-8")).toBe(conflicted);
  });

  // A line that changes the work is taken once: a later first command before their next message (the loop's step 1
  // again, a restart after the host compacted the chat) goes on from where the work now stands.
  test("/aidlc --stage reverse-engineering over work in hand: the jump once, then the work where it stands", () => {
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-inception.md"));
    typed("/aidlc --stage reverse-engineering");
    expect((run(["--entry"]) as { stage?: string }).stage).toBe("reverse-engineering");
    const again = run(["--entry"]);
    expect(shape(again)).toBe(shape(run([])));
    expect(readAuditShardEvents(proj).filter((row) => row.event === "STAGE_JUMPED")).toHaveLength(1);
  });

  test("a later bare next in the loop is as it was: with no typed line, it names the ways to start", () => {
    typed(REQUEST);
    expect(run([]).message).toStartWith("No workflow state found (no active intent).");
  });
});
