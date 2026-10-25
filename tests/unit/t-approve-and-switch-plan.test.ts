// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:scope-change, subcommand:aidlc-orchestrate:report
//
// "Approve, and switch back to the poc plan" typed at a stage's open gate. The step `next --scope` names runs the
// switch first, then the gate's report for the answer the reply gave, so both land in the same turn: a live Codex run
// switched, stopped with the gate still open, and recorded the approval only on the person's next line. A reply with no
// answer in it still ends the turn at the waiting question. A switch to a plan that drops the waiting stage, and a
// switch over parked work, keep their own steps; a skip at the same gate names the same answer step. Every move is a
// shipped tool's: intent-create, the human-turn hook, then `next` and the commands its step names.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, removeWorkspaceRecord } from "../harness/fixtures.ts";
import { env, exec, next, say, type Exec } from "../harness/aidlc-input-corpus.ts";
import {
  getField,
  readAuditShardEvents,
  stateFilePath,
  turnEndIsOpen,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { readFileSync } from "node:fs";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
// The Build and Test gate's own documents are not what this file is about.
const NO_OUTPUT_CHECKS = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
};
const REPLY = "approve. and switch back to the poc plan, i dont need the deployment stuff after all";
const ANSWER_STEP =
  "If their message also answered the open Build and Test question, record it now with " +
  "`bun .claude/tools/aidlc-orchestrate.ts report --stage build-and-test --result approved --user-input Approve` " +
  '(a change request: `--result rejected --user-input "Request Changes"`) and re-run `next`; ' +
  "otherwise stop: the question still waits.";

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const state = (proj: string): string => readFileSync(stateFilePath(proj), "utf-8");
const box = (proj: string, slug: string): string =>
  new RegExp(`^- \\[(.)\\] ${slug} \u2014 (EXECUTE|SKIP)`, "m").exec(state(proj))?.slice(1).join(" ") ?? "";
const events = (proj: string): string[] => readAuditShardEvents(proj).map((entry) => entry.event);

