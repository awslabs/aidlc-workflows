// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report,
// subcommand:aidlc-orchestrate:continue, subcommand:aidlc-orchestrate:park, function:swarmWorkerWorktreeMeta
//
// A side-by-side (swarm) build, records committed: the conductor's shell is left
// in a Unit's worktree after a `cd` (Claude Code's Bash keeps it), and its next
// workflow command runs there. That checkout holds the record as it was when the
// worktree was made and none of the hooks' heartbeats, which land in the project
// folder, so the command could only judge the hooks off or re-ask an approved
// plan. Each of the conductor's four workflow commands gets one step instead: go
// back to the project folder and run it again. The project folder's own `next`
// and a worker's command in its worktree are unchanged.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findStageBySlug, hooksHealthDir, readAuditShardEvents, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { ISOLATED_GIT_ENV, cleanupCheckpointFixtures, fixture, prepare, wt } from "../harness/swarm-checkpoint.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

// A tool run with its working folder at `cwd`, which the engine resolves as
// the project, as `.claude/tools` run from there does.
function run(cwd: string, tool: string, args: string[]): { code: number | null; out: string } {
  const env: Record<string, string | undefined> = { ...ISOLATED_GIT_ENV, AIDLC_UNATTENDED: "0" };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  env.AIDLC_PROJECT_DIR = cwd;
  env.CLAUDE_PROJECT_DIR = cwd;
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", tool), ...args], {
    cwd, env, stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

function directive(out: string): Record<string, unknown> {
  const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  return line ? JSON.parse(line) as Record<string, unknown> : {};
}

// Both Units' plans approved and their worktrees made, with the hooks beating
// in the project folder, where the host runs them.
function preparedBuild(): { pd: string; alpha: string } {
  const pd = fixture(["alpha", "beta"]);
  const prepared = prepare(pd, ["alpha", "beta"]);
  expect(prepared.code, prepared.out + prepared.err).toBe(0);
  const health = hooksHealthDir(pd);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "plan-approval-guard.last"), new Date().toISOString().replace(/\.\d+Z$/, "Z"));
  return { pd, alpha: wt(pd, "alpha") };
}

// The folder as the engine names it (its real path) and as the fixture spells
// it (forward slashes on Windows) are the same folder.
const sameSpelling = (path: string): string => path.replaceAll("\\", "/").toLowerCase();

function goBackStep(out: string, pd: string): void {
  const d = directive(out);
  expect(d.kind, out).toBe("print");
  const message = String(d.message);
  expect(sameSpelling(message)).toContain(sameSpelling(realpathSync(pd)));
  expect(message).toContain("alpha");
  expect(message).not.toMatch(/hook|settings|restart|start it again/i);
}

describe("a conductor command run in a Unit's worktree goes back to the project folder", () => {
  test("next from the alpha worktree names the project folder, not the hooks", () => {
    const { pd, alpha } = preparedBuild();
    const ran = run(alpha, "aidlc-orchestrate.ts", ["next"]);
    expect(ran.code, ran.out).toBe(0);
    goBackStep(ran.out, pd);
  });

  test("report, continue and park from there get the same step and change neither record", () => {
    const { pd, alpha } = preparedBuild();
    const before = [
      readFileSync(stateFilePath(pd), "utf-8"), JSON.stringify(readAuditShardEvents(pd)),
      readFileSync(stateFilePath(alpha), "utf-8"), JSON.stringify(readAuditShardEvents(alpha)),
    ];
    for (const args of [
      ["report", "--stage", "code-generation", "--result", "approved"],
      ["continue", "receipt-0000"],
      ["park", "--person-asked"],
    ]) {
      const ran = run(alpha, "aidlc-orchestrate.ts", args);
      goBackStep(ran.out, pd);
    }
    expect([
      readFileSync(stateFilePath(pd), "utf-8"), JSON.stringify(readAuditShardEvents(pd)),
      readFileSync(stateFilePath(alpha), "utf-8"), JSON.stringify(readAuditShardEvents(alpha)),
    ]).toEqual(before);
  });

  test("next from the project folder still hands out the build", () => {
    const { pd } = preparedBuild();
    const ran = run(pd, "aidlc-orchestrate.ts", ["next"]);
    expect(ran.code, ran.out).toBe(0);
    expect(directive(ran.out).kind, ran.out).toBe("invoke-swarm");
  });

  test("a worker's own command in its worktree is not sent back", () => {
    const { alpha } = preparedBuild();
    const reviewer = findStageBySlug("code-generation")?.reviewer ?? "";
    // The Unit's source manifest, as the worker leaves it before asking for its review.
    writeFileSync(
      join(codeGenerationRecordDir(alpha, "alpha"), "source-manifest.json"),
      `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [] }, null, 2)}\n`,
    );
    const ran = run(alpha, "aidlc-log.ts", [
      "review", "--stage", "code-generation", "--reviewer", reviewer, "--unit", "alpha", "--iteration", "1",
      "--project-dir", alpha,
    ]);
    // The worker's own review request goes through, never the conductor's step.
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain('"emitted":"REVIEW_REQUESTED"');
    expect(ran.out).not.toMatch(/project folder/i);
  });
});
