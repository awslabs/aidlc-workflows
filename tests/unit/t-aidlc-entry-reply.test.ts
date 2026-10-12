// covers: function:nextArgsAreOnlyWords, function:aidlcEntryWords
//
// What the person types after `/aidlc` (or `$aidlc`) is their reply when the
// engine reads it as nothing but words: "/aidlc approve the code plan" answers
// the open question the first time. Anything the dispatcher reads as a flag, a
// scope, a verb or a noun stays a command. The command words are not listed
// here or in the hook: these cases walk the dispatcher's own parser
// (parseNextFlags and the tables it reads), so a flag or verb added there is a
// command at once and free words never quietly become one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { nextArgsAreOnlyWords } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { aidlcEntryWords } from "../../dist/claude/.claude/tools/aidlc-reply-reader.ts";
import {
  CEREMONY_FLAGS,
  KNOWLEDGE_VERBS,
  ORCHESTRATOR_VERBS,
  nextFlagShape,
  READ_ONLY_FLAGS,
  splitKiroCommandArgs,
  validScopes,
  WORKSPACE_VERBS,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// Every flag the `next` parser reads an argument as, from its source: each
// `a === "--flag"` comparison and the `--config` it looks up. That is the one
// table of what `next` understands. (A value inside `config list --json` is
// that command's own, not a flag of `next`.)
function parserFlags(): string[] {
  const source = readFileSync(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), "utf-8");
  const start = source.indexOf("function parseNextFlags(");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);
  const compared = [...body.matchAll(/\ba === "(--[a-z][a-z-]*)"/g)].map((match) => match[1]);
  const lookedUp = [...body.matchAll(/args\.indexOf\("(--[a-z][a-z-]*)"\)/g)].map((match) => match[1]);
  return [...new Set([...compared, ...lookedUp])];
}

const words = (text: string) => nextArgsAreOnlyWords(splitKiroCommandArgs(text));

describe("words typed after /aidlc are a reply unless the dispatcher reads a command in them", () => {
  test("every flag the parser knows keeps the message a command, with or without a value, unless a utility flag sits among the person's words", () => {
    const flags = [...parserFlags(), ...READ_ONLY_FLAGS, ...Object.values(CEREMONY_FLAGS)];
    expect(flags.length).toBeGreaterThan(20);
    // `next` reads --doctor's own arguments only after --doctor, and a valued
    // flag with nothing after it as task text: in both cases `next` reads
    // words, and so does the reply.
    const doctorArgs = new Set(["--export", "--output", "--verbose"]);
    // A flag `next` takes with a value its own table does not hold has two
    // readings (a value they mistyped, or their own words), so it goes to the
    // agent whole and the words stay the person's: the reply is still a reply.
    const refuses = (flag: string, value: string): boolean => {
      const shape = nextFlagShape(flag);
      return shape?.value === "words" && shape.words?.includes(value) === false;
    };
    for (const flag of flags) {
      const lead = doctorArgs.has(flag) ? ["--doctor"] : [];
      expect(nextArgsAreOnlyWords([...lead, flag, "standard"]), `${flag} standard`)
        .toBe(refuses(flag, "standard"));
      if (lead.length === 0) {
        // Among the person's own words a utility flag is one of their words
        // ("add a --version flag ..."), so the message stays their reply. So is
        // a flag `next` takes with a value its own table does not hold: the
        // line has two readings, the agent picks, and their approval is still
        // theirs ("approve, but add a --verbose flag").
        expect(nextArgsAreOnlyWords(["approve", "it", flag, "off"]), `approve it ${flag} off`).toBe(
          READ_ONLY_FLAGS.has(flag) || refuses(flag, "off"),
        );
      }
    }
  });

  test("every verb, noun and scope word the dispatcher leads with keeps the message a command", () => {
    const leading: string[][] = [
      ...[...ORCHESTRATOR_VERBS].map((verb) => [verb]),
      ...[...WORKSPACE_VERBS].map((noun) => [noun, "list"]),
      ...KNOWLEDGE_VERBS.map((verb) => ["knowledge", verb]),
      ["plugin", "list"],
      ["config", "get", "depth"],
      ["compose", "a smaller plan"],
      ["help"],
      ["-h"],
      ["unpark"],
    ];
    expect(validScopes().size).toBeGreaterThan(5);
    for (const args of leading) expect(nextArgsAreOnlyWords(args), args.join(" ")).toBe(false);
    expect(nextArgsAreOnlyWords([])).toBe(false);
    // A plan's name alone is the plan; with their own words after it, unmarked,
    // the two readings go to the agent and the words stay the person's, so a
    // reply typed that way is still a reply.
    for (const scope of validScopes()) {
      expect(nextArgsAreOnlyWords([scope]), scope).toBe(false);
      expect(nextArgsAreOnlyWords([scope, "fix", "the", "login", "crash"]), scope).toBe(true);
    }
  });

  test("the person's own words are a reply", () => {
    for (const text of [
      "approve the code plan",
      "use postgres",
      "yes",
      "1",
      "A",
      "looks good, approve",
      "help me build auth",
      "park it for today",
      "approve, and turn plan approval off",
    ]) {
      expect(words(text), text).toBe(true);
    }
  });

  test("only a plain /aidlc or $aidlc entry gives words; a runner entry and other slashes do not", () => {
    expect(aidlcEntryWords("/aidlc approve the code plan")).toBe("approve the code plan");
    expect(aidlcEntryWords("  $aidlc   use postgres ")).toBe("use postgres");
    expect(aidlcEntryWords("/AIDLC yes")).toBe("yes");
    expect(aidlcEntryWords("/aidlc")).toBe("");
    expect(aidlcEntryWords("/aidlc-bugfix fix the login crash")).toBeNull();
    expect(aidlcEntryWords("/api/users returns 500")).toBeNull();
    expect(aidlcEntryWords("approve")).toBeNull();
  });
});
