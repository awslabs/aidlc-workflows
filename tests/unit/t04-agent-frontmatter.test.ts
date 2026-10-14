// covers: file:agents/aidlc-product-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-architect-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-quality-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-operations-agent.md
//
// t04 - AUTHORED agent-persona frontmatter contract. The authored contract is
// `tier:` on the CORE agent .md (model/effort are per-harness projection
// outputs - see core/tools/aidlc-tiers.ts and the companion t216, which pins
// the PROJECTED dist/claude contract).
//
// Mechanism: none. This is a pure structural/schema check over the authored
// bytes - does each agent persona's YAML frontmatter satisfy the registration
// contract? No process boundary, no argv/exit/stdout seam, no LLM, zero
// tokens. We read + parse each core/agents/*.md in-process. A frontmatter
// parser SCOPES every field assertion to the YAML block (between the opening
// and closing `---`), so prose in the body cannot satisfy a field check.
//
// Subject under test (core/agents/aidlc-<agent>-agent.md):
//   - name:           must equal `aidlc-<agent>-agent` (filename <-> name parity;
//                     every harness resolves a subagent by its `name`).
//   - description:    must be present (non-empty) - the routing summary.
//   - allowedTools:   must be ABSENT - a silently-ignored field. Its
//                     reappearance is a regression.
//   - disallowedTools: must contain `Task` - the machine-enforced single-level
//                     constraint that prevents subagents spawning subagents.
//   - tier:           must equal the documented per-agent value
//                     (judgment = multi-constraint reasoning under ambiguity,
//                      output cascades downstream;
//                      balanced = reviewer-shaped work against explicit criteria;
//                      templated = pattern-following output, methodology in
//                      knowledge; docs/reference/05-agent-system.md).
//                     judgment : architect, product, design, developer,
//                                quality, devsecops, compliance, aws-platform
//                     templated: delivery, pipeline-deploy, operations
//                     (a policy group whose shipped projection inherits)
//
// Test-design note (house style): assert the OBSERVABLE authored contract -
// frontmatter field presence/absence and exact values - against the real
// bytes on disk. The expected tier table is hard-coded here independently of
// the source, so the test pins the policy rather than echoing whatever the
// file says.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

// The AUTHORED source of truth: core/agents/. (t216 pins the projected
// dist/claude tree; this test pins what harness engineers actually edit.)
const AGENTS_DIR = join(REPO_ROOT, "core", "agents");

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

// Expected tier per agent -- hard-coded independently of the source.
// judgment = multi-constraint reasoning / high blast radius; templated =
// pattern-following config/scaffolding. (balanced covers the two review-only
// agents, which are outside this 11-agent roster - see t216 for the full 14.)
const EXPECTED_TIER: Record<(typeof AGENTS)[number], "judgment" | "balanced" | "templated"> = {
  product: "judgment",
  design: "judgment",
  delivery: "templated",
  architect: "judgment",
  "aws-platform": "judgment",
  compliance: "judgment",
  devsecops: "judgment",
  developer: "judgment",
  quality: "judgment",
  "pipeline-deploy": "templated",
  operations: "templated",
};

const agentFile = (agent: string): string =>
  join(AGENTS_DIR, `aidlc-${agent}-agent.md`);

/**
 * Extract the YAML frontmatter block (the text between the first two `---`
 * fences). Field assertions are scoped to this block, so a `name:` or
 * `description:` token in the persona's prose body cannot satisfy the check.
 */
function frontmatter(agent: string): string {
  const body = readFileSync(agentFile(agent), "utf-8");
  // Frontmatter is delimited by a leading `---\n` ... `\n---`.
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`no YAML frontmatter block in aidlc-${agent}-agent.md`);
  return m[1];
}

/** True if the frontmatter has a line `^<key>:` (block-scoped, anchored). */
function hasKeyLine(fm: string, key: string): boolean {
  return new RegExp(`^${key}:`, "m").test(fm);
}

describe("t04 agent-persona frontmatter contract (migrated from t04-agent-frontmatter.sh, plan 55)", () => {
  test("name: equals aidlc-<agent>-agent (filename parity) [.sh test 1 x11]", () => {
    for (const agent of AGENTS) {
      expect(existsSync(agentFile(agent))).toBe(true);
      const fm = frontmatter(agent);
      const m = fm.match(/^name:\s*(\S+)/m);
      expect(m, `aidlc-${agent}-agent.md: no name: line in frontmatter`).not.toBeNull();
      expect(m?.[1]).toBe(`aidlc-${agent}-agent`);
    }
  });

  test("description: is present and non-empty [.sh test 2 x11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      expect(
        hasKeyLine(fm, "description"),
        `aidlc-${agent}-agent.md: missing description: field`,
      ).toBe(true);
      const after = fm.split(/^description:/m)[1] ?? "";
      expect(after.trim().length, `aidlc-${agent}-agent.md: empty description`).toBeGreaterThan(0);
    }
  });

  // `allowedTools:` must be ABSENT (ignored field).
  test("allowedTools: is ABSENT (ignored field removed in v0.5.4) [.sh test 3 x11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      // Note: `^allowedTools:` must NOT also trip on `disallowedTools:` - the
      // anchored regex begins-of-line so `disallowedTools:` is not matched.
      expect(
        hasKeyLine(fm, "allowedTools"),
        `aidlc-${agent}-agent.md: allowedTools: field still present`,
      ).toBe(false);
    }
  });

  test("disallowedTools: is exactly one Task denial (no nested subagents) [.sh test 4 x11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      const matches = [
        ...fm.matchAll(/^disallowedTools:\s*(.*?)\s*$/gm),
      ];
      expect(
        matches,
        `aidlc-${agent}-agent.md: expected exactly one disallowedTools: line`,
      ).toHaveLength(1);
      expect(matches[0][1].trim()).toBe("Task");
    }
  });

  // The authored dial matches the documented policy. The dial is `tier:` - a
  // raw `model:`/`effort:` in AUTHORED frontmatter would bypass the projection,
  // so both are pinned ABSENT alongside the value pin.
  test("tier: matches the documented judgment/templated split [.sh test 5 x11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      const m = fm.match(/^tier:\s*(\S+)/m);
      expect(m, `aidlc-${agent}-agent.md: no tier: line`).not.toBeNull();
      expect(m?.[1]).toBe(EXPECTED_TIER[agent]);
      expect(
        hasKeyLine(fm, "model"),
        `aidlc-${agent}-agent.md: raw model: in AUTHORED frontmatter (projection bypass)`,
      ).toBe(false);
      expect(
        hasKeyLine(fm, "effort"),
        `aidlc-${agent}-agent.md: raw effort: in AUTHORED frontmatter (projection bypass)`,
      ).toBe(false);
    }
  });

  // Re-count to pin the plan and guard against an agent being silently dropped
  // from the roster (5 invariants x 11 agents = 55 rows).
  test("covers EXACTLY 11 agents x 5 invariants = 55 frontmatter assertions (TAP plan parity)", () => {
    expect(AGENTS.length).toBe(11);
    expect(Object.keys(EXPECTED_TIER).length).toBe(11);
    const INVARIANTS_PER_AGENT = 5;
    expect(AGENTS.length * INVARIANTS_PER_AGENT).toBe(55);
    for (const agent of AGENTS) {
      expect(EXPECTED_TIER[agent], `no expected tier for ${agent}`).toBeDefined();
    }
  });
});
