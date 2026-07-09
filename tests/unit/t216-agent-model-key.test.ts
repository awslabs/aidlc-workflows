// covers: file:agents/aidlc-architect-agent.md, file:agents/aidlc-architecture-reviewer-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-composer-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-operations-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-product-agent.md, file:agents/aidlc-product-lead-agent.md, file:agents/aidlc-quality-agent.md (t216 agent model key contract)
//
// t216 - shipped Claude agent model frontmatter key.
//
// Mechanism: none. Pure structural check over shipped bytes on disk. The test
// resolves the same dist/claude/.claude tree used by the harness fixtures and
// reads each agent Markdown file in-process.
//
// Subject under test: the YAML frontmatter in every shipped Claude agent persona
// under dist/claude/.claude/agents/aidlc-<agent>-agent.md. Claude Code reads
// `model:` there to pick the delegated subagent model. The old
// `modelOverride:` spelling is inert on Claude Code, so its presence in shipped
// frontmatter is a regression.
//
// Why this exists: t04 pins the model split for the 11 domain-expert agents.
// This companion pins the complete 14-agent roster, including the composer and
// the two review-only agents, and asserts both key-shape invariants that make
// the value pin meaningful.

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

const EXPECTED_MODEL: Record<Agent, "opus" | "sonnet"> = {
  architect: "opus",
  "architecture-reviewer": "sonnet",
  "aws-platform": "opus",
  compliance: "opus",
  composer: "opus",
  delivery: "sonnet",
  design: "opus",
  developer: "opus",
  devsecops: "opus",
  operations: "sonnet",
  "pipeline-deploy": "sonnet",
  product: "opus",
  "product-lead": "sonnet",
  quality: "opus",
};

const agentFile = (agent: Agent): string =>
  join(AGENTS_DIR, `aidlc-${agent}-agent.md`);

function frontmatter(agent: Agent): string {
  const body = readFileSync(agentFile(agent), "utf-8");
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`no YAML frontmatter block in aidlc-${agent}-agent.md`);
  return m[1];
}

function modelValues(fm: string): string[] {
  return [...fm.matchAll(/^model:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

describe("t216 complete Claude agent model key contract", () => {
  test("shipped Claude roster is exactly the expected 14 agent files", () => {
    const shipped = readdirSync(AGENTS_DIR)
      .filter((name) => name.endsWith("-agent.md"))
      .sort();
    const expected = AGENTS.map((agent) => `aidlc-${agent}-agent.md`).sort();
    expect(shipped).toEqual(expected);
  });

  test("model: appears exactly once in every shipped agent frontmatter", () => {
    for (const agent of AGENTS) {
      const values = modelValues(frontmatter(agent));
      expect(values.length, `aidlc-${agent}-agent.md: model: line count`).toBe(1);
    }
  });

  test("model: values match the explicit per-agent policy", () => {
    for (const agent of AGENTS) {
      const values = modelValues(frontmatter(agent));
      expect(values[0], `aidlc-${agent}-agent.md: model value`).toBe(EXPECTED_MODEL[agent]);
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
