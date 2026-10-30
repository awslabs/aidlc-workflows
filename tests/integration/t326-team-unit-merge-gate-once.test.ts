// covers: subcommand:aidlc-unit:pin, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:land, cli:aidlc-bolt(dispatch-event)

// After pin, a pinned Unit's merge gate is asked once and the person's first
// answer is the one recorded (#3302): the pin's own output carries the
// question, its strategy (a regular merge, whatever the team's default) and its
// target, and a reply after the pin is the human turn the gate counts. A Unit
// that is not pinned keeps its rules.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField,
  auditShardBlocks,
  readAllAuditShards,
  readUnitMergeTransaction,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  BOLT,
  UNIT,
  appendMainHumanTurn,
  cleanupTempDirs,
  git,
  makeSeed,
  prepareCandidate,
  replyAfterPin,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

function gate(seed: string, decision: "approve" | "reject", words: string) {
  return runMergeTool(
    UNIT,
    ["gate", "alpha", "--decision", decision, "--user-input", words],
    seed,
    true,
  );
}

function mergeGateRows(seed: string): string[] {
  return auditShardBlocks(readAllAuditShards(seed)).filter(
    (block) =>
      /^GATE_(APPROVED|REJECTED)$/.test(auditBlockField(block, "Event") ?? "") &&
      auditBlockField(block, "Gate Scope") === "unit-merge",
  );
}

function pinAlpha(seed: string): { pinned_oid: string; pin_id: string; generation: number } & Record<string, unknown> {
  const pin = runMergeTool(UNIT, ["pin", "alpha"], seed, true);
  expect(pin.status, pin.out).toBe(0);
  return JSON.parse(pin.stdout);
}

