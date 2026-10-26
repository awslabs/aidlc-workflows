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

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

describe("t-mockups-preview-bound", () => {
  test("the preview resolves to one HTML file", () => {
    expect(artifactFilename("mockups-preview")).toBe("mockups-preview.html");
    expect(findStageBySlug("refined-mockups")?.optional_produces).toContain("mockups-preview");
  });

  test("the reviewed outputs' fingerprint covers the preview", () => {
    const p = createTestProject();
    projects.push(p);
    seedStateFile(p, join(FIXTURES_DIR, "state-brownfield-feature.md"));
    const stage = findStageBySlug("refined-mockups")!;
    const dir = join(seededRecordDir(p), "inception", "refined-mockups");
    mkdirSync(dir, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
    writeFileSync(join(dir, "mockups-preview.html"), "<!doctype html><title>Add policyholder</title>\n");
    const approved = reviewArtifactFingerprint(p, stage);
    expect(approved).not.toBeNull();

    writeFileSync(join(dir, "mockups-preview.html"), "<!doctype html><title>Add policyholder, inline row</title>\n");
    expect(reviewArtifactFingerprint(p, stage)).not.toBe(approved);
  });
});
