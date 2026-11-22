// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:scope-change, function:stageReopenedByScopeChange, function:skipsBeforeReopen
//
// A plan switch reopens finished work at the first stage the new plan runs
// after the last one (#2261, offered since #3207). A skip typed beside the
// switch (`/aidlc --scope feature --skip ci-pipeline` on a finished poc) went to
// recompose after the switch, by which time the switch had started that very
// stage, so recompose refused it as in progress: the skip was lost and the
// stage ran. Now the skips the reopen would otherwise start land first, in the
// switch's own plan write, and the reopen starts at the first stage the person
// did not skip. One walk decides the print and the tool. Every other skip
// still goes to recompose after the switch, refused as before where it was;
// the switch with no skip and a skip beside a switch over running work print
// what they printed before.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  cleanupTestProject,
  createOrchestrationTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const STATE = join(TOOLS, "aidlc-state.ts");
const UTILITY = join(TOOLS, "aidlc-utility.ts");
const ORCH = join(TOOLS, "aidlc-orchestrate.ts");
const LIB = join(TOOLS, "aidlc-lib.ts");

// No chat names itself to the tools: a run from inside a host's own chat would
// otherwise lend the tools that chat.
const noChat: Record<string, string | undefined> = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
for (const key of ["AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID"]) {
  delete noChat[key];
}
let env = noChat;
const SESSION = "01995000-7a11-7000-8000-000000003207";

function run(tool: string, proj: string, args: string[]): { rc: number; out: string } {
  const res = spawnSync(process.execPath, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env,
  });
  return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

type Directive = { kind: string; message?: string; stage?: string; narration?: string; change_notices?: string[] };

function next(proj: string, args: string[] = []): Directive {
  const res = runOrchestrateNext(ORCH, proj, args, { cwd: proj, env });
  expect(res.directive, res.out).not.toBeNull();
  return res.directive as Directive;
}

function recordDir(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  return join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
}
const state = (proj: string): string => readFileSync(join(recordDir(proj), "aidlc-state.md"), "utf-8");
const field = (text: string, name: string): string =>
  new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(text)?.[1].trim() ?? "";
/** A stage's progress row: its box and its plan suffix. */
const row = (text: string, slug: string): string =>
  new RegExp(`^- \\[(.)\\] ${slug} \\u2014 (EXECUTE|SKIP)$`, "m").exec(text)?.slice(1).join(" ") ?? "";
function auditText(proj: string): string {
  const dir = join(recordDir(proj), "audit");
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
    .map((f) => readFileSync(join(dir, f), "utf-8")).join("\n");
}
/** The plan and stage rows, without the setting rows a switch writes beside them. */
const planEvents = (rows: string[]): string[] =>
  rows.filter((e) => e === "SCOPE_CHANGED" || e === "RECOMPOSED" || e === "WORKFLOW_COMPLETED" || e.startsWith("STAGE_"));
const events = (proj: string): string[] =>
  [...auditText(proj).matchAll(/\*\*Event\*\*: ([A-Z_]+)(?:\n\*\*Stage\*\*: ([a-z0-9-]+))?/g)]
    .map((m) => (m[2] ? `${m[1]}:${m[2]}` : m[1]));
const registryStatus = (proj: string): string => {
  const dir = recordDir(proj).split(/[\\/]/).at(-1);
  const rows = JSON.parse(readFileSync(join(proj, "aidlc", "spaces", "default", "intents", "intents.json"), "utf-8")) as
    { dirName: string; status: string }[];
  return rows.find((r) => r.dirName === dir)?.status ?? "";
};

/** Doctor reads the record as it stands: no drift between the state and the audit. */
function noDrift(proj: string): void {
  const said = run(UTILITY, proj, ["doctor"]).out;
  expect(said).not.toContain("State/audit drift");
  expect(said).not.toContain("state-audit-drift");
}

const created: string[] = [];
afterEach(() => {
  env = noChat;
  resetAidlcEnv();
  for (const proj of created.splice(0)) cleanupTestProject(proj);
});

