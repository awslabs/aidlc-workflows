// covers: hook:aidlc-session-start, hook:aidlc-statusline
//
// t40 — settings.json hook/statusline/permissions wiring + the
// settings.local.json.example override stub. Migrated from
// tests/integration/t40-settings-hook-config.sh (TAP plan 6).
//
// Mechanism: none. Every assertion reads a STATIC shipped JSON file
// (dist/claude/.claude/settings.json and settings.local.json.example) and
// inspects its parsed structure IN-PROCESS — zero LLM, zero subprocess, zero
// tokens. The .sh used `jq` / `grep` against the same two files on disk; here
// the data is the file's bytes, so we read + JSON.parse and assert the parsed
// shape. This is the same "registration (mechanism none)" surface t131 credits
// for the relocated hooks: settings.json is where Claude Code learns which hook
// fires on which event, and which command renders the statusline.
//
// SOURCE UNDER TEST (dist/claude/.claude/settings.json):
//   hooks.SessionStart -> one group, matcher "", one native hook command
//   :18-21  statusLine.type == "command",
//           statusLine.command routes through `aidlc statusline`
//   :5-17   permissions.allow — exactly 8 entries, including `Bash(aidlc *)`
// AND (dist/claude/.claude/settings.local.json.example):
//   the personal-override stub must be valid JSON (it ships as a copy-to
//   template; a malformed example would silently break the documented
//   "copy to settings.local.json" flow in the shipped CLAUDE.md).
//
// Test-design note (house style): assert the OBSERVABLE structural contract the
// .sh asserted — block presence, the wired hook command, the statusLine type,
// the exact allow-list count, and JSON validity of the example — by reading the
// parsed object, never by re-implementing settings.json. Several checks are
// STRONGER than the .sh's substring grep: the hook reference is pinned to the
// SessionStart group's command (not "appears somewhere in the file"), and the
// statusLine reference is pinned to statusLine.command.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1 (hooks.SessionStart array exists)            -> T1
//   .sh test 2 (SessionStart routes to the session hook)    -> T2
//   .sh test 3 (statusLine.type == "command")               -> T3
//   .sh test 4 (statusLine routes through native aidlc)     -> T4
//   .sh test 5 (permissions.allow has exactly 8 tools)      -> T5
//   .sh test 6 (settings.local.json.example is valid JSON)  -> T6

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const SETTINGS = join(AIDLC_SRC, "settings.json");
const SETTINGS_LOCAL_EXAMPLE = join(AIDLC_SRC, "settings.local.json.example");
const SOURCE_INVOKE = "bun .claude/tools/aidlc.ts";

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

/** Read + parse the static shipped settings.json. */
function readSettings(): Settings {
  return JSON.parse(readFileSync(SETTINGS, "utf-8")) as Settings;
}

describe("t40 settings.json hook/statusline/permissions config (migrated from t40-settings-hook-config.sh, plan 6, mechanism none)", () => {
  test("T1: hooks.SessionStart is a non-empty array [.sh test 1]", () => {
    // .sh: assert_grep SETTINGS '"SessionStart"'. STRONGER: the key parses to an
    // array carrying at least one hook group, not merely a substring present.
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

  test("T3: statusLine.type is 'command' [.sh test 3]", () => {
    // .sh: jq -r '.statusLine.type' == "command".
    expect(readSettings().statusLine?.type).toBe("command");
  });

  test("T4: statusLine.command uses the source-channel statusline route [.sh test 4]", () => {
    expect(readSettings().statusLine?.command).toBe(`${SOURCE_INVOKE} engine statusline`);
  });

  test("T5: permissions.allow has exactly 8 tools incl. the source tool pattern [.sh test 5]", () => {
    const allow = readSettings().permissions?.allow ?? [];
    expect(allow.length).toBe(8);
    expect(allow).toContain("Bash(bun .claude/tools/*)");
    expect(allow).not.toContain("Bash");
  });

  test("T6: settings.local.json.example is valid JSON [.sh test 6]", () => {
    // .sh: jq empty SETTINGS_LOCAL_EXAMPLE succeeds. Parsing the file is the
    // equivalent validity check; STRONGER, we assert it parses to an object.
    const text = readFileSync(SETTINGS_LOCAL_EXAMPLE, "utf-8");
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text) as unknown;
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
  });
});
