// covers: render-surface:statusline-complete
//
// t-tui-render-complete.serial.tui.test.ts — the statusline COMPLETE sentinel
// branch (§5-C render row, §7 Phase 1), driven SEEDED-STATE in a REAL terminal
// with ZERO Bedrock tokens.
//
// The branch under test (aidlc-statusline.ts ~:230): when the seeded state's
// Status is "Completed"/"Complete" the hook prints
//   "[AIDLC] COMPLETE <completeBar>"
// where completeBar is the natural phase bar when it resolves, else a forced full
// bar. The completed fixture has OPERATION fully [x] (7/7), so progressBar(7,7)
// fills all 10 cells -> "[▓▓▓▓▓▓▓▓▓▓]". Assert the EXACT sentinel + full grid the
// branch should draw.
//
// COST: launches the claude TUI but submits NO prompt — it reaches the COMPLETE
// statusline state purely from the seeded state file, spending NO Bedrock tokens
// (the probe on 2026-06-04 verified this branch paints pre-turn on the live TUI).
// Needs tmux + claude + the distributable; absent any of those it SKIPs with a
// reason — never a hollow pass.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts — node on
// Windows so node-pty never loads under bun (#748), bun elsewhere. The driver
// auto-selects its backend by os.platform(); this test is platform-agnostic. The
// `tui-drive.ts` spawn is what DERIVES the `tui` mechanism (Phase 0) — no
// filename mechanism segment is needed or added.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "state-completed.md");
const IS_WIN = os.platform() === "win32";
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

function absentReason(): string | null {
  if (!IS_WIN && spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status !== 0) {
    return "tmux not found";
  }
  if (IS_WIN) {
    if (!WIN_NODE) return "node not found (required to run tui-drive on Windows — #748)";
    if (spawnSync(WIN_NODE, ["-e", "require('node-pty')"], { encoding: "utf-8" }).status !== 0) {
      return "node-pty not node-resolvable (npm install node-pty so node can require it)";
    }
  }
  if (spawnSync("claude", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  if (!existsSync(FIXTURE)) return `fixture missing: ${FIXTURE}`;
  return null;
}
const ABSENT_REASON = absentReason();

describe("t-tui-render statusline COMPLETE sentinel (seeded completed, no tokens)", () => {
  test.skipIf(ABSENT_REASON !== null)(
    `statusline-complete paints "[AIDLC] COMPLETE [▓▓▓▓▓▓▓▓▓▓]"${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""}`,
    () => {
      const session = `aidlc_tui_render_complete_${process.pid}`;
      const sandbox = mkdtempSync(join(tmpdir(), "aidlc-tui-render-complete-"));
      try {
        // --- copy the distributable per the README ----------------------------
        const destClaude = join(sandbox, ".claude");
        cpSync(AIDLC_SRC, destClaude, { recursive: true });
        expect(readFileSync(join(destClaude, "settings.json"), "utf8")).toContain('"statusLine"');

        // --- SEED aidlc-docs/aidlc-state.md from the completed fixture ---------
        // Status: Completed + OPERATION 7/7 -> the COMPLETE branch fires with a
        // full bar. State-driven; no prompt, no tokens.
        const docsDir = join(sandbox, "aidlc-docs");
        mkdirSync(docsDir, { recursive: true });
        writeFileSync(join(docsDir, "aidlc-state.md"), readFileSync(FIXTURE, "utf8"));

        // --- launch the claude TUI --------------------------------------------
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

        // --- clear the two startup modals (idempotent) ------------------------
        if (waitFor(session, "trust this folder", 60000, 600)) {
          drive(["send", "--session", session, "--keys", "1"]);
        }
        if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
          drive(["send", "--session", session, "--keys", "2"]);
        }

        // --- wait for the COMPLETE sentinel + assert the full grid ------------
        const sawMarker = waitFor(session, "\\[AIDLC\\] COMPLETE", 45000, 1000);
        const pane = drive(["capture", "--session", session]).stdout;
        if (!sawMarker) {
          throw new Error(
            `COMPLETE statusline never appeared in the TUI.\n` +
              `---- last pane ----\n${pane}\n-------------------`,
          );
        }
        // EXACT sentinel + full 10-cell bar the branch should draw.
        expect(pane).toContain("[AIDLC] COMPLETE [▓▓▓▓▓▓▓▓▓▓]");
      } finally {
        drive(["kill", "--session", session]);
        if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
