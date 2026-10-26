// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-utility:recompose, subcommand:aidlc-jump:execute, function:owedJumpBack
//
// A stage the person skipped where it stood (it had started, so the skip marked it skipped and the work went on) and
// then asks to have back: the add puts it back on the line, not started, and `next` goes back to it, so it runs next.
// Reverse Engineering left out at the plan pick, the session that found it, runs with the redo while Construction has
// not started; another stage runs with the backward jump while the work has only just entered the stage after it, and
// the Code Generation plan-approval guard lets that one move through. Where the work no longer goes back to it, the
// add is refused with the way to run it on its own, as before. Stages skipped one after another and asked back together
// come back together. The line never says a stage skipped where it stood is already on the plan.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, seededRecordDir } from "../harness/fixtures.ts";
import { getField, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { env, exec, next, projectAt, say, templateProjects, type Exec } from "../harness/aidlc-answers-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");

const projects: string[] = [];
afterAll(() => {
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
});

const tool = (proj: string, path: string, args: string[]): Promise<Exec> =>
  exec([process.execPath, path, ...args, "--project-dir", proj], { cwd: proj, env: env(proj) });
const state = (proj: string): string => readFileSync(stateFilePath(proj), "utf-8");
const row = (proj: string, slug: string): string =>
  new RegExp(`^- \\[.\\] ${slug} \u2014 .*$`, "m").exec(state(proj))?.[0] ?? "";
const current = (proj: string): string => getField(state(proj), "Current Stage") ?? "";
// The command a step names, by the tool and words it starts with.
const named = (message: string, starts: string): string =>
  new RegExp(`\`([^\`]*${starts}[^\`]*)\``).exec(message)?.[1] ?? "";

