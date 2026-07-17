// covers: doc:knowledge/aidlc-shared/rules-reading.md, doc:knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md, doc:agents/aidlc-pipeline-deploy-agent.md
//
// t70 — static shape checks for the worktree KB rewrites + the
// pipeline-deploy agent's practices-loading wiring. Migrated from
// tests/unit/t70-worktree-kb-and-skill.sh (TAP plan 9).
//
// The .sh had no `# covers:` header; its subject is the prose/structure of
// three SHIPPED markdown artefacts, so — like the sibling t76 migration —
// the covers ids are `doc:<relative-path>` for each. There is no tool or
// function under test: the bytes on disk ARE the contract.
//
// Mechanism: none. The .sh ran `assert_file_exists`, `assert_grep`,
// `grep -c "^### ..."` count asserts, and an `awk`-extracted Knowledge-Loading
// region with `sed -n '4p'` positional check — all pure byte inspection of
// shipped markdown, zero spawn, zero LLM, zero tokens, no process boundary.
// The twin reads those same bytes ONCE in-process and asserts the same
// patterns. The `grep -c` counts and the awk-position-4 extraction are
// reproduced exactly (anchored to `^### ` / `^## ` / the numbered-list region)
// so future edits INSIDE those regions survive while the shape stays pinned —
// the same intent the .sh's heading-marker + awk-region approach had.
//
// Engine-cutover note (verbatim from the .sh header): the original Sections 4
// & 5 (SKILL.md per-Bolt Steps 0/0.5/6.5/6.75 and the halt-and-ask
// worktree-dispatch failure shapes) were RETIRED at the engine cutover — that
// per-Bolt orchestration prose moved into the engine, covered by the engine's
// own differential corpus (t118). This test pins only the KB + agent checks,
// unaffected by the cutover.
//
// Source under test (read verbatim, byte cites against the files as shipped):
//   dist/claude/.claude/knowledge/aidlc-shared/rules-reading.md
//     :23  "## 1. Empty-template detection"
//     :56  "## 2. Semantic-topic matching"
//     :91  "## 3. Fallback chain"
//   dist/claude/.claude/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md
//     5x "### Execution runbook" (one per strategy: trunk-based, GitHub Flow,
//        GitFlow, Release Branches, Monorepo)
//     5x "### Failure modes" (one per strategy)
//     :213 "## Response contract" (top-level section)
//     :5   cites "shared/rules-reading.md" (the new shared KB)
//   dist/claude/.claude/agents/aidlc-pipeline-deploy-agent.md
//     :83-91 "## Knowledge Loading" numbered list; position 1 (:86) is the
//            active-space memory layer carrying guardrails and practices
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh 1 (assert_file_exists $PR)                        -> "rules-reading.md exists"
//   .sh 2 (## 1. Empty-template detection)                -> "rules-reading.md has the empty-template-detection section heading"
//   .sh 3 (## 2. Semantic-topic matching)                 -> "rules-reading.md has the semantic-topic-matching section heading"
//   .sh 4 (## 3. Fallback chain)                          -> "rules-reading.md has the fallback-chain section heading"
//   .sh 5 (grep -c "^### Execution runbook" == 5)         -> "branching-strategies.md has exactly 5 Execution runbook sub-sections"
//   .sh 6 (grep -c "^### Failure modes" == 5)             -> "branching-strategies.md has exactly 5 Failure modes sub-sections"
//   .sh 7 (^## Response contract)                         -> "branching-strategies.md has the top-level Response contract section"
//   .sh 8 (references shared/rules-reading.md)            -> "branching-strategies.md references shared/rules-reading.md"
//   .sh 9 (retired rules-dir position) -> "pipeline-deploy agent loads active-space memory first"

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// The three shipped artefacts (the .sh's $PR / $BS / $AGENT).
const PR_PATH = join(
  AIDLC_SRC,
  "knowledge",
  "aidlc-shared",
  "rules-reading.md",
);
const BS_PATH = join(
  AIDLC_SRC,
  "knowledge",
  "aidlc-pipeline-deploy-agent",
  "branching-strategies.md",
);
const AGENT_PATH = join(
  AIDLC_SRC,
  "agents",
  "aidlc-pipeline-deploy-agent.md",
);

// Read the shipped bytes ONCE; split for line-anchored (^-prefix) assertions.
const pr = readFileSync(PR_PATH, "utf-8");
const bs = readFileSync(BS_PATH, "utf-8");
const bsLines = bs.split("\n");
const agent = readFileSync(AGENT_PATH, "utf-8");
const agentLines = agent.split("\n");

