// covers: subcommand:aidlc-utility:intent-create, subcommand:aidlc-graph:compile, subcommand:aidlc-utility:doctor, function:writeCompiledGraphLocked
//
// t-scope-grid-validation - a plan that changes which stages run gets the same
// check on every route, against the shipped tools in a real project:
//
//   - Stage changes at creation (`--scope <base> --skip/--add`): a change that
//     leaves a later stage without a required input is said in the creation
//     output, never left silent, and the base scope's own advisories are not
//     repeated as if the change caused them.
//   - The run-stage directive judges a missing input against this work's plan,
//     not the scope's stock grid: a producer the person skipped owns the
//     absence (`expected: true`).
//   - A hand-written scope record (`aidlc/scopes/<name>.md`) whose grid names a
//     stage that does not exist, or does not run the initialization stages, is
//     refused by `graph compile`, naming the file; nothing of it is projected,
//     `--scope <name>` does not resolve, and doctor names it. A well-formed
//     hand-written record still compiles and runs.
//
// Mechanism = cli: every step spawns the project's own tools.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderComposedScopeRecord } from "../../core/tools/aidlc-graph.ts";
import { cleanupTestProject, runOrchestrateNext, sedReplaceInFile, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const INIT = ["workspace-scaffold", "workspace-detection", "state-init"];
const STARVED_HEADER = "Inputs this plan leaves without their producer";

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function freshProject(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  projects.push(proj);
  return proj;
}

function toolEnv(): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AIDLC_SCOPE_MAPPING;
  delete env.AIDLC_SCOPE_GRID;
  delete env.AIDLC_SCOPES_DIR;
  delete env.AIDLC_COMPOSED_SCOPES_DIR;
  delete env.AIDLC_STAGE_GRAPH;
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env as Record<string, string>;
}

function runTool(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(BUN, [join(proj, ".claude", "tools", tool), ...args], {
    encoding: "utf-8",
    env: { ...toolEnv(), CLAUDE_PROJECT_DIR: proj },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const create = (proj: string, args: string[]) =>
  runTool(proj, "aidlc-utility.ts", ["intent-create", ...args, "--project-dir", proj]);
const compile = (proj: string) => runTool(proj, "aidlc-graph.ts", ["compile"]);
const doctor = (proj: string) => runTool(proj, "aidlc-utility.ts", ["doctor", "--verbose", "--project-dir", proj]);

function stateFile(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const dir = readdirSync(intents).find((d) => existsSync(join(intents, d, "aidlc-state.md")));
  if (!dir) throw new Error(`no state file under ${intents}`);
  return join(intents, dir, "aidlc-state.md");
}

/** Write a record by hand the way a person or a client would: a scope file's
 *  frontmatter and prose, with the grid region holding `stages`. */
function writeRecord(proj: string, name: string, stages: Record<string, "EXECUTE" | "SKIP">): string {
  const identity = `---\nname: ${name}\ndepth: Minimal\ndescription: Written by hand\n---\n\n# ${name} scope\n\nWritten by hand.\n`;
  const dir = join(proj, "aidlc", "scopes");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, renderComposedScopeRecord(identity, stages), "utf-8");
  return path;
}

const gridColumns = (proj: string): string[] =>
  Object.keys(JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "scope-grid.json"), "utf-8")));

