// covers: function:reviewArtifactSnapshot function:captureStageValidationBasis
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewArtifactSnapshot } from "../../core/tools/aidlc-lib.ts";
import { captureStageValidationBasis } from "../../core/tools/aidlc-validity.ts";
import { approvalFingerprint } from "../../core/tools/aidlc-testing-posture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("added or changed assignments invalidate review and output evidence without rewriting plan approval", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-assignment-fingerprints-"));
  roots.push(root);
  const intents = join(root, "aidlc/spaces/default/intents");
  const record = join(intents, "261010-example");
  const dir = join(record, "inception/units-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(intents, "active-intent"), "261010-example\n");
  const state = "# State\n- **Scope**: feature\n- **Project Type**: greenfield\n";
  writeFileSync(join(record, "aidlc-state.md"), state);
  const stage = {
    slug: "units-generation", phase: "inception", review_artifact: "unit-of-work",
    produces: ["unit-of-work"], optional_produces: ["unit-requirement-assignments"],
  };
  writeFileSync(join(dir, "unit-of-work.md"), "# Units\nExisting approved decomposition\n");
  const approvalPath = join(record, "plan-approval.json");
  const authority = { targetId: "u1-api", intentId: "intent-uuid", runFloor: "run-floor" };
  const approval = approvalFingerprint("Approved plan", "Testing instructions", "sha256:" + "a".repeat(64), authority);
  writeFileSync(approvalPath, JSON.stringify({ fingerprint: approval }));
  const approvedBytes = readFileSync(approvalPath);
  const review = () => reviewArtifactSnapshot(root, stage);
  const basis = () => captureStageValidationBasis(root, stage, state, [stage], { resolution: { recordPath: record } });
  const beforeReview = review();
  expect(beforeReview).not.toBeNull();
  const beforeBasis = basis();
  expect(beforeBasis.outputs.map(output => output.artifact)).toEqual(["unit-of-work"]);
  const assignmentPath = join(dir, "unit-requirement-assignments.json");
  writeFileSync(assignmentPath, JSON.stringify({ version: 1, assignments: [{ id: "NFR1", owner: "u1-api", related: [], required_for: "owner" }] }));
  const addedReview = review();
  const addedBasis = basis();
  expect(addedReview?.fingerprint).not.toBe(beforeReview?.fingerprint);
  expect(addedBasis.outputs.some(output => output.artifact === "unit-requirement-assignments")).toBe(true);
  expect(addedBasis).not.toEqual(beforeBasis);
  writeFileSync(assignmentPath, JSON.stringify({ version: 1, assignments: [{ id: "NFR1", owner: "u1-api", related: [], required_for: "all" }] }));
  expect(review()?.fingerprint).not.toBe(addedReview?.fingerprint);
  expect(basis()).not.toEqual(addedBasis);
  expect(readFileSync(approvalPath)).toEqual(approvedBytes);
  expect(approvalFingerprint("Approved plan", "Testing instructions", "sha256:" + "a".repeat(64), authority)).toBe(approval);
  expect(readFileSync(join(record, "aidlc-state.md"), "utf-8")).toBe(state);
});
