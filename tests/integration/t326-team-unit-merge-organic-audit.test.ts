// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, function:transportedAuditViolation

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSessionPidEntry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, seededAuditDir, seededRecordDir } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  git,
  runMergeTool,
  makeSeed,
  prepareCandidate,
} from "../harness/team-unit-merge.ts";

// A claimed team Unit's own clone writes every row its session's hooks write
// (session start/end, human-turn, subagent tracking, doctor, sensors, guards)
// to its local record, and only the rows pin accepts to the claim's tracked
// shard, the one publish ships. This drives a claimed clone through those real
// hooks (not a hand-written fixture shard) so the organic rows a real session
// leaves behind are exercised end to end.

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const SESSION_START_HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const LOG_SUBAGENT_HOOK = join(AIDLC_SRC, "hooks", "aidlc-log-subagent.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");

function fireHook(hookPath: string, checkout: string, stdinJson: unknown): void {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: checkout,
    input: JSON.stringify(stdinJson),
    env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
    encoding: "utf-8",
  });
  expect(
    result.status,
    `${hookPath}: ${result.stdout ?? ""}${result.stderr ?? ""}`,
  ).toBe(0);
}

// record-human-turn additionally gates on this session having "joined" the
// claimed clone's own workflow (workflowParticipation), which the dispatcher
// route (the real settings.json wiring) resolves the same way the mint hook
// itself does; invoke it the same way rather than the bare hook script.
function fireHumanTurnHook(checkout: string, payload: unknown): void {
  const result = spawnSync(process.execPath, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: checkout,
    input: JSON.stringify(payload),
    env: { ...process.env, AIDLC_PROJECT_DIR: checkout },
    encoding: "utf-8",
  });
  expect(
    result.status,
    `record-human-turn: ${result.stdout ?? ""}${result.stderr ?? ""}`,
  ).toBe(0);
}

// An answered question box, as the host hands one back: the reply is keyed by
// the question's own text. This mints QUESTION_REPLIED, which no allowlist
// names - the case the 13-event version of this fix still blocked.
function firePickerReply(checkout: string, sessionId: string): void {
  const question = "Which approach should the Unit take?";
  fireHumanTurnHook(checkout, {
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    session_id: sessionId,
    tool_input: {
      questions: [{
        question,
        options: [{ label: "Keep the current shape" }, { label: "Split the module" }],
      }],
    },
    tool_response: { answers: { [question]: "Keep the current shape" } },
  });
}

describe("t326 pinned team Unit merge: organic audit noise", () => {
  test("a claimed clone's own session hooks do not poison its published candidate", () => {
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-organic");
    const { checkout } = candidate;

    // Real hooks, not hand-written fixture rows: a session start, a human
    // turn, a subagent completion, and a doctor run all land in the clone's
    // own shard alongside its UNIT_COMPLETED/GATE_APPROVED/... receipts.
    const sessionId = "01995000-0326-7000-8000-00000000a17a";
    fireHook(SESSION_START_HOOK, checkout, { source: "startup" });
    // Joins the claimed clone's own workflow as its session, the same way the
    // real dispatcher's own session does: without it, record-human-turn
    // mints nothing (a conversation outside the selected workflow is not a
    // human at its gates).
    writeSessionPidEntry(checkout, process.pid, sessionId);
    fireHumanTurnHook(checkout, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
    });
    firePickerReply(checkout, sessionId);
    fireHook(LOG_SUBAGENT_HOOK, checkout, {
      hook_event_name: "SubagentStop",
      agent_type: "aidlc-developer-agent",
      agent_id: "r1",
    });
    // This fixture checkout is a synthetic test project, not a full installed
    // harness tree, so doctor reports real problems (missing settings.json,
    // etc.) and exits non-zero; it still appends GUARDRAIL_LOADED/
    // HEALTH_CHECKED to the shard either way, which is all this case needs.
    runMergeTool(UTILITY, ["doctor"], checkout);

    const shardPath = join(seededAuditDir(checkout), candidate.auditShard);
    const localPath = join(seededRecordDir(checkout), ".aidlc-engine", "audit", candidate.auditShard);
    const shardAfterHooks = readFileSync(shardPath, "utf-8");
    const localAfterHooks = readFileSync(localPath, "utf-8");
    for (
      const event of [
        "SESSION_STARTED",
        "HUMAN_TURN",
        // On neither pin's allowlist nor any hand-written noise list: the
        // proof that the writer defers to pin's one predicate, not a second list.
        "QUESTION_REPLIED",
        "SUBAGENT_COMPLETED",
        "GUARDRAIL_LOADED",
        "HEALTH_CHECKED",
      ]
    ) {
      expect(localAfterHooks, `missing ${event} after firing real hooks`)
        .toContain(`**Event**: ${event}`);
      expect(shardAfterHooks, `${event} reached the tracked shard`)
        .not.toContain(`**Event**: ${event}`);
    }

    // The session's rows left the tracked tree as it was: nothing to commit
    // before the publish.
    expect(git(checkout, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
    const republished = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(republished.status, republished.out).toBe(0);
    expect(JSON.parse(republished.stdout)).not.toHaveProperty("local_rows_withheld");
    // The clone's own record still holds everything it ever wrote.
    expect(readFileSync(shardPath, "utf-8")).toBe(shardAfterHooks);
    expect(readFileSync(localPath, "utf-8")).toBe(localAfterHooks);

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });

  test("a noise event minted before any Unit work still lets the candidate publish and pin", () => {
    // A fresh checkout's very first shard write is typically a real
    // session-start, before any Unit work exists yet: the one-line shard
    // header has no `---` separator before the first block, so it is fused
    // to that first block's own text. Pin this ordering specifically, since
    // every other case here (and the hand-written t326 fixtures generally)
    // happens to append noise AFTER the real receipts, never before.
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-noise-first", {
      afterClaim: (checkout) => {
        fireHook(SESSION_START_HOOK, checkout, { source: "startup" });
      },
    });

    const shardPath = join(seededAuditDir(candidate.checkout), candidate.auditShard);
    const localPath = join(seededRecordDir(candidate.checkout), ".aidlc-engine", "audit", candidate.auditShard);
    expect(readFileSync(localPath, "utf-8").startsWith("# AI-DLC Audit Log\n\n## Session Start\n"))
      .toBe(true);
    expect(readFileSync(shardPath, "utf-8")).not.toContain("## Session Start");

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });
});
