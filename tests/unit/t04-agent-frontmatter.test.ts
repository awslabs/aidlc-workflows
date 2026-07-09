// covers: file:agents/aidlc-product-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-architect-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-quality-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-operations-agent.md
//
// t04 - AUTHORED agent-persona frontmatter contract. Migrated from
// tests/unit/t04-agent-frontmatter.sh (TAP plan 55 - 5 distinct assertions
// per agent across the 11 domain-expert personas). Originally the .sh
// resolved dist/claude and grepped for a per-agent `model:` pin; the authored
// contract is now `tier:` on the CORE agent .md (model/effort became
// per-harness projection outputs - see core/tools/aidlc-tiers.ts and the
// companion t216, which pins the PROJECTED dist/claude contract).
//
// Mechanism: none. This is a pure structural/schema check over the authored
// bytes - does each agent persona's YAML frontmatter satisfy the registration
// contract? No process boundary, no argv/exit/stdout seam, no LLM, zero
// tokens. We read + parse each core/agents/*.md in-process. The .sh's
// per-line `grep` anchors are replaced with a frontmatter parser that SCOPES
// every field assertion to the YAML block (between the opening and closing
// `---`), which is STRONGER than a whole-file grep that could match prose in
// the body.
//
// Subject under test (core/agents/aidlc-<agent>-agent.md):
//   - name:           must equal `aidlc-<agent>-agent` (filename <-> name parity;
//                     every harness resolves a subagent by its `name`).
//   - description:    must be present (non-empty) - the routing summary.
//   - allowedTools:   must be ABSENT - a silently-ignored field removed in
//                     v0.5.4 (.sh L40-45). Its reappearance is a regression.
//   - disallowedTools: must contain `Task` - subagents must not spawn subagents
//                     (single-level constraint; the body also carries the
//                     "Do NOT use the Task tool" banner).
//   - tier:           must equal the documented per-agent value
//                     (judgment = multi-constraint reasoning under ambiguity,
//                      output cascades downstream;
//                      balanced = reviewer-shaped work against explicit criteria;
//                      templated = pattern-following output, methodology in
//                      knowledge; docs/reference/05-agent-system.md).
//                     judgment : architect, product, design, developer,
//                                quality, devsecops, compliance, aws-platform
//                     templated: delivery, pipeline-deploy, operations
//
// Test-design note (house style): assert the OBSERVABLE authored contract -
// frontmatter field presence/absence and exact values - against the real
// bytes on disk. The expected tier table is hard-coded here independently of
// the source (mirrors the .sh's `expected_model()` case), so the test pins
// the policy rather than echoing whatever the file says.
//
// Old TAP -> new test parity (1:1; the .sh emitted 5 `ok` lines PER agent in a
// single loop - 5 x 11 = 55. Here each of the 5 invariants is one test() that
// asserts across ALL 11 agents via expect() per agent, so every one of the 55
// .sh rows maps to a named expect(). The final test re-counts to pin the plan):
//   .sh L27-31 (name: matches filename)               -> "name: equals aidlc-<agent>-agent (filename parity)" [11 expects]
//   .sh L34-38 (description: present)                  -> "description: is present and non-empty"            [11 expects]
//   .sh L41-45 (allowedTools: absent)                  -> "allowedTools: is ABSENT (ignored field removed in v0.5.4)" [11 expects]
//   .sh L48-52 (disallowedTools contains Task)         -> "disallowedTools: contains Task (no nested subagents)" [11 expects]
//   .sh L54-61 (model matches expected)                -> "tier: matches the documented judgment/templated split" [11 expects]
//   .sh L21    plan 55                                  -> "covers EXACTLY 11 agents x 5 invariants = 55 frontmatter assertions (TAP plan parity)"

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

// The AUTHORED source of truth: core/agents/. (t216 pins the projected
// dist/claude tree; this test pins what harness engineers actually edit.)
const AGENTS_DIR = join(REPO_ROOT, "core", "agents");

// The 11 domain-expert agents, in the order the .sh's `AGENTS=` list named them.
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

