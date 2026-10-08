// covers: protocol:reuse-choice-recommended
//
// The question the agent asks when a stage's earlier work is already there, or
// missing, puts the option it recommends first, marked "(Recommended)" with the
// reason, so the person sees the same kind of choice every time.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

function section(file: string, heading: string): string {
  const text = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "protocols", file), "utf-8");
  const start = text.indexOf(heading);
  expect(start, `${file} has ${heading}`).toBeGreaterThan(-1);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, " ");
}

describe("re-use and missing-work choices name the recommended option first", () => {
  test.each([
    ["stage-protocol.md", "### Artifact Re-use"],
    ["stage-protocol-recovery.md", "### Missing artifact recovery"],
  ])("%s %s", (file, heading) => {
    const body = section(file, heading);
    expect(body).toContain('the option you recommend first, its label ending in "(Recommended)" and its description saying why');
  });

  test("a missing document the last commit still has recommends restoring it", () => {
    expect(section("stage-protocol-recovery.md", "### Missing artifact recovery"))
      .toContain("restore them from the last commit when it still has them, which is the one to recommend then");
  });
});
