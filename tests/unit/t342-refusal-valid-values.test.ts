// covers: function:parseReviewSection function:validReviewFindingStatus
//
// t342 - refusals on the review path must name what WOULD satisfy them, not only the
// value they rejected (#1082). The accepted set was already reachable at each throw
// and went unprinted, so the reader learned what was wrong and had to read the source
// to learn what was right.

import { describe, expect, test } from "bun:test";
import {
  parseReviewSection,
  REVIEW_FINDING_STATUS_VALUES,
  SUMMARY_CONFIRMATION_HASH_SCOPE,
  validReviewFindingStatus,
} from "../../core/tools/aidlc-lib.ts";

function reviewWithStatus(status: string): string {
  return [
    "**Verdict:** NOT-READY",
    "",
    "### Findings",
    "",
    "| ID | Severity | Location | Finding | Required action | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    `| R-02 | major | a.md:1 | x | y | ${status} |`,
  ].join("\n");
}

describe("t342 refusals name their accepted values", () => {
  test("an invalid finding status names the enum", () => {
    // "Fixed" is a plausible thing to type once a human has fixed something, so the
    // enum has to be named rather than implied.
    let message = "";
    try {
      parseReviewSection(reviewWithStatus("Fixed"), "core/user-stories/user-stories.md");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('invalid finding status "Fixed"');
    for (const value of ["New", "Unresolved", "Resolved", "Accepted risk", "Rejected:"]) {
      expect(message, `should name ${value}`).toContain(value);
    }
  });

  test("the fixed status source drives the predicate and rendered message", () => {
    for (const accepted of ["New", "Unresolved", "Resolved", "Accepted risk", "Rejected: too costly"]) {
      expect(validReviewFindingStatus(accepted), `${accepted} should be valid`).toBe(true);
      const label = accepted.startsWith("Rejected:") ? "Rejected: <reason>" : accepted;
      expect(REVIEW_FINDING_STATUS_VALUES).toContain(label);
    }
  });

  test("rejected status requires a non-whitespace reason", () => {
    for (const rejected of ["Fixed", "Done", "", "Rejected:", "Rejected: ", "Rejected:  reason"]) {
      expect(validReviewFindingStatus(rejected), `${rejected} should be invalid`).toBe(false);
    }
    expect(validReviewFindingStatus("Rejected: reason")).toBe(true);
  });

  test("a valid status still parses, so the message change did not alter behaviour", () => {
    const parsed = parseReviewSection(reviewWithStatus("Unresolved"), "core/a.md");
    expect(parsed.verdict).toBe("NOT-READY");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].status).toBe("Unresolved");
  });

  test("the supported summary-confirmation hash scope is a named constant", () => {
    // The refusal prints this rather than a literal, so an unsupported-scope message
    // cannot advertise a scope the checker does not accept.
    expect(SUMMARY_CONFIRMATION_HASH_SCOPE).toBe("confirmed-content-v1");
  });
});
