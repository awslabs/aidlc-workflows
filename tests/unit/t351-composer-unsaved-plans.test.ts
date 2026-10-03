// covers: function:planChangesBetween, function:planWithChanges,
// function:splitSlugList, function:composedPlanLabel,
// function:firstPlannedStageOfPhase, function:customPlanBase, function:customPlanStart,
// function:guardPolicyAtLeast,
// function:saveComposedScope, function:writeCompiledGraphLocked,
// function:delegatedLifecycleCommand,
// subcommand:aidlc-graph:validate-grid, subcommand:aidlc-utility:intent-create,
// subcommand:aidlc-utility:scope-save, subcommand:aidlc-utility:recompose,
// subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:status
//
// t351 - a composed plan belongs to the piece of work it was approved for. A
// custom plan runs on the stock scope the validator names (`base_scope`) with
// its own stage changes (`plan_changes`); creation writes those changes as the
// state file's EXECUTE/SKIP suffixes and a `Plan` line, and no scope file is
// written, so composing never grows the scope library. The person keeps a plan
// they like with `scope save --name <name>` (at the gate, "Approve and save as
// scope", or later, "save this plan as quick-fix"), which writes the running
// work's plan as a durable scope record and projects it. Approved stage changes
// and settings land in one recompose write, so a mixed approval is never left
// half-applied, and next checks every depth, test-strategy, and stage value it
// echoes into a command.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delegatedLifecycleCommand } from "../../core/hooks/aidlc-state-transition-guard.ts";
import { customPlanBase, customPlanStart, nearestStockScopes, scopeSettingsOf } from "../../core/tools/aidlc-graph.ts";
import {
  auditFilePath,
  composedPlanLabel,
  firstInScopeStageOfPhase,
  firstPlannedStageOfPhase,
  guardPolicyAtLeast,
  loadScopeMapping,
  planChangesBetween,
  planWithChanges,
  scopeGuardPolicyDefault,
  splitSlugList,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seedAidlcMemory,
  seedStateFile,
  seededRecordDir,
  setupIntegrationProject,
  withEnvAndFreshCaches,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const GRAPH_TOOL = join(AIDLC_SRC, "tools", "aidlc-graph.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const POLICY_ENV = {
  AIDLC_HARNESS_DIR: ".claude",
  AIDLC_SCOPE_MAPPING: undefined,
  AIDLC_SCOPE_GRID: join(AIDLC_SRC, "tools", "data", "scope-grid.json"),
  AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
  AIDLC_SCOPES_DIR: join(REPO_ROOT, "core", "scopes"),
};
const STOCK_ON = { sensors: "on", learnings: "on", summary_confirmation: "on", plan_approval: "on", review_cap: "adversarial" } as const;
// bugfix plus a design pass, without shipping: the shape the tests compose.
const ADD = "functional-design";
const SKIP = "deployment-pipeline,deployment-execution";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function stockGrid(scope: string): Record<string, "EXECUTE" | "SKIP"> {
  return withEnvAndFreshCaches(POLICY_ENV, () => ({ ...loadScopeMapping()[scope].stages }));
}

function composedGrid(): Record<string, "EXECUTE" | "SKIP"> {
  const grid = stockGrid("bugfix");
  grid[ADD] = "EXECUTE";
  for (const slug of SKIP.split(",")) grid[slug] = "SKIP";
  return grid;
}

/** A fresh installed project (its own .claude tree) with no intent yet. */
function installedProject(): string {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  return proj;
}

/** Run one of the project's OWN tools, with no fixture seams leaking in, so
 *  writes and reads follow the real resolution ladder into this project. */
function runTool(proj: string, tool: string, args: string[]): { status: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: proj };
  delete env.AIDLC_SCOPE_MAPPING;
  delete env.AIDLC_SCOPE_GRID;
  delete env.AIDLC_SCOPES_DIR;
  delete env.AIDLC_COMPOSED_SCOPES_DIR;
  delete env.AIDLC_STAGE_GRAPH;
  const res = spawnSync(BUN, [join(proj, ".claude", "tools", tool), ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: env as Record<string, string>,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function createComposed(proj: string, extra: string[] = []): { status: number; out: string } {
  return runTool(proj, "aidlc-utility.ts", [
    "intent-create", "--scope", "bugfix", "--add", ADD, "--skip", SKIP,
    "--arguments=fix the flaky date parser", "--label", "date parser", ...extra,
  ]);
}

function activeRecord(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  return join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
}

const stateOf = (proj: string): string => readFileSync(join(activeRecord(proj), "aidlc-state.md"), "utf-8");

function auditOf(proj: string): string {
  const dir = join(activeRecord(proj), "audit");
  return readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf-8")).join("\n");
}

const scopeFiles = (proj: string): string[] =>
  readdirSync(join(proj, ".claude", "scopes")).filter((file) => file.endsWith(".md")).sort();

const savedRecords = (proj: string): string[] =>
  existsSync(join(proj, "aidlc", "scopes")) ? readdirSync(join(proj, "aidlc", "scopes")).sort() : [];

function suffixOf(state: string, slug: string): string | undefined {
  return new RegExp(`^- \\[.\\] ${slug} \u2014 (EXECUTE|SKIP)`, "m").exec(state)?.[1];
}

function nextDirective(proj: string, args: string[]): { kind: string; message: string } {
  const res = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env: process.env });
  const line = res.out.split("\n").find((entry) => entry.trim().startsWith("{"));
  const parsed = JSON.parse(line ?? "{}") as { kind?: unknown; message?: unknown; reason?: unknown };
  return { kind: String(parsed.kind), message: String(parsed.message ?? parsed.reason ?? "") };
}

describe("t351 (1) a plan is its scope's grid with its own stage changes", () => {
  test("planChangesBetween names the changes in graph order", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(planChangesBetween(stockGrid("bugfix"), composedGrid())).toEqual({
        skip: ["deployment-pipeline", "deployment-execution"],
        add: [ADD],
      });
      expect(planChangesBetween(stockGrid("bugfix"), stockGrid("bugfix"))).toEqual({ skip: [], add: [] });
    });
  });

  test("planWithChanges applies the changes and refuses a slip, never a silent no-op", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const ok = planWithChanges("bugfix", { skip: splitSlugList(SKIP), add: [ADD] });
      expect(ok.errors).toEqual([]);
      expect(ok.stages).toEqual(composedGrid());
      const refuse = (skip: string[], add: string[]) => planWithChanges("bugfix", { skip, add }).errors;
      expect(refuse(["nope"], [])).toEqual(['--skip names "nope", which is not a stage.']);
      expect(refuse(["workspace-detection"], [])).toEqual([
        '--skip names "workspace-detection", an initialization stage; those always run.',
      ]);
      expect(refuse(["market-research"], [])).toEqual(['--skip names "market-research", which scope bugfix already skips.']);
      expect(refuse([], ["code-generation"])).toEqual(['--add names "code-generation", which scope bugfix already runs.']);
      expect(refuse([ADD], [ADD])).toEqual([`"${ADD}" is named by both --skip and --add.`]);
      expect(planWithChanges("no-such-scope", { skip: [], add: [] }).errors).toEqual(['Unknown scope: "no-such-scope".']);
    });
    expect(splitSlugList(" a, ,b ")).toEqual(["a", "b"]);
    expect(splitSlugList(undefined)).toEqual([]);
    expect(composedPlanLabel("bugfix")).toBe("custom, based on bugfix");
  });

  test("the plan's first Construction stage is its skeleton gate", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const lines = Object.entries(composedGrid()).map(([slug, action]) => `- [ ] ${slug} \u2014 ${action}`).join("\n");
      const plan = `- **Plan**: ${composedPlanLabel("bugfix")}\n${lines}`;
      expect(firstInScopeStageOfPhase("construction", "bugfix")?.slug).toBe("code-generation");
      expect(firstPlannedStageOfPhase("construction", "bugfix", plan)?.slug).toBe(ADD);
      // Any other workflow keeps its scope's anchor, whatever its suffixes say.
      expect(firstPlannedStageOfPhase("construction", "bugfix", lines)?.slug).toBe("code-generation");
      expect(firstPlannedStageOfPhase("construction", "bugfix", null)?.slug).toBe("code-generation");
    });
  });
});

