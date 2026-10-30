// covers: harness-instrument:no-hard-links-lint
//
// AI-DLC makes no hard links: exFAT and other storage a person brings have
// none, and a link from another temp folder or computer is not the no-replace
// step it is on one ext4 disk. An exclusive create ('wx') followed by a rename
// does that job everywhere (installWithoutReplacing in aidlc-locks.ts). This
// lint reads every source file under core/, harness/ and plugins/ with the
// TypeScript parser, so a comment or a string is never taken for code, and
// fails on any binding of node:fs's link: `linkSync`, `link` imported from
// node:fs or node:fs/promises, or `.link(` called on fs.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { runTestSourceGit } from "../lib/test-source.ts";

// Parsing every source file takes longer than bun's default case timeout.
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const FOLDERS = ["core", "harness", "plugins"];
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;

/** Every hard-link binding in one file's code, as `line: text`. */
export function hardLinksIn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node): string =>
    `${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.getText(source)}`;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "linkSync") found.push(at(node));
    if (
      ts.isImportSpecifier(node) &&
      (node.propertyName ?? node.name).text === "link" &&
      ts.isStringLiteral(node.parent.parent.parent.moduleSpecifier) &&
      FS_MODULE.test(node.parent.parent.parent.moduleSpecifier.text)
    ) {
      found.push(at(node));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "link" &&
      /\b(?:fs|fsp|promises)$/.test(node.expression.expression.getText(source))
    ) {
      found.push(at(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function shippedSources(): string[] {
  const listed = runTestSourceGit(REPO_ROOT, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...FOLDERS]);
  return [...new Set(listed.split("\0"))].filter((path) => SOURCE.test(path) && existsSync(join(REPO_ROOT, path)));
}

describe("t-no-hard-links-lint", () => {
  test("no code under core/, harness/ or plugins/ makes a hard link", () => {
    const findings = shippedSources().flatMap((path) =>
      hardLinksIn(path, readFileSync(join(REPO_ROOT, path), "utf8")).map((hit) => `${path}:${hit}`)
    );
    expect(findings).toEqual([]);
  });

  test("the lint finds each binding and nothing in a comment or a string", () => {
    const sample = [
      'import { linkSync, symlinkSync, unlinkSync } from "node:fs";',
      'import { link as hard } from "node:fs/promises";',
      'import * as fs from "node:fs";',
      "fs.link(a, b, () => {});",
      "fs.promises.link(a, b);",
      "// linkSync(a, b) in a comment, and link() too",
      'const words = "linkSync(a, b)";',
      "readlinkSync(a); symlinkSync(a, b); unlinkSync(a);",
      "markdown.link(a);",
    ].join("\n");
    expect(hardLinksIn("sample.ts", sample)).toEqual([
      "1: linkSync",
      "2: link as hard",
      "4: fs.link(a, b, () => {})",
      "5: fs.promises.link(a, b)",
    ]);
  });
});
