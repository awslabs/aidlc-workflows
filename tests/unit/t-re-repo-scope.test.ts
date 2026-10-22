// covers: cli:aidlc-utility(intent set-repos), function:handleIntentSetRepos, function:reverseEngineeringScopeAsk, function:intentReposNamed, function:repoScopePassedOver, function:noteRepoScopeAsked, function:repoScopeQuestionNote, audit:INTENT_REPOS_CHANGED
//
// #2874: before Reverse Engineering reads ten or more repositories the person
// never named, the engine asks once whether to read all of them or only some.
// Picking all records the set as theirs; picking some, the agent hands
// `intent set-repos` the exact names and the engine checks each one. A set
// they named (`--repos` at creation, or set-repos), an unattended run and a
// question they passed over read every recorded repository, with the cost said
// once; under ten the stage's progress line carries the count.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  removeWorkspaceRecord,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { readAuditShardEvents, readIntentRegistry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const TREE = join(REPO_ROOT, "dist", "claude");
const RE = "reverse-engineering";
const STATE_FIXTURE = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8");
const STAGE_LINE = /^- \[[ x-]\] ([a-z0-9-]+) \u2014 EXECUTE$/gm;
const FIXTURE_STAGES = [...STATE_FIXTURE.matchAll(STAGE_LINE)].map((match) => match[1] ?? "");
const BEFORE_RE = FIXTURE_STAGES[FIXTURE_STAGES.indexOf(RE) - 1];

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const repoNames = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `service-${String(index).padStart(3, "0")}`);

// The stage before Reverse Engineering approved, Reverse Engineering next, in
// a workspace whose work records `count` sibling repos (found on disk, unless
// `named`).
function workspace(count: number, named = false): { proj: string; repos: string[] } {
  const proj = createTestProject();
  projects.push(proj);
  cpSync(join(TREE, ".claude"), join(proj, ".claude"), { recursive: true });
  cpSync(join(TREE, "aidlc"), join(proj, "aidlc"), { recursive: true });
  const at = FIXTURE_STAGES.indexOf(RE);
  const state = STATE_FIXTURE
    .replace(/^(- \*\*Current Stage\*\*: ).*$/m, `$1${BEFORE_RE}`)
    .replace(/^(- \*\*In Progress\*\*: ).*$/m, `$1${BEFORE_RE}`)
    .replace(STAGE_LINE, (line, slug: string) =>
      line.replace(/^- \[[ x-]\]/, `- [${FIXTURE_STAGES.indexOf(slug) < at ? "x" : " "}]`));
  writeFileSync(seededStateFile(proj), state, "utf-8");
  const repos = repoNames(count);
  const registry = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
  const rows = JSON.parse(readFileSync(registry, "utf-8"));
  rows[0].repos = repos;
  if (named) rows[0].repos_named = true;
  writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
  for (const repo of repos) {
    mkdirSync(join(proj, repo, ".git"), { recursive: true });
    writeFileSync(join(proj, repo, "main.py"), "print('hello')\n");
  }
  return { proj, repos };
}

type Printed = Record<string, unknown> & { kind?: string };

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  delete env.AIDLC_UNATTENDED;
  return { ...env, ...extra };
}

function run(proj: string, tool: string, args: string[], env = childEnv()): { status: number; stdout: string } {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    cwd: proj,
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS * 4),
  });
  return { status: res.status ?? -1, stdout: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// `next` as the agent runs it, through every rules part.
function next(proj: string, env = childEnv()): Printed {
  let args = ["next"];
  for (let part = 0; part < 20; part++) {
    const { stdout } = run(proj, "aidlc-orchestrate.ts", args, env);
    const directive = JSON.parse(stdout.trim()) as Printed;
    if (directive.kind !== "load-steering") return directive;
    args = ["continue", String(directive.receipt)];
  }
  throw new Error("the rules parts did not end");
}

// The person types a line, through the host's human-turn hook.
function personSays(proj: string, prompt: string): void {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "repo-scope-session", prompt }),
    env: childEnv({ CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj }),
    encoding: "utf-8",
  });
  if (res.status !== 0) throw new Error(`record-human-turn failed: ${res.stderr}`);
}

function setRepos(proj: string, ...args: string[]): { status: number; stdout: string } {
  return run(proj, "aidlc-utility.ts", ["intent", "set-repos", ...args]);
}

const row = (proj: string) => readIntentRegistry(proj)[0];
const said = (directive: Printed): string => JSON.stringify(directive);
const COST = "Analysing all 12 may take significant time and consume many tokens: say which repositories matter to narrow the scope.";

