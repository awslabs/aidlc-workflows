// core/tools/aidlc-tiers.ts - the tunable-tier projection module.
//
// A per-agent TIER names HOW MUCH JUDGMENT the persona's work demands, and the
// packager projects that single authored fact into each harness's native model
// and effort knobs. `judgment` marks multi-constraint reasoning under ambiguity
// whose output cascades downstream (architect, developer, product, ...): it
// inherits the session's own model and effort so the user's ceiling is never
// silently capped. `balanced` marks reviewer-shaped work (novel input judged
// against explicit criteria): a mid-size model, session effort. `templated`
// marks dominantly pattern-following output whose methodology already lives in
// knowledge (delivery plans, CI/CD config, runbooks): a mid-size model at a
// deliberately reduced effort - the one place the framework steps DOWN on its
// own. Tiers only ever step down, never up, and only for templated work; the
// names describe the WORK, not the dial, so a reader can classify a new agent
// without knowing today's model lineup.
//
// Projection targets (see TIER_PROJECTIONS):
//   - Claude Code   agent .md frontmatter: `model:` and optional `effort:`.
//                   An OMITTED key inherits the session value, and a pinned
//                   `effort:` overrides the session in both directions - a pin
//                   is a cap, not a floor. So `judgment` writes `model:
//                   inherit` and NO effort line; `balanced` writes `model:
//                   sonnet` and NO effort line; only `templated` pins
//                   `effort: medium`.
//   - Codex CLI     agent role .toml: `model` and `model_reasoning_effort`.
//                   Omitted keys fall back to the shipped .codex/config.toml
//                   session defaults (live-verified on codex-cli 0.139.0 - the
//                   doctor floor - AND 0.142.5: a role TOML without `model`
//                   spawns on the config.toml model + effort). `judgment`
//                   omits both keys.
//   - Kiro CLI/IDE  agent surfaces carry a `"model"` value ONLY - kiro-cli
//                   fail-closes on any effort-like key in agent JSON, so no
//                   Kiro agent surface may EVER carry an effort key. Effort
//                   rides on the MODEL via cli.json chat.modelDefaults (see
//                   KIRO_TIER_EFFORT + kiroModelDefaults below). `judgment`
//                   omits `"model"`; the schema-documented fallback is the
//                   user's default model at that model's default effort.
//
// Kiro collapse rule: two tiers whose Kiro model IDs are equal are the same
// tier on Kiro (there is no per-agent effort surface to tell them apart).
// When tiers share a model, the cli.json chat.modelDefaults entry for that
// model takes the HIGHER tier's effort - kiroModelDefaults() computes this.
// Today `balanced` and `templated` both land on claude-sonnet-4.5, so the
// shipped entry is sonnet-4.5 -> "high" (balanced wins the collapse).
//
// Cost-cap override, resolved at PACK time (runtime composition is out of
// scope): the space-memory `tier_cap:` frontmatter key on the layered method
// files (org.md -> team.md -> project.md, last writer wins) is the persistent
// project knob, and the AIDLC_TIER_CAP env var is the per-invocation override
// that beats it. Setting the cap to `balanced` collapses `judgment` to
// `balanced` in every projection; `templated` collapses both higher tiers.
// See resolveTierCap().

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The tier vocabulary, ordered HIGH to LOW. The order is load-bearing:
 *  capTier() clamps by index, so index 0 is the top rung. */
export const TIERS = ["judgment", "balanced", "templated"] as const;

export type Tier = (typeof TIERS)[number];

/** Claude Code agent-frontmatter effort values (sub-agent contract). */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** Codex model_reasoning_effort values (config.toml contract). */
export type CodexEffort = "low" | "medium" | "high" | "xhigh";
/** Kiro effort values (chat.modelDefaults / --effort contract). */
export type KiroEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** opencode agent-frontmatter `variant` values (provider-specific reasoning
 *  effort; the Anthropic-on-Bedrock provider accepts these). */
