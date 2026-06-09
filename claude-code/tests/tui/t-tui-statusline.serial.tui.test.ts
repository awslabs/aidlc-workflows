// t-tui-statusline.serial.tui.test.ts — render-fidelity: the AI-DLC statusline
// draws in a REAL terminal (§5.2). A faithful port of the working spike
// tests/spike/t-tui-statusline.sh (91 lines, plan 3) — SAME flow, expressed in
// TS over the spawned tui-drive.ts subprocess instead of bash. No logic change.
//
// The flow the spike proved, step for step:
//   1. Copy the distributable exactly as the README says:
//        cp -r dist/claude/.claude/ <sandbox>/.claude/
//      (dest .claude must NOT pre-exist, or cp nests it).
//   2. Launch `claude` in a fixed-size session via the driver.
//   3. Clear the two startup modals the spike discovered:
//        a. workspace-trust dialog     -> "1. Yes, I trust"
//        b. bypass-permissions warning  -> "2. Yes, I accept"
//   4. Wait for the statusline marker "[AIDLC]" to paint and settle.
//   5. Assert the captured pane contains "[AIDLC] ready" — the no-workflow
//      statusline output from aidlc-statusline.ts (no aidlc-docs/ present).
//
// COST: this launches the claude TUI but submits NO prompt, so it reaches the
// `ready` statusline state WITHOUT a Bedrock turn — it spends NO tokens (unlike
// t-tui-workshop, which is AIDLC_TUI_LIVE-gated). It needs tmux + claude + the
// distributable; absent any of those it SKIPs with a reason.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts as a
// subprocess — node on Windows so node-pty never loads under bun (#748), bun
// elsewhere (tmux is a subprocess anyway). The driver auto-selects its backend
// by os.platform(); this test is platform-agnostic.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const IS_WIN = os.platform() === "win32";
// node on Windows (#748), resolved because the box's node is off PATH; the .ts
// entrypoint needs --experimental-strip-types under node < 22.18. bun elsewhere
// (runs .ts natively, no flag — byte-identical to the spike).
const WIN_NODE = IS_WIN ? resolveWinNode() : null;

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(args: string[]): Run {
  const [bin, prefix] = IS_WIN
    ? [WIN_NODE as string, ["--experimental-strip-types", DRIVER]]
    : [process.execPath, [DRIVER]];
  const res = spawnSync(bin, [...prefix, ...args], { encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
// `wait` returns nonzero on timeout — we want a boolean for the idempotent modal
// clears (only act if the modal is present), mirroring the spike's
// `if drive wait ...; then send; fi`.
function waitFor(session: string, pattern: string, timeoutMs: number, stableMs: number): boolean {
  return (
    drive([
      "wait",
      "--session",
      session,
      "--pattern",
      pattern,
      "--timeout-ms",
      String(timeoutMs),
      "--stable-ms",
      String(stableMs),
    ]).rc === 0
  );
}

// ABSENT detection (skip-with-reason). On POSIX the substrate is tmux; claude
// is needed on every platform; the distributable must be present to copy.
function absentReason(): string | null {
  if (!IS_WIN && spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status !== 0) {
    return "tmux not found";
  }
  if (IS_WIN) {
    // node may be off PATH (proven on the EC2 box) — resolve a concrete binary
    // and test node-pty resolvability with IT, not a bare `node`. Both absent ->
    // clean SKIP (capability absent).
    if (!WIN_NODE) return "node not found (required to run tui-drive on Windows — #748)";
    if (spawnSync(WIN_NODE, ["-e", "require('node-pty')"], { encoding: "utf-8" }).status !== 0) {
      return "node-pty not node-resolvable (npm install node-pty so node can require it)";
    }
  }
  if (spawnSync("claude", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  return null;
}
const ABSENT_REASON = absentReason();

describe("t-tui-statusline (statusline renders in a real terminal)", () => {
  test.skipIf(ABSENT_REASON !== null)(
    `[AIDLC] ready paints in the launched TUI${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""}`,
    () => {
      const session = `aidlc_tui_statusline_${process.pid}`;
      const sandbox = mkdtempSync(join(tmpdir(), "aidlc-tui-statusline-"));
      try {
        // --- step 1: copy the distributable per the README ---------------------
        // README: `cp -r dist/claude/.claude/ your-project/.claude/`. The
        // dest .claude must NOT pre-exist or cp nests it — we copy SRC -> <sandbox>/.claude.
        const destClaude = join(sandbox, ".claude");
        cpSync(AIDLC_SRC, destClaude, { recursive: true });
        const settingsPath = join(destClaude, "settings.json");
        expect(existsSync(settingsPath)).toBe(true);
        // P0a — the retired spike (git show 4ce826b:tests/spike/t-tui-statusline.sh
        // ~L55) also required settings.json to CARRY the "statusLine" key, not just
        // exist: that key is what wires aidlc-statusline.ts into the TUI, so a copy
        // that drops it would render no `[AIDLC]` line at all. Restore that guard.
        expect(readFileSync(settingsPath, "utf8")).toContain('"statusLine"');

        // --- step 2: launch the claude TUI ------------------------------------
        const started = drive([
          "start",
          "--session",
          session,
          "--cwd",
          sandbox,
          "--width",
          "120",
          "--height",
          "40",
          "--",
          "claude",
          "--dangerously-skip-permissions",
        ]);
        expect(started.rc).toBe(0);

        // --- step 3: clear the two startup modals (idempotent) ----------------
        // 3a. workspace-trust dialog: "1. Yes, I trust this folder".
        if (waitFor(session, "trust this folder", 60000, 600)) {
          drive(["send", "--session", session, "--keys", "1"]);
        }
        // 3b. bypass-permissions warning: "2. Yes, I accept" (only with
        // --dangerously-skip-permissions).
        if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
          drive(["send", "--session", session, "--keys", "2"]);
        }

        // --- step 4: wait for the statusline marker ---------------------------
        const sawMarker = waitFor(session, "\\[AIDLC\\]", 45000, 1000);
        if (!sawMarker) {
          const pane = drive(["capture", "--session", session]).stdout;
          throw new Error(
            `statusline marker [AIDLC] never appeared in the TUI.\n` +
              `---- last pane ----\n${pane}\n-------------------`,
          );
        }

        // --- step 5: assert the rendered statusline content -------------------
        // The no-workflow state (no aidlc-docs/ present) renders "[AIDLC] ready"
        // (aidlc-statusline.ts). This is the one thing the SDK path cannot see —
        // the painted statusline.
        const pane = drive(["capture", "--session", session]).stdout;
        expect(pane).toContain("[AIDLC] ready");
      } finally {
        drive(["kill", "--session", session]);
        if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
