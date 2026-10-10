// covers: function:nextTokenKind, function:nextFlagShape, function:NEXT_FLAGS, function:argumentIsFlagShaped, function:parseNextFlags
//
// One table of the flags `next` takes (NEXT_FLAGS in aidlc-lib.ts), read by the
// one parser and by the harness seams that have to read a line before any agent
// sees it. These cases pin the table against the parser's own branches, from its
// source, so the two can never drift: a flag added to the loop and not to the
// table would stop being taken, and a flag in the table that the loop does not
// take would become task text.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { parseNextFlags } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import {
  CEREMONY_FLAGS,
  CEREMONY_SETTINGS,
  GUARD_POLICY_VALUES,
  guardFenceConfigKey,
  NEXT_FLAGS,
  nextFlagShape,
  nextTokenKind,
  SWITCHABLE_GUARD_FENCES,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { VALID_DEPTHS, VALID_TEST_STRATEGIES } from "../../dist/claude/.claude/tools/aidlc-guard-switch.ts";

// `--doctor`'s own trailing arguments: compared in the loop, but only once
// --doctor has matched, so they are that command's and not the loop's own.
const DOCTOR_ARGS = ["--export", "--output", "--verbose"];

function parserBody(): string {
  const source = readFileSync(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), "utf-8");
  const start = source.indexOf("export function parseNextFlags(");
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}\n", start));
}

const sorted = (tokens: Iterable<string>) => [...new Set(tokens)].sort();

describe("the flags `next` takes are one table, pinned to the parser's own branches", () => {
  test("the table holds every flag the parser compares, and nothing else", () => {
    const compared = sorted(
      [...parserBody().matchAll(/\ba === "(--[a-z][a-z.-]*)"/g)]
        .map((match) => match[1])
        .filter((flag) => !DOCTOR_ARGS.includes(flag)),
    );
    expect(compared.length).toBeGreaterThan(25);
    expect(sorted(NEXT_FLAGS.keys())).toEqual(compared);
  });

  test("a flag taken only when a token follows it is the only kind marked that way", () => {
    const body = parserBody();
    const guarded = new Set(
      [...body.matchAll(/\ba === "(--[a-z][a-z.-]*)" && i \+ 1 < args\.length/g)].map((match) => match[1]),
    );
    // Four of them have a second, valueless branch (`--claim` alone refuses by
    // name), so the loop takes those whatever follows.
    const alsoBare = new Set(
      [...body.matchAll(/\ba === "(--[a-z][a-z.-]*)"[)\s]*(?:\|\||\))/g)].map((match) => match[1]),
    );
    const onlyWithFollowing = sorted([...guarded].filter((flag) => !alsoBare.has(flag)));
    expect(onlyWithFollowing).toEqual(["--phase", "--report", "--scope", "--stage"]);
    expect(sorted([...NEXT_FLAGS].filter(([, shape]) => shape.needsFollowing === true).map(([flag]) => flag)))
      .toEqual(onlyWithFollowing);
  });

  test("the words a valued flag holds are the ones the engine accepts", () => {
    expect(NEXT_FLAGS.get("--depth")?.words).toEqual(Object.keys(VALID_DEPTHS));
    expect(NEXT_FLAGS.get("--test-strategy")?.words).toEqual(Object.keys(VALID_TEST_STRATEGIES));
    expect(NEXT_FLAGS.get("--guard-policy")?.words).toEqual([...GUARD_POLICY_VALUES]);
    expect(NEXT_FLAGS.get("--change-control")?.words).toEqual([...GUARD_POLICY_VALUES]);
    for (const flag of Object.values(CEREMONY_FLAGS)) {
      expect(nextFlagShape(flag)?.words, flag).toEqual([...CEREMONY_SETTINGS]);
    }
    for (const fence of SWITCHABLE_GUARD_FENCES) {
      const flag = `--${guardFenceConfigKey(fence)}`;
      expect(nextFlagShape(flag)?.words, flag).toEqual([...CEREMONY_SETTINGS]);
    }
  });

  test("every flag in the table is one the parser takes, never one it could not", () => {
    const fences = SWITCHABLE_GUARD_FENCES.map((fence) => `--${guardFenceConfigKey(fence)}`);
    for (const flag of [...NEXT_FLAGS.keys(), ...Object.values(CEREMONY_FLAGS), ...fences]) {
      const value = nextFlagShape(flag)?.words?.[0] ?? "standard";
      expect(nextTokenKind(flag, value), flag).toBe("flag");
      expect(parseNextFlags([flag, value]).untakenFlag, `${flag} ${value}`).toBeUndefined();
    }
  });

  test("a flag-shaped token the table does not hold is untaken; the person's words are not", () => {
    for (const token of ["--details", "--plan-aprroval", "--session", "--choice", "--nonsense", "--status"]) {
      expect(nextTokenKind(token, "off"), token).toBe("untaken");
    }
    // One quoted argument can hold the whole request, as Kiro IDE's PowerShell
    // hands it over: a bare word in it that is no flag's value makes it theirs.
    expect(nextTokenKind("--help flag for the reverser", undefined)).toBe("words");
    expect(nextTokenKind("--choice=Approve Plan", undefined)).toBe("untaken");
    for (const token of ["fix", "-h", "bugfix", "approve"]) {
      expect(nextTokenKind(token, "the"), token).toBe("words");
    }
    // A flag taken only with something after it is untaken when nothing is.
    expect(nextTokenKind("--scope", undefined)).toBe("untaken");
    expect(nextTokenKind("--scope", "bugfix")).toBe("flag");
    expect(parseNextFlags(["--scope"]).untakenFlag).toBe("--scope");
    expect(parseNextFlags(["--scope", "bugfix"]).scope).toBe("bugfix");
  });
});
