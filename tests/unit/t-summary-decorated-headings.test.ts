// covers: function:headingKey, function:summaryConfirmationContentHash
//
// #1385 follow-up. The claim-sources sensor reads a Q<n> or Assumption
// Confirmation heading behind a leading emoji as the section it names, but the
// summary confirmation digest needed the exact spelling: a decorated follow-up
// question after the Consolidated Summary Confirmation stopped the gate with
// "unsupported H2 heading". Both now read contract headings through one rule,
// and an undecorated questions file digests exactly as it did before.

import { describe, expect, test } from "bun:test";
import { headingKey } from "../../dist/claude/.claude/tools/aidlc-artifact-vocabulary.ts";
import { summaryConfirmationContentHash } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const INFO = "\u2139\uFE0F"; // information sign, emoji presentation
const QUESTION = "\u2753"; // red question mark

const QUESTIONS = [
  "# Requirements Analysis Questions",
  "",
  "## Q1. Which users sign in?",
  "",
  "A. Staff only",
  "B. Staff and customers",
  "X. Other (please specify)",
  "",
  "[Answer]: B",
  "",
  "## Q2: Where is data stored?",
  "",
  "[Answer]: In the EU region",
  "",
  "## Consolidated Summary Confirmation",
  "",
  "Staff and customers sign in; data stays in the EU region.",
  "",
  "[Answer]: Looks correct",
  "",
  "---",
  "",
  "## Assumption Confirmation",
  "",
  "- [assumption] Customers use email sign-in.",
  "",
  "[Answer]: A. Accept assumptions",
  "",
  "## Requested Changes Feedback",
  "",
  "[Answer]: Add an audit log.",
  "",
  "## Q3. How long are audit logs kept?",
  "",
  "[Answer]: One year",
  "",
].join("\n");

// The digest of QUESTIONS on main before decorated headings were read (91be5bb9c).
const UNDECORATED_DIGEST = "803300063421a34531ab86949eb1b96c33660bed7e83edc9414cebca4c2ae5e9";

const decorate = (content: string, heading: string, emoji: string): string => {
  expect(content).toContain(`## ${heading}`);
  return content.replace(`## ${heading}`, `## ${emoji} ${heading}`);
};

describe("headingKey", () => {
  test("reads past a leading emoji run and nothing else", () => {
    expect(headingKey(`${INFO} Sources`)).toBe("Sources");
    expect(headingKey(`${QUESTION} Q1.`)).toBe("Q1.");
    expect(headingKey(`${INFO}\u200D\u{1F4A1} Sources`)).toBe("Sources");
    expect(headingKey("Sources")).toBe("Sources");
    // A text-presentation symbol, or an emoji with no space after it, is part of the name.
    expect(headingKey("\u2139 Sources")).toBe("\u2139 Sources");
    expect(headingKey(`${QUESTION}Q1.`)).toBe(`${QUESTION}Q1.`);
  });
});

describe("summary confirmation digest reads decorated contract headings", () => {
  test("an undecorated questions file digests exactly as before", () => {
    expect(summaryConfirmationContentHash(QUESTIONS)).toBe(UNDECORATED_DIGEST);
  });

  test("a decorated Assumption Confirmation after the checkpoint is excluded like the plain one", () => {
    const decorated = decorate(QUESTIONS, "Assumption Confirmation", INFO);
    expect(summaryConfirmationContentHash(decorated)).toBe(UNDECORATED_DIGEST);
    // Its body is outside the confirmed content, as for the plain heading.
    expect(summaryConfirmationContentHash(
      decorated.replace("Customers use email sign-in.", "Customers use SSO."),
    )).toBe(UNDECORATED_DIGEST);
    // A second one, decorated or not, is still a duplicate.
    expect(() => summaryConfirmationContentHash(
      `${decorated}\n## Assumption Confirmation\n\n[Answer]: A. Accept assumptions\n`,
    )).toThrow('duplicate H2 section "Assumption Confirmation"');
  });

  test("a decorated follow-up question after the checkpoint is confirmed content", () => {
    const decorated = decorate(QUESTIONS, "Q3.", QUESTION);
    const digest = summaryConfirmationContentHash(decorated);
    expect(digest).not.toBe(UNDECORATED_DIGEST);
    expect(summaryConfirmationContentHash(decorated.replace("One year", "Ten years"))).not.toBe(digest);
    // It ends the Assumption Confirmation exclusion just as `## Q3.` does.
    const afterAssumptions = decorate(
      QUESTIONS.replace("## Requested Changes Feedback\n\n[Answer]: Add an audit log.\n\n", ""),
      "Q3.",
      QUESTION,
    );
    expect(summaryConfirmationContentHash(afterAssumptions.replace("One year", "Ten years")))
      .not.toBe(summaryConfirmationContentHash(afterAssumptions));
  });

  test("a decorated question is counted before and after the checkpoint", () => {
    expect(() => summaryConfirmationContentHash(decorate(QUESTIONS, "Q2:", QUESTION))).not.toThrow();
    expect(() => summaryConfirmationContentHash(
      QUESTIONS.replace("## Q2:", `## ${QUESTION} Q1:`),
    )).toThrow('duplicate H2 section "Q1"');
    expect(() => summaryConfirmationContentHash(
      QUESTIONS.replace("## Q3.", `## ${QUESTION} Q2.`),
    )).toThrow('duplicate H2 section "Q2"');
  });

  test("a decorated question spelled inside code still ends the exclusion", () => {
    const spelled = QUESTIONS.replace(
      "- [assumption] Customers use email sign-in.",
      ["```text", `## ${QUESTION} Q9.`, "```", "", "Retained after the spelling."].join("\n"),
    );
    expect(summaryConfirmationContentHash(spelled.replace("Retained after", "Changed after")))
      .not.toBe(summaryConfirmationContentHash(spelled));
  });

  test("any other heading after the checkpoint is still refused, quoted as written", () => {
    for (const heading of [`${QUESTION} Notes`, "Notes", "\u2139 Assumption Confirmation", `${QUESTION}Q3.`]) {
      expect(() => summaryConfirmationContentHash(`${QUESTIONS}\n## ${heading}\n`))
        .toThrow(`unsupported H2 heading "${heading}"`);
    }
  });
});
