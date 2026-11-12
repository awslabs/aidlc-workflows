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
// in the plan-approval question, and has the developer agent take an element
// nothing upstream asks for through the plan first, so the after-approval
// rules see it. No new question, sensor or engine path: the existing Plan
// Approval is where the person decides.
//
// The Adds line is there only when the plan adds such an element (a plan that
// adds nothing reads as before), and it counts first, because the question
// cuts each Summary line at 200 characters. An Assumptions entry is a plain
// line, never a checkbox: the engine counts checkbox lines as plan steps for
// the start line, the resume point and the change notice. One found mid-build
// gets a step of its own, so the change notice names it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const STAGE = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "stages", "construction", "code-generation.md"), "utf-8");
const AGENT = readFileSync(join(REPO_ROOT, "core", "agents", "aidlc-developer-agent.md"), "utf-8");
const GUIDE = readFileSync(join(REPO_ROOT, "core", "knowledge", "aidlc-developer-agent", "code-generation-guide.md"), "utf-8");
const DOCS = readFileSync(join(REPO_ROOT, "docs", "reference", "04-stages", "construction.md"), "utf-8");

// One stage section, its line wraps folded, so a sentence is matched as read.
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n### /);
  return (next < 0 ? rest : rest.slice(0, next)).replace(/\s+/g, " ");
}

// The labels of a fenced block's list lines, in order.
function fenceLabels(text: string, opening: string): string[] {
  const at = text.indexOf(opening);
  expect(at).toBeGreaterThanOrEqual(0);
  const fence = text.slice(at, text.indexOf("```", at + 3));
  return fence.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2, line.indexOf(":")));
}

const PLANNING = section(STAGE, "### Step 2: PART 1");
const GENERATION = section(STAGE, "### Step 4: PART 2");

describe("a Code Generation plan names the data-model elements it adds (#3455)", () => {
  test("Step 2 has the plan name each element with what asks for it, and keep the rest under Assumptions", () => {
    expect(PLANNING).toContain("Data-model elements are named, never implied.");
    expect(PLANNING).toContain("object, entity, table, field or column");
    expect(PLANNING).toContain("requirement, acceptance criterion, business rule or design element that asks for it");
    expect(PLANNING).toContain("put it under a `## Assumptions` section of the plan");
    // A technical column is a key, an index or its created or updated time,
    // never a business date such as when a subscriber was welcomed.
    expect(PLANNING).toContain("(a key, an index, its created or updated time)");
  });

  test("an Assumptions entry is a plain line beside the step that adds it, never a step of its own there", () => {
    expect(PLANNING).toContain("one line each, not a checkbox (the checkbox is on the step that adds it)");
    expect(PLANNING).toContain("never only in a step");
    expect(GENERATION).not.toContain("as its own step under `## Assumptions`");
  });

  test("the Summary keeps its three lines, and the Adds line is added only when there is an element", () => {
    expect(PLANNING).toContain("`## Summary` section of three lines, one line each");
    expect(fenceLabels(STAGE, "```\n## Summary")).toEqual(["Builds", "Touches", "Tests"]);
    expect(PLANNING).toContain("When the plan adds an element nothing upstream asks for, the Summary gets one more line, the count first:");
    expect(fenceLabels(STAGE, "```\n- Adds:")).toEqual(["Adds"]);
    expect(STAGE).toContain("- Adds: <how many data-model elements no requirement asks for, then their names>; see Assumptions");
    // A plan that adds nothing says nothing: no line and no section on every
    // plan (a live run wrote "## Assumptions" with "None." when this was unsaid).
    for (const text of [STAGE, DOCS]) expect(text).not.toContain("nothing beyond the requirements");
    expect(PLANNING).toContain("A plan that adds no such element has no `## Assumptions` section and no `Adds:` line.");
  });

  test("the developer agent takes an element nothing upstream asks for through the plan first, as a step of its own", () => {
    expect(GENERATION).toContain("that nothing upstream or in the approved plan asks for is built only once the plan names it");
    expect(GENERATION).toContain("a key, index or created or updated time that a requested element needs is part of that element");
    expect(GENERATION).toContain("goes into the plan first, as a step of its own");
    expect(GENERATION).toContain("Step 3's after-approval rules decide what the person sees");
    // The agent and its guide keep Step 4's exemption: an element the approved
    // plan already names is built as approved, so a plan approved before this
    // rule is never edited for it.
    expect(AGENT).toContain("an element nothing upstream asks for and the approved plan does not name goes into the plan before the code");
    expect(GUIDE).toContain("For each entity something upstream asks for or the approved plan names (any other goes into the plan first");
  });

  test("the stage adds no question of its own: the person decides at Plan Approval", () => {
    // The one place the person learns of such an element is the question the
    // engine already asks; the stage never asks before the plan is written.
    expect(PLANNING).toContain("when the engine asks for approval");
    expect(PLANNING).not.toMatch(/ask the person (before|whether)/i);
  });
});
