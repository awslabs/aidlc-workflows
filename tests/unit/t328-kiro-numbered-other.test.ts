// covers: doc:harness/kiro/skills/aidlc/question-rendering.md(numbered-other), doc:harness/kiro-ide/skills/aidlc/question-rendering.md(numbered-other)

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findCompleteNumberedListByLabels,
  type KiroIdeNumberedListSnapshot,
  numberedListMarkersAreVisible,
} from "../harness/kiro-ide-driver.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const ANNEXES = [
  "harness/kiro/skills/aidlc/question-rendering.md",
  "harness/kiro-ide/skills/aidlc/question-rendering.md",
] as const;
const KIRO_SKILLS = [
  "harness/kiro/skills/aidlc/SKILL.md",
  "harness/kiro-ide/skills/aidlc/SKILL.md",
] as const;
const CORE_PROTOCOL = readFileSync(
  join(REPO_ROOT, "core/aidlc-common/protocols/stage-protocol.md"),
  "utf-8",
);

function readAnnex(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

function section(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}`);
  expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
  const end = body.indexOf("\n## ", start + 4);
  return body.slice(start, end < 0 ? undefined : end);
}

function numberedList(labels: string[]): KiroIdeNumberedListSnapshot {
  return {
    targetType: "iframe",
    targetUrl: "vscode-webview://chat",
    context: { id: 1 },
    href: "vscode-webview://chat",
    listStyleType: "decimal",
    start: 1,
    items: labels.map((text, index) => ({
      ordinal: index + 1,
      text,
      display: "list-item",
      listStyleType: "decimal",
      visibility: "visible",
      opacity: "1",
      markerContent: "normal",
      markerColor: "rgb(255, 255, 255)",
      markerFontSize: "14px",
      markerOpacity: "1",
    })),
  };
}

describe("t328 Kiro numbered Other rendering contract", () => {
  test("Kiro CLI and IDE annexes stay aligned", () => {
    const normalized = ANNEXES.map((rel) =>
      readAnnex(rel).replaceAll(/Kiro (?:CLI|IDE)/g, "Kiro HARNESS")
    );
    expect(normalized[0]).toBe(normalized[1]);
  });

  test("the interaction-mode example visibly renders Other as option 4", () => {
    for (const rel of ANNEXES) {
      const mode = section(readAnnex(rel), "Canonical interaction-mode rendering");
      expect(mode, rel).toContain(
        "4. **Other** — describe what you want instead",
      );
      expect(mode.match(/^4\. \*\*Other\*\*/gm) ?? [], rel).toHaveLength(1);
      expect(mode, rel).toContain(
        "Mentioning Other elsewhere in the message is not a substitute",
      );

      const invariant = section(readAnnex(rel), "Pre-send invariant");
      expect(invariant, rel).toContain("the final numbered line is an Other choice");
      expect(invariant, rel).toContain("exactly one numbered Other choice is present");
      expect(invariant, rel).toContain(
        "its number is one greater than the non-Other option count",
      );
    }
  });

  test("file-backed Other is remapped once and summary confirmation stays unlettered", () => {
    for (const rel of ANNEXES) {
      const body = readAnnex(rel);
      expect(body, rel).toContain('**Exactly one final "Other" escape**');
      expect(body, rel).toContain(
        "file-backed question already ends with `X. Other (please specify)`",
      );
      expect(body, rel).toContain(
        "do not append a\n  second Other",
      );
      expect(body, rel).toContain(
        "file options have no source letters and no file-level Other row",
      );

      const summary = section(body, "Mandatory consolidated-summary checkpoint");
      expect(summary.match(/^3\. \*\*Other\*\*/gm) ?? [], rel).toHaveLength(1);
      expect(summary, rel).toContain("both options without A/B file-letter prefixes");
      expect(summary, rel).toContain(
        "The numbered `3. Other` is mandatory in chat",
      );
      expect(summary, rel).toContain("it never adds a file option");
    }
  });

  test("summary and approval Other escape behavior agrees across core and Kiro skills", () => {
    expect(CORE_PROTOCOL).toContain(
      "A harness-supplied\n**Other** escape is an offered UI choice",
    );
    expect(CORE_PROTOCOL).toContain(
      "An explicit **Other** selection follows the §1 Other-escape rule",
    );
    for (const rel of KIRO_SKILLS) {
      const body = readAnnex(rel);
      expect(body, rel).toContain(
        "**Kiro numbered-question preflight (non-negotiable):**",
      );
      expect(body, rel).toContain(
        "`1. Guide me`, `2. I'll edit the file`, `3. Chat`, `4. Other`",
      );
      expect(body, rel).toContain(
        "A prose tip or sentence mentioning Other does\nnot count",
      );
      expect(body.match(/If the reply is \*\*Other\*\*/g) ?? [], rel).toHaveLength(2);
      expect(body, rel).toContain("re-present all three visible choices");
      expect(body, rel).toContain(
        "every offered semantic choice plus the final numbered Other",
      );
    }
    expect(CORE_PROTOCOL).toContain(
      "On a numbered-prose harness that gives five visible lines",
    );
    expect(CORE_PROTOCOL).toContain(
      "without `review_ui`, retain the existing\nthree semantic options plus Other",
    );
  });

  test("a streaming three-option prefix is not accepted as the completed mode list", () => {
    const labels = ["Guide me", "I'll edit the file", "Chat", "Other"];
    const partial = numberedList(labels.slice(0, 3));
    const complete = numberedList(labels);
    const duplicate = numberedList([...labels, "Other"]);

    expect(findCompleteNumberedListByLabels([partial], labels)).toBeNull();
    expect(findCompleteNumberedListByLabels([partial, complete], labels)).toBe(complete);
    expect(findCompleteNumberedListByLabels([duplicate], labels)).toBeNull();
  });

  test("marker proof rejects hidden or non-generated option numbers", () => {
    const visible = numberedList(["Guide me", "I'll edit the file", "Chat", "Other"]);
    expect(numberedListMarkersAreVisible(visible)).toBe(true);

    for (const patch of [
      { display: "block" },
      { listStyleType: "none" },
      { visibility: "hidden" },
      { opacity: "0" },
      { markerContent: "none" },
      { markerColor: "rgba(0, 0, 0, 0)" },
      { markerFontSize: "0px" },
      { markerOpacity: "0" },
      { markerContent: '"•"' },
      { markerContent: '"1."' },
    ]) {
      const hidden = structuredClone(visible);
      Object.assign(hidden.items[3], patch);
      expect(numberedListMarkersAreVisible(hidden), JSON.stringify(patch)).toBe(false);
    }
  });
});