describe("t326 a pinned Unit's merge gate asks once", () => {
  test("after pin, the person's first Approve is recorded and the Unit lands", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    const pin = pinAlpha(seed);
    replyAfterPin(seed, "alpha");
    const approved = gate(seed, "approve", "Approve");
    expect(approved.status, approved.out).toBe(0);
    expect(JSON.parse(approved.stdout)).toMatchObject({ gated: true, decision: "approve" });
    expect(readAllAuditShards(seed)).not.toContain("MERGE_DISPATCH_");
    const rows = mergeGateRows(seed);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0], "Strategy")).toBe("merge");
    expect(auditBlockField(rows[0], "Target branch")).toBe("main");
    expect(auditBlockField(rows[0], "User Input")).toBe("Approve");

    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status, landed.out).toBe(0);
    const mergeOid = JSON.parse(landed.stdout).git_commit_oid as string;
    expect(git(seed, ["rev-list", "--parents", "-n", "1", mergeOid]).split(" ")).toContain(pin.pinned_oid);
  });

  test("a pinned Unit's merge is a regular merge while the team's default stays squash", () => {
    const { seed, remote } = makeSeed();
    expect(
      readFileSync(join(seed, "aidlc", "spaces", "default", "memory", "org.md"), "utf-8"),
    ).toContain("**squash-merged**");
    prepareCandidate(remote, "alpha", "alpha-team");
    const pin = pinAlpha(seed);
    // A lookup of the team's practices returns their default: squash.
    const bound = [
      "--slug", "alpha",
      "--pinned-oid", pin.pinned_oid,
      "--attempt-generation", String(pin.generation),
      "--pin-id", pin.pin_id,
    ];
    const invoked = runMergeTool(
      BOLT,
      ["dispatch-event", "--event", "MERGE_DISPATCH_INVOKED", ...bound, "--practices-excerpt", "squash-merged into main"],
      seed,
    );
    expect(invoked.status, invoked.out).toBe(0);
    const returned = runMergeTool(
      BOLT,
      [
        "dispatch-event", "--event", "MERGE_DISPATCH_RETURNED", ...bound,
        "--strategy", "squash", "--target", "main", "--confidence", "0.9", "--notes", "the team default",
      ],
      seed,
    );
    expect(returned.status, returned.out).toBe(0);
    replyAfterPin(seed, "alpha");
    const approved = gate(seed, "approve", "Approve");
    expect(approved.status, approved.out).toBe(0);
    const rows = mergeGateRows(seed);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0], "Strategy")).toBe("merge");
  });

  test("pin shows the merge gate in its own turn", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    const pin = pinAlpha(seed);
    expect(pin).not.toHaveProperty("merge_dispatch_required");
    const mergeGate = pin.merge_gate as Record<string, string>;
    expect(mergeGate).toMatchObject({ strategy: "merge", target_branch: "main" });
    expect(mergeGate.ask).toContain("alpha");
    expect(mergeGate.approve).toContain("unit gate alpha --decision approve --request-file aidlc/.aidlc-request-text/gate-alpha.txt");
    expect(mergeGate.reject).toContain("unit gate alpha --decision reject --request-file aidlc/.aidlc-request-text/gate-alpha.txt");
  });

  test("after Approve at the merge gate, the next step is the land", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    pinAlpha(seed);
    replyAfterPin(seed, "alpha");
    const approved = gate(seed, "approve", "Approve");
    expect(approved.status, approved.out).toBe(0);
    const land = JSON.parse(approved.stdout).land as Record<string, string>;
    expect(land.command).toContain("unit land alpha --target main");
    expect(land.step).toContain("now");
    const landed = runMergeTool(UNIT, ["land", "alpha", "--target", "main"], seed);
    expect(landed.status, landed.out).toBe(0);
    expect(JSON.parse(landed.stdout)).toMatchObject({ landed: true, status: "complete" });
  });

  test("after Reject at the merge gate, nothing lands", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    pinAlpha(seed);
    replyAfterPin(seed, "alpha");
    const rejected = gate(seed, "reject", "Reject");
    expect(rejected.status, rejected.out).toBe(0);
    expect(JSON.parse(rejected.stdout)).not.toHaveProperty("land");
  });

  test("the turn that ran the pin is not the answer; the reply after it is", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    // The person's own "/aidlc unit pin alpha", recorded before the pin runs.
    appendMainHumanTurn(seed);
    pinAlpha(seed);
    const early = gate(seed, "approve", "Approve");
    expect(early.status).not.toBe(0);
    expect(early.out).toContain("typed human turn");
    expect(mergeGateRows(seed)).toHaveLength(0);
    replyAfterPin(seed, "alpha");
    const approved = gate(seed, "approve", "Approve");
    expect(approved.status, approved.out).toBe(0);
    expect(mergeGateRows(seed)).toHaveLength(1);
  });

  test("a re-pin needs the person's reply after the new pin", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    const first = pinAlpha(seed);
    replyAfterPin(seed, "alpha");
    expect(gate(seed, "reject", "Reject").status).toBe(0);
    const second = pinAlpha(seed);
    expect(second.pin_id).not.toBe(first.pin_id);
    expect(readUnitMergeTransaction(seed, "alpha")?.status).toBe("pinned");
    const stale = gate(seed, "approve", "Approve");
    expect(stale.status).not.toBe(0);
    expect(stale.out).toContain("typed human turn");
    replyAfterPin(seed, "alpha");
    const approved = gate(seed, "approve", "Approve");
    expect(approved.status, approved.out).toBe(0);
  });

  test("a Unit that is not pinned keeps its rules", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    appendMainHumanTurn(seed);
    const unpinned = gate(seed, "approve", "Approve");
    expect(unpinned.status).not.toBe(0);
    expect(unpinned.out).toContain("has no pinned merge transaction");
    // A Bolt's merge-strategy lookup still records the team's squash.
    const bolt = runMergeTool(
      BOLT,
      [
        "dispatch-event", "--event", "MERGE_DISPATCH_RETURNED", "--slug", "bolt-1",
        "--strategy", "squash", "--target", "main", "--confidence", "1", "--notes", "trunk-based",
      ],
      seed,
    );
    expect(bolt.status, bolt.out).toBe(0);
    const row = auditShardBlocks(readAllAuditShards(seed)).find(
      (block) => auditBlockField(block, "Event") === "MERGE_DISPATCH_RETURNED",
    );
    expect(row && auditBlockField(row, "Strategy")).toBe("squash");
  });
});
