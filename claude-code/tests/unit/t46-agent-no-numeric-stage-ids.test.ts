// covers: file:agents/aidlc-product-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-architect-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-quality-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-operations-agent.md, data:stage-graph.json
//
// t46 — shipped agent persona files must reference stages by SLUG, never by
// numeric stage ID. Migrated from tests/unit/t46-agent-no-numeric-stage-ids.sh
// (TAP plan 22 — 2 distinct assertions per agent across the 11 domain-expert
// personas). The .sh has no `# covers:` header; the units it proves are the 11
// shipped agent .md files plus the stage-graph.json it resolves slugs against,
// so the covers list above names them (same files t04's covers names, plus the
// graph data file the semantic half reads).
//
// Mechanism: none. This is a pure structural/content check over the shipped
// bytes — does each agent persona avoid digit.dot.digit stage IDs, and do its
// "Stages Owned" slugs all resolve in stage-graph.json? No process boundary, no
// argv/exit/stdout seam, no LLM, zero tokens. We resolve the same tree the .sh
// resolved (AGENTS_DIR = AIDLC_SRC/agents, STAGE_GRAPH =
// AIDLC_SRC/tools/data/stage-graph.json — fixtures.ts:42) and read + parse each
// file in-process. The .sh shelled out to grep/awk/jq purely to inspect static
// files; there is no process-boundary contract to preserve, so the equal-or-
// stronger port is in-process (the .sh even SKIPped entirely when jq was
// absent — this twin removes that environmental escape hatch, which is
// STRONGER: the assertions always run).
//
// Background (.sh header L4-7): v0.3.0 milestone 1 stripped digit.dot.digit stage
// identifiers (e.g. "1.1", "3.4–3.7") from the 11 agent files. Stages are
// identified by slug (e.g. "intent-capture") per SKILL.md's canonical-identifier
// rule; numbers live only in stage-graph.json for graph-machine use.
//
// Subject under test (dist/claude/.claude/agents/aidlc-<agent>-agent.md +
// dist/claude/.claude/tools/data/stage-graph.json):
//   A (format): grep -En '[0-9]+\.[0-9]+' minus the WCAG content-exclusion
//      returns ZERO matches. The lone allowed digit.dot.digit is the W3C
//      "WCAG 2.1" version reference in aidlc-design-agent.md, which is not a
//      stage ID (.sh L37 `grep -v 'WCAG'`).
//   B (semantic): every slug bullet in the agent's "## Stages Owned" section
//      (the bullets between that heading and the next `## ` heading, matching
//      `^- <slug> — `) exists as a `.slug` in stage-graph.json. Catches typos
//      or wrong-slug mappings the format check alone would miss (.sh L44-67).
//
// Test-design note (house style): assert the OBSERVABLE shipped contract the
// .sh asserted — the per-line numeric-ID scan with the WCAG carve-out, and the
// slug-resolution set membership — against the real bytes on disk. The slug
// extraction mirrors the .sh's awk state machine line-for-line so the SAME
// bullets are collected; the WCAG exclusion mirrors the .sh's `grep -v 'WCAG'`
// (whole-line drop). The stage-graph slug set is read from the shipped JSON
// (the .sh's `jq` source), not hard-coded, so a graph edit and an agent edit
// stay in lockstep exactly as the .sh enforced.
//
// Old TAP -> new test parity (1:1; the .sh emitted 2 `ok` lines PER agent in a
// single loop — 2 × 11 = 22. Here each of the 2 invariants is one test() that
// asserts across ALL 11 agents via expect() per agent, so every one of the 22
// .sh rows maps to a named expect(). A third test re-counts to pin the plan):
//   .sh L36-42 (A: no numeric stage IDs, WCAG excluded)  -> "<agent>-agent has no numeric stage IDs (WCAG excluded)" [11 expects]
//   .sh L44-68 (B: Stages Owned slugs resolve in graph)  -> "<agent>-agent Stages Owned slugs all resolve in stage-graph.json" [11 expects]
//   .sh L31    plan 22                                    -> "covers EXACTLY 11 agents × 2 invariants = 22 assertions (TAP plan parity)"

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same tree the .sh resolved as
// AGENTS_DIR's parent and STAGE_GRAPH's grandparent.
const AGENTS_DIR = join(AIDLC_SRC, "agents");
const STAGE_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

// The 11 domain-expert agents, in the order the .sh's `AGENTS=` list named them
// (.sh L24).
const AGENTS = [
  "product",
  "design",
  "delivery",
  "architect",
  "aws-platform",
  "compliance",
  "devsecops",
  "developer",
  "quality",
  "pipeline-deploy",
  "operations",
] as const;

const agentFile = (agent: string): string =>
  join(AGENTS_DIR, `aidlc-${agent}-agent.md`);

