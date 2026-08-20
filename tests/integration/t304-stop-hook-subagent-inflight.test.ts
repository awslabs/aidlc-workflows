// covers: hook:aidlc-continue-workflow, hook:aidlc-log-subagent, hook:aidlc-deliver-stage-rules, function:subagentInflightMarkerPath, function:SUBAGENT_INFLIGHT_TTL_MS
//
// t304 - background-subagent Stop-hook carve-out (tier 2c).
//
// A background Agent/Task dispatch legitimately ends the conductor's turn
// while the worker remains in flight. The stage remains pending, so without a
// positive signal the Stop hook injects the forwarding-loop continuation before
// the background result arrives. The dispatch hook writes the workspace-level
// marker only for run_in_background:true, SubagentStop clears it, and the Stop
// hook honours it only while fresh and outside autonomous Construction.
//
// Mechanism: cli. The Stop hook uses t195's seeded project + mock-engine seam;
// the dispatch/completion assertions spawn the real shipped hooks.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  subagentInflightMarkerPath,
  SUBAGENT_INFLIGHT_TTL_MS,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOKS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "hooks");
const STOP_HOOK = join(HOOKS_DIR, "aidlc-continue-workflow.ts");
const LOG_SUBAGENT_HOOK = join(HOOKS_DIR, "aidlc-log-subagent.ts");
const DELIVER_STAGE_RULES_HOOK = join(HOOKS_DIR, "aidlc-deliver-stage-rules.ts");

const MOCK_ENGINE = `console.log(JSON.stringify({ kind: "run-stage", stage: "requirements-analysis" }));
process.exit(0);
`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function makeProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  mkdirSync(join(proj, ".claude", "tools"), { recursive: true });
  writeFileSync(
    join(proj, ".claude", "tools", "aidlc-orchestrate.ts"),
    MOCK_ENGINE,
    "utf-8",
  );
  return proj;
}

function seedActive(proj: string, opts: { autonomy?: string } = {}): void {
  const autonomyLine = opts.autonomy
    ? `- **Construction Autonomy Mode**: ${opts.autonomy}\n`
    : "";
  writeFileSync(
    seededStateFile(proj),
    `- **Workflow**: feature\n- **Scope**: feature\n- **Current Stage**: requirements-analysis\n${autonomyLine}`,
    "utf-8",
  );
}

function runHook(
  hook: string,
  proj: string,
  payload: Record<string, unknown>,
): { rc: number; out: string; err: string } {
  const res = spawnSync(BUN, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PROJECT_DIR: proj,
      CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "",
    },
    timeout: 20_000,
  });
  return {
    rc: res.status ?? -1,
    out: (res.stdout ?? "").trim(),
    err: (res.stderr ?? "").trim(),
  };
}

function runStopHook(proj: string): { rc: number; out: string } {
  const result = runHook(STOP_HOOK, proj, { stop_hook_active: false });
  return { rc: result.rc, out: result.out };
}

describe("t304 background-subagent Stop-hook carve-out (tier 2c)", () => {
  test("a: fresh marker + pending run-stage -> ALLOW", () => {
    const proj = makeProject();
    seedActive(proj);
    writeFileSync(subagentInflightMarkerPath(proj), "in-flight\n", "utf-8");

    const result = runStopHook(proj);
    expect(result.rc).toBe(0);
    expect(result.out).not.toContain('"decision":"block"');
    expect(existsSync(subagentInflightMarkerPath(proj))).toBe(true);
  });

  test("b: no marker + pending run-stage -> BLOCK", () => {
    const proj = makeProject();
    seedActive(proj);

    const result = runStopHook(proj);
    expect(result.rc).toBe(0);
    expect(result.out).toContain('"decision":"block"');
  });

  test("c: marker under autonomous Construction -> BLOCK", () => {
    const proj = makeProject();
    seedActive(proj, { autonomy: "autonomous" });
    writeFileSync(subagentInflightMarkerPath(proj), "in-flight\n", "utf-8");

    expect(runStopHook(proj).out).toContain('"decision":"block"');
  });

  test("d: marker removed after completion -> BLOCK again", () => {
    const proj = makeProject();
    seedActive(proj);
    writeFileSync(subagentInflightMarkerPath(proj), "in-flight\n", "utf-8");
    expect(runStopHook(proj).out).not.toContain('"decision":"block"');

    unlinkSync(subagentInflightMarkerPath(proj));
    expect(runStopHook(proj).out).toContain('"decision":"block"');
  });

  test("e: stale marker -> BLOCK and janitor deletion", () => {
    const proj = makeProject();
    seedActive(proj);
    const marker = subagentInflightMarkerPath(proj);
    writeFileSync(marker, "in-flight\n", "utf-8");
    const staleAgeSec = SUBAGENT_INFLIGHT_TTL_MS / 1000 + 60 * 60;
    const when = Date.now() / 1000 - staleAgeSec;
    utimesSync(marker, when, when);

    const result = runStopHook(proj);
    expect(result.rc).toBe(0);
    expect(result.out).toContain('"decision":"block"');
    expect(existsSync(marker)).toBe(false);
  });

  test("f: SubagentStop clears the marker before the audit-file early return", () => {
    const proj = makeProject();
    seedActive(proj);
    const marker = subagentInflightMarkerPath(proj);
    writeFileSync(marker, "in-flight\n", "utf-8");

    const result = runHook(LOG_SUBAGENT_HOOK, proj, {
      hook_event_name: "SubagentStop",
      agent_type: "general-purpose",
      agent_id: "background-1",
      last_assistant_message: "done",
    });
    expect(result.rc).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("g: deliver-stage-rules writes only for run_in_background:true", () => {
    const foreground = makeProject();
    seedActive(foreground);
    const foregroundResult = runHook(DELIVER_STAGE_RULES_HOOK, foreground, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: {
        subagent_type: "general-purpose",
        prompt: "Inspect the active stage.",
        run_in_background: false,
      },
    });
    expect(foregroundResult.rc).toBe(0);
    expect(existsSync(subagentInflightMarkerPath(foreground))).toBe(false);

    const background = makeProject();
    seedActive(background);
    const backgroundResult = runHook(DELIVER_STAGE_RULES_HOOK, background, {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: {
        subagent_type: "general-purpose",
        prompt: "Inspect the active stage.",
        run_in_background: true,
      },
    });
    expect(backgroundResult.rc).toBe(0);
    expect(backgroundResult.err).toBe("");
    expect(existsSync(subagentInflightMarkerPath(background))).toBe(true);
  });
});
