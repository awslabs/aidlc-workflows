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
//     test closes exactly that gap, live, in the selected terminal backend.
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
// on AIDLC_TUI_LIVE (the watched live-TUI tier) + selected TUI substrate + claude + the
// distributable; absent any of those it SKIPs with a reason — never a hollow
// pass. (P10 hazard: the live-TUI legs are flaky-by-nature; re-run a flake ~5x
// watched before calling it red.)
//
// Spawn tui-drive.ts using the shared runtime selector: Bun for native and
// tmux backends, Node with type stripping for explicit legacy node-pty. The
// driver subprocess remains the source of the `tui` mechanism evidence.

import { fileCleanupReserveMs, liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS } from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  absentReason, captureOrientationStatusline, ORIENTATION_MARKER, type OrientationSample,
} from "../harness/tui-orientation.ts";

const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);

const DRIVER = join(import.meta.dir, "../harness/tui-drive.ts");
const ABSENT_REASON = absentReason({ command: ["claude", "--dangerously-skip-permissions"] });

describe("t-tui-journey-orientation (live Claude TUI — the render-half 'you are here')", () => {
  const sampleCount = process.platform === "win32" ? 3 : 1;
  let SAMPLES: OrientationSample[] | null = null;
  function samples(): OrientationSample[] {
    if (SAMPLES === null) {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const reserveMs = fileCleanupReserveMs(TEST_TIMEOUT_MS);
      SAMPLES = Array.from(
        { length: sampleCount },
        (_, index) => captureOrientationStatusline(index + 1, {
          driver: DRIVER,
          command: ["claude", "--dangerously-skip-permissions"],
          deadlineMs,
          reserveMs,
        }),
      );
    }
    return SAMPLES;
  }

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
    TEST_TIMEOUT_MS,
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
    TEST_TIMEOUT_MS,
  );
});
