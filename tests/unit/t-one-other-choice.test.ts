// covers: file:skills/aidlc/question-rendering.md
//
// A question shows exactly one Other choice. Every ordinary question in a
// questions file already ends with `X. Other (please specify)` (stage-protocol.md
// section 3), so an annex that tells the agent to always append its own Other,
// on the claim that the spec's options never include one, lists Other twice on
// every question walked through from a questions file. The annexes that render
// Other themselves say to append it only when the options have none, and to
// map an existing `X. Other` row to the last number otherwise. Read from every
// shipped tree's own annex.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

describe("t-one-other-choice", () => {
  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: the question annex never adds a second Other to a question that has one",
    (_name, harness) => {
      const annex = join(harness.skillsRoot, "aidlc", "question-rendering.md");
      expect(existsSync(annex)).toBe(true);
      const text = read(annex).replace(/\s+/g, " ");
      expect(text).not.toContain('Always append an "Other" escape');
      expect(text).not.toContain("the spec's options never include one");
      // An annex that appends Other itself keeps a questions file's own X. Other as the one.
      if (text.includes("append `Other`")) expect(text).toContain("do not append a second Other");
    },
  );
});
