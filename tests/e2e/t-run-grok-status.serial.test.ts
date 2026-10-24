// covers: file:skills/aidlc/SKILL.md
//
// t-run-grok-status.serial.test.ts — drive `/aidlc --status` through Grok
// Build's headless surface (`grok -p`) against the shipped dist/grok tree,
// and assert on the engine's real outputs. The observables are the model's
// final message and the project's on-disk state.
//
// SCOPE: the no-state case ONLY (status with no workflow = print-directive
// terminal arm). A headless run does not mint a human turn, so this journey
// never approves a gate.
//
// What this proves on the shipped tree:
//   - the /aidlc skill (.grok/skills/aidlc/SKILL.md) resolves in a trusted
//     print-mode run and forwards the flag text;
//   - the engine's print-directive terminal arm (status names no workflow);
//   - nothing is scaffolded by a read-only utility.
//
// LIVE GATE: requires AIDLC_GROK_RUN_LIVE=1 + a grok binary (AIDLC_GROK_BIN
// or `grok` on PATH) + a signed-in Grok account (~/.grok/auth.json). Skips
// cleanly otherwise. Hosted CI does not run it: the CLI uses the account of
// the environment it is started in.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  runGrok,
  setupGrokProject,
} from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const GROK_DIST = join(REPO_ROOT, "dist", "grok");
const GROK_BIN = process.env.AIDLC_GROK_BIN ?? "grok";

const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);

function grokAuthed(): boolean {
  try {
    return statSync(join(homedir(), ".grok", "auth.json")).size > 0;
  } catch {
    return false;
  }
}

function skipReason(): string | null {
  if (process.env.AIDLC_GROK_RUN_LIVE !== "1") {
    return "set AIDLC_GROK_RUN_LIVE=1 to run the live Grok Build journey (uses your Grok account)";
  }
  const which = completedStartupProbe(spawnSync(GROK_BIN, ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" }));
  if (which.status !== 0) return `grok not found (AIDLC_GROK_BIN=${GROK_BIN})`;
  if (!grokAuthed()) return "no Grok auth (~/.grok/auth.json is missing; run `grok login`)";
  if (!existsSync(GROK_DIST)) return `distributable missing: ${GROK_DIST}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-run-grok-status — /aidlc --status on the shipped dist/grok via grok -p", () => {
  test.skipIf(SKIP_REASON !== null)(
    `no-state: status renders 'no active workflow' and scaffolds nothing${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const { proj, root } = setupGrokProject();
      try {
        const r = runGrok(proj, "/aidlc --status");
        expect({ rc: r.rc, tail: r.rc === 0 ? "" : r.out.slice(-2000) }).toEqual({
          rc: 0,
          tail: "",
        });
        expect(r.out.toLowerCase()).toContain("no active");
        expect(existsSync(join(proj, "aidlc", "spaces", "default", "intents", "intents.json"))).toBe(
          false,
        );
        expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