/** A run to its end on `scope`, as complete-workflow leaves it: every stage the plan runs done, Status Completed. */
async function finished(scope: string): Promise<string> {
  const lib = await import(LIB) as typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts");
  const proj = createOrchestrationTestProject();
  created.push(proj);
  expect(run(UTILITY, proj, ["intent-create", "--scope", scope]).rc).toBe(0);
  const grid = lib.scopeGridOnProject(lib.loadScopeMapping()[scope], state(proj));
  const runs = lib.loadStageGraph().filter((stage) => grid[stage.slug] === "EXECUTE");
  const last = runs.at(-1)!;
  expect(run(STATE, proj, ["checkbox", ...runs.map((stage) => `${stage.slug}=completed`)]).rc).toBe(0);
  expect(run(STATE, proj, [
    "set", `Current Stage=${last.slug}`, "Status=Running", `Lifecycle Phase=${last.phase.toUpperCase()}`,
    "Next Stage=none", "In Progress=none", `Last Completed Stage=${last.slug}`,
  ]).rc).toBe(0);
  expect(run(STATE, proj, ["complete-workflow", last.slug]).rc).toBe(0);
  expect(field(state(proj), "Status")).toBe("Completed");
  expect(next(proj).kind).toBe("done");
  return proj;
}

/** A feature run on Feasibility, as `advance` leaves it. */
function featureAtFeasibility(box: "in-progress" | "awaiting-approval"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  expect(run(UTILITY, proj, ["intent-create", "--scope", "feature"]).rc).toBe(0);
  const done = ["workspace-scaffold", "workspace-detection", "state-init", "intent-capture", "market-research"];
  expect(run(STATE, proj, ["checkbox", ...done.map((s) => `${s}=completed`), `feasibility=${box}`]).rc).toBe(0);
  expect(run(STATE, proj, [
    "set", "Current Stage=feasibility", "Status=Running", "Lifecycle Phase=IDEATION",
    "Next Stage=scope-definition", "In Progress=feasibility", "Last Completed Stage=market-research",
  ]).rc).toBe(0);
  return proj;
}

