// covers: file:scripts/package.ts, file:scripts/earlier-release-regions.ts
//
// A project set up on 2.8.0 to 2.11.0 refreshes to this release with its own
// tool: `bun <dir>/tools/aidlc.ts config --from <runtime>` on a copy, and
// `aidlc config` on a native team clone whose teammate pinned this release.
// That tool writes the scope and stage tables into this release's /aidlc skill
// with its own code, and stops (exit 4) when the skill has no place for them.
// The code is those releases' own, copied byte for byte into
// tests/fixtures/region-merge-2.11.0 (the hashes below prove it), and it runs
// here over each skill this build ships, in both trees.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import { refreshSkill, SCOPE_TABLE, STAGE_TABLE } from "../fixtures/region-merge-2.11.0/region-merge.ts";

const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "region-merge-2.11.0", "region-merge.ts");
// sha256 of each part as `git show v2.8.0:core/tools/aidlc-init.ts` through
// v2.11.0 print it, the same on every tag.
const MERGE_FUNCTION = "203e05ef0b5f765c4890990b138ce0e3e5e3d83e7e24f61236c56a81f56b7341";
const SKILL_CHOICE = "53cd50cb821a785395379c5ba11a101492f3130c0369414d5ecc691ef41cbb6e";
const TREES = ["dist", "dist-release"] as const;

const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to + end.length);
}

// The skill those releases merge, as they pick it in the tree they refresh from.
function skillTheyRead(tree: string, harnessDir: string): string | null {
  const own = join(tree, harnessDir, "skills", "aidlc", "SKILL.md");
  if (existsSync(own)) return own;
  const agents = join(tree, ".agents", "skills", "aidlc", "SKILL.md");
  return existsSync(agents) ? agents : null;
}

describe("a refresh run by a 2.8.0 to 2.11.0 tool takes this release's /aidlc skill", () => {
  test("the copied merge is those releases' own, byte for byte", () => {
    const fixture = read(FIXTURE);
    expect(sha256(between(fixture, "function replaceGeneratedRegion(", "\n}\n"))).toBe(MERGE_FUNCTION);
    expect(sha256(between(
      fixture,
      "    const skillPath = existsSync(join(stagedHarness",
      "      writeFileSync(skillPath, generated);\n    }\n",
    ))).toBe(SKILL_CHOICE);
  });

  test("they read the skill of every harness but Copilot, whose skill is in .github/skills", () => {
    const readBy = HARNESS_MATRIX
      .filter((harness) => skillTheyRead(harness.distRoot, harness.manifest.harnessDir) !== null)
      .map((harness) => harness.name);
    expect(readBy).toEqual(["claude", "codex", "cursor", "kiro", "kiro-ide", "opencode"]);
  });

  for (const tree of TREES) {
    test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
      `${tree} %s: their merge passes and adds only the scope table, after the skill's own text`,
      (name, harness) => {
        const source = join(REPO_ROOT, tree, name);
        const shippedPath = skillTheyRead(source, harness.manifest.harnessDir);
        if (shippedPath === null) return;
        const root = mkdtempSync(join(tmpdir(), "aidlc-t-earlier-refresh-"));
        temporary.push(root);
        const staged = join(root, relative(source, shippedPath));
        mkdirSync(dirname(staged), { recursive: true });
        cpSync(shippedPath, staged);
        const shipped = read(staged);

        expect(() => refreshSkill(root, join(root, harness.manifest.harnessDir))).not.toThrow();

        const merged = read(staged);
        expect(merged).not.toContain(STAGE_TABLE);
        expect(merged.split(SCOPE_TABLE)).toHaveLength(2);
        const place = merged.indexOf("<!-- BEGIN: compiled scope grid via ");
        expect(merged.slice(0, place)).toBe(shipped.slice(0, place));
        expect(merged.endsWith(`${SCOPE_TABLE}\n\n<!-- END: compiled scope grid -->\n`)).toBe(true);
      },
    );
  }
});
