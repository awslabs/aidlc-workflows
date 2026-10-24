// covers: subcommand:aidlc-orchestrate:next, function:freshWorkOfferDirective, function:composeDispatchDirective
//
// t-typed-stage-change-reaches-composer - a `--skip` or `--add` typed with a
// request that names no plan is the person's own change, and the plan
// question's answers keep it. "Go ahead" creates the proposed plan with it
// when it applies to that plan (a change the plan already makes is left off,
// so creation never refuses it), and the question counts the plan it creates.
// "Tailor a plan" hands it to the composer as the person's own change, so the
// plan shown at the composer's gate has it. Both used to drop it unsaid.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeSettingsOf } from "../../core/tools/aidlc-graph.ts";
import { loadScopeMapping } from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  REPO_ROOT,
  runOrchestrateNext,
  setupIntegrationProject,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const POLICY_ENV = {
  AIDLC_HARNESS_DIR: ".claude",
  AIDLC_SCOPE_MAPPING: undefined,
  AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
  AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
  AIDLC_SCOPES_DIR: join(REPO_ROOT, "core", "scopes"),
};
const WORDS = "splitEvenly(100, 3) gives 33.33 three times so the invoice is a cent short";
const SKIPPED = "requirements-analysis";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

type Directive = Record<string, unknown> & { kind?: string; message?: string; question?: string };

function installedProject(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  return proj;
}

function runTool(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: proj };
  for (const seam of ["AIDLC_SCOPE_MAPPING", "AIDLC_SCOPE_GRID", "AIDLC_SCOPES_DIR", "AIDLC_COMPOSED_SCOPES_DIR", "AIDLC_STAGE_GRAPH"]) {
    delete env[seam];
  }
  const res = spawnSync(BUN, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: env as Record<string, string>,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function next(proj: string, args: string[]): Directive {
  const res = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env: process.env });
  return JSON.parse(res.out.split("\n").find((entry) => entry.trim().startsWith("{")) ?? "{}") as Directive;
}

/** The `next` arguments of a command an ask or print names, as the agent runs it. */
const argsOf = (command: string): string[] => command.split(" next ")[1].split(" ").filter(Boolean);

/** The plan question for the request, after the agent proposes `plan`. */
function planQuestion(proj: string, typed: string[], plan = "bugfix", first: string[] = []): Directive {
  const proposal = next(proj, [...first, ...typed, WORDS]);
  const request = /--propose <plan> --request ([0-9a-f]{8})/.exec(String(proposal.message))?.[1];
  expect(request, String(proposal.message)).toBeDefined();
  const ask = next(proj, ["--propose", plan, "--request", request!]);
  expect(ask.kind, String(ask.message)).toBe("ask");
  return ask;
}

const countOf = (text: string): string | undefined => /(\d+ stages?, \d+ approval gates?)/.exec(text)?.[1];