/** The engine commands a print names, in order, as the utility subcommand and its arguments. */
function engineCommands(message: string): string[][] {
  return [...message.matchAll(/`bun \.claude\/tools\/aidlc\.ts engine (scope change|recompose) ([^`]*)`/g)]
    .filter((m) => !message.slice(0, m.index).endsWith("If they later ask to undo it, run "))
    .map((m) => [
      m[1] === "scope change" ? "scope-change" : "recompose",
      ...[...m[2].matchAll(/'([^']*)'|(\S+)/g)].map((t) => t[1] ?? t[2]),
    ]);
}

/** Run what a print names, as the agent would, each through the dist tool. */
function actOn(proj: string, directive: Directive): string {
  expect(directive.kind, JSON.stringify(directive)).toBe("print");
  const commands = engineCommands(directive.message ?? "");
  expect(commands.length, directive.message).toBeGreaterThan(0);
  let out = "";
  for (const command of commands) {
    const res = run(UTILITY, proj, command);
    expect(res.rc, `${command.join(" ")}: ${res.out}`).toBe(0);
    out += res.out;
  }
  return out;
}

const CARRY_ON = "Then re-run `next` to carry on with the work.";
const PERSON_ASKED = "the person asked to skip it";

describe("t-skip-beside-reopen: a skip typed beside a plan switch on finished work lands before the reopen", () => {
  test("a skip of the stage the reopen would start is recorded, and the work reopens at the next stage", async () => {
    const proj = await finished("poc");
    const before = events(proj).length;
    const print = next(proj, ["--scope", "feature", "--skip", "ci-pipeline"]);
    expect(print.kind, JSON.stringify(print)).toBe("print");
    const said = print.message ?? "";
    expect(said).toContain("`bun .claude/tools/aidlc.ts engine scope change --scope feature --skip ci-pipeline`");
    expect(said).not.toContain("recompose");
    expect(said).not.toContain("do not show");
    expect(said).toContain('"Skipped CI Pipeline. It can still be run on its own with `/aidlc --stage ci-pipeline --single`."');
    expect(said.endsWith(CARRY_ON), said).toBe(true);

    const out = actOn(proj, print);
    expect(out).toContain("Switched to feature");
    expect(out).toContain("11 stages (4 done)");
    const text = state(proj);
    expect(field(text, "Status")).toBe("Running");
    expect(field(text, "Current Stage")).toBe("deployment-pipeline");
    expect(row(text, "deployment-pipeline")).toBe("- EXECUTE");
    expect(row(text, "ci-pipeline")).toBe("  SKIP");
    expect(field(text, "Total Stages")).toBe(String(text.match(/^- \[.\] [a-z0-9-]+ \u2014 EXECUTE$/gm)?.length));
    expect(registryStatus(proj)).toBe("in-flight");

    expect(planEvents(events(proj).slice(before))).toEqual(["SCOPE_CHANGED", "RECOMPOSED", "STAGE_STARTED:deployment-pipeline"]);
    const recomposed = /\*\*Event\*\*: RECOMPOSED\n([\s\S]*?)\n---/.exec(auditText(proj))?.[1] ?? "";
    expect(recomposed).toContain("**Stages skipped**: ci-pipeline");
    expect(recomposed).toContain(`**Reason**: ${PERSON_ASKED}`);

    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe("deployment-pipeline");
    expect(step.narration).toContain("of 11");
    expect(events(proj).filter((e) => e === "STAGE_STARTED:ci-pipeline")).toEqual([]);
    noDrift(proj);
  });

  // Agents re-run the flagged command as often as the bare `next` they are
  // told to: the skip has landed, so it is said as done and nothing moves.
  test("re-running the same request after the switch changes nothing, and the work goes on at the reopened stage", async () => {
    const proj = await finished("poc");
    actOn(proj, next(proj, ["--scope", "feature", "--skip", "ci-pipeline"]));
    const landed = state(proj);
    const again = next(proj, ["--scope", "feature", "--skip", "ci-pipeline"]);
    expect(again.kind).toBe("print");
    expect(again.message).toContain("CI Pipeline is already skipped.");
    expect(again.message).not.toContain("engine ");
    expect(state(proj)).toBe(landed);
    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe("deployment-pipeline");
  });

  // With a chat, what the switch did rides the reopened stage's first line, as
  // it does after the switch alone: that stage is the one after the skip.
  test("with a chat, the switch's own line rides the first line of the stage after the skip, once", async () => {
    const lib = await import(LIB) as typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts");
    env = { ...noChat, AIDLC_SESSION_OVERRIDE: SESSION };
    const proj = await finished("poc");
    const print = next(proj, ["--scope", "feature", "--skip", "ci-pipeline"]);
    expect(print.message?.endsWith(CARRY_ON), print.message).toBe(true);
    expect(actOn(proj, print)).not.toContain("Switched to");
    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe("deployment-pipeline");
    const said = (step.change_notices ?? []).join(" ");
    expect(said.startsWith("Switched to feature"), said).toBe(true);
    expect(said).toContain("11 stages (4 done)");
    expect(lib.pendingPersonLines(proj, SESSION).lines).toEqual([]);
    const again = next(proj);
    expect(`${(again.change_notices ?? []).join(" ")} ${again.narration ?? ""}`).not.toContain("Switched to");
  });

  test("skips one after another all land, and the work reopens past them", async () => {
    const proj = await finished("poc");
    const print = next(proj, ["--scope", "feature", "--skip", "ci-pipeline,deployment-pipeline"]);
    const said = print.message ?? "";
    expect(said).toContain("engine scope change --scope feature --skip ci-pipeline,deployment-pipeline`");
    expect(said).not.toContain("recompose");
    expect(said).toContain('"Skipped CI Pipeline and Deployment Pipeline. Either one can still be run on its own with ' +
      "`/aidlc --stage ci-pipeline --single` or `/aidlc --stage deployment-pipeline --single`.\"");
    actOn(proj, print);
    const text = state(proj);
    expect(field(text, "Current Stage")).toBe("environment-provisioning");
    expect(row(text, "ci-pipeline")).toBe("  SKIP");
    expect(row(text, "deployment-pipeline")).toBe("  SKIP");
    expect(next(proj).stage).toBe("environment-provisioning");
  });

  test("a skip further ahead still goes to recompose after the switch, and both land", async () => {
    const proj = await finished("poc");
    const print = next(proj, ["--scope", "feature", "--skip", "ci-pipeline,observability-setup"]);
    const commands = engineCommands(print.message ?? "");
    expect(commands).toEqual([
      ["scope-change", "--scope", "feature", "--skip", "ci-pipeline"],
      ["recompose", "--skip", "observability-setup", "--reason", PERSON_ASKED],
    ]);
    expect(print.message?.endsWith(CARRY_ON), print.message).toBe(true);
    actOn(proj, print);
    const text = state(proj);
    expect(field(text, "Current Stage")).toBe("deployment-pipeline");
    expect(row(text, "ci-pipeline")).toBe("  SKIP");
    expect(row(text, "observability-setup")).toBe("  SKIP");
    expect(next(proj).stage).toBe("deployment-pipeline");
  });

  test("with every stage the switch adds skipped, the work stays finished with the skip on its plan", async () => {
    const proj = await finished("bugfix");
    const before = events(proj).length;
    const print = next(proj, ["--scope", "express", "--skip", "observability-setup"]);
    const said = print.message ?? "";
    expect(said).toContain("engine scope change --scope express --skip observability-setup`");
    expect(said).not.toContain("recompose");
    expect(said).toContain('"Skipped Observability Setup. It can still be run on its own with `/aidlc --stage observability-setup --single`." Then stop.');
    actOn(proj, print);
    const text = state(proj);
    expect(field(text, "Scope")).toBe("express");
    expect(field(text, "Status")).toBe("Completed");
    expect(row(text, "observability-setup")).toBe("  SKIP");
    expect(planEvents(events(proj).slice(before))).toEqual(["SCOPE_CHANGED", "RECOMPOSED"]);
    expect(registryStatus(proj)).toBe("complete");
    expect(next(proj).kind).toBe("done");
    noDrift(proj);
  });
});

