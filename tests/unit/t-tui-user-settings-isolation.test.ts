// covers: harness-instrument:tui-drive-setting-sources
//
// Deterministic guards for the native Windows user-settings journey. These
// stay separate from t142's broader fixture tests so the isolation regressions
// can run as a narrow, token-free unit slice.

import { describe, expect, test } from "bun:test";
import {
  completedClaudeTurnPattern,
  isolatedTuiUserProfileEnv,
} from "../harness/tui-fixtures.ts";
import { normalizeTuiCommand } from "../harness/tui-drive.ts";

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
