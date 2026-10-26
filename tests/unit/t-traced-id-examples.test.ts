// covers: harness-instrument:traced-id-example-lint
//
// The traceability sensor reads requirement, story, criterion, rule and Unit
// IDs only in the form the stage files and verification.md give (`FR1`,
// `FR1.2`, `NFR3`, `US1.1`, `AC1.1.1`, `BR1.1`, `U1`; ID_PATTERNS in
// aidlc-sensor-traceability.ts). An example in shipped prose that shows such
// an ID with a hyphen or underscore (`FR-1`, `NFR_2`, `S-4`, `FR-n`) is one
// more nudge for an agent to write IDs the sensor cannot read, and a
// requirements file written that way first gets its finding at User Stories,
// after the person approved it (#2852). This reads AI-DLC's own shipped prose
// under core/, harness/ and plugins/, never a person's words.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { runTestSourceGit } from "../lib/test-source.ts";

const FOLDERS = ["core", "harness", "plugins"];
// Code and JSON hold IDs as data or in comments, not as examples an agent is
// given to follow; a plugin's tests/ folder holds fixtures.
const NOT_PROSE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)$/;
const PLUGIN_TESTS = /^plugins\/[^/]+\/tests\//;
// `S` is the bare story prefix the reviewer examples used for `US`.
const OFF_FORM = /\b(?:N?FR|US|AC|BR|U|S)[-_](?:\d+|[nxy])\b/g;

function offFormIds(text: string): string[] {
  return [...text.matchAll(OFF_FORM)].map((match) => match[0]);
}

/** Tracked or would-be-tracked prose files, so test leftovers are never read. */
function proseFiles(): string[] {
  const listed = runTestSourceGit(REPO_ROOT, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...FOLDERS]);
  return [...new Set(listed.split("\0"))].filter(
    (path) => path !== "" && !NOT_PROSE.test(path) && !PLUGIN_TESTS.test(path) && existsSync(join(REPO_ROOT, path)),
  );
}

describe("t-traced-id-examples", () => {
  test("the check finds the hyphen and underscore forms and leaves the forms the sensor reads", () => {
    expect(offFormIds("FR-1 NFR_2 FR-001 U-007 S-4 US-1 AC-1 BR-2 FR-n/NFR-n")).toEqual([
      "FR-1", "NFR_2", "FR-001", "U-007", "S-4", "US-1", "AC-1", "BR-2", "FR-n", "NFR-n",
    ]);
    expect(offFormIds("FR1 FR1.2 NFR3 NFR2.1 US1.1 AC1.1.1 BR1.1 U1 u1-auth R-01 ENT-001 AWS-1 FR{n}")).toEqual([]);
  });

  test("no example in shipped prose shows a traced ID in a form the sensor cannot read", () => {
    const files = proseFiles();
    expect(files).toContain("core/memory/org.md");
    const findings: string[] = [];
    for (const path of files) {
      readFileSync(join(REPO_ROOT, path), "utf8").split(/\r?\n/).forEach((line, index) => {
        for (const id of offFormIds(line)) {
          findings.push(`${path}:${index + 1}: ${id}: write it the way the stage files do (FR1, NFR3, US1.1, AC1.1.1, BR1.1, U1)`);
        }
      });
    }
    expect(findings).toEqual([]);
  });
});
