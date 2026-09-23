// covers: harness-instrument:tui-drive-calibration
//
// t-tui-preflight.serial.test.ts — the portable TUI CAPABILITY GATE (§6.2).
//
// The runner includes this prerequisite before selected TUI journeys. Legacy
// Windows ownership/CIM coverage lives in integration/t-tui-node-pty-compat.test.ts.
// This case proves the terminal rendering SUBSTRATE actually
// WORKS, with the t19 discipline of distinguishing ABSENT (skip-with-reason)
// from PRESENT-BUT-BROKEN (fail loud). It spends NO tokens and never touches
// claude — it drives a known-answer target that fragments a UTF-8 + ANSI payload
// byte by byte and asserts the captured grid carries every intended glyph.
//
// Why a probe, not a bare `command -v` (§6.2): presence != working.
//   - On Windows `node -e "require('node-pty')"` SUCCEEDS even when the driver
//     is run under bun — and that bun `_socket.write` wedge (microsoft/node-pty
//     #748) is exactly the misdiagnosis that cost the spike days. So we drive a
//     real round-trip, not a resolvability check.
//   - tmux can be installed yet `capture-pane` returns nothing useful; an
//     `@xterm/headless` import can resolve yet fail to reconstruct a grid. A
//     `command -v` sees none of this.
//
// SPAWN, not import (D-TUI-7): this `.test.ts` runs under bun, so it must never
// load node-pty in-process (the #748 in-process wedge). It SPAWNS tui-drive.ts
// as a subprocess using the selected runtime; the legacy backend pins Node. Same
// spawn-not-import pattern t17/t27 use for the CLI tools.
//
// The `covers:` header above claims the tui-drive instrument-calibration unit
// this preflight doubles as (§6.2/§7) — a harness-instrument claim, the same
// no-op-join form gen-coverage-registry.test.ts uses for the coverage generator
// (there is no enumerated `harness-instrument` unit class; the claim documents
// the calibration intent without inflating any covered count). The six
// `render-surface:*` statusline units the registry now enumerates are NOT
// claimed by these tests: as written, the tui tests assert the base `[AIDLC]
// ready` render, the live phase token, and the AUQ menu strip/footer — none is a
// glyph-level assertion of a specific statusline branch (phase bar / counter /
// stage name / colour / align / COMPLETE). Per the coverage-plan §4.2 "no
// guarantee weaker than the claim" rule they stay DEFERRED-tui (honestly listed),
// until a test asserts a specific branch's painted output.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { resolveTuiRuntime, tuiUnavailableReason } from "../harness/tui-runtime.ts";
import { cleanupTuiProjectAfterKill } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const IS_WIN = os.platform() === "win32";
const RUNTIME = resolveTuiRuntime(DRIVER);
const WIN_NODE = IS_WIN && RUNTIME.backend === "node-pty" ? resolveWinNode() : null;

// The known-answer target — no claude, no tokens. It writes every byte
// separately so Windows must preserve UTF-8 across the exact fragmented-output
// boundary that previously produced CP437 mojibake. On Windows it also refuses
// to emit the sentinel unless the real child received TERM=xterm-256color; this
// catches node-pty's Windows-only failure to propagate its `name` option into
// the environment. SGR wraps the line to prove xterm/tmux still parse ANSI while
// plain capture returns stable text.
const SENTINEL = "AIDLC_TUI_PREFLIGHT_OK";
const GLYPH_SENTINEL =
  `${SENTINEL} · ←→ ▓░ ✓✔ ❯☐☒ — ordinary text`;
