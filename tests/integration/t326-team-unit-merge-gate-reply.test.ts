// covers: subcommand:aidlc-unit:gate, audit:GATE_APPROVED, audit:GATE_REJECTED

// A pinned Unit's merge gate row keeps what the person said, as every stage
// gate's row does (#3316): their own words (Person Reply) and the message they
// came in (Message Id), read from the turns the human-turn hook kept after the
// pin, beside the agent's account (User Input or Feedback). Live on Claude
// Code, the person typed "1" at the merge gate and the row on main kept only
// "User Input: Approve". Words they typed before the pin answered something
// else and are not the gate's; with the human-presence guard off the row is as
// it was.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  auditBlockField,
  readAuditShardEvents,
  readUnitMergeTransaction,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-0000000c3316";

function chatEnv(): Record<string, string> {
  return { AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_UNATTENDED: "0" };
}

// What the person types in the lead's chat, through the real UserPromptSubmit
// route every harness uses.
function says(seed: string, prompt: string): string {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...chatEnv(),
    CLAUDE_PROJECT_DIR: seed,
    AIDLC_PROJECT_DIR: seed,
  };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const result = spawnSync(process.execPath, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: seed,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  const turn = readAuditShardEvents(seed).filter((row) => row.event === "HUMAN_TURN").at(-1);
  const id = turn ? auditBlockField(turn.block, "Message Id") : null;
  expect(id, "the hook kept the message").toBeTruthy();
  return id as string;
}

// After the pin's second, as the gate counts a turn (both are second-precision).
function afterPin(seed: string): void {
  const pinnedAt = readUnitMergeTransaction(seed, "alpha")?.pinned_at;
  expect(pinnedAt).toBeTruthy();
  while (new Date().toISOString().replace(/\.\d{3}Z$/, "Z") <= pinnedAt!) Bun.sleepSync(50);
}

function pinAlpha(seed: string): void {
  const pin = runMergeTool(UNIT, ["pin", "alpha"], seed, true, chatEnv());
  expect(pin.status, pin.out).toBe(0);
}

function gate(seed: string, decision: "approve" | "reject", account: string, guard = true) {
  return runMergeTool(
    UNIT,
    ["gate", "alpha", "--decision", decision, "--user-input", account],
    seed,
    guard,
    chatEnv(),
  );
}

function mergeGateRow(seed: string): string {
  const rows = readAuditShardEvents(seed).filter(
    (row) =>
      (row.event === "GATE_APPROVED" || row.event === "GATE_REJECTED") &&
      auditBlockField(row.block, "Gate Scope") === "unit-merge",
  );
  expect(rows).toHaveLength(1);
  return rows[0].block;
}

describe("t326 a pinned Unit's merge gate row keeps what the person said", () => {
  test("their 1 after the pin is the approval row's Person Reply, with its message", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    pinAlpha(seed);
    afterPin(seed);
    const message = says(seed, "1");
    const approved = gate(seed, "approve", "Approve");
    expect(approved.status, approved.out).toBe(0);
    const row = mergeGateRow(seed);
    expect(auditBlockField(row, "Event")).toBe("GATE_APPROVED");
    expect(auditBlockField(row, "Person Reply")).toBe("1");
    expect(auditBlockField(row, "Message Id")).toBe(message);
    expect(auditBlockField(row, "User Input")).toBe("Approve");
  });

  test("a reject keeps their words the same way, beside the agent's account", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    pinAlpha(seed);
    afterPin(seed);
    const words = "no, the tests are not in CI yet";
    const message = says(seed, words);
    const rejected = gate(seed, "reject", "Reject: tests not in CI");
    expect(rejected.status, rejected.out).toBe(0);
    const row = mergeGateRow(seed);
    expect(auditBlockField(row, "Event")).toBe("GATE_REJECTED");
    expect(auditBlockField(row, "Person Reply")).toBe(words);
    expect(auditBlockField(row, "Message Id")).toBe(message);
    expect(auditBlockField(row, "Feedback")).toBe("Reject: tests not in CI");
  });

  test("words typed before the pin are not the gate's", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    says(seed, "let's land alpha now");
    pinAlpha(seed);
    afterPin(seed);
    const message = says(seed, "1");
    const approved = gate(seed, "approve", "Approve");
    expect(approved.status, approved.out).toBe(0);
    const row = mergeGateRow(seed);
    expect(auditBlockField(row, "Message Id")).toBe(message);
    expect(auditBlockField(row, "Message Ids")).toBeNull();
    // Their words joined with the earlier line would not be the gate's alone.
    expect(auditBlockField(row, "Person Reply")).toBeNull();
  });

  test("after a reject and a re-pin, the approval keeps only the reply to the new pin", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    pinAlpha(seed);
    afterPin(seed);
    says(seed, "not yet, the tests are not in CI");
    expect(gate(seed, "reject", "Reject").status).toBe(0);
    pinAlpha(seed);
    afterPin(seed);
    const message = says(seed, "1");
    const approved = gate(seed, "approve", "Approve");
    expect(approved.status, approved.out).toBe(0);
    const row = readAuditShardEvents(seed).find((entry) =>
      entry.event === "GATE_APPROVED" && auditBlockField(entry.block, "Gate Scope") === "unit-merge");
    expect(row).toBeDefined();
    expect(auditBlockField(row!.block, "Person Reply")).toBe("1");
    expect(auditBlockField(row!.block, "Message Id")).toBe(message);
    expect(auditBlockField(row!.block, "Message Ids")).toBeNull();
  });

  test("with the human-presence guard off, the row is as it was", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    pinAlpha(seed);
    afterPin(seed);
    says(seed, "1");
    const approved = gate(seed, "approve", "Approve", false);
    expect(approved.status, approved.out).toBe(0);
    const row = mergeGateRow(seed);
    expect(auditBlockField(row, "Person Reply")).toBeNull();
    expect(auditBlockField(row, "Message Id")).toBeNull();
    expect(auditBlockField(row, "User Input")).toBe("Approve");
  });
});
