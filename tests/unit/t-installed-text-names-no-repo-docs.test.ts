// covers: docs-gate:installed-text-pointers
//
// No install carries this repository's docs/ folder: the docs are published
// on the site zensical.toml names as site_url, the address the aidlc command
// prints as "Docs". So text AI-DLC installs into a project (the always-on
// onboarding, knowledge, protocols, a tool's message, a shipped example) never
// names a docs/ path: a line a person reads names the page's address on the
// site, and every address it names is a page the site builds from docs/.
//
// It reads every built tree a project can receive (dist/<harness>/ and
// dist/plugins/): markdown, JSON, TOML and other text whole; a .ts file only
// through its string and template text, read with the TypeScript parser, so a
// code comment (which no run shows) is not counted. The Kiro trees' own guide
// line is the Kiro owner's to change; it is the one allowed line, by exact text,
// and an allowed line that no longer appears fails so the list stays true.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { REPO_ROOT } from "../harness/fixtures.ts";

const DIST = join(REPO_ROOT, "dist");
const DOCS = join(REPO_ROOT, "docs");
const SITE = (Bun.TOML.parse(readFileSync(join(REPO_ROOT, "zensical.toml"), "utf-8")) as { site_url: string }).site_url;
// An address on the site, up to the first character that ends a path in prose or code.
const ADDRESS_END = "[^\\s`\"'()<>\\]]*";
const SITE_ADDRESS = new RegExp(SITE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + ADDRESS_END, "g");
// This repository's docs folder by its top-level entries (a page, or a folder with a slash), so a new one is
// covered without an edit here.
const DOCS_ENTRIES = readdirSync(DOCS).filter((name) => !name.startsWith(".")).sort()
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (statSync(join(DOCS, name)).isDirectory() ? "/" : ""));
const REPO_DOCS_PATH = new RegExp(`(?<![\\w.-])docs/(?:${DOCS_ENTRIES.join("|")})${ADDRESS_END}`, "g");
const posix = (path: string): string => path.split(sep).join("/");

// The Kiro guide line in the two Kiro onboarding fills (harness/kiro,
// harness/kiro-ide), as it reaches each built tree.
const ALLOWED: ReadonlyArray<{ file: string; path: string }> = [
  { file: "kiro/.kiro/steering/aidlc-onboarding.md", path: "docs/guide/harnesses/kiro.md#kiro-cli-v2" },
  { file: "kiro-ide/.kiro/steering/aidlc-onboarding.md", path: "docs/guide/harnesses/kiro.md" },
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...files(abs));
    else out.push(abs);
  }
  return out;
}

function trees(): string[] {
  return readdirSync(DIST).filter((name) => name !== "plugins" && !name.startsWith("."))
    .map((name) => join(DIST, name)).filter((abs) => statSync(abs).isDirectory())
    .concat(existsSync(join(DIST, "plugins")) ? [join(DIST, "plugins")] : []);
}

function codeText(abs: string, source: string): string[] {
  const file = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, false,
    abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text);
      for (const span of node.templateSpans) out.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

interface Found {
  file: string;
  match: string;
}

function scan(pattern: RegExp): Found[] {
  const found: Found[] = [];
  for (const tree of trees()) {
    for (const abs of files(tree)) {
      const bytes = readFileSync(abs);
      if (bytes.includes(0)) continue;
      const source = bytes.toString("utf-8");
      // A cheap look first: only a file that names the pattern is parsed.
      if (source.search(pattern) < 0) continue;
      const texts = /\.(?:[cm]?ts|tsx|[cm]?js)$/.test(abs) ? codeText(abs, source) : [source];
      for (const text of texts) {
        for (const match of text.matchAll(pattern)) {
          found.push({ file: posix(relative(DIST, abs)), match: match[0].replace(/[.,;:]+$/, "") });
        }
      }
    }
  }
  return found;
}

describe("installed text names docs pages by their address on the docs site", () => {
  const repoPaths = scan(REPO_DOCS_PATH);

  test("no installed file names a page of this repository's docs folder", () => {
    const allowed = (found: Found): boolean =>
      ALLOWED.some((entry) => entry.file === found.file && entry.path === found.match);
    expect(repoPaths.filter((found) => !allowed(found)).map((found) => `${found.file}: ${found.match}`)).toEqual([]);
  });

  test("every allowed line still appears (the list stays true)", () => {
    const stale = ALLOWED.filter((entry) =>
      !repoPaths.some((found) => found.file === entry.file && found.match === entry.path));
    expect(stale.map((entry) => `${entry.file}: ${entry.path}`)).toEqual([]);
  });

  test("every docs site address an installed file names is a page the site builds", () => {
    const missing = new Set<string>();
    for (const found of scan(SITE_ADDRESS)) {
      const page = found.match.slice(SITE.length);
      // The site builds directory addresses; a section anchor is the other test's to check.
      const known = !page.includes("#") && (page === ""
        ? existsSync(join(DOCS, "README.md"))
        : page.endsWith("/") && (existsSync(join(DOCS, `${page.slice(0, -1)}.md`)) ||
          existsSync(join(DOCS, page, "README.md"))));
      if (!known) missing.add(`${found.file}: ${found.match}`);
    }
    expect([...missing]).toEqual([]);
  });
});
