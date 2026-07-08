// core/tools/aidlc-tiers.ts - the tunable-tier projection (SPIKE).
//
// A per-agent TIER expresses HOW MUCH JUDGMENT the persona brings. It replaces
// the raw `model: opus|sonnet` pin in each agent's frontmatter as the authored
// source of truth. The packager reads `tier:` from core/agents/*.md and
// PROJECTS it into the per-harness delivery form:
//
//   - Claude Code   -> `model: <alias|inherit>` + `effort: <low|medium|high>`
//                      in the agent's .md frontmatter (Claude Code reads both).
//   - Codex CLI     -> `model = "..."` + `model_reasoning_effort = "..."` in
//                      the agent's .codex/agents/*.toml.
//   - Kiro CLI/IDE  -> the `"model"` field in harness/kiro*/agents/*.json;
//                      no effort field is authored today (see NOTE below).
//
// The three tiers, and why THESE names:
//   `judgment`   Multi-constraint reasoning under ambiguity, output cascades
//                downstream (architect, developer, product, design, ...). This
//                is the persona that must NOT be silently downgraded, but its
//                model direction should not be PINNED to opus either: a Fable
//                session running an architect agent should stay on Fable, not
//                be dragged back to opus. Claude projection = MODEL INHERIT +
//                effort high. That respects the session (the commenter's
//                request) while still guaranteeing a reasoning budget.
//   `balanced`   Reviewer-shaped work: novel input, explicit criteria, "find
//                what's wrong" not "invent the answer" (architecture-reviewer,
//                product-lead). Needs enough headroom to spot gaps but the
//                methodology is largely encoded in the review checklist.
//                Claude projection = sonnet + high effort.
//   `templated`  Dominantly pattern-following output; methodology already in
//                knowledge (delivery plans, CI/CD YAML, runbooks). Claude
//                projection = sonnet + medium effort.
//
// Why not `high|medium|low`?
//   Those name the DIAL, not the work. A reader can't tell whether "low" is a
//   cost dial or a quality one, and the name reads as "less important" for
//   personas that are simply pattern-following. Naming the WORK makes the tier
//   assignment a domain judgment (is this reasoning-heavy or template-heavy?)
//   instead of a budgeting judgment.
//
// NOTE: Kiro-CLI-and-IDE per-agent effort capability is UNKNOWN today. The
// projection here writes only the "model" field; the design tolerates that
// harness having no effort surface (graceful degradation) and can grow to
// write an effort key once Kiro exposes one.
//
// NOTE: the ONE override seam the spike ships is the AIDLC_TIER_CAP env var,
// read at pack time. Setting AIDLC_TIER_CAP=balanced collapses `judgment` to
// `balanced` in every projection (cost cap); AIDLC_TIER_CAP=templated collapses
// both higher tiers. Per-agent overrides live in the .md frontmatter itself
// (change one agent's `tier:` in your dist copy after install). A runtime
// memory-layer knob (org.md / project.md) is the productionization path; see
// tmp/effort-spike/tier/DESIGN.md for the alternatives.

export type Tier = "judgment" | "balanced" | "templated";

export const TIERS: readonly Tier[] = ["judgment", "balanced", "templated"] as const;

// Claude Code effort keys, per the code.claude.com/docs/en/sub-agents contract.
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
// Codex effort keys (config.toml model_reasoning_effort).
export type CodexEffort = "low" | "medium" | "high" | "xhigh";

/** Per-harness projection of one tier. */
export type TierProjection = {
  claude: { model: string; effort: ClaudeEffort };
  codex: { model: string; effort: CodexEffort };
  // Kiro CLI/IDE: the value of the "model" JSON field. No effort key today
  // (Kiro's per-agent effort surface is unknown / unshipped).
  kiro: { model: string };
};

// The projection table. Tune here; every harness moves in lock-step.
export const TIER_PROJECTIONS: Record<Tier, TierProjection> = {
  judgment: {
    // MODEL INHERIT lets a Fable-session user stay on Fable (the point of
    // this whole spike). effort:high guarantees the reasoning budget the
    // persona expects, regardless of which model the session pins.
    claude: { model: "inherit", effort: "high" },
    codex: { model: "openai.gpt-5.5", effort: "high" },
    kiro: { model: "claude-opus-4.8" },
  },
  balanced: {
    claude: { model: "sonnet", effort: "high" },
    codex: { model: "openai.gpt-5.4", effort: "high" },
    kiro: { model: "claude-sonnet-4.5" },
  },
  templated: {
    claude: { model: "sonnet", effort: "medium" },
    codex: { model: "openai.gpt-5.4", effort: "medium" },
    kiro: { model: "claude-sonnet-4.5" },
  },
};

// Cost-cap collapse: return the tier `t` clamped to the ceiling `cap`.
// TIERS is ordered high-to-low, so an index-max is the ceiling.
export function capTier(t: Tier, cap: Tier | null): Tier {
  if (!cap) return t;
  const tI = TIERS.indexOf(t);
  const cI = TIERS.indexOf(cap);
  return TIERS[Math.max(tI, cI)];
}

// Read the AIDLC_TIER_CAP env var; return null if unset or invalid. The
// packager applies this cap uniformly across every harness at projection time.
export function readEnvCap(env: NodeJS.ProcessEnv = process.env): Tier | null {
  const v = env.AIDLC_TIER_CAP;
  if (!v) return null;
  if ((TIERS as readonly string[]).includes(v)) return v as Tier;
  throw new Error(
    `AIDLC_TIER_CAP=${JSON.stringify(v)} is not a valid tier; ` +
      `use one of ${TIERS.join(", ")}`,
  );
}

// Project one tier to one harness, applying the env cap. This is the ONE seam
// the packager calls; every harness gets an identically-derived projection.
export function projectTier(
  t: Tier,
  harness: "claude" | "codex" | "kiro",
  env: NodeJS.ProcessEnv = process.env,
): TierProjection[keyof TierProjection] {
  const effective = capTier(t, readEnvCap(env));
  return TIER_PROJECTIONS[effective][harness];
}

// The authored default tier for each shipped agent slug. This is a placement
// tool: it maps the current opus/sonnet split onto tiers so the frontmatter
// re-authoring commit is mechanical, not judgemental.
export const AUTHORED_TIER: Record<string, Tier> = {
  "aidlc-architect-agent": "judgment",
  "aidlc-architecture-reviewer-agent": "balanced",
  "aidlc-aws-platform-agent": "judgment",
  "aidlc-compliance-agent": "judgment",
  "aidlc-composer-agent": "judgment",
  "aidlc-delivery-agent": "templated",
  "aidlc-design-agent": "judgment",
  "aidlc-developer-agent": "judgment",
  "aidlc-devsecops-agent": "judgment",
  "aidlc-operations-agent": "templated",
  "aidlc-pipeline-deploy-agent": "templated",
  "aidlc-product-agent": "judgment",
  "aidlc-product-lead-agent": "balanced",
  "aidlc-quality-agent": "judgment",
};
