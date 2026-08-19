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

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  execCodex,
  setupCodexProject,
} from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const CODEX_DIST = join(REPO_ROOT, "dist", "codex");
const CODEX_BIN = process.env.AIDLC_CODEX_BIN ?? "codex";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;

function codexVersionOk(): boolean {
  const r = spawnSync(CODEX_BIN, ["--version"], { encoding: "utf-8" });
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

describe("t-exec-codex-status — $aidlc --status on the shipped dist/codex via codex exec", () => {
  test.skipIf(SKIP_REASON !== null)(
    `no-state: status renders 'no active workflow' and scaffolds nothing${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const { proj, home, root } = setupCodexProject();
      try {
        const r = execCodex(proj, home, "Use the $aidlc skill to run: /aidlc --status");
        expect(r.rc).toBe(0);
        // The engine's no-workflow status text, surfaced verbatim by the
        // print-directive terminal arm.
        expect(r.out.toLowerCase()).toContain("no active");
        // Read-only: the status path must not scaffold a workspace. The
        // hooks-health heartbeat dir is hook plumbing (the byte-shared Stop
        // hook writes it on every turn, same as the Claude harness) — the
        // workspace signals are the state file and the scaffold tree.
        expect(existsSync(join(proj, "aidlc-docs", "aidlc-state.md"))).toBe(false);
        expect(existsSync(join(proj, "aidlc-docs", "ideation"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
