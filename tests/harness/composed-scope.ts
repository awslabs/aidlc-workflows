import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  frontmatterBlock,
  listField,
  scalarField,
} from "../../core/tools/aidlc-lib.ts";

/**
 * Resolve the composed identity by its declared name, as loadScopeMetadataAll
 * does. Doctor accepts either <name>.md or aidlc-<name>.md for a core scope;
 * the name itself may already start with aidlc-. Never guess the identity by
 * stripping a prefix or by accepting the first new Markdown file.
 */
export function assertComposedScopeFile(scopesDir: string, name: string): string {
  const matches = readdirSync(scopesDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const path = join(scopesDir, file);
      const fm = frontmatterBlock(readFileSync(path, "utf-8"));
      if (fm === null) throw new Error(`Scope file missing frontmatter: ${path}`);
      const declaredName = scalarField(fm, "name");
      if (!declaredName) throw new Error(`Scope file missing name: ${path}`);
      return { path, fm, name: declaredName };
    })
    .filter((scope) => scope.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one scope file declaring "${name}", found ${matches.length}: ` +
        matches.map((scope) => scope.path).join(", "),
    );
  }
  const { path, fm } = matches[0];
  const stem = basename(path, ".md");
  if (stem !== name && stem !== `aidlc-${name}`) {
    throw new Error(`Scope filename "${stem}" does not match declared name "${name}"`);
  }

  // Omitted keywords and an empty block also mean no inference. Check the
  // inline value as well: listField intentionally ignores malformed scalars.
  const inline = fm.match(/^keywords:([^\r\n]*)/m)?.[1].trim();
  if (
    (inline !== undefined && inline !== "" && inline !== "[]") ||
    listField(fm, "keywords").length > 0
  ) {
    throw new Error(`Composed scope "${name}" has nonempty or invalid keywords: ${path}`);
  }
  return path;
}
