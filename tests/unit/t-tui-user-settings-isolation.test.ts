// covers: harness-instrument:tui-drive-setting-sources
//
// Deterministic guards for the native Windows user-settings journey. These
// stay separate from t142's broader fixture tests so the isolation regressions
// can run as a narrow, token-free unit slice.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import {
  completedClaudeTurnPattern,
  isolatedTuiUserProfileEnv,
  cleanupTuiProject,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import {
  acceptTuiFixtureTrust,
  claudeFixtureCwd,
  claudeTrustNavigation,
  isOwnedTuiFixture,
  normalizeTuiCommand,
  TUI_TEST_FIXTURE_MARKER,
} from "../harness/tui-drive.ts";

const TRUST_NO = "Accessing workspace:\n\n❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel";
const TRUST_YES = "Accessing workspace:\n\n  No, exit\n❯ Yes, I trust this folder\n\nEnter to confirm · Esc to cancel";

function trustClock() {
  let elapsedMs = 0;
  return {
    now: () => elapsedMs,
    sleep: async (ms: number) => { elapsedMs += ms; },
  };
}

describe("Claude fixture trust menu", () => {
  test("navigates both unnumbered and numbered layouts using the selected label", () => {
    expect(claudeTrustNavigation(TRUST_NO)).toBe("Down");
    expect(claudeTrustNavigation(TRUST_YES)).toBe("Enter");
    expect(claudeTrustNavigation("Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit")).toBe("Enter");
    expect(claudeTrustNavigation("Do you trust this folder?\n  1. Yes, I trust this folder\n❯ 2. No, exit")).toBe("Up");
    expect(claudeTrustNavigation("Yes, I trust this folder\n❯ No, exit")).toBeNull();
    expect(claudeTrustNavigation("Accessing workspace:\nNo, exit\nYes, I trust this folder")).toBeNull();
  });

  test("presses Enter only after the marked fixture paints Yes as selected", async () => {
    const project = setupTuiProject({ noAidlcDocs: true });
    const sent: string[] = [];
    let screen = TRUST_NO;
    try {
      expect(await acceptTuiFixtureTrust({
        fixtureCwd: () => project,
        capture: () => screen,
        send: (_session, key, literal, noEnter) => {
          expect(literal).toBe(false);
          expect(noEnter).toBe(true);
          if (key === "Enter") expect(screen).toBe(TRUST_YES);
          sent.push(key);
          if (key === "Down") screen = TRUST_YES;
        },
      }, "fixture-trust-regression", screen, trustClock())).toBe(true);
      expect(sent).toEqual(["Down", "Enter"]);
    } finally {
      cleanupTuiProject(project);
    }
  });

  test("waits for a complete stable repaint before sending one Down to an input-ready menu", async () => {
    const project = setupTuiProject({ noAidlcDocs: true });
    const clock = trustClock();
    const sent: string[] = [];
    let selectedYes = false;
    const capture = () => {
      if (selectedYes) return TRUST_YES;
      if (clock.now() < 300) return "Accessing workspace:\nYes, I trust this folder";
      if (clock.now() < 600) return `${TRUST_NO}\npainting permissions`;
      return TRUST_NO;
    };
    try {
      expect(await acceptTuiFixtureTrust({
        fixtureCwd: () => project,
        capture,
        send: (_session, key) => {
          sent.push(key);
          // Simulate the reported input handler: early Down is dropped.
          if (key === "Down" && clock.now() >= 1_200) selectedYes = true;
          if (key === "Enter") expect(capture()).toBe(TRUST_YES);
        },
      }, "trust-readiness", TRUST_NO, clock)).toBe(true);
      expect(sent).toEqual(["Down", "Enter"]);
      expect(clock.now()).toBe(1_350);
    } finally {
      cleanupTuiProject(project);
    }
  });

  test.each(["partial", "repainting"] as const)(
    "bounds the wait for a %s menu without sending keys",
    async (state) => {
      const project = setupTuiProject({ noAidlcDocs: true });
      const clock = trustClock();
      const sent: string[] = [];
      try {
        await expect(acceptTuiFixtureTrust({
          fixtureCwd: () => project,
          capture: () => state === "partial"
            ? "Accessing workspace:\nYes, I trust this folder"
            : `${TRUST_NO}\npaint ${clock.now()}`,
          send: (_session, key) => { sent.push(key); },
        }, `trust-${state}`, TRUST_NO, clock)).rejects.toThrow("refusing navigation");
        expect(sent).toEqual([]);
        expect(clock.now()).toBeLessThanOrEqual(5_150);
      } finally {
        cleanupTuiProject(project);
      }
    },
  );

  test("never retries a dropped navigation or presses Enter while No stays selected", async () => {
    const project = setupTuiProject({ noAidlcDocs: true });
    const clock = trustClock();
    const sent: string[] = [];
    try {
      await expect(acceptTuiFixtureTrust({
        fixtureCwd: () => project,
        capture: () => TRUST_NO,
        send: (_session, key) => { sent.push(key); },
      }, "trust-dropped-down", TRUST_NO, clock)).rejects.toThrow("refusing Enter");
      expect(sent).toEqual(["Down"]);
      expect(clock.now()).toBeLessThanOrEqual(5_750);
    } finally {
      cleanupTuiProject(project);
    }
  });

  test("revalidates fixture ownership after waiting for readiness", async () => {
    const project = setupTuiProject({ noAidlcDocs: true });
    const clock = trustClock();
    const sent: string[] = [];
    try {
      await expect(acceptTuiFixtureTrust({
        fixtureCwd: () => project,
        capture: () => {
          if (clock.now() >= 600) rmSync(join(project, TUI_TEST_FIXTURE_MARKER), { force: true });
          return TRUST_NO;
        },
        send: (_session, key) => { sent.push(key); },
      }, "trust-owner-lost", TRUST_NO, clock)).rejects.toThrow("refusing navigation");
      expect(sent).toEqual([]);
    } finally {
      cleanupTuiProject(project);
    }
  });

  test.each(["selection", "owner", "binding"] as const)(
    "refuses Enter when %s changes after the selected-Yes paint",
    async (changed) => {
      const project = setupTuiProject({ noAidlcDocs: true });
      const sent: string[] = [];
      let afterDown = false;
      let yesCaptures = 0;
      try {
        await expect(acceptTuiFixtureTrust({
          fixtureCwd: () => changed === "binding" && afterDown ? null : project,
          capture: () => {
            if (!afterDown) return TRUST_NO;
            yesCaptures++;
            if (yesCaptures === 1) return TRUST_YES;
            if (changed === "owner") rmSync(join(project, TUI_TEST_FIXTURE_MARKER));
            return changed === "selection" ? TRUST_NO : TRUST_YES;
          },
          send: (_session, key) => { sent.push(key); afterDown = true; },
        }, `trust-changed-${changed}`, TRUST_NO, trustClock())).rejects.toThrow("refusing Enter");
        expect(sent).toEqual(["Down"]);
      } finally {
        cleanupTuiProject(project);
      }
    },
  );

  test("does not automate an unmarked directory or a stale fixture owner", async () => {
    const project = setupTuiProject({ noAidlcDocs: true });
    const sent: string[] = [];
    const backend = {
      fixtureCwd: () => project,
      capture: () => TRUST_NO,
      send: (_session: string, key: string) => { sent.push(key); },
    };
    try {
      rmSync(join(project, TUI_TEST_FIXTURE_MARKER));
      expect(isOwnedTuiFixture(project)).toBe(false);
      expect(await acceptTuiFixtureTrust(backend, "unmarked", TRUST_NO)).toBe(false);
      writeFileSync(join(project, TUI_TEST_FIXTURE_MARKER), JSON.stringify({
        cwd: project, ownerPid: -1,
      }));
      expect(await acceptTuiFixtureTrust(backend, "stale-owner", TRUST_NO)).toBe(false);
      expect(sent).toEqual([]);
    } finally {
      cleanupTuiProject(project);
    }
  });
});

