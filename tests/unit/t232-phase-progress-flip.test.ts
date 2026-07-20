// covers: subcommand:aidlc-state:advance, subcommand:aidlc-state:finalize, subcommand:aidlc-state:complete-workflow, subcommand:aidlc-jump:execute, subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:recompose, subcommand:aidlc-utility:intent-birth, function:setPhaseProgress
//
// t232 - the state file's `## Phase Progress` rows advance with the workflow.
//
// Regression pin for the write-once drift: intent-birth seeded the section and
// no code ever flipped a row afterwards, so a reader saw `- **Ideation**:
// Pending` above a fully-checked Ideation checkbox block. The section is
// display-only (routing reads Lifecycle Phase + the checkboxes; --status
// recomputes its own block), so every assertion here is about the rendered
// state file, not routing.
//
// The contract under test (setPhaseProgress in aidlc-lib.ts + its call sites):
//   - intent-birth seeds Initialization=Verified (birth completes every init
//     stage), the first post-init stage's phase Active, later phases
//     Pending/Skipped by EXECUTE presence.
//   - advance: non-boundary leaves the section byte-identical; a boundary
//     flips completed->Verified and entered->Active in the same write.
//   - finalize: same boundary flip; on the final stage the phase -> Verified.
//   - complete-workflow: final phase -> Verified.
//   - jump forward: source phase -> Verified, jumped-over phases -> Skipped,
//     target -> Active. jump backward: reset phases with EXECUTE stages ->
//     Pending, target -> Active.
//   - scope-change / recompose: re-derive only Pending/Skipped rows against
//     the new plan; Verified/Active rows are history and stay untouched.
//   - a state file WITHOUT the section still transitions cleanly (the flip is
//     a silent no-op - display must never fail a state machine move).
//
// Mechanism: cli - every case spawns the REAL shipped tools (dist/claude) via
// spawnSync, asserting exit code + the on-disk aidlc-state.md, the same
// process boundary t17/t39 pin. Deterministic: no LLM, no live driver.
//
// FIXTURE DISCIPLINE: live-birth cases use a fresh createTestProject() temp
// dir per describe (birth populates state itself, as in t39); the seeded
// cases copy fixtures via seedStateFile + sedReplaceInFile. Cleanup in
// afterAll. Nothing is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seededStateFile,
  seedStateFile,
  sedReplaceInFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOLS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "tools",
);
const STATE_TOOL = join(TOOLS_DIR, "aidlc-state.ts");
const JUMP_TOOL = join(TOOLS_DIR, "aidlc-jump.ts");
const UTILITY_TOOL = join(TOOLS_DIR, "aidlc-utility.ts");
const LOG_TOOL = join(TOOLS_DIR, "aidlc-log.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface RunResult {
  rc: number;
  combined: string;
}