describe("t351 (2) the validator names the stock scope a custom plan runs on", () => {
  // A base adds nothing the gate does not show: no walking-skeleton checkpoint,
  // no test strategy other than the plan's depth (tests follow that depth).
  const addsNothing = (scope: string, depth = "standard"): boolean => {
    const def = loadScopeMapping()[scope];
    return def.skeleton !== true && (def.testStrategy === undefined || def.testStrategy.toLowerCase() === depth);
  };

  test("customPlanBase picks the nearest scope whose Guard Policy default is the plan's or lower", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      const grid = composedGrid();
      const nearest = nearestStockScopes(grid);
      const relaxed = nearest.find((entry) => guardPolicyAtLeast("relaxed", scopeGuardPolicyDefault(entry.scope)) && addsNothing(entry.scope))!.scope;
      expect(customPlanBase(grid, "relaxed", nearest, "standard")).toEqual({
        scope: relaxed,
        changes: planChangesBetween(stockGrid(relaxed), grid),
      });
      // No stock scope defaults to relaxed, so creation raises an off base to it.
      expect(scopeGuardPolicyDefault(relaxed)).toBe("off");
      // The base's grid plus its changes is exactly the plan.
      const base = customPlanBase(grid, "relaxed", nearest, "standard");
      if ("changes" in base) expect(planWithChanges(base.scope, base.changes).stages).toEqual(grid);
      // Creation can always apply strict, so a strict plan takes the nearest of the rest.
      expect(customPlanBase(grid, "strict", nearest, "standard")).toMatchObject({ scope: nearest.find((entry) => addsNothing(entry.scope))!.scope });
      // An off plan runs on the nearest off scope that adds nothing.
      const offScope = nearest.find((entry) => scopeGuardPolicyDefault(entry.scope) === "off" && addsNothing(entry.scope))!.scope;
      const off = customPlanBase(grid, "off", nearest, "standard");
      expect(off).toMatchObject({ scope: offScope });
      if ("changes" in off) expect(off.changes).toEqual(planChangesBetween(stockGrid(offScope), grid));
      // A lowering no stock scope carries has no base.
      expect(customPlanBase(grid, "off", nearest.filter((entry) => entry.scope === "enterprise"), "standard")).toEqual({
        error:
          "No stock scope here defaults Guard Policy to off or lower without a walking skeleton or a test strategy other than the plan's depth, " +
          "so a plan for this piece of work cannot carry it. Propose strict, or a value at or above such a stock scope's default.",
      });
      expect(customPlanBase({ ...grid, "workspace-detection": "SKIP" }, "relaxed", nearest, "standard")).toEqual({
        error: "A plan cannot skip initialization stages (workspace-detection); they always run.",
      });
    });
  });

  test("a custom plan never runs on a base with a walking skeleton or another test strategy", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      // feature runs a walking skeleton; workshop holds tests at Minimal on a
      // Standard depth. A plan one stage away from either still runs on a base
      // that adds neither, with the same stages.
      for (const near of ["feature", "workshop"]) {
        expect(addsNothing(near)).toBe(false);
        const grid = { ...stockGrid(near), "feedback-optimization": "SKIP" } as Record<string, "EXECUTE" | "SKIP">;
        const nearest = nearestStockScopes(grid);
        // Guard Policy alone would pick it.
        expect(nearest.find((entry) => guardPolicyAtLeast("relaxed", scopeGuardPolicyDefault(entry.scope)))!.scope).toBe(near);
        const base = customPlanBase(grid, "relaxed", nearest, "standard");
        if (!("changes" in base)) throw new Error(base.error);
        expect(base.scope).not.toBe(near);
        expect(addsNothing(base.scope)).toBe(true);
        expect(guardPolicyAtLeast("relaxed", scopeGuardPolicyDefault(base.scope))).toBe(true);
        expect(planWithChanges(base.scope, base.changes).stages).toEqual(grid);
      }
    });
  });

  test("a base's own test strategy counts only when it is the plan's depth", () => {
    // A scope (a plugin's, say) may state the strategy its depth gives. It
    // serves a plan at that depth, even as the only candidate, and no other.
    const proj = createTestProject();
    tempDirs.push(proj);
    const scopes = join(proj, "scopes");
    cpSync(join(REPO_ROOT, "core", "scopes"), scopes, { recursive: true });
    const classic = join(scopes, "aidlc-classic.md");
    writeFileSync(classic, readFileSync(classic, "utf-8").replace("depth: Standard\n", "depth: Standard\ntestStrategy: Standard\n"));
    withEnvAndFreshCaches({ ...POLICY_ENV, AIDLC_SCOPES_DIR: scopes }, () => {
      expect(loadScopeMapping().classic.testStrategy).toBe("Standard");
      const grid = { ...loadScopeMapping().classic.stages, "feedback-optimization": "EXECUTE" } as Record<string, "EXECUTE" | "SKIP">;
      const nearest = nearestStockScopes(grid);
      expect(nearest.find((entry) => guardPolicyAtLeast("relaxed", scopeGuardPolicyDefault(entry.scope)))!.scope).toBe("classic");
      expect(customPlanBase(grid, "relaxed", nearest, "standard")).toMatchObject({ scope: "classic" });
      const only = nearest.filter((entry) => entry.scope === "classic");
      expect(customPlanBase(grid, "relaxed", only, "standard")).toMatchObject({ scope: "classic" });
      // At another depth its strategy would override the plan's, so it is passed over.
      const minimal = customPlanBase(grid, "relaxed", nearest, "minimal");
      if (!("changes" in minimal)) throw new Error(minimal.error);
      expect(minimal.scope).not.toBe("classic");
      expect(loadScopeMapping()[minimal.scope].testStrategy).toBeUndefined();
      expect(customPlanBase(grid, "relaxed", only, "minimal")).toHaveProperty("error");
    });
  });

  test("validate-grid --custom echoes the base, the stage changes, and settings against the base", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const proposal = join(proj, "proposal.json");
    writeFileSync(proposal, JSON.stringify({ stages: composedGrid(), scopeSettings: STOCK_ON, guardPolicy: "relaxed", depth: "Standard" }));
    const run = spawnSync(BUN, [GRAPH_TOOL, "validate-grid", "--proposal", proposal, "--custom", "--project-dir", proj], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const echoed = JSON.parse(run.stdout);
    const base = withEnvAndFreshCaches(POLICY_ENV, () => customPlanBase(composedGrid(), "relaxed", nearestStockScopes(composedGrid()), "standard"));
    if (!("scope" in base)) throw new Error("no base");
    expect(echoed).toMatchObject({ valid: true, routing: "custom", base_scope: base.scope, plan_changes: base.changes });
    // The settings are measured against the base: full reviews on a base that
    // caps them at advisory is a change for this piece of work.
    const baseSettings = withEnvAndFreshCaches(POLICY_ENV, () => scopeSettingsOf(base.scope)!);
    // Plan approval on over a base that builds without asking is a change too.
    expect(echoed.creation_settings).toEqual({
      ...(baseSettings.plan_approval === "on" ? {} : { plan_approval: "on" }),
      ...(baseSettings.review_cap === "adversarial" ? {} : { review: "adversarial" }),
    });
    // The plan's own depth rides to creation when its base runs another one.
    const baseDepth = withEnvAndFreshCaches(POLICY_ENV, () => loadScopeMapping()[base.scope].depth.toLowerCase());
    expect(echoed.creation_depth).toBe(baseDepth === "standard" ? undefined : "standard");
    // A custom proposal without its depth has not been routed.
    writeFileSync(proposal, JSON.stringify({ stages: composedGrid(), scopeSettings: STOCK_ON, guardPolicy: "relaxed" }));
    const bare = spawnSync(BUN, [GRAPH_TOOL, "validate-grid", "--proposal", proposal, "--custom", "--project-dir", proj], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    expect(bare.status).toBe(1);
    expect(JSON.parse(bare.stdout).errors).toContain(
      "A custom proposal must carry its depth: a depth member of minimal, standard, or comprehensive.",
    );
    expect(JSON.parse(bare.stdout).routing).toBeUndefined();
  });

  test("an approved relaxed custom plan is created at relaxed on its off base, with no typed switch", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const proposal = join(proj, "proposal.json");
    writeFileSync(proposal, JSON.stringify({ stages: composedGrid(), scopeSettings: STOCK_ON, guardPolicy: "relaxed", depth: "Standard" }));
    const validated = spawnSync(BUN, [GRAPH_TOOL, "validate-grid", "--proposal", proposal, "--custom", "--project-dir", proj], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    expect(validated.status, validated.stdout + validated.stderr).toBe(0);
    const echoed = JSON.parse(validated.stdout) as { base_scope: string; plan_changes: { skip: string[]; add: string[] } };
    expect(withEnvAndFreshCaches(POLICY_ENV, () => scopeGuardPolicyDefault(echoed.base_scope))).toBe("off");
    // What the conductor runs on approval. The presence bypass is off, so a lowering would be refused.
    const args = ["intent-create", "--scope", echoed.base_scope, "--guard-policy", "relaxed", "--arguments", "x", "--label", "relaxed-plan"];
    if (echoed.plan_changes.skip.length > 0) args.push("--skip", echoed.plan_changes.skip.join(","));
    if (echoed.plan_changes.add.length > 0) args.push("--add", echoed.plan_changes.add.join(","));
    const created = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0" },
    });
    expect(created.status, created.stdout + created.stderr).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    expect(readFileSync(join(intents, record, "aidlc-state.md"), "utf-8")).toContain("- **Guard Policy**: relaxed (set by you)");
  });
});

