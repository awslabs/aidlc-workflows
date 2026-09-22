// covers: function:visibleMarkdownLines, function:summaryConfirmationContentHash,
// function:summaryConfirmationAnswer, function:summaryInputReviewFingerprint
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  summaryConfirmationAnswer,
  summaryConfirmationContentHash,
  summaryInputReviewFingerprint,
  visibleMarkdownLines,
} from "../../core/tools/aidlc-lib.ts";
import corpus from "../fixtures/markdown-goldens/corpus.json";

// Only parser-corrected constructs may depart from the pre-upgrade byte contract.
// Each key names one captured source document, not an entire test or directory.
const EXPECTED_DIVERGENCES: Record<string, string> = {};

function observed(content: string) {
  let summaryHash: { value: string } | { error: string };
  try {
    summaryHash = { value: summaryConfirmationContentHash(content) };
  } catch (error) {
    summaryHash = { error: (error as Error).message };
  }
  return {
    visible: visibleMarkdownLines(content),
    commentBoundaries: visibleMarkdownLines(content, { preserveCommentBoundaries: true }),
    indentedCode: visibleMarkdownLines(content, { preserveIndentedCode: true }),
    summaryHash,
    answer: summaryConfirmationAnswer(content),
    reviewFingerprint: summaryInputReviewFingerprint(content),
  };
}

describe("pre-upgrade Markdown consumer byte contract", () => {
  for (const [key, document] of Object.entries(corpus.documents)) {
    test(`${document.source} (${document.sha256.slice(0, 12)})`, () => {
      expect(createHash("sha256").update(document.content).digest("hex")).toBe(document.sha256);
      const actual = observed(document.content);
      if (EXPECTED_DIVERGENCES[key]) {
        expect(actual).not.toEqual(document.expected);
      } else {
        expect(actual).toEqual(document.expected);
      }
    });
  }
  test("every declared semantics change names a captured document", () => {
    for (const key of Object.keys(EXPECTED_DIVERGENCES)) {
      expect(Object.hasOwn(corpus.documents, key)).toBe(true);
    }
  });
});
