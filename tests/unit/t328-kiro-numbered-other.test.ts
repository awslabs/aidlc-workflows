// covers: doc:harness/kiro/skills/aidlc/question-rendering.md(numbered-other), doc:harness/kiro-ide/skills/aidlc/question-rendering.md(numbered-other),
// function:kiroIdeBinCandidates, function:kiroIdeMissingBinaryReason

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findCompleteNumberedListByLabels,
  kiroIdeBinCandidates,
  kiroIdeMissingBinaryReason,
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
      "this interaction-mode question has four visible\nnumbered lines",
    );
    expect(CORE_PROTOCOL).toContain("the final\n`4. Other`");
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


// The Kiro IDE gates treat a missing binary as a SKIP REASON, so a stale default
// path does not fail loudly: it makes the whole live journey skip while the file
// still reports PASS. That happened here - Kiro renamed its macOS executable from
// the stock Electron name to `Kiro`, and the gate silently stopped running. These
// pins keep the probe honest and make the next rename say so out loud.
describe("t328 Kiro IDE launch-binary resolution (a skip is an unmet gate)", () => {
  test("macOS probes the current Kiro executable BEFORE the retired Electron name", () => {
    const candidates = kiroIdeBinCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    if (process.platform === "darwin") {
      expect(candidates[0]).toBe("/Applications/Kiro.app/Contents/MacOS/Kiro");
      expect(candidates).toContain("/Applications/Kiro.app/Contents/MacOS/Electron");
      // Order is the contract: a machine carrying both must launch the new one.
      expect(candidates.indexOf("/Applications/Kiro.app/Contents/MacOS/Kiro"))
        .toBeLessThan(candidates.indexOf("/Applications/Kiro.app/Contents/MacOS/Electron"));
    } else if (process.platform === "win32") {
      expect(candidates[0]).toEndWith("Kiro.exe");
    }
  });

  test("the missing-binary reason names every path tried, or the override", () => {
    const previous = process.env.AIDLC_KIRO_IDE_BIN;
    try {
      delete process.env.AIDLC_KIRO_IDE_BIN;
      const reason = kiroIdeMissingBinaryReason("/nowhere/Kiro");
      for (const candidate of kiroIdeBinCandidates()) {
        expect(reason, candidate).toContain(candidate);
      }
      expect(reason).toContain("AIDLC_KIRO_IDE_BIN");

      process.env.AIDLC_KIRO_IDE_BIN = "/custom/path/Kiro";
      const overridden = kiroIdeMissingBinaryReason("/custom/path/Kiro");
      expect(overridden).toContain("AIDLC_KIRO_IDE_BIN=/custom/path/Kiro");
    } finally {
      if (previous === undefined) delete process.env.AIDLC_KIRO_IDE_BIN;
      else process.env.AIDLC_KIRO_IDE_BIN = previous;
    }
  });
});