describe("t-skip-beside-reopen: everything else prints and does what it did", () => {
  test("the same switch with no skip reopens at the stage it adds, as before", async () => {
    const proj = await finished("poc");
    const print = next(proj, ["--scope", "feature"]);
    expect(print.message).toBe(
      "Run `bun .claude/tools/aidlc.ts engine scope change --scope feature` to change scope, then print its output " +
        "verbatim and re-run next to carry on with the work.",
    );
    expect(run(UTILITY, proj, ["scope-change", "--scope", "feature"]).rc).toBe(0);
    expect(field(state(proj), "Current Stage")).toBe("ci-pipeline");
    expect(row(state(proj), "ci-pipeline")).toBe("- EXECUTE");
  });

  test("a skip of a stage behind the cursor beside the switch still goes to recompose, which refuses it", async () => {
    const proj = await finished("poc");
    const print = next(proj, ["--scope", "feature", "--skip", "functional-design"]);
    expect(engineCommands(print.message ?? "")).toEqual([
      ["scope-change", "--scope", "feature"],
      ["recompose", "--skip", "functional-design", "--reason", PERSON_ASKED],
    ]);
    expect(run(UTILITY, proj, ["scope-change", "--scope", "feature"]).rc).toBe(0);
    const refused = run(UTILITY, proj, ["recompose", "--skip", "functional-design", "--reason", PERSON_ASKED]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("a plan change only reaches stages ahead");
  });

  test("a skip beside a switch over running work prints the step it printed before", () => {
    const ahead = featureAtFeasibility("in-progress");
    expect(next(ahead, ["--scope", "mvp", "--skip", "delivery-planning"]).message).toBe(
      "Run `bun .claude/tools/aidlc.ts engine scope change --scope mvp` and print its output verbatim, then run " +
        "`bun .claude/tools/aidlc.ts engine recompose --skip delivery-planning --reason 'the person asked to skip it'` " +
        "to change this workflow's remaining stages as the person asked, and do not show its output: the one line " +
        "below says what changed. If a command refuses, tell the person in plain words why it could not, and the way " +
        "it names to do it instead, then stop. Otherwise tell the person in one line: \"Skipped Delivery Planning. You " +
        "can undo that until the work moves past it.\" Then stop. If they later ask to undo it, run " +
        "`bun .claude/tools/aidlc.ts engine recompose --add delivery-planning`.",
    );
    const running = featureAtFeasibility("in-progress");
    expect(next(running, ["--scope", "mvp", "--skip", "feasibility"]).message).toBe(
      "Run `bun .claude/tools/aidlc.ts engine scope change --scope mvp` and print its output verbatim, then run " +
        "`bun .claude/tools/aidlc-orchestrate.ts report --stage feasibility --result skipped --reason 'the person " +
        "asked to skip it'` to skip Feasibility & Constraints, which has already started, and do not show its output: " +
        "the one line below says what changed. If a command refuses, tell the person in plain words why it could not, " +
        "and the way it names to do it instead, then stop. Otherwise tell the person in one line: \"Skipped " +
        "Feasibility & Constraints. It can still be run on its own with `/aidlc --stage feasibility --single`.\" Then " +
        "re-run `next` to carry on with the work.",
    );
  });

  test("the scope change takes --skip only for the stages the reopen would start, and writes nothing otherwise", async () => {
    const running = featureAtFeasibility("in-progress");
    const runningBefore = state(running);
    const onRunning = run(UTILITY, running, ["scope-change", "--scope", "mvp", "--skip", "delivery-planning"]);
    expect(onRunning.rc).not.toBe(0);
    expect(onRunning.out).toContain("delivery-planning");
    expect(state(running)).toBe(runningBefore);

    const done = await finished("poc");
    const doneBefore = state(done);
    for (const args of [
      ["--scope", "feature", "--skip", "observability-setup"],
      ["--scope", "feature", "--skip", "functional-design"],
      ["--scope", "feature", "--skip", "no-such-stage"],
      ["--scope", "poc", "--skip", "ci-pipeline"],
    ]) {
      const refused = run(UTILITY, done, ["scope-change", ...args]);
      expect(refused.rc, args.join(" ")).not.toBe(0);
      expect(state(done), args.join(" ")).toBe(doneBefore);
    }
  });

  // The #2261 rule with a skip: for every shipped plan, a skip of the stage the
  // reopen would start makes the print carry on exactly when the tool reopens,
  // at the stage the one walk names.
  test("one walk decides the print and the tool, for every plan that reopens finished work", async () => {
    const lib = await import(LIB) as typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts");
    const utility = await import(UTILITY) as typeof import("../../dist/claude/.claude/tools/aidlc-utility.ts");
    // Nothing is reopened, so nothing is skipped before it: running work, a plan
    // that is not one, and finished work's own plan.
    const running = state(featureAtFeasibility("in-progress"));
    expect(utility.skipsBeforeReopen(running, "mvp", ["feasibility", "delivery-planning"])).toEqual([]);
    const done = state(await finished("poc"));
    expect(utility.skipsBeforeReopen(done, "no-such-plan", ["ci-pipeline"])).toEqual([]);
    expect(utility.skipsBeforeReopen(done, "poc", ["ci-pipeline"])).toEqual([]);
    expect(utility.skipsBeforeReopen(done, "feature", [])).toEqual([]);
    for (const finishedOn of ["poc", "bugfix"]) {
      const probe = await finished(finishedOn);
      const text = state(probe);
      const scopes = Object.keys(lib.loadScopeMapping()).filter((s) => s !== finishedOn).sort();
      for (const scope of scopes) {
        const first = lib.stageReopenedByScopeChange(text, scope);
        if (first === null) continue;
        expect(utility.skipsBeforeReopen(text, scope, [first.slug, "no-such-stage"]), scope).toEqual([first.slug]);
        const predicted = lib.stageReopenedByScopeChange(text, scope, [first.slug]);
        const proj = await finished(finishedOn);
        const print = next(proj, ["--scope", scope, "--skip", first.slug]);
        expect(print.message, `${finishedOn} -> ${scope}`).toContain(`--scope ${scope} --skip ${first.slug}\``);
        actOn(proj, print);
        const after = state(proj);
        const reopened = field(after, "Status") === "Running";
        expect(reopened, `${finishedOn} -> ${scope}`).toBe(predicted !== null);
        expect(print.message?.endsWith(CARRY_ON) ?? false, `${finishedOn} -> ${scope}: ${print.message}`).toBe(reopened);
        expect(row(after, first.slug), `${finishedOn} -> ${scope}`).toBe("  SKIP");
        if (predicted) expect(field(after, "Current Stage"), `${finishedOn} -> ${scope}`).toBe(predicted.slug);
      }
    }
  });
});
