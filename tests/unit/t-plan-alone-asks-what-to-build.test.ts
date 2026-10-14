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

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { splitKiroCommandArgs, validScopes } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  removeWorkspaceRecord,
  runOrchestrateNext,
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

function next(proj: string, args: string[]): Directive {
  const r = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env: { ...process.env } });
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
