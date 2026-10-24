// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// A stage the person asks to skip while it is in progress, or while its own
// approval question is open, is skipped where it stands, whatever kind of
// stage it is, and the work goes on; on the last stage of the plan the work
// ends. The engine names the report that skips it
// and the agent runs it as named. A stage that must run for every piece of
// work (Requirements Analysis, Code Generation, Build and Test, ...) used to
// be sent to recompose, which refused it as already started and named a jump
// instead, or, on the last stage, only "It is the last stage on the plan."
//
// Mechanism: cli - spawns the shipped tools against temp projects created via
// intent-create; the stage is put in progress by a forward jump, as the engine
// does it.

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  cleanupTestProject,
  runOrchestrateNext,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { artifactFilename } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const env: Record<string, string | undefined> = { ...process.env };
for (const key of ["AIDLC_SCOPE_MAPPING", "AIDLC_SCOPE_GRID", "AIDLC_SCOPES_DIR", "AIDLC_COMPOSED_SCOPES_DIR", "AIDLC_STAGE_GRAPH"]) {
  delete env[key];
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function run(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...env, CLAUDE_PROJECT_DIR: proj },
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function stateFile(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const record = readdirSync(intents).find((name) => existsSync(join(intents, name, "aidlc-state.md")));
  return join(intents, String(record), "aidlc-state.md");
}

// A piece of work of `scope` whose `stage` the engine has started.
function startedAt(scope: string, stage: string): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  const created = run(proj, "aidlc-utility.ts", ["intent-create", "--scope", scope]);
  expect(created.status, created.out).toBe(0);
  const jumped = run(proj, "aidlc-jump.ts", ["execute", "--target", stage, "--direction", "forward", "--scope", scope]);
  expect(jumped.status, jumped.out).toBe(0);
  expect(readFileSync(stateFile(proj), "utf-8")).toContain(`- [-] ${stage} \u2014 EXECUTE`);
  return proj;
}

// The person asks to skip `stage`; the agent runs the one command the step
// names, as it names it. Returns the step's message.
function personSkips(proj: string, stage: string): string {
  const res = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, ["--skip", stage], {
    cwd: proj,
    env: { ...env, CLAUDE_PROJECT_DIR: proj },
  });
  const step = res.directive as { kind?: string; message?: string } | null;
  expect(step?.kind, res.out).toBe("print");
  const message = String(step?.message);
  expect(message).not.toContain("engine recompose");
  const named = /`[^`]*\.ts (report --stage ([a-z-]+) --result skipped --reason '([^']*)')`/.exec(message);
  expect(named, message).not.toBeNull();
  expect(named?.[2]).toBe(stage);
  const skipped = run(proj, "aidlc-orchestrate.ts", [
    "report", "--stage", stage, "--result", "skipped", "--reason", String(named?.[3]),
  ]);
  expect(skipped.status, skipped.out).toBe(0);
  expect(skipped.out).toContain('"kind":"done"');
  return message;
}

describe("a stage the person asks to skip while it is in progress is skipped", () => {
  for (const stage of ["requirements-analysis", "units-generation", "delivery-planning", "code-generation"]) {
    test(`${stage}: skipped where it stands, and the work goes on`, () => {
      const proj = startedAt("feature", stage);
      const message = personSkips(proj, stage);
      expect(message).toMatch(/"Skipped [A-Z][^."]*\. It can still be run on its own with `\/aidlc --stage [a-z-]+ --single`\."/);
      expect(message).toContain(`It can still be run on its own with \`/aidlc --stage ${stage} --single\`.`);
      expect(message).toContain("re-run `next`");
      const after = readFileSync(stateFile(proj), "utf-8");
      expect(after).toContain(`- [S] ${stage} \u2014 EXECUTE`);
      expect(after).not.toContain(`- **Current Stage**: ${stage}\n`);
      expect(after).toContain("- **Status**: Running");
    });
  }

  test("the last stage on the plan is skipped and the work ends", () => {
    const proj = startedAt("poc", "build-and-test");
    const message = personSkips(proj, "build-and-test");
    expect(message).toContain('"Skipped Build and Test. It can still be run on its own with');
    expect(message).not.toContain("last stage on the plan");
    const after = readFileSync(stateFile(proj), "utf-8");
    expect(after).toContain("- [S] build-and-test \u2014 EXECUTE");
    expect(after).toContain("- **Status**: Completed");
    // The way back is a command the person can type as shown: it names the
    // stage they skipped, and it runs that stage on its own.
    const typed = /run on its own with `\/aidlc (--stage \S+ --single)`/.exec(message);
    expect(typed?.[1], message).toBe("--stage build-and-test --single");
    const single = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, String(typed?.[1]).split(" "), {
      cwd: proj,
      env: { ...env, CLAUDE_PROJECT_DIR: proj },
    });
    const ran = single.directive as { kind?: string; stage?: string; single?: boolean } | null;
    expect(ran?.kind, single.out).toBe("run-stage");
    expect(ran?.stage).toBe("build-and-test");
    expect(ran?.single).toBe(true);
  });

  test("a stage being revised after the person asked for changes is skipped the same way", () => {
    const proj = startedAt("feature", "requirements-analysis");
    const path = stateFile(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace(
      "- [-] requirements-analysis \u2014 EXECUTE",
      "- [R] requirements-analysis \u2014 EXECUTE",
    ));
    personSkips(proj, "requirements-analysis");
    expect(readFileSync(path, "utf-8")).toContain("- [S] requirements-analysis \u2014 EXECUTE");
  });

  // What keeps a stage that must run from being dropped by the agent's own
  // reading of it: a skip the agent reports with its own reason is refused.
  test("a skip the agent reports on its own for a stage that must run is still refused", () => {
    const proj = startedAt("feature", "requirements-analysis");
    const before = readFileSync(stateFile(proj), "utf-8");
    const own = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "requirements-analysis", "--result", "skipped", "--reason", "nothing to analyse",
    ]);
    expect(own.out).toContain("only a CONDITIONAL stage can report skipped");
    expect(readFileSync(stateFile(proj), "utf-8")).toBe(before);
  });
});

