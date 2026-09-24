// covers: render-surface:statusline-phase-bar render-surface:statusline-counter
// covers: render-surface:statusline-stage-name render-surface:statusline-align
//
// t-tui-render-statusline.serial.tui.test.ts — four render-surface units of the
// AI-DLC statusline (§5-C render row, §7 Phase 1), driven SEEDED-STATE in a REAL
// terminal with ZERO Bedrock tokens.
//
// These four branches all paint from ONE seeded per-intent aidlc-state.md, so a
// SINGLE launched TUI capture proves all four — one assertion-focus per unit:
//   - statusline-phase-bar  : progressBar(done,total) draws the 10-cell ▓/░ grid.
//                             Seeded mid-ideation = 2 done / 7 total IDEATION
//                             stages, so floor(2*10/7)=2 filled -> "[▓▓░░░░░░░░]".
//   - statusline-counter    : the "done/total" appended after the bar -> "2/7".
//   - statusline-stage-name : STAGE_DISPLAY["feasibility"]="Feasibility", seeded
//                             Current Stage=feasibility -> "> Feasibility".
//   - statusline-align      : printLine() (aidlc-statusline.ts:174-187) joins the
//                             left status to the right side (model, and ctx:% on a
//                             live turn). In production the statusline hook runs
//                             with PIPED stdout, so process.stdout.columns is
//                             undefined -> cols=0 -> printLine takes the ` | `
//                             separator branch (:185). The model is pinned in the
//                             distributable settings.json (ANTHROPIC_DEFAULT_OPUS_
//                             MODEL=us.anthropic.claude-opus-4-8, abbreviated by
//                             abbreviateModel() to "BR:opus-4-8[1m]"), so the
//                             painted right side is "<status> | BR:opus-4-8[1m]".
//                             This asserts printLine's REAL production output and
//                             is platform-invariant plain text (no colour escapes,
//                             so the Windows node-pty backend captures it identically
//                             — unlike statusline-colour, which is macOS-only).
//
// DIST/ FINDING (surfaced, not chased here): printLine's right-justify/padStart
// branch (:180-183) only fires when process.stdout.columns > 0. Claude Code pipes
// stdout to the statusline hook, so columns is always 0 and that branch is DEAD in
// the live render path — the ` | ` fallback always wins. The "padded to terminal
// width" behaviour the align unit is nominally about never executes in production.
// Either it's dead code or Claude Code is expected to pass columns and doesn't.
// Worth a product look; this test covers what printLine ACTUALLY paints.
//
// COST: launches the claude TUI but submits NO prompt — it reaches the workflow
// statusline state purely from the seeded state file, spending NO Bedrock tokens
// (the probe on 2026-06-04 verified all three paint pre-turn on the live TUI).
// Needs the selected TUI substrate + claude + the distributable; absent any of those it SKIPs with a
// reason — never a hollow pass.
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
import { resolveTuiRuntime, tuiUnavailableReason } from "../harness/tui-runtime.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const FIXTURE = join(import.meta.dir, "..", "fixtures", "state-mid-ideation.md");

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
// `wait` returns nonzero on timeout — boolean for the idempotent modal clears
// (only act if the modal is present), mirroring the statusline template.
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

