// covers: function:artifactFilename, function:reviewArtifactFingerprint
//
// Refined Mockups' HTML preview is what the person looks at before approving
// the experience. Declared as an output, it is fingerprinted with the Markdown
// ones, so a preview changed after review is a changed output like any other.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject, createTestProject, FIXTURES_DIR, resetAidlcEnv, seededRecordDir, seedStateFile,
} from "../harness/fixtures.ts";
import {
  artifactFilename, findStageBySlug, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  inspectRequiredArtifactInstances, PREVIEW_CONTENT_POLICY,
} from "../../dist/claude/.claude/tools/aidlc-artifact-resolution.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

// A preview as the stage writes it: the policy line first in its head.
const preview = (body: string): string =>
  `<!doctype html><html><head>${PREVIEW_CONTENT_POLICY}</head><body>${body}</body></html>\n`;

describe("t-mockups-preview-bound", () => {
  test("the preview resolves to one HTML file", () => {
    expect(artifactFilename("mockups-preview")).toBe("mockups-preview.html");
    expect(findStageBySlug("refined-mockups")?.produces).toContain("mockups-preview");
  });

  test("the reviewed outputs' fingerprint covers the preview", () => {
    const p = createTestProject();
    projects.push(p);
    seedStateFile(p, join(FIXTURES_DIR, "state-brownfield-feature.md"));
    const stage = findStageBySlug("refined-mockups")!;
    const dir = join(seededRecordDir(p), "inception", "refined-mockups");
    mkdirSync(dir, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
    writeFileSync(join(dir, "mockups-preview.html"), preview("<title>Add policyholder</title>"));
    expect(reviewArtifactFingerprint(p, stage, undefined, { requireRequiredArtifacts: true })).not.toBeNull();
    const approved = reviewArtifactFingerprint(p, stage);
    expect(approved).not.toBeNull();

    writeFileSync(join(dir, "mockups-preview.html"), preview("<title>Add policyholder, inline row</title>"));
    expect(reviewArtifactFingerprint(p, stage)).not.toBe(approved);
  });

  // The preview is opened in a browser and written partly from document text:
  // its fixed policy line, first in the head, has the browser run no script and
  // load nothing from elsewhere. The engine checks the line where it requires the file.
  test("the review request and the gate require the preview's policy line first in its head", () => {
    const p = createTestProject();
    projects.push(p);
    seedStateFile(p, join(FIXTURES_DIR, "state-brownfield-feature.md"));
    const stage = findStageBySlug("refined-mockups")!;
    const dir = join(seededRecordDir(p), "inception", "refined-mockups");
    mkdirSync(dir, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
    const previewFailure = () =>
      inspectRequiredArtifactInstances(p, stage).failures.find((failure) => failure.artifact === "mockups-preview");
    for (const html of [
      preview("<title>Add policyholder</title>"),
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n${PREVIEW_CONTENT_POLICY}\n<title>x</title></head></html>\n`,
    ]) {
      writeFileSync(join(dir, "mockups-preview.html"), html);
      expect(previewFailure(), html).toBeUndefined();
    }
    for (const html of [
      "<!doctype html><html><head><title>no policy</title></head></html>\n",
      `<!doctype html><html><head><script src="https://example.com/x.js"></script>${PREVIEW_CONTENT_POLICY}</head></html>\n`,
      `<!doctype html><html><head><title>late</title></head><body>${PREVIEW_CONTENT_POLICY}</body></html>\n`,
      PREVIEW_CONTENT_POLICY.replace("default-src 'none'", "default-src *"),
    ]) {
      writeFileSync(join(dir, "mockups-preview.html"), html);
      expect(previewFailure()?.reason, html).toContain(PREVIEW_CONTENT_POLICY);
    }
  });
});
