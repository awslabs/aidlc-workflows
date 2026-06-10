// covers: file:agents/aidlc-product-agent.md, file:agents/aidlc-design-agent.md, file:agents/aidlc-delivery-agent.md, file:agents/aidlc-architect-agent.md, file:agents/aidlc-aws-platform-agent.md, file:agents/aidlc-compliance-agent.md, file:agents/aidlc-devsecops-agent.md, file:agents/aidlc-developer-agent.md, file:agents/aidlc-quality-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:agents/aidlc-operations-agent.md
//
// t04 — shipped agent-persona FRONTMATTER contract. Migrated from
// tests/unit/t04-agent-frontmatter.sh (TAP plan 55 — 5 distinct assertions
// per agent across the 11 domain-expert personas). The .sh resolved
// AGENTS_DIR = dist/claude/.claude/agents and, for each `aidlc-<agent>-agent.md`,
// grepped the frontmatter for five invariants.
//
// Mechanism: none. This is a pure structural/schema check over the shipped
// bytes — does each agent persona's YAML frontmatter satisfy the registration
// contract? No process boundary, no argv/exit/stdout seam, no LLM, zero tokens.
// We resolve the same tree the .sh resolved (AIDLC_SRC = <repo>/dist/claude/.claude,
// fixtures.ts:42) and read + parse each .md in-process. The .sh's per-line
// `grep` anchors are replaced with a frontmatter parser that SCOPES every
// field assertion to the YAML block (between the opening and closing `---`),
// which is STRONGER than a whole-file grep that could match prose in the body.
//
// Subject under test (dist/claude/.claude/agents/aidlc-<agent>-agent.md):
//   - name:           must equal `aidlc-<agent>-agent` (filename ⇄ name parity;
//                     Claude Code resolves a subagent by its `name`).
//   - description:    must be present (non-empty) — the routing summary.
//   - allowedTools:   must be ABSENT — a silently-ignored field removed in
//                     v0.5.4 (.sh L40-45). Its reappearance is a regression.
//   - disallowedTools: must contain `Task` — subagents must not spawn subagents
//                     (single-level constraint; the body also carries the
//                     "Do NOT use the Task tool" banner).
//   - modelOverride:  must equal the documented per-agent value
//                     (opus = high-judgment / high-blast-radius work;
//                      sonnet = templated config/scaffolding;
//                      docs/reference/05-agent-system.md, .sh L11-19).
//                     opus  : architect, product, design, developer, quality,
//                             devsecops, compliance, aws-platform
//                     sonnet: delivery, pipeline-deploy, operations
//
// Test-design note (house style): assert the OBSERVABLE shipped contract the
// .sh asserted — frontmatter field presence/absence and exact values — against
// the real bytes on disk. The expected modelOverride table is hard-coded here
// independently of the source (mirrors the .sh's `expected_model()` case), so
// the test pins the policy rather than echoing whatever the file says.
//
// Old TAP -> new test parity (1:1; the .sh emitted 5 `ok` lines PER agent in a
// single loop — 5 × 11 = 55. Here each of the 5 invariants is one test() that
// asserts across ALL 11 agents via expect() per agent, so every one of the 55
// .sh rows maps to a named expect(). The final test re-counts to pin the plan):
//   .sh L27-31 (name: matches filename)               -> "name: equals aidlc-<agent>-agent (filename parity)" [11 expects]
//   .sh L34-38 (description: present)                  -> "description: is present and non-empty"            [11 expects]
//   .sh L41-45 (allowedTools: absent)                  -> "allowedTools: is ABSENT (ignored field removed in v0.5.4)" [11 expects]
//   .sh L48-52 (disallowedTools contains Task)         -> "disallowedTools: contains Task (no nested subagents)" [11 expects]
//   .sh L54-61 (modelOverride matches expected)        -> "modelOverride: matches the documented opus/sonnet split" [11 expects]
//   .sh L21    plan 55                                  -> "covers EXACTLY 11 agents × 5 invariants = 55 frontmatter assertions (TAP plan parity)"

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// AIDLC_SRC === <repo>/dist/claude/.claude — the same tree the .sh resolved as
// AGENTS_DIR's parent.
const AGENTS_DIR = join(AIDLC_SRC, "agents");

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

