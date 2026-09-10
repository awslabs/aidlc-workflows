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
  claudeTrustNavigation,
  isOwnedTuiFixture,
  normalizeTuiCommand,
  TUI_TEST_FIXTURE_MARKER,
} from "../harness/tui-drive.ts";

const TRUST_NO = "Accessing workspace:\n\n❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel";
const TRUST_YES = "Accessing workspace:\n\n  No, exit\n❯ Yes, I trust this folder\n\nEnter to confirm · Esc to cancel";

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
      }, "fixture-trust-regression", screen)).toBe(true);
      expect(sent).toEqual(["Down", "Enter"]);
    } finally {
      cleanupTuiProject(project);
    }
  });

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