describe("t351 (3) creating a composed plan writes it to the work's state, not a scope file", () => {
  test("the stages, dirs, audit, and Plan line follow the plan", () => {
    const proj = installedProject();
    const before = scopeFiles(proj);
    const created = createComposed(proj);
    expect(created.status, created.out).toBe(0);
    expect(created.out).toContain("Plan: custom, based on bugfix, for this piece of work only (no scope file written)");
    const state = stateOf(proj);
    expect(state).toContain("- **Scope**: bugfix");
    expect(state).toContain("- **Plan**: custom, based on bugfix");
    expect(suffixOf(state, ADD)).toBe("EXECUTE");
    expect(suffixOf(state, "deployment-pipeline")).toBe("SKIP");
    expect(suffixOf(state, "deployment-execution")).toBe("SKIP");
    expect(state).toContain("- **Operation**: Skipped");
    expect(existsSync(join(activeRecord(proj), "operation"))).toBe(false);
    expect(existsSync(join(activeRecord(proj), "construction"))).toBe(true);
    const audit = auditOf(proj);
    expect(audit).toContain("**Plan**: custom, based on bugfix");
    expect(audit).toContain("**Stages skipped**: deployment-pipeline, deployment-execution");
    expect(audit).toContain(`**Stages added**: ${ADD}`);
    expect(audit).toContain("**Reason**: this plan excludes operation");
    // Nothing piles up in the scope library.
    expect(scopeFiles(proj)).toEqual(before);
    expect(savedRecords(proj)).toEqual([]);
    // Status names the plan.
    const status = runTool(proj, "aidlc-utility.ts", ["status"]);
    expect(status.out).toContain("Plan:           custom, based on bugfix (this piece of work only)");
  });

  test("a refused plan creates nothing", () => {
    const proj = installedProject();
    for (const args of [["--skip", "market-research"], ["--add", "nope"], ["--skip", "state-init"], ["--add", ADD, "--skip", ADD]]) {
      const res = runTool(proj, "aidlc-utility.ts", ["intent-create", "--scope", "bugfix", ...args, "--arguments=x", "--label", "x"]);
      expect(res.status, args.join(" ")).not.toBe(0);
      expect(res.out, args.join(" ")).toContain("intent-create refused:");
    }
    // An inherited property name is not a level word.
    for (const [flag, value, message] of [["--depth", "constructor", "Unknown depth"], ["--test-strategy", "__proto__", "Unknown test strategy"]]) {
      const res = runTool(proj, "aidlc-utility.ts", ["intent-create", "--scope", "bugfix", flag, value, "--arguments=x", "--label", "x"]);
      expect(res.status, `${flag} ${value}`).not.toBe(0);
      expect(res.out, `${flag} ${value}`).toContain(message);
    }
    expect(existsSync(join(proj, "aidlc", "spaces", "default", "intents"))).toBe(false);
  });

  test("a scope change replaces the plan and drops its Plan line", () => {
    const proj = installedProject();
    expect(createComposed(proj).status).toBe(0);
    const changed = runTool(proj, "aidlc-utility.ts", ["scope-change", "--scope", "feature"]);
    expect(changed.status, changed.out).toBe(0);
    expect(stateOf(proj)).not.toContain("- **Plan**:");
  });
});

