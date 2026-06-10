// covers: doc:aidlc-common/protocols/stage-protocol.md, doc:knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md, doc:agents/aidlc-pipeline-deploy-agent.md
//
// t76 — halt-and-ask prose-shape contract across the worktree-dispatch surfaces.
// Migrated from tests/feature/t76-halt-and-ask-prose-shape.sh (TAP plan 7).
// The .sh had no `# covers:` header; its subject is the prose shape of three
// SHIPPED markdown artefacts, so the covers ids are `doc:<relative-path>` for
// each. There is no tool/function under test — the bytes on disk ARE the
// contract.
//
// Mechanism: none. The .sh ran a battery of `assert_grep` plus three
// `grep -n | head -1` line-extraction + same-line `grep -q` checks against the
// bytes on disk (NOT file-wide greps — the line-anchoring is load-bearing so a
// "preserved" word elsewhere in the file can't false-green). The TS twin reads
// those same bytes ONCE in-process and asserts the same patterns — zero spawn,
// zero LLM, zero tokens, no process boundary. STRONGER than the .sh: the three
// same-line cases are reproduced by isolating the matched line and asserting the
// phrase is co-located on THAT line (exactly what the .sh's grep-extract-then-
// grep-the-line did), rather than a file-wide contains().
//
// Engine-cutover note (verbatim from the .sh header): the original SKILL.md half
// of this contract (slug-derivation paragraph, two worktree-dispatch carve-out
// subheadings, "Inspecting a paused Bolt" paragraph, PR-13 prefix-hash +
// orphan-BOLT_STARTED italic carve-outs — formerly tests 1-5, 13-14) was RETIRED
// at the engine cutover; that prose moved into the engine, covered by the t118
// corpus. The halt-and-ask PROSE-SHAPE contract still lives in the three
// downstream surfaces this test pins.
//
// Source under test (read verbatim, byte cites against the files as shipped):
//   dist/claude/.claude/aidlc-common/protocols/stage-protocol.md
//     :140 AUQ template question interpolates [path] AND [branch_name]:
//          'Worktree at [path] on branch [branch_name]. How would you like to proceed?'
//     :145 Skip option description carries "worktree preserved"
//     :132 "- Skip:" bullet carries "Worktree at" SAME-LINE (preservation phrase)
//     :133 "- Abort:" bullet carries "Worktree at" SAME-LINE (preservation phrase)
//   dist/claude/.claude/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md
//     :46  "Dirty tree on merge" bullet appends "Worktree preserved on retry" SAME-LINE
//     :258 cross-links `aidlc-common/protocols/stage-protocol.md` § "Halt-and-ask on failure"
//   dist/claude/.claude/agents/aidlc-pipeline-deploy-agent.md
//     :63  "On conflict envelopes" bullet appends "preserves the worktree" SAME-LINE
//
// Old TAP -> new test parity (1:1 — every one of the 7 .sh assertions maps to a
// named test(); the three same-line cases are STRONGER, asserting co-location on
// the matched line rather than file-wide presence):
//   .sh 1 (PROTO question [path]+[branch_name])        -> "AUQ question carries [path] and [branch_name]"
//   .sh 2 (PROTO Skip.*worktree preserved)             -> "Skip option mentions worktree preserved"
//   .sh 3 (PROTO ^- Skip: line + Worktree at same-line)-> "- Skip: bullet carries preservation phrase same-line"
//   .sh 4 (PROTO ^- Abort: line + Worktree at same-line)-> "- Abort: bullet carries preservation phrase same-line"
//   .sh 5 (BRANCH Dirty-tree line + Worktree preserved on retry same-line) -> "Dirty-tree bullet appends preservation phrase same-line"
//   .sh 6 (BRANCH stage-protocol.md.*Halt-and-ask)     -> "cross-links to stage-protocol halt-and-ask block"
//   .sh 7 (PDAGENT On conflict envelopes line + preserves the worktree same-line) -> "conflict bullet appends preservation phrase same-line"

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// The three shipped artefacts (the .sh's $PROTO / $BRANCH / $PDAGENT).
const PROTO_PATH = join(
  AIDLC_SRC,
  "aidlc-common",
  "protocols",
  "stage-protocol.md",
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

// Read the shipped bytes ONCE; split for line-anchored (same-line) assertions.
const proto = readFileSync(PROTO_PATH, "utf-8");
const protoLines = proto.split("\n");
const branch = readFileSync(BRANCH_PATH, "utf-8");
const branchLines = branch.split("\n");
const pdagent = readFileSync(PDAGENT_PATH, "utf-8");
const pdagentLines = pdagent.split("\n");

/**
 * Mirror the .sh's `grep -n "<anchor>" | head -1` line extraction: return the
 * FIRST line satisfying the predicate (or "" if none). The .sh then ran a
 * second `grep -q "<phrase>"` against THAT line — so co-location is the real
 * contract, not file-wide presence.
 */
function firstLine(lines: string[], pred: (l: string) => boolean): string {
  return lines.find(pred) ?? "";
}

describe("t76 stage-protocol.md — AUQ template + Skip/Abort preservation (none, migrated from t76-halt-and-ask-prose-shape.sh plan 7)", () => {
  test("AUQ question carries [path] and [branch_name] [.sh 1]", () => {
    // .sh: assert_grep 'question.*\[path\].*\[branch_name\]'. Reproduce the
    // same regex shape (literal-bracket [path] ... [branch_name], in order, on
    // a `question` line) so a stray [path] elsewhere can't satisfy it.
    expect(
      /question.*\[path\].*\[branch_name\]/.test(proto),
    ).toBe(true);
    // STRONGER: the single matched line carries both interpolations in order.
    const q = firstLine(
      protoLines,
      (l) => /question.*\[path\].*\[branch_name\]/.test(l),
    );
    expect(q).toContain("[path]");
    expect(q).toContain("[branch_name]");
  });

  test("Skip option mentions worktree preserved [.sh 2]", () => {
    // .sh: assert_grep 'Skip.*worktree preserved' — a Skip label/option line
    // carrying the lowercase "worktree preserved" phrasing (:145).
    expect(/Skip.*worktree preserved/.test(proto)).toBe(true);
  });

  test("- Skip: bullet carries preservation phrase same-line [.sh 3]", () => {
    // .sh: SKIP_LINE=$(grep -n "^- Skip:" PROTO | head -1); echo "$SKIP_LINE" |
    //      grep -q "Worktree at". STRONGER than a file-wide contains(): the
    //      "Worktree at" phrase MUST be on the "- Skip:" bullet itself.
    const skipLine = firstLine(protoLines, (l) => l.startsWith("- Skip:"));
    expect(skipLine).not.toBe("");
    expect(skipLine).toContain("Worktree at");
  });

  test("- Abort: bullet carries preservation phrase same-line [.sh 4]", () => {
    // .sh: ABORT_LINE=$(grep -n "^- Abort:" PROTO | head -1); same-line grep
    //      for "Worktree at".
    const abortLine = firstLine(protoLines, (l) => l.startsWith("- Abort:"));
    expect(abortLine).not.toBe("");
    expect(abortLine).toContain("Worktree at");
  });
});

describe("t76 branching-strategies.md — dirty-tree preservation + halt-and-ask cross-link", () => {
  test("Dirty-tree bullet appends preservation phrase same-line [.sh 5]", () => {
    // .sh: DIRTY_LINE=$(grep -n "Dirty tree on merge" BRANCH | head -1);
    //      same-line grep for "Worktree preserved on retry". STRONGER:
    //      co-located on the dirty-tree bullet, not merely present in the file.
    const dirtyLine = firstLine(branchLines, (l) =>
      l.includes("Dirty tree on merge"),
    );
    expect(dirtyLine).not.toBe("");
    expect(dirtyLine).toContain("Worktree preserved on retry");
  });

  test("cross-links to stage-protocol halt-and-ask block [.sh 6]", () => {
    // .sh: assert_grep "stage-protocol\.md.*Halt-and-ask" — a single line
    //      naming stage-protocol.md then referencing the Halt-and-ask block.
    expect(/stage-protocol\.md.*Halt-and-ask/.test(branch)).toBe(true);
    // STRONGER: both tokens co-located on one line (the cross-link sentence).
    const linkLine = firstLine(branchLines, (l) =>
      /stage-protocol\.md.*Halt-and-ask/.test(l),
    );
    expect(linkLine).toContain("stage-protocol.md");
    expect(linkLine).toContain("Halt-and-ask");
  });
});

describe("t76 aidlc-pipeline-deploy-agent.md — conflict bullet preservation", () => {
  test("conflict bullet appends preservation phrase same-line [.sh 7]", () => {
    // .sh: PD_LINE=$(grep -n "On conflict envelopes" PDAGENT | head -1);
    //      same-line grep for "preserves the worktree". STRONGER: co-located on
    //      the conflict-envelope bullet itself.
    const pdLine = firstLine(pdagentLines, (l) =>
      l.includes("On conflict envelopes"),
    );
    expect(pdLine).not.toBe("");
    expect(pdLine).toContain("preserves the worktree");
  });
});
