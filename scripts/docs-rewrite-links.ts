// Rewrites relative markdown links whose targets resolve OUTSIDE docs/ into
// GitHub blob URLs. The published site is built from docs/ only, so a relative
// link into dist/, core/, or plugins/ has no page to land on there; in a local
// clone the same relative link is the better experience (jumps straight to the
// file). The committed markdown therefore keeps relative links, and the docs
// deploy workflow (.github/workflows/docs.yml) runs this in-place on the CI
// checkout right before `zensical build` - the rewrite is never committed.
//
// Lines inside fenced code blocks (``` or ~~~) are left untouched: a link
// there is example text, not navigation, and must ship verbatim.
//
// Fails (exit 1) if a link target does not exist on disk, so a typo'd path
// breaks the deploy instead of shipping a dead GitHub URL.
//
// Usage: bun scripts/docs-rewrite-links.ts [docsDir]   (default: docs)

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const REPO_BLOB_URL = "https://github.com/awslabs/aidlc-workflows/blob/v2";

const docsDir = resolve(process.argv[2] ?? "docs");
const repoRoot = dirname(docsDir);

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listMarkdown(abs));
    else if (name.endsWith(".md")) out.push(abs);
  }
  return out;
}

let rewritten = 0;
let missing = 0;

for (const file of listMarkdown(docsDir)) {
  const body = readFileSync(file, "utf-8");
  const lines = body.split("\n");
  // Open fence delimiter, or null outside a fence. CommonMark: a fence closes
  // only on the SAME marker character with AT LEAST as many markers as the
  // opener (and no info string) - a ``` line inside a ```` block is content.
  let fence: { char: string; len: number } | null = null;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (m) {
      const [, marker, rest] = m;
      if (fence === null) {
        fence = { char: marker[0], len: marker.length };
        continue;
      }
      if (marker[0] === fence.char && marker.length >= fence.len && rest.trim() === "") {
        fence = null;
        continue;
      }
      // Incompatible delimiter inside an open fence: plain content.
    }
    if (fence !== null) continue;
    // Inline links/images: `](target)` with an optional `#fragment`. Absolute
    // URLs (scheme-prefixed) and pure in-page anchors are left alone.
    const next = lines[i].replace(
      /\]\(([^)#\s]+)(#[^)\s]*)?\)/g,
      (whole, target: string, fragment: string | undefined) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole;
        const abs = resolve(dirname(file), target);
        if (abs.startsWith(docsDir + sep)) return whole;
        if (!existsSync(abs)) {
          console.error(`MISSING: ${relative(repoRoot, file)}:${i + 1} -> ${target}`);
          missing++;
          return whole;
        }
        rewritten++;
        const repoRel = relative(repoRoot, abs).split(sep).join("/");
        return `](${REPO_BLOB_URL}/${repoRel}${fragment ?? ""})`;
      },
    );
    if (next !== lines[i]) {
      lines[i] = next;
      changed = true;
    }
  }
  if (changed) writeFileSync(file, lines.join("\n"));
}

console.log(`docs-rewrite-links: ${rewritten} out-of-tree link(s) rewritten to ${REPO_BLOB_URL}`);
if (missing > 0) {
  console.error(`docs-rewrite-links: ${missing} link target(s) missing on disk - refusing to deploy dead links.`);
  process.exit(1);
}