// The stage's work is written and its approval question is open: "skip it"
// there is the same skip, and the question goes with the stage. It used to go
// to recompose, which refused it as no longer pending and named a jump, or, on
// the last stage, only "It is the last stage on the plan."
describe("a stage the person asks to skip at its own approval question is skipped", () => {
  const SESSION = "01995000-7a11-7000-8000-00000000d2d2";

  function atItsQuestion(scope: string, stage: string): string {
    const proj = startedAt(scope, stage);
    const path = stateFile(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace(
      `- [-] ${stage} \u2014 EXECUTE`,
      `- [?] ${stage} \u2014 EXECUTE`,
    ));
    return proj;
  }

  // What the person types, through the human-turn hook every harness uses.
  function says(proj: string, prompt: string): void {
    const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
      cwd: proj,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
      env: { ...env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(res.status, res.stderr).toBe(0);
  }

  function nextStep(proj: string): { kind?: string; stage?: string; gate?: unknown; kept_replies?: { replies?: string[] }; receipt?: string } {
    const opts = { cwd: proj, env: { ...env, CLAUDE_PROJECT_DIR: proj, AIDLC_SESSION_OVERRIDE: SESSION } };
    let step = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, [], opts).directive as
      { kind?: string; receipt?: string };
    if (step?.kind === "load-steering") {
      const res = run(proj, "aidlc-orchestrate.ts", ["continue", String(step.receipt)]);
      step = JSON.parse(res.out.split("\n").find((line) => line.trim().startsWith("{")) ?? "{}");
    }
    return step;
  }

  test("a stage in the middle: skipped at its question, the next stage starts, and the person's words stay with the skip", () => {
    const proj = atItsQuestion("feature", "requirements-analysis");
    says(proj, "skip requirements analysis, we already know what we need");
    const message = personSkips(proj, "requirements-analysis");
    expect(message).toContain('"Skipped Requirements Analysis. It can still be run on its own with');
    const after = readFileSync(stateFile(proj), "utf-8");
    expect(after).toContain("- [S] requirements-analysis \u2014 EXECUTE");
    expect(after).toContain("- [-] user-stories \u2014 EXECUTE");
    expect(after).toContain("- **Current Stage**: user-stories");
    expect(after).toContain("- **Status**: Running");
    // User Stories' own question, still unanswered, is not handed the skip.
    const questions = join(dirname(stateFile(proj)), "inception", "user-stories", "user-stories-questions.md");
    mkdirSync(dirname(questions), { recursive: true });
    writeFileSync(questions, "# User Stories Questions\n\n## Question 1\nWho uses it?\n\n[Answer]:\n");
    const step = nextStep(proj);
    expect(step.stage, JSON.stringify(step)).toBe("user-stories");
    expect(JSON.stringify(step.kept_replies ?? null)).not.toContain("skip requirements analysis");
  });

  test("the last stage on the plan: skipped at its question, and the work ends", () => {
    const proj = atItsQuestion("poc", "build-and-test");
    const message = personSkips(proj, "build-and-test");
    expect(message).not.toContain("last stage on the plan");
    const after = readFileSync(stateFile(proj), "utf-8");
    expect(after).toContain("- [S] build-and-test \u2014 EXECUTE");
    expect(after).toContain("- **Status**: Completed");
  });

  // A new chat opened at the question gets the person's plain words, not a
  // typed skip: the step for words at an open question names the skip too.
  test("in a new chat, the person's plain words at the question reach the same skip", () => {
    const proj = atItsQuestion("poc", "build-and-test");
    const words = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj,
      ["skip build and test, I'll run the tests myself later"], { cwd: proj, env: { ...env, CLAUDE_PROJECT_DIR: proj } });
    const step = words.directive as { kind?: string; message?: string } | null;
    expect(step?.kind, words.out).toBe("print");
    expect(step?.message).toContain(
      "If it asks to skip this stage, run `bun .claude/tools/aidlc-orchestrate.ts next --skip build-and-test` and follow what it returns.",
    );
    personSkips(proj, "build-and-test");
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- **Status**: Completed");
  });

  // Construction walked Unit by Unit asks for each stage's approval once every
  // Unit has done it: the Units' files stay, and the next stage's own question
  // comes next.
  test("a Construction stage at its question after the Unit walk: skipped, the Units' files stay, the next stage's question follows", () => {
    const proj = setupIntegrationProject({ stripEnvScope: true });
    tempDirs.push(proj);
    const block = {
      "functional-design": ["entities", "rules", "functional-spec", "frontend-components", "traceability"],
      "nfr-requirements": ["performance-requirements", "security-requirements", "scalability-requirements", "reliability-requirements", "observability-requirements", "tech-stack-decisions", "traceability"],
      "nfr-design": ["performance-design", "security-design", "scalability-design", "reliability-design", "observability-design", "logical-components", "traceability"],
      "infrastructure-design": ["infrastructure-specification", "monitoring-design", "cicd-pipeline", "traceability"],
      "code-generation": ["code-generation-plan", "unit-test-instructions", "code-summary", "traceability"],
    };
    writeFileSync(seededStateFile(proj), [
      "# AI-DLC State Tracking", "", "## Project Information", "- **Project**: walk", "- **Project Type**: Greenfield",
      "- **Scope**: feature", "- **State Version**: 8", "- **Unit Ownership**: solo", "- **Skeleton Stance**: on", "",
      "## Runtime State", "- **Revision Count**: 0", "- **Construction Iteration**: unit-major", "",
      "## Scope Configuration", "- **Stages to Execute**: all", "- **Stages to Skip**: none", "- **Depth**: Standard",
      "- **Test Strategy**: Standard", "- **Summary Confirmation**: off (set by you)", "", "## Stage Progress", "",
      "### CONSTRUCTION PHASE",
      "- [?] functional-design \u2014 EXECUTE",
      ...Object.keys(block).slice(1).map((slug) => `- [ ] ${slug} \u2014 EXECUTE`),
      "- [ ] build-and-test \u2014 EXECUTE", "", "## Current Status", "- **Lifecycle Phase**: CONSTRUCTION",
      "- **Current Stage**: functional-design", "- **Status**: Running", "",
    ].join("\n"));
    seedBoltDag(proj, ["alpha", "beta"]);
    for (const unit of ["alpha", "beta"]) {
      for (const [slug, names] of Object.entries(block)) {
        const dir = join(seededRecordDir(proj), "construction", unit, slug);
        mkdirSync(dir, { recursive: true });
        for (const name of names) writeFileSync(join(dir, artifactFilename(name)), `# ${name} for ${unit}\n`);
      }
    }
    personSkips(proj, "functional-design");
    const after = readFileSync(seededStateFile(proj), "utf-8");
    expect(after).toContain("- [S] functional-design \u2014 EXECUTE");
    expect(after).toContain("- **Current Stage**: nfr-requirements");
    expect(existsSync(join(seededRecordDir(proj), "construction", "alpha", "functional-design", artifactFilename("functional-spec")))).toBe(true);
    // The next stage's own question, the same one each time it is asked for.
    for (let turn = 0; turn < 2; turn++) {
      const step = nextStep(proj);
      expect(step.stage, JSON.stringify(step)).toBe("nfr-requirements");
      expect(step.gate, JSON.stringify(step)).toBe(true);
    }
  });

  // What keeps a stage that must run, or one the person did not ask to skip,
  // at its question: a skip the agent reports with its own reason is refused.
  test("a skip the agent reports on its own at a stage's question is still refused", () => {
    const proj = atItsQuestion("feature", "requirements-analysis");
    const before = readFileSync(stateFile(proj), "utf-8");
    const own = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "requirements-analysis", "--result", "skipped", "--reason", "the requirements are clear",
    ]);
    expect(own.out).toContain("only a CONDITIONAL stage can report skipped");
    expect(readFileSync(stateFile(proj), "utf-8")).toBe(before);
  });

  test("a stage that may be skipped is still not skipped at its question on the agent's own reason", () => {
    const proj = atItsQuestion("feature", "user-stories");
    const before = readFileSync(stateFile(proj), "utf-8");
    const own = run(proj, "aidlc-orchestrate.ts", [
      "report", "--stage", "user-stories", "--result", "skipped", "--reason", "one user, no stories needed",
    ]);
    expect(own.out).toContain("only an active, revising, or interrupted skipped stage can be routed as skipped");
    const direct = spawnSync(process.execPath, [
      join(proj, ".claude", "tools", "aidlc-state.ts"), "skip", "user-stories", "--route", "--reason", "one user, no stories needed",
      "--project-dir", proj,
    ], {
      cwd: proj,
      env: { ...env, CLAUDE_PROJECT_DIR: proj, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(direct.status, `${direct.stdout}${direct.stderr}`).not.toBe(0);
    expect(readFileSync(stateFile(proj), "utf-8")).toBe(before);
  });
});

// "Switch to bugfix and skip this stage" in one command: the scope change runs
// first, then the stage the person is on is skipped where it stands, as the
// skip alone does. The scope-change step used to hand recompose every stage
// named, and recompose refused the one already started, so the switch went
// through, the skip did not, and a plain "go on" ran the stage they asked to
// skip.
describe("a stage the person asks to skip with a scope switch in the same command is skipped where it stands", () => {
  const SESSION = "01995000-7a11-7000-8000-00000000d3d3";

  // The commands a step names, in the order it names them, without the undo.
  function namedCommands(message: string): string[] {
    const until = message.indexOf("If they later ask to undo");
    return [...(until === -1 ? message : message.slice(0, until)).matchAll(/`(bun [^`]*\.ts [^`]*)`/g)].map((m) => m[1]);
  }

  // Runs one named command as the agent would, its words split as a shell does.
  function runNamed(proj: string, command: string): { status: number; out: string } {
    const words = command.match(/'[^']*'|\S+/g) ?? [];
    const at = words.findIndex((word) => word.endsWith(".ts"));
    const tool = String(words[at]).split("/").at(-1) ?? "";
    return run(proj, tool, words.slice(at + 1).map((word) => word.replace(/^'(.*)'$/, "$1")));
  }

  function switchesAndSkips(proj: string, scope: string, stage: string): { message: string; commands: string[] } {
    const res = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, ["--scope", scope, "--skip", stage], {
      cwd: proj,
      env: { ...env, CLAUDE_PROJECT_DIR: proj, AIDLC_SESSION_OVERRIDE: SESSION },
    });
    const step = res.directive as { kind?: string; message?: string } | null;
    expect(step?.kind, res.out).toBe("print");
    const message = String(step?.message);
    return { message, commands: namedCommands(message) };
  }

  function atItsQuestion(scope: string, stage: string): string {
    const proj = startedAt(scope, stage);
    const path = stateFile(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace(`- [-] ${stage} — EXECUTE`, `- [?] ${stage} — EXECUTE`));
    return proj;
  }

  const SWITCH = "bun .claude/tools/aidlc.ts engine scope change --scope bugfix";
  const skipsIt = (stage: string): string =>
    `bun .claude/tools/aidlc-orchestrate.ts report --stage ${stage} --result skipped --reason 'the person asked to skip it'`;

  for (const [where, at] of [["in progress", startedAt], ["at its own approval question", atItsQuestion]] as const) {
    test(`${where}: the scope changes, then the stage is skipped, and the work goes on`, () => {
      const proj = at("feature", "requirements-analysis");
      const { message, commands } = switchesAndSkips(proj, "bugfix", "requirements-analysis");
      expect(commands, message).toEqual([SWITCH, skipsIt("requirements-analysis")]);
      expect(message).not.toContain("engine recompose --skip");
      expect(message).toContain(
        '"Skipped Requirements Analysis. It can still be run on its own with `/aidlc --stage requirements-analysis --single`."',
      );
      expect(message).toContain("re-run `next`");
      for (const command of commands) {
        const ran = runNamed(proj, command);
        expect(ran.status, ran.out).toBe(0);
      }
      const after = readFileSync(stateFile(proj), "utf-8");
      expect(after).toContain("- **Scope**: bugfix");
      expect(after).toContain("- [S] requirements-analysis — EXECUTE");
      expect(after).toContain("- **Current Stage**: code-generation");
      expect(after).toContain("- **Status**: Running");
    });
  }

  // A stage the new scope does not run is skipped by the switch itself: the
  // line says so, recompose is not asked, and nothing reads as refused.
  for (const [where, stage] of [["a stage ahead", "user-stories"], ["the stage the person is on", "user-stories"]] as const) {
    test(`${where} that the new scope does not run: the switch skips it, and the line says it is skipped`, () => {
      const proj = startedAt("feature", where === "a stage ahead" ? "requirements-analysis" : stage);
      const { message, commands } = switchesAndSkips(proj, "bugfix", stage);
      expect(commands, message).toEqual([SWITCH]);
      expect(message).toContain('"User Stories is already skipped."');
      expect(message).not.toContain("The plan is unchanged");
      // The switch alone goes on with the running work here, and so does this.
      expect(message).toEndWith("Then re-run `next` to carry on with the work.");
      const ran = runNamed(proj, SWITCH);
      expect(ran.status, ran.out).toBe(0);
      expect(readFileSync(stateFile(proj), "utf-8")).toContain(`${stage} — SKIP`);
    });
  }

  // A stage already done is never said to be skipped: recompose names it done,
  // as it does without the switch.
  test("a stage already done, named with the switch: it is not said to be skipped", () => {
    const proj = startedAt("feature", "units-generation");
    const path = stateFile(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace("- [S] user-stories — EXECUTE", "- [x] user-stories — EXECUTE"));
    const { message, commands } = switchesAndSkips(proj, "bugfix", "user-stories");
    expect(message).not.toContain("already skipped");
    expect(commands, message).toEqual([
      SWITCH, "bun .claude/tools/aidlc.ts engine recompose --skip user-stories --reason 'the person asked to skip it'",
    ]);
  });

  // A new project's plan skips Reverse Engineering whatever the scope's grid
  // says, and the switch writes it so: an add of it after the switch is a
  // change for recompose to carry out, never said to be on the plan already.
  test("on a new project, Reverse Engineering added with the switch is added after it", () => {
    const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    tempDirs.push(proj);
    const created = run(proj, "aidlc-utility.ts", ["intent-create", "--scope", "feature"]);
    expect(created.status, created.out).toBe(0);
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- **Project Type**: Greenfield");
    const res = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj,
      ["--scope", "bugfix", "--add", "reverse-engineering"], { cwd: proj, env: { ...env, CLAUDE_PROJECT_DIR: proj } });
    const message = String((res.directive as { message?: string } | null)?.message);
    expect(message, res.out).not.toContain("already on the plan");
    const commands = namedCommands(message);
    expect(commands).toEqual([SWITCH, "bun .claude/tools/aidlc.ts engine recompose --add reverse-engineering"]);
    for (const command of commands) {
      const ran = runNamed(proj, command);
      expect(ran.status, ran.out).toBe(0);
    }
    expect(readFileSync(stateFile(proj), "utf-8")).toContain("- [ ] reverse-engineering — EXECUTE");
  });

  // The open question stays the person's to answer: the step names its report
  // after the switch and the change, as the skip alone does at an open gate.
  test("at the open question, a stage ahead skipped with the switch: the step names the question's report after both", () => {
    const proj = atItsQuestion("feature", "requirements-analysis");
    const { message, commands } = switchesAndSkips(proj, "bugfix", "deployment-pipeline");
    expect(commands[0], message).toBe(SWITCH);
    expect(commands[1]).toBe("bun .claude/tools/aidlc.ts engine recompose --skip deployment-pipeline --reason 'the person asked to skip it'");
    expect(message).toContain(
      "If their message also answered the open Requirements Analysis question, record it now with " +
        "`bun .claude/tools/aidlc-orchestrate.ts report --stage requirements-analysis --result approved --user-input Approve`",
    );
  });

  // Work whose saved scope this install no longer defines switches the same way.
  test("on work whose saved scope is no longer installed: the scope changes, then the stage is skipped where it stands", () => {
    const proj = startedAt("feature", "requirements-analysis");
    const path = stateFile(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace("- **Scope**: feature", "- **Scope**: retired-scope"));
    const { message, commands } = switchesAndSkips(proj, "bugfix", "requirements-analysis");
    expect(commands, message).toEqual([SWITCH, skipsIt("requirements-analysis")]);
    for (const command of commands) {
      const ran = runNamed(proj, command);
      expect(ran.status, ran.out).toBe(0);
    }
    expect(readFileSync(path, "utf-8")).toContain("- [S] requirements-analysis — EXECUTE");
  });
});