function guardAllows(proj: string, command: string): { allowed: boolean; said: string } {
  if (!existsSync(join(proj, ".claude", "tools"))) cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
  const r = spawnSync(process.execPath, [join(proj, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    cwd: proj,
    env: env(proj),
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: proj }),
    encoding: "utf-8",
  });
  return { allowed: r.status === 0, said: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The person's skip of a stage that has started, carried out as the step names it: skipped where it stands.
async function skipWhereItStands(proj: string, slug: string, words: string): Promise<void> {
  expect((await say(proj, words, "claude")).status).toBe(0);
  const step = await next(proj, ["--skip", slug]);
  const report = named(String(step.directive?.message ?? ""), `report --stage ${slug} --result skipped`);
  expect(report, step.out).toContain("--reason 'the person asked to skip it'");
  const skipped = await tool(proj, ORCHESTRATE, ["report", "--stage", slug, "--result", "skipped", "--reason", "the person asked to skip it"]);
  expect(skipped.status, skipped.stdout + skipped.stderr).toBe(0);
  expect(row(proj, slug)).toStartWith("- [S] ");
}

// The undo, as the person asks for it in a later message: the add the conductor runs for a stage they name.
async function askBack(proj: string, slug: string, words: string): Promise<string> {
  expect((await say(proj, words, "claude")).status).toBe(0);
  const change = await next(proj, ["--add", slug]);
  expect(change.status, change.out).toBe(0);
  const message = String(change.directive?.message ?? "");
  expect(message, change.out).not.toContain("already on the plan");
  expect(message, change.out).not.toContain("The plan is unchanged.");
  expect(named(message, "recompose"), change.out).toEndWith(`recompose --add ${slug}`);
  return message;
}

describe("a stage skipped where it stood, asked back, goes back on the line", () => {
  test("Reverse Engineering left out at the plan pick and asked back while Requirements Analysis runs runs next", async () => {
    const proj = await projectAt("stage-gate");
    projects.push(proj);
    // The work at Reverse Engineering, as a brownfield bugfix starts.
    const back = await tool(proj, JUMP, ["execute", "--target", "reverse-engineering", "--direction", "backward", "--scope", "bugfix"]);
    expect(back.status, back.stdout + back.stderr).toBe(0);
    expect((await next(proj, [])).directive?.stage).toBe("reverse-engineering");
    await skipWhereItStands(proj, "reverse-engineering", "1, but skip the reverse engineering");
    expect(current(proj)).toBe("requirements-analysis");
    const message = await askBack(proj, "reverse-engineering", "I want the reverse engineering after all, undo the skip");
    expect(message).toContain("Put Reverse Engineering back on the plan.");
    const added = await tool(proj, UTILITY, ["recompose", "--add", "reverse-engineering"]);
    expect(added.status, added.stdout + added.stderr).toBe(0);
    expect(row(proj, "reverse-engineering")).toBe("- [ ] reverse-engineering \u2014 EXECUTE");
    // `next` runs it now with the redo, and the work comes back to Requirements Analysis after it.
    const route = await next(proj, []);
    const redo = named(String(route.directive?.message ?? ""), "aidlc-jump\\.ts execute");
    expect(redo, route.out).toEndWith("execute --target reverse-engineering --direction redo --scope bugfix");
    const jumped = await tool(proj, JUMP, ["execute", "--target", "reverse-engineering", "--direction", "redo", "--scope", "bugfix"]);
    expect(jumped.status, jumped.stdout + jumped.stderr).toBe(0);
    const run = await next(proj, []);
    expect(run.directive?.kind, run.out).toBe("run-stage");
    expect(run.directive?.stage, run.out).toBe("reverse-engineering");
  });

  test("a stage skipped at its own gate and asked back as the next one starts runs next, past the plan-approval guard", async () => {
    const proj = await projectAt("stage-gate");
    projects.push(proj);
    await skipWhereItStands(proj, "requirements-analysis", "skip the requirements analysis");
    expect(current(proj)).toBe("code-generation");
    const message = await askBack(proj, "requirements-analysis", "actually, undo that skip");
    expect(message).toContain("Put Requirements Analysis back on the plan.");
    // It starts in the same turn, as an add the work has just passed over does.
    expect(message).toContain("Then re-run `next` to carry on with the work.");
    const added = await tool(proj, UTILITY, ["recompose", "--add", "requirements-analysis"]);
    expect(added.status, added.stdout + added.stderr).toBe(0);
    expect(row(proj, "requirements-analysis")).toBe("- [ ] requirements-analysis \u2014 EXECUTE");
    const route = await next(proj, []);
    const jump = named(String(route.directive?.message ?? ""), "aidlc-jump\\.ts execute");
    expect(jump, route.out).toEndWith("execute --target requirements-analysis --direction backward --scope bugfix");
    const guard = guardAllows(proj, jump);
    expect(guard.allowed, guard.said).toBe(true);
    const jumped = await tool(proj, JUMP, ["execute", "--target", "requirements-analysis", "--direction", "backward", "--scope", "bugfix"]);
    expect(jumped.status, jumped.stdout + jumped.stderr).toBe(0);
    // The person never stood at Code Generation, so the move back says nothing.
    expect(jumped.stdout).not.toContain("Moved back to");
    const run = await next(proj, []);
    expect(run.directive?.kind, run.out).toBe("run-stage");
    expect(run.directive?.stage, run.out).toBe("requirements-analysis");
  });

  test("two stages skipped where they stood one after the other, asked back together, both go back and the first runs next", async () => {
    const proj = await projectAt("stage-gate");
    projects.push(proj);
    await skipWhereItStands(proj, "requirements-analysis", "skip the requirements analysis");
    await skipWhereItStands(proj, "code-generation", "skip the code generation too");
    expect(current(proj)).toBe("build-and-test");
    const both = "requirements-analysis,code-generation";
    const message = await askBack(proj, both, "actually, undo both skips");
    expect(message).toContain("Put Requirements Analysis and Code Generation back on the plan.");
    expect(message).toContain("Then re-run `next` to carry on with the work.");
    const added = await tool(proj, UTILITY, ["recompose", "--add", both]);
    expect(added.status, added.stdout + added.stderr).toBe(0);
    expect(row(proj, "requirements-analysis")).toBe("- [ ] requirements-analysis \u2014 EXECUTE");
    expect(row(proj, "code-generation")).toBe("- [ ] code-generation \u2014 EXECUTE");
    const route = await next(proj, []);
    const jump = named(String(route.directive?.message ?? ""), "aidlc-jump\\.ts execute");
    expect(jump, route.out).toEndWith("execute --target requirements-analysis --direction backward --scope bugfix");
  });

  test("once the stage after it has work of its own, the add names the way to run it on its own, as before", async () => {
    const proj = await projectAt("stage-gate");
    projects.push(proj);
    await skipWhereItStands(proj, "requirements-analysis", "skip the requirements analysis");
    const plan = join(seededRecordDir(proj), "construction", "code-generation", "code-generation-plan.md");
    mkdirSync(join(plan, ".."), { recursive: true });
    writeFileSync(plan, "# Code Generation Plan\n", "utf-8");
    await askBack(proj, "requirements-analysis", "actually, undo that skip");
    const before = state(proj);
    const refused = await tool(proj, UTILITY, ["recompose", "--add", "requirements-analysis"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain(
      "its checkbox is not pending ([skipped]), so the plan can no longer change it. " +
        "To run it on its own, type `/aidlc --stage requirements-analysis --single`.",
    );
    expect(state(proj)).toBe(before);
  });
});
