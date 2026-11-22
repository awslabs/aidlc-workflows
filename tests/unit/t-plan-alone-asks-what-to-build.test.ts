// covers: subcommand:aidlc-orchestrate:next, function:createPrintDirective
//
// #2355: a plan's name typed alone on a fresh workspace (`/aidlc workshop`,
// `/aidlc --scope bugfix`) created the work at once with the placeholder
// "[Project description]" as its request, and nothing asked what to build;
// Requirements Analysis then read the placeholder as the authoritative
// request. The plan is the person's pick, so it stands: the step asks them,
// once and in plain words, what the work is for, creates nothing, and names
// the one command their answer runs (that plan, the settings typed with it,
// and their words), which starts the work with their words as its request.
// Beside work in progress on another plan, the same plan typed alone was
// dropped and the stage in hand ran ("Starting the bugfix plan ..."): the
// agent now reads whether they meant new work on that plan or this work moved
// to it, with one command for each, and asks once only when it cannot tell.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { getField, splitKiroCommandArgs, validScopes } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  REPO_ROOT,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(AIDLC_SRC, "tools");
const ORCH = join(TOOLS, "aidlc-orchestrate.ts");
const WORDS = "the login rejects a correct password";
// The command's place for the person's words: a placeholder, never quotes of
// its own, since a single quote is no quote on Kiro IDE's cmd shell (#2167).
const THEIR_WORDS = "<their words>";
const asked = (plan: string) => `I'll use the ${plan} plan. What should I work on? Tell me in your own words and I'll start it.`;

type Directive = Record<string, unknown> & { kind?: string; message?: string; narration?: string };

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function fresh(): string {
  const proj = createTestProject();
  removeWorkspaceRecord(proj);
  created.push(proj);
  return proj;
}

function next(proj: string, args: string[], orch = ORCH): Directive {
  const r = runOrchestrateNext(orch, proj, args, { cwd: proj, env: { ...process.env } });
  expect(r.directive, r.out.slice(0, 400)).not.toBeNull();
  return r.directive as Directive;
}

function questionCount(proj: string): number {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).length : 0;
}

function records(proj: string): string[] {
  const dir = join(proj, "aidlc", "spaces", "default", "intents");
  return existsSync(dir) ? readdirSync(dir).filter((name) => /^\d{6}-/.test(name)) : [];
}

function answerWith(message: unknown, words: string): string[] {
  const command = /`([^`]* next --scope [^`]*)`/.exec(String(message))?.[1];
  expect(command, String(message)).toBeDefined();
  expect(command!, "their words have one place in the command").toContain(` -- ${THEIR_WORDS}`);
  const args = splitKiroCommandArgs(command!.slice(command!.indexOf(" next ") + 6).replace(THEIR_WORDS, "THEIR_WORDS"));
  args[args.indexOf("THEIR_WORDS")] = words;
  return args;
}