// ABSENT detection checks the selected substrate; claude is
// needed on every platform; the distributable + the fixture must be present.
function absentReason(): string | null {
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (spawnSync("claude", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  if (!existsSync(FIXTURE)) return `fixture missing: ${FIXTURE}`;
  return null;
}
const ABSENT_REASON = absentReason();

// Capture the workflow statusline once, shared by all three unit assertions. A
// fresh TUI launch per assertion would triple the (already slow) tmux+claude
// startup for no extra coverage — the three branches paint from ONE seeded
// state, so one capture is the faithful observation. Returns the captured pane.
function captureWorkflowStatusline(): string {
  const session = `aidlc_tui_render_sl_${process.pid}`;
  // setupTuiProject copies the distributable + sibling aidlc/ memory shell,
  // seeds the per-intent workspace shell, and writes the mid-ideation fixture
  // into the active intent's record. With state present the hook paints the
  // WORKFLOW line (phase + bar + counter + stage), not the no-workflow "ready"
  // line. Purely state-driven — no prompt, no tokens.
  const sandbox = setupTuiProject({ withState: "state-mid-ideation.md" });
  try {
    // The statusLine key is what wires aidlc-statusline.ts into the TUI; a copy
    // that dropped it would render no [AIDLC] line at all.
    expect(
      readFileSync(join(sandbox, ".claude", "settings.json"), "utf8"),
    ).toContain('"statusLine"');

    // --- launch the claude TUI ----------------------------------------------
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

    // Startup exits as soon as the target UI is ready; absent modals do not
    // consume separate timeout windows. Navigation stays fixture-scoped.
    const startup = drive([
      "startup", "--session", session,
      "--ready-pattern", "\\[AIDLC\\].*IDEATION", "--timeout-ms", "60000",
    ]);
    if (startup.rc !== 0) throw new Error(`TUI startup failed: ${startup.stderr}`);

    // --- wait for the WORKFLOW statusline (IDEATION, not "ready") -----------
    // P9: the statusline now carries the orientation prefix ("<intent-slug> · ")
    // between [AIDLC] and the phase, so match with .* rather than a contiguous gap.
    const sawMarker = waitFor(session, "\\[AIDLC\\].*IDEATION", 45000, 1000);
    const pane = drive(["capture", "--session", session]).stdout;
    if (!sawMarker) {
      throw new Error(
        `workflow statusline "[AIDLC] IDEATION" never appeared in the TUI.\n` +
          `---- last pane ----\n${pane}\n-------------------`,
      );
    }
    return pane;
  } finally {
    cleanupTuiProjectAfterKill(
      sandbox,
      session,
      drive(["kill", "--session", session]),
    );
  }
}

describe("t-tui-render statusline workflow branches (seeded mid-ideation, no tokens)", () => {
  // One launch, cached for the three unit assertions.
  let PANE: string | null = null;
  function pane(): string {
    if (PANE === null) PANE = captureWorkflowStatusline();
    return PANE;
  }

  // statusline-phase-bar — the 10-cell ▓/░ progress bar. progressBar(2,7) fills
  // floor(2*10/7)=2 cells, leaving 8 empty: "[▓▓░░░░░░░░]". Assert the EXACT grid
  // the branch should draw, not a looser "contains ▓".
  test.skipIf(ABSENT_REASON !== null)(
    `statusline-phase-bar paints [▓▓░░░░░░░░] for 2/7 IDEATION${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""}`,
    () => {
      expect(pane()).toContain(
        "[AIDLC] fixture · IDEATION [▓▓░░░░░░░░] 2/7 > Feasibility -- Architect Agent | BR:opus-4-8[1m]",
      );
    },
    90_000,
  );

  // statusline-counter — the "done/total" appended after the bar. Seeded
  // mid-ideation = 2 done / 7 total IDEATION stages -> "2/7". Anchored to the bar
  // so a stray "2/7" elsewhere can't satisfy it.
  test.skipIf(ABSENT_REASON !== null)(
    `statusline-counter paints "2/7" after the bar${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""}`,
    () => {
      expect(pane()).toContain("░░] 2/7");
    },
    90_000,
  );

  // statusline-stage-name — the "> Stage Name" segment, mapped through
  // STAGE_DISPLAY. Seeded Current Stage=feasibility -> STAGE_DISPLAY["feasibility"]
  // ="Feasibility" -> "> Feasibility".
  test.skipIf(ABSENT_REASON !== null)(
    `statusline-stage-name paints "> Feasibility"${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""}`,
    () => {
      expect(pane()).toContain("> Feasibility");
    },
    90_000,
  );

  // statusline-align — printLine() joins the left status to the right side. With
  // piped stdout (cols=0, the production reality) it uses the ` | ` separator, and
  // the distributable pins the Opus model -> abbreviateModel() -> "BR:opus-4-8[1m]".
  // So the painted line ends "... | BR:opus-4-8[1m]". Anchored on the separator +
  // model token so a stray "BR:" elsewhere can't satisfy it. Platform-invariant
  // plain text (no SGR escapes) -> the Windows node-pty backend captures it the
  // same as tmux. (The padStart right-justify branch is dead in production — see
  // the DIST/ FINDING in the header; this asserts what printLine really paints.)
  test.skipIf(ABSENT_REASON !== null)(
    `statusline-align paints the " | BR:opus-4-8[1m]" right side via printLine${ABSENT_REASON ? ` — SKIP: ${ABSENT_REASON}` : ""}`,
    () => {
      expect(pane()).toContain(" | BR:opus-4-8[1m]");
    },
    90_000,
  );
});
