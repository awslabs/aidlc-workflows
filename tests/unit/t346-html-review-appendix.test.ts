// covers: function:existingReviewAppendixOffset, function:validateReviewAppendix, function:reviewAppendixDigest

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  existingReviewAppendixOffset,
  reviewAppendixDigest,
  validateReviewAppendix,
} from "../../core/tools/aidlc-lib.ts";

const REVIEWER = "aidlc-product-lead-agent";
const CHALLENGE = "review:0123456789abcdef0123456789abcdef";
const expected = {
  verdict: "READY" as const,
  reviewer: REVIEWER,
  iteration: 2,
  reviewChallenge: CHALLENGE,
};

function htmlReview(verdict = "READY", extra = ""): string {
  return `<section data-aidlc="review">
<h2>Review</h2>
<p><strong>Verdict:</strong> ${verdict}</p>
<p><strong>Reviewer:</strong> ${REVIEWER}</p>
<p><strong>Iteration:</strong> 2</p>
<p><strong>Request Challenge:</strong> ${CHALLENGE}</p>
<h3>Findings</h3><p>No blocking findings.</p>
${extra}</section>`;
}

describe("t346 HTML review appendix", () => {
  test("locates the terminal body review section at a UTF-8 byte boundary", () => {
    const prefix = `<!doctype html><html lang="en"><body>\n<p>café</p>\n`;
    const artifact = `${prefix}${htmlReview()}\n</body></html>\n`;
    expect(existingReviewAppendixOffset(Buffer.from(artifact), "html")).toBe(
      Buffer.byteLength(prefix),
    );
  });

  test("uses the closing body as insertion boundary when no review exists", () => {
    const prefix = `<!doctype html><html lang="en"><body>\n<p>body</p>\n`;
    const artifact = `${prefix}</body></html>\n`;
    expect(existingReviewAppendixOffset(Buffer.from(artifact), "html")).toBe(
      Buffer.byteLength(prefix),
    );
  });

  test("rejects non-terminal, commented, and script-text review markers", () => {
    const followed = `<!doctype html><html><body>${htmlReview()}<p>later</p></body></html>`;
    expect(existingReviewAppendixOffset(Buffer.from(followed), "html")).toBe(
      Buffer.byteLength(followed.slice(0, followed.indexOf("</body>"))),
    );
    const hidden = `<!doctype html><html><body><!-- ${htmlReview()} --><script>${htmlReview()}</script></body></html>`;
    expect(existingReviewAppendixOffset(Buffer.from(hidden), "html")).toBe(
      Buffer.byteLength(hidden.slice(0, hidden.indexOf("</body>"))),
    );
  });

  test("validates canonical Markdown and HTML ownership fields", () => {
    const markdown = `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 2\n**Request Challenge:** ${CHALLENGE}\n\n### Findings\n\nNone.\n`;
    const html = `\n${htmlReview()}\n</body></html>\n`;
    expect(validateReviewAppendix(Buffer.from(markdown), expected)).toEqual({
      valid: true,
    });
    expect(validateReviewAppendix(Buffer.from(html), expected)).toEqual({
      valid: true,
    });
  });

  test("rejects conflicting HTML fields and later body content", () => {
    const duplicate = htmlReview(
      "READY",
      "<p><strong>Verdict:</strong> NOT-READY</p>",
    );
    expect(validateReviewAppendix(Buffer.from(duplicate), expected)).toMatchObject({
      valid: false,
    });
    expect(
      validateReviewAppendix(
        Buffer.from(`${htmlReview()}<p>outside review</p></body></html>`),
        expected,
      ),
    ).toMatchObject({ valid: false });
  });

  test("digest is byte-stable and sensitive to HTML appendix changes", () => {
    const appendix = Buffer.from(`\n${htmlReview()}\n</body></html>`);
    expect(reviewAppendixDigest(appendix)).toBe(reviewAppendixDigest(appendix));
    expect(reviewAppendixDigest(appendix)).not.toBe(
      reviewAppendixDigest(Buffer.from(`\n${htmlReview("NOT-READY")}\n</body></html>`)),
    );
  });

  test("reviewer protocol documents extension resolution and both exclusive forms", () => {
    const protocol = readFileSync(
      join(import.meta.dir, "../../core/aidlc-common/protocols/stage-protocol-reviewer.md"),
      "utf-8",
    );
    const prose = protocol.replace(/\s+/g, " ");
    expect(prose).toContain(
      "`.md` uses the Markdown appendix and `.html` uses the HTML appendix.",
    );
    expect(protocol).toContain("<section data-aidlc=\"review\">");
    expect(protocol).toContain("<p><strong>Verdict:</strong> READY|NOT-READY</p>");
    expect(protocol).toContain("Select by extension and never append both forms");
  });
});