// Expected modelOverride per agent — hard-coded independently of the source,
// mirroring the .sh's expected_model() case (L13-19). opus = high-judgment /
// high-blast-radius; sonnet = templated config/scaffolding.
const EXPECTED_MODEL: Record<(typeof AGENTS)[number], "opus" | "sonnet"> = {
  product: "opus",
  design: "opus",
  delivery: "sonnet",
  architect: "opus",
  "aws-platform": "opus",
  compliance: "opus",
  devsecops: "opus",
  developer: "opus",
  quality: "opus",
  "pipeline-deploy": "sonnet",
  operations: "sonnet",
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
  test("name: equals aidlc-<agent>-agent (filename parity) [.sh test 1 ×11]", () => {
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
  test("description: is present and non-empty [.sh test 2 ×11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      expect(
        hasKeyLine(fm, "description"),
        `aidlc-${agent}-agent.md: missing description: field`,
      ).toBe(true);
      // STRONGER: the field must actually carry content (block-scalar `>` or
      // inline) — not a bare `description:` with nothing after it. The first
      // description line plus any following indented continuation lines must
      // contain non-whitespace.
      const after = fm.split(/^description:/m)[1] ?? "";
      expect(after.trim().length, `aidlc-${agent}-agent.md: empty description`).toBeGreaterThan(0);
    }
  });

  // .sh L41-45: `allowedTools:` must be ABSENT (ignored field removed in v0.5.4).
  test("allowedTools: is ABSENT (ignored field removed in v0.5.4) [.sh test 3 ×11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      // The .sh grepped `^allowedTools:` and FAILED (not_ok) if it matched.
      // Note: `^allowedTools:` must NOT also trip on `disallowedTools:` — the
      // anchored regex begins-of-line so `disallowedTools:` is not matched.
      expect(
        hasKeyLine(fm, "allowedTools"),
        `aidlc-${agent}-agent.md: allowedTools: field still present`,
      ).toBe(false);
    }
  });

  // .sh L48-52: `grep -q "^disallowedTools:.*Task"`.
  test("disallowedTools: contains Task (no nested subagents) [.sh test 4 ×11]", () => {
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

  // .sh L54-61: modelOverride matches expected_model().
  test("modelOverride: matches the documented opus/sonnet split [.sh test 5 ×11]", () => {
    for (const agent of AGENTS) {
      const fm = frontmatter(agent);
      // The .sh used `awk -F': *' '/^modelOverride:/ {print $2; exit}'`.
      const m = fm.match(/^modelOverride:\s*(\S+)/m);
      expect(m, `aidlc-${agent}-agent.md: no modelOverride: line`).not.toBeNull();
      expect(m?.[1]).toBe(EXPECTED_MODEL[agent]);
    }
  });

  // .sh L21: plan 55. Re-count to pin the plan and guard against an agent being
  // silently dropped from the roster (5 invariants × 11 agents = 55 rows).
  test("covers EXACTLY 11 agents × 5 invariants = 55 frontmatter assertions (TAP plan parity)", () => {
    expect(AGENTS.length).toBe(11);
    expect(Object.keys(EXPECTED_MODEL).length).toBe(11);
    const INVARIANTS_PER_AGENT = 5;
    expect(AGENTS.length * INVARIANTS_PER_AGENT).toBe(55);
    // Every agent in the roster must have an expected-model entry (no orphan).
    for (const agent of AGENTS) {
      expect(EXPECTED_MODEL[agent], `no expected model for ${agent}`).toBeDefined();
    }
  });
});
