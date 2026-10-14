// covers: hook:aidlc-session-start, hook:aidlc-statusline
//
// t40 - settings.json hook/permissions wiring, the harness.json statusline, and
// the settings.local.json.example override stub.
//
// Mechanism: none. Every assertion reads a STATIC shipped JSON file
// (dist/claude/.claude/settings.json, tools/data/harness.json and
// settings.local.json.example) and inspects its parsed structure IN-PROCESS -
// zero LLM, zero subprocess, zero tokens. This is the same "registration
// (mechanism none)" surface t131 credits for the relocated hooks: settings.json
// is where Claude Code learns which hook fires on which event. The statusline
// command ships in harness.json and reaches each person's settings.local.json
// only on their yes.
//
// SOURCE UNDER TEST:
//   settings.json hooks.SessionStart -> a non-empty array wiring the
//     source-channel session-start hook command
//   tools/data/harness.json statusLine.type == "command",
//     statusLine.command routes through `engine statusline`
//   settings.json permissions.allow: `Edit(/**)` plus AI-DLC's own commands one
//     by one (no bare `Bash`, no `aidlc-*` wildcard)
//   settings.local.json.example:
//   the personal-override stub must be valid JSON (it ships as a copy-to
//   template; a malformed example would silently break the documented
//   "copy to settings.local.json" flow in the shipped CLAUDE.md).
//
// Test-design note (house style): assert the OBSERVABLE structural contract -
// block presence, the wired hook command, the statusLine type, the allow-list
// shape, and JSON validity of the example - by reading the parsed object, never
// by re-implementing settings.json. The hook reference is pinned to the
// SessionStart group's command (not "appears somewhere in the file"), and the
// statusLine reference is pinned to statusLine.command in harness.json.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyChannelDispatcherCommands, copyChannelToolScripts } from "../../core/tools/aidlc.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const SETTINGS = join(AIDLC_SRC, "settings.json");
const SETTINGS_LOCAL_EXAMPLE = join(AIDLC_SRC, "settings.local.json.example");
const SOURCE_INVOKE = 'bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts"';

interface HookEntry {
  type?: string;
  command?: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  statusLine?: { type?: string; command?: string };
  permissions?: { allow?: string[] };
}

function readSettings(): Settings {
  return JSON.parse(readFileSync(SETTINGS, "utf-8")) as Settings;
}

/** AI-DLC's status line ships in harness.json, outside any file Claude Code reads (#1407). */
function readShippedStatusLine(): Settings["statusLine"] {
  return (JSON.parse(readFileSync(join(AIDLC_SRC, "tools", "data", "harness.json"), "utf-8")) as Settings).statusLine;
}

describe("t40 settings.json hook/statusline/permissions config (migrated from t40-settings-hook-config.sh, plan 6, mechanism none)", () => {
  test("T1: hooks.SessionStart is a non-empty array [.sh test 1]", () => {
    const s = readSettings();
    const groups = s.hooks?.SessionStart;
    expect(Array.isArray(groups)).toBe(true);
    expect((groups ?? []).length).toBeGreaterThan(0);
  });

  test("T2: SessionStart wires the source-channel session-start hook command [.sh test 2]", () => {
    const s = readSettings();
    const commands = (s.hooks?.SessionStart ?? []).flatMap((g) =>
      (g.hooks ?? []).map((h) => h.command ?? ""),
    );
    expect(commands).toContain(`${SOURCE_INVOKE} engine hook session-start`);
  });

  test("T3: statusLine.type is 'command', and the shared settings carry none [.sh test 3]", () => {
    // The value ships in harness.json and reaches each person's settings.local.json
    // on their yes.
    expect(readShippedStatusLine()?.type).toBe("command");
    expect(readSettings().statusLine).toBeUndefined();
  });

  test("T4: statusLine.command uses the source-channel statusline route [.sh test 4]", () => {
    expect(readShippedStatusLine()?.command).toBe(`${SOURCE_INVOKE} engine statusline`);
  });

  test("T5: permissions.allow has project edits and AI-DLC's own commands one by one [.sh test 5]", () => {
    const allow = readSettings().permissions?.allow ?? [];
    expect(allow.length).toBe(4 + copyChannelDispatcherCommands().length + 2 * copyChannelToolScripts().length);
    expect(allow).toContain("Edit(/**)");
    expect(allow).toContain("Bash(bun .claude/tools/aidlc.ts engine *)");
    expect(allow).toContain("Bash(bun .claude/tools/aidlc-log.ts *)");
    expect(allow).not.toContain("Bash(bun .claude/tools/aidlc-*)");
    expect(allow).not.toContain("Bash(date -u *)");
    expect(allow).not.toContain("Bash");
  });

  test("T6: settings.local.json.example is valid JSON [.sh test 6]", () => {
    const text = readFileSync(SETTINGS_LOCAL_EXAMPLE, "utf-8");
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text) as unknown;
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
  });
});
