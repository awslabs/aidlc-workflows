// t-review-granularity — the review-granularity dial (stage | phase): WHERE
// agent review passes run, while t266's review class stays WHETHER and HOW.
//
// Pins the seams the feature spans:
//   1. Resolution: resolveReviewGranularity is state override > scope
//      frontmatter > "stage"; an invalid state value is ignored.
//   2. Grouping: phaseReviewRole defers an ideation/inception review to its
//      reviewer's last in-plan stage of the phase (the anchor) and leaves
//      everything else — stage granularity, construction/per-unit stages,
//      single-member groups, capped-to-none scopes — exactly as it was.
//   3. Plan sensitivity: skipped stages leave the group, moving the anchor;
//      only completed earlier stages are covered.
//   4. CLI: config-change --review-granularity writes the Review Granularity
//      state field, audits REVIEW_GRANULARITY_CHANGED, and says the change in
//      plain words; an unknown value is refused before mutation.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readAllAuditShards,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  phaseReviewRole,
  resolveReviewGranularity,
} from "../../dist/claude/.claude/tools/aidlc-review-granularity.ts";
import {
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ROOT = join(import.meta.dir, "..", "..");
const UTILITY = join(ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const tempDirs: string[] = [];

resetAidlcEnv();
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function runUtility(project: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [UTILITY, ...args, "--project-dir", project],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const set = (granularity: string) => `- **Review Granularity**: ${granularity}\n`;

// A graph node by slug, as phaseReviewRole's callers hand it one.
type Stage = Parameters<typeof phaseReviewRole>[0];
const node = (slug: string, overrides: Partial<Stage> = {}): Stage => ({
  slug,
  name: slug,
  phase: "inception",
  reviewer: "aidlc-product-lead-agent",
  review_class: "advisory",
  ...overrides,
});

// An mvp state mid-inception under phase granularity: ideation reviewed
// stages completed, inception under way. Checkbox lines are what
// parseCheckboxes reads; the Review Granularity field is the override.
const MVP_PHASE_STATE = `# AI-DLC State Tracking

## Scope Configuration
- **Scope**: mvp
${set("phase")}
## Stage Progress

### IDEATION PHASE
- [x] intent-capture — EXECUTE
- [x] feasibility — EXECUTE
- [x] scope-definition — EXECUTE
- [x] rough-mockups — EXECUTE

### INCEPTION PHASE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [-] refined-mockups — EXECUTE
- [ ] domain-design — EXECUTE
- [ ] units-generation — EXECUTE
- [ ] contract-design — EXECUTE
- [ ] delivery-planning — EXECUTE
`;

describe("resolveReviewGranularity", () => {
  test("defaults to stage with no scope value and no override", () => {
    expect(resolveReviewGranularity("mvp")).toBe("stage");
    expect(resolveReviewGranularity("mvp", "")).toBe("stage");
    expect(resolveReviewGranularity(null, null)).toBe("stage");
  });

  test("state override wins and an invalid value is ignored", () => {
    expect(resolveReviewGranularity("mvp", set("phase"))).toBe("phase");
    expect(resolveReviewGranularity("mvp", set("stage"))).toBe("stage");
    expect(resolveReviewGranularity("mvp", set("weekly"))).toBe("stage");
    expect(resolveReviewGranularity("mvp", set(""))).toBe("stage");
  });
});

describe("phaseReviewRole", () => {
  test("stage granularity leaves every stage as declared", () => {
    for (const slug of ["intent-capture", "requirements-analysis", "contract-design"]) {
      expect(phaseReviewRole(node(slug), "mvp", "").role).toBe("stage");
      expect(phaseReviewRole(node(slug), "mvp", null).role).toBe("stage");
    }
  });

  test("phase granularity defers non-anchor stages to their reviewer's anchor", () => {
    // Ideation product-lead group: intent-capture -> rough-mockups (anchor).
    expect(
      phaseReviewRole(node("intent-capture", { phase: "ideation" }), "mvp", MVP_PHASE_STATE),
    ).toEqual({ role: "deferred", anchor: "rough-mockups" });
    // Inception product-lead group: requirements-analysis, user-stories ->
    // refined-mockups (anchor).
    expect(
      phaseReviewRole(node("requirements-analysis"), "mvp", MVP_PHASE_STATE),
    ).toEqual({ role: "deferred", anchor: "refined-mockups" });
    expect(
      phaseReviewRole(node("user-stories"), "mvp", MVP_PHASE_STATE),
    ).toEqual({ role: "deferred", anchor: "refined-mockups" });
    // Inception architecture group: domain-design, units-generation ->
    // contract-design (anchor), leaving reviewerless delivery-planning alone.
    expect(
      phaseReviewRole(
        node("domain-design", { reviewer: "aidlc-architecture-reviewer-agent" }),
        "mvp",
        MVP_PHASE_STATE,
      ),
    ).toEqual({ role: "deferred", anchor: "contract-design" });
  });

  test("the anchor covers its group's completed earlier stages only", () => {
    const anchor = phaseReviewRole(node("refined-mockups"), "mvp", MVP_PHASE_STATE);
    expect(anchor.role).toBe("anchor");
    if (anchor.role === "anchor") {
      expect(anchor.covers.map((stage) => stage.slug)).toEqual([
        "requirements-analysis",
        "user-stories",
      ]);
    }
    // The architecture anchor has no completed group members yet: covers empty.
    const archAnchor = phaseReviewRole(
      node("contract-design", { reviewer: "aidlc-architecture-reviewer-agent" }),
      "mvp",
      MVP_PHASE_STATE,
    );
    expect(archAnchor.role).toBe("anchor");
    if (archAnchor.role === "anchor") expect(archAnchor.covers).toEqual([]);
  });

  test("a skipped stage leaves the group and moves the anchor", () => {
    const skipped = MVP_PHASE_STATE.replace(
      "- [-] refined-mockups — EXECUTE",
      "- [S] refined-mockups — EXECUTE",
    );
    expect(
      phaseReviewRole(node("requirements-analysis"), "mvp", skipped),
    ).toEqual({ role: "deferred", anchor: "user-stories" });
    const anchor = phaseReviewRole(node("user-stories"), "mvp", skipped);
    expect(anchor.role).toBe("anchor");
    if (anchor.role === "anchor") {
      expect(anchor.covers.map((stage) => stage.slug)).toEqual(["requirements-analysis"]);
    }
  });

  test("construction, per-unit stages, capped scopes, and single-member groups stay per stage", () => {
    // Construction is never grouped, per-unit or not.
    expect(
      phaseReviewRole(
        node("functional-design", {
          phase: "construction",
          reviewer: "aidlc-architecture-reviewer-agent",
          review_class: "adversarial",
          for_each: "unit-of-work",
        }),
        "mvp",
        MVP_PHASE_STATE,
      ).role,
    ).toBe("stage");
    // review_cap: none (express) silences reviews entirely; nothing to group.
    expect(
      phaseReviewRole(node("requirements-analysis"), "express", set("phase")).role,
    ).toBe("stage");
    // A plan that runs only one of the reviewer's stages has nothing to group.
    const loneProductLead = MVP_PHASE_STATE
      .replace("- [x] user-stories — EXECUTE", "- [S] user-stories — EXECUTE")
      .replace("- [-] refined-mockups — EXECUTE", "- [S] refined-mockups — EXECUTE");
    expect(
      phaseReviewRole(node("requirements-analysis"), "mvp", loneProductLead).role,
    ).toBe("stage");
  });
});

describe("config-change --review-granularity", () => {
  function projectWithState(): string {
    const project = createTestProject();
    tempDirs.push(project);
    seedAidlcMemory(project);
    seedStateFile(project, "state-mid-inception.md");
    return project;
  }

  test("writes the state field, audits the change, and says it in plain words", () => {
    const project = projectWithState();
    const result = runUtility(project, ["config-change", "--review-granularity", "phase"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("grouped per reviewer late in each phase");
    const state = readFileSync(stateFilePath(project), "utf-8");
    expect(state).toContain("- **Review Granularity**: phase");
    const audit = readAllAuditShards(project);
    expect(audit).toContain("REVIEW_GRANULARITY_CHANGED");
    expect(audit).toContain("**New Granularity**: phase");
  });

  test("setting the scope default back clears the override", () => {
    const project = projectWithState();
    expect(runUtility(project, ["config-change", "--review-granularity", "phase"]).status).toBe(0);
    const back = runUtility(project, ["config-change", "--review-granularity", "stage"]);
    expect(back.status).toBe(0);
    const state = readFileSync(stateFilePath(project), "utf-8");
    expect(state).toContain("- **Review Granularity**:");
    expect(state).not.toContain("- **Review Granularity**: stage");
    expect(state).not.toContain("- **Review Granularity**: phase");
  });

  test("refuses an unknown value before mutation", () => {
    const project = projectWithState();
    const result = runUtility(project, ["config-change", "--review-granularity", "weekly"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Valid: stage, phase");
    const state = readFileSync(stateFilePath(project), "utf-8");
    expect(state).not.toContain("- **Review Granularity**: weekly");
  });
});