describe("stage changes at creation", () => {
  test("a skip that leaves a later stage without a required input is said, and the work is created", () => {
    const proj = freshProject();
    const res = create(proj, ["--scope", "poc", "--skip", "requirements-analysis", "--arguments=try the idea", "--label", "try it"]);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("State initialized: poc scope");
    expect(res.out).toContain(STARVED_HEADER);
    expect(res.out).toContain('Stage "code-generation" requires artifact "requirements" whose producer(s) [requirements-analysis]');
    expect(readFileSync(stateFile(proj), "utf-8")).toMatch(/^- \[.\] requirements-analysis — SKIP/m);

    // The run-stage directive reads the same plan: the person skipped the
    // producer, so the missing requirements are expected, not a broken stage.
    const state = stateFile(proj);
    sedReplaceInFile(state, /^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
    sedReplaceInFile(state, /^- \[.\] code-generation — EXECUTE/m, "- [-] code-generation — EXECUTE");
    const orchestrate = join(proj, ".claude", "tools", "aidlc-orchestrate.ts");
    // The host fires its PreToolUse hook before the agent's `next`; its
    // heartbeat is what tells the engine this project runs AI-DLC's hooks.
    const hook = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "hook", "plan-approval-guard"], {
      encoding: "utf-8",
      env: { ...toolEnv(), CLAUDE_PROJECT_DIR: proj },
      input: JSON.stringify({
        session_id: "grid-validation", cwd: proj, hook_event_name: "PreToolUse", tool_name: "Bash",
        tool_input: { command: `bun ${orchestrate} next --project-dir ${proj}` },
      }),
    });
    expect(hook.status, `${hook.stdout}${hook.stderr}`).toBe(0);
    const next = runOrchestrateNext(orchestrate, proj, [], { env: { ...toolEnv(), CLAUDE_PROJECT_DIR: proj } });
    const directive = next.directive as { kind?: string; stage?: string; consumes_absent?: Array<{ path: string; expected: boolean }> };
    expect(directive.kind, JSON.stringify(directive)).toBe("run-stage");
    expect(directive.stage).toBe("code-generation");
    const requirements = (directive.consumes_absent ?? []).find((entry) => entry.path.endsWith("/requirements.md"));
    expect(requirements?.expected).toBe(true);
  });

  test("what the base scope already leaves out is not repeated as the change's doing", () => {
    const proj = freshProject();
    // bugfix's own code-generation already runs without units-generation's
    // unit-of-work; skipping the deployment stages starves nothing new.
    const res = create(proj, [
      "--scope", "bugfix", "--skip", "deployment-pipeline,deployment-execution",
      "--arguments=fix the date parser", "--label", "date parser",
    ]);
    expect(res.status, res.out).toBe(0);
    expect(res.out).not.toContain(STARVED_HEADER);
  });

  test("a scope run as it is says nothing about missing inputs", () => {
    const proj = freshProject();
    const res = create(proj, ["--scope", "poc", "--arguments=try the idea", "--label", "try it"]);
    expect(res.status, res.out).toBe(0);
    expect(res.out).not.toContain(STARVED_HEADER);
  });
});

describe("a hand-written scope record", () => {
  test("naming a stage that does not exist is refused at compile, naming the file", () => {
    const proj = freshProject();
    const stages = Object.fromEntries(
      [...INIT, "code-generation", "build-and-test", "not-a-stage"].map((s) => [s, "EXECUTE" as const]),
    );
    const path = writeRecord(proj, "typo-plan", stages);
    const res = compile(proj);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(`Composed scope record ${path}`);
    expect(res.out).toContain('unknown stage "not-a-stage"');
    // Nothing of it is projected, so it never resolves as a plan.
    expect(existsSync(join(proj, ".claude", "scopes", "aidlc-typo-plan.md"))).toBe(false);
    expect(gridColumns(proj)).not.toContain("typo-plan");
    const created = create(proj, ["--scope", "typo-plan", "--arguments=x", "--label", "x"]);
    expect(created.status).not.toBe(0);
    expect(created.out).toContain("Unknown scope");
    expect(created.out).toContain("typo-plan");
    // Doctor names the record and how to fix it.
    const report = doctor(proj).out;
    expect(report).toContain("stage grid no plan can run [typo-plan:");
    expect(report).toContain('unknown stage "not-a-stage"');
  });

  test("that does not run the initialization stages is refused at compile, naming each one", () => {
    const proj = freshProject();
    const path = writeRecord(proj, "three-only", {
      "requirements-analysis": "EXECUTE",
      "code-generation": "EXECUTE",
      "build-and-test": "EXECUTE",
    });
    const res = compile(proj);
    expect(res.status).not.toBe(0);
    expect(res.out).toContain(`Composed scope record ${path}`);
    for (const slug of INIT) {
      expect(res.out).toContain(`Grid does not run "${slug}", an initialization stage; those always run.`);
    }
    expect(existsSync(join(proj, ".claude", "scopes", "aidlc-three-only.md"))).toBe(false);
    expect(doctor(proj).out).toContain("stage grid no plan can run [three-only:");
  });

  test("that is well formed still compiles and runs, other stages left out", () => {
    const proj = freshProject();
    writeRecord(proj, "mvp-min", Object.fromEntries(
      [...INIT, "requirements-analysis", "code-generation", "build-and-test"].map((s) => [s, "EXECUTE" as const]),
    ));
    const res = compile(proj);
    expect(res.status, res.out).toBe(0);
    expect(gridColumns(proj)).toContain("mvp-min");
    const created = create(proj, ["--scope", "mvp-min", "--arguments=smallest build", "--label", "smallest"]);
    expect(created.status, created.out).toBe(0);
    expect(created.out).toContain("State initialized: mvp-min scope");
    expect(doctor(proj).out).not.toContain("stage grid no plan can run");
  });
});
