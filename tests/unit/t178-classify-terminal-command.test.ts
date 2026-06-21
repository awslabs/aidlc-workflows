// covers: function:classifyTerminalCommand
// covers: function:READ_ONLY_FLAGS function:WORKSPACE_VERBS
//
// t178 — classifyTerminalCommand() in aidlc-lib.ts, plus the two exported sets
// READ_ONLY_FLAGS and WORKSPACE_VERBS that it classifies off.
// Mechanism: none (pure data-in/data-out classifier — zero I/O, zero LLM, zero
// tokens). A direct import + call satisfies the "none" minMechanism.
//
// Source (dist/claude/.claude/tools/aidlc-lib.ts):
//   :303  READ_ONLY_FLAGS = {"--status","--help","--doctor","--version"}
//   :309  WORKSPACE_VERBS = {"space","space-create","intent"}
//   :318  interface TerminalCommand { subcommand; arg?; source }
//   :331  classifyTerminalCommand(args): TerminalCommand | null
//
// Verified contract the assertions below pin (read at :331-346):
//   - A READ_ONLY_FLAGS token matches ANYWHERE in args (the loop scans every
//     index). On a hit it returns { subcommand: token w/o leading "--",
//     source: "read-only-flag" } — NO `arg` field.
//   - A WORKSPACE_VERBS token matches ONLY at index 0 (the `i === 0` guard).
//     A leading verb returns { subcommand: verb, source: "workspace-verb" },
//     and { arg: args[1] } too IFF args[1] exists and does NOT start with "--".
//   - The loop returns on the FIRST match scanning i = 0..n, so a read-only
//     flag at any position is reported even when a workspace verb leads (the
//     flag wins only if it is the earlier index; a leading verb returns first).
//   - Everything else (a verb NOT at index 0, freeform prose, a --scope/--stage
//     jump, an empty arg list) returns null — it carries workflow work / is not
//     terminal.
//
// Test-design note: assert the OBSERVABLE returned shape per case
// (subcommand / arg / source), never re-implement the loop. The `arg`-field
// cases use toEqual on the whole object so a spurious `arg: undefined` key vs.
// an absent key is caught, and the null cases pin the freeform/empty contract.

import { describe, expect, test } from "bun:test";
import {
  classifyTerminalCommand,
  READ_ONLY_FLAGS,
  WORKSPACE_VERBS,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

describe("classifyTerminalCommand() — read-only flags (match anywhere)", () => {
  test("a leading --status maps to subcommand 'status', source read-only-flag", () => {
    expect(classifyTerminalCommand(["--status"])).toEqual({
      subcommand: "status",
      source: "read-only-flag",
    });
  });

  test("--doctor, --help, --version each strip the leading -- and report read-only-flag", () => {
    expect(classifyTerminalCommand(["--doctor"])).toEqual({
      subcommand: "doctor",
      source: "read-only-flag",
    });
    expect(classifyTerminalCommand(["--help"])).toEqual({
      subcommand: "help",
      source: "read-only-flag",
    });
    expect(classifyTerminalCommand(["--version"])).toEqual({
      subcommand: "version",
      source: "read-only-flag",
    });
  });

  test("a read-only flag is matched even when NOT at index 0", () => {
    // The loop scans every index, so a flag preceded by a non-verb token still
    // classifies. "foo" is not a workspace verb (and not at a verb position
    // that matches), so the scan reaches "--status".
    expect(classifyTerminalCommand(["foo", "--status"])).toEqual({
      subcommand: "status",
      source: "read-only-flag",
    });
  });

  test("the exported READ_ONLY_FLAGS set is exactly the four utility flags", () => {
    // Pins the set classifyTerminalCommand reads from; a drift here would
    // silently change what the seam treats as terminal.
    expect([...READ_ONLY_FLAGS].sort()).toEqual([
      "--doctor",
      "--help",
      "--status",
      "--version",
    ]);
  });
});

describe("classifyTerminalCommand() — workspace verbs (leading token only)", () => {
  test("a bare leading verb returns the verb with no arg", () => {
    // No args[1] -> no `arg` field at all (not arg: undefined). toEqual on the
    // whole object catches a spurious undefined key.
    expect(classifyTerminalCommand(["space"])).toEqual({
      subcommand: "space",
      source: "workspace-verb",
    });
  });

  test("a leading verb with a positional name captures it as arg", () => {
    expect(classifyTerminalCommand(["space-create", "teamB"])).toEqual({
      subcommand: "space-create",
      arg: "teamB",
      source: "workspace-verb",
    });
    expect(classifyTerminalCommand(["intent", "x"])).toEqual({
      subcommand: "intent",
      arg: "x",
      source: "workspace-verb",
    });
  });

  test("a --flag following a leading verb is NOT taken as the arg", () => {
    // args[1] starts with "--", so `arg` is omitted. The verb still classifies
    // as terminal with no positional name.
    expect(classifyTerminalCommand(["space", "--json"])).toEqual({
      subcommand: "space",
      source: "workspace-verb",
    });
  });

  test("a workspace verb NOT at index 0 is freeform -> null", () => {
    // "space" appears mid-sentence; the `i === 0` guard means it does NOT
    // classify, and no read-only flag is present, so the result is null.
    expect(classifyTerminalCommand(["add", "a", "space"])).toBeNull();
  });

  test("the exported WORKSPACE_VERBS set is exactly the three navigation verbs", () => {
    expect([...WORKSPACE_VERBS].sort()).toEqual([
      "intent",
      "space",
      "space-create",
    ]);
  });
});

describe("classifyTerminalCommand() — non-terminal inputs return null", () => {
  test("freeform intent text returns null", () => {
    expect(classifyTerminalCommand(["build", "auth"])).toBeNull();
  });

  test("an empty arg list returns null", () => {
    expect(classifyTerminalCommand([])).toBeNull();
  });

  test("a --scope jump is not a terminal command -> null", () => {
    // --scope is neither a read-only flag nor a workspace verb; it carries
    // workflow work and must go through the engine, so it classifies as null.
    expect(classifyTerminalCommand(["--scope", "mvp"])).toBeNull();
  });
});
