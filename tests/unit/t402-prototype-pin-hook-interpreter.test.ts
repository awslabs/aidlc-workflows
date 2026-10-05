// covers: function:pinHookCommand function:pinSettingsHookInterpreters function:absoluteHookInterpreter
//
// PROTOTYPE test (issue #1575): the absolute-path hook interpreter pin. These
// pin the PURE transform — the robust part a reviewer should judge — not the
// init wiring, which is env-gated and carries an open design question about the
// drift-hash of a machine-local path (see the PR description).

import { describe, expect, test } from "bun:test";
import {
  absoluteHookInterpreter,
  pinHookCommand,
  pinSettingsHookInterpreters,
} from "../../core/tools/aidlc-hook-interpreter-pin.ts";

const toAbs = (interpreter: "bun" | "aidlc"): string =>
  interpreter === "aidlc"
    ? "/opt/aidlc/bin/aidlc"
    : "/home/dev/.bun/bin/bun";

describe("prototype: absolute-path hook interpreter pin", () => {
  test("pins a bare bun hook command, preserving the rest byte-for-byte", () => {
    const cmd = 'bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook record-human-turn';
    expect(pinHookCommand(cmd, toAbs)).toBe(
      '/home/dev/.bun/bin/bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook record-human-turn',
    );
  });

  test("pins a bare aidlc (native) hook command", () => {
    const cmd = "aidlc engine hook session-start";
    expect(pinHookCommand(cmd, toAbs)).toBe("/opt/aidlc/bin/aidlc engine hook session-start");
  });

  test("quotes an absolute path that contains spaces (Windows user dir)", () => {
    const cmd = "aidlc engine hook session-start";
    const win = () => "C:\\Users\\Some Name\\AppData\\Local\\aidlc\\bin\\aidlc.cmd";
    expect(pinHookCommand(cmd, win)).toBe(
      '"C:\\Users\\Some Name\\AppData\\Local\\aidlc\\bin\\aidlc.cmd" engine hook session-start',
    );
  });

  test("is a no-op when the interpreter cannot be resolved", () => {
    const cmd = 'bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts" engine hook fold-usage';
    expect(pinHookCommand(cmd, () => null)).toBe(cmd);
  });

  test("is idempotent: an already-absolute command is left unchanged", () => {
    const cmd = "/opt/aidlc/bin/aidlc engine hook session-start";
    expect(pinHookCommand(cmd, toAbs)).toBe(cmd);
  });

  test("rewrites every hook command across the settings hooks tree", () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: "bun x engine hook record-human-turn" }] },
        ],
        PostToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [
              { type: "command", command: "bun x engine hook write-audit-log" },
              { type: "command", command: "bun x engine hook run-sensors" },
            ],
          },
        ],
      },
    };
    pinSettingsHookInterpreters(settings as Record<string, unknown>, toAbs);
    const cmds = JSON.stringify(settings);
    expect(cmds).not.toContain('"bun x');
    expect((settings.hooks.UserPromptSubmit[0].hooks[0] as { command: string }).command)
      .toBe("/home/dev/.bun/bin/bun x engine hook record-human-turn");
    expect((settings.hooks.PostToolUse[0].hooks[1] as { command: string }).command)
      .toBe("/home/dev/.bun/bin/bun x engine hook run-sensors");
  });

  test("tolerates a malformed hooks shape without throwing", () => {
    for (const bad of [{}, { hooks: null }, { hooks: [] }, { hooks: { X: "nope" } }]) {
      expect(() => pinSettingsHookInterpreters(bad as Record<string, unknown>, toAbs)).not.toThrow();
    }
  });

  test("absoluteHookInterpreter returns null for aidlc when the launcher is absent", () => {
    expect(absoluteHookInterpreter("aidlc", { exists: () => false })).toBeNull();
  });

  test("absoluteHookInterpreter resolves bun from the provided PATH", () => {
    const which = (cmd: string, pathValue: string) =>
      cmd === "bun" && pathValue === "/x/bin" ? "/x/bin/bun" : null;
    expect(absoluteHookInterpreter("bun", { pathValue: "/x/bin", which })).toBe("/x/bin/bun");
    expect(absoluteHookInterpreter("bun", { pathValue: "/other", which })).toBeNull();
  });
});
