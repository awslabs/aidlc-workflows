// covers: doc:aidlc-common/protocols/stage-protocol-construction.md, doc:knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md, doc:agents/aidlc-pipeline-deploy-agent.md
//
// t76 — halt-and-ask prose-shape contract across the worktree-dispatch surfaces.
// Its subject is the prose shape of three SHIPPED markdown artefacts, so the
// covers ids are `doc:<relative-path>` for each. There is no tool/function
// under test - the bytes on disk ARE the contract.
//
// Mechanism: none. The test reads the shipped bytes ONCE in-process and asserts
// the patterns - zero spawn, zero LLM, zero tokens, no process boundary. The
// line-anchoring is load-bearing so a "preserved" word elsewhere in the file
// can't false-green: the same-line cases isolate the matched line and assert
// the phrase is co-located on THAT line, rather than a file-wide contains().
//
// Source under test:
//   dist/claude/.claude/aidlc-common/protocols/stage-protocol-construction.md
//     the halt-and-ask ```question prompt interpolates [path] AND [branch_name]:
//          'Worktree at [path] on branch [branch_name]. How would you like to proceed?'
//     Skip option description carries "worktree preserved"
//     "- Skip:" bullet carries "Worktree at" SAME-LINE (preservation phrase)
//     "- Abort:" bullet carries "Worktree at" SAME-LINE (preservation phrase)
//   dist/claude/.claude/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md
//     "Dirty tree on merge" bullet appends "Worktree preserved on retry" SAME-LINE
//     cross-links `aidlc-common/protocols/stage-protocol-construction.md`
//       section "Halt-and-ask on failure"
//   dist/claude/.claude/agents/aidlc-pipeline-deploy-agent.md
//     "On conflict envelopes" bullet appends "preserves the worktree" SAME-LINE

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const PROTO_PATH = join(
  AIDLC_SRC,
  "aidlc-common",
  "protocols",
  "stage-protocol-construction.md",
);
const BRANCH_PATH = join(
  AIDLC_SRC,
  "knowledge",
  "aidlc-pipeline-deploy-agent",
  "branching-strategies.md",
);
const PDAGENT_PATH = join(
  AIDLC_SRC,
  "agents",
  "aidlc-pipeline-deploy-agent.md",
);

const proto = readFileSync(PROTO_PATH, "utf-8");
const protoLines = proto.split("\n");
const branch = readFileSync(BRANCH_PATH, "utf-8");
const branchLines = branch.split("\n");
const pdagent = readFileSync(PDAGENT_PATH, "utf-8");
const pdagentLines = pdagent.split("\n");

/**
 * Return the FIRST line satisfying the predicate (or "" if none). Co-location
 * is the real contract, not file-wide presence.
 */
function firstLine(lines: string[], pred: (l: string) => boolean): string {
  return lines.find(pred) ?? "";
}

describe("t76 stage-protocol-construction.md — AUQ template + Skip/Abort preservation (none, migrated from t76-halt-and-ask-prose-shape.sh plan 7)", () => {
  test("AUQ question carries [path] and [branch_name] [.sh 1]", () => {
    // Inside the fenced ```question block, the halt-and-ask prompt line
    // interpolates [path] then [branch_name] in order.
    expect(
      /prompt.*\[path\].*\[branch_name\]/.test(proto),
    ).toBe(true);
    const q = firstLine(
      protoLines,
      (l) => /prompt.*\[path\].*\[branch_name\]/.test(l),
    );
    expect(q).toContain("[path]");
    expect(q).toContain("[branch_name]");
  });

  test("Skip option mentions worktree preserved [.sh 2]", () => {
    // The ```question spec splits label and description onto adjacent lines, so
    // the contract is: the `- label: Skip` line's IMMEDIATE next line is a
    // description carrying "worktree preserved".
    const i = protoLines.findIndex((l) => /^\s*- label: Skip\b/.test(l));
    expect(i).toBeGreaterThan(-1);
    expect(/description:.*worktree preserved/.test(protoLines[i + 1] ?? "")).toBe(true);
  });

  test("- Skip: bullet carries preservation phrase same-line [.sh 3]", () => {
    // The "Worktree at" phrase MUST be on the "- Skip:" bullet itself, not merely
    // present in the file.
    const skipLine = firstLine(protoLines, (l) => l.startsWith("- Skip:"));
    expect(skipLine).not.toBe("");
    expect(skipLine).toContain("Worktree at");
  });

  test("- Abort: bullet carries preservation phrase same-line [.sh 4]", () => {
    const abortLine = firstLine(protoLines, (l) => l.startsWith("- Abort:"));
    expect(abortLine).not.toBe("");
    expect(abortLine).toContain("Worktree at");
  });
});

describe("t76 branching-strategies.md — dirty-tree preservation + halt-and-ask cross-link", () => {
  test("Dirty-tree bullet appends preservation phrase same-line [.sh 5]", () => {
    // "Worktree preserved on retry" must be co-located on the dirty-tree bullet,
    // not merely present in the file.
    const dirtyLine = firstLine(branchLines, (l) =>
      l.includes("Dirty tree on merge"),
    );
    expect(dirtyLine).not.toBe("");
    expect(dirtyLine).toContain("Worktree preserved on retry");
  });

  test("cross-links to construction protocol halt-and-ask block [.sh 6]", () => {
    expect(
      /stage-protocol-construction\.md.*Halt-and-ask/.test(branch),
    ).toBe(true);
    const linkLine = firstLine(branchLines, (l) =>
      /stage-protocol-construction\.md.*Halt-and-ask/.test(l),
    );
    expect(linkLine).toContain("stage-protocol-construction.md");
    expect(linkLine).toContain("Halt-and-ask");
  });
});

describe("t76 aidlc-pipeline-deploy-agent.md — conflict bullet preservation", () => {
  test("conflict bullet appends preservation phrase same-line [.sh 7]", () => {
    // "preserves the worktree" must be co-located on the conflict-envelope bullet
    // itself.
    const pdLine = firstLine(pdagentLines, (l) =>
      l.includes("On conflict envelopes"),
    );
    expect(pdLine).not.toBe("");
    expect(pdLine).toContain("preserves the worktree");
  });
});
