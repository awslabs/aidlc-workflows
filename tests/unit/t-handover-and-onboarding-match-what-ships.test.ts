// covers: file:skills/aidlc-outcomes-pack/SKILL.md
//
// Two files a person opens say what AI-DLC does:
//   - the handover the outcomes pack writes (OUTCOMES.md) never tells the team
//     to delete the state file or the question files, or to keep the record's
//     per-clone event files out of the repository: the onboarding says the
//     whole record is committed, and the state file is what AI-DLC reads to
//     pick work up again;
//   - an onboarding file or harness guide that lists the stages handed to a
//     separate agent lists the ones the shipped stage graph runs that way
//     (Cursor and opencode said two, where the graph has four).
// Every shipped tree is read, with the stage list from its own shipped graph.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

type GraphStage = { number: string; mode: string };

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

function markdownFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (/\.(?:mdc?|toml)$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("t-handover-and-onboarding-match-what-ships", () => {
  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: the outcomes pack keeps the record the onboarding says is committed",
    (_name, harness) => {
      const skill = read(join(harness.skillsRoot, "aidlc-outcomes-pack", "SKILL.md"));
      expect(skill).toContain("## 6. What to Commit");
      expect(skill).not.toMatch(/aidlc-state\.md` \| Discard/);
      expect(skill).not.toMatch(/question files \| Discard/i);
      expect(skill).not.toContain("do NOT commit");
    },
  );

  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: a list of the delegated stages names the ones the graph delegates",
    (_name, harness) => {
      const graph = JSON.parse(read(join(harness.engineRoot, "tools", "data", "stage-graph.json"))) as GraphStage[];
      const delegated = graph.filter((stage) => stage.mode !== "inline").map((stage) => stage.number).sort();
      expect(delegated.length).toBeGreaterThan(0);
      const found: string[] = [];
      for (const file of markdownFiles(harness.distRoot)) {
        for (const match of read(file).matchAll(/delegated stages \(([^)]*)\)/g)) {
          const named = [...match[1].matchAll(/\b\d+\.\d+\b/g)].map((n) => n[0]).sort();
          if (named.join(",") !== delegated.join(",")) found.push(`${relative(harness.distRoot, file)}: (${match[1]})`);
        }
      }
      expect(found).toEqual([]);
    },
  );

  test("the Cursor and opencode guides name no count of delegated stages the graph does not have", () => {
    for (const guide of ["cursor.md", "opencode.md"]) {
      const text = read(join(REPO_ROOT, "docs", "guide", "harnesses", guide)).replace(/\s+/g, " ");
      expect(text, guide).not.toContain("two subagent stages");
      expect(text, guide).not.toContain("two delegated stages");
    }
  });
});
