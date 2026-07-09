// covers: file:agents/aidlc-architect-agent.md, file:agents/aidlc-architecture-reviewer-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-composer-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-operations-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-product-agent.md, file:agents/aidlc-product-lead-agent.md, file:agents/aidlc-quality-agent.md (t216 projected model+effort contract)
//
// t216 - shipped Claude agent model + effort frontmatter PROJECTION contract.
//
// Mechanism: none. Pure structural check over shipped bytes on disk. The test
// resolves the same dist/claude/.claude tree used by the harness fixtures and
// reads each agent Markdown file in-process.
//
// Subject under test: the YAML frontmatter in every shipped Claude agent
// persona under dist/claude/.claude/agents/aidlc-<agent>-agent.md. The
// AUTHORED contract is `tier:` on core/agents (pinned by t04); the packager
// PROJECTS it into the `model:`/`effort:` keys Claude Code actually reads.
// This test pins the projected values per agent, per the tier table in
// core/tools/aidlc-tiers.ts:
//
//   judgment  -> model: inherit, NO effort: line (the session's model AND
//                effort win - an omitted effort key inherits the session
//                effort, and a pinned one would override it in both
//                directions, so ABSENCE is the contract)
//   balanced  -> model: sonnet,  NO effort: line (same inherit reasoning)
//   templated -> model: sonnet,  effort: medium (the one deliberate,
//                cost-saving downgrade)
//
// Why this exists: t04 pins the authored tier split for the 11 domain-expert
// agents. This companion pins the complete 14-agent roster's PROJECTED
// frontmatter, including the composer and the two review-only agents, and
// asserts the key-shape invariants that make the value pins meaningful
// (exactly-once model:, absent effort: where absence is the contract, and
// the modelOverride: regression pin - that spelling is inert on Claude Code).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const AGENTS_DIR = join(AIDLC_SRC, "agents");

const AGENTS = [
  "architect",
  "architecture-reviewer",
  "aws-platform",
  "compliance",
  "composer",
  "delivery",
  "design",
  "developer",
  "devsecops",
  "operations",
  "pipeline-deploy",
  "product",
  "product-lead",
  "quality",
] as const;

type Agent = (typeof AGENTS)[number];

// The PROJECTED per-agent contract, hard-coded independently of the source
// (both the agent files and the projection table), so the test pins the
// policy rather than echoing either. effort: null = the line must be ABSENT.
const EXPECTED: Record<Agent, { model: "inherit" | "sonnet"; effort: "medium" | null }> = {
  architect: { model: "inherit", effort: null },
  "architecture-reviewer": { model: "sonnet", effort: null },
  "aws-platform": { model: "inherit", effort: null },
  compliance: { model: "inherit", effort: null },
  composer: { model: "inherit", effort: null },
  delivery: { model: "sonnet", effort: "medium" },
  design: { model: "inherit", effort: null },
  developer: { model: "inherit", effort: null },
  devsecops: { model: "inherit", effort: null },
  operations: { model: "sonnet", effort: "medium" },
  "pipeline-deploy": { model: "sonnet", effort: "medium" },
  product: { model: "inherit", effort: null },
  "product-lead": { model: "sonnet", effort: null },
  quality: { model: "inherit", effort: null },
};

const agentFile = (agent: Agent): string =>
  join(AGENTS_DIR, `aidlc-${agent}-agent.md`);

function frontmatter(agent: Agent): string {
  const body = readFileSync(agentFile(agent), "utf-8");
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`no YAML frontmatter block in aidlc-${agent}-agent.md`);
  return m[1];
}

function keyValues(fm: string, key: string): string[] {
  return [...fm.matchAll(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "gm"))].map((m) => m[1]);
}

describe("t216 complete Claude agent tier-projection contract", () => {
  test("shipped Claude roster is exactly the expected 14 agent files", () => {
    const shipped = readdirSync(AGENTS_DIR)
      .filter((name) => name.endsWith("-agent.md"))
      .sort();
    const expected = AGENTS.map((agent) => `aidlc-${agent}-agent.md`).sort();
    expect(shipped).toEqual(expected);
  });

  test("model: appears exactly once in every shipped agent frontmatter", () => {
    for (const agent of AGENTS) {
      const values = keyValues(frontmatter(agent), "model");
      expect(values.length, `aidlc-${agent}-agent.md: model: line count`).toBe(1);
    }
  });

  test("model: values match the projected per-tier policy", () => {
    for (const agent of AGENTS) {
      const values = keyValues(frontmatter(agent), "model");
      expect(values[0], `aidlc-${agent}-agent.md: model value`).toBe(EXPECTED[agent].model);
    }
  });

  test("effort: is pinned for templated agents and ABSENT everywhere else", () => {
    for (const agent of AGENTS) {
      const values = keyValues(frontmatter(agent), "effort");
      const want = EXPECTED[agent].effort;
      if (want === null) {
        // ABSENCE is the contract: an effort: pin would override the session
        // effort in both directions, silently capping an xhigh session.
        expect(
          values.length,
          `aidlc-${agent}-agent.md: effort: must be ABSENT (inherits session effort)`,
        ).toBe(0);
      } else {
        expect(values.length, `aidlc-${agent}-agent.md: effort: line count`).toBe(1);
        expect(values[0], `aidlc-${agent}-agent.md: effort value`).toBe(want);
      }
    }
  });

  test("tier: never leaks into shipped Claude frontmatter (projection completeness)", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      expect(
        /^tier:/m.test(fm),
        `aidlc-${agent}-agent.md: raw tier: leaked through the projection`,
      ).toBe(false);
    }
  });

  test("modelOverride: is absent from every shipped agent frontmatter", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      expect(
        /^modelOverride:/m.test(fm),
        `aidlc-${agent}-agent.md: modelOverride: must not be in frontmatter`,
      ).toBe(false);
    }
  });
});
