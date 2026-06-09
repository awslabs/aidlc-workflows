// covers: harness-instrument:tui-drive-calibration
//
// t-tui-preflight.serial.tui.test.ts — the tui tier's CAPABILITY GATE (§6.2).
//
// This is the FIRST file in the tui tier (it is `*.serial.*`, so the runner's
// serial partition runs it before the parallel fan-out — run-tests.sh:495-497),
// and it gates the rest: it proves the terminal rendering SUBSTRATE actually
// WORKS, with the t19 discipline of distinguishing ABSENT (skip-with-reason)
// from PRESENT-BUT-BROKEN (fail loud). It spends NO tokens and never touches
// claude — it drives a known-answer target (printf in tmux / cmd.exe via
// node-pty) and asserts the captured grid carries the sentinel.
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
// as a subprocess — bun on macOS/Linux (the driver is just tmux there, a
// subprocess anyway), node on Windows (so node-pty never loads under bun). Same
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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";

// ---------------------------------------------------------------------------
// Locate the driver + pick the runtime per platform (§2.1, D-TUI-7).
// On win32 the driver subprocess MUST be node (node-pty input wedges under bun,
// #748) — resolved via resolveWinNode() because the box's node is off PATH —
// and the `.ts` entrypoint needs --experimental-strip-types (node < 22.18 cannot
// run a bare `.ts`). Everywhere else it is the bun running this test (tmux
// backend), which runs `.ts` natively with no flag (byte-identical to the spike).
// ---------------------------------------------------------------------------
const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const IS_WIN = os.platform() === "win32";
const WIN_NODE = IS_WIN ? resolveWinNode() : null;

// The known-answer target — no claude, no tokens. On POSIX a bash printf that
// holds the pane open; on Windows cmd.exe echoing the sentinel (the calibration
// proven in the spike). The driver's `start` runs `<cmd...>` after `--`.
const SENTINEL = "AIDLC_TUI_PREFLIGHT_OK";
const TARGET_CMD: string[] = IS_WIN
  ? ["cmd.exe", "/c", `echo ${SENTINEL} & timeout /t 10`]
  : ["bash", "-c", `printf '${SENTINEL}\\n'; sleep 10`];

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}

function drive(args: string[]): Run {
  // win32: <resolved-node> --experimental-strip-types tui-drive.ts <args>.
  // elsewhere: <bun> tui-drive.ts <args> (bun runs .ts natively, no flag).
  const [bin, prefix] = IS_WIN
    ? [WIN_NODE as string, ["--experimental-strip-types", DRIVER]]
    : [process.execPath, [DRIVER]];
  const res = spawnSync(bin, [...prefix, ...args], { encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// ABSENT detection — runs OUTSIDE the test body so skipIf can gate the whole
// describe. A clean ABSENT result SKIPs with a reason (the .test.ts analogue of
// the spikes' TAP `1..0 # SKIP`); the band's other files then also skip. A
// PRESENT-but-BROKEN substrate is NOT caught here — it is caught inside the test
// and FAILS LOUD, so a contributor gets one clear diagnostic line.
// ---------------------------------------------------------------------------
function substrateAbsentReason(): string | null {
  if (IS_WIN) {
    // node + node-pty + @xterm/headless must all be resolvable. Resolvability is
    // necessary-not-sufficient (the wedge is a runtime fault), so absence here is
    // a clean SKIP; a resolvable-but-wedged backend is the BROKEN case the test
    // body fails on.
    //
    // node may be installed yet OFF PATH (proven on the EC2 box: node at
    // C:\Program Files\nodejs but not on PATH), so we resolve a concrete binary
    // rather than trusting a bare `node`. node ABSENT anywhere -> clean SKIP.
    if (!WIN_NODE) return "node not found (required to run tui-drive on Windows — #748)";
    // node-pty must be require-able BY THE RESOLVED NODE. The driver loads node-pty
    // under this same node, so testing resolvability with a bare `node` (off PATH)
    // would falsely report absence; use the resolved binary. node-pty installed by
    // bun cannot be required by node (ERR_MODULE_NOT_FOUND) — only an npm-installed
    // node-pty resolves here. Absence -> clean SKIP (capability absent, not broken).
    const ptyOk =
      spawnSync(WIN_NODE, ["-e", "require('node-pty')"], { encoding: "utf-8" }).status === 0;
    if (!ptyOk) return "node-pty not node-resolvable (npm install node-pty so node can require it)";
    return null;
  }
  // POSIX: tmux is the substrate.
  const tmuxOk = spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
  if (!tmuxOk) return "tmux not found";
  return null;
}

const ABSENT_REASON = substrateAbsentReason();

describe("t-tui-preflight (terminal substrate capability gate)", () => {
  // skipIf carries the reason in the test name so the SKIP is never silent —
  // it surfaces in the bun output and the junit <skipped/> the runner aggregates.
  test.skipIf(ABSENT_REASON !== null)(
    `substrate present and a known-answer round-trip reconstructs the grid${
      ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""
    }`,
    () => {
      const session = `aidlc_tui_preflight_${process.pid}`;
      const sandbox = mkdtempSync(join(tmpdir(), "aidlc-tui-preflight-"));
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
              `node-pty present but running under bun? microsoft/node-pty #748). ` +
              `This is a fail-loud diagnostic, not a skip.\n${waited.stderr}`,
          );
        }

        // 3) capture the grid and assert the sentinel is really there — proves
        // the round-trip (send-or-emit -> render -> capture) closes. On Windows
        // this is the @xterm/headless grid; on POSIX the tmux capture-pane grid.
        // Either way capture returns the same current-screen text (D-TUI-2).
        const captured = drive(["capture", "--session", session]);
        expect(captured.rc).toBe(0);
        expect(captured.stdout).toContain(SENTINEL);
      } finally {
        drive(["kill", "--session", session]);
        if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
      }
    },
  );
});
