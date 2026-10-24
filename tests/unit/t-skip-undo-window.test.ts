// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:recompose, subcommand:aidlc-orchestrate:report
//
// The line a named skip prints says how long its undo holds. The undo is the opposite flip, and recompose takes it only
// while the work runs and the stage is still ahead, so the line names that window: until the work moves past the
// skipped stage, or, with nothing after it on the plan, until the work is finished. Two live runs read "You can undo
// that any time." and then met the refusal: on Codex the skip of Requirements Analysis, undone at Code Generation's
// gate; on Claude Code on Windows the skip of the deployment stages, undone after the last approval. An add alone keeps
// "any time" (a later "skip it" still works where it stands). Every move is a shipped tool's: intent-create, the
// human-turn hook, then `next` and the commands its step names.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, removeWorkspaceRecord } from "../harness/fixtures.ts";
import { env, exec, next, say, type Exec } from "../harness/aidlc-input-corpus.ts";
import { getField, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
// The gates' own documents are not what this file is about.
const NO_OUTPUT_CHECKS = {
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
};

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const state = (proj: string): string => readFileSync(stateFilePath(proj), "utf-8");
/** The one line the step tells the agent to say. */
const line = (message: string): string => /tell the person in one line: "([^"]*)"/.exec(message)?.[1] ?? "";

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
/** The person types `typed`; the agent runs `next` with `args` and returns its step's message. */
async function step(proj: string, typed: string, args: string[]): Promise<string> {
  await say(proj, typed, "claude");
  const got = await next(proj, args);
  expect(got.status, got.out).toBe(0);
  return String(got.directive?.message ?? "");
}
/** The person's skip, carried out as the step names it; returns the line it tells the agent to say. */
async function skipped(proj: string, typed: string, args: string[]): Promise<{ said: string; undo: string }> {
  const message = await step(proj, typed, args);
  for (const command of named(message, /engine recompose --skip/)) await ran(proj, command);
  const undo = /If they later ask to undo it, run `([^`]+)`/.exec(message)?.[1] ?? "";
  expect(undo, message).not.toBe("");
  return { said: line(message), undo };
}
/** The person moves the work to `stage` with the jump the engine names. */
async function jumpTo(proj: string, stage: string): Promise<void> {
  const message = await step(proj, `/aidlc --stage ${stage}`, ["--stage", stage]);
  for (const command of named(message, /aidlc-jump\.ts execute/)) await ran(proj, command);
  expect((await next(proj, [])).directive?.stage).toBe(stage);
}

/** An express run on existing code, at Reverse Engineering. */
async function expressAtReverseEngineering(): Promise<string> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  removeWorkspaceRecord(proj);
  const made = await exec([process.execPath, UTILITY, "intent-create", "--scope", "express", "--project-type", "brownfield",
    "--label", "due-dates", "--arguments", "add due dates to my todo app", "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  await say(proj, "/aidlc", "claude");
  expect((await next(proj, [])).directive?.stage).toBe("reverse-engineering");
  return proj;
}

describe("t-skip-undo-window: a skip says how long its undo holds", () => {
  test("a skip of a stage ahead: the undo holds until the work moves past it, then the isolated run is the way", async () => {
    const proj = await expressAtReverseEngineering();
    const { said, undo } = await skipped(proj, "1, and skip requirements analysis, i already told you what i want",
      ["--skip", "requirements-analysis"]);
    expect(said).toBe("Skipped Requirements Analysis. You can undo that until the work moves past it.");
    // While Requirements Analysis is still ahead, the undo goes through, and the skip can be made again.
    await ran(proj, undo);
    expect(getField(state(proj), "Current Stage")).toBe("reverse-engineering");
    await skipped(proj, "skip requirements analysis after all", ["--skip", "requirements-analysis"]);
    // Once the work has moved past it, the same undo is refused with the isolated run, as the line said.
    await jumpTo(proj, "code-generation");
    const late = await runNamed(proj, undo);
    expect(late.status).not.toBe(0);
    expect(`${late.stdout}${late.stderr}`).toContain("--stage requirements-analysis --single");
  });

  test("several skipped stages name the earliest one", async () => {
    const proj = await expressAtReverseEngineering();
    const message = await step(proj, "skip requirements analysis and observability setup",
      ["--skip", "requirements-analysis,observability-setup"]);
    expect(line(message)).toBe(
      "Skipped Requirements Analysis and Observability Setup. You can undo that until the work moves past Requirements Analysis.",
    );
  });

  test("a skip of the plan's last stages: the undo holds until the work is finished, and is refused after it", async () => {
    const proj = await expressAtReverseEngineering();
    await jumpTo(proj, "build-and-test");
    const { said, undo } = await skipped(proj, "skip the deployment stages", [
      "--skip", "deployment-pipeline,deployment-execution,observability-setup",
    ]);
    expect(said).toBe(
      "Skipped Deployment Pipeline, Deployment Execution and Observability Setup. You can undo that until the work is finished.",
    );
    await ran(proj, "bun .claude/tools/aidlc-orchestrate.ts report --stage build-and-test --result awaiting-approval");
    await say(proj, "approve", "claude");
    await ran(proj, "bun .claude/tools/aidlc-orchestrate.ts report --stage build-and-test --result approved --user-input Approve");
    expect(getField(state(proj), "Status")).toBe("Completed");
    const late = await runNamed(proj, undo);
    expect(late.status).not.toBe(0);
    expect(`${late.stdout}${late.stderr}`).toContain("Completed");
  });

  test("a skip and an earlier add: the add names the window", async () => {
    const proj = await expressAtReverseEngineering();
    const message = await step(proj, "add user stories and skip observability setup",
      ["--add", "user-stories", "--skip", "observability-setup"]);
    expect(line(message)).toBe("Skipped Observability Setup and added User Stories. You can undo that until User Stories starts.");
  });

  test("a skip typed with a scope switch says the same window", async () => {
    const proj = await expressAtReverseEngineering();
    const message = await step(proj, "switch to the poc plan and skip requirements analysis",
      ["--scope", "poc", "--skip", "requirements-analysis"]);
    expect(line(message)).toBe("Skipped Requirements Analysis. You can undo that until the work moves past it.");
  });

  test("an add alone keeps its way back", async () => {
    const proj = await expressAtReverseEngineering();
    const message = await step(proj, "add user stories", ["--add", "user-stories"]);
    expect(line(message)).toBe("Added User Stories. You can undo that any time.");
  });
});
