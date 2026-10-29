// covers: subcommand:aidlc-orchestrate:next, function:approvedComposerPlan, function:composedPlanChangeStep,
// function:keptComposerPlans, function:unseenComposedPlanStep
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
//
// The plan the gate showed is the one the composer kept before the person's
// reply. On Codex CLI the composer that offered a plan was gone by the Approve
// turn, the agent ran a new one, and its different plan was created as the one
// approved. A plan composed after the reply now creates nothing: `next` names
// the plan the person saw and its approval, or, with none on record, has the
// agent show the new plan once, and the person's next reply creates it.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scopeSettingsOf } from "../../core/tools/aidlc-graph.ts";
import { loadScopeMapping, scopeGuardPolicyDefault } from "../../core/tools/aidlc-lib.ts";
import { saveMessage } from "../../core/tools/aidlc-message-store.ts";
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
type Validated = {
  base_scope?: string;
  plan_changes?: { skip: string[]; add: string[] };
  creation_depth?: string;
  creation_settings?: Record<string, string>;
};

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

function create(proj: string, printed: Printed, message?: string): void {
  const args = commandIn(printed, "intent create").split(" intent create ")[1].replace(/--label '[^']*'/, "--label split-evenly")
    .replace("'<id>'", message ?? "'<id>'");
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

// The person's own chat: the reply-since rule on (the fixture profile switches
// it off), the hooks beating as they do on every message.
function asPerson(proj: string): Record<string, string | undefined> {
  const health = join(engineDir(proj), "hooks-health");
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), `${wholeSeconds(new Date())}\n`);
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  return env;
}

const wholeSeconds = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, "Z");

function nextAsPerson(proj: string, args: string[]): Printed {
  const res = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env: asPerson(proj) });
  const raw = JSON.parse(res.out.split("\n").find((entry) => entry.trim().startsWith("{")) ?? "{}") as Record<string, unknown>;
  return {
    kind: String(raw.kind),
    message: String(raw.message ?? raw.reason ?? ""),
    ...(typeof raw.narration === "string" ? { narration: raw.narration } : {}),
    raw,
  };
}

/** The person's message, kept as the prompt hook keeps it (whole seconds). Returns its id. */
function personSays(proj: string, words: string, at = new Date()): string {
  return saveMessage(proj, {
    session: null, at: wholeSeconds(at), source: "prompt", text: words, picker: null, words, settings: [],
    route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
  }).id;
}

/** Moves the request's question, and the plan kept so far if any, a minute back,
 *  and returns a time between them and now for the person's reply. */
function before(proj: string, request: string): Date {
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const question = join(proj, "aidlc", ".aidlc-sessions", "questions", `${request}.json`);
  writeFileSync(question, JSON.stringify({ ...JSON.parse(readFileSync(question, "utf-8")), createdAt: earlier }));
  keptAt(proj, earlier);
  return new Date(Date.now() - 30_000);
}

/** Moves the plan kept last, if any, to `at`. */
function keptAt(proj: string, at: string): void {
  const recordPath = join(engineDir(proj), "composer-scores.json");
  const record = JSON.parse(readFileSync(recordPath, "utf-8"));
  if (record.plan) writeFileSync(recordPath, JSON.stringify({ ...record, plan: { ...record.plan, at } }));
}

type Custom = { base: string; changes: { skip: string[]; add: string[] }; depth?: string; settings: Record<string, string> };

/** A custom plan on bugfix's grid with `flips`, validated as the composer does. */
function customPlan(
  proj: string,
  flips: Record<string, "EXECUTE" | "SKIP">,
  shape: { depth?: string; flip?: "sensors" | "learnings" } = {},
): Custom {
  const grid = { ...stockGrid("bugfix"), ...flips };
  const settings: Record<string, string> = { ...bugfix().settings };
  if (shape.flip) settings[shape.flip] = settings[shape.flip] === "on" ? "off" : "on";
  const echoed = validate(proj, { stages: grid, scopeSettings: settings, guardPolicy: "off", depth: shape.depth ?? "minimal" }, ["--custom"]);
  return {
    base: echoed.base_scope as string,
    changes: echoed.plan_changes as { skip: string[]; add: string[] },
    ...(echoed.creation_depth ? { depth: echoed.creation_depth } : {}),
    settings: echoed.creation_settings ?? {},
  };
}

