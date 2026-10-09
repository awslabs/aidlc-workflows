// covers: hook:aidlc-record-human-turn, subcommand:aidlc-swarm:finalize, subcommand:aidlc-audit:audit-merge
//
// A swarm worker builds in the worktree swarm prepare made for it. On Codex the
// worker is its own session (`codex exec -C <worktree>`), so its brief reaches
// the human-turn hook as a UserPromptSubmit with the worktree as the project.
// That turn is the conductor's, never a person's: no HUMAN_TURN (nor any other
// authority row) lands in the worktree record, which finalize merges back into
// the main record and whose merge refuses every authority row. The heartbeat
// and the conversational marker still land, nothing is printed about it, and
// the Unit lands. The main checkout keeps minting the person's turn.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditShardDir,
  humanTurnMarkerPath,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  checkReviewFinalizeAndLand, cleanupCheckpointFixtures, fixture, prepare, runCheckpointTool, wt, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const WORKER_SESSION = "01a11f64-8fb5-76d1-9b8b-f2ad35e1674f";
const BRIEF = "Implement alpha in this worktree until the convergence check passes.";

// Every row of every shard in a record's audit directory (the worktree mirror's
// shard is named after the main clone, so the directory is read whole). The
// mirror starts as a copy of the main shard up to AUDIT_FORKED, so the person's
// own earlier turns are in it; what the worker adds is the text after that copy.
function auditRows(projectDir: string): string {
  const dir = auditShardDir(projectDir);
  if (dir === null || !existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md")).sort()
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

function events(rows: string): string[] {
  return [...rows.matchAll(/^\*\*Event\*\*: (\S+)$/gm)].map((match) => match[1]);
}

// The worker's session, as Codex runs it: SessionStart, then its brief as a
// UserPromptSubmit, both with the worktree as the project.
function workerTurn(worktree: string) {
  const started = runCheckpointTool(worktree, "tools/aidlc.ts", ["engine", "hook", "session-start"], {
    hook_event_name: "SessionStart", source: "startup", session_id: WORKER_SESSION,
  });
  expect(started.code, started.err).toBe(0);
  return runCheckpointTool(worktree, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: WORKER_SESSION, prompt: BRIEF,
  });
}

describe("a swarm worker's prompt is not a human turn", () => {
  test("the worker's turn leaves no authority row in its worktree, says nothing, and the Unit lands", () => {
    const pd = fixture(["alpha"]);
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const worktree = wt(pd);
    const mainRowsBefore = auditRows(pd);
    const forkedRows = auditRows(worktree);
    expect(events(forkedRows).at(-1)).toBe("AUDIT_FORKED");

    const turn = workerTurn(worktree);
    expect(turn.code, turn.err).toBe(0);
    expect(turn.out.trim()).toBe("");
    expect(turn.err.trim()).toBe("");

    // The worker's session is on the record; its brief is not a person's turn.
    const added = auditRows(worktree).slice(forkedRows.length);
    expect(events(added)).toEqual(["SESSION_STARTED"]);
    expect(existsSync(humanTurnMarkerPath(worktree))).toBe(true);
    expect(auditRows(pd)).toBe(mainRowsBefore);

    writeUnitSource(pd, "alpha", 2);
    checkReviewFinalizeAndLand(pd, { alpha: 2 });
  });

  test("the main checkout still records the person's turn", () => {
    const pd = fixture(["alpha"]);
    const before = readAuditShardEvents(pd).filter((row) => row.event === "HUMAN_TURN").length;
    const turn = runCheckpointTool(pd, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"], {
      hook_event_name: "UserPromptSubmit", session_id: WORKER_SESSION, prompt: "Looks good, carry on.",
    });
    expect(turn.code, turn.err).toBe(0);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "HUMAN_TURN")).toHaveLength(before + 1);
  });
});
