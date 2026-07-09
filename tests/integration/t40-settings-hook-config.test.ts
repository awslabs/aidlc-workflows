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
//   :32-43  hooks.SessionStart -> one group, matcher "", one hook command
//           "bun $CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-session-start.ts"
//   :18-21  statusLine.type == "command",
//           statusLine.command references aidlc-statusline.ts
//   :5-17   permissions.allow — exactly 9 entries, including the
//           "Bash(bun $CLAUDE_PROJECT_DIR/.claude/tools/*)" tools pattern
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
//   .sh test 2 (SessionStart references session-start.ts)   -> T2
//   .sh test 3 (statusLine.type == "command")               -> T3
//   .sh test 4 (statusLine references aidlc-statusline.ts)  -> T4
//   .sh test 5 (permissions.allow has exactly 9 tools)      -> T5
//   .sh test 6 (settings.local.json.example is valid JSON)  -> T6

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const SETTINGS = join(AIDLC_SRC, "settings.json");
const SETTINGS_LOCAL_EXAMPLE = join(AIDLC_SRC, "settings.local.json.example");

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

  test("T2: SessionStart wires the session-start.ts hook command [.sh test 2]", () => {
    // .sh: assert_grep SETTINGS 'session-start.ts'. STRONGER: the reference must
    // live on a SessionStart group's hook command, not anywhere in the file.
    const s = readSettings();
    const commands = (s.hooks?.SessionStart ?? []).flatMap((g) =>
      (g.hooks ?? []).map((h) => h.command ?? ""),
    );
    expect(commands.some((c) => c.includes("aidlc-session-start.ts"))).toBe(
      true,
    );
  });

  test("T3: statusLine.type is 'command' [.sh test 3]", () => {
    // .sh: jq -r '.statusLine.type' == "command".
    expect(readSettings().statusLine?.type).toBe("command");
  });

  test("T4: statusLine.command references aidlc-statusline.ts [.sh test 4]", () => {
    // .sh: assert_grep SETTINGS 'aidlc-statusline.ts'. STRONGER: pinned to
    // statusLine.command, the field Claude Code actually executes.
    expect(readSettings().statusLine?.command ?? "").toContain(
      "aidlc-statusline.ts",
    );
  });

  test("T5: permissions.allow has exactly 9 tools incl. the bun-tools pattern [.sh test 5]", () => {
    // .sh: jq '.permissions.allow | length' == 9.
    const allow = readSettings().permissions?.allow ?? [];
    expect(allow.length).toBe(9);
    // STRONGER than the .sh's bare length check: the pre-approved bun-tools glob
    // the .sh's comment calls out ("including bun tools pattern") is present.
    // Quoted form (issue 519): $CLAUDE_PROJECT_DIR stays inside double quotes with
    // the * outside so the matcher still globs; t219 pins the quoting invariant.
    expect(
      allow.some((a) => a.includes('bun "$CLAUDE_PROJECT_DIR/.claude/tools/"*')),
    ).toBe(true);
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