describe("t351 (4) next carries the plan's typed changes and checks every echoed value", () => {
  test("the creation command carries --skip and --add, and the preview counts the plan", () => {
    const proj = installedProject();
    const d = nextDirective(proj, ["--scope", "bugfix", "--add", ADD, "--skip", SKIP, "--", "fix the parser"]);
    expect(d.kind).toBe("print");
    expect(d.message).toContain(`--skip ${SKIP} --add ${ADD}`);
    const previewed = /\((\d+) of \d+ stages/.exec(d.message)?.[1];
    expect(createComposed(proj).status).toBe(0);
    expect(previewed).toBe(/^- \*\*Total Stages\*\*: (\d+)$/m.exec(stateOf(proj))?.[1]);
  });

  test("hostile depth, test-strategy, and stage values never reach a command", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    removeWorkspaceRecord(proj);
    const hostile = ["minimal;touch /tmp/t351-pwn", "$(touch /tmp/t351-pwn)", "standard --scope express", "Minimal`id`", "constructor", "__proto__"];
    for (const flag of ["--depth", "--test-strategy"]) {
      for (const value of hostile) {
        const d = nextDirective(proj, ["--scope", "bugfix", flag, value, "--", "x"]);
        expect(d.kind, `${flag} ${value}`).toBe("error");
        expect(d.message).toBe(`${flag} requires <minimal|standard|comprehensive>; received ${JSON.stringify(value)}.`);
      }
    }
    for (const flag of ["--skip", "--add"]) {
      const d = nextDirective(proj, ["--scope", "bugfix", flag, "x;touch /tmp/t351-pwn", "--", "x"]);
      expect(d.kind).toBe("error");
      expect(d.message).toBe(`${flag} requires stage slugs; "x;touch /tmp/t351-pwn" is not a stage.`);
    }
    // A valid level still passes, lowercased.
    expect(nextDirective(proj, ["--scope", "bugfix", "--depth", "Standard", "--", "x"]).message).toContain("--depth standard");
    expect(existsSync("/tmp/t351-pwn")).toBe(false);
  });

  test("a running workflow's stages change only through the reshape gate", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    const d = nextDirective(proj, ["--skip", "team-formation"]);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("--skip and --add shape a new workflow's stages when it is created");
    expect(d.message).toContain('compose "<the change>"');
    const combined = nextDirective(proj, ["compose", "--skip", "team-formation", "trim it"]);
    expect(combined.kind).toBe("error");
    expect(combined.message).toContain("Cannot combine --skip or --add");
  });
});

