// covers: subcommand:aidlc-jump:execute, subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:recompose, subcommand:aidlc-orchestrate:next
//
// A scope switch that drops the stage the work is on, or one it jumped past, then a go-back to an earlier stage. The
// go-back resets every stage after its target, so a stage the new plan skips and the work never finished reads not
// started again, as intent creation writes it. Then adding it back, returning to it (the go-back's own line says the
// person can) and switching back to a scope that runs it all reach it, instead of a refusal naming an isolated run, or
// the router walking past it without a word. A stage the work finished keeps its box, and the go-back names only the
// stages on the plan as reset. Every move is a shipped tool's: intent-create, then `next` and the command its step names
// (a jump `next` makes itself names none).

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, removeWorkspaceRecord } from "../harness/fixtures.ts";
import { env, exec, next, say, type Exec } from "../harness/aidlc-input-corpus.ts";
import {
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  getField,
  nextInScopeStage,
  readAuditShardEvents,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
// The User Stories gate's own documents and review are not what this file is about.
const NO_OUTPUT_CHECKS = {
  // The stage's checks before its review (completionChecksStep) are not this walk either.
  AIDLC_DISABLE_SENSORS: "1",
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
};

const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const state = (proj: string): string => readFileSync(stateFilePath(proj), "utf-8");
const box = (proj: string, slug: string): string =>
  new RegExp(`^- \\[(.)\\] ${slug} \u2014 (EXECUTE|SKIP)`, "m").exec(state(proj))?.slice(1).join(" ") ?? "";
const after = (proj: string, slug: string, scope: string): string | undefined =>
  nextInScopeStage(slug, scope, state(proj))?.slug;
/** The documents the last go-back recorded as invalidated. */
function invalidated(proj: string): string {
  const row = readAuditShardEvents(proj).findLast((entry) => entry.event === "STAGE_JUMPED");
  expect(row).toBeDefined();
  return auditBlockField(row?.block ?? "", "Invalidated Downstream Artifacts") ?? "";
}

/** A command a step names (`bun .claude/tools/<tool>.ts ...`), run from the shipped tree on this project. */
async function runNamed(proj: string, command: string, extra: Record<string, string> = {}): Promise<Exec> {
  const parts = (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((part) => part.replace(/^['"]|['"]$/g, ""));
  if (parts[0] === "bun") parts.shift();
  const tool = join(AIDLC_SRC, "tools", (parts.shift() ?? "").replace(/^.*tools\//, ""));
  return exec([process.execPath, tool, ...parts, "--project-dir", proj], { cwd: proj, env: env(proj, { env: extra }) });
}
/** The commands a step names that match `pattern`, in order. */
function named(message: string, pattern: RegExp): string[] {
  return [...message.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((command) => pattern.test(command));
}
/**
 * The person types `typed`; the agent runs `next` and every command its step names that matches `pattern`. A `--stage`
 * jump that `next` makes itself names none: its step is the target's, and the row already reads it.
 */
async function move(proj: string, typed: string, args: string[], pattern: RegExp): Promise<Exec[]> {
  await say(proj, typed, "claude");
  const step = await next(proj, args);
  expect(step.status, step.out).toBe(0);
  const message = String(step.directive?.message ?? "");
  const commands = named(message, pattern);
  if (commands.length === 0 && args[0] === "--stage" && step.directive?.stage === args[1]) {
    expect(getField(state(proj), "Current Stage"), step.out).toBe(args[1]);
    return [];
  }
  expect(commands.length, message).toBeGreaterThan(0);
  const ran: Exec[] = [];
  for (const command of commands) {
    const result = await runNamed(proj, command);
    expect(result.status, `${command}\n${result.stdout}${result.stderr}`).toBe(0);
    ran.push(result);
  }
  return ran;
}
const JUMP = /aidlc-jump\.ts execute/;

/** A feature at User Stories, moved there by a jump: its box reads `[-]`. */
async function atUserStories(): Promise<string> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  removeWorkspaceRecord(proj);
  const made = await exec([process.execPath, UTILITY, "intent-create", "--scope", "feature", "--project-type", "greenfield",
    "--label", "tags", "--arguments", "add tags to the to-do app", "--project-dir", proj], { cwd: proj, env: env(proj) });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  await move(proj, "/aidlc --stage user-stories", ["--stage", "user-stories"], JUMP);
  expect((await next(proj, [])).directive?.stage).toBe("user-stories");
  expect(box(proj, "user-stories")).toBe("- EXECUTE");
  return proj;
}

/** User Stories' documents on disk and its gate open, as a run leaves it before the person answers. */
async function userStoriesGate(proj: string): Promise<void> {
  const dir = join(dirname(stateFilePath(proj)), "inception", "user-stories");
  mkdirSync(dir, { recursive: true });
  for (const name of findStageBySlug("user-stories")?.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n\n- As a person, I tag a to-do.\n`, "utf-8");
  }
  const reviewer = findStageBySlug("user-stories")?.reviewer ?? "";
  const base = ["review", "--stage", "user-stories", "--reviewer", reviewer, "--iteration", "1", "--project-dir", proj];
  const asked = await exec([process.execPath, LOG, ...base], { cwd: proj, env: env(proj, { env: NO_OUTPUT_CHECKS }) });
  expect(asked.status, asked.stdout + asked.stderr).toBe(0);
  const reviewFile = (JSON.parse(asked.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}") as { reviewFile?: string }).reviewFile;
  writeFileSync(join(proj, reviewFile as string), `## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Date:** 2026-01-01T00:00:00Z\n` +
    "**Iteration:** 1\n\n### Findings\n\n**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n" +
    "### Summary\n\nReady.\n", "utf-8");
  const ready = await exec([process.execPath, LOG, ...base, "--verdict", "READY"], { cwd: proj, env: env(proj, { env: NO_OUTPUT_CHECKS }) });
  expect(ready.status, ready.stdout + ready.stderr).toBe(0);
  const gate = await exec([process.execPath, ORCHESTRATE, "report", "--stage", "user-stories", "--result", "awaiting-approval", "--project-dir", proj],
    { cwd: proj, env: env(proj, { env: NO_OUTPUT_CHECKS }) });
  expect(gate.status, gate.stdout + gate.stderr).toBe(0);
}
async function answerGate(proj: string, words: string, result: "approved" | "rejected"): Promise<void> {
  await say(proj, words, "claude");
  const answered = await exec([process.execPath, ORCHESTRATE, "report", "--stage", "user-stories", "--result", result, "--user-input", words,
    "--project-dir", proj], { cwd: proj, env: env(proj, { env: NO_OUTPUT_CHECKS }) });
  expect(answered.status, answered.stdout + answered.stderr).toBe(0);
}

/** "This is really just a bug fix": the switch drops User Stories (and Domain Design and the rest) from the plan. */
async function switchToBugfix(proj: string): Promise<void> {
  await move(proj, "this is really just a bug fix, switch the work to the bugfix scope", ["--scope", "bugfix"], /scope change/);
}
/** "Go back to Requirements Analysis". */
async function goBack(proj: string): Promise<void> {
  await move(proj, "go back to requirements analysis", ["--stage", "requirements-analysis"], JUMP);
  expect(getField(state(proj), "Current Stage")).toBe("requirements-analysis");
}

/** The four ways a run reaches the go-back with User Stories dropped by the switch. */
const PATHS: Record<string, () => Promise<string>> = {
  // The go-back typed right after the switch: User Stories keeps the box of the stage the work was on.
  "on it": async () => {
    const proj = await atUserStories();
    await switchToBugfix(proj);
    expect(box(proj, "user-stories")).toBe("- SKIP");
    return proj;
  },
  // "Go on" after the switch: the engine's own skip step routes past User Stories.
  "on it, then go on": async () => {
    const proj = await atUserStories();
    await switchToBugfix(proj);
    const skip = await next(proj, []);
    for (const command of named(String(skip.directive?.message ?? ""), /--result skipped/)) {
      expect((await runNamed(proj, command)).status).toBe(0);
    }
    expect(box(proj, "user-stories")).toBe("S SKIP");
    return proj;
  },
  // Request Changes at User Stories, then the switch: the box reads `[R]`.
  "revising it": async () => {
    const proj = await atUserStories();
    await userStoriesGate(proj);
    await answerGate(proj, "Request Changes", "rejected");
    expect(box(proj, "user-stories")).toBe("R EXECUTE");
    await switchToBugfix(proj);
    expect(box(proj, "user-stories")).toBe("R SKIP");
    return proj;
  },
  // A jump past User Stories to Code Generation first.
  "jumped past it": async () => {
    const proj = await atUserStories();
    await move(proj, "/aidlc --stage code-generation", ["--stage", "code-generation"], JUMP);
    expect(box(proj, "user-stories")).toBe("S EXECUTE");
    await switchToBugfix(proj);
    return proj;
  },
};

describe("t-go-back-after-scope-switch: the go-back leaves a stage the switch dropped not started", () => {
  for (const [path, reach] of Object.entries(PATHS)) {
    test(`${path}: the row reads not started, and adding it back puts it next`, async () => {
      const proj = await reach();
      await goBack(proj);
      expect(box(proj, "user-stories")).toBe("  SKIP");
      // Nothing of User Stories reruns or is invalidated: the go-back names the stages on the plan only.
      expect(invalidated(proj)).not.toContain("user-stories");
      await move(proj, "Approve, and add User Stories next", ["--add", "user-stories"], /recompose --add user-stories/);
      expect(box(proj, "user-stories")).toBe("  EXECUTE");
      expect(after(proj, "requirements-analysis", "bugfix")).toBe("user-stories");
    });
  }

  test("jumped past it: every Inception stage it jumped past reads not started", async () => {
    const proj = await PATHS["jumped past it"]();
    await goBack(proj);
    for (const slug of ["user-stories", "refined-mockups", "domain-design", "units-generation", "functional-design"]) {
      expect(box(proj, slug), slug).toBe("  SKIP");
    }
  });

  test("returning to it, as the go-back says the person can, moves the work there", async () => {
    const proj = await PATHS["on it"]();
    await goBack(proj);
    await move(proj, "Return to User Stories.", ["--stage", "user-stories"], /recompose --add user-stories|aidlc-jump\.ts execute/);
    expect(getField(state(proj), "Current Stage")).toBe("user-stories");
    expect(box(proj, "user-stories")).toBe("- EXECUTE");
  });

  for (const path of ["on it, then go on", "jumped past it"]) {
    test(`${path}: switching back to the feature scope runs User Stories after Requirements Analysis`, async () => {
      const proj = await PATHS[path]();
      await goBack(proj);
      await move(proj, "Switch back to the feature scope.", ["--scope", "feature"], /scope change/);
      expect(after(proj, "requirements-analysis", "feature")).toBe("user-stories");
    });
  }

  test("a stage the work finished keeps its box, and its documents are not named as invalidated", async () => {
    const proj = await atUserStories();
    await userStoriesGate(proj);
    await answerGate(proj, "Approve", "approved");
    expect(box(proj, "user-stories")).toBe("x EXECUTE");
    await switchToBugfix(proj);
    await goBack(proj);
    expect(box(proj, "user-stories")).toBe("x SKIP");
    expect(invalidated(proj)).not.toContain("user-stories");
  });
});
