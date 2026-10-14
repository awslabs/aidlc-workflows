// covers: subcommand:aidlc-swarm:check, subcommand:aidlc-swarm:finalize, subcommand:aidlc-log:review
//
// In a side-by-side build the workers and reviewers run the tests the person
// approved through AI-DLC's own `swarm check`, which the harness lets run
// without asking again: the worker's brief and the reviewer's request name the
// command, it runs from the main folder, and with --show-output the tests' own
// output shows while stdout keeps the one verdict line.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stateDigest, writeActiveDirectiveMarker } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  cleanupCheckpointFixtures, fixture, ISOLATED_GIT_ENV, prepare, reviewRevisedSource, runCheckpointTool,
  STAGE, swarm, wt,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

// One command both shells run (checkConverged uses cmd.exe on Windows): it
// prints a line of its own, then fails on a trailing space in the Unit's code.
const APPROVED = "echo visible-test-output && git diff --check";

// The command as the brief and the review request spell it. It names no folder, so no shell has a path to
// quote: cmd.exe hands a quoted Windows path to the program with its quotes, and splits it at a space.
const COMMAND = "bun .claude/tools/aidlc.ts engine swarm check alpha --show-output";

function prepared(): string {
  const pd = fixture(["alpha"], APPROVED);
  const result = prepare(pd);
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  return pd;
}

// The Unit's list of files, which a Code Generation review request reads.
function writeManifest(dir: string): void {
  writeFileSync(join(codeGenerationRecordDir(dir, "alpha"), "source-manifest.json"),
    JSON.stringify({ stage: STAGE, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }] }));
}

function verdict(out: string): { unit: string; converged: boolean } {
  const lines = out.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

// A guard hook of the parent session, run on a command as a worker or reviewer sends it from the main folder.
function hook(pd: string, file: string, toolCommand: string, agent?: string) {
  const env: NodeJS.ProcessEnv = {
    ...testGuardEnvironment(ISOLATED_GIT_ENV, "production"), AIDLC_UNATTENDED: "0", AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd,
  };
  delete env.AIDLC_STATE_TRANSITION_OWNER;
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "hooks", file)], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd,
    env,
    stdin: Buffer.from(JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: toolCommand },
      session_id: "swarm-parent-session", cwd: pd, ...(agent ? { agent_type: agent } : {}),
    })),
    stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

const PLAN_GUARD = "aidlc-plan-approval-guard.ts";
const STATE_GUARD = "aidlc-state-transition-guard.ts";
const DEVELOPER = "aidlc-developer-agent";
const REVIEWER = "aidlc-architecture-reviewer-agent";

// Both guards let a delegated agent run the command: it runs the approved tests and changes nothing.
function admitted(pd: string, toolCommand: string, agent: string): void {
  for (const file of [PLAN_GUARD, STATE_GUARD]) {
    const result = hook(pd, file, toolCommand, agent);
    expect(result.code, `${file} ${agent}\n${result.out}\n${result.err}`).toBe(0);
    expect(result.out).toBe("");
  }
}

