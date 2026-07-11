// covers: function:classifyTerminalCommand function:RESERVED_RECORD_NAMES
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
//     with the shared workspace parser deciding list/switch/create/birth forms.
//   - A leading workspace command wins over a later read-only-looking token;
//     that token belongs to the workspace command argv, not global mode
//     selection.
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
  RESERVED_RECORD_NAMES,
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

  test("a --json following a leading verb is preserved as workspace list argv", () => {
    // --json is meaningful on list forms, so the classifier carries it as the
    // utility tail rather than dropping it or treating it as a switch target.
    const cmd = classifyTerminalCommand(["space", "--json"]) as unknown as {
      subcommand: string;
      source: string;
      args?: string[];
    };
    expect(cmd).toMatchObject({
      subcommand: "space",
      source: "workspace-verb",
    });
    expect(cmd.args).toEqual(["--json"]);
  });

  test("a workspace verb NOT at index 0 is freeform -> null", () => {
    // "space" appears mid-sentence; the `i === 0` guard means it does NOT
    // classify, and no read-only flag is present, so the result is null.
    expect(classifyTerminalCommand(["add", "a", "space"])).toBeNull();
  });

  test("intent help / space help classify as the help subcommand, not a switch", () => {
    // "help" after a nav verb is a help REQUEST: no per-verb help exists, and
    // treating it as a record name dies with an error that historically steered
    // the conductor into birthing an intent. Both route to global help. Same
    // for the -h spelling.
    expect(classifyTerminalCommand(["intent", "help"])).toEqual({
      subcommand: "help",
      source: "read-only-flag",
    });
    expect(classifyTerminalCommand(["space", "help"])).toEqual({
      subcommand: "help",
      source: "read-only-flag",
    });
    expect(classifyTerminalCommand(["intent", "-h"])).toEqual({
      subcommand: "help",
      source: "read-only-flag",
    });
    expect(classifyTerminalCommand(["space", "-h"])).toEqual({
      subcommand: "help",
      source: "read-only-flag",
    });
  });

  test("space-create help is NOT rerouted - the creation chokepoint refuses the reserved name itself", () => {
    // The classifier passes it through as a normal verb+arg; handleSpaceCreate
    // dies on the reserved name with an actionable error (RESERVED_RECORD_NAMES).
    expect(classifyTerminalCommand(["space-create", "help"])).toEqual({
      subcommand: "space-create",
      arg: "help",
      source: "workspace-verb",
    });
    expect(RESERVED_RECORD_NAMES.has("help")).toBe(true);
  });

  test("the exported WORKSPACE_VERBS set is exactly the three navigation verbs", () => {
    expect([...WORKSPACE_VERBS].sort()).toEqual([
      "intent",
      "space",
      "space-create",
    ]);
  });
});

describe("classifyTerminalCommand() - sole bare help tokens are terminal", () => {
  test("a sole bare `help` or `-h` classifies as the help subcommand", () => {
    // Neither is in READ_ONLY_FLAGS (only --help is); without the sole-token
    // special case they would read as freeform intent text and the funnel
    // would offer to birth an intent literally named "help".
    expect(classifyTerminalCommand(["help"])).toEqual({
      subcommand: "help",
      source: "read-only-flag",
    });
    expect(classifyTerminalCommand(["-h"])).toEqual({
      subcommand: "help",
      source: "read-only-flag",
    });
  });

  test("`help` inside a longer description stays freeform -> null", () => {
    expect(classifyTerminalCommand(["help", "me", "build", "auth"])).toBeNull();
    expect(classifyTerminalCommand(["build", "a", "help", "desk"])).toBeNull();
  });
});

describe("classifyTerminalCommand() - marker-led shapes stay freeform", () => {
  // The engine does NOT repair a conductor that echoes the whole invocation
  // line (`/aidlc ...` as one blob or with the marker as a leading token):
  // re-tokenizing prose deterministically hijacked real descriptions
  // ("/aidlc space out the rollout plan" became a switch to space "out"), so
  // marker-stripping belongs to the SKILL.md forwarding prose. Anything that
  // still arrives marker-led lands in the freeform ask funnel - a safe human
  // gate, never a birth.
  test("a marker-led blob or token sequence returns null (freeform)", () => {
    expect(classifyTerminalCommand(["/aidlc intent help"])).toBeNull();
    expect(classifyTerminalCommand(["$aidlc --status"])).toBeNull();
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
