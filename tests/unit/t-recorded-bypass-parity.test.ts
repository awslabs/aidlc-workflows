// covers: function:resolveProjectFlag, function:guardAttemptState, subcommand:aidlc-state:gate-start, subcommand:aidlc-orchestrate:report, subcommand:aidlc-log:review, subcommand:aidlc-log:link
//
// #1248: a bypass recorded with `aidlc config flags --bypass <NAME> --project`
// must have the same effect as exporting the variable, at every guard that
// reads it. Each case runs the same guard three ways: nothing set, the
// variable exported, and the bypass recorded in the project's
// aidlc.settings.json with the variable unset. The recorded run must match the
// exported run, and both must differ from the unset run.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  guardAttemptState,
  loadStageGraphAll,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { _resetSettingsCacheForTests } from "../../dist/claude/.claude/tools/aidlc-settings.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const RE_STAGE = "reverse-engineering";
const LEAD = "aidlc-developer-agent";
const PRODUCES = [
  "business-overview",
  "architecture",
  "code-structure",
  "api-documentation",
  "component-inventory",
  "technology-stack",
  "dependencies",
  "code-quality-assessment",
  "reverse-engineering-timestamp",
];
// The suite exports these for synthetic fixtures; every run here starts
// without them so the recorded setting is the only bypass in play.
const SUITE_BYPASSES = [
  "AIDLC_SKIP_ARTIFACT_GUARD",
  "AIDLC_DISABLE_ENSEMBLE_EVIDENCE",
  "AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD",
];

type Mode = "unset" | "exported" | "recorded";
const MODES: Mode[] = ["unset", "exported", "recorded"];

const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop());
});

function project(fixture: string): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, fixture);
  return proj;
}

// The file `aidlc config flags --bypass <NAME> --project` writes. The command
// itself needs an installed harness, which these bare fixtures do not have.
function recordProjectBypass(proj: string, name: string): void {
  writeFileSync(
    join(proj, "aidlc.settings.json"),
    `${JSON.stringify({ schemaVersion: 1, flags: { schemaVersion: 1, bypasses: [name] } }, null, 2)}\n`,
    "utf-8",
  );
}

function modeEnv(
  proj: string,
  bypass: string,
  mode: Mode,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of SUITE_BYPASSES) delete env[name];
  // The native dispatcher names the project this way; the recorded setting is
  // read from that project's aidlc.settings.json.
  env.AIDLC_PROJECT_DIR = proj;
  if (mode === "exported") env[bypass] = "1";
  return env;
}