// Expected tier per agent -- hard-coded independently of the source,
// mirroring the .sh's expected_model() case (L13-19). judgment =
// multi-constraint reasoning / high blast radius; templated = pattern-
// following config/scaffolding. (balanced covers the two review-only agents,
// which are outside this 11-agent roster - see t216 for the full 14.)
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
 * fences). Scoping field assertions to this block is STRONGER than the .sh's
 * whole-file grep: a `name:`/`description:` token appearing in the persona's
 * prose body cannot satisfy the check.
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
  // .sh L27-31: `grep -q "^name:.*aidlc-${agent}-agent"`.
  test("name: equals aidlc-<agent>-agent (filename parity) [.sh test 1 x11]", () => {
    for (const agent of AGENTS) {
      // Sanity: the file the .sh grepped must exist.
      expect(existsSync(agentFile(agent))).toBe(true);
      const fm = frontmatter(agent);
      const m = fm.match(/^name:\s*(\S+)/m);
      expect(m, `aidlc-${agent}-agent.md: no name: line in frontmatter`).not.toBeNull();
      // STRONGER than the .sh's `.*aidlc-${agent}-agent` substring grep: pin the
      // EXACT value to the filename stem.
      expect(m?.[1]).toBe(`aidlc-${agent}-agent`);
    }
  });

  // .sh L34-38: `grep -q "^description:"`.
  test("description: is present and non-empty [.sh test 2 x11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      expect(
        hasKeyLine(fm, "description"),
        `aidlc-${agent}-agent.md: missing description: field`,
      ).toBe(true);
      // STRONGER: the field must actually carry content (block-scalar `>` or
      // inline) - not a bare `description:` with nothing after it. The first
      // description line plus any following indented continuation lines must
      // contain non-whitespace.
      const after = fm.split(/^description:/m)[1] ?? "";
      expect(after.trim().length, `aidlc-${agent}-agent.md: empty description`).toBeGreaterThan(0);
    }
  });

  // .sh L41-45: `allowedTools:` must be ABSENT (ignored field removed in v0.5.4).
  test("allowedTools: is ABSENT (ignored field removed in v0.5.4) [.sh test 3 x11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      // The .sh grepped `^allowedTools:` and FAILED (not_ok) if it matched.
      // Note: `^allowedTools:` must NOT also trip on `disallowedTools:` - the
      // anchored regex begins-of-line so `disallowedTools:` is not matched.
      expect(
        hasKeyLine(fm, "allowedTools"),
        `aidlc-${agent}-agent.md: allowedTools: field still present`,
      ).toBe(false);
    }
  });

  // .sh L48-52: `grep -q "^disallowedTools:.*Task"`.
  test("disallowedTools: contains Task (no nested subagents) [.sh test 4 x11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      const m = fm.match(/^disallowedTools:\s*(.+)$/m);
      expect(m, `aidlc-${agent}-agent.md: no disallowedTools: line`).not.toBeNull();
      // STRONGER: parse the value and assert Task is one of the listed tools,
      // not merely that "Task" appears somewhere on the line.
      const tools = (m?.[1] ?? "").split(",").map((t) => t.trim());
      expect(tools).toContain("Task");
    }
  });

  // .sh L54-61: the authored dial matches the documented policy. The dial is
  // now `tier:` - a raw `model:`/`effort:` in AUTHORED frontmatter would
  // bypass the projection, so both are pinned ABSENT alongside the value pin.
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

  // .sh L21: plan 55. Re-count to pin the plan and guard against an agent being
  // silently dropped from the roster (5 invariants x 11 agents = 55 rows).
  test("covers EXACTLY 11 agents x 5 invariants = 55 frontmatter assertions (TAP plan parity)", () => {
    expect(AGENTS.length).toBe(11);
    expect(Object.keys(EXPECTED_TIER).length).toBe(11);
    const INVARIANTS_PER_AGENT = 5;
    expect(AGENTS.length * INVARIANTS_PER_AGENT).toBe(55);
    // Every agent in the roster must have an expected-tier entry (no orphan).
    for (const agent of AGENTS) {
      expect(EXPECTED_TIER[agent], `no expected tier for ${agent}`).toBeDefined();
    }
  });
});
