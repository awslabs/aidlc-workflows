// covers: render-surface:statusline-colour
//
// t-tui-render-colour.serial.tui.test.ts — the statusline context-window COLOUR
// branch (§5-C render row, §7 Phase 3), proven through the hook bytes and a REAL
// terminal render.
//
// The branch under test (aidlc-statusline.ts:54-58, contextColor): the right side
// paints "ctx:N%" wrapped in an SGR colour escape chosen by the context-window
// usage — green (\x1b[32m) < 50%, yellow (\x1b[33m) >= 50%, red (\x1b[31m) >= 75%.
//
// WHY THIS IS A LIVE TEST (not seeded/token-free like the other render units):
// ctx:N% is driven by input.context_window.used_percentage, which Claude Code only
// populates AFTER a turn has consumed context. A seeded-state idle TUI paints the
// model ("BR:opus-4-8[1m]") but NO ctx:%, so contextColor is never called pre-turn
// (verified by probe 2026-06-06). So this test first invokes the copied hook
// directly with synthetic context JSON to prove the green SGR branch is alive,
// then submits a trivial one-word live prompt to prove a user-visible TUI status
// row renders ctx:N%. COST: a few hundred Bedrock tokens (one tiny turn) — gated
// behind AIDLC_TUI_LIVE=1.
//
// PLATFORM SCOPE — macOS only, by harness capability (verified, not a weakness):
// the colour assertion needs the captured pane to PRESERVE the SGR escape. tmux
// `capture-pane -e` does (tui-drive.ts:288-291). The Windows node-pty backend has
// NO colour-escape passthrough — it explicitly ignores --ansi and returns the plain
// reconstructed grid (tui-drive.ts:413-416). The PRODUCT paints colour identically
// on both platforms (the same TS hook runs); only this TEST HARNESS's Windows
// capture is blind to it. So on Windows this test SKIPs with that reason rather than
// faking a pass — a documented harness-capability gap, NOT a product divergence.
// (Teaching the node-pty backend an @xterm/headless SGR-serialize path so Windows
// could assert colour too is a deferred follow-up, decided 2026-06-06.)
//
// RECONCILIATION (verified live with NDJSON 2026-06-09): the hook stdout still
// contains ESC [32m ctx:N% ESC [0m, but current Claude Code strips that hook SGR
// before painting the statusline pane. tmux capture therefore proves the live ctx
// token, not the colour byte. If a later Claude renderer preserves the SGR again,
// this test accepts that stronger evidence.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts. The
// `tui-drive.ts` spawn is what DERIVES the `tui` mechanism (Phase 0) — no filename
// mechanism segment is needed or added.

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
const FIXTURE = join(import.meta.dir, "..", "fixtures", "state-mid-ideation.md");
const IS_WIN = os.platform() === "win32";
const WIN_NODE = IS_WIN ? resolveWinNode() : null;

// Generous live-turn budget — one tiny turn, but tmux+claude startup + a real
// Bedrock round-trip. Honour the suite's AIDLC_TEST_TIMEOUT (seconds).
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;

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
function runStatuslineHook(hook: string, projectDir: string, pct: number): Run {
  const input = JSON.stringify({
    workspace: { project_dir: projectDir },
    model: { id: "us.anthropic.claude-opus-4-20250514-v1:0" },
    context_window: { used_percentage: pct },
  });
  const res = spawnSync(process.execPath, [hook], { encoding: "utf-8", input });
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

// Gating. AIDLC_TUI_LIVE=1 first (this spends tokens). Then the Windows
// capability gap: node-pty cannot capture colour escapes, so the colour assertion
// is unprovable there — SKIP with that reason rather than fake it. Then substrate.
function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live colour render (uses Bedrock tokens)";
  }
  if (IS_WIN) {
    return "node-pty backend strips colour escapes (#748, tui-drive.ts:398-401) — colour capture is macOS/tmux-only; the product paints colour identically on Windows, only the test harness cannot capture it";
  }
  if (spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status !== 0) {
    return "tmux not found";
  }
  if (spawnSync("claude", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  if (!existsSync(FIXTURE)) return `fixture missing: ${FIXTURE}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-tui-render statusline COLOUR branch (live turn populates ctx:%, macOS)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `statusline-colour emits green SGR and the live TUI renders ctx:N%${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    () => {
      const session = `aidlc_tui_render_colour_${process.pid}`;
      const sandbox = mkdtempSync(join(tmpdir(), "aidlc-tui-render-colour-"));
      try {
        // --- copy the distributable + seed mid-ideation state -----------------
        const destClaude = join(sandbox, ".claude");
        cpSync(AIDLC_SRC, destClaude, { recursive: true });
        expect(readFileSync(join(destClaude, "settings.json"), "utf8")).toContain('"statusLine"');
        const docsDir = join(sandbox, "aidlc-docs");
        mkdirSync(docsDir, { recursive: true });
        writeFileSync(join(docsDir, "aidlc-state.md"), readFileSync(FIXTURE, "utf8"));
        const ESC = String.fromCharCode(0x1b);

        // Prove the product hook's colour branch directly: with a synthetic low
        // context percentage it emits the green SGR wrapper around the ctx token.
        const hook = join(destClaude, "hooks", "aidlc-statusline.ts");
        const hookOut = runStatuslineHook(hook, sandbox, 4);
        expect(hookOut.rc).toBe(0);
        expect(hookOut.stdout).toMatch(new RegExp(`${ESC}\\[32mctx:4%${ESC}\\[0m`));

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
        expect(waitFor(session, "\\[AIDLC\\] IDEATION", 45000, 1000)).toBe(true);

        // --- submit a trivial prompt to consume context (populate ctx:%) ------
        // One word back; the smallest turn that still advances the context window.
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "Reply with only the single word: ok",
        ]);
        // Wait for ctx:% to appear in the statusline (the turn consumed context).
        // The statusline repaints each render; ctx:N% shows up once used_percentage
        // is populated. Match on the literal "ctx:" token in the (plain) pane.
        // The pane is still streaming while the stop hook/orchestrator notices
        // the seeded pending step, so requiring a byte-stable screen can miss a
        // ctx:N% token that is plainly rendered. Match immediately once present.
        expect(waitFor(session, "ctx:\\d", 180000, 0)).toBe(true);

        // --- assert the live statusline token in the ANSI capture --------------
        // The hook branch is proven above. On the current Claude Code renderer,
        // the statusline pane strips hook SGR while preserving the text token. If
        // the renderer starts preserving SGR again, accept that stronger evidence.
        const ansi = drive(["capture", "--session", session, "--ansi"]).stdout;
        expect(ansi).toMatch(/ctx:\d+%/);
        const colourPainted = new RegExp(`${ESC}\\[3[123]m\\s*ctx:\\d`).test(ansi);
        if (colourPainted) {
          expect(ansi).toMatch(new RegExp(`${ESC}\\[32m\\s*ctx:\\d`));
        }
      } finally {
        drive(["kill", "--session", session]);
        if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
