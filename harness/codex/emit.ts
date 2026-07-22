// harness/codex/emit.ts — the Codex CLI per-shell emission plugin.
//
// The unified packager copies core/ → dist/codex/.codex/ (rules → aidlc-rules)
// and runs graph compile, then calls this emit() for everything that is CODE,
// not declarative data: the Codex config, hook wiring, trust pre-seed, the
// AGENTS.md merge, the per-agent TOML transpositions, and the .agents/skills/
// tree (orchestrator + generated runners + session skills + openai.yaml guards).
//
// Ported faithfully from the proven scripts/package-codex.ts emission half
// (spike tip d465886). The ONE transform class is the harness-dir token /
// anchored-prefix family, exposed via ctx.substituteToken plus a local
// aidlc-rules rename mirroring the packager's. Nothing here invents a new sed.
//
// emit() also owns the codex compiled-data + skills layout: skills do NOT ship
// in .codex/skills/ (Codex discovers skills at <project>/.agents/skills/), so
// the manifest sets skipRunnerGen and emit composes the runners here.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, win32 } from "node:path";
import { stringify } from "smol-toml";
import type { EmitContext } from "../../scripts/manifest-types.ts";
import { renderOnboarding } from "../../scripts/onboarding.ts";
import onboardingFills from "./onboarding.fills.ts";
import { projectTier } from "../../core/tools/aidlc-tiers.ts";

// ---------------------------------------------------------------------------
// Hook wiring (kiro-normative shape: register ONLY events with a real core-hook
// consumer; dropped hooks ship unregistered).
// ---------------------------------------------------------------------------
const HOOK_WIRING: Array<{ event: string; matcher?: string; target: string }> = [
  { event: "SessionStart", target: "session-start" },
  { event: "UserPromptSubmit", target: "mint" },
  { event: "PreToolUse", target: "state-transition-guard" },
  // No matcher: the reviewer-scope target self-filters (Bash + apply_patch;
  // everything else exits 0 instantly), and Codex read access rides the shell
  // tool anyway. Verified on 0.142.5: subagent tool calls carry agent_type,
  // and a PreToolUse exit 2 + stderr blocks the call with the reason relayed.
  { event: "PreToolUse", target: "reviewer-scope" },
  { event: "PostToolUse", matcher: "apply_patch", target: "audit-and-sensors" },
  { event: "PostToolUse", matcher: "update_plan", target: "state-sync" },
  { event: "PostToolUse", matcher: "Bash", target: "runtime-compile" },
  { event: "PreCompact", target: "validate-state" },
  { event: "SubagentStop", target: "log-subagent" },
  { event: "Stop", target: "stop" },
];

const adapterCmd = (harnessDir: string, target: string) =>
  `bun ${harnessDir}/hooks/aidlc-codex-adapter.ts ${target}`;

function emitHooksJson(harnessDir: string): string {
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const { event, matcher, target } of HOOK_WIRING) {
    const group: Record<string, unknown> = {
      hooks: [{ type: "command", command: adapterCmd(harnessDir, target) }],
    };
    if (matcher) group.matcher = matcher;
    hooks[event] ??= [];
    hooks[event].push(group);
  }
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

