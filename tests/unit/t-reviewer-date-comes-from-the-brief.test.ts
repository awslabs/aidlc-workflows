// covers: file:core/knowledge/aidlc-product-lead-agent/reviewing.md, file:core/knowledge/aidlc-architecture-reviewer-agent/reviewing.md, file:core/aidlc-common/protocols/stage-protocol-reviewer.md
//
// In two live runs on Claude Code the product-lead reviewer subagent ran
// `bun <absolute project dir>/.claude/tools/aidlc.ts engine now` for the one
// thing it needed a command for: the UTC time of its review's `**Date:**`
// line. The shipped allow rule matches the command text as written
// (`Bash(bun .claude/tools/aidlc.ts engine *)`), so the absolute form did not
// match it and the person was asked to allow an AI-DLC internal step, twice in
// one review.
//
// The time is mechanical, so a tool hands it over: the review request the
// conductor already runs before every dispatch returns `reviewed_at` (pinned
// behaviourally in t115), the conductor carries it into the dispatch brief,
// and the reviewer writes its Date from the brief. These are the prose halves:
// both reviewer templates read the date from the brief and tell the reviewer
// to run no command for it, and the protocol step tells the conductor to carry
// it. Without all three the tool's new field is never read.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const REVIEWER_TEMPLATES = [
  join("core", "knowledge", "aidlc-product-lead-agent", "reviewing.md"),
  join("core", "knowledge", "aidlc-architecture-reviewer-agent", "reviewing.md"),
];

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf-8");

describe("a reviewer is handed the time instead of running a command for it", () => {
  for (const template of REVIEWER_TEMPLATES) {
    test(`${template} dates the review from the dispatch brief`, () => {
      const body = read(template);
      expect(body).toContain("**Date:** [the UTC time the dispatch brief names on its `Date for this review:` line]");
      expect(body).toContain(
        "For the `Date` field, use the UTC time the dispatch brief names on its `Date for this review:` line. " +
          "Never guess or infer the date, and run no command for it.",
      );
      // No shell command for the date, by any spelling of the invocation.
      expect(body).not.toContain("engine now");
    });
  }

  test("the reviewer protocol tells the conductor to carry the time into the brief", () => {
    const protocol = read(join("core", "aidlc-common", "protocols", "stage-protocol-reviewer.md"));
    expect(protocol).toContain(
      "It also returns `reviewed_at`, the UTC time this review is\n   dated: put it in the dispatch brief as " +
        "`Date for this review: <reviewed_at>`,\n   so the reviewer writes its `**Date:**` line from the brief and " +
        "runs no\n   command of its own for the time.",
    );
  });
});
