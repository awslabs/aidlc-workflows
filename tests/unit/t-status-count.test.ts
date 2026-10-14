// covers: subcommand:aidlc-utility:status, function:plannedStages
//
// Status counts the stages the person was shown: the stages the plan runs
// after Initialization, the count the plan offer gave ("29 stages"), each
// stage's start says ("stage 3 of 29") and the progress line after an approval
// uses, read from the one list they share. A stage the person skipped leaves
// the count and is named. Initialization's setup keeps its row in Phase
// Progress and stays out of the count.
//
// Mechanism: cli - spawns the shipped tools against temp projects on an empty
// folder: the offer from `next`, then intent-create, state checkboxes and a
// forward jump, then status and the next stage start.

import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  cleanupTestProject,
  proposalFollowUp,
  removeWorkspaceRecord,
  runOrchestrateNext,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { expectedStages, sourceStages } from "../harness/scope-run.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

// No chat names itself to the tools, so the step's line is the stage's alone.
const env: Record<string, string | undefined> = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
for (const key of [
  "AIDLC_SCOPE_MAPPING", "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "KIRO_SESSION_ID",
]) {
  delete env[key];
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

// The project goes right after the subcommand, ahead of the person's words.
function tool(proj: string, name: string, [subcommand, ...args]: string[]): string {
  const res = spawnSync(process.execPath, [join(proj, ".claude", "tools", name), subcommand, "--project-dir", proj, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
    cwd: proj,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  expect(res.status, out).toBe(0);
  return out;
}

// `next` for a request, following the proposal step the agent takes after a
// plan proposal, as it does live.
function next(proj: string, args: string[]): Record<string, unknown> {
  const directive = JSON.parse(tool(proj, "aidlc-orchestrate.ts", ["next", ...args]).trim()) as Record<string, unknown>;
  const proposal = proposalFollowUp(directive);
  return proposal === null ? directive : next(proj, proposal);
}

// The stages a scope runs after Initialization on a folder with no code, from
// the source, in run order.
function planOf(scope: string): string[] {
  const init = new Set(sourceStages().filter((s) => s.phase === "initialization").map((s) => s.slug));
  return expectedStages(scope, false).filter((slug) => !init.has(slug));
}

// A new piece of work on an empty folder, and the stage count its offer gave.
function started(scope: string): { proj: string; offered: number } {
  const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
  tempDirs.push(proj);
  removeWorkspaceRecord(proj);
  const offer = next(proj, [scope, "add login support"]);
  expect(offer.kind, JSON.stringify(offer)).toBe("print");
  const count = String(offer.message).match(/to start the workflow \((\d+) stages?, /);
  if (!count) throw new Error(`no stage count in the offer:\n${String(offer.message)}`);
  tool(proj, "aidlc-utility.ts", ["intent-create", "--scope", scope]);
  return { proj, offered: Number(count[1]) };
}

function status(proj: string): string {
  return tool(proj, "aidlc-utility.ts", ["status"]);
}

function completion(out: string): string {
  return out.split("\n").find((line) => line.startsWith("Completion:")) ?? `no Completion line in:\n${out}`;
}

// The stages each Phase Progress row after Initialization counts, added up.
function rowsTotal(out: string): number {
  const rows = [...out.matchAll(/^ {2}(IDEATION|INCEPTION|CONSTRUCTION|OPERATION) +\S+ (\d+)\/(\d+)$/gm)];
  return rows.reduce((sum, row) => sum + Number(row[3]), 0);
}

function startLine(proj: string): string {
  const step = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, [], { env });
  expect(step.directive?.kind, step.out).toBe("run-stage");
  return String(step.directive?.narration ?? "");
}

describe("status counts the stages the person was shown", () => {
  for (const scope of ["feature", "bugfix"]) {
    test(`a new ${scope} plan counts the stages its offer counted`, () => {
      const { proj, offered } = started(scope);
      expect(offered).toBe(planOf(scope).length);
      expect(completion(status(proj))).toBe(`Completion:     0/${offered} stages (0%)`);
      expect(startLine(proj)).toContain(`(stage 1 of ${offered})`);
    });
  }

  test("finished stages count against that total, and Initialization's row stays out of it", () => {
    const { proj, offered } = started("feature");
    tool(proj, "aidlc-state.ts", ["checkbox", ...planOf("feature").slice(0, 2).map((slug) => `${slug}=completed`)]);
    const out = status(proj);
    expect(completion(out)).toBe(`Completion:     2/${offered} stages (${Math.round((2 / offered) * 100)}%)`);
    expect(out).toMatch(/^ {2}INITIALIZATION +\S+ 3\/3$/m);
    expect(rowsTotal(out)).toBe(offered);
  });

  test("a stage the person skipped leaves the count and is named", () => {
    const { proj, offered } = started("feature");
    tool(proj, "aidlc-state.ts", [
      "checkbox", ...planOf("feature").slice(0, 2).map((slug) => `${slug}=completed`), "scope-definition=skipped",
    ]);
    const out = status(proj);
    const left = offered - 1;
    expect(completion(out)).toBe(
      `Completion:     2/${left} stages (${Math.round((2 / left) * 100)}%), skipped: Scope Definition`,
    );
    expect(rowsTotal(out)).toBe(left);
  });

  test("after a jump forward, status counts the stages the stage start counts", () => {
    const { proj } = started("bugfix");
    tool(proj, "aidlc-jump.ts", ["execute", "--target", "build-and-test", "--direction", "forward"]);
    const plan = planOf("bugfix");
    const left = plan.length - plan.indexOf("build-and-test");
    expect(completion(status(proj))).toBe(
      `Completion:     0/${left} stages (0%), skipped: Requirements Analysis, Code Generation`,
    );
    expect(startLine(proj)).toBe(`Now working on Build and Test (stage 1 of ${left}), wearing the quality engineer hat.`);
  });

  test("a feature plan jumped to Inception counts the same in both", () => {
    const { proj } = started("feature");
    tool(proj, "aidlc-jump.ts", ["execute", "--target", "requirements-analysis", "--direction", "forward"]);
    const plan = planOf("feature");
    const left = plan.length - plan.indexOf("requirements-analysis");
    expect(completion(status(proj))).toMatch(new RegExp(`^Completion: {5}0/${left} stages \\(0%\\), skipped: `));
    expect(startLine(proj)).toContain(`(stage 1 of ${left})`);
  });

  test("a plan whose every stage was skipped has nothing left to do", () => {
    const { proj } = started("bugfix");
    tool(proj, "aidlc-state.ts", ["checkbox", ...planOf("bugfix").map((slug) => `${slug}=skipped`)]);
    expect(completion(status(proj))).toMatch(/^Completion: {5}0\/0 stages \(100%\), skipped: Requirements Analysis, /);
  });
});
