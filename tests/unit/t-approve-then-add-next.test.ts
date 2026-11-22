// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-utility:recompose, subcommand:aidlc-jump:execute, function:owedJumpBack
//
// "Approve, and add <Stage> next" when the agent records the approval first: the approval moves the work past the
// stage the plan skips and starts the next one, so the add then names a stage behind the cursor. While nothing after
// it has started (the stage the work just entered has nothing in the record), recompose takes the add, the plan-change
// step carries on, `next` goes back to the stage with the backward jump (which says nothing: the person never stood at
// the stage the approval had just entered) and the stage runs, leaving the state the add-first order leaves
// (t-approve-and-add-walk). The Code Generation plan-approval guard lets that one jump through (it is the person's
// add carried out, and nothing is built yet); any other jump, and the code, still wait for them. The rule's own words
// cover the add typed in the next message, after a jump, or at a workflow's start, while nothing after it has
// started. The jump's notice is also left out when the person themselves asks to go back to the added stage before
// `next` ran the route: it would name a place they never were. Once anything after the stage has started, a stage
// behind the cursor stays refused as before, and a scope change's stages behind the cursor stay as the scope change
// leaves them. The same door, read from the same check as `next` (owedJumpBack), lets through the redo `next` names
// to run Reverse Engineering the person left out at the plan pick and put back while Requirements Analysis ran, and
// nothing wider.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, removeWorkspaceRecord, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  getField,
  latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents,
  recordDir,
  setGuardPolicyLine,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { env, exec, next, projectAt, say, templateProjects, type Exec } from "../harness/aidlc-answers-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const POLICIES = ["off", "relaxed", "strict"] as const;
type Policy = (typeof POLICIES)[number];
// The added stage's own documents and review are not what this walk is about.
const NO_OUTPUT_CHECKS = {
  // The stage's checks before its review (completionChecksStep) are not this walk either.
  AIDLC_DISABLE_SENSORS: "1",
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
};

const projects: string[] = [];
afterAll(() => {
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
});

// The Requirements Analysis gate open on a bugfix plan, User Stories an unchecked box marked SKIP.
async function gateAt(policy: Policy = "relaxed"): Promise<string> {
  const proj = await projectAt("stage-gate");
  projects.push(proj);
  const file = seededStateFile(proj);
  writeFileSync(file, setGuardPolicyLine(readFileSync(file, "utf-8"), `${policy} (set by you)`));
  return proj;
}

const tool = (proj: string, path: string, args: string[], extra: Record<string, string> = {}): Promise<Exec> =>
  exec([process.execPath, path, ...args, "--project-dir", proj], { cwd: proj, env: env(proj, { env: extra }) });
const state = (proj: string): string => readFileSync(stateFilePath(proj), "utf-8");
const checkbox = (proj: string, slug: string): string | undefined =>
  new RegExp(`^- \\[(.)\\] ${slug} \u2014`, "m").exec(state(proj))?.[1];
const current = (proj: string): string => getField(state(proj), "Current Stage") ?? "";
const events = (proj: string) => readAuditShardEvents(proj);
const approvals = (proj: string, stage: string) => events(proj)
  .filter((row) => row.event === "GATE_APPROVED" && auditBlockField(row.block, "Stage") === stage);
const lastJson = (out: string): Record<string, unknown> =>
  JSON.parse(out.trim().split("\n").findLast((line) => line.startsWith("{")) ?? "{}") as Record<string, unknown>;
// The state with its clock left out, to set one walk's record beside another's.
const comparable = (proj: string): string => state(proj).replace(/^- \*\*Last Updated\*\*: .*$/gm, "");

// The person approves (their own turn, unless it came with the line before), and the agent records it.
// The Code Generation plan-approval guard's answer to the agent running `command`, as Claude Code's hook asks it in
// a project with AI-DLC installed (the guard knows the engine's own commands by the installed tools).
function guardAllows(proj: string, command: string, write?: string): { allowed: boolean; said: string } {
  return guardAllowsCall(proj, write === undefined
    ? { tool_name: "Bash", tool_input: { command } }
    : { tool_name: "Write", tool_input: { file_path: join(proj, write), content: command } });
}

