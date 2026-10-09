// covers: subcommand:release-notes
//
// A stable release's body is this version's CHANGELOG entry. It used to be
// GitHub's generated "What's Changed" list, which names every contributing
// account by handle: a published page naming people who never chose to be named
// there, and twice it carried a handle that should not have been published at
// all. The release job now writes the entry to a file and passes it with
// `--notes-file`, and this holds the script that writes it.
//
// The heading rule itself has one owner, `releaseNotesFromChangelog`, which the
// preview channel publishes with and t68 holds the CHANGELOG to; these cases
// cover the script around it, including the two failures that must stop a
// release before it creates anything.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const SCRIPT = join(REPO_ROOT, "scripts", "release-notes.ts");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A CHANGELOG of the shape the release-preparation PR writes. */
function changelog(body: string): { changelog: string; out: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "aidlc-t-release-notes-"));
  roots.push(root);
  const path = join(root, "CHANGELOG.md");
  writeFileSync(path, body, "utf-8");
  return { changelog: path, out: join(root, "release-notes.md") };
}

function run(tag: string, files: { changelog: string; out: string }): {
  status: number;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--tag", tag, "--changelog", files.changelog, "--out", files.out],
    { encoding: "utf-8" },
  );
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

const ENTRY = `# Changelog

## [2.12.0] - 2026-10-09

What a person gets in this release.

- A flag they type
- An error they read

## [2.11.0] - 2026-10-08

The release before it.

- An older bullet
`;

describe("the release body is the CHANGELOG entry for the tag", () => {
  test("the entry is written, and the next heading ends it", () => {
    const files = changelog(ENTRY);
    const run212 = run("v2.12.0", files);
    expect(run212.status, run212.stderr).toBe(0);
    const notes = readFileSync(files.out, "utf-8");
    expect(notes).toBe(
      "What a person gets in this release.\n\n- A flag they type\n- An error they read\n",
    );
    expect(notes).not.toContain("2.11.0");
    expect(notes).not.toContain("An older bullet");
  });

  test("an older version in the same file is written on its own", () => {
    const files = changelog(ENTRY);
    expect(run("v2.11.0", files).status).toBe(0);
    expect(readFileSync(files.out, "utf-8")).toBe(
      "The release before it.\n\n- An older bullet\n",
    );
  });

  // The release job runs this before it creates anything, so a release with no
  // entry to show stops here rather than publishing a page of handles.
  test("a version with no heading fails and writes nothing", () => {
    const files = changelog(ENTRY);
    const missing = run("v2.13.0", files);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no dated 2.13.0 release heading");
    expect(() => readFileSync(files.out, "utf-8")).toThrow();
  });

  test("a heading with an empty section fails", () => {
    const files = changelog("# Changelog\n\n## [2.12.0] - 2026-10-09\n\n## [2.11.0] - 2026-10-08\n\nThe one before.\n");
    const empty = run("v2.12.0", files);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("no release notes for 2.12.0");
  });

  test("an undated heading is not a release heading", () => {
    const files = changelog("# Changelog\n\n## [2.12.0]\n\nNo date on it.\n");
    const undated = run("v2.12.0", files);
    expect(undated.status).toBe(1);
    expect(undated.stderr).toContain("no dated 2.12.0 release heading");
  });

  test("a missing flag is named rather than guessed", () => {
    const files = changelog(ENTRY);
    const noOut = spawnSync(
      process.execPath,
      [SCRIPT, "--tag", "v2.12.0", "--changelog", files.changelog],
      { encoding: "utf-8" },
    );
    expect(noOut.status).toBe(1);
    expect(noOut.stderr ?? "").toContain("missing --out <value>");
  });

  // The reason this path exists at all: nothing in the body comes from GitHub's
  // list of pull requests and the accounts that opened them.
  test("the body carries no account handle, as the generated list did", () => {
    const files = changelog(ENTRY);
    expect(run("v2.12.0", files).status).toBe(0);
    const notes = readFileSync(files.out, "utf-8");
    expect(notes).not.toContain("@");
    expect(notes).not.toContain("What's Changed");
    expect(notes).not.toMatch(/by .+ in https:\/\/github\.com/);
  });
});
