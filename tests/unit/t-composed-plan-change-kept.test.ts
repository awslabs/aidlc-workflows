// covers: subcommand:aidlc-orchestrate:next, function:approvedComposerPlan, function:composedPlanChangeStep
//
// t-composed-plan-change-kept - a stage change typed with the creation of a
// tailored plan, where the composer kept a different plan for that request,
// is never dropped unsaid. At a composed plan's gate the person says "skip the
// requirements step"; when the agent types that into creation instead of
// re-dispatching the composer, creation used to carry the composer's plan in
// its place and say nothing, so the agent told them it was done. Now nothing is
// created from such a list: `next` says which plan the gate showed and names
// both ways on, the composer for a change and the plan's own approval command
// for an Approve, so an Approve retyped by hand still creates the plan
// approved (#2923) and a change asked for reaches the composer.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeSettingsOf } from "../../core/tools/aidlc-graph.ts";
import { loadScopeMapping, scopeGuardPolicyDefault } from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  runOrchestrateNext,
  setupIntegrationProject,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
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

type Printed = { kind: string; message: string; narration?: string; raw: Record<string, unknown> };
type Validated = { base_scope?: string; plan_changes?: { skip: string[]; add: string[] } };

function installedProject(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  return proj;
}

function stockGrid(scope: string): Record<string, "EXECUTE" | "SKIP"> {
  return withEnvAndFreshCaches(POLICY_ENV, () => ({ ...loadScopeMapping()[scope].stages }));
}

const bugfix = () => withEnvAndFreshCaches(POLICY_ENV, () => ({
  settings: scopeSettingsOf("bugfix")!,
  policy: scopeGuardPolicyDefault("bugfix"),
}));

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

function next(proj: string, args: string[]): Printed {
  const res = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env: process.env });
  const raw = JSON.parse(res.out.split("\n").find((entry) => entry.trim().startsWith("{")) ?? "{}") as Record<string, unknown>;
  return {
    kind: String(raw.kind),
    message: String(raw.message ?? raw.reason ?? ""),
    ...(typeof raw.narration === "string" ? { narration: raw.narration } : {}),
    raw,
  };
}

const engineDir = (proj: string) => join(proj, "aidlc", "spaces", "default", "intents", ".aidlc-engine");

/** What the composer does before its gate: write its grid, validate it on its route. */
function validate(proj: string, proposal: Record<string, unknown>, route: string[]): Validated {
  mkdirSync(engineDir(proj), { recursive: true });
  writeFileSync(join(engineDir(proj), "composer-proposal.json"), JSON.stringify(proposal));
  const run = runTool(proj, "aidlc-graph.ts", ["validate-grid", ...route]);
  expect(run.status, run.out).toBe(0);
  return JSON.parse(run.out.slice(run.out.indexOf("{"))) as Validated;
}

/** The live path to a composed plan's gate: the request, the plan question's
 *  "Tailor a plan" answer, the compose dispatch. Returns the request the gate's
 *  approval names. */
function tailor(proj: string, args: string[] = []): string {
  const proposal = next(proj, [...args, WORDS]);
  const first = /--propose <plan> --request ([0-9a-f]{8})/.exec(proposal.message)?.[1];
  expect(first, proposal.message).toBeDefined();
  const offer = next(proj, ["--propose", "bugfix", "--request", first!]);
  const compose = String(offer.raw.compose_command ?? "");
  const request = /--request ([0-9a-f]{8})/.exec(compose)?.[1];
  expect(request, JSON.stringify(offer.raw)).toBeDefined();
  const dispatch = next(proj, ["compose", "--request", request!]);
  expect(dispatch.message, dispatch.message).toContain("Dispatch the composer agent");
  return request!;
}

function matchedBugfix(proj: string): void {
  const { settings, policy } = bugfix();
  validate(proj, { stages: stockGrid("bugfix"), scopeSettings: settings, guardPolicy: policy }, ["--matched", "bugfix"]);
}

