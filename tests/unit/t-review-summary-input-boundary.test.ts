// covers: function:reviewedArtifactUnit, function:reviewArtifactEntries,
// function:reviewArtifactSnapshot, function:reviewArtifactFingerprint,
// function:reviewArtifactBytesSnapshot, function:judgeFreeze
// covers: function:summaryInputReviewFingerprint
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  reviewArtifactBytesSnapshot,
  reviewArtifactFingerprint,
  reviewArtifactSnapshot,
  summaryInputReviewFingerprint,
  type ReviewFingerprintStage,
} from "../../core/tools/aidlc-lib.ts";
import { judgeFreeze } from "../../core/hooks/aidlc-review-freeze.ts";
import {
  cleanupTestProject,
  createTestProject,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

const stage: ReviewFingerprintStage = {
  slug: "requirements-analysis",
  phase: "inception",
  reviewer: "aidlc-product-lead-agent",
  review_artifact: "requirements",
  produces: ["requirements", "requirements-analysis-questions"],
  summary_confirmation: "required",
};
const receipts = { stageVerdict: "READY", unitVerdicts: new Map<string, string>() };
const confirmed = "# Questions\n\n## Consolidated Summary Confirmation\n\n[Answer]: Looks correct\n";

function fixture() {
  const project = createTestProject();
  projects.push(project);
  seedStateFile(project, "state-mid-inception.md");
  const dir = join(seededRecordDir(project), stage.phase, stage.slug);
  mkdirSync(dir, { recursive: true });
  const output = join(dir, "requirements.md");
  const questions = join(dir, "requirements-analysis-questions.md");
  writeFileSync(output, "# Requirements\n\nPrivate saved searches.\n");
  writeFileSync(questions, confirmed);
  return { project, output, questions };
}

describe("summary input and reviewed output have separate authority", () => {
  test("confirmation replay preserves a trailing comment without excluding its content", () => {
    const body = `${confirmed.trimEnd()} <!-- keep this review context -->\n`;
    const fingerprint = summaryInputReviewFingerprint(body);
    expect(summaryInputReviewFingerprint(body.replace("Looks correct", ""))).toBe(fingerprint);
    expect(summaryInputReviewFingerprint(body.replace("Looks correct", "Request changes"))).toBe(fingerprint);
    expect(summaryInputReviewFingerprint(body.replace("keep this review context", "different context")))
      .not.toBe(fingerprint);
  });

  test("a confirmation-looking line inside a code fence remains reviewed content", () => {
    const body = `${confirmed.trimEnd()} <!-- keep -->\n\n\`\`\`md\n[Answer]: Looks correct\n\`\`\`\n`;
    expect(summaryInputReviewFingerprint(body.replace("```md\n[Answer]: Looks correct", "```md\n[Answer]: Request changes")))
      .not.toBe(summaryInputReviewFingerprint(body));
  });

  test("invalid UTF-8 question content retains its byte identity", () => {
    expect(summaryInputReviewFingerprint(Buffer.from([0xff])))
      .not.toBe(summaryInputReviewFingerprint(Buffer.from([0xfe])));
  });

  test("summary reconfirmation can change its input file while reviewed output stays frozen", () => {
    const { project, output, questions } = fixture();
    const before = reviewArtifactSnapshot(project, stage, undefined, { requireRequiredArtifacts: true });
    expect(before).not.toBeNull();
    expect(judgeFreeze(stage, questions, new Set(), receipts).block).toBe(false);
    expect(judgeFreeze(stage, output, new Set(), receipts).block).toBe(true);
    writeFileSync(questions, confirmed.replace("Looks correct", ""));
    expect(reviewArtifactSnapshot(project, stage, undefined, { requireRequiredArtifacts: true })?.fingerprint)
      .toBe(before!.fingerprint);
    writeFileSync(questions, `${confirmed}\nA changed human requirement.\n`);
    expect(reviewArtifactFingerprint(project, stage)).not.toBe(before!.fingerprint);
    // Changed substantive input invalidates the review too, while replaying the
    // confirmation question does not. The production sequence checks descent.
    writeFileSync(output, "# Requirements\n\nA different implementation.\n");
    expect(reviewArtifactFingerprint(project, stage)).not.toBe(before!.fingerprint);
  });

  test("a snapshot still captures the input bytes for worktree transfer and requires declared inputs", () => {
    const { project, questions } = fixture();
    const snapshot = reviewArtifactBytesSnapshot(project, stage, undefined, {
      captureBytes: true, requireRequiredArtifacts: true,
    })!;
    expect(snapshot.fingerprint).toBe(reviewArtifactFingerprint(project, stage)!);
    expect(snapshot.entries.find((entry) => entry.path === questions)?.bytes?.toString())
      .toBe(confirmed);
    rmSync(questions);
    expect(reviewArtifactSnapshot(project, stage, undefined, { requireRequiredArtifacts: true }))
      .toBeNull();
    expect(reviewArtifactBytesSnapshot(project, stage, undefined, { requireRequiredArtifacts: true }))
      .toBeNull();
  });

  test("a stage explicitly reviewing its questions keeps their byte binding and freeze", () => {
    const { project, questions } = fixture();
    const explicit = { ...stage, review_artifact: "requirements-analysis-questions" };
    const fingerprint = reviewArtifactFingerprint(project, explicit);
    expect(fingerprint).not.toBeNull();
    expect(judgeFreeze(explicit, questions, new Set(), receipts).block).toBe(true);
    writeFileSync(questions, `${confirmed}\nChanged content.\n`);
    expect(reviewArtifactFingerprint(project, explicit)).not.toBe(fingerprint);
  });

  test("an artifact named questions has no exemption without a summary-confirmation contract", () => {
    const { project, questions } = fixture();
    const { summary_confirmation: _policy, ...ordinary } = stage;
    const fingerprint = reviewArtifactFingerprint(project, ordinary);
    expect(fingerprint).not.toBeNull();
    expect(judgeFreeze(ordinary, questions, new Set(), receipts).block).toBe(true);
    writeFileSync(questions, `${confirmed}\nChanged content.\n`);
    expect(reviewArtifactFingerprint(project, ordinary)).not.toBe(fingerprint);
  });

  test("optional summary input presence is part of the reviewed snapshot", () => {
    const { project, questions } = fixture();
    const conditional = {
      ...stage,
      summary_confirmation: "if-present" as const,
      produces: ["requirements"],
      optional_produces: ["requirements-analysis-questions"],
    };
    const before = reviewArtifactFingerprint(project, conditional);
    rmSync(questions);
    const after = reviewArtifactFingerprint(project, conditional);
    expect(after).not.toBe(before);
    expect(reviewArtifactBytesSnapshot(project, conditional)?.fingerprint).toBe(after!);
  });
});