function guardAllowsCall(proj: string, call: { tool_name: string; tool_input: Record<string, string> }): { allowed: boolean; said: string } {
  if (!existsSync(join(proj, ".claude", "tools"))) cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
  const r = spawnSync(process.execPath, [join(proj, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    cwd: proj,
    env: env(proj),
    input: JSON.stringify({ hook_event_name: "PreToolUse", ...call, cwd: proj }),
    encoding: "utf-8",
  });
  return { allowed: r.status === 0, said: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function approve(proj: string, stage: string, said = true): Promise<void> {
  if (said) expect((await say(proj, "Approve", "claude")).status).toBe(0);
  const input = "Approve";
  const approved = await tool(proj, ORCHESTRATE, ["report", "--stage", stage, "--result", "approved", "--user-input", input], NO_OUTPUT_CHECKS);
  expect(approved.status, approved.stdout + approved.stderr).toBe(0);
}

// A stage run to its gate the way a run leaves it: its documents written, its reviewer's READY on record, the gate open.
async function runToGate(proj: string, stage: string): Promise<void> {
  const node = findStageBySlug(stage)!;
  const dir = join(recordDir(proj) as string, node.phase, stage);
  mkdirSync(dir, { recursive: true });
  for (const name of node.produces ?? []) {
    const file = join(dir, artifactFilename(name));
    writeFileSync(file, `# ${name}\n\n- Task: a title that is never blank.\n`, "utf-8");
    appendAuditEntry("ARTIFACT_CREATED", { File: file }, proj);
  }
  if (node.reviewer) {
    const base = ["review", "--stage", stage, "--reviewer", node.reviewer, "--iteration", "1"];
    const asked = await tool(proj, LOG, base, NO_OUTPUT_CHECKS);
    expect(asked.status, asked.stdout + asked.stderr).toBe(0);
    const reviewFile = (lastJson(asked.stdout) as { reviewFile?: string }).reviewFile;
    expect(reviewFile, asked.stdout).toBeDefined();
    writeFileSync(join(proj, reviewFile as string),
      `## Review\n\n**Verdict:** READY\n**Reviewer:** ${node.reviewer}\n**Date:** 2026-01-01T00:00:00Z\n**Iteration:** 1\n\n` +
        "### Findings\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n### Summary\n\nReady.\n", "utf-8");
    const ready = await tool(proj, LOG, [...base, "--verdict", "READY"], NO_OUTPUT_CHECKS);
    expect(ready.status, ready.stdout + ready.stderr).toBe(0);
  }
  const gate = await tool(proj, ORCHESTRATE, ["report", "--stage", stage, "--result", "awaiting-approval"], NO_OUTPUT_CHECKS);
  expect(gate.status, gate.stdout + gate.stderr).toBe(0);
}

// The agent's order the live runs met: the approval first, then `next --add <stage>` and the recompose its step names.
async function approveThenAdd(proj: string, gate: string, added: string): Promise<string> {
  expect((await say(proj, `Approve, and add ${findStageBySlug(added)?.name} next`, "claude")).status).toBe(0);
  await approve(proj, gate, false);
  const change = await next(proj, ["--add", added]);
  expect(change.status, change.out).toBe(0);
  const message = String(change.directive?.message ?? "");
  expect(message, change.out).toContain(`recompose --add ${added}`);
  // The stage starts in the same turn, as it does when the add comes first.
  expect(message, change.out).toContain("Then re-run `next` to carry on with the work.");
  expect(message, change.out).not.toContain("Then stop.");
  const recomposed = await tool(proj, UTILITY, ["recompose", "--add", added]);
  expect(recomposed.status, recomposed.stdout + recomposed.stderr).toBe(0);
  return message;
}

// `next` names the backward jump to the added stage; the jump runs and keeps no line for the person; the stage starts.
async function routedBack(proj: string, added: string, scope = "bugfix"): Promise<void> {
  const route = await next(proj, []);
  expect(route.status, route.out).toBe(0);
  expect(route.directive?.kind, route.out).toBe("print");
  expect(String(route.directive?.message), route.out).toContain(`execute --target ${added} --direction backward --scope ${scope}`);
  // The guards let the agent run the step as named (the Code Generation one arms on the stage the approval entered).
  const named = /`([^`]*aidlc-jump\.ts execute[^`]*)`/.exec(String(route.directive?.message))?.[1] ?? "";
  const guard = guardAllows(proj, named);
  expect(guard.allowed, guard.said).toBe(true);
  const jumped = await tool(proj, JUMP, ["execute", "--target", added, "--direction", "backward", "--scope", scope]);
  expect(jumped.status, jumped.stdout + jumped.stderr).toBe(0);
  expect(lastJson(jumped.stdout).notice, jumped.stdout).toBeUndefined();
  const started = await next(proj, []);
  expect(started.status, started.out).toBe(0);
  expect(started.directive?.kind, started.out).toBe("run-stage");
  expect(started.directive?.stage, started.out).toBe(added);
  expect(started.out).not.toContain("Moved back to");
  expect(current(proj)).toBe(added);
  expect(events(proj).filter((row) => row.event === "PLAN_APPROVAL_BLOCKED")).toEqual([]);
}

describe("t-approve-then-add-next: the approval recorded first, the add of the stage it just passed over still lands", () => {
  for (const policy of POLICIES) {
    test(`${policy}: at Requirements Analysis, approve, then add User Stories: User Stories runs, then Code Generation`, async () => {
      const proj = await gateAt(policy);
      await approveThenAdd(proj, "requirements-analysis", "user-stories");
      const floor = latestMainWorkflowStageRunFloorForProject(proj, "requirements-analysis");
      await routedBack(proj, "user-stories");
      expect(approvals(proj, "requirements-analysis")).toHaveLength(1);
      expect(latestMainWorkflowStageRunFloorForProject(proj, "requirements-analysis")).toBe(floor);

      // The record of the work is the one the add-first order leaves.
      const first = await gateAt(policy);
      expect((await say(first, "Approve, and add User Stories next", "claude")).status).toBe(0);
      expect((await tool(first, UTILITY, ["recompose", "--add", "user-stories"])).status).toBe(0);
      await approve(first, "requirements-analysis", false);
      expect(comparable(proj)).toBe(comparable(first));

      // After User Stories' approval the work goes on to Code Generation, and nothing goes back again.
      await runToGate(proj, "user-stories");
      await approve(proj, "user-stories");
      const after = await next(proj, []);
      expect(after.directive?.kind, after.out).toBe("run-stage");
      expect(after.directive?.stage, after.out).toBe("code-generation");
      expect(approvals(proj, "requirements-analysis")).toHaveLength(1);
    });

    test(`${policy}: at Domain Design, approve, then add Units Generation: Units Generation runs next`, async () => {
      // The person put Domain Design on this bugfix plan at the Requirements Analysis gate; Units Generation stays skipped.
      const proj = await gateAt(policy);
      expect((await say(proj, "Approve, and add Domain Design", "claude")).status).toBe(0);
      expect((await tool(proj, UTILITY, ["recompose", "--add", "domain-design"])).status).toBe(0);
      await approve(proj, "requirements-analysis");
      expect((await next(proj, [])).directive?.stage).toBe("domain-design");
      await runToGate(proj, "domain-design");
      await approveThenAdd(proj, "domain-design", "units-generation");
      await routedBack(proj, "units-generation");
      expect(approvals(proj, "domain-design")).toHaveLength(1);
    });
  }

  test("refactor: approve Functional Design, then add NFR Requirements: its files are no work of Code Generation's", async () => {
    // A refactor runs Functional Design, skips NFR Requirements and goes on to Code Generation.
    const proj = await gateAt();
    removeWorkspaceRecord(proj);
    const made = await tool(proj, UTILITY, ["intent-create", "--scope", "refactor", "--project-type", "greenfield",
      "--label", "title-check", "--arguments", "refactor the blank-title check into one place"]);
    expect(made.status, made.stdout + made.stderr).toBe(0);
    expect((await say(proj, "/aidlc", "claude")).status).toBe(0);
    expect((await next(proj, [])).directive?.stage).toBe("requirements-analysis");
    await runToGate(proj, "requirements-analysis");
    await approve(proj, "requirements-analysis");
    expect(current(proj)).toBe("functional-design");
    await runToGate(proj, "functional-design");
    await approveThenAdd(proj, "functional-design", "nfr-requirements");
    await routedBack(proj, "nfr-requirements", "refactor");
    expect(approvals(proj, "functional-design")).toHaveLength(1);
    expect(checkbox(proj, "functional-design")).toBe("x");
  });

  test("inside one phase: Domain Design just entered, the add of User Stories behind it lands with no phase change", async () => {
    const proj = await gateAt();
    expect((await tool(proj, UTILITY, ["recompose", "--add", "domain-design"])).status).toBe(0);
    await approveThenAdd(proj, "requirements-analysis", "user-stories");
    expect(current(proj)).toBe("domain-design");
    const before = events(proj).length;
    await routedBack(proj, "user-stories");
    expect(events(proj).slice(before).map((row) => row.event).filter((event) => event.startsWith("PHASE_"))).toEqual([]);
    expect(checkbox(proj, "domain-design")).toBe(" ");
    await runToGate(proj, "user-stories");
    await approve(proj, "user-stories");
    expect((await next(proj, [])).directive?.stage).toBe("domain-design");
  });

  test("a new chat before `next` ran still goes back to the added stage", async () => {
    const proj = await gateAt();
    await approveThenAdd(proj, "requirements-analysis", "user-stories");
    const other = { session: "01995000-7a11-7000-8000-00000000d0c2" };
    expect((await say(proj, "/aidlc", "claude", other)).status).toBe(0);
    const route = await next(proj, [], other);
    expect(String(route.directive?.message), route.out).toContain("execute --target user-stories --direction backward");
  });

  test("after a jump past Requirements Analysis, the add of User Stories lands; one with a skipped row after it does not", async () => {
    const proj = await gateAt();
    // The person's `--stage` makes the jump in that `next`, which returns Code Generation's step.
    const jump = await next(proj, ["--stage", "code-generation"]);
    expect(jump.status, jump.out).toBe(0);
    expect(jump.directive?.stage, jump.out).toBe("code-generation");
    expect(current(proj)).toBe("code-generation");
    expect(checkbox(proj, "requirements-analysis")).toBe("S");
    const pd = await tool(proj, UTILITY, ["recompose", "--add", "practices-discovery"]);
    expect(pd.status).not.toBe(0);
    expect(pd.stdout + pd.stderr).toContain("behind the current stage");
    const added = await tool(proj, UTILITY, ["recompose", "--add", "user-stories"]);
    expect(added.status, added.stdout + added.stderr).toBe(0);
    await routedBack(proj, "user-stories");
  });

  test("once the stage after it has anything written, the add stays refused", async () => {
    const proj = await gateAt();
    await approve(proj, "requirements-analysis");
    expect(current(proj)).toBe("code-generation");
    const plan = join(seededRecordDir(proj), "construction", "code-generation", "code-generation-plan.md");
    mkdirSync(join(plan, ".."), { recursive: true });
    writeFileSync(plan, "# Code Generation Plan\n\n- [ ] Step 1: refuse a blank title.\n", "utf-8");
    const before = state(proj);
    const refused = await tool(proj, UTILITY, ["recompose", "--add", "user-stories"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("behind the current stage");
    expect(state(proj)).toBe(before);

    // The same for a Unit's own Code Generation folder.
    const unit = await gateAt();
    await approve(unit, "requirements-analysis");
    const unitPlan = join(seededRecordDir(unit), "construction", "todo-core", "code-generation", "code-generation-plan.md");
    mkdirSync(join(unitPlan, ".."), { recursive: true });
    writeFileSync(unitPlan, "# Code Generation Plan\n", "utf-8");
    const perUnit = await tool(unit, UTILITY, ["recompose", "--add", "user-stories"]);
    expect(perUnit.status).not.toBe(0);
    expect(perUnit.stdout + perUnit.stderr).toContain("behind the current stage");

    // The same inside Inception: Domain Design's questions written.
    const dd = await gateAt();
    expect((await tool(dd, UTILITY, ["recompose", "--add", "domain-design"])).status).toBe(0);
    await approve(dd, "requirements-analysis");
    const questions = join(seededRecordDir(dd), "inception", "domain-design", "domain-design-questions.md");
    mkdirSync(join(questions, ".."), { recursive: true });
    writeFileSync(questions, "# Questions\n\n## Q1\n\nOne service or two?\n\n[Answer]: \n", "utf-8");
    const inside = await tool(dd, UTILITY, ["recompose", "--add", "user-stories"]);
    expect(inside.status).not.toBe(0);
    expect(inside.stdout + inside.stderr).toContain("behind the current stage");
  });

  test("the undo the add's line names, asked for before `next` goes back, puts the plan back", async () => {
    const proj = await gateAt();
    const message = await approveThenAdd(proj, "requirements-analysis", "user-stories");
    const undo = /If they later ask to undo it, run `[^`]*?engine (recompose [^`]*)`/.exec(message)?.[1];
    expect(undo, message).toContain("--skip user-stories");
    // The command's words as a shell reads them: a quoted reason is one argument.
    const words = ((undo as string).match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((arg) => arg.replace(/^['"]|['"]$/g, ""));
    const undone = await tool(proj, join(AIDLC_SRC, "tools", "aidlc.ts"), ["engine", ...words]);
    expect(undone.status, undone.stdout + undone.stderr).toBe(0);
    expect(state(proj)).toMatch(/^- \[ \] user-stories \u2014 SKIP/m);
    const after = await next(proj, []);
    expect(after.out).not.toContain("--direction backward");
    expect(after.directive?.stage, after.out).toBe("code-generation");
  });

  test("at Code Generation just entered, the guard lets through only the move back to the added stage", async () => {
    const proj = await gateAt("strict");
    await approveThenAdd(proj, "requirements-analysis", "user-stories");
    expect(current(proj)).toBe("code-generation");
    const jump = "bun .claude/tools/aidlc-jump.ts execute";
    // The move back, in each spelling the jump tool takes.
    for (const command of [
      `${jump} --target user-stories --direction backward --scope bugfix`,
      `${jump} --target=user-stories --direction=backward --scope=bugfix`,
      "bun .claude/tools/aidlc.ts engine jump execute --target user-stories --direction backward --scope bugfix",
    ]) {
      const back = guardAllows(proj, command);
      expect(back.allowed, `${command}: ${back.said}`).toBe(true);
    }
    // Still waiting for the person: any other jump, and the code.
    for (const command of [
      `${jump} --target requirements-analysis --direction backward --scope bugfix`,
      `${jump} --target user-stories --direction forward --scope bugfix`,
      `${jump} --target user-stories --direction redo --scope bugfix`,
      "bun .claude/tools/aidlc-jump.ts reopen --target user-stories --units todo-core",
    ]) {
      const other = guardAllows(proj, command);
      expect(other.allowed, `${command}: ${other.said}`).toBe(false);
    }
    const code = guardAllows(proj, "export const refuseBlankTitle = true;\n", "src/todo.ts");
    expect(code.allowed, code.said).toBe(false);
    // Once Code Generation has something written, the move back waits too.
    const plan = join(seededRecordDir(proj), "construction", "code-generation", "code-generation-plan.md");
    mkdirSync(join(plan, ".."), { recursive: true });
    writeFileSync(plan, "# Code Generation Plan\n", "utf-8");
    const late = guardAllows(proj, `${jump} --target user-stories --direction backward --scope bugfix`);
    expect(late.allowed, late.said).toBe(false);
  });

  // A live run on Kiro CLI: the plan picked without Reverse Engineering ("1, but skip the reverse engineering"),
  // then "I want the reverse engineering after all, undo the skip" while Requirements Analysis ran, then the
  // approval. `next` named the redo that runs Reverse Engineering now, the Code Generation guard refused it, and
  // `next` named it again: a loop the person could leave only by turning plan approval off.
  test("Reverse Engineering left out at the plan pick and put back during Requirements Analysis runs after the approval", async () => {
    const proj = await gateAt();
    // The plan the person picked leaves Reverse Engineering out, as creation's --skip writes its row.
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8")
      .replace(/^- \[x\] reverse-engineering \u2014 EXECUTE$/m, "- [ ] reverse-engineering \u2014 SKIP"));
    expect((await say(proj, "I want the reverse engineering after all, undo the skip", "claude")).status).toBe(0);
    const change = await next(proj, ["--add", "reverse-engineering"]);
    expect(String(change.directive?.message), change.out).toContain("recompose --add reverse-engineering");
    const added = await tool(proj, UTILITY, ["recompose", "--add", "reverse-engineering"]);
    expect(added.status, added.stdout + added.stderr).toBe(0);
    expect(events(proj).some((row) =>
      row.event === "RECOMPOSED" && auditBlockField(row.block, "Stages added") === "reverse-engineering")).toBe(true);
    expect(state(proj)).toMatch(/^- \[ \] reverse-engineering \u2014 EXECUTE/m);
    await approve(proj, "requirements-analysis");
    expect(current(proj)).toBe("code-generation");
    const route = await next(proj, []);
    expect(route.directive?.kind, route.out).toBe("print");
    const named = /`([^`]*aidlc-jump\.ts execute[^`]*)`/.exec(String(route.directive?.message))?.[1] ?? "";
    expect(named, route.out).toEndWith("execute --target reverse-engineering --direction redo --scope bugfix");
    // The door is the step: another jump to it, or a redo of the stage just approved, waits for the person.
    const jump = named.slice(0, named.indexOf(" --target"));
    for (const command of [
      `${jump} --target reverse-engineering --direction backward --scope bugfix`,
      `${jump} --target requirements-analysis --direction redo --scope bugfix`,
    ]) {
      const other = guardAllows(proj, command);
      expect(other.allowed, `${command}: ${other.said}`).toBe(false);
    }
    const blocked = events(proj).filter((row) => row.event === "PLAN_APPROVAL_BLOCKED").length;
    const guard = guardAllows(proj, named);
    expect(guard.allowed, guard.said).toBe(true);
    expect(events(proj).filter((row) => row.event === "PLAN_APPROVAL_BLOCKED").length).toBe(blocked);
    const jumped = await tool(proj, JUMP, ["execute", "--target", "reverse-engineering", "--direction", "redo", "--scope", "bugfix"]);
    expect(jumped.status, jumped.stdout + jumped.stderr).toBe(0);
    const run = await next(proj, []);
    expect(run.directive?.kind, run.out).toBe("run-stage");
    expect(run.directive?.stage, run.out).toBe("reverse-engineering");
    // Its developer scan is dispatched and recorded, and its approval returns the work to Code Generation.
    const scan = guardAllowsCall(proj, { tool_name: "Task", tool_input: {
      subagent_type: "aidlc-developer-agent", description: "Reverse Engineering developer scan",
      prompt: "Scan the code for Reverse Engineering and write developer-scan.md.",
    } });
    expect(scan.allowed, scan.said).toBe(true);
    const scanFile = join(recordDir(proj) as string, "inception", "reverse-engineering", "developer-scan.md");
    mkdirSync(join(scanFile, ".."), { recursive: true });
    writeFileSync(scanFile, "# Developer scan\n\n- One module, one entry point.\n", "utf-8");
    const link = await tool(proj, LOG, ["link", "--stage", "reverse-engineering", "--link", "aidlc-developer-agent",
      "--artifact", relative(proj, scanFile)], NO_OUTPUT_CHECKS);
    expect(link.status, link.stdout + link.stderr).toBe(0);
    await runToGate(proj, "reverse-engineering");
    await approve(proj, "reverse-engineering");
    expect(current(proj)).toBe("code-generation");
    const back = await next(proj, []);
    expect(back.directive?.kind, back.out).toBe("run-stage");
    expect(back.directive?.stage, back.out).toBe("code-generation");
    // Code Generation's plan approval still holds the code.
    const code = guardAllows(proj, "export const refuseBlankTitle = true;\n", "src/todo.ts");
    expect(code.allowed, code.said).toBe(false);
  });

  test("with plan approval off, the move back goes through as any step does", async () => {
    const proj = await gateAt();
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace(/^(- \*\*Guard Policy\*\*:.*)$/m, "$1\n- **Plan Approval**: off (set by you)"));
    expect(getField(state(proj), "Plan Approval")).toBe("off (set by you)");
    await approveThenAdd(proj, "requirements-analysis", "user-stories");
    await routedBack(proj, "user-stories");
  });

  test("a plan whose rows say EXECUTE behind the cursor with no add recorded is left as it is", async () => {
    const proj = await gateAt();
    await approve(proj, "requirements-analysis");
    const file = seededStateFile(proj);
    writeFileSync(file, readFileSync(file, "utf-8").replace(/^(- \[ \] user-stories \u2014 )SKIP\b/m, "$1EXECUTE"));
    expect(state(proj)).toMatch(/^- \[ \] user-stories \u2014 EXECUTE/m);
    const after = await next(proj, []);
    expect(after.out).not.toContain("--direction backward");
    expect(after.directive?.stage, after.out).toBe("code-generation");
  });

  test("a stage behind one the work finished stays refused", async () => {
    const proj = await gateAt();
    await approve(proj, "requirements-analysis");
    const refused = await tool(proj, UTILITY, ["recompose", "--add", "practices-discovery"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("behind the current stage");
  });

  test("a scope change's stages behind the cursor stay as it leaves them: `next` does not go back", async () => {
    const proj = await gateAt();
    await approve(proj, "requirements-analysis");
    const change = await next(proj, ["--scope", "feature"]);
    const command = /`([^`]*scope change --scope feature[^`]*)`/.exec(String(change.directive?.message))?.[1];
    expect(command, change.out).toBeDefined();
    const args = (command as string).replace(/^.*?engine /, "").split(" ");
    const switched = await tool(proj, join(AIDLC_SRC, "tools", "aidlc.ts"), ["engine", ...args]);
    expect(switched.status, switched.stdout + switched.stderr).toBe(0);
    expect(getField(state(proj), "Scope")).toBe("feature");
    const after = await next(proj, []);
    expect(after.out).not.toContain("--direction backward");
    expect(current(proj)).toBe("code-generation");
  });
});
