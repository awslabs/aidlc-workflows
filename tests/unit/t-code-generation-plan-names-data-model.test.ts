// covers: stage:code-generation, file:aidlc-common/stages/construction/code-generation.md, file:agents/aidlc-developer-agent.md, file:knowledge/aidlc-developer-agent/code-generation-guide.md
//
// A Code Generation plan names every data-model element it creates or changes
// (#3455). A plan could say "schema changes" as one step, the Summary the
// person approves showed no element, and the developer agent could add an
// object or field that no requirement asked for without anyone seeing it
// before deployment; on a platform where a schema change is shared and hard
// to undo, that was found after the fact. The stage now has the plan name
// each element with what asks for it, keeps the ones nothing asks for under
// `## Assumptions`, shows them on the Summary's `Adds:` line the engine puts
// in the plan-approval question, and tells the developer agent to create only
// what the approved plan names, taking a mid-build need through the plan
// first so the after-approval rules see it. No new question, sensor or engine
// path: the existing Plan Approval is where the person decides.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const STAGE = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "stages", "construction", "code-generation.md"), "utf-8");
const AGENT = readFileSync(join(REPO_ROOT, "core", "agents", "aidlc-developer-agent.md"), "utf-8");
const GUIDE = readFileSync(join(REPO_ROOT, "core", "knowledge", "aidlc-developer-agent", "code-generation-guide.md"), "utf-8");

// One stage section, its line wraps folded, so a sentence is matched as read.
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n### /);
  return (next < 0 ? rest : rest.slice(0, next)).replace(/\s+/g, " ");
}

describe("a Code Generation plan names the data-model elements it adds (#3455)", () => {
  test("Step 2 has the plan name each element with what asks for it, and keep the rest under Assumptions", () => {
    const planning = section(STAGE, "### Step 2: PART 1 — Planning");
    expect(planning).toContain("Data-model elements are named, never implied.");
    expect(planning).toContain("object, entity, table, field or column");
    expect(planning).toContain("custom object or custom field");
    expect(planning).toContain("requirement, acceptance criterion, business rule or design element that asks for it");
    expect(planning).toContain("put it under a `## Assumptions` section of the plan");
    expect(planning).toContain("never in a step alone");
  });

  test("the Summary the person sees carries an Adds line for those elements", () => {
    const planning = section(STAGE, "### Step 2: PART 1 — Planning");
    expect(planning).toContain("`## Summary` section of four lines");
    expect(planning).toContain("- Adds: <the data-model elements no requirement asks for");
    expect(planning).toContain('"nothing beyond the requirements"');
    const raw = STAGE.slice(STAGE.indexOf("```\n## Summary"));
    const fence = raw.slice(0, raw.indexOf("```", 3));
    const labels = fence.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2, line.indexOf(":")));
    expect(labels).toEqual(["Builds", "Touches", "Tests", "Adds"]);
  });

  test("the developer agent is told to create only what the approved plan names, through the plan first", () => {
    const generation = section(STAGE, "### Step 4: PART 2 — Generation");
    expect(generation).toContain("are the ones the approved plan names");
    expect(generation).toContain("goes into the plan first");
    expect(generation).toContain("Step 3's after-approval rules decide what the person sees");
    expect(generation).toContain("never adds an object, table, field or column the plan does not name");
    expect(AGENT).toContain("create only the elements the approved plan names");
    expect(GUIDE).toContain("For each entity the approved plan names");
  });

  test("the stage adds no question of its own: the person decides at Plan Approval", () => {
    const planning = section(STAGE, "### Step 2: PART 1 — Planning");
    // The one place the person learns of such an element is the question the
    // engine already asks; the stage never asks before the plan is written.
    expect(planning).toContain("when the engine asks for approval");
    expect(planning).not.toMatch(/ask the person (before|whether)/i);
  });
});
