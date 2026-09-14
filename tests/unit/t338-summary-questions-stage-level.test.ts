// covers: function:summaryQuestionFiles function:checkSummaryConfirmationEvidence
//
// t338 - under a scope whose approved plan SKIPs units-generation (e.g. infra),
// a per-unit construction stage keeps its artifacts at the STAGE level
// (construction/<slug>/), not under per-unit subdirs. The completion guard
// already consults usesStageLevelPerUnitArtifacts and skips the unit-set
// requirement for this case, but its question-file discovery helper
// (summaryQuestionFiles) did not, so it only looked under
// construction/<unit>/<slug>/, found nothing, and fell through to
// SUMMARY_QUESTIONS_MISSING forever (issue #1105). This pins that the helper
// discovers the stage-level questions file in that mode while leaving the
// per-unit lane (a scope that DOES run units-generation) untouched.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkSummaryConfirmationEvidence,
  loadStageGraphAll,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const STAGE = "nfr-requirements";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function withSummaryGuard<T>(fn: () => T): T {
  const prior = process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  try {
    return fn();
  } finally {
    if (prior === undefined) {
      delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
    } else {
      process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = prior;
    }
  }
}

function stateFor(scope: string, unitsGeneration: "EXECUTE" | "SKIP"): string {
  return `# AI-DLC State Tracking

## Runtime State
- **Project Type**: greenfield
- **Scope**: ${scope}

## Stage Progress
- [x] units-generation \u2014 ${unitsGeneration}
- [-] nfr-requirements \u2014 EXECUTE

## Current Status
- **Current Stage**: nfr-requirements
`;
}

function project(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-construction.md");
  return proj;
}

function stage() {
  return loadStageGraphAll().find((entry) => entry.slug === STAGE)!;
}

function writeStageLevelQuestions(proj: string): void {
  const dir = join(seededRecordDir(proj), "construction", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${STAGE}-questions.md`),
    [
      "# NFR Questions",
      "",
      "## Consolidated Summary Confirmation",
      "",
      "- [Answer]: Looks correct",
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("t338 stage-level per-unit summary questions discovery", () => {
  test("infra scope discovers a stage-level questions file (not SUMMARY_QUESTIONS_MISSING)", () => {
    const proj = project();
    writeStageLevelQuestions(proj);
    const evidence = withSummaryGuard(() =>
      checkSummaryConfirmationEvidence(proj, stage(), {
        stateContent: stateFor("infra", "SKIP"),
      }),
    );
    // The questions file is now discovered, so the guard advances past the
    // missing-questions refusal to the receipt/answer checks.
    if (!evidence.ok) {
      expect(evidence.message).not.toContain("its question flow has no");
    }
  });

  test("a scope that runs units-generation still discovers only per-unit questions", () => {
    const proj = project();
    // Stage-level file present, but this scope executes units-generation, so
    // the per-unit lane applies and the stage-level file must be ignored.
    writeStageLevelQuestions(proj);
    const evidence = withSummaryGuard(() =>
      checkSummaryConfirmationEvidence(proj, stage(), {
        stateContent: stateFor("feature", "EXECUTE"),
      }),
    );
    expect(evidence.ok).toBe(false);
    if (evidence.ok) throw new Error("expected a refusal on the per-unit lane");
    expect(evidence.message).toContain("its question flow has no");
  });
});
