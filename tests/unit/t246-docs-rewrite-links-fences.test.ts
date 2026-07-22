// t246-docs-rewrite-links-fences: run the real scripts/docs-rewrite-links.ts
// as a subprocess against purpose-built markdown fixtures and assert its two
// contracts: (1) CommonMark fence handling - links inside fenced code blocks
// are example text and ship verbatim, where "inside" honours the opener's
// marker character and length (a ``` line inside a ```` block is content, not
// a closer); (2) navigation links that resolve outside docs/ are rewritten to
// GitHub blob URLs when the target exists and fail the run (exit 1) when it
// does not.
//
// covers: script:docs-rewrite-links

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "docs-rewrite-links.ts");
const BLOB_URL = "https://github.com/awslabs/aidlc-workflows/blob/v2";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Lay out <root>/docs/page.md plus a real out-of-tree target, run the script. */
function run(pageBody: string): { exitCode: number; stderr: string; page: string } {
  const root = mkdtempSync(join(tmpdir(), "t246-"));
  scratch.push(root);
  const docs = join(root, "docs");
  mkdirSync(docs);
  writeFileSync(join(root, "REAL.md"), "target\n");
  const page = join(docs, "page.md");
  writeFileSync(page, pageBody);
  const proc = Bun.spawnSync(["bun", SCRIPT, docs], { cwd: REPO_ROOT });
  return {
    exitCode: proc.exitCode,
    stderr: proc.stderr.toString(),
    page: readFileSync(page, "utf-8"),
  };
}

describe("t246 docs-rewrite-links fence awareness (CommonMark delimiters)", () => {
  test("rewrites an out-of-tree navigation link and leaves intra-docs links alone", () => {
    const r = run("See [real](../REAL.md) and [local](other.md).\n");
    expect(r.exitCode).toBe(0);
    expect(r.page).toContain(`](${BLOB_URL}/REAL.md)`);
    expect(r.page).toContain("[local](other.md)");
  });

  test("a missing out-of-tree target fails the run with file:line", () => {
    const r = run("Bad [gone](../missing.md).\n");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("docs/page.md:1");
    expect(r.page).toContain("[gone](../missing.md)");
  });

  test("links inside backtick and tilde fences ship verbatim", () => {
    const r = run(
      "```markdown\n[fenced](../missing.md)\n```\n\n~~~\n[tilde](../also-missing.md)\n~~~\n\n[real](../REAL.md)\n",
    );
    expect(r.exitCode).toBe(0);
    expect(r.page).toContain("[fenced](../missing.md)");
    expect(r.page).toContain("[tilde](../also-missing.md)");
    expect(r.page).toContain(`](${BLOB_URL}/REAL.md)`);
  });

  test("a shorter inner ``` does not close a ```` fence (marker-length rule)", () => {
    const r = run(
      "````markdown\n```text\n[example](../missing.md)\n```\n````\n\n[real](../REAL.md)\n",
    );
    expect(r.exitCode).toBe(0);
    expect(r.page).toContain("[example](../missing.md)");
    expect(r.page).toContain(`](${BLOB_URL}/REAL.md)`);
  });

  test("a tilde line does not close a backtick fence (marker-character rule)", () => {
    const r = run("```\n~~~\n[example](../missing.md)\n```\n\n[real](../REAL.md)\n");
    expect(r.exitCode).toBe(0);
    expect(r.page).toContain("[example](../missing.md)");
    expect(r.page).toContain(`](${BLOB_URL}/REAL.md)`);
  });

  test("a longer closer with an info string is content, not a close", () => {
    // CommonMark: the closing fence may not carry an info string.
    const r = run("```\n````text\n[example](../missing.md)\n```\n\n[real](../REAL.md)\n");
    expect(r.exitCode).toBe(0);
    expect(r.page).toContain("[example](../missing.md)");
    expect(r.page).toContain(`](${BLOB_URL}/REAL.md)`);
  });

  test("after a properly closed fence, rewriting resumes", () => {
    const r = run("```\ncode\n```\n\n[real](../REAL.md)\n");
    expect(r.exitCode).toBe(0);
    expect(r.page).toContain(`](${BLOB_URL}/REAL.md)`);
  });
});
