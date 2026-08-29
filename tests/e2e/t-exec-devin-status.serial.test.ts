// covers: file:skills/aidlc/SKILL.md
//
// t-exec-devin-status.serial.test.ts — drive `/aidlc --status` through Devin
// CLI's headless surface (`devin -p`) against the SHIPPED dist/devin tree,
// and assert on the engine's real outputs. The devin-exec driver is the
// structured "logic half" for the Devin harness — the analogue of codex's
// exec driver (no tmux, no painted screen; the model's final message + the
// project's on-disk state are the observables).
//
// SCOPE: the no-state case ONLY (status with no workflow = print-directive
// terminal arm — turn-stable). With an ACTIVE workflow the conductor may
// legitimately resume it inside the same exec turn, so a with-state assert
// is not turn-stable here.
//
// What this proves on the SHIPPED tree, structurally:
//   - skill discovery at .devin/skills/aidlc under a real devin session;
//   - the engine's print-directive terminal arm (status names no workflow);
//   - nothing is scaffolded by a read-only utility (no aidlc-docs creature).
//
// LIVE GATE: requires AIDLC_DEVIN_EXEC_LIVE=1 + a devin binary (AIDLC_DEVIN_BIN
// or PATH). Skips cleanly otherwise.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  runDevin,
  setupDevinProject,
} from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const DEVIN_DIST = join(REPO_ROOT, "dist", "devin");
const DEVIN_BIN = process.env.AIDLC_DEVIN_BIN ?? "devin";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;

function devinVersionOk(): boolean {
  const r = spawnSync(DEVIN_BIN, ["--version"], { encoding: "utf-8" });
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.status !== 0 || !m) return false;
  const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Minimum Devin CLI version: 3000.3.0 (the modern .devin/ config layout).
  return maj > 3000 || (maj === 3000 && (min > 3 || (min === 3 && patch >= 0)));
}

function skipReason(): string | null {
  if (process.env.AIDLC_DEVIN_EXEC_LIVE !== "1") {
    return "set AIDLC_DEVIN_EXEC_LIVE=1 to run the live devin-exec journey";
  }
  if (!devinVersionOk()) return `devin >= 3000.3.0 not found (AIDLC_DEVIN_BIN=${DEVIN_BIN})`;
  if (!existsSync(DEVIN_DIST)) return `distributable missing: ${DEVIN_DIST}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-exec-devin-status — /aidlc --status on the shipped dist/devin via devin -p", () => {
  test.skipIf(SKIP_REASON !== null)(
    `no-state: status renders 'no active workflow' and scaffolds nothing${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const { proj, root } = setupDevinProject();
      try {
        const r = runDevin(proj, "Use the aidlc skill to run: /aidlc --status");
        expect(r.rc).toBe(0);
        // The engine's no-workflow status text, surfaced verbatim by the
        // print-directive terminal arm.
        expect(r.out.toLowerCase()).toContain("no active");
        // Read-only: the status path must not scaffold a workspace.
        expect(existsSync(join(proj, "aidlc", "spaces", "default", "intents"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
