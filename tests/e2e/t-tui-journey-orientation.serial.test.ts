// covers: hook:aidlc-statusline
//
// t-tui-journey-orientation.serial.test.ts — the RENDER-HALF of the P10 / Stage E
// workspace journey (the logic-half rides the SDK·ACP·exec drivers in
// t-journey-workspace.sdk / t-acp-kiro-journey-workspace / t-exec-codex-journey-
// workspace). It proves the vision §3 "you are here" promise PAINTS on a REAL
// terminal: when more than one space exists, the statusline shows the active
// `<space> · <intent> · <phase>` orientation prefix as a persistent cwd-style
// breadcrumb, so work never lands in the wrong space.
//
// WHY THIS IS THE NET-NEW RENDER ASSERTION (verified 2026-06-19):
//   - The deterministic twin t168 already SPAWNS the shipped hook directly and
//     asserts the `teamB · export-bug · CONSTRUCTION` two-space string — so the
//     prefix LOGIC is unit-proven token-free. What t168 CANNOT prove is that the
//     prefix survives the real TUI render path (the host pipes the workspace
//     JSON to the statusLine command and paints its stdout into the pane). This
//     test closes exactly that gap, live, in tmux.
//   - The sibling render test t-tui-render-statusline.serial seeds a SINGLE-space
//     fixture (setupTuiProject with no secondSpace), so its statusline never
//     paints the `<space> ·` segment — it matches `[AIDLC].*IDEATION` loosely and
//     asserts the bar/counter/stage, never the orientation prefix. So the
//     >1-space orientation paint is genuinely net-new here, riding the new
//     `secondSpace` fixture variant (tui-fixtures.ts).
//
// HARNESS MATRIX — Claude TUI ONLY, by surface limitation (stated, not faked):
//   The orientation prefix is the aidlc-statusline.ts hook, wired ONLY through
//   Claude Code's settings.json `statusLine` key (dist/claude/.claude/
//   settings.json). Kiro has NO statusline surface at all — dist/kiro/AGENTS.md
//   and harness/kiro/skills/aidlc/SKILL.md both state "there is no statusline;
//   use /aidlc --status and the progress lines at gates", and dist/kiro ships
//   aidlc-statusline.ts but nothing invokes it as a status row. Codex likewise
//   has no statusline host (and no TUI surface — tui-drive.ts has zero codex
//   awareness). So the render-half statusline-orientation matrix is Claude-only:
//   there is no Kiro/Codex statusline pane to scrape. A Kiro-TUI sibling was NOT
//   written because the surface it would assert against does not exist — mirror
//   the plan's "stated, not faked" honesty rather than a hollow skip. The Kiro
//   render path IS exercised (read-only status through the print-directive arm)
//   by t-tui-kiro-status.serial; that surfaces the same scope/stage strings, but
//   in the chat transcript, not a statusline.
//
// COST: launches the claude TUI but submits NO prompt — it reaches the workflow
// statusline purely from the seeded per-intent state file (state-mid-ideation),
// spending NO Bedrock tokens, exactly like t-tui-render-statusline. Still gated
// on AIDLC_TUI_LIVE (the watched live-TUI tier) + tmux + claude + the
// distributable; absent any of those it SKIPs with a reason — never a hollow
// pass. (P10 hazard: the live-TUI legs are flaky-by-nature; re-run a flake ~5x
// watched before calling it red.)
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts as a
// subprocess — node on Windows so node-pty never loads under bun (#748), bun
// elsewhere. The driver auto-selects its backend by os.platform().

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { AIDLC_SRC, cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "state-mid-ideation.md");
const IS_WIN = os.platform() === "win32";
const WIN_NODE = IS_WIN ? resolveWinNode() : null;
const ORIENTATION_MARKER = "default · fixture · IDEATION";
const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_WALL_BOUND_MS = 20_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const WINDOWS_SAMPLE_COUNT = 3;

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
// Gate: the watched live-TUI tier (AIDLC_TUI_LIVE) + the substrate. On POSIX the
// substrate is tmux; claude is needed on every platform; the distributable +
// the fixture must be present. A creds-less / binary-less machine SKIPs with a
// reason — never a hard fail (the P10 live-leg posture).
function absentReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live Claude TUI orientation render (watched tier)";
  }
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

interface OrientationSample {
  pane: string;
  startupWallMs: number;
}

