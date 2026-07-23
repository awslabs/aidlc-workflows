// scripts/ci-changelog-guard.ts — CI guard: a PR must never DELETE an existing
// CHANGELOG entry.
//
// tests/unit/t68 already guards version⇄changelog sync and heading UNIQUENESS,
// but nothing guards against a PR dropping a `## [x.y.z]` heading that shipped
// on the base branch (a bad rebase, an accidental truncation, or a conflict
// resolution that clobbers someone else's entry). This runs in CI where the PR
// base ref is available to diff against; it is intentionally NOT a unit test
// (a unit test has no base ref to compare to).
//
// Usage: bun scripts/ci-changelog-guard.ts <base-ref>
//   e.g. bun scripts/ci-changelog-guard.ts origin/v2
//
// Exit 0 = every base heading is still present (new headings are fine).
// Exit 1 = one or more base headings were removed (prints them), or the base
//          CHANGELOG could not be read.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Same shape t68 pins: `## [N.N.N]` at line start. Kept in lock-step so the two
// guards never disagree about what counts as a heading.
const HEADING_LINE = /^## \[[0-9]+\.[0-9]+\.[0-9]+\]/;
const SEMVER = /[0-9]+\.[0-9]+\.[0-9]+/;

const REPO_ROOT = join(import.meta.dir, "..");
const CHANGELOG_PATH = join(REPO_ROOT, "CHANGELOG.md");

function headingsFrom(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => HEADING_LINE.test(l))
    .map((l) => (l.match(SEMVER) as RegExpMatchArray)[0]);
}

function baseChangelog(baseRef: string): string {
  const r = spawnSync("git", ["show", `${baseRef}:CHANGELOG.md`], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    const detail = (r.stderr || "").trim() || `git exited ${r.status}`;
    throw new Error(
      `Could not read CHANGELOG.md at base ref "${baseRef}": ${detail}. ` +
        `Ensure the workflow checks out with fetch-depth: 0 and passes the base ref.`,
    );
  }
  return r.stdout;
}

function main(): void {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error("Usage: bun scripts/ci-changelog-guard.ts <base-ref>");
    process.exit(2);
  }
  if (!existsSync(CHANGELOG_PATH)) {
    console.error(`ci-changelog-guard: ${CHANGELOG_PATH} not found.`);
    process.exit(1);
  }

  let baseText: string;
  try {
    baseText = baseChangelog(baseRef);
  } catch (e) {
    console.error(`ci-changelog-guard: ${(e as Error).message}`);
    process.exit(1);
  }

  const baseHeadings = new Set(headingsFrom(baseText));
  const prHeadings = new Set(headingsFrom(readFileSync(CHANGELOG_PATH, "utf-8")));

  const removed = [...baseHeadings].filter((v) => !prHeadings.has(v));

  if (removed.length > 0) {
    console.error(
      `ci-changelog-guard: this PR removes CHANGELOG entries present on "${baseRef}":`,
    );
    for (const v of removed) console.error(`  - ## [${v}]`);
    console.error(
      "\nEvery shipped CHANGELOG entry must be preserved. If you rebased, keep " +
        "the base entries and add yours above them (re-bump your version if it " +
        "now collides — see the CHANGELOG conflict-trap policy in AGENTS.md).",
    );
    process.exit(1);
  }

  console.log(
    `ci-changelog-guard: OK — all ${baseHeadings.size} CHANGELOG entries from "${baseRef}" preserved ` +
      `(${prHeadings.size - baseHeadings.size} new).`,
  );
}

main();
