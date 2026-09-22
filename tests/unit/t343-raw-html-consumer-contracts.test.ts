// covers: function:summaryConfirmationContentHash, function:summaryConfirmationAnswer,
// function:memorySectionBody, function:questionsFileApproved,
// function:questionsFilePlannedSource, function:codeGenerationPlanApprovalQuestionEvidence

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANGE_CONTROL_FIELD,
  memorySectionBody,
  setField,
  stateDigest,
  summaryConfirmationAnswer,
  summaryConfirmationContentHash,
  workspaceSourceFingerprint,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  codeGenerationPlanApprovalQuestionEvidence,
  codeGenerationRecordDir,
  questionsFileApproved,
  questionsFilePlannedSource,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  seededRecordDir,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const SUMMARY = "## Consolidated Summary Confirmation\n[Answer]: Looks correct\n";
const SOURCE = "a".repeat(64);
const HIDDEN_SOURCE = "b".repeat(64);

// Kind-6 HTML blocks end at a blank line, not at the closing tag alone.
function rawHtml(body: string): string {
  return `<div>\n${body}\n</div>\n\n`;
}

function presentPlan(project: string): string {
  const statePath = join(seededRecordDir(project), "aidlc-state.md");
  let state = readFileSync(statePath, "utf-8")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
    .replace(
      /^- \[[ xSR?-]\] code-generation(\s+\S\s+)EXECUTE$/m,
      "- [-] code-generation$1EXECUTE",
    );
  state = setField(state, CHANGE_CONTROL_FIELD, "relaxed (set by you)");
  writeFileSync(statePath, state);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "base.ts"), "export const base = 1;\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"],
    ["commit", "-qm", "baseline"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
  writeActiveDirectiveMarker(project, {
    kind: "run-stage",
    stage: "code-generation",
    state_sha256: stateDigest(state),
  });
  const dir = codeGenerationRecordDir(project, null);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "code-generation-plan.md"),
    `# Plan\n\n${renderTestingContract(resolveTestingPosture(project))}\n## Steps\n\n- [ ] Implement\n`,
  );
  writeFileSync(
    join(dir, "unit-test-instructions.md"),
    "# Unit Test Instructions\n\n## Command\n\n`bun test unit.test.ts`\n",
  );
  const questions = join(dir, "code-generation-questions.md");
  writeFileSync(questions, "## Plan Approval\n[Answer]:\n");
  const result = Bun.spawnSync([
    process.execPath,
    join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"),
    "fingerprint", "--stage-level", "--project-dir", project,
  ], { cwd: project, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  writeFileSync(questions, `## Plan Approval\n${result.stdout.toString().trim()}\n[Answer]:\n`);
  return questions;
}

describe("t343 raw HTML consumer contracts", () => {
  test("summary digest excludes a visible assumption section but retains heading-looking raw HTML bytes", () => {
    const assumption = "## Assumption Confirmation\nAssume one region.\n[Answer]: A. Accept assumptions";
    const hidden = `${SUMMARY}\n${rawHtml(assumption)}`;
    expect(summaryConfirmationContentHash(hidden)).toBe(
      createHash("sha256").update(hidden.trimEnd(), "utf-8").digest("hex"),
    );
    expect(summaryConfirmationContentHash(hidden.replace("one region", "two regions")))
      .not.toBe(summaryConfirmationContentHash(hidden));
    expect(summaryConfirmationContentHash(`${SUMMARY}\n${assumption}\n`))
      .toBe(summaryConfirmationContentHash(SUMMARY));
  });

  test("summary answer ignores raw HTML and reads the same answer outside it", () => {
    const heading = "## Consolidated Summary Confirmation\n";
    const answer = "[Answer]: A. Accept assumptions";
    expect(summaryConfirmationAnswer(heading + rawHtml(answer))).toBeNull();
    expect(summaryConfirmationAnswer(`${heading}${answer}\n`)).toBe("A. Accept assumptions");
    expect(summaryConfirmationAnswer(`${heading}${rawHtml(answer)}[Answer]: Looks correct\n`))
      .toBe("Looks correct");
  });

  test("memory section ignores a Change Control heading and Mode inside raw HTML", () => {
    const hidden = rawHtml("## Change Control\n- **Mode**: relaxed");
    expect(memorySectionBody(hidden, "## Change Control")).toBe("");
    expect(memorySectionBody(`${hidden}## Change Control\n- **Mode**: strict\n`, "## Change Control").trim())
      .toBe("- **Mode**: strict");
    expect(memorySectionBody(`## Change Control\n${rawHtml("- **Mode**: relaxed")}- **Mode**: strict\n`, "## Change Control").trim())
      .toBe("- **Mode**: strict");
  });

  test("latest Plan Approval ignores raw HTML headings and answers", () => {
    const approval = "## Plan Approval\n[Answer]: Approve Plan";
    expect(questionsFileApproved(rawHtml(approval))).toBe(false);
    expect(questionsFileApproved(`${approval}\n`)).toBe(true);
    expect(questionsFileApproved(`${approval}\n\n${rawHtml("## Plan Approval\n[Answer]: Request Changes")}`))
      .toBe(true);
  });

  test("Planned Source selection ignores a raw HTML tag and selects the visible one", () => {
    const hidden = rawHtml(`[Planned Source]: ${HIDDEN_SOURCE}`);
    expect(questionsFilePlannedSource(`## Plan Approval\n${hidden}`)).toBeNull();
    expect(questionsFilePlannedSource(`## Plan Approval\n${hidden}[Planned Source]: ${SOURCE}\n`))
      .toBe(SOURCE);
    expect(questionsFilePlannedSource(`## Plan Approval\n[Planned Source]: ${SOURCE}\n\n${hidden}`))
      .toBe(SOURCE);
  });

  test("pre-challenge source re-baselining rewrites the visible tag, never a later raw HTML tag", () => {
    const project = setupIntegrationProject({ withState: "state-brownfield-feature.md" });
    try {
      const questions = presentPlan(project);
      const hidden = rawHtml(`[Planned Source]: ${HIDDEN_SOURCE}`);
      const baseline = readFileSync(questions, "utf-8");
      const original = `${baseline}\n${hidden}`;
      const oldSource = questionsFilePlannedSource(baseline);
      expect(oldSource).not.toBeNull();
      writeFileSync(questions, original);
      writeFileSync(join(project, "src", "drifted.ts"), "export const drifted = 1;\n");
      const current = workspaceSourceFingerprint(project);
      if (current === null) throw new Error("Source fixture must have a bindable fingerprint");
      expect(current).not.toBe(oldSource);

      const evidence = codeGenerationPlanApprovalQuestionEvidence(project, { unit: null }, questions, "");
      const rewritten = readFileSync(questions, "utf-8");
      expect(rewritten).toBe(original.replace(`[Planned Source]: ${oldSource}`, `[Planned Source]: ${current}`));
      expect(questionsFilePlannedSource(rewritten)).toBe(current);
      expect(evidence.plannedSourceSha256).toBe(current);

      const hiddenOnly = rewritten.replace(`[Planned Source]: ${current}\n`, "");
      writeFileSync(questions, hiddenOnly);
      expect(() => codeGenerationPlanApprovalQuestionEvidence(project, { unit: null }, questions, ""))
        .toThrow(/requires a \[Planned Source\]: tag/);
      expect(readFileSync(questions, "utf-8")).toBe(hiddenOnly);
    } finally {
      cleanupTestProject(project);
    }
  });
});
