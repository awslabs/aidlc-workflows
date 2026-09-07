// covers: hook:aidlc-continue-workflow, hook:aidlc-log-subagent, hook:aidlc-deliver-stage-rules, function:markSubagentInflight, function:completeSubagentInflight, function:matchSubagentInflight, function:inspectSubagentInflight, function:subagentInflightMarkerPath, function:SUBAGENT_INFLIGHT_TTL_MS
//
// t327 - session-scoped background-subagent Stop-hook carve-out.
//
// Accepted background dispatches add one ledger entry for the dispatching
// session. Completion removes one matching entry, so overlapping workers and
// concurrent sessions remain isolated. Stop honours only a fresh entry for its
// own session and prunes stale entries outside autonomous Construction.
//
// Mechanism: cli. Dispatch, completion, and Stop assertions spawn the real
// shipped hooks; direct helper calls seed exact stale/autonomy states.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  activeIntent,
  inspectSubagentInflight,
  markSubagentInflight,
  subagentInflightMarkerPath,
  SUBAGENT_INFLIGHT_TTL_MS,
  writeSessionBinding,
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
    `- **Workflow**: feature\n- **Scope**: feature\n- **Status**: Running\n- **Current Stage**: requirements-analysis\n${autonomyLine}`,
    "utf-8",
  );
}

function bindSession(proj: string, sessionId: string): void {
  const intent = activeIntent(proj, "default");
  expect(intent).not.toBeNull();
  writeSessionBinding(proj, sessionId, "default", intent);
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
      CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "100",
    },
    timeout: 20_000,
  });
  return {
    rc: res.status ?? -1,
    out: (res.stdout ?? "").trim(),
    err: (res.stderr ?? "").trim(),
  };
}

function runStopHook(
  proj: string,
  sessionId?: string,
): { rc: number; out: string } {
  const result = runHook(STOP_HOOK, proj, {
    stop_hook_active: false,
    ...(sessionId ? { session_id: sessionId } : {}),
  });
  return { rc: result.rc, out: result.out };
}

function dispatchBackground(
  proj: string,
  sessionId: string,
  background = true,
): { rc: number; out: string; err: string } {
  return runHook(DELIVER_STAGE_RULES_HOOK, proj, {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    tool_name: "Task",
    tool_input: {
      subagent_type: "general-purpose",
      prompt: "Inspect the active stage.",
      run_in_background: background,
    },
  });
}

function completeBackground(
  proj: string,
  sessionId: string,
  agentId: string,
): { rc: number; out: string; err: string } {
  return runHook(LOG_SUBAGENT_HOOK, proj, {
    hook_event_name: "SubagentStop",
    session_id: sessionId,
    agent_type: "general-purpose",
    agent_id: agentId,
    last_assistant_message: "done",
  });
}

describe("t327 background-subagent Stop-hook carve-out", () => {
  test("fresh entry authorizes only its own session", () => {
    const proj = makeProject();
    seedActive(proj);
    bindSession(proj, "session-a");
    bindSession(proj, "session-b");
    expect(markSubagentInflight(proj, "session-a")).toBe(true);

    expect(runStopHook(proj, "session-a").out).not.toContain(
      '"decision":"block"',
    );
    expect(runStopHook(proj, "session-b").out).toContain(
      '"decision":"block"',
    );
    expect(inspectSubagentInflight(proj).freshCount).toBe(1);
  });

  test("no entry keeps pending run-stage enforcement active", () => {
    const proj = makeProject();
    seedActive(proj);

    const result = runStopHook(proj, "session-a");
    expect(result.rc).toBe(0);
    expect(result.out).toContain('"decision":"block"');
  });

  test("entry under autonomous Construction does not authorize a stop", () => {
    const proj = makeProject();
    seedActive(proj, { autonomy: "autonomous" });
    expect(markSubagentInflight(proj, "session-a")).toBe(true);

    expect(runStopHook(proj, "session-a").out).toContain(
      '"decision":"block"',
    );
  });

  test("stale entry is pruned and does not authorize a stop", () => {
    const proj = makeProject();
    seedActive(proj);
    expect(markSubagentInflight(proj, "session-a")).toBe(true);
    const path = subagentInflightMarkerPath(proj);
    const ledger = JSON.parse(readFileSync(path, "utf-8")) as {
      entries: Array<{ startedAtMs: number }>;
    };
    ledger.entries[0].startedAtMs =
      Date.now() - SUBAGENT_INFLIGHT_TTL_MS - 60 * 60 * 1000;
    writeFileSync(path, `${JSON.stringify(ledger)}\n`, "utf-8");

    expect(runStopHook(proj, "session-a").out).toContain(
      '"decision":"block"',
    );
    expect(existsSync(path)).toBe(false);
  });

  test("only accepted background dispatches add ledger entries", () => {
    const foreground = makeProject();
    seedActive(foreground);
    expect(dispatchBackground(foreground, "session-a", false).rc).toBe(0);
    expect(existsSync(subagentInflightMarkerPath(foreground))).toBe(false);

    const background = makeProject();
    seedActive(background);
    const result = dispatchBackground(background, "session-a");
    expect(result.rc).toBe(0);
    expect(result.err).toBe("");
    expect(inspectSubagentInflight(background)).toMatchObject({
      freshCount: 1,
      staleCount: 0,
      malformed: false,
    });
  });

  test("one completion preserves another worker in the same session", () => {
    const proj = makeProject();
    seedActive(proj);
    bindSession(proj, "session-a");
    expect(dispatchBackground(proj, "session-a").rc).toBe(0);
    expect(dispatchBackground(proj, "session-a").rc).toBe(0);
    expect(inspectSubagentInflight(proj).freshCount).toBe(2);

    expect(completeBackground(proj, "session-a", "worker-a").rc).toBe(0);
    expect(inspectSubagentInflight(proj).freshCount).toBe(1);
    expect(runStopHook(proj, "session-a").out).not.toContain(
      '"decision":"block"',
    );

    expect(completeBackground(proj, "session-a", "worker-b").rc).toBe(0);
    expect(existsSync(subagentInflightMarkerPath(proj))).toBe(false);
    expect(runStopHook(proj, "session-a").out).toContain(
      '"decision":"block"',
    );
  });

  test("completion and authorization remain isolated across sessions", () => {
    const proj = makeProject();
    seedActive(proj);
    bindSession(proj, "session-a");
    bindSession(proj, "session-b");
    expect(dispatchBackground(proj, "session-a").rc).toBe(0);
    expect(dispatchBackground(proj, "session-b").rc).toBe(0);
    expect(inspectSubagentInflight(proj).freshCount).toBe(2);

    expect(runStopHook(proj, "session-a").out).not.toContain(
      '"decision":"block"',
    );
    expect(runStopHook(proj, "session-b").out).not.toContain(
      '"decision":"block"',
    );
    expect(runStopHook(proj, "session-c").out).toContain(
      '"decision":"block"',
    );

    expect(completeBackground(proj, "session-a", "worker-a").rc).toBe(0);
    expect(runStopHook(proj, "session-a").out).toContain(
      '"decision":"block"',
    );
    expect(runStopHook(proj, "session-b").out).not.toContain(
      '"decision":"block"',
    );
    expect(inspectSubagentInflight(proj).freshCount).toBe(1);

    expect(completeBackground(proj, "session-b", "worker-b").rc).toBe(0);
    expect(existsSync(subagentInflightMarkerPath(proj))).toBe(false);
  });
});