export type OpencodeVariant = "low" | "medium" | "high" | "max";

/** Per-harness projection of one tier. A `null` model or effort means the
 *  harness-native key is OMITTED so the harness's own session/config default
 *  applies ("inherit" on Claude is an explicit frontmatter value, so it stays
 *  a string there). The kiro slot is model-only BY DESIGN: kiro-cli rejects
 *  effort-like keys in agent surfaces (fail-closed schema), so the type makes
 *  an effort leak structurally impossible - Kiro effort lives in
 *  KIRO_TIER_EFFORT and reaches users via cli.json, never the agent files. */
export type TierProjection = {
  claude: { model: string; effort: ClaudeEffort | null };
  codex: { model: string | null; effort: CodexEffort | null };
  kiro: { model: string | null };
  /** opencode agent .md frontmatter: `model:` ("provider/model-id") and
   *  optional `variant:` (reasoning effort). Omitted keys inherit the
   *  session's opencode.json defaults — same inherit-by-omission contract
   *  as codex. */
  opencode: { model: string | null; variant: OpencodeVariant | null };
};

export type Harness = keyof TierProjection;

/** The projection table. Tune here; every harness moves in lock-step. */
export const TIER_PROJECTIONS: Record<Tier, TierProjection> = {
  judgment: {
    // The session's model AND effort win: `inherit` follows the session model
    // (a Fable session keeps Fable), and the omitted effort key follows the
    // session effort. The framework never silently downgrades judgment work.
    claude: { model: "inherit", effort: null },
    codex: { model: null, effort: null },
    kiro: { model: null },
    opencode: { model: null, variant: null },
  },
  balanced: {
    claude: { model: "sonnet", effort: null },
    codex: { model: "openai.gpt-5.4", effort: null },
    kiro: { model: "claude-sonnet-4.5" },
    opencode: { model: "amazon-bedrock/global.anthropic.claude-sonnet-4-6", variant: null },
  },
  templated: {
    // The one deliberate downgrade: a smaller model at reduced effort for
    // pattern-following output.
    claude: { model: "sonnet", effort: "medium" },
    codex: { model: "openai.gpt-5.4", effort: "medium" },
    kiro: { model: "claude-sonnet-4.5" },
    opencode: { model: "amazon-bedrock/global.anthropic.claude-sonnet-4-6", variant: "medium" },
  },
};

/** Kiro effort per tier - used ONLY to derive cli.json chat.modelDefaults
 *  entries (effort rides on the model on Kiro, never on the agent). Kept out
 *  of TierProjection so no agent-surface writer can reach it. `judgment` is
 *  absent deliberately: it pins no Kiro model, so there is no model entry to
 *  carry its effort - judgment agents run at the user's default model's own
 *  default effort. */
export const KIRO_TIER_EFFORT: Partial<Record<Tier, KiroEffort>> = {
  balanced: "high",
  templated: "medium",
};

export function isTier(v: string): v is Tier {
  return (TIERS as readonly string[]).includes(v);
}

/** Clamp tier `t` to the ceiling `cap` (both-null-safe). TIERS is ordered
 *  high to low, so the clamped tier is the one with the LARGER index. */
export function capTier(t: Tier, cap: Tier | null | undefined): Tier {
  if (!cap) return t;
  return TIERS[Math.max(TIERS.indexOf(t), TIERS.indexOf(cap))];
}

/** Read the AIDLC_TIER_CAP env var. Unset/empty -> null; an unknown value is
 *  a loud error (the packager must fail, not silently ship uncapped). */
export function readEnvCap(env: NodeJS.ProcessEnv = process.env): Tier | null {
  const v = env.AIDLC_TIER_CAP;
  if (!v) return null;
  if (isTier(v)) return v;
  throw new Error(
    `AIDLC_TIER_CAP=${JSON.stringify(v)} is not a valid tier; use one of ${TIERS.join(", ")}`,
  );
}