function run(tool: string, proj: string, args: string[]): RunResult {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
    env: {
      ...process.env,
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    },
  });
  return {
    rc: res.status ?? -1,
    combined: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

// Resolve the live state file: the born intent's record when a birth ran,
// else the seeded default record (both under aidlc/spaces/...). Mirrors
// t17's recordDirOf, trimmed to the two shapes this file produces.
function statePath(proj: string): string {
  const intentsDir = join(proj, "aidlc", "spaces", "default", "intents");
  try {
    const rec = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
    if (rec) return join(intentsDir, rec, "aidlc-state.md");
  } catch {
    // no birth ran - fall through to the seeded record
  }
  return seededStateFile(proj);
}

/** One row's status, or "(not found)" - the t39 helper's regex verbatim. */
function rowStatus(proj: string, phaseCap: string): string {
  const re = new RegExp(`^- \\*\\*${phaseCap}\\*\\*: (\\w+)$`);
  for (const line of readFileSync(statePath(proj), "utf-8").split("\n")) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return "(not found)";
}

/** The whole `## Phase Progress` section, for byte-identity assertions. */
function phaseProgressSection(proj: string): string {
  const m = readFileSync(statePath(proj), "utf-8").match(
    /## Phase Progress\n[\s\S]*?(?=\n## )/,
  );
  return m ? m[0] : "(no section)";
}

function birth(proj: string, scope: string): RunResult {
  return run(UTILITY_TOOL, proj, ["intent-birth", "--scope", scope]);
}

function recordRequiredReview(proj: string, slug: string): void {
  if (slug !== "rough-mockups") return;
  const reviewed = run(LOG_TOOL, proj, [
    "review",
    "--stage",
    slug,
    "--reviewer",
    "aidlc-product-lead-agent",
    "--iteration",
    "1",
    "--verdict",
    "READY",
  ]);
  if (reviewed.rc !== 0) {
    throw new Error(`failed to record ${slug} review: ${reviewed.combined}`);
  }
}

function advance(proj: string, slug: string): RunResult {
  recordRequiredReview(proj, slug);
  return run(STATE_TOOL, proj, ["advance", slug]);
}

// Feature scope, greenfield: birth lands on intent-capture; the whole
// Ideation ladder then approval-handoff -> practices-discovery crosses the
// ideation->inception boundary (greenfield SKIPs reverse-engineering).
const IDEATION_LADDER = [
  "intent-capture",
  "market-research",
  "feasibility",
  "scope-definition",
  "team-formation",
  "rough-mockups",
] as const;

describe("t232 Phase Progress - birth seed", () => {
  test("feature scope: Verified init, Active first post-init phase, Pending rest", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    expect(birth(proj, "feature").rc).toBe(0);
    expect(rowStatus(proj, "Initialization")).toBe("Verified");
    expect(rowStatus(proj, "Ideation")).toBe("Active");
    expect(rowStatus(proj, "Inception")).toBe("Pending");
    expect(rowStatus(proj, "Construction")).toBe("Pending");
    expect(rowStatus(proj, "Operation")).toBe("Pending");
  });

  test("bugfix scope: excluded phases Skipped, first post-init phase Active", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    expect(birth(proj, "bugfix").rc).toBe(0);
    expect(rowStatus(proj, "Initialization")).toBe("Verified");
    expect(rowStatus(proj, "Ideation")).toBe("Skipped");
    expect(rowStatus(proj, "Inception")).toBe("Active");
    expect(rowStatus(proj, "Operation")).toBe("Skipped");
  });
});

describe("t232 Phase Progress - advance", () => {
  const proj = createTestProject();
  tempDirs.push(proj);
  const born = birth(proj, "feature");

  test("non-boundary advance leaves the section byte-identical", () => {
    expect(born.rc).toBe(0);
    const before = phaseProgressSection(proj);
    expect(advance(proj, "intent-capture").rc).toBe(0);
    expect(phaseProgressSection(proj)).toBe(before);
  });

  test("boundary advance flips completed->Verified, entered->Active", () => {
    for (const slug of IDEATION_LADDER.slice(1)) {
      expect(advance(proj, slug).rc).toBe(0);
    }
    const res = run(STATE_TOOL, proj, ["advance", "approval-handoff"]);
    expect(res.rc).toBe(0);
    expect(res.combined).toContain('"phase_boundary":true');
    expect(rowStatus(proj, "Ideation")).toBe("Verified");
    expect(rowStatus(proj, "Inception")).toBe("Active");
    // Untouched rows keep their seed.
    expect(rowStatus(proj, "Construction")).toBe("Pending");
  });
});

describe("t232 Phase Progress - finalize", () => {
  test("boundary finalize flips completed->Verified, entered->Active", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    expect(birth(proj, "feature").rc).toBe(0);
    for (const slug of IDEATION_LADDER) {
      expect(advance(proj, slug).rc).toBe(0);
    }
    expect(run(STATE_TOOL, proj, ["finalize", "approval-handoff"]).rc).toBe(0);
    expect(rowStatus(proj, "Ideation")).toBe("Verified");
    expect(rowStatus(proj, "Inception")).toBe("Active");
  });

  test("final-stage finalize flips the last phase to Verified", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedStateFile(proj, "state-final-stage.md");
    // The fixture pre-dates the flip in spirit: force the Operation row back
    // to Active so the transition under test is observable.
    sedReplaceInFile(
      statePath(proj),
      "- **Operation**: Verified",
      "- **Operation**: Active",
    );
    expect(run(STATE_TOOL, proj, ["finalize", "feedback-optimization"]).rc).toBe(0);
    expect(rowStatus(proj, "Operation")).toBe("Verified");
  });
});