describe("TUI user-settings journey guards", () => {
  test("binds the exact revision backstop unset launcher without altering its argv", () => {
    const project = setupTuiProject({ noAidlcDocs: true });
    const command = [
      "env", "-u", "AIDLC_SKIP_REVISION_BACKSTOP", "claude",
      "--setting-sources", "project", "--dangerously-skip-permissions",
    ];
    try {
      expect(claudeFixtureCwd(project, command)).toBe(project);
      expect(normalizeTuiCommand(command, {})).toEqual(command);
      const implicit = command.filter((arg) => arg !== "--setting-sources" && arg !== "project");
      expect(normalizeTuiCommand(implicit, {})).toEqual(command);
      const repeatedUnset = ["/usr/bin/env", "-u", "FIRST", "-u", "SECOND", "/usr/local/bin/claude"];
      expect(claudeFixtureCwd(project, repeatedUnset)).toBe(project);
      expect(normalizeTuiCommand(repeatedUnset, {})).toEqual([
        ...repeatedUnset, "--setting-sources", "project",
      ]);
      rmSync(join(project, TUI_TEST_FIXTURE_MARKER));
      expect(claudeFixtureCwd(project, command)).toBeNull();
    } finally {
      cleanupTuiProject(project);
    }
  });

  test("rejects cwd-changing, malformed, non-Claude and unknown wrappers without normalization", () => {
    const project = setupTuiProject({ noAidlcDocs: true });
    const commands = [
      ["env", "-C", "/elsewhere", "claude"],
      ["env", "-u", "AIDLC_SKIP_REVISION_BACKSTOP", "--chdir=/elsewhere", "claude"],
      ["env", "-u", "AIDLC_SKIP_REVISION_BACKSTOP", "-C", "/elsewhere", "claude"],
      ["env", "-S", "claude --setting-sources project"],
      ["env", "PWD=/elsewhere", "claude"],
      ["env", "-u", "FIRST", "HOME=/elsewhere", "claude"],
      ["env", "-u", "", "claude"],
      ["env", "-u", "INVALID=NAME", "claude"],
      ["env", "-u"],
      ["env", "-u", "FIRST"],
      ["env", "claude"],
      ["env", "-u", "FIRST", "kiro"],
      ["env", "-u", "FIRST", "bash", "-c", "cd /elsewhere && claude"],
      ["env", "-u", "FIRST", "env", "-u", "SECOND", "claude"],
      ["unknown", "claude"],
      ["bash", "-lc", "claude"],
    ];
    try {
      for (const command of commands) {
        expect(claudeFixtureCwd(project, command)).toBeNull();
        expect(normalizeTuiCommand(command, {})).toEqual(command);
      }
    } finally {
      cleanupTuiProject(project);
    }
  });

  test("path-resolved Windows launchers preserve explicit setting sources without duplication", () => {
    const commands = [
      [
        "C:\\Users\\dev\\.local\\bin\\claude.exe",
        "--setting-sources",
        "user,project",
        "--resume",
      ],
      [
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
        "--setting-sources=user,project",
      ],
      [
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.ps1",
        "--setting-sources",
        "project,local",
      ],
    ];

    for (const command of commands) {
      const normalized = normalizeTuiCommand(command, {});
      expect(normalized).toEqual(command);
      expect(
        normalized.filter(
          (arg) =>
            arg === "--setting-sources" || arg.startsWith("--setting-sources="),
        ),
      ).toHaveLength(1);
    }
  });

  test("isolated user profiles clear machine config and setting-source overrides", () => {
    const isolated = isolatedTuiUserProfileEnv(
      "C:\\probe\\user-home",
      "C:\\Program Files\\nodejs\\node.exe",
      {
        USERPROFILE: "C:\\Users\\developer",
        HOME: "C:\\Users\\developer",
        CLAUDE_CONFIG_DIR: "C:\\machine-claude-config",
        AIDLC_TUI_SETTING_SOURCES: "default",
        KEEP_ME: "yes",
      },
    );

    expect(isolated.USERPROFILE).toBe("C:\\probe\\user-home");
    expect(isolated.HOME).toBe("C:\\probe\\user-home");
    expect(isolated.AIDLC_NODE_BIN).toBe(
      "C:\\Program Files\\nodejs\\node.exe",
    );
    expect(isolated.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(isolated.AIDLC_TUI_SETTING_SOURCES).toBeUndefined();
    expect(isolated.KEEP_ME).toBe("yes");
  });

  test("completion matching rejects a streaming sentinel until the idle prompt returns", () => {
    const pattern = new RegExp(
      completedClaudeTurnPattern("PROJECT_GUIDANCE_SENTINEL"),
    );
    const streaming = [
      "PROJECT_GUIDANCE_SENTINEL",
      "still streaming USER_POISON_SENTINEL",
      "esc to interrupt",
    ].join("\n");
    const completed = [
      "PROJECT_GUIDANCE_SENTINEL",
      "USER_POISON_SENTINEL",
      "",
      "\u276f\u00a0 ",
      "--------------------------------",
      "bypass permissions on",
    ].join("\n");

    expect(pattern.test(streaming)).toBe(false);
    expect(pattern.test(completed)).toBe(true);
  });
});
