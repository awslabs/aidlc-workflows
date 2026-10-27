// covers: file:core/aidlc-common/protocols/stage-protocol.md, file:harness/claude/skills/aidlc/question-rendering.md, file:harness/codex/skills/aidlc/question-rendering.md
//
// t-long-question-asked-once: a question from the questions file with more
// options than the harness's question box takes is still one question, asked
// once with every option, as a numbered list in one message. Step 3a used to
// say to split it across structured questions ("options A-D first, then
// options E+"), and on Claude Code the person met it as two questions in one
// box ("part 1 of 2", "part 2 of 2"), as a second question with a choice the
// stage never wrote, or with its "None" option promised and never shown
// (#2920). Step 3a owns the rule; each annex gives only its box size and points
// at it. The numbered list is the shape AI-DLC already uses where a box cannot
// take a question (the Codex composer's four-choice gate, the one-choice
// question).
//
// Read from core, the authored annexes and every generated dist/ tree: the
// protocol is a projection, so the bytes that ship are checked too.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const HARNESS_NAMES = readdirSync(join(REPO_ROOT, "harness"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, "harness", entry.name, "manifest.ts")))
  .map((entry) => entry.name)
  .sort();

const manifests = new Map<string, HarnessManifest>();
for (const name of HARNESS_NAMES) {
  manifests.set(name, (await import(join(REPO_ROOT, "harness", name, "manifest.ts"))).default as HarnessManifest);
}

// Markdown wraps a bullet across lines; compare its words.
function words(path: string): string {
  return readFileSync(path, "utf-8").replace(/\s+/g, " ");
}

const ASKED_ONCE =
  "- A question from the questions file with more options than the harness's question tool takes (its " +
  "question-rendering annex gives the limit) is still one question, asked once with every option: ask it on its " +
  "own as a numbered list in one message, numbered and ended as the numbered-list bullet above says, never split " +
  "across calls or into more questions. The file retains the full option set as the authoritative record.";

const SPLIT_RULE = /splitting across multiple structured questions|options E\+|split across (multiple )?calls \(options/;

describe("a question past the question box is asked once", () => {
  test("Step 3a asks it once as a numbered list, in core and in every shipped tree", () => {
    const sources = [join(REPO_ROOT, "core", "aidlc-common", "protocols", "stage-protocol.md")];
    for (const name of HARNESS_NAMES) {
      sources.push(join(REPO_ROOT, "dist", name, manifests.get(name)?.harnessDir ?? "", "aidlc-common", "protocols", "stage-protocol.md"));
    }
    for (const source of sources) {
      const text = words(source);
      expect(text, source).toContain(ASKED_ONCE);
      expect(text, source).not.toMatch(SPLIT_RULE);
    }
  });

  test("Claude Code's annex keeps its box size and points at Step 3a, with the multi-select reply line", () => {
    const annex = words(join(REPO_ROOT, "harness", "claude", "skills", "aidlc", "question-rendering.md"));
    expect(annex).toContain("max 4 options per question");
    expect(annex).toContain(
      'A question from the questions file with more options is asked as a numbered list instead (stage-protocol.md ' +
        'Step 3a; a multi-select ends "Reply with all numbers that apply (e.g. 1, 3)."); the questions file retains ' +
        "the full option set as the authoritative record.",
    );
    expect(annex).not.toMatch(SPLIT_RULE);
  });

  test("Codex's annex keeps its box size and points at its numbered prose and Step 3a", () => {
    const annex = words(join(REPO_ROOT, "harness", "codex", "skills", "aidlc", "question-rendering.md"));
    expect(annex).toContain("2-3 options each");
    expect(annex).toContain(
      "A question from the questions file with more options is asked as numbered prose instead (Track 2, " +
        "stage-protocol.md Step 3a); the questions file retains the full option set as the authoritative record.",
    );
    expect(annex).not.toMatch(SPLIT_RULE);
  });

  test("the stage protocol reference says the same", () => {
    const reference = words(join(REPO_ROOT, "docs", "reference", "04-stage-protocol.md"));
    expect(reference).not.toContain("holds: split across calls");
    expect(reference).not.toContain("| Split across calls |");
    expect(reference).toContain("asked once as a numbered list in one message, never split across calls");
    expect(reference).toContain("| More options than one call holds | One numbered list in chat | One numbered list in chat |");
  });
});