/** A command a step names (`bun .claude/tools/<tool>.ts ...`), run from the shipped tree on this project. */
async function runNamed(proj: string, command: string): Promise<Exec> {
  const parts = (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^['"]|['"]$/g, ""));
  if (parts[0] === "bun") parts.shift();
  const tool = join(AIDLC_SRC, "tools", (parts.shift() ?? "").replace(/^.*tools\//, ""));
  return exec([process.execPath, tool, ...parts, "--project-dir", proj],
    { cwd: proj, env: env(proj, { env: NO_OUTPUT_CHECKS }) });
}
/** The commands a step names that match `pattern`, in order. */
function named(message: string, pattern: RegExp): string[] {
  return [...message.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((command) => pattern.test(command));
}
async function ran(proj: string, command: string): Promise<Exec> {
  const result = await runNamed(proj, command);
  expect(result.status, `${command}\n${result.stdout}${result.stderr}`).toBe(0);
  return result;
}

/** A run on `scope` at `stage`'s open gate, moved there by the jump the engine names. */
async function atGate(scope: string, stage: string): Promise<string> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  removeWorkspaceRecord(proj);
  const made = await exec([process.execPath, UTILITY, "intent-create", "--scope", scope, "--project-type", "greenfield",
    "--label", "due-dates", "--arguments", "add due dates to my todo app", "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  await say(proj, `/aidlc --stage ${stage}`, "claude");
  const jump = await next(proj, ["--stage", stage]);
  for (const command of named(String(jump.directive?.message ?? ""), /aidlc-jump\.ts execute/)) await ran(proj, command);
  expect((await next(proj, [])).directive?.stage).toBe(stage);
  await ran(proj, `bun .claude/tools/aidlc-orchestrate.ts report --stage ${stage} --result awaiting-approval`);
  expect(box(proj, stage)).toBe("? EXECUTE");
  return proj;
}
const expressAtBuildAndTestGate = (): Promise<string> => atGate("express", "build-and-test");

/** The person's reply through the host's hook, then the `next --scope poc` the agent runs for it. */
async function switchStep(proj: string, reply = REPLY): Promise<string> {
  await say(proj, reply, "claude");
  const step = await next(proj, ["--scope", "poc"]);
  expect(step.status, step.out).toBe(0);
  expect(step.directive?.kind).toBe("print");
  return String(step.directive?.message ?? "");
}

describe("t-approve-and-switch-plan: an approval typed with a plan switch at an open gate is recorded in the same turn", () => {
  test("approve: the switch runs first, then the gate's approval, and the work on the new plan is done", async () => {
    const proj = await expressAtBuildAndTestGate();
    const message = await switchStep(proj);
    expect(message).toContain(ANSWER_STEP);
    const [scopeChange] = named(message, /engine scope change --scope poc/);
    expect(scopeChange, message).toBeDefined();
    expect(message.indexOf(scopeChange)).toBeLessThan(message.indexOf("--result approved"));
    // The step still ends the turn when the reply held no answer.
    expect(turnEndIsOpen(proj)).toBe(true);

    await ran(proj, scopeChange);
    expect(getField(state(proj), "Scope")).toBe("poc");
    expect(box(proj, "build-and-test")).toBe("? EXECUTE");
    await ran(proj, named(message, /--result approved/)[0]);
    expect(box(proj, "build-and-test")).toBe("x EXECUTE");
    expect(getField(state(proj), "Status")).toBe("Completed");
    const log = events(proj);
    expect(log.lastIndexOf("GATE_APPROVED")).toBeGreaterThan(log.lastIndexOf("SCOPE_CHANGED"));
  });

  test("a change request typed with the switch is recorded as Request Changes on the new plan", async () => {
    const proj = await expressAtBuildAndTestGate();
    const message = await switchStep(proj, "switch back to the poc plan, and the test summary needs the slow tests listed");
    await ran(proj, named(message, /engine scope change --scope poc/)[0]);
    const approve = named(message, /--result approved/)[0];
    await ran(proj, approve.replace("--result approved --user-input Approve", '--result rejected --user-input "Request Changes"'));
    expect(getField(state(proj), "Scope")).toBe("poc");
    expect(box(proj, "build-and-test")).toBe("R EXECUTE");
  });

  test("a reply with no answer in it: after the switch the question still waits", async () => {
    const proj = await expressAtBuildAndTestGate();
    const message = await switchStep(proj, "switch back to the poc plan");
    await ran(proj, named(message, /engine scope change --scope poc/)[0]);
    expect(box(proj, "build-and-test")).toBe("? EXECUTE");
    expect((await next(proj, [])).directive?.stage).toBe("build-and-test");
  });

  test("a skip typed at the same gate names the same answer step", async () => {
    const proj = await expressAtBuildAndTestGate();
    await say(proj, "approve, and skip deployment pipeline", "claude");
    const step = await next(proj, ["--skip", "deployment-pipeline"]);
    expect(String(step.directive?.message ?? "")).toContain(ANSWER_STEP);
  });

  test("over parked work the switch keeps its still-paused question and names no gate report", async () => {
    const proj = await expressAtBuildAndTestGate();
    await say(proj, "let's stop here for now", "claude");
    const parked = await exec([process.execPath, ORCHESTRATE, "park", "--project-dir", proj], { cwd: proj, env: env(proj) });
    expect(parked.status, `${parked.stdout}${parked.stderr}`).toBe(0);
    expect(getField(state(proj), "Parked At Stage")).toBe("build-and-test");
    const message = await switchStep(proj);
    expect(message).toContain("Your work is still paused.");
    expect(message).not.toContain("--result approved");
  });

  // Practices Discovery's approval waits for the practices to be saved (practices-promote), so a bare approval
  // report there is refused in engine words: an approval typed with a switch or a skip waits for the person's next
  // message. A change request needs no saving, so it is handed over and recorded at once (Arden's pick).
  const REQUEST_CHANGES = '--result rejected --user-input "Request Changes"';
  test("at Practices Discovery's gate the switch hands over a change request at once, and names no approval report", async () => {
    const proj = await atGate("feature", "practices-discovery");
    await say(proj, "the practices list needs ruff instead of black, and switch to mvp", "claude");
    const step = await next(proj, ["--scope", "mvp"]);
    const message = String(step.directive?.message ?? "");
    expect(message).toContain(`report --stage practices-discovery ${REQUEST_CHANGES}`);
    expect(message).not.toContain("--result approved");
    expect(turnEndIsOpen(proj)).toBe(true);
    await ran(proj, named(message, /engine scope change --scope mvp/)[0]);
    await ran(proj, named(message, /--result rejected/)[0]);
    expect(getField(state(proj), "Scope")).toBe("mvp");
    expect(box(proj, "practices-discovery")).toBe("R EXECUTE");
  });

  test("a skip typed at Practices Discovery's gate hands over a change request at once, and names no approval report", async () => {
    const proj = await atGate("feature", "practices-discovery");
    await say(proj, "the practices list needs ruff instead of black, and skip user stories", "claude");
    const step = await next(proj, ["--skip", "user-stories"]);
    const message = String(step.directive?.message ?? "");
    expect(message).toContain("engine recompose --skip user-stories");
    expect(message).toContain(`report --stage practices-discovery ${REQUEST_CHANGES}`);
    expect(message).not.toContain("--result approved");
    expect(turnEndIsOpen(proj)).toBe(true);
    for (const command of named(message, /engine recompose --skip|--result rejected/)) await ran(proj, command);
    expect(box(proj, "user-stories")).toBe("  SKIP");
    expect(box(proj, "practices-discovery")).toBe("R EXECUTE");
  });

  test("a switch to a plan that does not run the waiting stage skips it with its own line and names no gate report", async () => {
    const proj = await expressAtBuildAndTestGate();
    // poc does not run Deployment Pipeline: the waiting stage here is that one, opened the same way.
    await say(proj, "Approve", "claude");
    await ran(proj, "bun .claude/tools/aidlc-orchestrate.ts report --stage build-and-test --result approved --user-input Approve");
    expect(getField(state(proj), "Current Stage")).toBe("deployment-pipeline");
    expect((await next(proj, [])).directive?.stage).toBe("deployment-pipeline");
    await ran(proj, "bun .claude/tools/aidlc-orchestrate.ts report --stage deployment-pipeline --result awaiting-approval");
    const message = await switchStep(proj);
    expect(message).toContain("to change scope, then print its output verbatim and stop.");
    expect(message).not.toContain("--result approved");
    const switched = await ran(proj, named(message, /engine scope change --scope poc/)[0]);
    expect(switched.stdout).toContain("Skipped Deployment Pipeline (it was waiting for your approval)");
  });
});