/** The command a step names in backticks that contains `needle`. */
function commandIn(printed: Printed, needle: string): string {
  const span = [...printed.message.matchAll(/`([^`]*)`/g)].map((m) => m[1]).find((s) => s.includes(needle));
  expect(span, printed.message).toBeDefined();
  return span as string;
}

/** Run a `next` command a step named, as the agent would. */
function runNamed(proj: string, command: string, tail: string[] = []): Printed {
  const args = command.split(" next ")[1].split(" ").filter(Boolean);
  return next(proj, [...args, ...tail]);
}

const lists = (changes: { skip: string[]; add: string[] }): string[] => [
  ...(changes.skip.length > 0 ? ["--skip", changes.skip.join(",")] : []),
  ...(changes.add.length > 0 ? ["--add", changes.add.join(",")] : []),
];

const nothingCreated = (proj: string) =>
  expect(existsSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"))).toBe(false);

function stateOf(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  return readFileSync(join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim(), "aidlc-state.md"), "utf-8");
}

const suffixOf = (state: string, slug: string) => new RegExp(`^- \\[.\\] ${slug} \u2014 (EXECUTE|SKIP)`, "m").exec(state)?.[1];

function create(proj: string, printed: Printed): void {
  const args = commandIn(printed, "intent create").split(" intent create ")[1].replace(/--label "[^"]*"/, "--label split-evenly");
  const run = runTool(proj, "aidlc-utility.ts", ["intent-create", ...args.split(/\s+/).filter(Boolean)]);
  expect(run.status, run.out).toBe(0);
}

/** The step a list that is not the gate's plan gets: nothing to create, both ways on. */
function expectChangeStep(printed: Printed, typed: string): void {
  expect(printed.kind, printed.message).toBe("print");
  expect(printed.message).not.toContain("intent create");
  expect(printed.message).toContain(typed);
  expect(printed.message).toContain("dispatch the composer again");
  expect(printed.narration).toBeUndefined();
}

describe("a stage change typed at a composed plan's gate is never dropped unsaid", () => {
  test("the live shape: a skip typed beside a matched plan creates nothing and names the composer and the plan's own approval", () => {
    for (const scoped of [false, true]) {
      const proj = installedProject();
      const request = tailor(proj);
      matchedBugfix(proj);
      const step = next(proj, [...(scoped ? ["--scope", "bugfix"] : []), "--skip", SKIPPED, "--request", request]);
      expectChangeStep(step, `skip ${SKIPPED}`);
      expect(step.message).toContain("(bugfix with no stage changes)");
      nothingCreated(proj);
      // An Approve: the plan's own approval command creates the plan the gate showed.
      const approval = commandIn(step, " next --scope bugfix");
      expect(approval).toEndWith(`next --scope bugfix --request ${request}`);
      const created = runNamed(proj, approval);
      expect(created.kind, created.message).toBe("print");
      expect(commandIn(created, "intent create")).not.toContain("--skip");
      expect(created.message).toContain("to start the workflow");
    }
  });

  test("a custom plan's list retyped without one of its changes names the kept lists and the typed plan name", () => {
    const proj = installedProject();
    const request = tailor(proj);
    const grid = stockGrid("bugfix");
    grid["functional-design"] = "EXECUTE";
    grid["deployment-pipeline"] = "SKIP";
    grid["deployment-execution"] = "SKIP";
    const echoed = validate(proj, { stages: grid, scopeSettings: bugfix().settings, guardPolicy: "off", depth: "minimal" }, ["--custom"]);
    const base = echoed.base_scope as string;
    const kept = echoed.plan_changes as { skip: string[]; add: string[] };
    expect(kept.skip).toContain("deployment-execution");
    // "Put the deploy back": the agent typed the plan's lists without that skip.
    const typed = { skip: kept.skip.filter((slug) => slug !== "deployment-execution"), add: kept.add };
    const step = next(proj, ["--scope", base, ...lists(typed), "--plan-name", "cent-fix", "--request", request]);
    expectChangeStep(step, "deployment-execution");
    const approval = commandIn(step, ` next --scope ${base}`);
    expect(approval).toContain(`${lists(kept).join(" ")} --plan-name cent-fix --request ${request}`);
    const created = runNamed(proj, approval);
    expect(commandIn(created, "intent create")).toContain(lists(kept).join(" "));
  });

  test("the change reaches the plan through the composer: its revised plan is the one created", () => {
    const proj = installedProject();
    const request = tailor(proj);
    matchedBugfix(proj);
    expectChangeStep(next(proj, ["--skip", SKIPPED, "--request", request]), `skip ${SKIPPED}`);
    // The composer applies the edit and validates the revised plan, which it keeps for the request.
    const grid = stockGrid("bugfix");
    grid[SKIPPED] = "SKIP";
    const echoed = validate(proj, { stages: grid, scopeSettings: bugfix().settings, guardPolicy: "off", depth: "minimal" }, ["--custom"]);
    const revised = echoed.plan_changes as { skip: string[]; add: string[] };
    expect(revised.skip).toContain(SKIPPED);
    // The person approves the revised plan; the agent types its lists.
    const created = next(proj, [
      "--scope", echoed.base_scope as string,
      ...(revised.skip.length > 0 ? ["--skip", revised.skip.join(",")] : []),
      ...(revised.add.length > 0 ? ["--add", revised.add.join(",")] : []),
      "--request", request,
    ]);
    create(proj, created);
    expect(suffixOf(stateOf(proj), SKIPPED)).toBe("SKIP");
  });

  test("a report-only composition gets the step before its entry is spent", () => {
    const proj = installedProject();
    const dispatch = next(proj, ["compose", "--report", "scan.json"]);
    const entry = /--request ([0-9a-f]{8})/.exec(dispatch.message)?.[1] as string;
    matchedBugfix(proj);
    const step = next(proj, ["--scope", "bugfix", "--skip", SKIPPED, "--request", entry, "--", "fix the split rounding"]);
    expectChangeStep(step, `skip ${SKIPPED}`);
    const approval = commandIn(step, " next --scope bugfix");
    expect(approval).toEndWith(`--request ${entry} -- <creationDescription>`);
    expect(step.message).not.toContain("fix the split rounding");
    // The entry is still there: the approval, with the description, creates the plan the gate showed.
    const created = runNamed(proj, approval.replace(" -- <creationDescription>", ""), ["--", "fix the split rounding"]);
    expect(created.kind, created.message).toBe("print");
    expect(commandIn(created, "intent create")).not.toContain("--skip");
  });

  test("a list that is the kept plan's, in any order, a plan the composer did not keep, or a list kept from the request creates at once", () => {
    const proj = installedProject();
    const request = tailor(proj);
    const grid = stockGrid("bugfix");
    grid["functional-design"] = "EXECUTE";
    grid["deployment-pipeline"] = "SKIP";
    grid["deployment-execution"] = "SKIP";
    const echoed = validate(proj, { stages: grid, scopeSettings: bugfix().settings, guardPolicy: "off", depth: "minimal" }, ["--custom"]);
    const base = echoed.base_scope as string;
    const kept = echoed.plan_changes as { skip: string[]; add: string[] };
    const reordered = next(proj, ["--scope", base, ...lists({ skip: [...kept.skip].reverse(), add: [...kept.add].reverse() }), "--request", request]);
    expect(commandIn(reordered, "intent create")).toContain(`--skip ${kept.skip.join(",")}`);
    // Another plan, after a Reject: what was typed stands.
    const other = base === "feature" ? "classic" : "feature";
    expect(commandIn(next(proj, ["--scope", other, "--skip", "code-generation", "--request", request]), "intent create"))
      .toContain("--skip code-generation");

    // A skip the person typed with the request rides the plan's answers as its
    // settings, not as a list typed at the gate: the approval creates at once.
    const typedFirst = installedProject();
    const asked = tailor(typedFirst, ["--skip", SKIPPED]);
    matchedBugfix(typedFirst);
    const approved = next(typedFirst, ["--scope", "bugfix", "--request", asked]);
    expect(approved.kind, approved.message).toBe("print");
    expect(approved.message).toContain("intent create");
  });

  test("new work beside running work: the step's approval carries --new-intent", () => {
    const proj = installedProject();
    const running = runTool(proj, "aidlc-utility.ts", ["intent-create", "--scope", "bugfix", "--arguments=fix the date parser", "--label", "date parser"]);
    expect(running.status, running.out).toBe(0);
    const request = tailor(proj, ["--new-intent"]);
    matchedBugfix(proj);
    const step = next(proj, ["--new-intent", "--scope", "bugfix", "--skip", SKIPPED, "--request", request]);
    expectChangeStep(step, `skip ${SKIPPED}`);
    expect(commandIn(step, " next --scope bugfix")).toContain("--new-intent");
  });

  test("after a Reject, the plan's own base named with its own change gets the step too, with both ways on", () => {
    // The record outlives the gate until creation, so "use bugfix but skip
    // requirements" after a Reject reads as a change to the composed plan:
    // the composer route creates it after one more look; nothing is dropped.
    const proj = installedProject();
    const request = tailor(proj);
    matchedBugfix(proj);
    const step = next(proj, ["--scope", "bugfix", "--skip", SKIPPED, "--request", request]);
    expectChangeStep(step, `skip ${SKIPPED}`);
    expect(commandIn(step, " next --scope bugfix")).not.toContain("--skip");
    expect(readdirSync(engineDir(proj))).toContain("composer-scores.json");
  });
});
