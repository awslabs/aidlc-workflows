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
import upgraded from "../fixtures/markdown-goldens/parser-upgrade.json";

// Only parser-corrected constructs may depart from the pre-upgrade byte contract.
// Each key names one captured source document, not an entire test or directory.
const EXPECTED_DIVERGENCES: Record<string, string> = {
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1034#59ae43f26420bf91f145b1056eba74a8009ecefc5e6fe0fe80e1a55923fbd8d3": "CommonMark §4.6 kind-6 HTML runs to the blank line even when its opening tag is unfinished; Q3 is raw text. Changes: visible lines and digest.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1122#53e7fa1ac261e47de1e858a1ca29401d296607ff6b2474ae3cc90eaf04c8f89c": "CommonMark §4.6 kind-6 HTML ends at a blank line, not </div>; the following Markdown-looking H2 is raw text. Changes: visible lines and digest.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1154#1fe7a273c90655ae5ab49d8e89116462608b0c72cc084f984af2fb292aaa7609": "CommonMark §4.6 raw HTML does not parse backticks as code, so the later literal <h2> remains an HTML heading. Changes: visible lines and digest.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1273#2e972ef2682c20deebd6763ca18bac4a95161da82146ca673d26ee83ffd48888": "CommonMark §5.1 permits only paragraph lazy continuation; the following unclosed comment is a top-level kind-2 block. Changes: visible lines and digest.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1273#6b781c9da2b7ff43e735ef4736dc1da46ce2e0abab78ca334051d7c191fadb51": "CommonMark §5.1 permits only paragraph lazy continuation; the indented fence following the quote opens at top level. Changes: visible lines and digest.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1273#e3d15c21fc5b67288f5a7f5c2a6c3ec0aac53851b4938715cc822b7368c159fb": "CommonMark §5.1 permits only paragraph lazy continuation; the fence after the quote opens at top level. Changes: visible lines and digest.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1476#260fd1127b3ab4921c4a6e1f1f7b73ee92788988ccb1beec81fb08443c404f43": "CommonMark §4.6 classifies the div and nested HTML heading as kind-6 raw HTML, not Markdown control text. Changes: visible lines; digest unchanged.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1476#286b527d442e8c3403bc53904ef37a0c0b7fd1d3532487f7e91b1a4d57593918": "CommonMark §4.6 classifies the HTML heading as kind-6 raw HTML, not Markdown control text. Changes: visible lines; digest unchanged.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1476#83e1af96fb291625d23d9a679533ccbd95e97bfa206f83698ddc3cce82b25f0c": "CommonMark §4.6 recognizes the multiline HTML heading as kind-6 raw HTML from its opening line. Changes: visible lines; digest unchanged.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:1476#cc0c4272a4cb66eb0d580ee162d204810085e193e9079c8d87147764dcf5029e": "CommonMark §4.6 allows up to three spaces before a kind-6 HTML block; its bytes are not Markdown control text. Changes: visible lines; digest unchanged.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:906#cb37ca3d2cbe23649eb51252910f4272274dea010e1e96241a57928e8901a98c": "CommonMark §4.6 kind-2 HTML interrupts the paragraph before inline parsing; an unmatched backtick cannot hide the comment opener. Changes: visible lines and digest.",
  "tests/integration/t185-stage-artifact-guard.test.ts:489 > tests/integration/t185-stage-artifact-guard.test.ts:963#9180b5ae8c1aeab4c9aa4209974569d7f5e1cfc2ffe1b212b3796a494e11b543": "CommonMark §4.6 kind-6 HTML retains comment-looking attribute bytes and continues through Q3 until a blank line. Changes: visible lines and digest.",
  "tests/integration/t185-stage-artifact-guard.test.ts:992#f1024f1244d0353c3e55b8baa90597266b6a51259033cbf6e2849c16c6adfb3c": "CommonMark §4.6 kind-6 HTML starts at the div opening line; attribute-contained answers remain invisible. Changes: visible lines; digest unchanged.",
};

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
        expect(actual).toEqual(upgraded[key as keyof typeof upgraded]);
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

  test("an inline comment's closing-line suffix cannot become a summary answer", () => {
    const content = "## Consolidated Summary Confirmation\n\ntext <!-- example\n-->[Answer]: Looks correct\n";
    expect(summaryConfirmationAnswer(content)).toBeNull();
    expect(summaryInputReviewFingerprint(content)).toBe(createHash("sha256").update(content).digest("hex"));
    expect(summaryConfirmationAnswer(`${content}\n[Answer]: Looks correct\n`)).toBe("Looks correct");
  });

  test("comment-looking bytes inside a comment do not manufacture additional boundaries", () => {
    expect(visibleMarkdownLines("<!-- outer\n<!-- nested\n--> after", { preserveCommentBoundaries: true }))
      .toEqual(["\u0000", "", "\u0000 after"]);
    expect(visibleMarkdownLines("<!-- first --> <!-- second --> after", { preserveCommentBoundaries: true }))
      .toEqual(["\u0000\u0000 \u0000\u0000 after"]);
  });
});
