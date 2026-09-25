// covers: file:skills/aidlc/SKILL.md
//
// t-exec-codex-status.serial.test.ts — drive `$aidlc --status` through Codex
// CLI's headless surface (`codex exec`) against the SHIPPED dist/codex tree,
// and assert on the engine's real outputs. The codex-exec driver is the
// structured "logic half" for the Codex harness — the analogue of kiro's ACP
// driver (no tmux, no painted screen; the model's final message + the
// project's on-disk state are the observables).
//
// MR-6-PROVEN (2026-06-12, codex-cli 0.139.0 on Bedrock): the same rig shape
// ran a FULL poc workflow (INIT → 7 stages → Completed, 43 audit rows) with
// hooks live — transcript archived in the journey write-up. This test pins
// the cheap status journey so CI can re-verify the shipped tree end-to-end
// without burning a whole workflow.
//
// SCOPE: the no-state case ONLY (status with no workflow = print-directive
// terminal arm — turn-stable). With an ACTIVE workflow the conductor may
// legitimately resume it inside the same exec turn (the forwarding loop lives
// in-turn), so a with-state "status is read-only" assert is not turn-stable
// here; that contract holds on the interactive TUI, where turn boundaries are
// human-paced.
//
// What this proves on the SHIPPED tree, structurally:
//   - skill discovery at .agents/skills/aidlc under a real codex session;
//   - the engine's print-directive terminal arm (status names no workflow);
//   - nothing is scaffolded by a read-only utility (no aidlc-docs creature).
//
// LIVE GATE: requires AIDLC_CODEX_EXEC_LIVE=1 + a codex >= 0.145.0 binary
// (AIDLC_CODEX_BIN or PATH) + AWS creds for the Bedrock profile in
// AIDLC_CODEX_AWS_PROFILE (default "codex"). Skips cleanly otherwise.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, FILE_CLEANUP_RESERVE_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  execCodex,
  setupCodexProject,
} from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { codexExecDiagnostic, codexExecTimeout, withCodexFixture } from "../harness/codex-test-lifecycle.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";

const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);

function codexVersionOk(): boolean {
  const r = completedStartupProbe(spawnSync(CODEX_BIN, ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" }));
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.status !== 0 || !m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 145;
}

function skipReason(): string | null {
  if (process.env.AIDLC_CODEX_EXEC_LIVE !== "1") {
    return "set AIDLC_CODEX_EXEC_LIVE=1 to run the live codex-exec journey (uses Bedrock)";
  }
  if (!codexVersionOk()) return `codex >= 0.145.0 not found (AIDLC_CODEX_BIN=${CODEX_BIN})`;
  if (!existsSync(CODEX_DIST)) return `distributable missing: ${CODEX_DIST}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("Codex fixture failure and retirement contract", () => {
  const unowned = join(tmpdir(), "unowned-codex-proof");

  test("a cleanup failure preserves the original assertion object and cause", async () => {
    const primary = new Error("original return-code assertion");
    const cleanup = Object.assign(new Error("fixture still busy"), { code: "EBUSY" });
    const failure = await withCodexFixture(unowned, () => { throw cleanup; }, () => { throw primary; })
      .then(() => undefined, (error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toBe(primary);
    expect(failure.errors[1]).toBe(cleanup);
    expect(failure.cause).toBe(primary);
  });

  test("cleanup outside a verified runner context remains mandatory", async () => {
    const order: string[] = [];
    const cleanup = new Error("unowned cleanup refused");
    const failure = await withCodexFixture(unowned, () => { order.push("cleanup"); throw cleanup; },
      () => { order.push("body"); }).then(() => undefined, (error) => error);
    expect(order).toEqual(["body", "cleanup"]);
    expect(failure).toBe(cleanup);
  });

  test("exec diagnostics retain the beginning, tail and spawn failure within a bounded message", () => {
    const message = codexExecDiagnostic({
      rc: -1, signal: "SIGTERM", error: "ETIMEDOUT", out: `BEGIN${"x".repeat(40_000)}END`,
    });
    expect(message.length).toBeLessThan(13_000);
    expect(message).toContain("BEGIN");
    expect(message).toContain("END");
    expect(message).toContain("ETIMEDOUT");
    expect(message).toContain("SIGTERM");
  });

  test("an exec cannot consume the case's cleanup reserve", async () => {
    await withCodexFixture(unowned, () => {}, () => {
      expect(codexExecTimeout(600_000)).toBeLessThanOrEqual(15_000);
      expect(codexExecTimeout(600_000)).toBeGreaterThan(0);
    }, performance.now() + FILE_CLEANUP_RESERVE_MS + 15_000);
  });

  test("Windows runner-owned fixture deletion is handed to post-job cleanup with a receipt", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-exec-")));
    let removed = false;
    await withCodexFixture(root, () => { rmSync(root, { recursive: true, force: true }); removed = true; }, () => {});
    const isolatedWindows = process.platform === "win32" && process.env.AIDLC_CODEX_EXEC_LIVE === "1" &&
      /^[1-9]\d*$/.test(process.env.AIDLC_TEST_WORKER_ID ?? "");
    if (isolatedWindows) {
      expect(removed).toBe(false);
      expect(existsSync(root)).toBe(true);
      const artifacts = process.env.AIDLC_TEST_WORKER_ROOT!;
      const receipts = readdirSync(artifacts).filter((name) => name.startsWith("codex-deferred-cleanup-"))
        .map((name) => JSON.parse(readFileSync(join(artifacts, name), "utf8")));
      expect(receipts.some((record) => record.root === root && record.temporaryDirectory === process.env.TEMP)).toBe(true);
    } else {
      expect(removed).toBe(true);
      expect(existsSync(root)).toBe(false);
    }
  });
});

describe("t-exec-codex-status — $aidlc --status on the shipped dist/codex via codex exec", () => {
  test.skipIf(SKIP_REASON !== null)(
    `no-state: status renders 'no active workflow' and scaffolds nothing${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    async () => {
      const deadlineMs = performance.now() + TEST_TIMEOUT_MS;
      const { proj, home, root } = setupCodexProject();
      await withCodexFixture(root, () => rmSync(root, { recursive: true, force: true }), () => {
        const r = execCodex(proj, home, "Use the $aidlc skill to run: /aidlc --status");
        expect(r.rc, codexExecDiagnostic(r)).toBe(0);
        // The engine's no-workflow status text, surfaced verbatim by the
        // print-directive terminal arm.
        expect(r.out.toLowerCase().includes("no active"), codexExecDiagnostic(r)).toBe(true);
        // Read-only: the status path must not scaffold a workspace. The
        // hooks-health heartbeat dir is hook plumbing (the byte-shared Stop
        // hook writes it on every turn, same as the Claude harness) — the
        // workspace signals are the state file and the scaffold tree.
        expect(existsSync(join(proj, "aidlc-docs", "aidlc-state.md"))).toBe(false);
        expect(existsSync(join(proj, "aidlc-docs", "ideation"))).toBe(false);
      }, deadlineMs);
    },
    TEST_TIMEOUT_MS,
  );
});