function emitConfigToml(): string {
  return `# dist/codex shipped config — copy into the project's .codex/config.toml
# (trusted projects) or merge into ~/.codex/config.toml.
#
# Model: these session defaults are what judgment-tier agent roles inherit
# (their TOMLs omit model/model_reasoning_effort by design - see the tier
# projection); balanced/templated roles pin gpt-5.4 per the tier table.
# D-9: Amazon Bedrock is the shipped default provider (web_search is
# unavailable there; the market-research stage degrades gracefully). For
# OpenAI-auth setups, comment out model_provider and the [model_providers]
# block.
model = "openai.gpt-5.5"
model_provider = "amazon-bedrock"
model_context_window = 1000000
model_reasoning_effort = "high"

[model_providers.amazon-bedrock.aws]
# Set to your AWS profile/region with Bedrock model access.
profile = "default"
region = "us-east-1"

# The AIDLC method (the markdown rule layers: org/team/project + phases/) now
# lives at the workspace root under aidlc/spaces/<space>/memory/ — the single
# hand-editable source of truth, identical on every harness (NOT a per-harness
# copy under .codex/). The AIDLC_RULES_DIR seam below ships pointed at the
# always-present default space; /aidlc space <name> re-points it IN PLACE so
# the next session's resolver follows the active space (a byte-identical no-op at
# default). Codex also auto-merges the root AGENTS.md and the orchestrator
# injects an @aidlc/spaces/<space>/memory/... prompt mention to pull specific
# method files into context on demand. (.codex/rules/ remains Codex's native
# Starlark permission-rules dir — D-10 — distinct from the AIDLC method.)
[shell_environment_policy]
set = { AIDLC_RULES_DIR = "aidlc/spaces/default/memory" }

# Sandbox: workspace-write keeps <workspace>/.git read-only BY DESIGN;
# interactive sessions escalate (deny -> approve -> retry unsandboxed) and the
# shipped rules/default.rules pre-allows git worktree/commit/add prefixes so
# escalations vanish. HEADLESS runs (codex exec workers, CI, test drivers)
# cannot escalate: uncomment writable_roots with the MAIN repo's absolute
# .git path (linked worktrees resolve into <main>/.git/worktrees/*).
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
# writable_roots = ["/absolute/path/to/main-repo/.git"]

# Gates (D-3 both-track): prose gates are the floor; these flags enable the
# structured request_user_input tool (verified working at 0.137.0+; the
# default-mode flag is under development and prints a warning banner).
[tools]
experimental_request_user_input = { enabled = true }

[features]
default_mode_request_user_input = true

# Statusline (D-6): predefined item IDs only; task-progress is fed by the
# update_plan tool, which the orchestrator skill keeps current per stage.
[tui]
status_line = ["model-with-reasoning", "git-branch", "task-progress", "context-used"]
`;
}

function emitDefaultRules(harnessDir: string): string {
  return `# dist/codex shipped permission rules (Starlark) — ${harnessDir}/rules/ is
# Codex's NATIVE rules dir (this file), distinct from the AIDLC markdown rule
# layers at ${harnessDir}/aidlc-rules/ (D-10 rename).
#
# bun tool allowlist: the deterministic core runs via these exact prefixes.
prefix_rule(pattern = ["bun", "${harnessDir}/tools/"], decision = "allow")
prefix_rule(pattern = ["bun", "${harnessDir}/hooks/"], decision = "allow")

# Git allow-rules (S9d): workspace-write keeps .git read-only in-sandbox and
# routes git writes through escalation; these prefix rules pre-approve the
# retry-unsandboxed step so Bolt worktree/commit flows run friction-free.
prefix_rule(pattern = ["git", "worktree"], decision = "allow")
prefix_rule(pattern = ["git", "commit"], decision = "allow")
prefix_rule(pattern = ["git", "add"], decision = "allow")
`;
}

// S9a trust-hash recipe. Identity = {event_name: <snake>, hooks: [{async:false,
// command, timeout:600, type:"command"}]} → canonical JSON (sorted keys,
// compact) → sha256.
function trustHash(eventSnake: string, command: string): string {
  const identity = {
    event_name: eventSnake,
    hooks: [{ async: false, command, timeout: 600, type: "command" }],
  };
  const sortKeys = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(sortKeys);
    if (o !== null && typeof o === "object") {
      return Object.fromEntries(
        Object.keys(o as Record<string, unknown>)
          .sort()
          .map((k) => [k, sortKeys((o as Record<string, unknown>)[k])]),
      );
    }
    return o;
  };
  const blob = JSON.stringify(sortKeys(identity));
  return "sha256:" + createHash("sha256").update(blob, "utf-8").digest("hex");
}

const SNAKE: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  PermissionRequest: "permission_request",
  PreCompact: "pre_compact",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
};

