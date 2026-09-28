// Captured-output controls for the assertion also used by the live Kiro journey.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findIntentGroundingRegressions } from "../harness/intent-grounding-regressions.ts";

const fixture = join(import.meta.dir, "../fixtures/intent-grounding/kiro-overclaims");
const read = (name: string) => readFileSync(join(fixture, name), "utf8");
const description = "Build a simple React todo app";
function captured() {
  return {
    description,
    questions: read("intent-capture-questions.md"),
    artifacts: ["intent-statement.md", "stakeholder-map.md"].map((name) => ({ name, markdown: read(name) })),
  };
}
function checkClaim(claim: string, answer?: string) {
  return findIntentGroundingRegressions({
    description,
    questions: answer === undefined ? "" : `## Q9. Confirm this fact\n\n[Answer]: ${answer}\n`,
    artifacts: [{ name: "artifact.md", markdown: `## Target Customer\n\n${claim}` }],
  });
}

describe("intent-capture known grounding regressions", () => {
  test("the retained Kiro output exposes both unsupported claims despite populated citations", () => {
    const findings = findIntentGroundingRegressions(captured());
    expect(findings.map((f) => [f.kind, f.artifact])).toEqual([
      ["external-customers-excluded", "intent-statement.md"],
      ["developer-is-end-user", "stakeholder-map.md"],
    ]);
    for (const finding of findings) {
      expect(finding.citedSources).toEqual(["Q2", "Q5"]);
      expect(finding.claim.length).toBeGreaterThan(40);
    }
  });

  test("removing only the two unsupported additions clears the captured regression", () => {
    const input = captured();
    const intent = input.artifacts[0];
    const stakeholder = input.artifacts[1];
    const exclusion = " The application is single-user and personal in nature; it is not\n" +
      "aimed at teams or external product customers. [Q2] [Q5]";
    const identity = "; in this initiative the developer and end user needs are aligned under one person";
    expect(intent.markdown).toContain(exclusion);
    expect(stakeholder.markdown).toContain(identity);
    intent.markdown = intent.markdown.replace(exclusion, "");
    stakeholder.markdown = stakeholder.markdown.replace(identity, "");
    expect(findIntentGroundingRegressions(input)).toEqual([]);
  });

  test("unselected options and decision-making authority do not confirm either claim", () => {
    const input = captured();
    expect(input.questions).toContain("C. External customers of a product");
    expect(input.questions).toContain("D. Just me (developer/personal use)");
    expect(input.questions).toContain("[Answer]: A. Just me — I decide scope and priorities");
    expect(findIntentGroundingRegressions(input)).toHaveLength(2);
  });

  test.each([
    ["external-customers-excluded", "The app is not aimed at external customers. [Q9]", "External customers are excluded."],
    ["developer-is-end-user", "The developer and end user are the same person. [Q9]", "The developer and end user are the same person."],
  ])("explicit cited confirmation permits %s", (_kind, claim, answer) => {
    expect(checkClaim(claim, answer)).toEqual([]);
    expect(checkClaim(claim)).toHaveLength(1);
  });

  test("confirmed facts in an unrelated answer do not repair the cited answer", () => {
    const input = captured();
    input.questions += "\n## Q9. Explicit confirmations\n\n[Answer]: External customers are excluded. " +
      "The developer and end user are the same person.\n";
    expect(findIntentGroundingRegressions(input)).toHaveLength(2);
    for (const artifact of input.artifacts) artifact.markdown = artifact.markdown.replaceAll("[Q2] [Q5]", "[Q9]");
    expect(findIntentGroundingRegressions(input)).toEqual([]);
  });

  test("an artifact's own source register cannot authorize its unsupported content", () => {
    const input = captured();
    input.artifacts[0].markdown = input.artifacts[0].markdown.replace(
      "Customer: individual end users managing their own personal tasks.",
      "Customer: external customers are excluded.",
    );
    const findings = findIntentGroundingRegressions(input);
    expect(findings).toHaveLength(3);
    expect(findings.some((finding) => finding.claim.includes("Customer: external customers are excluded."))).toBe(true);
  });

  test("a selected bare answer label resolves only its chosen option", () => {
    const input = {
      description,
      questions: "## Q9. Confirm audience\n\n- A. External customers are excluded.\n- B. Individual users.\n\n[Answer]: B\n",
      artifacts: [{ name: "intent.md", markdown: "## Target Customer\n\nExternal customers are excluded. [Q9]" }],
    };
    expect(findIntentGroundingRegressions(input)).toHaveLength(1);
    input.questions = input.questions.replace("[Answer]: B", "[Answer]: A");
    expect(findIntentGroundingRegressions(input)).toEqual([]);
  });

  test.each(["D", "D. Just me (developer/personal use)"])(
    "actually selecting the captured customer/personal-use option supplies supporting evidence: %s",
    (answer) => {
      const input = captured();
      input.questions = input.questions.replace(
        "[Answer]: A. Individual end users managing their own personal tasks",
        `[Answer]: ${answer}`,
      );
      expect(findIntentGroundingRegressions(input)).toEqual([]);
    },
  );

  test("personal-use wording in a decision-authority question does not establish the audience", () => {
    const input = captured();
    input.questions = input.questions.replace(
      "[Answer]: A. Just me — I decide scope and priorities",
      "[Answer]: Just me (developer/personal use)",
    );
    expect(findIntentGroundingRegressions(input)).toHaveLength(2);
  });

  test.each(["Who are the customers?", "Audience\n\nWho will use this app?"])(
    "personal-use confirmation follows the customer question rather than a fixed heading: %s",
    (prompt) => {
      expect(findIntentGroundingRegressions({
        description,
        questions: `## Q9. ${prompt}\n\nA. Just me (developer/personal use)\n\n[Answer]: A\n`,
        artifacts: [{ name: "stakeholder.md", markdown:
          "## Stakeholders\n\nThe developer and end user are the same person. [Q9]" }],
      })).toEqual([]);
    },
  );

  test("mentioning end users in a decision-authority question is not a customer confirmation", () => {
    expect(findIntentGroundingRegressions({
      description,
      questions: "## Q9. Who decides what end users need?\n\n[Answer]: Just me (developer/personal use)\n",
      artifacts: [{ name: "stakeholder.md", markdown:
        "## Stakeholders\n\nThe developer and end user are the same person. [Q9]" }],
    })).toHaveLength(1);
  });

  test.each([
    "[Q9](https://example.invalid/)",
    "`[Q9]`",
    "[Q9][support]\n\n[support]: https://example.invalid/",
    "[Q9][]\n\n[Q9]: https://example.invalid/",
    "[Q9]\n\n[Q9]: https://example.invalid/",
  ])("a link or code tag cannot borrow an unrelated answer's confirmation: %s", (citation) => {
    expect(findIntentGroundingRegressions({
      description,
      questions: "## Q2. Audience\n\n[Answer]: Individual users.\n\n" +
        "## Q9. Audience boundary\n\n[Answer]: External customers are excluded.\n",
      artifacts: [{ name: "intent.md", markdown:
        `## Target Customer\n\nExternal customers are excluded. [Q2] ${citation}` }],
    })).toHaveLength(1);
  });

  test("blank and duplicate answers do not provide confirmation", () => {
    expect(checkClaim("External customers are excluded. [Q9]", "")).toHaveLength(1);
    const input = captured();
    input.questions += "\n## Q2. Duplicate\n\n[Answer]: External customers are excluded.\n";
    expect(findIntentGroundingRegressions(input)).toHaveLength(2);
  });

  test("a later summary or approval answer cannot fill an unanswered question", () => {
    expect(findIntentGroundingRegressions({
      description,
      questions: "## Q9. Confirm audience\n\n[Answer]:\n\n## Consolidated Summary Confirmation\n\n" +
        "[Answer]: External customers are excluded.\n",
      artifacts: [{ name: "intent.md", markdown: "## Target Customer\n\nExternal customers are excluded. [Q9]" }],
    })).toHaveLength(1);
  });

  test.each([
    "<!--\n[Answer]: External customers are excluded.\n-->",
    "```example\n[Answer]: External customers are excluded.\n```",
    "> [Answer]: External customers are excluded.",
  ])("hidden or quoted answer examples do not confirm a claim: %s", (example) => {
    expect(findIntentGroundingRegressions({
      description,
      questions: `## Q9. Confirm audience\n\n${example}\n\n[Answer]: Individual users.\n`,
      artifacts: [{ name: "intent.md", markdown: "## Target Customer\n\nExternal customers are excluded. [Q9]" }],
    })).toHaveLength(1);
  });

  test("conflicting answer rows do not provide confirmation", () => {
    expect(findIntentGroundingRegressions({
      description,
      questions: "## Q9. Confirm audience\n\n[Answer]: External customers are excluded.\n\n[Answer]: Not decided.\n",
      artifacts: [{ name: "intent.md", markdown: "## Target Customer\n\nExternal customers are excluded. [Q9]" }],
    })).toHaveLength(1);
  });

  test("the authoritative test description may confirm a claim when it is cited", () => {
    const input = captured();
    input.description += " External customers are excluded. The developer and end user are the same person.";
    expect(findIntentGroundingRegressions(input)).toHaveLength(2);
    for (const artifact of input.artifacts) artifact.markdown = artifact.markdown.replaceAll("[Q2] [Q5]", "[desc]");
    expect(findIntentGroundingRegressions(input)).toEqual([]);
  });

  test.each([
    "External customers are not excluded. [Q9]",
    "External customers are not necessarily excluded. [Q9]",
    "The app does not exclude external customers. [Q9]",
    "The app does not exclude any external customers. [Q9]",
    "The app doesn't exclude external customers. [Q9]",
    "External customers aren’t excluded. [Q9]",
    "The app is not intended for only external customers. [Q9]",
    "The app is not limited to external customers. [Q9]",
    "The app is not intended exclusively for external customers. [Q9]",
    "The developer and end user are not necessarily the same person. [Q9]",
    "The developer and end user aren't the same person. [Q9]",
    "The developer and end user have aligned needs. [Q9]",
    "Whether the developer and end user are the same person is unknown. [Q9]",
    "Are the developer and end user the same person? [Q9]",
  ])("does not mistake qualification or uncertainty for the known assertion: %s", (claim) => {
    expect(checkClaim(claim)).toEqual([]);
  });

  test("confirmed answers that deny a claim cannot support its affirmative version", () => {
    expect(checkClaim("External customers are excluded. [Q9]", "External customers are not excluded.")).toHaveLength(1);
    expect(checkClaim("External customers are excluded. [Q9]", "The app does not exclude external customers.")).toHaveLength(1);
    expect(checkClaim("The developer and end user are the same person. [Q9]",
      "The developer and end user are not the same person.")).toHaveLength(1);
  });

  test.each([
    "The app is **not intended for** external product customers. [Q9]",
    "No external customers are in scope. [Q9]",
    "External customers are out of scope. [Q9]",
    "The developer is also the end user. [Q9]",
    "| End user | The developer and end user are one person | [Q9] |",
    "- The developer and end user needs are\n  aligned under one person. [Q9]",
    "- The app is not aimed at teams or\n  external product customers. [Q9]",
  ])("recognizes captured claim variants: %s", (claim) => {
    expect(checkClaim(claim)).toHaveLength(1);
  });

  test("labelled assumptions are separate from facts; the sensor owns their confirmation", () => {
    const markdown = "The developer and end user are the same person. [assumption]";
    expect(findIntentGroundingRegressions({
      description, questions: "",
      artifacts: [{ name: "stakeholder.md", markdown: `## Assumptions & Open Questions\n\n${markdown}` }],
    })).toEqual([]);
    expect(checkClaim(markdown)).toHaveLength(1);
  });

  test("subheadings retain their enclosing assumptions section", () => {
    expect(findIntentGroundingRegressions({
      description, questions: "",
      artifacts: [{ name: "intent.md", markdown:
        "## Assumptions & Open Questions\n\n### Audience\n\nExternal customers are excluded. [assumption]\n\n" +
        "## Target Customer\n\n### Audience\n\nExternal customers are excluded. [Q9]\n" }],
    })).toHaveLength(1);
  });

  test("code examples, comments and legacy review notes are not producer claims", () => {
    const claim = "External customers are excluded. [Q9]";
    expect(findIntentGroundingRegressions({
      description, questions: "",
      artifacts: [{ name: "intent.md", markdown:
        `## Sources\n\n[Q9] Audience question.\n\n## Target Customer\n\n<!-- ${claim} -->\n\n` +
        `\`\`\`text\n${claim}\n\`\`\`\n\n## Review\n\n${claim}\n` }],
    })).toEqual([]);
  });

  test("a Sources heading does not exempt an unsupported source summary", () => {
    expect(findIntentGroundingRegressions({
      description,
      questions: "## Q9. Audience\n\n[Answer]: Individual users.\n",
      artifacts: [{ name: "intent.md", markdown:
        "## Sources\n\n- [Q9] External customers are excluded.\n\n## Target Customer\n\nIndividual users. [Q9]" }],
    })).toHaveLength(1);
  });
});