const TARGET_SCRIPT = [
  'const fs = require("node:fs");',
  'if (process.platform === "win32" && process.env.TERM !== "xterm-256color") {',
  '  process.stderr.write("TERM_MISMATCH=<" + (process.env.TERM ?? "unset") + ">\\n");',
  "  process.exit(3);",
  "}",
  `const bytes = Buffer.from(${JSON.stringify(`\x1b[32m${GLYPH_SENTINEL}\x1b[0m\r\n`)}, "utf8");`,
  "let offset = 0;",
  "const timer = setInterval(() => {",
  "  fs.writeSync(1, bytes.subarray(offset, offset + 1));",
  "  offset++;",
  "  if (offset === bytes.length) clearInterval(timer);",
  "}, 2);",
  "setTimeout(() => process.exit(0), 10000);",
].join("");
const TARGET_CMD: string[] = [
  RUNTIME.backend === "node-pty" ? (WIN_NODE ?? "node") : process.execPath,
  "-e",
  TARGET_SCRIPT,
];

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}

function drive(args: string[]): Run {
  const res = spawnSync(RUNTIME.bin, [...RUNTIME.prefix, ...args], {
    encoding: "utf-8", env: process.env, timeout: 30_000,
  });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Missing substrate is an explicit skip; a present but broken substrate fails.
const ABSENT_REASON = tuiUnavailableReason();

describe("t-tui-preflight (terminal substrate capability gate)", () => {
  // skipIf carries the reason in the test name so the SKIP is never silent —
  // it surfaces in the bun output and the junit <skipped/> the runner aggregates.
  test.skipIf(ABSENT_REASON !== null)(
    `substrate preserves exact fragmented Unicode and ANSI grid rendering${
      ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""
    }`,
    () => {
      const session = `aidlc_tui_preflight_${process.pid}`;
      const sandbox = mkdtempSync(join(tmpdir(), "aidlc-tui-preflight-"));
      let runError: unknown;
      try {
        // 1) start the known-answer target in a fixed-size session.
        const started = drive([
          "start",
          "--session",
          session,
          "--cwd",
          sandbox,
          "--width",
          "80",
          "--height",
          "24",
          "--",
          ...TARGET_CMD,
        ]);
        // A start spawn-failure (exit 2 / nonzero) IS the present-but-broken
        // case — fail loud with the driver's stderr, never skip past it.
        if (started.rc !== 0) {
          throw new Error(
            `tui-drive start failed (rc=${started.rc}) — substrate present but ` +
              `the driver could not launch a session.\n${started.stderr}`,
          );
        }

        // 2) wait for the sentinel to paint on the reconstructed grid. A timeout
        // here is the BROKEN signal: the substrate resolved (we are past the
        // ABSENT skip) but capture returned nothing useful — e.g. node-pty present
        // but wedged under bun (#748), or tmux capture-pane returning empty.
        const waited = drive([
          "wait",
          "--session",
          session,
          "--pattern",
          SENTINEL,
          "--timeout-ms",
          "15000",
          "--stable-ms",
          "300",
        ]);
        if (waited.rc !== 0) {
          throw new Error(
            `tui-drive wait timed out for the known-answer sentinel — the ` +
              `substrate is PRESENT but BROKEN (capture empty? on Windows: ` +
              `selected terminal backend failed to reconstruct the grid). ` +
              `This is a fail-loud diagnostic, not a skip.\n${waited.stderr}`,
          );
        }

        // 3) Capture the grid and require the exact Unicode payload. On Windows
        // native capture uses @xterm/headless; tmux uses capture-pane.
        // The SGR bytes must affect terminal attributes without leaking into the
        // plain-text capture or changing any visible code point.
        const captured = drive(["capture", "--session", session]);
        expect(captured.rc).toBe(0);
        expect(captured.stdout).toContain(GLYPH_SENTINEL);
        expect(captured.stdout).not.toContain("\x1b[");
      } catch (error) {
        runError = error;
      }
      let cleanupError: unknown;
      try {
        cleanupTuiProjectAfterKill(
          sandbox,
          session,
          drive(["kill", "--session", session]),
        );
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError !== undefined) {
        if (runError === undefined) throw cleanupError;
        throw new Error(
          `TUI preflight and cleanup both failed.\n` +
            `original test error: ${String(runError)}\n` +
            `cleanup error: ${String(cleanupError)}`,
          { cause: runError },
        );
      }
      if (runError !== undefined) throw runError;
    },
    20_000,
  );
});