describe("t232 Phase Progress - jump + complete-workflow", () => {
  const proj = createTestProject();
  tempDirs.push(proj);
  const born = birth(proj, "feature");

  test("forward jump: source Verified, jumped-over Skipped, target Active", () => {
    expect(born.rc).toBe(0);
    const res = run(JUMP_TOOL, proj, [
      "execute", "--target", "deployment-pipeline", "--direction", "forward",
    ]);
    expect(res.rc).toBe(0);
    expect(rowStatus(proj, "Ideation")).toBe("Verified");
    expect(rowStatus(proj, "Inception")).toBe("Skipped");
    expect(rowStatus(proj, "Construction")).toBe("Skipped");
    expect(rowStatus(proj, "Operation")).toBe("Active");
  });

  test("backward jump: reset phases with EXECUTE stages return to Pending", () => {
    const res = run(JUMP_TOOL, proj, [
      "execute", "--target", "practices-discovery", "--direction", "backward",
    ]);
    expect(res.rc).toBe(0);
    expect(rowStatus(proj, "Inception")).toBe("Active");
    expect(rowStatus(proj, "Construction")).toBe("Pending");
    expect(rowStatus(proj, "Operation")).toBe("Pending");
    // History before the target is not rewritten.
    expect(rowStatus(proj, "Ideation")).toBe("Verified");
  });

  test("complete-workflow flips the final phase to Verified", () => {
    expect(
      run(JUMP_TOOL, proj, [
        "execute", "--target", "feedback-optimization", "--direction", "forward",
      ]).rc,
    ).toBe(0);
    expect(
      run(STATE_TOOL, proj, ["complete-workflow", "feedback-optimization"]).rc,
    ).toBe(0);
    expect(rowStatus(proj, "Operation")).toBe("Verified");
  });
});

describe("t232 Phase Progress - plan re-shaping re-derives unreached rows", () => {
  test("scope-change: newly excluded phase Skipped, history untouched", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    expect(birth(proj, "feature").rc).toBe(0);
    expect(run(UTILITY_TOOL, proj, ["scope-change", "--scope", "bugfix"]).rc).toBe(0);
    expect(rowStatus(proj, "Operation")).toBe("Skipped");
    // The Active/Verified rows record history the plan change cannot rewrite.
    expect(rowStatus(proj, "Initialization")).toBe("Verified");
    expect(rowStatus(proj, "Ideation")).toBe("Active");
  });

  test("recompose: skip-all empties a phase -> Skipped; add-back -> Pending", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    expect(birth(proj, "feature").rc).toBe(0);
    const allOperation =
      "deployment-pipeline,environment-provisioning,deployment-execution," +
      "observability-setup,incident-response,performance-validation," +
      "feedback-optimization";
    expect(run(UTILITY_TOOL, proj, ["recompose", "--skip", allOperation]).rc).toBe(0);
    expect(rowStatus(proj, "Operation")).toBe("Skipped");
    // Add the whole set back - a lone add is refused by the strict validator
    // (its upstream producers would stay skipped, starving its consumes).
    expect(
      run(UTILITY_TOOL, proj, ["recompose", "--add", allOperation]).rc,
    ).toBe(0);
    expect(rowStatus(proj, "Operation")).toBe("Pending");
  });
});

describe("t232 Phase Progress - missing section tolerated", () => {
  test("boundary advance on a state file without the section still exits 0", () => {
    const proj = createTestProject();
    tempDirs.push(proj);
    seedStateFile(proj, "state-mid-ideation.md");
    seedAuditFile(proj);
    // Strip the whole section (an older or hand-edited state file), then
    // drive a boundary transition: the flip must silently no-op, never fail.
    sedReplaceInFile(
      statePath(proj),
      /## Phase Progress\n[\s\S]*?(?=## )/,
      "",
    );
    expect(rowStatus(proj, "Ideation")).toBe("(not found)");
    expect(run(STATE_TOOL, proj, ["set", "Current Stage=approval-handoff"]).rc).toBe(0);
    const res = run(STATE_TOOL, proj, ["advance", "approval-handoff"]);
    expect(res.rc).toBe(0);
    expect(res.combined).toContain('"phase_boundary":true');
    expect(rowStatus(proj, "Ideation")).toBe("(not found)");
  });
});