// Trust entries keyed on "<abs hooks.json path>:<event_snake>:<group>:<idx>".
// Exported so the `trust` subcommand (aidlc-codex-trust.ts) can print
// installer-substituted entries.
export function trustEntries(
  projectDir: string,
  hooksJsonPath?: string,
  harnessDir = ".codex",
): string {
  // A supplied hooks path is already the Codex trust identity: preserve it
  // exactly. For the default, choose the path implementation from the project
  // spelling so Windows installers can generate native paths even when this
  // packager is invoked from Unix (and vice versa).
  const projectPath =
    win32.isAbsolute(projectDir) &&
    (!posix.isAbsolute(projectDir) || projectDir.startsWith("//"))
      ? win32
      : posix;
  const path = hooksJsonPath ?? projectPath.join(projectDir, harnessDir, "hooks.json");
  const counters: Record<string, number> = {};
  const state: Record<string, { trusted_hash: string }> = {};
  for (const { event, target } of HOOK_WIRING) {
    const snake = SNAKE[event];
    const idx = counters[snake] ?? 0;
    counters[snake] = idx + 1;
    const hash = trustHash(snake, adapterCmd(harnessDir, target));
    state[`${path}:${snake}:${idx}:0`] = { trusted_hash: hash };
  }
  return stringify({ hooks: { state } });
}

function emitTrustSeed(harnessDir: string): string {
  return (
    `# dist/codex hook-trust pre-seed (S9a) — TEMPLATE.\n` +
    `# From an AI-DLC source checkout, install the pinned serializer first:\n` +
    `#   bun install --frozen-lockfile\n` +
    `# Then generate ready-to-paste entries:\n` +
    `#   bun scripts/package.ts codex trust --project <abs-dir> [--hooks-json <abs-path>]\n` +
    `# Paste the complete stdout into the USER config.toml ($CODEX_HOME/config.toml).\n` +
    `# If entries for that hooks.json path already exist, replace the full set;\n` +
    `# appending a second set creates invalid TOML. The hash covers the\n` +
    `# normalized hook identity (event + command + defaults), NOT the path —\n` +
    `# only the key changes per install. Codex then runs the hooks without a\n` +
    `# TUI trust pass (the --dangerously-bypass-hook-trust flag does NOT fire\n` +
    `# untrusted hooks at 0.137-0.139; never rely on it).\n\n` +
    trustEntries("<PROJECT_DIR>", undefined, harnessDir)
  );
}

// --- Agent transposition: persona .md → .codex/agents/*.toml ----------------
// The old D7 model map is DERIVED from the tier projection module. Codex reads
// `tier:` from the core agent .md (authoritative source of truth) and looks up
// {model, effort} via projectTier. A null projected value means the TOML key
// is OMITTED: the spawned role then falls back to the shipped config.toml
// session defaults (live-verified on codex-cli 0.139.0 - the doctor floor -
// AND 0.142.5: a role TOML without `model` spawns on the config.toml model +
// effort). judgment omits both keys;
// balanced pins a model but inherits effort; templated pins both.

function parseAgentMd(raw: string): { fm: Record<string, string>; body: string } {
  // BOM tolerance, matching the packager's agent reader and the rule parser.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  let current: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) {
      current = kv[1];
      fm[current] = kv[2].replace(/^>\s*$/, "");
    } else if (current && /^\s+\S/.test(line)) {
      if (!line.trim().startsWith("-")) fm[current] = `${fm[current]} ${line.trim()}`.trim();
    }
  }
  return { fm, body: raw.slice(m[0].length) };
}

function tomlMultiline(s: string): string {
  return `"""\n${s.replace(/"""/g, '\\"\\"\\"')}\n"""`;
}

