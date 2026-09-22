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
// CAPTURE SCOPE: tmux preserves SGR with capture-pane -e; native Bun uses the
// tui-screen.ts ANSI snapshot, which serializes palette green as ESC [32m.
// The hook-byte and live ctx token assertions below apply to both, including
// native Windows. Legacy node-pty still returns plain text for --ansi and skips.
//
// RECONCILIATION (verified live with NDJSON 2026-06-09): the hook stdout still
// contains ESC [32m ctx:N% ESC [0m, but current Claude Code strips that hook SGR
// before painting the statusline pane. tmux capture therefore proves the live ctx
// token, not the colour byte. If a later Claude renderer preserves the SGR again,
// this test accepts that stronger evidence.
//
// Spawn tui-drive.ts using the shared runtime selector: Bun for native and
// tmux backends, Node with type stripping for explicit legacy node-pty. The
// driver subprocess remains the source of the `tui` mechanism evidence.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTuiProjectAfterKill,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import {
  resolveTuiRuntime,
  selectedTuiBackend,
  tuiUnavailableReason,
} from "../harness/tui-runtime.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "state-mid-ideation.md");

// Generous live-turn budget — one tiny turn, but TUI+claude startup + a real
// Bedrock round-trip. Honour the suite's AIDLC_TEST_TIMEOUT (seconds).
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(args: string[]): Run {
  const { bin, prefix } = resolveTuiRuntime(DRIVER);
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

// Keep the token opt-in first, then check the selected backend's ANSI capability.
function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live colour render (uses Bedrock tokens)";
  }
  if (selectedTuiBackend() === "node-pty") {
    return "legacy node-pty backend strips colour escapes; select the native Bun or tmux backend for ANSI capture";
  }
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (spawnSync("claude", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  if (!existsSync(FIXTURE)) return `fixture missing: ${FIXTURE}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-tui-render statusline COLOUR branch (live turn populates ctx:%, ANSI capture)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `statusline-colour emits green SGR and the live TUI renders ctx:N%${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    () => {
      const session = `aidlc_tui_render_colour_${process.pid}`;
      // setupTuiProject copies the distributable + sibling aidlc/ memory shell,
      // seeds the per-intent workspace shell, and writes the mid-ideation fixture
      // into the active intent's record so the statusline hook resolves it.
      const sandbox = setupTuiProject({ withState: "state-mid-ideation.md" });
      try {
        const destClaude = join(sandbox, ".claude");
        expect(readFileSync(join(destClaude, "settings.json"), "utf8")).toContain('"statusLine"');
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
        // Share the original 60s trust + 15s permission + 45s readiness budget.
        const startupDeadlineMs = Date.now() + 120_000;
        const startup = drive([
          "startup", "--session", session,
          "--ready-pattern", "\\[AIDLC\\].*IDEATION", "--timeout-ms", "120000",
        ]);
        expect(startup.rc).toBe(0);
        // P9: orientation prefix ("<intent-slug> · ") sits between [AIDLC] and the
        // phase, so match with .* rather than a contiguous gap.
        expect(waitFor(session, "\\[AIDLC\\].*IDEATION", Math.max(0, startupDeadlineMs - Date.now()), 1000)).toBe(true);

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
        cleanupTuiProjectAfterKill(
          sandbox,
          session,
          drive(["kill", "--session", session]),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});
