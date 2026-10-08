// covers: function:writeActiveDirectiveMarker, function:leaveCreationReceipt, function:writeWorkspaceSourceSnapshot, function:writeBaselineSourceSnapshot
//
// The records AI-DLC keeps under an intent's engine folder (the Stop hook's
// block counter, the compaction breadcrumb, the active-directive marker, the
// source snapshots, the creation receipt) were written through whatever sat at
// that path. A cloned repository can carry an in-progress intent whose engine
// folder is a link, and then the person's next turn end, compaction or Plan
// Approval wrote a file outside the project. Every such write now goes through
// the record root with no link in the way: the hooks carry on and simply keep
// no record while the link is there (they never fail a turn), and a publication
// or snapshot that cannot be recorded refuses through its existing error path.
// Where no link is planted, every record lands where it always did.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  leaveCreationReceipt,
  stateDigest,
  workspaceSourceState,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
  writeWorkspaceSourceSnapshot,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const BUN = process.execPath;
const created: string[] = [];
const outsideDirs: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
  while (outsideDirs.length) rmSync(outsideDirs.pop()!, { recursive: true, force: true });
});

// Symlink creation needs a privilege on Windows; the planted cases skip there
// rather than assert what the host cannot set up.
function canPlantLinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "nofollow-probe-"));
  try {
    mkdirSync(join(dir, "target"));
    symlinkSync(join(dir, "target"), join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const linksWork = canPlantLinks();

/** A project at Construction with the shipped hooks and tools, and a mock engine that answers `done`. */
function project(): { proj: string; record: string } {
  const proj = setupIntegrationProject({ withState: "state-construction.md" });
  created.push(proj);
  // The Stop hook asks the engine for the next step through the project's own
  // tools; this stand-in answers that the workflow is complete, the path on
  // which the hook resets its block counter (t121 does the same).
  writeFileSync(
    join(proj, ".claude", "tools", "aidlc-orchestrate.ts"),
    'console.log(JSON.stringify({ kind: "done", reason: "Workflow complete." }));\n',
  );
  return { proj, record: seededRecordDir(proj) };
}

/** An empty folder outside the project, and the record's engine folder planted as a link to it. */
function plantEngineLink(record: string): string {
  const outside = mkdtempSync(join(tmpdir(), "nofollow-outside-"));
  outsideDirs.push(outside);
  mkdirSync(record, { recursive: true });
  symlinkSync(outside, join(record, ".aidlc-engine"), "dir");
  return outside;
}

function runHook(proj: string, name: string, payload: Record<string, unknown>): { code: number; stderr: string } {
  const r = spawnSync(BUN, [join(AIDLC_SRC, "hooks", name)], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_HARNESS_DIR: ".claude" },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

const STOP = { session_id: "nofollow-session", stop_hook_active: false };
const COMPACT = { session_id: "nofollow-session", hook_event_name: "PreCompact" };

describe("t-record-writes-never-follow-links: records under the engine folder are never written through a link", () => {
  test.skipIf(!linksWork)("the Stop hook keeps no block counter through a planted link and still ends the turn as before", () => {
    const { proj, record } = project();
    const outside = plantEngineLink(record);
    const result = runHook(proj, "aidlc-continue-workflow.ts", STOP);
    expect(result.code, result.stderr).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(record, ".aidlc-engine")).isSymbolicLink()).toBe(true);
  });

  test.skipIf(!linksWork)("the compaction hook keeps no breadcrumb through a planted link and still exits cleanly", () => {
    const { proj, record } = project();
    const outside = plantEngineLink(record);
    const result = runHook(proj, "aidlc-validate-state.ts", COMPACT);
    expect(result.code, result.stderr).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
  });

  test.skipIf(!linksWork)("the creation receipt, the source snapshot and the active-directive marker never land outside", () => {
    const { proj, record } = project();
    const outside = plantEngineLink(record);
    leaveCreationReceipt(record, "00000000-0000-7000-8000-00000000abcd");
    const state = workspaceSourceState(proj);
    expect(state).not.toBeNull();
    // The advisory workspace listing is simply not kept; the audit-referenced
    // baseline refuses, so no approval is recorded without its evidence.
    expect(writeWorkspaceSourceSnapshot(proj, "code-generation", state!)).toBe(false);
    expect(() => writeBaselineSourceSnapshot(proj, "code-generation", state!.listing)).toThrow();
    const stateContent = readFileSync(join(record, "aidlc-state.md"), "utf-8");
    expect(() =>
      writeActiveDirectiveMarker(proj, { kind: "run-stage", stage: "code-generation", state_sha256: stateDigest(stateContent) })
    ).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  test("without a link, the block counter and the breadcrumb land where they belong", () => {
    const { proj, record } = project();
    expect(runHook(proj, "aidlc-continue-workflow.ts", STOP).code).toBe(0);
    expect(existsSync(join(record, ".aidlc-engine", "stop-hook", "block-count.json"))).toBe(true);
    expect(runHook(proj, "aidlc-validate-state.ts", COMPACT).code).toBe(0);
    expect(existsSync(join(record, ".aidlc-engine", "recovery.md"))).toBe(true);
  });
});