function run(
  tool: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number; out: string } {
  const result = spawnSync(BUN, [tool, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return {
    status: result.status ?? -1,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// A brownfield Reverse Engineering run whose CodeKB is written but whose
// pipeline recorded only the developer handoff, not the architect's.
function pipelineProject(mode: Mode): string {
  const proj = project("state-brownfield-init-done.md");
  if (mode === "recorded") recordProjectBypass(proj, "AIDLC_DISABLE_ENSEMBLE_EVIDENCE");
  const codekb = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", basename(proj));
  mkdirSync(codekb, { recursive: true });
  for (const name of PRODUCES) writeFileSync(join(codekb, `${name}.md`), `# ${name}\n`);
  const direct = modeEnv(proj, "AIDLC_DISABLE_ENSEMBLE_EVIDENCE", "unset", {
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  });
  const checkbox = run(STATE, ["checkbox", `${RE_STAGE}=in-progress`, "--project-dir", proj], direct);
  expect(checkbox.status, checkbox.out).toBe(0);
  appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
  const handoff = join(dirname(seededStateFile(proj)), "inception", RE_STAGE, "developer-scan.md");
  mkdirSync(dirname(handoff), { recursive: true });
  writeFileSync(
    handoff,
    "## Developer Code Scan Results\n\n### Scan Coverage\n\n- src/\n\n## Handoff Summary\n\nCurrent attempt.\n",
    "utf-8",
  );
  const link = run(LOG, [
    "link", "--stage", RE_STAGE, "--link", LEAD,
    "--artifact", relative(proj, handoff), "--project-dir", proj,
  ], modeEnv(proj, "AIDLC_DISABLE_ENSEMBLE_EVIDENCE", "unset"));
  expect(link.status, link.out).toBe(0);
  return proj;
}

// Code Generation for Unit alpha with only the plan written, so a required
// output document is missing when the review is requested.
function codeGenerationProject(mode: Mode): string {
  const proj = project("state-construction-with-worktree.md");
  if (mode === "recorded") recordProjectBypass(proj, "AIDLC_SKIP_ARTIFACT_GUARD");
  seedBoltDag(proj, ["alpha"]);
  const dir = join(seededRecordDir(proj), "construction", "alpha", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"), "# Plan\n");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(
    join(dir, "source-manifest.json"),
    `${JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }] }, null, 2)}\n`,
  );
  return proj;
}

const REVIEW_ARGS = [
  "review", "--stage", "code-generation",
  "--reviewer", "aidlc-architecture-reviewer-agent",
  "--unit", "alpha", "--iteration", "1",
];

describe("t-recorded-bypass-parity: a recorded bypass matches the exported variable (#1248)", () => {
  test("AIDLC_DISABLE_ENSEMBLE_EVIDENCE at the direct gate-start pipeline check (aidlc-state.ts)", () => {
    const results = Object.fromEntries(MODES.map((mode) => {
      const proj = pipelineProject(mode);
      return [mode, run(
        STATE,
        ["gate-start", RE_STAGE, "--project-dir", proj],
        modeEnv(proj, "AIDLC_DISABLE_ENSEMBLE_EVIDENCE", mode, {
          AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
          AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
        }),
      )];
    })) as Record<Mode, { status: number; out: string }>;
    expect(results.unset.status).not.toBe(0);
    expect(results.unset.out).toContain("pipeline handoffs have not been recorded");
    expect(results.exported.status, results.exported.out).toBe(0);
    expect(results.recorded.status, results.recorded.out).toBe(results.exported.status);
    expect(results.recorded.out).not.toContain("pipeline handoffs have not been recorded");
  });

  test("AIDLC_DISABLE_ENSEMBLE_EVIDENCE at the engine's approval-presentation pipeline check (aidlc-orchestrate.ts)", () => {
    const results = Object.fromEntries(MODES.map((mode) => {
      const proj = pipelineProject(mode);
      return [mode, run(
        ORCH,
        ["report", "--stage", RE_STAGE, "--result", "awaiting-approval", "--project-dir", proj],
        modeEnv(proj, "AIDLC_DISABLE_ENSEMBLE_EVIDENCE", mode),
      )];
    })) as Record<Mode, { status: number; out: string }>;
    expect(results.unset.out).toContain("for approval because these pipeline handoffs have not been recorded");
    expect(results.exported.out).not.toContain("pipeline handoffs have not been recorded");
    expect(results.recorded.out).not.toContain("pipeline handoffs have not been recorded");
    expect(results.recorded.status).toBe(results.exported.status);
  });

  test("AIDLC_SKIP_ARTIFACT_GUARD at the review logger's required-output check (aidlc-log.ts)", () => {
    const results = Object.fromEntries(MODES.map((mode) => {
      const proj = codeGenerationProject(mode);
      return [mode, run(LOG, [...REVIEW_ARGS, "--project-dir", proj], modeEnv(proj, "AIDLC_SKIP_ARTIFACT_GUARD", mode))];
    })) as Record<Mode, { status: number; out: string }>;
    expect(results.unset.status).not.toBe(0);
    expect(results.unset.out).toContain("a required output document is missing");
    expect(results.exported.out).not.toContain("a required output document is missing");
    expect(results.recorded.out).not.toContain("a required output document is missing");
    expect(results.recorded.status).toBe(results.exported.status);
  });

  test("AIDLC_SKIP_ARTIFACT_GUARD at the refusal snapshot's pending-review default (aidlc-lib.ts guardAttemptState)", () => {
    // A review requested while the missing output was bypassed stays pending.
    // Whether it can be retried or its verdict recorded follows the same
    // bypass, read through the default the refusal snapshot uses.
    const snapshots = Object.fromEntries(MODES.map((mode) => {
      const proj = codeGenerationProject(mode);
      const requested = run(LOG, [...REVIEW_ARGS, "--project-dir", proj], modeEnv(proj, "AIDLC_SKIP_ARTIFACT_GUARD", "exported"));
      expect(requested.status, requested.out).toBe(0);
      const stage = loadStageGraphAll().find((entry) => entry.slug === "code-generation");
      if (!stage) throw new Error("code-generation stage is not in the graph");
      const saved = new Map(
        [...SUITE_BYPASSES, "AIDLC_PROJECT_DIR"].map((name) => [name, process.env[name]]),
      );
      try {
        const env = modeEnv(proj, "AIDLC_SKIP_ARTIFACT_GUARD", mode);
        for (const name of saved.keys()) {
          if (env[name] === undefined) delete process.env[name];
          else process.env[name] = env[name];
        }
        _resetSettingsCacheForTests();
        const state = readFileSync(seededStateFile(proj), "utf-8");
        return [mode, guardAttemptState(proj, state, stage, { unit: "alpha" }).attempt.pendingReview];
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        _resetSettingsCacheForTests();
      }
    })) as Record<Mode, { retryable: boolean; verdictRecordable: boolean } | undefined>;
    expect(snapshots.unset?.retryable).toBe(false);
    expect(snapshots.exported?.retryable).toBe(true);
    expect(snapshots.recorded?.retryable).toBe(snapshots.exported?.retryable);
    expect(snapshots.recorded?.verdictRecordable).toBe(snapshots.exported?.verdictRecordable);
  });
});