// ---------------------------------------------------------------------------
// emit() — the manifest entry point. Assembles every codex-only emission as a
// {path, content} list, then writes it into the packager-provided dist root.
// ---------------------------------------------------------------------------
export default function emit(ctx: EmitContext): void {
  // tierCap is the packager's resolved pack-time cap, passed through so the
  // emit-owned TOML projections use the SAME cap as every declarative
  // projection - never re-resolved here.
  const { coreRoot, harnessRoot, distRoot, harnessDir, substituteToken, tierCap } = ctx;
  const CODEX_ROOT = join(distRoot, harnessDir);
  const SKILLS_DST = join(distRoot, ".agents", "skills");

  // The codex anchored transform: token/prefix substitution (.codex) THEN the
  // aidlc-rules rename — mirrors the packager's transform for prose the emit
  // layer generates from core sources (AGENTS.md, agent bodies, runner prose).
  const rewriteProse = (s: string): string =>
    substituteToken(s).replaceAll(`${harnessDir}/rules/`, `${harnessDir}/aidlc-rules/`);

  // --- AGENTS.md, at the dist ROOT (beside .codex/) -------------------------
  // Rendered from the SHARED onboarding skeleton (core/templates/onboarding.md)
  // with Codex's fills — NOT a regex-rewrite of Claude's CLAUDE.md. This retires
  // the read-CLAUDE.md path and the Claude-prose-leak class with it: Codex
  // authors its own header + Prerequisites in harness/codex/onboarding.fills.ts.
  // The skeleton carries {{HARNESS_DIR}}; rewriteProse() substitutes → .codex and
  // renames rules/ → aidlc-rules/, exactly the codex transform class. Skills ship
  // at .agents/skills/ (never .codex/skills/), so redirect that one segment.
  function emitAgentsMd(): string {
    const skeleton = readFileSync(join(coreRoot, "templates", "onboarding.md"), "utf-8");
    let s = renderOnboarding(skeleton, onboardingFills);
    s = substituteToken(s); // {{HARNESS_DIR}} → .codex
    // Rename the markdown rule layers dir → aidlc-rules/, but NOT the native
    // Starlark `.codex/rules/default.rules` (the codex fills reference both, and
    // only the aidlc-* markdown layers move). Negative lookahead on default.rules.
    const escapedHarnessDir = harnessDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(
      new RegExp(`${escapedHarnessDir}/rules/(?!default\\.rules)`, "g"),
      `${harnessDir}/aidlc-rules/`,
    );
    // Skills ship at .agents/skills/, never .codex/skills/.
    s = s.replaceAll(`${harnessDir}/skills/`, ".agents/skills/");
    return s;
  }

  function emitAgentToml(mdPath: string): string {
    const raw = readFileSync(mdPath, "utf-8");
    const { fm, body } = parseAgentMd(raw);
    const name = fm.name ?? "";
    const description = (fm.description ?? "").replace(/\s+/g, " ").trim();
    // The authored source of truth is `tier:` on the core .md; the packager's
    // frontmatter transform doesn't run against emit.ts (Codex reads directly
    // from core), so project tier -> {model, effort} here. An agent .md
    // without a tier: line is an authoring bug - fail the build loudly.
    // parseAgentMd's value capture keeps trailing whitespace; trim so an
    // invisible trailing space cannot fail the codex leg alone (the
    // packager's own reader strips it for the other harnesses).
    const tier = fm.tier?.trim();
    if (!tier) throw new Error(`${mdPath}: agent frontmatter has no tier: line.`);
    const proj = projectTier(tier, "codex", tierCap); // throws on unknown tier
    const instructions = rewriteProse(body);
    const modelLines =
      (proj.model !== null ? `model = "${proj.model}"\n` : "") +
      (proj.effort !== null ? `model_reasoning_effort = "${proj.effort}"\n` : "");
    return (
      `name = "${name}"\n` +
      `description = "${description.replace(/"/g, '\\"')}"\n` +
      modelLines +
      `developer_instructions = ${tomlMultiline(instructions.trim())}\n`
    );
  }

  // --- Skill packaging into .agents/skills/ ----------------------------------
  // Compose runner-gen's render fns under the manifest harnessDir. Load the
  // module FROM THE ASSEMBLED DIST TREE (<harnessDir>/tools/) — the packager's
  // compile step already wrote tools/data/stage-graph.json there, and
  // runner-gen resolves its graph + scopes relative to its own location. (core/
  // carries no compiled JSON, so requiring it from coreRoot would fail.)
  const IMPLICIT_GUARD = "policy:\n  allow_implicit_invocation: false\n";
  process.env.AIDLC_HARNESS_DIR = harnessDir;
  const gen = require(join(CODEX_ROOT, "tools", "aidlc-runner-gen.ts")) as {
    runnableStages: () => Array<{ slug: string }>;
    renderStageRunner: (node: { slug: string }) => string;
    renderInitRunner: () => string;
    renderComposeRunner: () => string;
    defaultScopeBatch: (discovered?: Record<string, { name: string; description: string; plugin?: string; runner?: boolean }>) => string[];
    discoverScopes: () => Record<string, { name: string; description: string; plugin?: string; runner?: boolean }>;
    renderRunner: (scope: string, description: string) => string;
  };

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  }

  const emissions: Array<{ path: string; content: () => string }> = [];

  // codex-only config + wiring + trust + AGENTS.md
  emissions.push({ path: join(CODEX_ROOT, "hooks.json"), content: () => emitHooksJson(harnessDir) });
  emissions.push({ path: join(CODEX_ROOT, "config.toml"), content: emitConfigToml });
  emissions.push({
    path: join(CODEX_ROOT, "rules", "default.rules"),
    content: () => emitDefaultRules(harnessDir),
  });
  emissions.push({
    path: join(CODEX_ROOT, "trust-seed.toml"),
    content: () => emitTrustSeed(harnessDir),
  });
  emissions.push({ path: join(distRoot, "AGENTS.md"), content: emitAgentsMd });

  // agent TOMLs from core/agents/*.md (one per shipped persona)
  const agentsDir = join(coreRoot, "agents");
  for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md")).sort()) {
    emissions.push({
      path: join(CODEX_ROOT, "agents", f.replace(/\.md$/, ".toml")),
      content: () => emitAgentToml(join(agentsDir, f)),
    });
  }

  // (a) authored orchestrator shell — verbatim from harness/codex/skills/aidlc/
  for (const f of ["SKILL.md", "question-rendering.md"]) {
    emissions.push({
      path: join(SKILLS_DST, "aidlc", f),
      content: () => readFileSync(join(harnessRoot, "skills", "aidlc", f), "utf-8"),
    });
  }
  // (b) stage runners + init, generated, with the implicit-invocation guard
  for (const node of gen.runnableStages()) {
    const dir = join(SKILLS_DST, `aidlc-${node.slug}`);
    emissions.push({ path: join(dir, "SKILL.md"), content: () => rewriteProse(gen.renderStageRunner(node)) });
    emissions.push({ path: join(dir, "agents", "openai.yaml"), content: () => IMPLICIT_GUARD });
  }
  emissions.push({ path: join(SKILLS_DST, "aidlc-init", "SKILL.md"), content: () => rewriteProse(gen.renderInitRunner()) });
  emissions.push({ path: join(SKILLS_DST, "aidlc-init", "agents", "openai.yaml"), content: () => IMPLICIT_GUARD });
  emissions.push({ path: join(SKILLS_DST, "aidlc-compose", "SKILL.md"), content: () => rewriteProse(gen.renderComposeRunner()) });
  emissions.push({ path: join(SKILLS_DST, "aidlc-compose", "agents", "openai.yaml"), content: () => IMPLICIT_GUARD });
  // (c) Default-batch scope runners
  const scopes = gen.discoverScopes();
  for (const scope of gen.defaultScopeBatch(scopes).filter((s) => s in scopes)) {
    const dir = join(SKILLS_DST, `aidlc-${scope}`);
    emissions.push({ path: join(dir, "SKILL.md"), content: () => rewriteProse(gen.renderRunner(scope, scopes[scope].description)) });
    emissions.push({ path: join(dir, "agents", "openai.yaml"), content: () => IMPLICIT_GUARD });
  }
  // (d) session skills — byte-copy + prose rewrite from core/skills/
  for (const skill of ["aidlc-session-cost", "aidlc-replay", "aidlc-outcomes-pack"]) {
    const srcDir = join(coreRoot, "skills", skill);
    if (!existsSync(srcDir)) continue;
    for (const file of walk(srcDir)) {
      const rel = relative(srcDir, file);
      emissions.push({ path: join(SKILLS_DST, skill, rel), content: () => rewriteProse(readFileSync(file, "utf-8")) });
    }
    emissions.push({ path: join(SKILLS_DST, skill, "agents", "openai.yaml"), content: () => IMPLICIT_GUARD });
  }

  // Clean-sweep the emitted skills tree so a removed runner doesn't linger.
  // In --check mode distRoot is temporary; the packager compares its complete
  // inventory with the committed distribution after emit returns.
  rmSync(SKILLS_DST, { recursive: true, force: true });
  for (const { path, content } of emissions) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content(), "utf-8");
  }
}
