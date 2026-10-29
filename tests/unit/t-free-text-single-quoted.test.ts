// covers: harness-instrument:free-text-quoting-lint
//
// Words on an AI-DLC command line travel in single quotes. Inside double quotes
// a `$` or a backtick in them is expanded by the shell: a choice "$0.00" was
// recorded as "/usr/bin/bash.00" and Claude Code asked the person to allow
// AI-DLC's own command, since it cannot vouch for an expansion (#3135). The
// agent copies the form the shipped text shows, so this lint reads every
// shipped prose file and engine string under core/, harness/ and plugins/ and
// fails on a double-quoted placeholder for words: a flag's value, or what
// `next`, `next compose` and `audit append-raw` take as their words. A flag
// whose value the engine names (a slug, an id or a path) may stay
// double-quoted; the `"|<A>|<B>"` list form stays, since the Copilot adapter's
// VS Code allow takes a `|` only inside double quotes; a harness whose shell is
// cmd.exe keeps its skill's own rule to switch to double quotes there.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Flags whose value is a name the engine gave: no words of anyone's.
const ENGINE_NAMED = new Set([
  "artifacts", "fix-finding", "override-file", "project-dir", "questions-file", "reviewer", "stage", "unit", "units",
]);

const SHIPPED = /\.(md|mdc|ts|json|toml)$/;

function shippedFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "tests" || entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return shippedFiles(path);
    return SHIPPED.test(entry.name) ? [path] : [];
  });
}

// A flag's double-quoted value holding a placeholder, escaped quotes included;
// not the `"|<A>|<B>"` list.
const FLAG_VALUE = /--([a-z][a-z-]*) \\{0,3}"(?!\|)[^"\n]*</g;
// The words `next` (after any flags) and `next compose` take, and each of
// `audit append-raw`'s two.
const POSITIONAL_WORDS = /\b(?:next(?: --[a-z-]+(?: <[^>\s]+>)?)*(?: compose)?|append-raw(?: '[^'\n]*')?) \\{0,3}"[^"\n]*</g;

function doubleQuotedWords(text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(FLAG_VALUE)) {
      if (!ENGINE_NAMED.has(match[1])) found.push(`${index + 1}: ${match[0]}`);
    }
    for (const match of line.matchAll(POSITIONAL_WORDS)) found.push(`${index + 1}: ${match[0]}`);
  });
  return found;
}

describe("words on an AI-DLC command line are single-quoted in everything AI-DLC ships", () => {
  test("the lint finds each double-quoted form and passes the single-quoted and engine-named ones", () => {
    expect(doubleQuotedWords([
      "`report --stage x --result skipped --reason \"<why>\"`",
      "\"--details \\\"<their choice>\\\"\"",
      "--details \"Request Changes: <feedback>\"",
      "`next compose \"<their words>\"`",
      "`next --new-intent --scope <scope> \"<text>\"`",
      "`audit append-raw 'Error: <brief>' \"<body>\"`",
    ].join("\n"))).toHaveLength(6);
    expect(doubleQuotedWords([
      "`report --stage x --result skipped --reason '<why>'`",
      "`--unit \"<directive.unit>\" --stage \"<directive.stage>\"`",
      "--options \"|<A>|<B>|<C>\"",
      "--user-input \"Approve\"",
      "`/aidlc compose \"<task>\"`",
      "`next compose '<their words>'`",
      "`audit append-raw 'Error: <brief>' '<body>'`",
    ].join("\n"))).toEqual([]);
  });

  test("no shipped prose file or engine string double-quotes a placeholder for words", () => {
    const found = ["core", "harness", "plugins"].flatMap((root) =>
      shippedFiles(join(REPO_ROOT, root)).flatMap((path) =>
        doubleQuotedWords(readFileSync(path, "utf-8")).map((hit) => `${relative(REPO_ROOT, path)}:${hit}`)
      )
    );
    expect(found).toEqual([]);
  });
});