describe("t351 (5) scope save keeps a work's plan as a reusable scope", () => {
  test("the saved scope is the running plan, with its settings, and resolves at once", () => {
    const proj = installedProject();
    expect(createComposed(proj, ["--learnings", "off", "--review", "none", "--depth", "standard"]).status).toBe(0);
    expect(stateOf(proj)).toContain("- **Depth**: Standard");
    const stateBefore = stateOf(proj);
    const saved = runTool(proj, "aidlc-utility.ts", ["scope-save", "--name", "quick-fix", "--keywords", "parser-fix"]);
    expect(saved.status, saved.out).toBe(0);
    expect(saved.out).toContain("Saved as scope quick-fix (");
    expect(saved.out).toContain("sensors on, learnings off, summary confirmation on, reviews none).");
    expect(saved.out).toContain('Next time: /aidlc --scope quick-fix "<what to build>"');
    // The running work is left as it is.
    expect(stateOf(proj)).toBe(stateBefore);
    const record = readFileSync(join(proj, "aidlc", "scopes", "quick-fix.md"), "utf-8");
    for (const line of ["name: quick-fix", "depth: Standard", "guard_policy: off", "learnings: off", "review_cap: none", "  - parser-fix"]) {
      expect(record, line).toContain(line);
    }
    expect(scopeFiles(proj)).toContain("aidlc-quick-fix.md");
    const grid = JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "scope-grid.json"), "utf-8")) as Record<
      string,
      { stages: Record<string, string> }
    >;
    const stages = grid["quick-fix"].stages;
    expect(stages[ADD]).toBe("EXECUTE");
    expect(stages["deployment-pipeline"]).toBe("SKIP");
    // The empty project scanned greenfield, which skips reverse-engineering for
    // this run only; the saved scope keeps it for the next project.
    expect(suffixOf(stateBefore, "reverse-engineering")).toBe("SKIP");
    expect(stages["reverse-engineering"]).toBe("EXECUTE");
    expect(auditOf(proj)).toContain("**Saved as**: quick-fix");
    // A new piece of work on the saved scope runs the saved plan.
    const again = runTool(proj, "aidlc-utility.ts", ["intent-create", "--scope", "quick-fix", "--arguments=another fix", "--label", "another fix"]);
    expect(again.status, again.out).toBe(0);
    expect(suffixOf(stateOf(proj), ADD)).toBe("EXECUTE");
    expect(stateOf(proj)).not.toContain("- **Plan**:");
  });

  test("a taken or malformed name, a claimed keyword, or an unknown flag writes nothing", () => {
    const proj = installedProject();
    expect(createComposed(proj).status).toBe(0);
    const refused = (args: string[], message: string) => {
      const res = runTool(proj, "aidlc-utility.ts", ["scope-save", ...args]);
      expect(res.status, args.join(" ")).not.toBe(0);
      // Refusals print one JSON error line.
      expect(String((JSON.parse(res.out) as { error?: unknown }).error), args.join(" ")).toContain(message);
    };
    refused(["--name", "bugfix"], "A scope named bugfix already exists. Pick another name.");
    refused(["--name", "Quick_Fix"], '"Quick_Fix" cannot name a scope');
    refused(["--name", "-quick"], '"-quick" cannot name a scope');
    refused(["--name", `a${"b".repeat(40)}`], "cannot name a scope");
    refused(["--name", "quick-fix", "--keywords", "fix"], 'Keyword "fix" is already claimed by scope');
    refused(["--name", "quick-fix", "--keywords", "semi;colon"], '"semi;colon" cannot be a keyword');
    refused(["--name", "quick-fix", "--keywords", "two words"], '"two words" cannot be a keyword');
    refused(["--name", "quick-fix", "--scope", "bugfix"], "scope-save does not accept --scope.");
    expect(savedRecords(proj)).toEqual([]);
    expect(runTool(proj, "aidlc-utility.ts", ["scope-save", "--name", "quick-fix", "--keywords", "parser-fix"]).status).toBe(0);
    refused(["--name", "quick-fix"], "A scope named quick-fix already exists.");
    // A keyword the first save claimed is checked again under the lock.
    refused(["--name", "other-fix", "--keywords", "parser-fix"], 'Keyword "parser-fix" is already claimed by scope');
    expect(savedRecords(proj)).toEqual(["quick-fix.md"]);
  });

  test("a failed audit undoes the save, so the same name works on retry", () => {
    const proj = installedProject();
    expect(createComposed(proj).status).toBe(0);
    const shards = readdirSync(join(activeRecord(proj), "audit"));
    expect(shards.length).toBe(1);
    const shard = join(activeRecord(proj), "audit", shards[0]);
    const kept = readFileSync(shard, "utf-8");
    // A directory where the audit file belongs: the save compiles, then its
    // audit append fails.
    rmSync(shard);
    mkdirSync(shard);
    const failed = runTool(proj, "aidlc-utility.ts", ["scope-save", "--name", "quick-fix"]);
    expect(failed.status).not.toBe(0);
    expect(failed.out).toContain("Cannot save the scope:");
    expect(savedRecords(proj)).toEqual([]);
    expect(scopeFiles(proj)).not.toContain("aidlc-quick-fix.md");
    const grid = JSON.parse(readFileSync(join(proj, ".claude", "tools", "data", "scope-grid.json"), "utf-8")) as object;
    expect(Object.hasOwn(grid, "quick-fix")).toBe(false);
    rmSync(shard, { recursive: true });
    writeFileSync(shard, kept);
    const retried = runTool(proj, "aidlc-utility.ts", ["scope-save", "--name", "quick-fix"]);
    expect(retried.status, retried.out).toBe(0);
    expect(savedRecords(proj)).toEqual(["quick-fix.md"]);
  });

  test("only the main session saves a scope", () => {
    for (const command of [
      "bun .claude/tools/aidlc.ts engine scope save --name quick-fix",
      "bun .claude/tools/aidlc-utility.ts scope-save --name quick-fix",
    ]) {
      expect(delegatedLifecycleCommand(command), command).not.toBeNull();
    }
  });
});

