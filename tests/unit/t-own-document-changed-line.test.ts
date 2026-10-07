// covers: function:staleStageNote, function:ownDocumentChangedLine, subcommand:aidlc-utility:status
//
// Under Guard Policy strict, the person edited Requirements Analysis' approved
// requirements.md during a later stage. The line they heard said
// "Requirements Analysis finished before something it used changed", and the
// agent went on to call their own line stray (a live Kiro IDE run). Now the
// line names the document that changed, says the change stands, and names the
// redo. A document that is gone, or an input that changed, keeps the line it
// had.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import {
  inspectStageValidity, stageValidationAuditFields, staleStageNote,
} from "../../dist/claude/.claude/tools/aidlc-validity.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});

const STAGE = "requirements-analysis";
const LINE = 'requirements.md changed after Requirements Analysis finished; carrying on with it as it is. ' +
  'Say "redo requirements analysis" to go over the stage again with the change.';

// Requirements Analysis approved with its completion record.
function project(policy: "off" | "strict"): { proj: string; requirements: string } {
  const proj = createTestProject();
  created.push(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const statePath = seededStateFile(proj);
  writeFileSync(statePath, readFileSync(statePath, "utf-8")
    .replace("- **Change Control**: strict (from scope bugfix)",
      policy === "off" ? "- **Guard Policy**: off (from scope bugfix)" : "- **Guard Policy**: strict (set by you)")
    .replace(/^- \[.\] requirements-analysis/m, "- [x] requirements-analysis"));
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const requirements = join(dir, "requirements.md");
  writeFileSync(requirements, "# Requirements\n\n- FR-1: a blank title is refused.\n");
  const stage = loadGraph().find((node) => node.slug === STAGE);
  if (!stage) throw new Error(`graph has no ${STAGE}`);
  appendAuditEntry("STAGE_COMPLETED", {
    Stage: STAGE, ...stageValidationAuditFields(proj, stage, readFileSync(statePath, "utf-8")),
  }, proj);
  return { proj, requirements };
}

function status(proj: string): string {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "status", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
  });
  return `${result.stdout}${result.stderr}`;
}

describe("t-own-document-changed-line: an edit to a finished stage's own document", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`the line names the document, says the change stands, and names the redo (Guard Policy ${policy})`, () => {
      const { proj, requirements } = project(policy);
      appendFileSync(requirements, "- FR-2: a title is at most 200 characters.\n");
      const state = readFileSync(seededStateFile(proj), "utf-8");
      const issue = inspectStageValidity(proj, state).issues.find((entry) => entry.stage === STAGE);
      expect(issue?.direct, JSON.stringify(issue)).toBe(true);
      expect(staleStageNote("Requirements Analysis", issue!, state)).toBe(LINE);
      // `/aidlc --status` says the same line.
      expect(status(proj)).toContain(LINE);
      expect(status(proj)).not.toContain("finished before something it used changed");
    });

    test(`a document that is gone keeps the line it had (Guard Policy ${policy})`, () => {
      const { proj, requirements } = project(policy);
      rmSync(requirements);
      const state = readFileSync(seededStateFile(proj), "utf-8");
      const issue = inspectStageValidity(proj, state).issues.find((entry) => entry.stage === STAGE);
      expect(issue?.direct, JSON.stringify(issue)).toBe(true);
      expect(staleStageNote("Requirements Analysis", issue!, state)).toBe(
        'Requirements Analysis finished before something it used changed; say "redo requirements analysis" to bring it up to date.',
      );
      expect(status(proj)).not.toContain("carrying on with it as it is");
    });
  }

  test("several documents are named together; an input that changed keeps its line", () => {
    expect(staleStageNote("User Stories", { reasons: ["output:personas", "output:stories"], edited: true }, "")).toBe(
      'personas.md and stories.md changed after User Stories finished; carrying on with them as they are. ' +
        'Say "redo user stories" to go over the stage again with the change.',
    );
    expect(staleStageNote("User Stories", { reasons: ["input:requirements", "output:stories"] }, "")).toBe(
      'User Stories finished before something it used changed; say "redo user stories" to bring it up to date.',
    );
  });
});
