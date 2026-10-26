// covers: function:reviewManifestForms, function:reviewArtifactFingerprint
//
// A review receipt records the fingerprint of the stage's documents, with a
// `missing` entry for each declared output that is not there. A receipt
// recorded before the stage declared an optional output (Requirements
// Analysis's traceability record) has no entry for it, so after the update the
// same documents fingerprinted differently: the person who changed nothing was
// told their documents changed, or under strict was handed a review nobody
// asked for. The fingerprint stays the form every receipt records, and the form
// with no entry for a missing optional output, over LF or raw line endings, is
// the same documents. An optional output that appears, changes or goes away
// after the review is still a change.
//
// Mechanism: function - the manifest forms, and the fingerprint of a scratch project's documents.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentFingerprintForm,
  findStageBySlug,
  rawFingerprintForm,
  reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { reviewManifestForms } from "../../dist/claude/.claude/tools/aidlc-review-manifest.ts";
import { cleanupTestProject, createTestProject, resetAidlcEnv, seededRecordDir, seedStateFile } from "../harness/fixtures.ts";

resetAidlcEnv();
const projects: string[] = [];
afterAll(() => {
  for (const dir of projects) cleanupTestProject(dir);
});

type Entry = [string, string];
const digest = (manifest: Entry[]) => `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
const file = { required: true, state: "file" };
const optionalMissing = { required: false, state: "missing" };

describe("the forms of one review manifest", () => {
  test("nothing optional missing, LF only: the fingerprint and no other form", () => {
    const manifest: Entry[] = [["a.md", "sha256:1"], ["b.md", "missing"], ["c.md", "not-file"]];
    const forms = reviewManifestForms(manifest, manifest, [file, { required: true, state: "missing" }, { required: false, state: "not-file" }]);
    expect(forms).toEqual({ fingerprint: digest(manifest), raw: null, older: [] });
  });

  test("a missing optional output: the older form has no entry for it", () => {
    const manifest: Entry[] = [["r.md", "sha256:1"], ["t.json", "missing"]];
    const forms = reviewManifestForms(manifest, manifest, [file, optionalMissing]);
    expect(forms).toEqual({ fingerprint: digest(manifest), raw: null, older: [digest([["r.md", "sha256:1"]])] });
  });

  test("two missing optional outputs: the older form drops both, and a form that drops one is no form of it", () => {
    const manifest: Entry[] = [["a.md", "missing"], ["r.md", "sha256:1"], ["z.md", "missing"]];
    const forms = reviewManifestForms(manifest, manifest, [optionalMissing, file, optionalMissing]);
    expect(forms.older).toEqual([digest([["r.md", "sha256:1"]])]);
    const all = [forms.fingerprint, forms.raw, ...forms.older];
    expect(all).not.toContain(digest([["r.md", "sha256:1"], ["z.md", "missing"]]));
    expect(all).not.toContain(digest([["a.md", "missing"], ["r.md", "sha256:1"]]));
  });

  test("raw line endings: the raw form, and both with no entry for the missing optional output", () => {
    const manifest: Entry[] = [["r.md", "sha256:lf"], ["t.json", "missing"]];
    const rawManifest: Entry[] = [["r.md", "sha256:crlf"], ["t.json", "missing"]];
    const forms = reviewManifestForms(manifest, rawManifest, [file, optionalMissing]);
    expect(forms.fingerprint).toBe(digest(manifest));
    expect(forms.raw).toBe(digest(rawManifest));
    expect(forms.older).toEqual([digest([["r.md", "sha256:lf"]]), digest([["r.md", "sha256:crlf"]])]);
  });
});

describe("a review recorded before the stage declared an optional output", () => {
  const CURRENT = findStageBySlug("requirements-analysis")!;
  // The stage as 2.11.1 declared it: no traceability record.
  const BEFORE = { ...CURRENT, optional_produces: [] as string[] };

  function project(eol = "\n"): string {
    const proj = createTestProject();
    projects.push(proj);
    seedStateFile(proj, "state-mid-inception.md");
    const dir = join(seededRecordDir(proj), "inception", "requirements-analysis");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requirements.md"), ["# Requirements", "", "- FR1 Sign up", ""].join(eol));
    writeFileSync(join(dir, "requirements-analysis-questions.md"), ["# Questions", ""].join(eol));
    return proj;
  }
  const record = (proj: string) => join(seededRecordDir(proj), "inception", "requirements-analysis", "traceability.json");

  test("covers the same documents, and the form every receipt records is unchanged", () => {
    expect(CURRENT.optional_produces).toContain("traceability");
    const proj = project();
    const recorded = reviewArtifactFingerprint(proj, BEFORE)!;
    const current = reviewArtifactFingerprint(proj, CURRENT)!;
    expect(current).not.toBe(recorded);
    expect(currentFingerprintForm(recorded)).toBe(current);
    expect(currentFingerprintForm(current)).toBe(current);
    // The older form is no raw form of the current one: checkpoint evidence rebuilt over raw forms is unchanged.
    expect(rawFingerprintForm(current)).toBeNull();
  });

  test("the record written, changed or removed after that review is a change", () => {
    const proj = project();
    const before = reviewArtifactFingerprint(proj, BEFORE)!;
    const missing = reviewArtifactFingerprint(proj, CURRENT)!;
    writeFileSync(record(proj), '{"coverage":[]}\n');
    const written = reviewArtifactFingerprint(proj, CURRENT)!;
    expect(currentFingerprintForm(before)).not.toBe(written);
    expect(currentFingerprintForm(missing)).not.toBe(written);
    writeFileSync(record(proj), '{"coverage":[{"id":"FR1"}]}\n');
    const changed = reviewArtifactFingerprint(proj, CURRENT)!;
    expect(currentFingerprintForm(written)).not.toBe(changed);
    rmSync(record(proj));
    const removed = reviewArtifactFingerprint(proj, CURRENT)!;
    expect(currentFingerprintForm(changed)).not.toBe(removed);
    expect(removed).toBe(missing);
  });

  test("CRLF documents: a receipt over the raw bytes with no entry for the record covers the same documents", () => {
    const proj = project("\r\n");
    const recordedRaw = rawFingerprintForm(reviewArtifactFingerprint(proj, BEFORE));
    expect(recordedRaw).not.toBeNull();
    const current = reviewArtifactFingerprint(proj, CURRENT)!;
    expect(currentFingerprintForm(recordedRaw)).toBe(current);
    const raw = rawFingerprintForm(current);
    expect(raw).not.toBeNull();
    expect(raw).not.toBe(recordedRaw);
    expect(currentFingerprintForm(raw)).toBe(current);
  });

  test("Build and Test's outputs, required before and optional now, fingerprint as before when they are missing", () => {
    const stage = findStageBySlug("build-and-test")!;
    expect(stage.optional_produces?.length).toBeGreaterThan(0);
    const required = { ...stage, produces: [...(stage.produces ?? []), ...(stage.optional_produces ?? [])], optional_produces: [] as string[] };
    const proj = project();
    expect(reviewArtifactFingerprint(proj, stage)).toBe(reviewArtifactFingerprint(proj, required)!);
  });
});
