// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:land, audit:UNIT_MERGED, function:UNIT_MERGE_DIR, function:unitMergedReceipts

import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  REPO_ROOT,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  UNIT,
  tempDirs,
  cleanupTempDirs,
  git,
  runMergeTool,
  makeSeed,
  clone,
  prepareCandidate,
  dispatchMerge,
  approveMerge,
  gateAndLand,
  nextDirective,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

// The pinned merge cases are split across four files
// (t326-team-unit-merge*.test.ts) so the integration tier runs them in
// parallel; the shared fixture is tests/harness/team-unit-merge.ts.

// Several independent Git trees and CLI sessions share each case. Use the
// generous workload backstop for both its work and its afterEach cleanup.
setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

describe("t326 pinned team Unit merge", () => {
  test("full round trip lands content first, folds receipts, reopens dependencies, and advances after final row", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team");
    const alpha = gateAndLand(seed, "alpha", true);
    expect(alpha.pinnedOid).toHaveLength(40);
    expect(unitProgressRow(seed, "alpha")).toBe(
      "| alpha | alpha-team | [x] | [x] | [x] | [x] | [x] | [x] | [x] |",
    );
    expect(unitProgressRow(seed, "beta")).toBe(
      "| beta | - | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |",
    );
    const alphaEvents = readAllAuditShards(seed).match(/\*\*Event\*\*: UNIT_MERGED/g) ?? [];
    expect(alphaEvents).toHaveLength(1);
    expect(readAllAuditShards(seed)).toContain(
      "**Event**: MERGE_DISPATCH_INVOKED",
    );
    expect(readAllAuditShards(seed)).toContain(
      "**Event**: MERGE_DISPATCH_RETURNED",
    );
    git(seed, ["push", "origin", "main"]);

    const status = runMergeTool(UNIT, ["status"], seed);
    expect(status.status, status.out).toBe(0);
    expect(JSON.parse(status.stdout).claimable).toContain("beta");

    prepareCandidate(remote, "beta", "beta-team");
    gateAndLand(seed, "beta");
    expect(
      readAllAuditShards(seed).match(/\*\*Event\*\*: UNIT_MERGED/g) ?? [],
    ).toHaveLength(2);
    expect(nextDirective(seed)).toMatchObject({
      kind: "run-stage",
      stage: "build-and-test",
    });
    const completedState = readFileSync(seededStateFile(seed), "utf-8");
    const completedAudit = readAllAuditShards(seed);
    const completeRetry = runMergeTool(UNIT, ["land", "beta"], seed);
    expect(completeRetry.status, completeRetry.out).toBe(0);
    expect(readFileSync(seededStateFile(seed), "utf-8")).toBe(completedState);
    expect(readAllAuditShards(seed)).toBe(completedAudit);
  // Two full gate-and-land cycles measure ~110 s alone on an M3 Pro (each tool call is a fresh bun process), so 120 s leaves no headroom under --parallel 4.
  });

  // #1286: under bun the state fold reaches aidlc-state.ts directly, so only a
  // compiled install crosses the dispatcher. Compile the release projection and
  // land the state step with it: the fold must route through `engine state`,
  // which the state-passthrough allowlist must carry.
  test("a compiled install folds a landed Unit through the engine state route", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-native");
    const { stateBeforeGit } = approveMerge(seed, "alpha");
    const gitStep = runMergeTool(UNIT, ["land", "alpha", "--step", "git"], seed);
    expect(gitStep.status, gitStep.out).toBe(0);
    expect(readFileSync(seededStateFile(seed), "utf-8")).toBe(stateBeforeGit);

    const binDir = mkdtempSync(join(tmpdir(), "aidlc-t326-native-"));
    tempDirs.push(binDir);
    const executable = join(binDir, process.platform === "win32" ? "aidlc.exe" : "aidlc");
    const built = spawnSync(
      process.execPath,
      [
        "build",
        "--compile",
        join(REPO_ROOT, "dist-release", "claude", ".claude", "tools", "aidlc.ts"),
        "--outfile",
        executable,
      ],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: 60_000 },
    );
    if (built.error) throw built.error;
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);

    const stateStep = spawnSync(
      executable,
      ["unit", "land", "alpha", "--step", "state", "--project-dir", seed],
      {
        cwd: seed,
        encoding: "utf-8",
        env: {
          ...process.env,
          // A native install reads its generated data from a runtime root
          // beside the binary; point it at the projection instead.
          AIDLC_RUNTIME_HARNESS_ROOT: AIDLC_SRC,
          AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
          AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
          AIDLC_SKIP_ARTIFACT_GUARD: "1",
        },
      },
    );
    const out = `${stateStep.stdout ?? ""}${stateStep.stderr ?? ""}`;
    expect(out).not.toContain("unknown command");
    expect(out).not.toContain("unknown verb");
    expect(stateStep.status, out).toBe(0);
    expect(readFileSync(seededStateFile(seed), "utf-8")).toContain("| merged |");
    expect(unitProgressRow(seed, "alpha")).toBe(
      "| alpha | alpha-native | [x] | [x] | [x] | [x] | [x] | [x] | [x] |",
    );
  }, 180000);

  test("moved refs require re-pin", () => {
    const { seed, remote } = makeSeed();
    const first = prepareCandidate(remote, "alpha", "move-team");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    writeFileSync(
      join(first.checkout, "src", "alpha.ts"),
      'export const alpha = "moved";\n',
    );
    git(first.checkout, ["add", "-A"]);
    git(first.checkout, ["commit", "-m", "move candidate"]);
    expect(runMergeTool(UNIT, ["publish", "alpha"], first.checkout).status).toBe(0);
    const movedGate = runMergeTool(
      UNIT,
      ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
      seed,
    );
    expect(movedGate.status).not.toBe(0);
    expect(movedGate.out).toContain("run aidlc-unit pin alpha again");
    const repin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(repin.status, repin.out).toBe(0);
    const repinPayload = JSON.parse(repin.stdout);
    dispatchMerge(
      seed,
      "alpha",
      repinPayload.pinned_oid,
      repinPayload.generation,
    );
    expect(
      runMergeTool(
        UNIT,
        ["gate", "alpha", "--decision", "approve", "--user-input", "Approve"],
        seed,
      ).status,
    ).toBe(0);
    expect(runMergeTool(UNIT, ["land", "alpha"], seed).status).toBe(0);
    expect(readFileSync(join(seed, "src", "alpha.ts"), "utf-8")).toContain(
      "moved",
    );
  });

  test("released attempts cannot pin", () => {
    const released = makeSeed();
    prepareCandidate(released.remote, "alpha", "release-team");
    const releaseMain = clone(released.remote, "release-main");
    expect(runMergeTool(UNIT, ["release", "alpha"], releaseMain).status).toBe(0);
    const stalePin = runMergeTool(UNIT, ["pin", "alpha"], released.seed);
    expect(stalePin.status).not.toBe(0);
    expect(stalePin.out).toContain("no published live candidate");
  });

});
