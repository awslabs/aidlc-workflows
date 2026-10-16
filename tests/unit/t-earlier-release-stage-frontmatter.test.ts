// covers: file:core/aidlc-common/stages/inception/requirements-analysis.md
//
// A project set up on 2.8.0 to 2.11.0 refreshes to this release with its own
// tool: `bun <dir>/tools/aidlc.ts config --from <runtime>` on a copy, and
// `aidlc config` on a native team clone whose teammate pinned this release.
// That tool compiles the stage graph from this release's stage files with its
// own parser and validator, and stops (exit 4, "schema validation failed")
// on any stage key it does not know. Their code is in
// tests/fixtures/stage-frontmatter-2.11.0, made by generate.ts there from
// `git show v2.11.0:...` with comment-only lines left out and characters
// outside printable ASCII written as escapes; the hashes below are that
// output, and the three functions hash the same from v2.8.0 to v2.11.0
// (`generate.ts --hashes <tags>`). Here it runs over every stage file this
// build ships, in both trees. The agent roster check it also makes reads the
// same tree's agents and is not what this checks.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { declaration, hash, MARKER, PINNED_FUNCTIONS } from "../fixtures/stage-frontmatter-2.11.0/generate.ts";
import { parseStageFrontmatter, validateStageFrontmatter } from "../fixtures/stage-frontmatter-2.11.0/stage-frontmatter.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "stage-frontmatter-2.11.0", "stage-frontmatter.ts");
// sha256 of generate.ts's output from v2.11.0, below its marker line.
const BODY = "3468db30d70c1767fdba19a7c48584b279ad5ebc336a9538a09691f8b63bc54f";
// The same on v2.8.0, 2.8.1, 2.8.2, 2.9.0, 2.10.0 and 2.11.0.
const FUNCTIONS: Record<string, string> = {
  parseStageFrontmatter: "3c756f8dbbb0bdb781ec85d3f2a05cc256224dc65891521807fe0d04d01086a1",
  objectListField: "dea46ea9f17f5a3cb36e651772124fa1661ef494345b85c5ee6c39bd751e6c1c",
  validateStageFrontmatter: "118edde754ba9d4430f6b10f6afdd32fec72cbebe824494130be36a156e561a1",
};
const TREES = ["dist", "dist-release"] as const;

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

// The stage files those releases compile: <harness dir>/aidlc-common/stages/<phase>/<slug>.md.
function stageFiles(stagesRoot: string): string[] {
  return readdirSync(stagesRoot, { withFileTypes: true })
    .filter((phase) => phase.isDirectory())
    .flatMap((phase) =>
      readdirSync(join(stagesRoot, phase.name))
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => join(stagesRoot, phase.name, name))
    );
}

describe("a refresh run by a 2.8.0 to 2.11.0 tool compiles this release's stage files", () => {
  test("the copied parser and validator are those releases' own", () => {
    const fixture = read(FIXTURE);
    const at = fixture.indexOf(`${MARKER}\n`);
    expect(at).toBeGreaterThan(0);
    expect(hash(fixture.slice(at + MARKER.length + 1))).toBe(BODY);
    expect(PINNED_FUNCTIONS.map((name) => [name, hash(declaration(fixture, name))]))
      .toEqual(Object.entries(FUNCTIONS));
  });

  for (const tree of TREES) {
    test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
      `${tree} %s: every stage file passes their parser and validator`,
      (name, harness) => {
        const stagesRoot = join(REPO_ROOT, tree, name, harness.manifest.harnessDir, "aidlc-common", "stages");
        expect(existsSync(stagesRoot), stagesRoot).toBe(true);
        const files = stageFiles(stagesRoot);
        expect(files.length).toBeGreaterThan(30);
        const refused = files.flatMap((file) => {
          const result = validateStageFrontmatter(parseStageFrontmatter(read(file)));
          return result.valid ? [] : [`${file.slice(stagesRoot.length + 1)}: ${result.errors.join("; ")}`];
        });
        expect(refused).toEqual([]);
      },
    );
  }
});