/**
 * The set of valid stage slugs, read from the shipped stage-graph.json (the
 * .sh's `jq -e '.[] | select(.slug == $s)'` source). Reading the live JSON —
 * rather than hard-coding — keeps a graph edit and an agent edit in lockstep
 * exactly as the .sh's `jq` lookup did.
 */
function loadGraphSlugs(): Set<string> {
  const raw = JSON.parse(readFileSync(STAGE_GRAPH, "utf-8")) as Array<{
    slug?: string;
  }>;
  return new Set(
    raw.map((n) => n.slug).filter((s): s is string => typeof s === "string"),
  );
}

/**
 * Mirror the .sh's assertion-A scan (L37): every line matching
 * /[0-9]+\.[0-9]+/, then drop any line containing 'WCAG' (the W3C version
 * reference in aidlc-design-agent.md, not a stage ID). Returns the surviving
 * offending lines (empty array === pass).
 */
function numericStageIdHits(body: string): string[] {
  const re = /[0-9]+\.[0-9]+/;
  return body
    .split("\n")
    .filter((line) => re.test(line) && !line.includes("WCAG"));
}

/**
 * Mirror the .sh's assertion-B slug extraction (awk state machine, L47-55):
 * collect bullets inside the "## Stages Owned" section (from that heading until
 * the next `## ` heading), matching `^- <slug> — ` where <slug> is
 * [a-z][a-z0-9-]* and ` — ` is the em-dash separator. The `**Lead:**` /
 * `**Supporting:**` sub-headers are not bullets, so collection spans both, just
 * as the awk did. Returns the slugs in document order.
 */
function stagesOwnedSlugs(body: string): string[] {
  const slugs: string[] = [];
  let inSection = false;
  for (const line of body.split("\n")) {
    if (/^## Stages Owned/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^## /.test(line)) {
      inSection = false;
    }
    if (inSection) {
      // `^- <slug> — ...` — em-dash (U+2014) with surrounding spaces, exactly
      // the awk pattern `/^- [a-z][a-z0-9-]* — /`.
      const m = line.match(/^- ([a-z][a-z0-9-]*) — /);
      if (m) slugs.push(m[1]);
    }
  }
  return slugs;
}

describe("t46 agent files reference stages by slug, not numeric ID (migrated from t46-agent-no-numeric-stage-ids.sh, plan 22)", () => {
  // .sh L36-42 (assertion A ×11): no digit.dot.digit stage IDs survive the
  // WCAG content-exclusion.
  test("each agent has no numeric stage IDs (WCAG version refs excluded) [.sh assertion A ×11]", () => {
    for (const agent of AGENTS) {
      // Sanity: the file the .sh grepped must exist.
      expect(existsSync(agentFile(agent)), `aidlc-${agent}-agent.md missing`).toBe(
        true,
      );
      const body = readFileSync(agentFile(agent), "utf-8");
      const hits = numericStageIdHits(body);
      // STRONGER than the .sh's `[ -z "$HITS" ]` pass/fail: surface the
      // offending lines in the assertion message so a regression is debuggable.
      expect(
        hits,
        `aidlc-${agent}-agent.md has numeric stage ID(s):\n${hits.join("\n")}`,
      ).toEqual([]);
    }
  });

  // .sh L44-68 (assertion B ×11): every Stages Owned slug resolves in
  // stage-graph.json.
  test("each agent's Stages Owned slugs all resolve in stage-graph.json [.sh assertion B ×11]", () => {
    const graphSlugs = loadGraphSlugs();
    // Guard: the graph itself must have loaded (the .sh implicitly relied on a
    // non-empty graph; if jq found nothing every lookup would have failed).
    expect(graphSlugs.size).toBeGreaterThan(0);
    for (const agent of AGENTS) {
      const body = readFileSync(agentFile(agent), "utf-8");
      const slugs = stagesOwnedSlugs(body);
      // STRONGER than the .sh: every agent must actually declare a non-empty
      // Stages Owned list. The .sh would silently pass an agent whose section
      // was empty or mis-headed (no slugs -> UNKNOWN empty -> ok); pin that the
      // extraction found ownership bullets so a structural regression can't
      // masquerade as a pass.
      expect(
        slugs.length,
        `aidlc-${agent}-agent.md: no Stages Owned slug bullets found`,
      ).toBeGreaterThan(0);
      const unknown = slugs.filter((s) => !graphSlugs.has(s));
      expect(
        unknown,
        `aidlc-${agent}-agent.md Stages Owned has unknown slug(s): ${unknown.join(", ")}`,
      ).toEqual([]);
    }
  });

  // .sh L31: plan 22. Re-count to pin the plan and guard against an agent being
  // silently dropped from the roster (2 invariants × 11 agents = 22 rows).
  test("covers EXACTLY 11 agents × 2 invariants = 22 assertions (TAP plan parity)", () => {
    expect(AGENTS.length).toBe(11);
    const INVARIANTS_PER_AGENT = 2;
    expect(AGENTS.length * INVARIANTS_PER_AGENT).toBe(22);
  });
});
