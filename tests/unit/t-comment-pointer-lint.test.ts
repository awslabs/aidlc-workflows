// covers: harness-instrument:comment-pointer-lint
//
// A comment points at code by name, never by line: a line number goes wrong as
// soon as someone edits above it (AGENTS.md, "Comments"). This lint reads every
// comment in the code folders with the TypeScript parser, so a string, regex or
// template is never taken for a comment, and fails on a line pointer: a file
// with an extension and a line, any name with a line range, or a bare line
// after a space or bracket. A value written `name: 123`, a port in a URL, a
// time, and a name with neither extension nor range are not pointers.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { runTestSourceGit } from "../lib/test-source.ts";

// Parsing every source file takes longer than bun's default case timeout.
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const FOLDERS = ["core", "harness", "scripts", "plugins", "tests"];
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
// Fixtures are inputs the tests read as data, not code anyone maintains.
const FIXTURES = "tests/fixtures/";
// #1568 edits the lines under these two t66 comments: cut this skip when it lands or closes.
const SKIP_POINTERS = new Set(["tests/integration/t66.test.ts .sh:79-84", "tests/integration/t66.test.ts .sh:892-900"]);
const URL = /\bhttps?:\/\/\S+/g;
const POINTER =
  /(?<![\w./-])(?:[\w./-]*\.[A-Za-z]{1,5}:\d+(?:-\d+)?|[A-Za-z_][\w.-]*:\d+-\d+)\b|(?<![\w:])(?<=^|[\s([,;/]):\d{2,}\b/g;

/** The line pointers in one comment's text. */
export function pointersIn(comment: string): string[] {
  const text = comment.replace(URL, (url) => " ".repeat(url.length));
  return [...text.matchAll(POINTER)].map((match) => match[0]);
}

/**
 * The source files Git tracks or would track, so what a test run leaves behind
 * (tests/logs/, dist/, node_modules/) is never read. --cached still lists a
 * tracked file deleted from the working tree, hence the existsSync.
 */
function sourceFiles(): string[] {
  const listed = runTestSourceGit(REPO_ROOT, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...FOLDERS]);
  return [...new Set(listed.split("\0"))].filter(
    (path) => SOURCE.test(path) && !path.startsWith(FIXTURES) && existsSync(join(REPO_ROOT, path)),
  );
}

/** Every comment in a file, once, with the line it starts on. */
function commentsOf(file: string, text: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Map<number, string>();
  const take = (ranges: ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) found.set(range.pos, text.slice(range.pos, range.end));
  };
  // Tokens are children too, so a comment right before a closing bracket is
  // read as well.
  const visit = (node: ts.Node): void => {
    take(ts.getLeadingCommentRanges(text, node.getFullStart()));
    take(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...found].map(([pos, comment]) => ({
    line: source.getLineAndCharacterOfPosition(pos).line + 1,
    text: comment,
  }));
}

describe("t-comment-pointer-lint", () => {
  test("no comment in core/, harness/, scripts/, plugins/ or tests/ points at a line", () => {
    const findings: string[] = [];
    for (const path of sourceFiles()) {
      for (const comment of commentsOf(path, readFileSync(join(REPO_ROOT, path), "utf8"))) {
        for (const pointer of pointersIn(comment.text)) {
          if (SKIP_POINTERS.has(`${path} ${pointer}`)) continue;
          findings.push(`${path}:${comment.line}: ${pointer} in a comment: name the function, test or section instead`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  test("the check fires on each pointer shape and leaves values, ports and times alone", () => {
    expect(pointersIn("// see aidlc-jump.ts:142 and SKILL.md:191-193")).toEqual(["aidlc-jump.ts:142", "SKILL.md:191-193"]);
    expect(pointersIn("/* docs/reference/16-artifact-vocabulary.md:144-167 */")).toEqual([
      "docs/reference/16-artifact-vocabulary.md:144-167",
    ]);
    expect(pointersIn("// activeIntent() returns null (lib:357-361)")).toEqual(["lib:357-361"]);
    expect(pointersIn("// the advance path does (:869/:935).")).toEqual([":869", ":935"]);
    expect(pointersIn("// :876-879). Tolerates a missing file")).toEqual([":876"]);
    for (const value of [
      "// Measured: 121 MB RSS",
      "// bounded by MAX_DIR_COLLISIONS: 998 same-day dirs",
      "// the after-step:9 anchor",
      "// output_tokens:0 when the turn was cut",
      "// model au.anthropic.claude-haiku-4-5-20251001-v1:0",
      "// http://localhost:8080/health and https://example.com:443/x",
      "// at 12:30 UTC, v0.6.10:",
      "// import from node:fs and bun:test",
      "// <file>:<line> placeholders",
    ]) {
      expect(pointersIn(value), value).toEqual([]);
    }
  });

  test("a comment right before a closing bracket is read", () => {
    const comments = commentsOf("x.ts", "function f() {\n  return 1;\n  // see lib.ts:12\n}\n").map((c) => c.text);
    expect(comments).toEqual(["// see lib.ts:12"]);
  });
});
