// covers: harness-instrument:free-text-quoting-lint
//
// Words on an AI-DLC command line travel in single quotes. Inside double quotes
// a `$` or a backtick in them is expanded by the shell: a choice "$0.00" was
// recorded as "/usr/bin/bash.00" and Claude Code asked the person to allow
// AI-DLC's own command, since it cannot vouch for an expansion (#3135). The
// agent copies the form the shipped text shows, and a person the form the
// docs show, so this lint reads every shipped prose file and engine string
// under core/, harness/ and plugins/, and every page under docs/, and fails on
// a double-quoted placeholder for words: a flag's value, or what `next`,
// `next compose` and `audit append-raw` take as their words. It is the one
// check of that rule. What stays, and why the patterns leave it alone:
//   - a flag whose value is a name the engine gave (a slug, an id or a path,
//     ENGINE_NAMED), such as `--questions-file \"<path>\"` in core/tools;
//   - a slash command typed in the chat (`/aidlc compose "<task>"`), which no
//     shell reads;
//   - the cmd.exe sentence in the Copilot and opencode skills, which shows no
//     `--flag "<...>"` form: a harness whose shell is cmd.exe switches to
//     double quotes there by its skill's own rule.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Flags whose value is a name the engine gave: no words of anyone's.
const ENGINE_NAMED = new Set([
  "artifacts", "claimed", "fix-finding", "override-file", "project-dir", "questions-file", "receipt", "reviewer",
  "stage", "unit", "units",
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

// A flag's double-quoted value holding a placeholder, escaped quotes included,
// the value on the flag's line or wrapped onto the next. A question whose
// choice holds a comma passes each choice as its own `--option`, so no `|`
// list is left for a shell to read.
const GAP = String.raw`(?:[ \t]+|[ \t]*\n[ \t]*)`;
const FLAG_VALUE = new RegExp(String.raw`--([a-z][a-z-]*)${GAP}\\{0,3}"[^"\n]*<`, "g");
// The words `next` (after any flags, a placeholder value with spaces too) and
// `next compose` take, and each of `audit append-raw`'s two; `next` also where
// the engine builds the command (`${aidlcDispatcherInvocation("orchestrate next")}`).
const POSITIONAL_WORDS = new RegExp(
  String.raw`\b(?:next(?:"\)\})?(?: --[a-z-]+(?: <[^>\n]+>)?)*(?: compose)?|append-raw(?:${GAP}'[^'\n]*')?)${GAP}\\{0,3}"[^"\n]*<`,
  "g",
);

function doubleQuotedWords(text: string): string[] {
  const line = (index: number): number => text.slice(0, index).split("\n").length;
  return [
    ...[...text.matchAll(FLAG_VALUE)].filter((match) => !ENGINE_NAMED.has(match[1])),
    ...text.matchAll(POSITIONAL_WORDS),
  ].map((match) => `${line(match.index)}: ${match[0].replace(/\s+/g, " ")}`);
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
      "`report --result skipped --reason\n  \"<why>\"`",
      `\${aidlcDispatcherInvocation("orchestrate next")} --new-intent --scope <the confirmed scope> "<the words>"`,
      "--options \"|<A>|<B>|<C>\"",
    ].join("\n"))).toHaveLength(9);
    expect(doubleQuotedWords([
      "`report --stage x --result skipped --reason '<why>'`",
      "`--unit \"<directive.unit>\" --stage \"<directive.stage>\"`",
      "--option '<A>' --option '<B>'",
      "--user-input \"Approve\"",
      "`/aidlc compose \"<task>\"`",
      "`next compose '<their words>'`",
      "`audit append-raw 'Error: <brief>' '<body>'`",
    ].join("\n"))).toEqual([]);
  });

  test("no shipped prose file, engine string or doc double-quotes a placeholder for words", () => {
    const docs = shippedFiles(join(REPO_ROOT, "docs")).filter((path) => path.endsWith(".md"));
    const found = [...["core", "harness", "plugins"].flatMap((root) => shippedFiles(join(REPO_ROOT, root))), ...docs]
      .flatMap((path) =>
        doubleQuotedWords(readFileSync(path, "utf-8")).map((hit) => `${relative(REPO_ROOT, path)}:${hit}`)
      );
    expect(found).toEqual([]);
  });
});