describe("t351 (6) approved stage changes and settings land in one recompose write", () => {
  function running(): { proj: string; statePath: string } {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
    return { proj, statePath: join(seededRecordDir(proj), "aidlc-state.md") };
  }
  const recompose = (proj: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(BUN, [UTIL, "recompose", ...args, "--project-dir", proj], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env },
    });

  test("Approve all flips the stage and applies the settings together", () => {
    const { proj, statePath } = running();
    const res = recompose(proj, ["--skip", "team-formation", "--sensors", "off", "--review", "none"]);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain("Recomposed: 1 skipped (team-formation)");
    expect(res.stdout).toContain("Sensors changed:");
    const state = readFileSync(statePath, "utf-8");
    expect(suffixOf(state, "team-formation")).toBe("SKIP");
    // A command applied it, not the person's typed switch.
    expect(state).toContain("- **Sensors**: off (set by a command)");
    expect(state).toContain("- **Review Override**: none");
    const audit = readdirSync(join(seededRecordDir(proj), "audit"))
      .map((file) => readFileSync(join(seededRecordDir(proj), "audit", file), "utf-8"))
      .join("\n");
    const order = ["RECOMPOSED", "REVIEW_CLASS_CHANGED", "CEREMONY_SET"].map((event) => audit.indexOf(`**Event**: ${event}`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order[0]).toBeLessThan(Math.min(order[1], order[2]));
  });

  test("a failed audit changes nothing and records nothing", () => {
    const { proj, statePath } = running();
    const before = readFileSync(statePath, "utf-8");
    const shard = auditFilePath(proj);
    rmSync(shard, { force: true });
    mkdirSync(shard, { recursive: true });
    const res = recompose(proj, ["--skip", "team-formation", "--sensors", "off", "--review", "none"]);
    expect(res.status).not.toBe(0);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    const auditDir = join(seededRecordDir(proj), "audit");
    for (const file of readdirSync(auditDir).filter((name) => join(auditDir, name) !== shard)) {
      expect(readFileSync(join(auditDir, file), "utf-8")).not.toContain("**Event**: RECOMPOSED");
    }
  });

  test("a refused flip applies none of its settings, and settings alone go through config set", () => {
    const { proj, statePath } = running();
    const before = readFileSync(statePath, "utf-8");
    const frozen = recompose(proj, ["--skip", "feasibility", "--sensors", "off"]);
    expect(frozen.status).not.toBe(0);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    // Summary confirmation off is the person's own switch: a recompose that
    // carries it without them is refused whole, so the stage change does not
    // land alone. (An unattended run always refuses it; the fixture profile's
    // presence bypass would otherwise let it through.)
    const summaryOff = recompose(proj, ["--skip", "team-formation", "--summary-confirmation", "off"], { AIDLC_UNATTENDED: "1" });
    expect(summaryOff.status).not.toBe(0);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    const alone = recompose(proj, ["--sensors", "off"]);
    expect(alone.status).not.toBe(0);
    expect(`${alone.stdout}${alone.stderr}`).toContain("recompose requires at least one flip; apply a setting on its own with config set.");
    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });
});

