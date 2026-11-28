// covers: function:artifactFilename, function:reviewArtifactFingerprint, function:opensWithPreviewPolicy
//
// Refined Mockups' HTML preview is what the person looks at before approving
// the experience. An optional output, written when the work has screens, it is
// fingerprinted with the Markdown ones when it exists, so a preview changed
// after review is a changed output like any other. Its head opens with the
// policy tag, however a formatter lays the tag out.

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
  opensWithPreviewPolicy, PREVIEW_CONTENT_POLICY, PREVIEW_POLICY_TAG,
} from "../../dist/claude/.claude/tools/aidlc-artifact-resolution.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

// A preview as the stage writes it: the policy tag first in its head.
const preview = (body: string): string =>
  `<!doctype html><html><head>${PREVIEW_POLICY_TAG}</head><body>${body}</body></html>\n`;

describe("t-mockups-preview-bound", () => {
  test("the preview resolves to one HTML file, an optional output", () => {
    expect(artifactFilename("mockups-preview")).toBe("mockups-preview.html");
    const stage = findStageBySlug("refined-mockups");
    expect(stage?.optional_produces).toContain("mockups-preview");
    expect(stage?.produces).not.toContain("mockups-preview");
  });

  test("the reviewed outputs' fingerprint covers the preview when it is written", () => {
    const p = createTestProject();
    projects.push(p);
    seedStateFile(p, join(FIXTURES_DIR, "state-brownfield-feature.md"));
    const stage = findStageBySlug("refined-mockups")!;
    const dir = join(seededRecordDir(p), "inception", "refined-mockups");
    mkdirSync(dir, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
    const withoutPreview = reviewArtifactFingerprint(p, stage, undefined, { requireRequiredArtifacts: true });
    expect(withoutPreview, "API-only work, with no preview, is reviewed as before").not.toBeNull();

    writeFileSync(join(dir, "mockups-preview.html"), preview("<title>Add policyholder</title>"));
    const approved = reviewArtifactFingerprint(p, stage);
    expect(approved).not.toBeNull();
    expect(approved).not.toBe(withoutPreview);

    writeFileSync(join(dir, "mockups-preview.html"), preview("<title>Add policyholder, inline row</title>"));
    expect(reviewArtifactFingerprint(p, stage)).not.toBe(approved);
  });

  // The preview is opened in a browser and written partly from document text:
  // the policy, first in the head, has the browser run no script and load
  // nothing from elsewhere. A formatter's layout of the same tag is the same
  // tag; the policy value itself is compared exactly.
  test("the policy tag opens the head, however a formatter lays it out", () => {
    for (const html of [
      preview("<title>Add policyholder</title>"),
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n${PREVIEW_POLICY_TAG}\n<title>x</title></head></html>\n`,
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta\n      http-equiv="Content-Security-Policy"\n` +
        `      content="${PREVIEW_CONTENT_POLICY}"\n    />\n  </head>\n</html>\n`,
      `<!doctype html><html><head><meta content="${PREVIEW_CONTENT_POLICY}" http-equiv="Content-Security-Policy"/></head></html>\n`,
    ]) {
      expect(opensWithPreviewPolicy(html), html).toBe(true);
    }
    for (const html of [
      "<!doctype html><html><head><title>no policy</title></head></html>\n",
      `<!doctype html><html><head><script src="https://example.com/x.js"></script>${PREVIEW_POLICY_TAG}</head></html>\n`,
      `<!doctype html><html><head><title>late</title></head><body>${PREVIEW_POLICY_TAG}</body></html>\n`,
      preview("x").replace("default-src 'none'", "default-src *"),
      preview("x").replace("img-src data:", "img-src data: https:"),
    ]) {
      expect(opensWithPreviewPolicy(html), html).toBe(false);
    }
  });
});