/** Count lines that exactly start with `prefix` — mirrors `grep -c "^<prefix>"`. */
function countLineStartsWith(lines: string[], prefix: string): number {
  return lines.filter((l) => l.startsWith(prefix)).length;
}

/**
 * Extract the numbered-list items inside the `## Knowledge Loading` region,
 * mirroring the .sh's awk:
 *   /^## Knowledge Loading/ { inside=1; next }
 *   inside && /^## /        { exit }            # stop at the next H2
 *   inside                  { print }           # body lines
 * then `grep -E "^[0-9]+\. "` to keep only numbered items. Returns them in
 * document order so `[index]` reproduces the .sh's `sed -n '4p'` (1-based).
 */
function knowledgeLoadingNumberedItems(lines: string[]): string[] {
  const items: string[] = [];
  let inside = false;
  for (const l of lines) {
    if (l.startsWith("## Knowledge Loading")) {
      inside = true;
      continue;
    }
    if (inside && l.startsWith("## ")) break; // next H2 closes the region
    if (inside && /^[0-9]+\. /.test(l)) items.push(l);
  }
  return items;
}

describe("t70 rules-reading.md — shared KB shape (none, migrated from t70-worktree-kb-and-skill.sh plan 9)", () => {
  test("rules-reading.md exists [.sh 1]", () => {
    // .sh: assert_file_exists "$PR".
    expect(existsSync(PR_PATH)).toBe(true);
  });

  test("rules-reading.md has the empty-template-detection section heading [.sh 2]", () => {
    // .sh: assert_grep "$PR" "## 1. Empty-template detection".
    expect(pr.includes("## 1. Empty-template detection")).toBe(true);
  });

  test("rules-reading.md has the semantic-topic-matching section heading [.sh 3]", () => {
    // .sh: assert_grep "$PR" "## 2. Semantic-topic matching".
    expect(pr.includes("## 2. Semantic-topic matching")).toBe(true);
  });

  test("rules-reading.md has the fallback-chain section heading [.sh 4]", () => {
    // .sh: assert_grep "$PR" "## 3. Fallback chain".
    expect(pr.includes("## 3. Fallback chain")).toBe(true);
  });
});

describe("t70 branching-strategies.md — per-strategy runbook/failure-mode coverage + response contract + shared-KB cite", () => {
  test("branching-strategies.md has exactly 5 Execution runbook sub-sections [.sh 5]", () => {
    // .sh: RUNBOOK_COUNT=$(grep -c "^### Execution runbook" "$BS"); assert_eq 5.
    // One per strategy (trunk-based, GitHub Flow, GitFlow, Release Branches,
    // Monorepo). Exact count, not >=, so a dropped or duplicated runbook reds.
    expect(countLineStartsWith(bsLines, "### Execution runbook")).toBe(5);
  });

  test("branching-strategies.md has exactly 5 Failure modes sub-sections [.sh 6]", () => {
    // .sh: FAILURE_COUNT=$(grep -c "^### Failure modes" "$BS"); assert_eq 5.
    expect(countLineStartsWith(bsLines, "### Failure modes")).toBe(5);
  });

  test("branching-strategies.md has the top-level Response contract section [.sh 7]", () => {
    // .sh: assert_grep "$BS" "^## Response contract" — line-anchored H2, so a
    // mid-line mention can't satisfy it.
    expect(bsLines.some((l) => l.startsWith("## Response contract"))).toBe(true);
  });

  test("branching-strategies.md references shared/rules-reading.md [.sh 8]", () => {
    // .sh: assert_grep "$BS" "shared/rules-reading.md" — the file must cite the
    // shared protocol KB rather than duplicate it.
    expect(bs.includes("shared/rules-reading.md")).toBe(true);
  });
});

describe("t70 aidlc-pipeline-deploy-agent.md — Knowledge-Loading wiring", () => {
  test("pipeline-deploy agent loads active-space memory first [.sh 9]", () => {
    // The relocated memory layer replaces the retired dotted rules directory.
    // Keep the positional invariant: guardrails and affirmed practices load
    // before methodology knowledge. Also assert the region is non-empty so the
    // positional check isn't silently matching an empty extraction).
    const items = knowledgeLoadingNumberedItems(agentLines);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]).toContain(
      "aidlc/spaces/<active-space>/memory/{org,team,project}.md",
    );
  });
});
