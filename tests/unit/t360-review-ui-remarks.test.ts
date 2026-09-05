import { describe, expect, test } from "bun:test";
import { parseReviewUiRemarks } from "../../core/tools/aidlc-review-ui-workflow.ts";

describe("review UI sent remarks", () => {
  test("parses artifact, location, quote, body, and edit diff", () => {
    const source = [
      "# Review feedback: requirements-analysis (revision 1)",
      "",
      "## requirements.md",
      "",
      "### Comment · a7 — Functional requirements › FR2 (lines ~9-9)",
      "> The user can mark a task complete.",
      "",
      "Clarify whether this can be undone.",
      "",
      "### Edit (unified diff) · a8",
      "```diff",
      "--- a/requirements.md",
      "+++ b/requirements.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "```",
    ].join("\n");

    expect(parseReviewUiRemarks(source)).toEqual([
      {
        id: "a7",
        kind: "comment",
        artifact: "requirements.md",
        heading_path: ["Functional requirements", "FR2"],
        quote: "The user can mark a task complete.",
        body: "Clarify whether this can be undone.",
        diff: null,
        reply_to: null,
      },
      {
        id: "a8",
        kind: "edit",
        artifact: "requirements.md",
        heading_path: [],
        quote: null,
        body: null,
        diff: "--- a/requirements.md\n+++ b/requirements.md\n@@ -1 +1 @@\n-old\n+new\n",
        reply_to: null,
      },
    ]);
  });

  test("keeps labels and deletes nullable when no prose follows", () => {
    const source = [
      "## design.md",
      "",
      "### Label · a1 — Overview (element: article > p)",
      "`needs evidence`",
      "",
      "### Delete · a2",
      "> Obsolete sentence",
    ].join("\n");

    expect(parseReviewUiRemarks(source)).toEqual([
      {
        id: "a1",
        kind: "label",
        artifact: "design.md",
        heading_path: ["Overview"],
        quote: null,
        body: "`needs evidence`",
        diff: null,
        reply_to: null,
      },
      {
        id: "a2",
        kind: "delete",
        artifact: "design.md",
        heading_path: [],
        quote: "Obsolete sentence",
        body: null,
        diff: null,
        reply_to: null,
      },
    ]);
  });

  test("parses legacy headings and synthesizes stable file-scoped identifiers", () => {
    const source = [
      "## requirements.md",
      "",
      "### Looks good — Functional requirements",
      "> Good sentence",
      "",
      "### Delete — Functional requirements",
      "> Remove this sentence",
      "",
      "This is obsolete.",
    ].join("\n");

    expect(parseReviewUiRemarks(source, "feedback-001")).toEqual([
      {
        id: "feedback-001-1",
        kind: "looks-good",
        artifact: "requirements.md",
        heading_path: ["Functional requirements"],
        quote: "Good sentence",
        body: null,
        diff: null,
        reply_to: null,
      },
      {
        id: "feedback-001-2",
        kind: "delete",
        artifact: "requirements.md",
        heading_path: ["Functional requirements"],
        quote: "Remove this sentence",
        body: "This is obsolete.",
        diff: null,
        reply_to: null,
      },
    ]);
  });

  test("reads the reply-to suffix a threaded follow-up carries", () => {
    const source = [
      "## requirements.md",
      "",
      "### Comment · a9 · reply to a7 — Functional requirements › FR2 (lines ~3-3)",
      "> The user can mark a task complete.",
      "",
      "Agreed — and keep the deleted task visible for a moment.",
      "",
    ].join("\n");

    expect(parseReviewUiRemarks(source)).toEqual([
      {
        id: "a9",
        kind: "comment",
        artifact: "requirements.md",
        heading_path: ["Functional requirements", "FR2"],
        quote: "The user can mark a task complete.",
        body: "Agreed — and keep the deleted task visible for a moment.",
        diff: null,
        reply_to: "a7",
      },
    ]);
  });
});
