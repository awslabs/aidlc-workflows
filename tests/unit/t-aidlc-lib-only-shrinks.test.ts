// covers: harness-instrument:aidlc-lib-only-shrinks
//
// core/tools/aidlc-lib.ts takes no new code (docs/reference/11-contributing.md,
// "Where new tool code goes"). Read with the TypeScript parser, so a string or a
// comment is never taken for code:
//   1. every top-level name it declares is on tests/fixtures/aidlc-lib-declarations.txt
//      (an `export ... from` line declares nothing). A move out of the file deletes
//      its names from the list; nothing adds one. Its size is capped by biome.json's
//      override for the file, which each move lowers;
//   2. a module it names in an import or `export ... from` line never imports it
//      back, except those on IMPORTS_LIB_BEFORE_THE_RULE; one that stops comes off it.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

// Parsing the file takes most of a second, longer on a slow Windows box.
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(REPO_ROOT, "core", "tools");
const LIB = "aidlc-lib.ts";
const LIST = join(REPO_ROOT, "tests", "fixtures", "aidlc-lib-declarations.txt");
// They reach aidlc-lib.ts at load time while it reaches them only by type and a
// lazy require(); a module moved out of it has no such way round.
const IMPORTS_LIB_BEFORE_THE_RULE = new Set([
  "aidlc-audit.ts",
  "aidlc-construction-checkpoints.ts",
  "aidlc-graph.ts",
  "aidlc-swarm-checkpoints.ts",
]);

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
}

/** The names a file declares at its top level. */
function declaredNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      names.push(statement.name?.text ?? "default");
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      names.push(statement.name.text);
    } else if (ts.isExportAssignment(statement)) {
      names.push("default");
    }
  }
  return names;
}

/** The sibling modules a file names in its import and `export ... from` lines. */
function namedSiblings(source: ts.SourceFile): string[] {
  const siblings = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier) && /^\.\/[\w.-]+\.ts$/.test(specifier.text)) {
      siblings.add(specifier.text.slice(2));
    }
  }
  return [...siblings];
}

/** Whether a module reaches aidlc-lib.ts: import, export from, require(), import() or an import type. */
function reachesLib(source: ts.SourceFile): boolean {
  const isLib = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isStringLiteralLike(node) && /^\.\/aidlc-lib(?:\.ts|\.js)?$/.test(node.text);
  const visit = (node: ts.Node): boolean => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isLib(node.moduleSpecifier)) return true;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")) && isLib(node.arguments[0])) {
      return true;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isLib(node.argument.literal)) return true;
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(source);
}

const WHERE = 'new code goes in its area\'s module (docs/reference/11-contributing.md, "Where new tool code goes")';

describe("t-aidlc-lib-only-shrinks", () => {
  const lib = parse(LIB, readFileSync(join(TOOLS, LIB), "utf8"));

  test("aidlc-lib.ts declares no name that is not on its list", () => {
    const listed = new Set(readFileSync(LIST, "utf8").split(/\r?\n/).filter(Boolean));
    const added = [...new Set(declaredNames(lib))].filter((name) => !listed.has(name));
    expect(added, `aidlc-lib.ts declares ${added.join(", ")}: ${WHERE}`).toEqual([]);
  });

  test("a module aidlc-lib.ts imports or re-exports never imports it back", () => {
    const back = namedSiblings(lib)
      .filter((sibling) => !IMPORTS_LIB_BEFORE_THE_RULE.has(sibling))
      .filter((sibling) => reachesLib(parse(sibling, readFileSync(join(TOOLS, sibling), "utf8"))));
    expect(back, `aidlc-lib.ts loads ${back.join(", ")}, and each imports it back: move what it needs out of aidlc-lib.ts too`).toEqual([]);
  });

  test("each module that imported aidlc-lib.ts before the rule still does", () => {
    const stale = [...IMPORTS_LIB_BEFORE_THE_RULE].filter(
      (sibling) => !reachesLib(parse(sibling, readFileSync(join(TOOLS, sibling), "utf8"))),
    );
    expect(stale, "no longer imports aidlc-lib.ts: take it off IMPORTS_LIB_BEFORE_THE_RULE").toEqual([]);
  });

  test("the readers see code, never a comment or a string", () => {
    const sample = parse("sample.ts", [
      'import { a } from "./aidlc-x.ts";',
      'import type { B } from "./aidlc-y.ts";',
      'export { c } from "./aidlc-z.ts";',
      'import { readFileSync } from "node:fs";',
      "// function inComment() {} from \"./aidlc-lib.ts\"",
      'const text = "function inString() {}";',
      "export function placedHere(): void {}",
      "const one = 1, { two, three: [four] } = { two: 2, three: [4] };",
      "export interface Shape {}",
      "type Alias = string;",
      "class Thing {}",
      "enum Kind { A }",
    ].join("\n"));
    expect(declaredNames(sample)).toEqual(["text", "placedHere", "one", "two", "four", "Shape", "Alias", "Thing", "Kind"]);
    expect(namedSiblings(sample)).toEqual(["aidlc-x.ts", "aidlc-y.ts", "aidlc-z.ts"]);
    expect(reachesLib(sample)).toBe(false);
    for (const line of [
      'import { x } from "./aidlc-lib.ts";',
      'import type { X } from "./aidlc-lib";',
      'export { x } from "./aidlc-lib.ts";',
      'const lib = require("./aidlc-lib.ts");',
      'const lib = await import("./aidlc-lib.ts");',
      'type Lib = typeof import("./aidlc-lib.ts");',
    ]) {
      expect(reachesLib(parse("reaches.ts", line)), line).toBe(true);
    }
  });
});
