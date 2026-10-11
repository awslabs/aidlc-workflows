// covers: file:knowledge/aidlc-product-lead-agent/reviewing.md, file:knowledge/aidlc-architecture-reviewer-agent/reviewing.md
//
// t200 - reviewer Date-sourcing pin. The `## Review` template's **Date:**
// field is model-authored prose, so the template must carry where the time
// comes from, not just the format. A bare `[ISO timestamp]` placeholder lets
// the reviewer guess the date, and guessed dates drift from the timestamps
// the CLI tools record for the same stage.
//
// The source is now the dispatch brief: the review request the conductor runs
// before every dispatch returns `reviewed_at` from the engine's own clock, and
// the brief carries it as `Date for this review:`. The reviewer runs no command
// of its own, because on Claude Code it spelled the engine by absolute path,
// which no Bash allow rule covers, and the person was asked to approve an
// AI-DLC internal step in the middle of their review.
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
    test(`${agent}: template names where the time comes from and forbids guessing`, () => {
      const body = readFileSync(join(AIDLC_SRC, rel), "utf-8");
      const dateLines = body.split("\n").filter((l) => l.startsWith("**Date:**"));
      // Exactly one Date line (the template), and it is no longer the bare
      // format-only placeholder.
      expect(dateLines.length).toBe(1);
      expect(dateLines[0]).not.toBe("**Date:** [ISO timestamp]");
      // The sourcing instruction: the engine's clock, handed over in the
      // dispatch brief, with no command of the reviewer's own and an explicit
      // prohibition on guessing.
      expect(body).toContain("the UTC time the dispatch brief names on its `Date for this review:` line");
      expect(body).toContain("run no command for it");
      expect(body).not.toContain("engine now");
      expect(body).not.toContain("date -u");
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

    test(`${agent}: template states the findings table rule before the review is written`, () => {
      // A shortened report or a "no findings" placeholder row is refused and
      // costs a whole reviewer run, so the rule sits beside the other rules
      // the reviewer reads before the template.
      const body = readFileSync(join(AIDLC_SRC, rel), "utf-8");
      const guidance = body.slice(0, body.indexOf("Use this exact format:"));
      expect(guidance).toContain("The engine owns finding");
      expect(guidance).toContain("decided finding is settled and read-only");
      expect(guidance).toContain("New findings have");
      expect(guidance).toContain("no ID or status");
      expect(guidance).toContain("Keep both table headers");
      expect(guidance).toContain("A placeholder row is refused");
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