describe("t351 (7) every conductor surface offers the save and never writes scope files itself", () => {
  const harnesses = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"];
  const read = (surface: string) => readFileSync(join(REPO_ROOT, surface), "utf-8");

  test("each SKILL.md offers Approve and save as scope and saves on request", () => {
    for (const harness of harnesses) {
      const surface = `harness/${harness}/skills/aidlc/SKILL.md`;
      const text = read(surface);
      expect(text, surface).toContain("Approve / Approve and save as scope / Edit the plan / Reject");
      expect(text, surface).toContain("{{INVOKE}} engine scope save --name <name>");
      expect(text, surface).toContain('"save this plan as quick-fix"');
      expect(text, surface).toContain("on Approve all run ONE recompose carrying the stage changes and the settings as its flags");
      expect(text, surface).not.toContain("author the two files");
      expect(text, surface).not.toContain("APPENDS approved composed scopes");
      expect(text, surface).not.toContain("approved scope write runs INSIDE the dispatched composer");
    }
  });

  test("Codex shows the four-choice custom gate as one numbered list", () => {
    // Its question tool takes at most three options, so splitting the gate
    // would ask for a decision before every choice is on screen.
    const text = read("harness/codex/skills/aidlc/SKILL.md");
    expect(text).toContain(
      "four choices, more than `request_user_input` takes: render that gate as numbered prose (1 to 4) in one message, never split across calls",
    );
  });

  test("the composer returns the base and changes and writes no scope file", () => {
    const agent = read("core/agents/aidlc-composer-agent.md");
    for (const phrase of ["base_scope", "plan_changes", "baseScope", "you never write a scope file", "### Step 10: Nothing to write"]) {
      expect(agent, phrase).toContain(phrase);
    }
    expect(agent).not.toContain("Author BOTH files");
    expect(read("core/knowledge/aidlc-composer-agent/composing.md")).toContain("Neither route writes a scope file.");
  });

  test("the front dispatch names the save and the custom creation", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const d = nextDirective(proj, ["compose", "fix the token bug"]);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("Approve / Approve and save as scope / Edit the plan / Reject");
    expect(d.message).toContain("scope save --name <name>");
    expect(d.message).toContain("create it with --scope <baseScope> plus --skip <changes.skip> and --add <changes.add>");
  });
});