function creationOf(printed: Directive): string {
  const span = [...String(printed.message).matchAll(/`([^`]*)`/g)].map((m) => m[1]).find((s) => s.includes("intent create"));
  expect(span, String(printed.message)).toBeDefined();
  return span as string;
}

describe("a stage change typed with the request reaches the plan the person approves", () => {
  test("Tailor a plan: the compose answer carries it, and the composer is told it is the person's own", () => {
    const proj = installedProject();
    const ask = planQuestion(proj, ["--skip", SKIPPED]);
    const compose = String(ask.compose_command);
    expect(compose).toContain(`--skip ${SKIPPED}`);
    const dispatch = next(proj, argsOf(compose));
    expect(dispatch.kind, String(dispatch.message)).toBe("print");
    expect(String(dispatch.message)).toContain("Dispatch the composer agent");
    expect(String(dispatch.message)).toContain(`With this request the person asked to skip ${SKIPPED}`);
    expect(String(dispatch.message)).toContain("until they change it at the gate");
  });

  test("the composer's plan with the change, approved with its lists, is created with it", () => {
    const proj = installedProject();
    const dispatch = next(proj, argsOf(String(planQuestion(proj, ["--skip", SKIPPED]).compose_command)));
    const request = /--request ([0-9a-f]{8})/.exec(String(dispatch.message))?.[1] as string;
    const grid = withEnvAndFreshCaches(POLICY_ENV, () => ({ ...loadScopeMapping().bugfix.stages }));
    grid[SKIPPED] = "SKIP";
    const engine = join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-engine");
    mkdirSync(engine, { recursive: true });
    const settings = withEnvAndFreshCaches(POLICY_ENV, () => scopeSettingsOf("bugfix")!);
    writeFileSync(join(engine, "composer-proposal.json"), JSON.stringify({ stages: grid, scopeSettings: settings, guardPolicy: "off", depth: "minimal" }));
    const run = runTool(proj, "aidlc-graph.ts", ["validate-grid", "--custom"]);
    expect(run.status, run.out).toBe(0);
    const echoed = JSON.parse(run.out.slice(run.out.indexOf("{"))) as { base_scope: string; plan_changes: { skip: string[]; add: string[] } };
    expect(echoed.plan_changes.skip).toContain(SKIPPED);
    const created = next(proj, [
      "--scope", echoed.base_scope,
      ...(echoed.plan_changes.skip.length > 0 ? ["--skip", echoed.plan_changes.skip.join(",")] : []),
      ...(echoed.plan_changes.add.length > 0 ? ["--add", echoed.plan_changes.add.join(",")] : []),
      "--request", request,
    ]);
    expect(creationOf(created)).toContain(SKIPPED);
  });

  test("Go ahead: the proposed plan is created with it, and the question counts the plan created", () => {
    const proj = installedProject();
    const plain = countOf(String(planQuestion(installedProject(), []).question));
    const ask = planQuestion(proj, ["--skip", SKIPPED]);
    const confirm = String(ask.confirm_command);
    expect(confirm).toContain(`--skip ${SKIPPED}`);
    const asked = countOf(String(ask.question));
    expect(asked).toBeDefined();
    expect(asked).not.toBe(plain);
    const created = next(proj, argsOf(confirm));
    expect(creationOf(created)).toContain(`--skip ${SKIPPED}`);
    expect(countOf(String(created.message))).toBe(asked);
    // "Use a different plan" lists the proposed plan with the same answer.
    const rows = ask.scope_commands as Array<{ scope: string; command: string }>;
    expect(rows.find((row) => row.scope === "bugfix")?.command).toContain(`--skip ${SKIPPED}`);
    expect(rows.find((row) => row.scope === "feature")?.command).not.toContain("--skip");
  });

  test("a change the proposed plan already makes is left off its answer, so creation goes through as before", () => {
    const proj = installedProject();
    // bugfix already skips Market Research.
    const plain = countOf(String(planQuestion(installedProject(), []).question));
    const ask = planQuestion(proj, ["--skip", "market-research"]);
    expect(String(ask.confirm_command)).not.toContain("--skip");
    expect(countOf(String(ask.question))).toBe(plain);
    const created = next(proj, argsOf(String(ask.confirm_command)));
    expect(created.kind, String(created.message)).toBe("print");
    expect(creationOf(created)).not.toContain("--skip");
    // The composer still hears it as the person's.
    expect(String(ask.compose_command)).toContain("--skip market-research");
  });

  test("the compose offer (no ready-made plan fits) carries it the same way", () => {
    const proj = installedProject();
    const offer = planQuestion(proj, ["--add", "functional-design"], "compose");
    expect(offer.ask_type).toBe("compose-offer");
    const compose = String(offer.compose_command);
    expect(compose).toContain("--add functional-design");
    expect(String(next(proj, argsOf(compose)).message)).toContain("With this request the person asked to add functional-design");
  });

  test("a stage list with any other compose is still refused", () => {
    const proj = installedProject();
    const typed = next(proj, ["compose", "--skip", SKIPPED, WORDS]);
    expect(typed.kind).toBe("error");
    expect(String(typed.message)).toContain("Cannot combine --skip or --add");
    const running = installedProject();
    expect(runTool(running, "aidlc-utility.ts", ["intent-create", "--scope", "bugfix", "--arguments=fix the date parser", "--label", "date parser"]).status).toBe(0);
    const reshape = next(running, ["compose", "--skip", SKIPPED]);
    expect(reshape.kind).toBe("error");
    expect(String(reshape.message)).toContain("Cannot combine --skip or --add");
  });

  test("new work beside running work: the tailored answer carries it to the front composer, never the running work's", () => {
    const proj = installedProject();
    expect(runTool(proj, "aidlc-utility.ts", ["intent-create", "--scope", "bugfix", "--arguments=fix the date parser", "--label", "date parser"]).status).toBe(0);
    const ask = planQuestion(proj, ["--skip", SKIPPED], "bugfix", ["--new-intent"]);
    const compose = String(ask.compose_command);
    expect(compose).toContain(`--skip ${SKIPPED}`);
    const dispatch = String(next(proj, argsOf(compose)).message);
    expect(dispatch).toContain(`With this request the person asked to skip ${SKIPPED}`);
    expect(dispatch).not.toContain("RUNNING workflow");
  });

  test("the composer keeps the person's change out of a stock grid until they change it at the gate", () => {
    const persona = readFileSync(join(REPO_ROOT, "core", "agents", "aidlc-composer-agent.md"), "utf-8");
    expect(persona).toContain("Stage changes the dispatch names as the person's own");
    expect(persona).toContain("until the person changes them at the gate");
  });
});