/** The creation flags a plan's own approval types for its depth and settings. */
const shapeFlags = (plan: Custom): string[] => [
  ...(plan.depth ? ["--depth", plan.depth] : []),
  ...Object.entries(plan.settings).flatMap(([key, value]) => [`--${key.replace(/_/g, "-")}`, value]),
];

const SHOWN = { "deployment-pipeline": "SKIP", "deployment-execution": "SKIP" } as const;
const RECOMPOSED = { [SKIPPED]: "SKIP", "deployment-execution": "SKIP" } as const;

describe("Approve creates the plan the gate showed, even when the plan is composed again after the reply", () => {
  test("the live shape: a composer run again after Approve keeps a different plan; creating it names the plan shown, whose approval creates it", () => {
    const proj = installedProject();
    const request = tailor(proj);
    const shown = customPlan(proj, SHOWN, { depth: "standard", flip: "sensors" });
    const approve = personSays(proj, "Approve", before(proj, request));
    const again = customPlan(proj, RECOMPOSED, { depth: "comprehensive", flip: "learnings" });
    expect(again.base).toBe(shown.base);
    expect(again.changes).not.toEqual(shown.changes);
    expect(shapeFlags(again)).not.toEqual(shapeFlags(shown));

    // The agent types the later plan as composer.md says: its lists, depth, settings and name.
    const typed = ["--scope", again.base, ...lists(again.changes), ...shapeFlags(again), "--plan-name", "cent-fix", "--request", request];
    const step = nextAsPerson(proj, typed);
    expect(step.kind, step.message).toBe("print");
    expect(step.message).not.toContain("intent create");
    expect(step.message).toContain("worked out after the person's last message on record");
    nothingCreated(proj);
    // The plan shown is named with its own depth and settings, never the later plan's.
    const approval = commandIn(step, ` next --scope ${shown.base}`);
    expect(approval).toContain(`${lists(shown.changes).join(" ")} --plan-name cent-fix --request ${request}`);
    for (const [flag, value] of pairs(shapeFlags(shown))) expect(approval).toContain(`${flag} ${value}`);
    for (const [flag, value] of pairs(shapeFlags(again))) expect(approval).not.toContain(`${flag} ${value}`);

    const created = nextAsPerson(proj, runNamedArgs(approval));
    const creation = commandIn(created, "intent create");
    expect(creation).toContain(lists(shown.changes).join(" "));
    for (const [flag, value] of pairs(shapeFlags(shown))) expect(creation).toContain(`${flag} ${value}`);
    create(proj, created, approve);
    const state = stateOf(proj);
    expect(suffixOf(state, "deployment-pipeline")).toBe("SKIP");
    expect(suffixOf(state, SKIPPED)).toBe("EXECUTE");
  });

  test("a later plan with the same stages and other settings: the plan shown is named with its own, and a setting the person asked for rides once", () => {
    const proj = installedProject();
    const request = tailor(proj);
    const shown = customPlan(proj, SHOWN, { depth: "standard", flip: "sensors" });
    const approve = personSays(proj, "Approve", before(proj, request));
    const again = customPlan(proj, SHOWN, { depth: "comprehensive", flip: "learnings" });
    expect(again.changes).toEqual(shown.changes);

    const step = nextAsPerson(proj, ["--scope", again.base, ...lists(again.changes), ...shapeFlags(again), "--request", request]);
    expect(step.message).not.toContain("intent create");
    expect(step.message).toContain("worked out after the person's last message on record");
    expect(step.message).toContain("adding the flag for any setting their reply asked for in their own words");
    nothingCreated(proj);
    const approval = commandIn(step, ` next --scope ${shown.base}`);
    for (const [flag, value] of pairs(shapeFlags(shown))) expect(approval).toContain(`${flag} ${value}`);
    for (const [flag, value] of pairs(shapeFlags(again))) expect(approval).not.toContain(`${flag} ${value}`);

    // The person's "Approve, and turn learnings on" rides as its flag on the named approval, which creates at once.
    const [learnings, value] = pairs(shapeFlags(again)).find(([flag]) => flag === "--learnings") as [string, string];
    const created = nextAsPerson(proj, [...runNamedArgs(approval), learnings, value]);
    const creation = commandIn(created, "intent create");
    expect(creation).toContain(`${learnings} ${value}`);
    for (const [flag, shownValue] of pairs(shapeFlags(shown))) expect(creation).toContain(`${flag} ${shownValue}`);
    create(proj, created, approve);
  });

  test("a setting the person asked for, carried by the later plan too, is the agent's to add to the plan shown", () => {
    const proj = installedProject();
    const request = tailor(proj);
    const shown = customPlan(proj, SHOWN);
    personSays(proj, "Approve, and turn sensors off", before(proj, request));
    const again = customPlan(proj, RECOMPOSED, { flip: "sensors" });
    const [sensors, value] = pairs(shapeFlags(again)).find(([flag]) => flag === "--sensors") as [string, string];

    const step = nextAsPerson(proj, ["--scope", again.base, ...lists(again.changes), sensors, value, "--request", request]);
    expect(step.message).not.toContain("intent create");
    expect(step.message).toContain("adding the flag for any setting their reply asked for in their own words");
    const approval = commandIn(step, ` next --scope ${shown.base}`);
    expect(approval).not.toContain(sensors);
    const created = nextAsPerson(proj, [...runNamedArgs(approval), sensors, value]);
    const creation = commandIn(created, "intent create");
    expect(creation).toContain(lists(shown.changes).join(" "));
    expect(creation).toContain(`${sensors} ${value}`);
  });

  test("a plan composed again on another scope names the plan shown on its own scope, without the other plan's Guard Policy", () => {
    const proj = installedProject();
    const request = tailor(proj);
    const shown = customPlan(proj, SHOWN);
    personSays(proj, "Approve", before(proj, request));
    // The later plan is enterprise as it stands, whose Guard Policy is its default, strict, typed as composer.md says.
    const enterprise = withEnvAndFreshCaches(POLICY_ENV, () => ({ settings: scopeSettingsOf("enterprise")!, policy: scopeGuardPolicyDefault("enterprise") }));
    expect(enterprise.policy).toBe("strict");
    validate(proj, { stages: stockGrid("enterprise"), scopeSettings: enterprise.settings, guardPolicy: enterprise.policy }, ["--matched", "enterprise"]);

    const step = nextAsPerson(proj, ["--scope", "enterprise", "--guard-policy", "strict", "--request", request]);
    expect(step.message).not.toContain("intent create");
    expect(step.message).toContain("worked out after the person's last message on record");
    nothingCreated(proj);
    const approval = commandIn(step, ` next --scope ${shown.base}`);
    expect(approval).not.toContain("--guard-policy strict");
    const creation = commandIn(nextAsPerson(proj, runNamedArgs(approval)), "intent create");
    expect(creation).toContain(lists(shown.changes).join(" "));
    expect(creation).not.toContain("--guard-policy strict");
  });

  test("with no plan kept before the reply, the plan composed after it is shown once, and the next reply creates it", () => {
    const proj = installedProject();
    const request = tailor(proj);
    personSays(proj, "Approve", before(proj, request));
    const again = customPlan(proj, RECOMPOSED);
    const command = ["--scope", again.base, ...lists(again.changes), "--request", request];

    const step = nextAsPerson(proj, command);
    expect(step.kind, step.message).toBe("print");
    expect(step.message).not.toContain("intent create");
    expect(step.message).toContain("If you worked it out again after their reply, first say: \"I no longer had the plan I showed you, so I worked it out again. Here it is; nothing is set up until you approve it.\"");
    expect(step.message).toContain("end your turn: their next reply creates it");
    nothingCreated(proj);

    // Shown once: the person's next reply makes it the plan shown, and the same command creates it.
    keptAt(proj, new Date(Date.now() - 20_000).toISOString());
    personSays(proj, "Approve", new Date(Date.now() - 10_000));
    const created = nextAsPerson(proj, command);
    expect(commandIn(created, "intent create")).toContain(lists(again.changes).join(" "));

    // A third plan worked out after that reply never loops back here: the step names the plan now shown.
    const third = customPlan(proj, { [SKIPPED]: "SKIP" });
    expect(third.changes).not.toEqual(again.changes);
    const named = nextAsPerson(proj, ["--scope", third.base, ...lists(third.changes), "--request", request]);
    expect(named.message).not.toContain("intent create");
    const approval = commandIn(named, ` next --scope ${again.base}`);
    expect(commandIn(nextAsPerson(proj, runNamedArgs(approval)), "intent create")).toContain(lists(again.changes).join(" "));
  });

  test("the same plan validated again, an edit shown again, and a run with no messages on record create at once", () => {
    // The composer validates the shown plan again after the reply: it is still the plan shown.
    const same = installedProject();
    const sameRequest = tailor(same);
    const shown = customPlan(same, SHOWN);
    personSays(same, "Approve", before(same, sameRequest));
    customPlan(same, SHOWN);
    expect(commandIn(nextAsPerson(same, ["--scope", shown.base, ...lists(shown.changes), "--request", sameRequest]), "intent create"))
      .toContain(lists(shown.changes).join(" "));

    // An edit: the revised plan is shown, and the reply after it approves it.
    const edited = installedProject();
    const editRequest = tailor(edited);
    customPlan(edited, SHOWN);
    personSays(edited, "Edit the plan: skip the requirements step", before(edited, editRequest));
    const revised = customPlan(edited, RECOMPOSED);
    personSays(edited, "Approve");
    expect(commandIn(nextAsPerson(edited, ["--scope", revised.base, ...lists(revised.changes), "--request", editRequest]), "intent create"))
      .toContain(lists(revised.changes).join(" "));

    // No message on record (a host whose prompt hook keeps none): the plan kept last, as before.
    const unrecorded = installedProject();
    const unrecordedRequest = tailor(unrecorded);
    customPlan(unrecorded, SHOWN);
    before(unrecorded, unrecordedRequest);
    const last = customPlan(unrecorded, RECOMPOSED);
    expect(commandIn(nextAsPerson(unrecorded, ["--scope", last.base, ...lists(last.changes), "--request", unrecordedRequest]), "intent create"))
      .toContain(lists(last.changes).join(" "));
  });

  test("a report-only composition gets the step before its entry is spent", () => {
    const proj = installedProject();
    const dispatch = next(proj, ["compose", "--report", "scan.json"]);
    const entry = /--request ([0-9a-f]{8})/.exec(dispatch.message)?.[1] as string;
    const shown = customPlan(proj, SHOWN);
    personSays(proj, "Approve", before(proj, entry));
    const again = customPlan(proj, RECOMPOSED);
    const step = nextAsPerson(proj, ["--scope", again.base, ...lists(again.changes), "--request", entry, "--", "fix the split rounding"]);
    expect(step.message).not.toContain("intent create");
    expect(step.message).toContain("worked out after the person's last message on record");
    const approval = commandIn(step, ` next --scope ${shown.base}`);
    expect(approval).toEndWith(`--request ${entry} -- <creationDescription>`);
    const created = nextAsPerson(proj, [...runNamedArgs(approval.replace(" -- <creationDescription>", "")), "--", "fix the split rounding"]);
    expect(commandIn(created, "intent create")).toContain(lists(shown.changes).join(" "));
  });
});

const pairs = (flat: string[]): Array<[string, string]> =>
  flat.flatMap((token, i) => (i % 2 === 0 ? [[token, flat[i + 1]] as [string, string]] : []));

/** The arguments of a `next` command a step named, as the agent would run them. */
function runNamedArgs(command: string): string[] {
  return command.split(" next ")[1].split(" ").filter(Boolean);
}