describe("t351 (8) a custom plan starts from classic's ceremony, whatever stock scope it runs on", () => {
  // Issue #1552: a custom plan near bugfix showed bugfix's summary
  // confirmation on. It picks its own stages but starts from the ceremony a
  // person gets without composing.
  const CLASSIC = {
    guard_policy: "off",
    scope_settings: { sensors: "on", learnings: "on", summary_confirmation: "off", plan_approval: "on", review_cap: "advisory" },
  } as const;
  const read = (surface: string) => readFileSync(join(REPO_ROOT, surface), "utf-8").replace(/\s+/g, " ");

  function validate(proj: string, proposal: unknown, route: string[]) {
    const path = join(proj, "proposal.json");
    writeFileSync(path, JSON.stringify(proposal));
    const run = spawnSync(BUN, [GRAPH_TOOL, "validate-grid", "--proposal", path, ...route, "--project-dir", proj], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    return { status: run.status, out: run.stdout + run.stderr, body: JSON.parse(run.stdout) as Record<string, unknown> };
  }

  test("customPlanStart is classic's Guard Policy and settings, and nothing when classic is not enabled", () => {
    withEnvAndFreshCaches(POLICY_ENV, () => {
      expect(customPlanStart()).toEqual(CLASSIC);
      expect(customPlanStart()).toEqual({ guard_policy: scopeGuardPolicyDefault("classic"), scope_settings: scopeSettingsOf("classic")! });
    });
    const proj = createTestProject();
    tempDirs.push(proj);
    const scopes = join(proj, "scopes");
    cpSync(join(REPO_ROOT, "core", "scopes"), scopes, { recursive: true });
    rmSync(join(scopes, "aidlc-classic.md"));
    withEnvAndFreshCaches({ ...POLICY_ENV, AIDLC_SCOPES_DIR: scopes }, () => {
      expect(customPlanStart()).toBeNull();
    });
  });

  test("validate-grid echoes custom_start on every run but --matched", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const plan = { stages: composedGrid(), scopeSettings: CLASSIC.scope_settings, guardPolicy: CLASSIC.guard_policy, depth: "Standard" };
    const unrouted = validate(proj, { stages: composedGrid() }, []);
    expect(unrouted.status, unrouted.out).toBe(0);
    expect(unrouted.body.custom_start).toEqual(CLASSIC);
    const custom = validate(proj, plan, ["--custom"]);
    expect(custom.status, custom.out).toBe(0);
    expect(custom.body.custom_start).toEqual(CLASSIC);
    const matched = validate(proj, { ...plan, stages: stockGrid("bugfix") }, ["--matched", "bugfix"]);
    expect(matched.status, matched.out).toBe(0);
    expect(matched.body).not.toHaveProperty("custom_start");
  });

  test("on a bugfix base, classic's ceremony becomes this work's settings at creation, with no typed switch", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    // Three stages past bugfix: too far to match, so the plan runs on bugfix.
    const nearBugfix = { ...stockGrid("bugfix"), "user-stories": "EXECUTE", "units-generation": "EXECUTE", "feedback-optimization": "EXECUTE" };
    const plan = { stages: nearBugfix, scopeSettings: CLASSIC.scope_settings, guardPolicy: CLASSIC.guard_policy, depth: "Standard" };
    const validated = validate(proj, plan, ["--custom"]);
    expect(validated.status, validated.out).toBe(0);
    expect(validated.body).toMatchObject({ routing: "custom", base_scope: "bugfix" });
    expect(validated.body.creation_settings).toEqual({ summary_confirmation: "off" });
    // What the conductor runs on approval: no --guard-policy for off, one flag per creation setting.
    const changes = validated.body.plan_changes as { skip: string[]; add: string[] };
    const args = ["intent-create", "--scope", "bugfix", "--summary-confirmation", "off", "--arguments", "x", "--label", "classic-ceremony"];
    if (typeof validated.body.creation_depth === "string") args.push("--depth", validated.body.creation_depth);
    if (changes.skip.length > 0) args.push("--skip", changes.skip.join(","));
    if (changes.add.length > 0) args.push("--add", changes.add.join(","));
    const created = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0" },
    });
    expect(created.status, created.stdout + created.stderr).toBe(0);
    const state = stateOf(proj);
    expect(state).toMatch(/^- \*\*Summary Confirmation\*\*: off\b/m);
    expect(state).toMatch(/^- \*\*Guard Policy\*\*: off\b/m);
    expect(state).toMatch(/^- \*\*Plan Approval\*\*: on\b/m);
  });

  test("on an express base, the plan approval the gate showed reaches the new work", () => {
    // express builds code plans without asking; classic asks. The gate shows
    // on, so creation must carry --plan-approval on, not inherit express's off.
    const proj = createTestProject();
    tempDirs.push(proj);
    seedAidlcMemory(proj);
    const nearExpress = { ...stockGrid("express"), "user-stories": "EXECUTE", "units-generation": "EXECUTE", "feedback-optimization": "EXECUTE" };
    const plan = { stages: nearExpress, scopeSettings: CLASSIC.scope_settings, guardPolicy: CLASSIC.guard_policy, depth: "Minimal" };
    const validated = validate(proj, plan, ["--custom"]);
    expect(validated.status, validated.out).toBe(0);
    expect(validated.body).toMatchObject({ routing: "custom", base_scope: "express" });
    expect(validated.body.creation_settings).toEqual({ sensors: "on", learnings: "on", plan_approval: "on", review: "advisory" });
    // The conductor turns each creation setting into its fixed flag.
    const flags: Record<string, string> = {
      sensors: "--sensors", learnings: "--learnings", summary_confirmation: "--summary-confirmation", plan_approval: "--plan-approval", review: "--review",
    };
    const args = ["intent-create", "--scope", "express", "--arguments", "x", "--label", "express-plan"];
    for (const [key, value] of Object.entries(validated.body.creation_settings as Record<string, string>)) args.push(flags[key], value);
    const changes = validated.body.plan_changes as { skip: string[]; add: string[] };
    if (changes.skip.length > 0) args.push("--skip", changes.skip.join(","));
    if (changes.add.length > 0) args.push("--add", changes.add.join(","));
    const created = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], {
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0", AIDLC_UNATTENDED: "0" },
    });
    expect(created.status, created.stdout + created.stderr).toBe(0);
    const state = stateOf(proj);
    expect(state).toMatch(/^- \*\*Plan Approval\*\*: on\b/m);
    expect(state).toMatch(/^- \*\*Sensors\*\*: on\b/m);
    expect(state).toMatch(/^- \*\*Summary Confirmation\*\*: off\b/m);
  });

  test("every conductor passes a plan_approval creation setting, and no flag only for the person's skip", () => {
    for (const harness of ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"]) {
      const surface = `harness/${harness}/skills/aidlc/SKILL.md`;
      const text = read(surface);
      expect(text, surface).toContain("a `plan_approval` in `creationSettings` (a custom plan raising it on a base that builds without asking) becomes `--plan-approval` like the other settings");
      expect(text, surface).toContain("so keep the proposal as it is and pass no `--plan-approval` flag.");
      expect(text, surface).not.toContain("Plan approval keeps the value of the scope the plan runs on");
    }
    const dispatch = read("core/tools/aidlc-orchestrate.ts");
    expect(dispatch).toContain("a plan_approval in creationSettings becomes --plan-approval like the others");
    expect(dispatch).toContain("so pass no --plan-approval flag at all");
    expect(dispatch).not.toContain("plan approval keeps the scope's value");
    // The validate-grid references name all five settings.
    for (const surface of ["docs/guide/12-cli-commands.md", "docs/reference/03-orchestrator.md"]) {
      expect(read(surface), surface).not.toMatch(/four (scope settings|`scopeSettings`)/);
      expect(read(surface), surface).toContain("`plan_approval`");
    }
  });

  test("the composer starts a custom plan from custom_start and keeps its Guard Policy off", () => {
    for (const surface of ["core/agents/aidlc-composer-agent.md", "core/knowledge/aidlc-composer-agent/composing.md"]) {
      const text = read(surface);
      expect(text, surface).toContain("`custom_start.guard_policy`");
      expect(text, surface).toContain("`custom_start.scope_settings`");
      // An edit that turns a matched plan custom keeps what the gate showed.
      expect(text, surface).toContain("A matched proposal that the human's edit turns custom keeps the Guard Policy and settings the gate showed");
      // The retired rules: settings from the nearest stock scope, and a Guard Policy chosen from risk.
      expect(text, surface).not.toContain("reads the same file as its settings baseline");
      expect(text, surface).not.toContain("For a custom grid, start from the validator's nearest stock scope.");
      expect(text, surface).not.toMatch(/relaxed for a spike|points to relaxed|propose the value from the evidence/);
      expect(text, surface).not.toContain("or a custom plan's base scope");
    }
    // The evidence rules live in the knowledge file the agent defers to.
    expect(read("core/knowledge/aidlc-composer-agent/composing.md")).toContain("a custom plan turns it on only when either is HIGH");
    const dispatch = read("core/tools/aidlc-orchestrate.ts");
    expect(dispatch).toContain("a custom one starts from the classic scope's default, which the validator echoes as custom_start");
    expect(dispatch).not.toContain("a custom one the composer's choice");
  });
});
