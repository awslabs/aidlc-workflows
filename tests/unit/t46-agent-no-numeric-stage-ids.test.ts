// covers: file:agents/aidlc-product-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-architect-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-quality-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-operations-agent.md
//
// t46 - shipped domain-agent personas must not use numeric stage IDs or
// duplicate stage ownership and knowledge-loading contracts that are
// authoritative in stage frontmatter and stage-protocol.md.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const AGENTS_DIR = join(AIDLC_SRC, "agents");

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

function numericStageIdHits(body: string): string[] {
  const re = /[0-9]+\.[0-9]+/;
  return body
    .split("\n")
    .filter((line) => re.test(line) && !line.includes("WCAG"));
}

describe("t46 agent persona stage-reference shape", () => {
  test("each agent has no numeric stage IDs (WCAG version refs excluded)", () => {
    for (const agent of AGENTS) {
      expect(existsSync(agentFile(agent)), `aidlc-${agent}-agent.md missing`).toBe(
        true,
      );
      const body = readFileSync(agentFile(agent), "utf-8");
      const hits = numericStageIdHits(body);
      expect(
        hits,
        `aidlc-${agent}-agent.md has numeric stage ID(s):\n${hits.join("\n")}`,
      ).toEqual([]);
    }
  });

  test("each agent omits redundant Stages Owned and Knowledge Loading sections", () => {
    for (const agent of AGENTS) {
      const body = readFileSync(agentFile(agent), "utf-8");
      expect(body).not.toMatch(/^## Stages Owned$/m);
      expect(body).not.toMatch(/^## Knowledge Loading$/m);
    }
  });
});
