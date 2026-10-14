// covers: doc:knowledge/aidlc-shared/rules-reading.md, doc:knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md, doc:agents/aidlc-pipeline-deploy-agent.md
//
// t70 - static shape checks for the worktree KB + the pipeline-deploy agent's
// memory-focus wiring.
//
// The subject is the prose/structure of three SHIPPED markdown artefacts, so
// the covers ids are `doc:<relative-path>` for each. There is no tool or
// function under test: the bytes on disk ARE the contract.
//
// Per-Bolt orchestration is covered by the engine's own differential corpus
// (t118). This test pins only the KB + agent checks.
//
// Source under test:
//   dist/claude/.claude/knowledge/aidlc-shared/rules-reading.md
//     "## 1. Empty-template detection"
//     "## 2. Semantic-topic matching"
//     "## 3. Fallback chain"
//   dist/claude/.claude/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md
//     5x "### Execution runbook" (one per strategy: trunk-based, GitHub Flow,
//        GitFlow, Release Branches, Monorepo)
//     5x "### Failure modes" (one per strategy)
//     "## Response contract" (top-level section)
//     cites "shared/rules-reading.md" (the shared KB)
//   dist/claude/.claude/agents/aidlc-pipeline-deploy-agent.md
//     "## Memory Focus" preserves the active-space memory path carrying
//     guardrails and practices

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

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

const pr = readFileSync(PR_PATH, "utf-8");
const bs = readFileSync(BS_PATH, "utf-8");
const bsLines = bs.split("\n");
const agent = readFileSync(AGENT_PATH, "utf-8");

function countLineStartsWith(lines: string[], prefix: string): number {
  return lines.filter((l) => l.startsWith(prefix)).length;
}

describe("t70 rules-reading.md — shared KB shape (none, migrated from t70-worktree-kb-and-skill.sh plan 9)", () => {
  test("rules-reading.md exists [.sh 1]", () => {
    expect(existsSync(PR_PATH)).toBe(true);
  });

  test("rules-reading.md has the empty-template-detection section heading [.sh 2]", () => {
    expect(pr.includes("## 1. Empty-template detection")).toBe(true);
  });

  test("rules-reading.md has the semantic-topic-matching section heading [.sh 3]", () => {
    expect(pr.includes("## 2. Semantic-topic matching")).toBe(true);
  });

  test("rules-reading.md has the fallback-chain section heading [.sh 4]", () => {
    expect(pr.includes("## 3. Fallback chain")).toBe(true);
  });
});

describe("t70 branching-strategies.md — per-strategy runbook/failure-mode coverage + response contract + shared-KB cite", () => {
  test("branching-strategies.md has exactly 5 Execution runbook sub-sections [.sh 5]", () => {
    // One per strategy (trunk-based, GitHub Flow, GitFlow, Release Branches,
    // Monorepo). Exact count, not >=, so a dropped or duplicated runbook reds.
    expect(countLineStartsWith(bsLines, "### Execution runbook")).toBe(5);
  });

  test("branching-strategies.md has exactly 5 Failure modes sub-sections [.sh 6]", () => {
    expect(countLineStartsWith(bsLines, "### Failure modes")).toBe(5);
  });

  test("branching-strategies.md has the top-level Response contract section [.sh 7]", () => {
    // Line-anchored H2, so a mid-line mention can't satisfy it.
    expect(bsLines.some((l) => l.startsWith("## Response contract"))).toBe(true);
  });

  test("branching-strategies.md references shared/rules-reading.md [.sh 8]", () => {
    // The file must cite the shared protocol KB rather than duplicate it.
    expect(bs.includes("shared/rules-reading.md")).toBe(true);
  });
});

describe("t70 aidlc-pipeline-deploy-agent.md — memory-focus wiring", () => {
  test("pipeline-deploy agent preserves the active-space memory focus [.sh 9]", () => {
    expect(agent).toContain("## Memory Focus");
    expect(agent).toContain(
      "aidlc/spaces/<active-space>/memory/{org,team,project}.md",
    );
  });
});