function requestKept(proj: string, creation: Directive, plan: string): string {
  expect(creation.kind, JSON.stringify(creation).slice(0, 400)).toBe("print");
  const id = new RegExp(`intent create --scope ${plan} --request ([0-9a-f]{8})`).exec(String(creation.message))?.[1];
  expect(id, String(creation.message)).toBeDefined();
  const tool = (args: string[]) => spawnSync(process.execPath, [join(TOOLS, "aidlc-utility.ts"), ...args, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  const made = tool(["intent-create", "--scope", plan, "--request", id!, "--label", "login-fix"]);
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  return tool(["project-description"]).stdout;
}

describe("#2355: a plan typed alone on a fresh workspace asks what the work is for", () => {
  for (const argv of [["bugfix"], ["--scope", "bugfix"], ["workshop"]]) {
    const plan = argv[argv.length - 1];
    test(`\`/aidlc ${argv.join(" ")}\`: nothing is created and the person is asked, once, what it is for`, () => {
      const proj = fresh();
      const d = next(proj, argv);
      expect(d.kind, JSON.stringify(d).slice(0, 400)).toBe("print");
      expect(String(d.message)).not.toContain("intent create");
      expect(d.narration, JSON.stringify(d).slice(0, 400)).toBe(asked(plan));
      // The command their answer runs keeps the plan they picked, and quotes
      // nothing of its own around their words.
      expect(String(d.message)).toContain(`next --scope ${plan} -- ${THEIR_WORDS}`);
      expect(String(d.message)).toContain("one shell-safe argument");
      expect(String(d.message)).not.toContain("'<");
      expect(questionCount(proj)).toBe(0);
      expect(records(proj)).toEqual([]);
    });
  }

  test("their answer runs the command the step names and starts that plan with their words as the request", () => {
    const proj = fresh();
    const asked = next(proj, ["workshop"]);
    const request = requestKept(proj, next(proj, answerWith(asked.message, WORDS)), "workshop");
    expect(request).toContain(WORDS);
    expect(request).not.toContain("[Project description]");
  });

  test("settings typed with the plan ride the command their answer runs", () => {
    const proj = fresh();
    const d = next(proj, ["bugfix", "--depth", "minimal", "--learnings", "off"]);
    expect(String(d.message)).not.toContain("intent create");
    const args = answerWith(d.message, WORDS);
    expect(args.join(" ")).toContain("--depth minimal");
    expect(args.join(" ")).toContain("--learnings off");
  });

  test("stage changes typed with the plan ride the command too, and the answer creates that plan with them", () => {
    const proj = fresh();
    const d = next(proj, ["bugfix", "--skip", "deployment-execution", "--add", "functional-design", "--plan-name", "lean-fix"]);
    expect(String(d.message)).not.toContain("intent create");
    const args = answerWith(d.message, WORDS).join(" ");
    for (const change of ["--skip deployment-execution", "--add functional-design", "--plan-name lean-fix"]) {
      expect(args, change).toContain(change);
    }
    const creation = next(proj, answerWith(d.message, WORDS));
    const message = String(creation.message);
    expect(message, JSON.stringify(creation).slice(0, 400)).toContain("intent create --scope bugfix --request");
    for (const change of ["--skip deployment-execution", "--add functional-design", "--plan-name lean-fix"]) {
      expect(message, change).toContain(change);
    }
  });

  test("no plan this install ships, typed alone, creates work before the person says what it is for", () => {
    for (const plan of validScopes()) {
      const proj = fresh();
      const d = next(proj, [plan]);
      expect(String(d.message), `${plan}: ${String(d.message).slice(0, 200)}`).not.toContain("intent create");
      expect(records(proj), plan).toEqual([]);
    }
  });
});

// `/aidlc-init --scope <plan>` with nothing else ran intent create with no
// request, so the work started as "[Project description]". The runner now asks
// the engine (`next --new-intent --scope <plan>`), which takes the same step
// as a plan typed alone; beside work in progress the answer starts the new work
// next to it, as the runner promises.
describe("`/aidlc-init --scope <plan>` with nothing else asks what the work is for", () => {
  test("fresh: nothing is created, and the answer starts that plan with their words as the request", () => {
    const proj = fresh();
    const d = next(proj, ["--new-intent", "--scope", "bugfix"]);
    expect(d.kind, JSON.stringify(d).slice(0, 400)).toBe("print");
    expect(d.narration, JSON.stringify(d).slice(0, 400)).toBe(asked("bugfix"));
    expect(String(d.message)).not.toContain("intent create");
    expect(String(d.message)).toContain(`next --scope bugfix -- ${THEIR_WORDS}`);
    expect(questionCount(proj)).toBe(0);
    expect(records(proj)).toEqual([]);
    const request = requestKept(proj, next(proj, answerWith(d.message, WORDS)), "bugfix");
    expect(request).toContain(WORDS);
    expect(request).not.toContain("[Project description]");
  });

  test("beside work in progress: nothing is created, and the answer, with the settings typed, starts the new work at once", () => {
    const proj = createTestProject();
    created.push(proj);
    seedStateFile(proj, "state-mid-ideation.md");
    const before = records(proj);
    const d = next(proj, ["--new-intent", "--scope", "bugfix", "--depth", "minimal"]);
    expect(d.kind, JSON.stringify(d).slice(0, 400)).toBe("print");
    expect(d.narration, JSON.stringify(d).slice(0, 400)).toBe(asked("bugfix"));
    expect(String(d.message)).not.toContain("intent create");
    expect(records(proj)).toEqual(before);
    const answer = answerWith(d.message, WORDS);
    expect(answer).toContain("--new-intent");
    expect(answer.join(" ")).toContain("--depth minimal");
    const creation = next(proj, answer);
    expect(creation.kind, JSON.stringify(creation).slice(0, 400)).toBe("print");
    expect(String(creation.message)).toMatch(/intent create --scope bugfix --request [0-9a-f]{8}/);
    expect(String(creation.message)).toContain("--depth minimal");
  });
});

// Work in progress on the bugfix plan, and the person types another plan's name
// with nothing else (`/aidlc workshop`, the facilitator guide's start line).
describe("a plan typed alone beside work on another plan is read, not dropped", () => {
  const KIRO_ORCH = join(REPO_ROOT, "dist", "kiro", ".kiro", "tools", "aidlc-orchestrate.ts");
  const STAGE = /Current Stage\*\*: (\S+)/;

  function besideBugfix(): string {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    seedStateFile(proj, "state-mid-inception.md");
    return proj;
  }
  const state = (proj: string) => readFileSync(seededStateFile(proj), "utf-8");
  /** The command the print names for a reading (new work or the move), as the agent runs it. */
  function command(message: unknown, reading: "new" | "move"): string[] {
    const found = [...String(message).matchAll(/`([^`]* next --scope [^`]*)`/g)].map((m) => m[1])
      .find((c) => c.includes(" --new-intent") === (reading === "new"));
    expect(found, String(message)).toBeDefined();
    return splitKiroCommandArgs(found!.slice(found!.indexOf(" next ") + 6));
  }

  for (const [host, orch] of [["claude", ORCH], ["kiro", KIRO_ORCH]] as const) {
    test(`${host}: \`/aidlc workshop\` gets the reading step with both commands, and no stage runs`, () => {
      const proj = besideBugfix();
      const before = { records: records(proj), state: state(proj) };
      const d = next(proj, ["workshop"], orch);
      expect(d.kind, JSON.stringify(d).slice(0, 400)).toBe("print");
      const message = String(d.message);
      expect(message).toContain("next --scope workshop --new-intent`");
      expect(message).toContain("next --scope workshop`");
      expect(message).toContain("ask them once");
      expect(message).not.toContain("intent create");
      expect(records(proj)).toEqual(before.records);
      expect(state(proj)).toBe(before.state);
      expect(questionCount(proj)).toBe(0);
    });
  }

  test("new work: the command asks what it is for and creates nothing; the move: the command is the scope change", () => {
    const proj = besideBugfix();
    const before = records(proj);
    const d = next(proj, ["workshop"]);
    const asks = next(proj, command(d.message, "new"));
    expect(asks.kind, JSON.stringify(asks).slice(0, 400)).toBe("print");
    expect(asks.narration).toBe(asked("workshop"));
    expect(String(asks.message)).toContain(`next --scope workshop --new-intent -- ${THEIR_WORDS}`);
    expect(records(proj)).toEqual(before);
    const moved = next(proj, command(d.message, "move"));
    expect(moved.kind, JSON.stringify(moved).slice(0, 400)).toBe("print");
    expect(String(moved.message)).toContain("scope change --scope workshop");
    expect(getField(state(proj), "Scope")).toBe("bugfix");
    // Their answer may already say what the new work is for: the step names
    // where their words go, so they are not asked for them a second time.
    expect(String(d.message)).toContain(`\` -- ${THEIR_WORDS}\``);
    const starts = next(proj, [...command(d.message, "new"), "--", WORDS]);
    expect(starts.kind, JSON.stringify(starts).slice(0, 400)).toBe("print");
    expect(String(starts.message)).toMatch(/intent create --scope workshop --request [0-9a-f]{8}/);
  });

  test("settings typed with the plan ride both commands and are not applied to the bugfix work", () => {
    const proj = besideBugfix();
    const before = state(proj);
    const d = next(proj, ["workshop", "--learnings", "off", "--depth", "comprehensive"]);
    expect(d.kind, JSON.stringify(d).slice(0, 400)).toBe("print");
    for (const reading of ["new", "move"] as const) {
      const args = command(d.message, reading).join(" ");
      expect(args, reading).toContain("--learnings off");
      expect(args, reading).toContain("--depth comprehensive");
    }
    expect(state(proj)).toBe(before);
    const asks = next(proj, command(d.message, "new"));
    expect(asks.narration).toBe(asked("workshop"));
    const answer = answerWith(asks.message, WORDS).join(" ");
    expect(answer).toContain("--learnings off");
    expect(answer).toContain("--depth comprehensive");
  });

  test("parked work gets the same reading step, and stays parked", () => {
    const proj = besideBugfix();
    const parked = spawnSync(process.execPath, [join(TOOLS, "aidlc-state.ts"), "park", "--project-dir", proj], {
      cwd: proj,
      encoding: "utf-8",
      env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
    });
    expect(parked.status, `${parked.stdout}${parked.stderr}`).toBe(0);
    const before = state(proj);
    expect((getField(before, "Parked") ?? "").trim().length).toBeGreaterThan(0);
    const d = next(proj, ["workshop"]);
    expect(d.kind, JSON.stringify(d).slice(0, 400)).toBe("print");
    expect(String(d.message)).toContain("next --scope workshop --new-intent`");
    expect(state(proj)).toBe(before);
  });

  test("the work's own plan typed alone carries on, and `--scope workshop` is the scope change, as before", () => {
    const proj = besideBugfix();
    const stage = STAGE.exec(state(proj))?.[1];
    const same = next(proj, ["bugfix"]);
    expect(same.kind, JSON.stringify(same).slice(0, 400)).toBe("run-stage");
    expect(same.stage).toBe(stage);
    const flag = next(proj, ["--scope", "workshop"]);
    expect(flag.kind, JSON.stringify(flag).slice(0, 400)).toBe("print");
    expect(String(flag.message)).toContain("scope change --scope workshop");
  });
});
