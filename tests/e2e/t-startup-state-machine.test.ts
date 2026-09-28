// covers: harness-instrument:tui-drive-startup
//
// Deterministic coverage for the grid-driven Claude startup reducer. The live
// orientation journey proves the same reducer through tmux / ConPTY, but its
// `t-tui` filename is folded behind the substrate capability gate. These cases
// stay outside that gate so modal compatibility and ready-grid priority run in
// every e2e tier without launching Claude.

import { describe, expect, test } from "bun:test";
import {
  advanceTuiStartup,
  initialTuiStartupState,
} from "../harness/tui-drive.ts";

const ORIENTATION_MARKER = "default · fixture · IDEATION";
const READY = new RegExp(ORIENTATION_MARKER);

describe("TUI startup state machine", () => {
  test("returns immediately when the ready statusline is already painted", () => {
    const step = advanceTuiStartup(
      initialTuiStartupState(),
      `[AIDLC] ${ORIENTATION_MARKER} [##........] 2/7 > Feasibility`,
      READY,
    );
    expect(step.action).toBe("ready");
  });

  test("dismisses the older trust then bypass modals before accepting ready", () => {
    let state = initialTuiStartupState();
    let step = advanceTuiStartup(
      state,
      "Do you trust the files in this folder?\n1. Yes, I trust this folder\n2. No, exit",
      READY,
    );
    expect(step.action).toBe("dismiss-trust");
    state = step.state;

    step = advanceTuiStartup(
      state,
      "1. Yes, I trust this folder\n" +
        "Bypass Permissions mode\n1. No\n2. Yes, I accept\n" +
        `[AIDLC] ${ORIENTATION_MARKER}`,
      READY,
    );
    expect(step.action).toBe("dismiss-bypass");
    state = step.state;

    step = advanceTuiStartup(
      state,
      `[AIDLC] ${ORIENTATION_MARKER}`,
      READY,
    );
    expect(step.action).toBe("ready");
  });

  test("answers each modal once while waiting for its grid to repaint", () => {
    const trustGrid = "1. Yes, I trust this folder";
    const first = advanceTuiStartup(
      initialTuiStartupState(),
      trustGrid,
      READY,
    );
    expect(first.action).toBe("dismiss-trust");
    expect(advanceTuiStartup(first.state, trustGrid, READY).action).toBe("wait");
  });

  test("does not mistake the normal bypass footer for the warning modal", () => {
    const step = advanceTuiStartup(
      initialTuiStartupState(),
      `[AIDLC] ${ORIENTATION_MARKER}\n` +
        "bypass permissions on (shift+tab to cycle)",
      READY,
    );
    expect(step.action).toBe("ready");
  });

});
