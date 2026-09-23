// covers: file:knowledge/aidlc-product-lead-agent/reviewing.md, file:knowledge/aidlc-architecture-reviewer-agent/reviewing.md
//
// t200 - reviewer Date-sourcing pin. The `## Review` template's **Date:**
// field is model-authored prose with no engine-side timestamp fill, so the
// template must carry the procedure (run `date -u` in the shell, paste the
// output), not just the format. A bare `[ISO timestamp]` placeholder lets
// the reviewer guess the date, and guessed dates drift from the timestamps
// the CLI tools record for the same stage.
//
// Mechanism: none. Pure content check over the shipped knowledge bytes
// (AIDLC_SRC = dist/claude/.claude; the other trees are byte-guarded by
// package.ts --check).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const FILES = [
  ["aidlc-product-lead-agent", "knowledge/aidlc-product-lead-agent/reviewing.md"],
  ["aidlc-architecture-reviewer-agent", "knowledge/aidlc-architecture-reviewer-agent/reviewing.md"],
] as const;

describe("t200 reviewer Date field carries a sourcing instruction", () => {
  for (const [agent, rel] of FILES) {
    test(`${agent}: template instructs date -u in the shell and forbids guessing`, () => {
      const body = readFileSync(join(AIDLC_SRC, rel), "utf-8");
      const dateLines = body.split("\n").filter((l) => l.startsWith("**Date:**"));
      // Exactly one Date line (the template), and it is no longer the bare
      // format-only placeholder.
      expect(dateLines.length).toBe(1);
      expect(dateLines[0]).not.toBe("**Date:** [ISO timestamp]");
      // The sourcing instruction: the exact date command, and an explicit
      // prohibition on guessing.
      expect(body).toContain('date -u +"%Y-%m-%dT%H:%M:%SZ"');
      expect(body.toLowerCase()).toContain("guess");
    });

    test(`${agent}: template attributes the review to the reviewer persona, not the producer`, () => {
      // The maker-checker split exists so the review record shows an
      // independent checker; a template stamping the PRODUCER's name would
      // misattribute every review to the agent that wrote the artifact.
      const body = readFileSync(join(AIDLC_SRC, rel), "utf-8");
      const reviewerLines = body.split("\n").filter((l) => l.startsWith("**Reviewer:**"));
      expect(reviewerLines.length).toBe(1);
      expect(reviewerLines[0]).toBe(`**Reviewer:** ${agent}`);
    });

    test(`${agent}: template states the heading rule before the review is written`, () => {
      // A verdict is refused when the review carries a second top-level
      // heading, and a reviewer writing a structured document reaches for one
      // by habit. The constraint used to appear only in the refusal, by which
      // point the whole file has to be rewritten — so the template the reviewer
      // reads FIRST has to carry it.
      const body = readFileSync(join(AIDLC_SRC, rel), "utf-8");
      const guidance = body.slice(0, body.indexOf("Use this exact format:"));
      expect(guidance).toContain("only top-level heading");
      expect(guidance).toContain("`###` or deeper");
      expect(guidance).toContain("the verdict is refused");
      expect(guidance).toContain("bold lead-in");
    });
  }
});