describe("the question before Reverse Engineering reads ten or more repositories", () => {
  test("it is asked once: the waiting question comes back until the person speaks, then never again", () => {
    const { proj } = workspace(12);
    const asked = next(proj);
    expect(asked.kind, said(asked)).toBe("ask");
    expect(asked.ask_type).toBe("repo-scope");
    expect(asked.question).toBe(
      "Reverse Engineering will read the 12 repositories this work covers. Analysing all 12 may take significant " +
        "time and consume many tokens. Read all 12, or only the ones this work needs?",
    );
    const choices = asked.choices as Array<{ label: string; command?: string }>;
    expect(choices.map(({ label }) => label)).toEqual(["Read all 12", "Only some"]);
    expect(choices[0].command).toContain("intent set-repos --all");
    expect(String(asked.question_note)).toContain("set-repos <names>");
    // A request that already said which repositories is not asked again.
    expect(String(asked.question_note)).toStartWith(
      "When the person's own words already said which repositories to read, all of them or named ones, do not put this question:",
    );
    expect(String(asked.question_note)).toContain("set-repos --all");
    expect(next(proj).ask_type).toBe("repo-scope");

    personSays(proj, "what is the weather like");
    const step = next(proj);
    expect(step.kind, said(step)).toBe("run-stage");
    expect(step.stage).toBe(RE);
    expect(String(step.narration)).toEndWith(", across the 12 repositories this work covers.");
    expect(said(step)).toContain(COST);
    expect(next(proj).kind).toBe("run-stage");
  });

  test("picking all records the set as the person's, and it is never asked again", () => {
    const { proj, repos } = workspace(12);
    const asked = next(proj);
    expect(asked.ask_type).toBe("repo-scope");
    // The Read all choice's own command, run as the agent runs it.
    const [, ...words] = String((asked.choices as Array<{ command?: string }>)[0].command).split(" ");
    const ran = spawnSync(process.execPath, words, { cwd: proj, env: childEnv(), encoding: "utf-8" });
    const all = { status: ran.status ?? -1, stdout: `${ran.stdout ?? ""}${ran.stderr ?? ""}` };
    expect(all.status, all.stdout).toBe(0);
    expect(all.stdout.trim()).toBe("This work covers all 12 of its repositories.");
    expect(row(proj).repos).toEqual(repos);
    expect(row(proj).repos_named).toBe(true);
    const step = next(proj);
    expect(step.kind, said(step)).toBe("run-stage");
    expect(said(step)).toContain(COST);
    // Another clone has no mark of the question; the named set still holds.
    rmSync(join(seededRecordDir(proj), ".aidlc-engine", "repo-scope-ask.json"), { force: true });
    expect(next(proj).kind).toBe("run-stage");
  });

  test("picking some runs set-repos with the exact names: the analysis covers only those", () => {
    const { proj } = workspace(12);
    expect(next(proj).ask_type).toBe("repo-scope");
    const refused = setRepos(proj, "service-000,service-099");
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toMatch(/service-099\\?" is not a Git checkout under the workspace folder/);
    expect(refused.stdout).toContain("Nothing was changed.");
    expect(row(proj).repos).toHaveLength(12);

    // The names as an agent may write them, a space after a comma included.
    const some = setRepos(proj, "service-007,", "service-000, service-003");
    expect(some.status, some.stdout).toBe(0);
    expect(some.stdout.trim()).toBe("This work now covers service-000, service-003 and service-007. The 9 left out can be added back any time.");
    expect(row(proj).repos).toEqual(["service-000", "service-003", "service-007"]);
    expect(row(proj).repos_named).toBe(true);
    const changes = readAuditShardEvents(proj).filter((event) => event.event === "INTENT_REPOS_CHANGED");
    expect(changes).toHaveLength(1);
    expect(changes[0].block).toContain("**Repos**: service-000, service-003, service-007");

    const step = next(proj);
    expect(step.kind, said(step)).toBe("run-stage");
    expect(String(step.narration)).toEndWith(", across the 3 repositories this work covers.");
    expect(step.repos_note).toBe("Each path with {repo} is one file per repository this work covers: service-000, service-003 and service-007.");
    const record = (step.pipeline as { record: Array<{ repo?: string }> }).record;
    expect([...new Set(record.map(({ repo }) => repo))]).toEqual(["service-000", "service-003", "service-007"]);
  });

  test("an unattended run never asks; it reads every repository and says the cost", () => {
    const { proj } = workspace(12);
    const step = next(proj, childEnv({ AIDLC_UNATTENDED: "1" }));
    expect(step.kind, said(step)).toBe("run-stage");
    expect(said(step)).toContain(COST);
    expect(existsSync(join(seededRecordDir(proj), ".aidlc-engine", "repo-scope-ask.json"))).toBe(false);
  });

  test("a set the person named never asks; it says the count and the cost", () => {
    const { proj } = workspace(12, true);
    const step = next(proj);
    expect(step.kind, said(step)).toBe("run-stage");
    expect(String(step.narration)).toEndWith(", across the 12 repositories this work covers.");
    expect(said(step)).toContain(COST);
  });

  test("under ten there is no question: the progress line carries the count; one repository reads as before", () => {
    const three = next(workspace(3).proj);
    expect(three.kind, said(three)).toBe("run-stage");
    expect(String(three.narration)).toEndWith(", across the 3 repositories this work covers.");
    expect(said(three)).not.toContain("significant time");
    const one = next(workspace(1).proj);
    expect(one.kind, said(one)).toBe("run-stage");
    expect(String(one.narration)).not.toContain("repositories");
  });
});

describe("a set named at creation", () => {
  test("--repos marks the set as the person's; a set found on disk is not", () => {
    for (const [args, named] of [[["--repos", "repo-b,repo-a"], true], [[], false]] as const) {
      const proj = createTestProject();
      projects.push(proj);
      removeWorkspaceRecord(proj);
      for (const repo of ["repo-a", "repo-b"]) mkdirSync(join(proj, repo, ".git"), { recursive: true });
      const res = spawnSync(process.execPath, [join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts"),
        "intent-create", "--scope", "feature", ...args, "--project-dir", proj], { env: childEnv(), encoding: "utf-8" });
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
      expect(row(proj).repos).toEqual(["repo-a", "repo-b"]);
      expect(row(proj).repos_named === true).toBe(named);
    }
  });
});