// Launch the claude TUI on the >1-space + active-intent fixture and return the
// captured pane once the orientation-bearing workflow statusline has painted.
// Every launch uses a unique session and proves its process tree is gone before
// the next launch can begin.
function captureOrientationStatusline(sampleIndex: number): OrientationSample {
  const session = `aidlc_tui_journey_orient_${process.pid}_${sampleIndex}`;
  // setupTuiProject seeds the per-intent shell (default space's record + cursors)
  // and writes the mid-ideation state into it; secondSpace seeds a non-default
  // sibling space so listSpaces().length > 1 and the orientation prefix paints
  // its `<space> ·` segment. With the active space still `default`, the prefix
  // renders `default · fixture · IDEATION …`. No prompt, no tokens.
  const sandbox = setupTuiProject({ withState: "state-mid-ideation.md", secondSpace: true });
  let sample: OrientationSample | undefined;
  let launchError: unknown;
  try {
    // The statusLine key is what wires aidlc-statusline.ts into the TUI; a copy
    // that dropped it would render no [AIDLC] line at all.
    expect(readFileSync(join(sandbox, ".claude", "settings.json"), "utf8")).toContain(
      '"statusLine"',
    );

    const launchStartedAt = Date.now();
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

    // One bounded grid-driven startup loop handles both old Claude modal paths
    // and the current preseeded path. A visible trust / bypass modal is answered;
    // otherwise the already-painted orientation statusline returns immediately.
    const startup = drive([
      "startup",
      "--session",
      session,
      "--ready-pattern",
      ORIENTATION_MARKER,
      "--timeout-ms",
      String(STARTUP_TIMEOUT_MS),
    ]);
    const pane = drive(["capture", "--session", session]).stdout;
    if (startup.rc !== 0) {
      throw new Error(
        `orientation statusline "${ORIENTATION_MARKER}" never painted.\n` +
          `---- startup stderr ----\n${startup.stderr}\n` +
          `---- last pane ----\n${pane}\n-------------------`,
      );
    }
    sample = {
      pane,
      startupWallMs: Date.now() - launchStartedAt,
    };
  } catch (error) {
    launchError = error;
  }

  const killed = drive(["kill", "--session", session]);
  const dead = drive([
    "wait-dead",
    "--session",
    session,
    "--timeout-ms",
    String(PROCESS_EXIT_TIMEOUT_MS),
  ]);
  let fixtureCleanupError: unknown;
  try {
    cleanupTuiProject(sandbox);
  } catch (error) {
    fixtureCleanupError = error;
  }

  if (killed.rc !== 0 || dead.rc !== 0 || fixtureCleanupError !== undefined) {
    throw new Error(
      `TUI session '${session}' did not cleanly reap its process tree and fixture.\n` +
        `---- kill stderr ----\n${killed.stderr}\n` +
        `---- wait-dead stderr ----\n${dead.stderr}\n` +
        `---- fixture cleanup ----\n${String(fixtureCleanupError ?? "ok")}\n` +
        `---- original launch error ----\n${String(launchError ?? "none")}\n`,
    );
  }

  if (launchError !== undefined) throw launchError;
  if (sample === undefined) {
    throw new Error(`TUI session '${session}' produced no orientation sample`);
  }
  return sample;
}

describe("t-tui-journey-orientation (live Claude TUI — the render-half 'you are here')", () => {
  const sampleCount = IS_WIN ? WINDOWS_SAMPLE_COUNT : 1;
  let SAMPLES: OrientationSample[] | null = null;
  function samples(): OrientationSample[] {
    if (SAMPLES === null) {
      SAMPLES = Array.from(
        { length: sampleCount },
        (_, index) => captureOrientationStatusline(index + 1),
      );
    }
    return SAMPLES;
  }

  test.skipIf(ABSENT_REASON !== null || !IS_WIN)(
    `three native Windows launches stay within ${STARTUP_WALL_BOUND_MS}ms and reap each process tree` +
      `${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : !IS_WIN ? " — SKIP: Windows-only" : ""}`,
    () => {
      const observed = samples();
      expect(observed).toHaveLength(WINDOWS_SAMPLE_COUNT);
      for (const sample of observed) {
        expect(sample.startupWallMs).toBeLessThanOrEqual(
          STARTUP_WALL_BOUND_MS,
        );
      }
    },
    90_000,
  );

  // The full orientation prefix: space token (because >1 space) + intent slug +
  // phase, in the `<space> · <intent> · <phase>` order the builder emits. This is
  // the genuinely-new render assertion — no existing TUI test scrapes the space
  // segment (t-tui-render-statusline seeds a single space).
  test.skipIf(ABSENT_REASON !== null)(
    `paints the "default · fixture · IDEATION" orientation prefix (>1 space)${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""}`,
    () => {
      for (const sample of samples()) {
        expect(sample.pane).toContain(ORIENTATION_MARKER);
      }
    },
    90_000,
  );

  // The orientation rides BEFORE the phase progress bar — the same painted line
  // also carries the seeded stage, so the breadcrumb and the stage coexist on the
  // one statusline (proves the prefix didn't displace the rest of the row).
  test.skipIf(ABSENT_REASON !== null)(
    `the oriented line still carries the stage "> Feasibility"${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""}`,
    () => {
      for (const sample of samples()) {
        expect(sample.pane).toContain("> Feasibility");
      }
    },
    90_000,
  );
});