// The layered method files a tier_cap: may ride on, in precedence order
// (later files override earlier ones - the same last-writer-wins order the
// rule resolver applies to org -> team -> project).
const MEMORY_CAP_FILES = ["org.md", "team.md", "project.md"] as const;

/** Extract a `tier_cap:` scalar from a method file's YAML frontmatter block.
 *  Returns null when the file has no frontmatter or no tier_cap: line. A
 *  PRESENT key with an empty or invalid value throws, naming the file - a
 *  user who wrote the key believes the cap is active, so silently ignoring a
 *  malformed value would ship uncapped agents without any error. Tolerates
 *  the common YAML scalar spellings: quoted values and trailing comments. */
function tierCapFromFrontmatter(raw: string, file: string): Tier | null {
  const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const m = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const kv = m[1].match(/^tier_cap:(.*)$/m);
  if (!kv) return null;
  // Strip a trailing comment, whitespace, and matching quotes.
  let v = kv[1].replace(/\s#.*$/, "").trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1).trim();
  }
  if (isTier(v)) return v;
  throw new Error(
    `${file}: tier_cap: ${JSON.stringify(v)} is not a valid tier; use one of ${TIERS.join(", ")}`,
  );
}

/** Read the persistent tier cap from the space memory layer: org.md, team.md,
 *  project.md under `memoryDir`, in that order, LAST writer wins (a project
 *  may lower OR raise the org ceiling). Missing dir or files -> null. */
export function readMemoryCap(memoryDir: string): Tier | null {
  let cap: Tier | null = null;
  for (const f of MEMORY_CAP_FILES) {
    const p = join(memoryDir, f);
    if (!existsSync(p)) continue;
    const found = tierCapFromFrontmatter(readFileSync(p, "utf-8"), p);
    if (found) cap = found;
  }
  return cap;
}

/** The effective pack-time cap: the AIDLC_TIER_CAP env var (per-invocation)
 *  beats the space-memory `tier_cap:` key (persistent), which itself resolves
 *  org -> team -> project, last writer wins. */
export function resolveTierCap(
  memoryDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Tier | null {
  return readEnvCap(env) ?? readMemoryCap(memoryDir);
}

/** Project one tier onto one harness, applying the cap. This is the ONE seam
 *  the packager and the codex emit call; every harness gets an identically
 *  derived projection. Throws on an unknown tier string so a typo in agent
 *  frontmatter fails the build loudly. */
export function projectTier<H extends Harness>(
  t: string,
  harness: H,
  cap: Tier | null = null,
): TierProjection[H] {
  if (!isTier(t)) {
    throw new Error(`unknown tier ${JSON.stringify(t)}; use one of ${TIERS.join(", ")}`);
  }
  return TIER_PROJECTIONS[capTier(t, cap)][harness];
}

/** Derive the Kiro cli.json chat.modelDefaults entries the tier table needs:
 *  one entry per DISTINCT pinned Kiro model, carrying the HIGHEST sharing
 *  tier's effort (the Kiro collapse rule - when tiers share a model there is
 *  no per-agent surface to tell them apart, so the more demanding tier's
 *  effort wins). Tiers with no pinned Kiro model (judgment) contribute no
 *  entry. NOTE: the orchestrator's own model entry (claude-opus-4.8 ->
 *  xhigh) is authored in the per-harness kiro settings cli.json, outside
 *  this table - the orchestrator agent is not a tier-carrying persona. */
export function kiroModelDefaults(cap: Tier | null = null): Record<string, KiroEffort> {
  const out: Record<string, KiroEffort> = {};
  // TIERS is ordered high to low, so the first tier to claim a model wins -
  // exactly the "higher tier's effort" collapse rule.
  for (const tier of TIERS) {
    const model = TIER_PROJECTIONS[capTier(tier, cap)].kiro.model;
    const effort = KIRO_TIER_EFFORT[capTier(tier, cap)];
    if (!model || !effort) continue;
    if (!(model in out)) out[model] = effort;
  }
  return out;
}
