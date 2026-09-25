// covers: function:checkSummaryConfirmationEvidence, function:summaryConfirmationContentHash
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import {
  checkSummaryConfirmationEvidence,
  summaryConfirmationContentHash,
} from "../../core/tools/aidlc-lib.ts";
import {
  cleanupTestProject, createTestProject, seedAidlcMemory, seededRecordDir,
  seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import goldens from "../fixtures/markdown-goldens/corpus.json";

const projects: string[] = [];
afterEach(() => { while (projects.length) cleanupTestProject(projects.pop()!); });
const confirmed = "# Questions\n\n## Q1\n\nKeep the login flow.\n\n## Consolidated Summary Confirmation\n\n[Answer]: Looks correct\n";

function fixture(content = confirmed) {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const stage: Parameters<typeof checkSummaryConfirmationEvidence>[1] = {
    slug: "requirements-analysis", name: "Requirements Analysis", phase: "inception",
    outputs: "record", produces: ["requirements", "requirements-analysis-questions"],
    optional_produces: [], produces_kinds: {}, summary_confirmation: "required",
  };
  const dir = join(seededRecordDir(proj), "inception", stage.slug);
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, `${stage.slug}-questions.md`);
  const artifact = join(dir, "requirements.md");
  writeFileSync(questions, content);
  function receipt(scope: string | null, digest: string) {
    appendAuditEntry("SUMMARY_CONFIRMATION_RECORDED", {
      Stage: stage.slug, Details: "Looks correct", Checkpoint: "Consolidated Summary Confirmation",
      "Questions File": relative(proj, questions), "Questions SHA-256": digest,
      ...(scope === null ? {} : { "Hash Scope": scope }),
    }, proj);
  }
  function save() {
    writeFileSync(artifact, "# Requirements\n");
    appendAuditEntry("ARTIFACT_CREATED", { Stage: stage.slug, File: relative(proj, artifact) }, proj);
  }
  function evidence() {
    const prior = process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
    process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = "0";
    try {
      return checkSummaryConfirmationEvidence(proj, stage, {
        stateContent: readFileSync(seededStateFile(proj), "utf-8"),
      });
    } finally {
      if (prior === undefined) delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
      else process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = prior;
    }
  }
  return { receipt, save, evidence };
}

describe("summary-confirmation parser scope migration", () => {
  test("a v1 receipt whose digest still matches authorizes generated output", () => {
    const f = fixture();
    f.receipt("confirmed-content-v1", summaryConfirmationContentHash(confirmed));
    f.save();
    expect(f.evidence().ok).toBe(true);
  });

  test("v1 digest mismatch explains parser semantics without asserting an edit happened", () => {
    const document = Object.values(goldens.documents).find((entry) => entry.sha256.startsWith("59ae43f26420"))!;
    if (!("value" in document.expected.summaryHash)) throw new Error("expected valid v1 digest");
    const f = fixture(document.content);
    f.receipt("confirmed-content-v1", document.expected.summaryHash.value);
    f.save();
    const result = f.evidence();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal?.code).toBe("SUMMARY_CONTENT_SEMANTICS_CHANGED");
    expect(result.message).toContain("predates the Markdown-parser upgrade");
    expect(result.message).toContain("Either the confirmed content changed");
    expect(result.message).toContain("raw HTML content");
    expect(result.message).toContain("re-present");
    expect(result.message).not.toContain("changed after the human confirmed its summary");
  });

  test("v2 digest mismatch retains the edited-after-confirmation refusal", () => {
    const f = fixture();
    f.receipt("confirmed-content-v2", summaryConfirmationContentHash(confirmed.replace("login", "logout")));
    f.save();
    const result = f.evidence();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal?.code).toBe("SUMMARY_CONTENT_STALE");
    expect(result.message).toContain("changed after the human confirmed its summary");
  });

  test("a v2 reconfirmation can descend from an identical v1 receipt's earlier write", () => {
    const f = fixture();
    const digest = summaryConfirmationContentHash(confirmed);
    f.receipt("confirmed-content-v1", digest);
    f.save();
    f.receipt("confirmed-content-v2", digest);
    expect(f.evidence().ok).toBe(true);
  });

  test("unknown scopes remain invalid rather than inheriting v1 compatibility", () => {
    const f = fixture();
    f.receipt("confirmed-content-v99", summaryConfirmationContentHash(confirmed));
    f.save();
    const result = f.evidence();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal?.code).toBe("SUMMARY_HASH_SCOPE_INVALID");
  });

  test("unscoped receipts still verify whole-file bytes", () => {
    const f = fixture();
    f.receipt(null, createHash("sha256").update(confirmed).digest("hex"));
    f.save();
    expect(f.evidence().ok).toBe(true);
  });
});
