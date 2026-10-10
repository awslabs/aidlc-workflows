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
    for (const flag of flags) {
      const lead = doctorArgs.has(flag) ? ["--doctor"] : [];
      expect(nextArgsAreOnlyWords([...lead, flag, "standard"]), `${flag} standard`).toBe(false);
      if (lead.length === 0) {
        // Among the person's own words a utility flag is one of their words
        // ("add a --version flag ..."), so the message stays their reply. So is
        // --session and --choice, which `next` reads only ahead of their words
        // (arguments the agent passed to the wrong command).
        expect(nextArgsAreOnlyWords(["approve", "it", flag, "off"]), `approve it ${flag} off`).toBe(
          READ_ONLY_FLAGS.has(flag) || flag === "--session" || flag === "--choice",
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
      ...[...validScopes()].map((scope) => [scope, "fix", "the", "login", "crash"]),
    ];
    expect(validScopes().size).toBeGreaterThan(5);
    for (const args of leading) expect(nextArgsAreOnlyWords(args), args.join(" ")).toBe(false);
    expect(nextArgsAreOnlyWords([])).toBe(false);
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