describe("a parallel batch's Unit runs the approved tests through swarm check", () => {
  test("the brief names the command, the guard lets it run from the main folder, and it shows the tests' output", () => {
    const pd = prepared();
    const brief = runCheckpointTool(pd, "tools/aidlc-testing-posture.ts", ["brief", "--unit", "alpha"]);
    expect(brief.code, `${brief.out}\n${brief.err}`).toBe(0);
    expect(brief.out).toContain(
      `To run the tests the person approved (\`${APPROVED}\`), run \`${COMMAND}\` as a command of its own ` +
        `from the project's main folder \`${resolve(pd)}\`, not from your worktree and with no \`cd\` before it: ` +
        "it runs them in your worktree and shows their output, and its JSON line says `\"converged\":true` when they pass.",
    );
    expect(brief.out).not.toContain("--project-dir");

    // Under Guard Policy strict, with the batch out, the worker runs the command as the brief spells it.
    admitted(pd, COMMAND, DEVELOPER);

    // Through the dispatcher, from the main folder of a session that names its project, as the brief spells it:
    // the tests' output on stderr, one verdict line on stdout. The public form also takes --project-dir.
    const run = (extra: string[]) =>
      runCheckpointTool(pd, "tools/aidlc.ts", ["engine", "swarm", "check", "alpha", ...extra]);
    const shown = run(["--show-output"]);
    expect(shown.code, `${shown.out}\n${shown.err}`).toBe(0);
    expect(shown.err).toContain("visible-test-output");
    expect(verdict(shown.out)).toMatchObject({ unit: "alpha", converged: true });

    // Without the flag, as before: the verdict alone, the same bytes.
    const plain = run(["--project-dir", pd]);
    expect(plain.code, `${plain.out}\n${plain.err}`).toBe(0);
    expect(plain.err).not.toContain("visible-test-output");
    expect(plain.out).toBe(shown.out);

    // A failing run shows why it failed.
    writeFileSync(join(wt(pd), "src", "alpha.ts"), "export const alpha = 2; \n");
    const failed = run(["--show-output"]);
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain("trailing whitespace");
    expect(verdict(failed.out)).toMatchObject({ unit: "alpha", converged: false });
  });

  test("the reviewer's request carries the command; finalize prints only its verdict", () => {
    const pd = prepared();
    writeFileSync(join(wt(pd), "src", "alpha.ts"), "export const alpha = 2;\n");
    const child = wt(pd);
    writeManifest(child);
    const request = runCheckpointTool(child, "tools/aidlc-log.ts", [
      "review", "--stage", STAGE, "--unit", "alpha", "--reviewer", "aidlc-architecture-reviewer-agent",
      "--iteration", "1", "--project-dir", child,
    ]);
    expect(request.code, `${request.out}\n${request.err}`).toBe(0);
    expect(JSON.parse(request.out).test_command).toBe(COMMAND);
    admitted(pd, COMMAND, REVIEWER);

    const checked = swarm(pd, ["check", "alpha"]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd);
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(`${finalized.out}${finalized.err}`).not.toContain("visible-test-output");
    expect(JSON.parse(finalized.out).units[0]).toMatchObject({ unit: "alpha" });
  });

  test("a worker or reviewer may run swarm check; the batch's own steps stay the conductor's", () => {
    const pd = prepared();
    for (const agent of [DEVELOPER, REVIEWER]) {
      const ran = hook(pd, STATE_GUARD, COMMAND, agent);
      expect(ran.code, `${agent}\n${ran.out}\n${ran.err}`).toBe(0);
    }
    for (const step of [
      "bun .claude/tools/aidlc.ts engine swarm prepare --batch 1 --units alpha --base main",
      "bun .claude/tools/aidlc.ts engine swarm finalize --batch 1 --units alpha --claimed alpha",
    ]) {
      const refused = hook(pd, STATE_GUARD, step, DEVELOPER);
      expect(refused.code, step).toBe(2);
      expect(refused.err).toContain("only the main workflow session can change stage status or routing");
    }
  });

  test("a one-at-a-time build's brief and review request name no swarm check", () => {
    const pd = fixture(["alpha"], APPROVED);
    writeActiveDirectiveMarker(pd, {
      kind: "run-stage", stage: STAGE, unit: "alpha",
      state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
    });
    const brief = runCheckpointTool(pd, "tools/aidlc-testing-posture.ts", ["brief", "--unit", "alpha"]);
    expect(brief.code, `${brief.out}\n${brief.err}`).toBe(0);
    expect(brief.out).not.toContain("swarm check");
    writeManifest(pd);
    const request = runCheckpointTool(pd, "tools/aidlc-log.ts", [
      "review", "--stage", STAGE, "--unit", "alpha", "--reviewer", "aidlc-architecture-reviewer-agent",
      "--iteration", "1", "--project-dir", pd,
    ]);
    expect(request.code, `${request.out}\n${request.err}`).toBe(0);
    expect(JSON.parse(request.out)).not.toHaveProperty("test_command");
  });
});
