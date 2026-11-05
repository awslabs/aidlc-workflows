// covers: scope:infra, stage:construction/infrastructure-design, stage:operation/environment-provisioning

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";

const GRID = join(AIDLC_SRC, "tools", "data", "scope-grid.json");
const STAGES = join(REPO_ROOT, "core", "aidlc-common", "stages");

type ScopeGrid = Record<string, { stages: Record<string, string> }>;

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const rest = markdown.slice(start + heading.length + 3);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

const grid = JSON.parse(readFileSync(GRID, "utf-8")) as ScopeGrid;
const provisionsWithoutGeneration = Object.entries(grid)
  .filter(([, entry]) => entry.stages["environment-provisioning"] === "EXECUTE")
  .filter(([, entry]) => entry.stages["code-generation"] !== "EXECUTE")
  .map(([scope]) => scope)
  .sort();

describe("a scope that provisions environments names the stage that writes the IaC", () => {
  test("the scope grid still has one, so the invariant is live", () => {
    expect(provisionsWithoutGeneration.length).toBeGreaterThan(0);
  });

  for (const scope of provisionsWithoutGeneration) {
    test(`${scope}: its scope note names infrastructure-design as the IaC author and its gate as the approval`, () => {
      const note = readFileSync(join(REPO_ROOT, "core", "scopes", `aidlc-${scope}.md`), "utf-8");
      expect(note).toMatch(/infrastructure-design writes the IaC/);
      expect(note).toMatch(/completion\s+gate is where that IaC is approved/);
    });
  }

  test("infrastructure-design writes the IaC itself where code-generation is skipped", () => {
    const constraints = section(
      readFileSync(join(STAGES, "construction", "infrastructure-design.md"), "utf-8"),
      "Constraints",
    );
    expect(constraints).toMatch(/belong in code-generation/);
    expect(constraints).toMatch(/The one exception is `infra`/);
    expect(constraints).toMatch(/this stage writes it itself/);
    expect(constraints).toMatch(/completion gate is the approval that precedes environment-provisioning/);
  });

  test("infrastructure-design Step 5 sends the infra IaC to the workspace, not the record", () => {
    const steps = section(
      readFileSync(join(STAGES, "construction", "infrastructure-design.md"), "utf-8"),
      "Steps",
    );
    expect(steps).toMatch(/under `infra`, the IaC itself goes into the workspace instead/);
  });
});
