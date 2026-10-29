// covers: function:takePersonsOwnLine
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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  runOrchestrateNext,
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
    .map((arg) => arg.replace(/^"(.*)"$/, "$1"));
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
    // Quoted for the platform's shell: single quotes on POSIX, double on Windows.
    expect(step.message).toMatch(/next -- ['"]classic Bike Rental Shop['"]/);
    expect(step.message).toMatch(/--scope classic -- ['"]Bike Rental Shop['"]/);
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
    expect(step.message).toMatch(/next -- ['"]bugfix slugit should reject ""['"]/);
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
      [`fix  the\t"Save"\nbutton`, `fix  the\t"Save" button`],
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
