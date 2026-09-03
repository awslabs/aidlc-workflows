import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { summaryConfirmationContentHash } from "../../core/tools/aidlc-lib.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PROTOCOL = join(ROOT, "core", "aidlc-common", "protocols", "stage-protocol.md");
const GUIDE = join(ROOT, "core", "aidlc-common", "protocols", "stage-protocol-guide.md");
const REFERENCE = join(ROOT, "docs", "reference", "04-stage-protocol.md");

describe("browser guide protocol prose", () => {
  test("pins gated mode text, Step 3d, note handling, and reference mirror", () => {
    const protocol = readFileSync(PROTOCOL, "utf-8");
    expect(protocol).toContain("Guide me in the browser");
    expect(protocol).toContain("Read an explainer with trade-offs and answer in the browser");
    expect(protocol).toContain("ONLY when `directive.review_ui` is present");
    expect(protocol).toContain("five visible lines");
    expect(protocol).toContain('**Step 3d: If "Guide me in the browser":**');
    expect(protocol).toContain("`[Note]:` lines are discussion input");

    const reference = readFileSync(REFERENCE, "utf-8");
    expect(reference).toContain("Guide Me in the Browser");
    expect(reference).toContain("five visible lines including final Other");
    expect(reference).toContain("aidlc-log.ts\nanswers-apply");
  });

  test("guide module exists and stays concise", () => {
    expect(existsSync(GUIDE)).toBe(true);
    const guide = readFileSync(GUIDE, "utf-8");
    expect(guide.split("\n").length - 1).toBeLessThanOrEqual(90);
    expect(guide).toContain('data-aidlc-question="Q1"');
    expect(guide).toContain('data-aidlc-recommend="B"');
    expect(guide).toContain("Option</th><th>You get</th><th>You give up</th><th>Cost / risk");
    expect(guide).toContain("aidlc-html.ts check --guide");
  });

  test("note tags are ordinary content for summary hashing, never answer tags", () => {
    const withoutNote = "# Questions\n\n## Q1. Runtime\n\n[Answer]: A\n\n## Consolidated Summary Confirmation\n\n[Answer]: Looks correct\n";
    const withNote = withoutNote.replace("[Answer]: A", "[Answer]: A\n[Note]: Discuss portability next.");
    expect(() => summaryConfirmationContentHash(withNote)).not.toThrow();
    expect(summaryConfirmationContentHash(withNote)).not.toBe(
      summaryConfirmationContentHash(withoutNote),
    );
  });
});
