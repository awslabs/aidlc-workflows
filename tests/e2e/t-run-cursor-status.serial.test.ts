// covers: file:skills/aidlc/SKILL.md
//
// t-run-cursor-status.serial.test.ts — drive `/aidlc --status` through the
// Cursor CLI's headless surface (`agent -p`) against the SHIPPED dist/cursor
// tree, and assert on the engine's real outputs. The cursor-run driver is the
// structured "logic half" for the cursor harness — the analogue of opencode's
// run driver (no tmux, no painted screen; the model's final message + the
// project's on-disk state are the observables).
//
// LIVE-PROVEN (2026-07-26, cursor-agent 2026.07.23 on Linux, Pro account):
// the same rig shape ran rules discovery (alwaysApply .mdc), /command
// invocation with inline args, native skill invocation, hooks.json firing
// (sessionStart context injection, preToolUse permission-deny), and subagent
// dispatch from .cursor/agents, recorded in the private compatibility-spike
// evidence. This test pins the cheap status journey so CI can
// re-verify the shipped tree end-to-end without burning a whole workflow.
//
// SCOPE: the no-state case ONLY (status with no workflow = print-directive
// terminal arm — turn-stable). With an ACTIVE workflow the conductor may
// legitimately resume it inside the same run turn (the forwarding loop lives
// in-turn), so a with-state "status is read-only" assert is not turn-stable
// here — same carve-out as the codex/opencode twins.
//
// What this proves on the SHIPPED tree, structurally:
//   - the /aidlc skill entry (.cursor/skills/aidlc/SKILL.md) resolves in a
//     print-mode run and forwards the flag text;
//   - the engine's print-directive terminal arm (status names no workflow);
//   - the shipped cli.json Shell(bun) allowlist admits the engine call
//     without -f/--force;
//   - nothing is scaffolded by a read-only utility.
//
// TRAP (live-verified): the Cursor CLI exits 0 on EVERY outcome — auth
// errors, plan-gated models, hard failures all return rc 0 with the error on
// the output stream. Never assert on the exit code alone; the engine's
// no-workflow text is the real observable.
//
// LIVE GATE: requires AIDLC_CURSOR_RUN_LIVE=1 + a cursor-agent binary
// (AIDLC_CURSOR_BIN or `agent` on PATH) + an authenticated Cursor account
// (`agent status`; API key via CURSOR_API_KEY also works) on a plan whose
// models the run can use (AIDLC_CURSOR_MODEL overrides; default "auto" works
// on every plan). Skips cleanly otherwise.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  runCursor,
  setupCursorProject,
} from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const CURSOR_DIST = join(REPO_ROOT, "dist", "cursor");
const CURSOR_BIN = process.env.AIDLC_CURSOR_BIN ?? "agent";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;

function cursorAuthed(): boolean {
  const r = spawnSync(CURSOR_BIN, ["status"], { encoding: "utf-8" });
  return r.status === 0 && (r.stdout ?? "").includes("Logged in");
}

function skipReason(): string | null {
  if (process.env.AIDLC_CURSOR_RUN_LIVE !== "1") {
    return "set AIDLC_CURSOR_RUN_LIVE=1 to run the live cursor-agent journey (uses your Cursor account)";
  }
  const which = spawnSync(CURSOR_BIN, ["--version"], { encoding: "utf-8" });
  if (which.status !== 0) return `cursor-agent not found (AIDLC_CURSOR_BIN=${CURSOR_BIN})`;
  if (!process.env.CURSOR_API_KEY && !cursorAuthed()) {
    return "no Cursor auth (run `agent login` or set CURSOR_API_KEY)";
  }
  if (!existsSync(CURSOR_DIST)) return `distributable missing: ${CURSOR_DIST}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-run-cursor-status — /aidlc --status on the shipped dist/cursor via agent -p", () => {
  test.skipIf(SKIP_REASON !== null)(
    `no-state: status renders 'no active workflow' and scaffolds nothing${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const { proj, root } = setupCursorProject();
      try {
        const r = runCursor(proj, "/aidlc --status");
        // rc is 0 on EVERY outcome on this CLI (live-verified trap) — surface
        // the output tail on any assert failure instead of trusting rc.
        expect({ rc: r.rc, tail: r.rc === 0 ? "" : r.out.slice(-2000) }).toEqual({
          rc: 0,
          tail: "",
        });
        // An auth/plan failure also exits 0; refuse to call that green.
        expect(r.out).not.toContain("Authentication required");
        expect(r.out).not.toContain("Named models unavailable");
        // The engine's no-workflow status text, surfaced verbatim by the
        // print-directive terminal arm.
        expect(r.out.toLowerCase()).toContain("no active");
        // A read-only utility scaffolds nothing: no intent record, no
        // workflow state anywhere under the workspace tree.
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
