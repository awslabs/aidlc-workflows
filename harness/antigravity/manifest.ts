// harness/antigravity/manifest.ts — the Google Antigravity distribution row.
//
// Projects the harness-neutral core/ tree into dist/antigravity/.agents/. One
// tree serves every surface that runs the Antigravity agent: the Antigravity
// IDE and the Antigravity CLI (`agy`). They share the same
// workspace-local customization root, `<project>/.agents/`, and read the same
// files from it: skills/<name>/SKILL.md, agents/*.md, rules/*.md, hooks.json
// and plugins/. Like Cursor, Antigravity consumes the standard projection
// directly - no emit.ts.
//
// Antigravity specifics vs Claude (live-verified against agy cli-2026.10.13
// on macOS; the IDE and CLI share the discovery and hook contract):
//   - token → .agents. Antigravity reads ONLY .agents/skills/, .agents/agents/,
//     .agents/rules/, .agents/hooks.json, .agents/plugins/ and the JSON
//     registries beside them for native meaning; the engine dirs (tools/,
//     aidlc-common/, knowledge/, sensors/, scopes/, hooks/) are inert data to
//     Antigravity and safely share the directory.
//   - the 14 core persona .md files in .agents/agents/ ARE live native
//     subagents: Antigravity's Markdown agent frontmatter needs `name` and
//     `description` (both core keys) and tolerates the rest. An agent with no
//     `tools:` line inherits Antigravity's default NON-MUTATING tool set, so
//     the manifest injects the allowlist every persona needs (shell, file
//     writes, search) and keeps delegation tools out of it: the conductor owns
//     every spawn, and `invoke_subagent` targets the personas by `name`.
//   - skills: .agents/skills/<name>/SKILL.md is Antigravity's native skill
//     layout, expanded as /<name> in the chat. The generated stage runners
//     land there via the standard runner-gen step; three authored utility
//     skills add /aidlc-status, /aidlc-jump, and /aidlc-scope.
//   - rules: .agents/rules/*.md with a `trigger:` frontmatter. Rules do not
//     expand @-import lines, so the method include is split the way Cursor's
//     is: rules/aidlc.md (always_on) carries org/team/project as a READ
//     instruction, while four model_decision phase pointers keep phase
//     guidance relevant. Each rule file is capped at 24,000 bytes by the host.
//   - hooks: .agents/hooks.json wires the host's named-hook schema
//     (SessionStart / PreInvocation / PreToolUse / PostToolUse / Stop) to
//     aidlc-antigravity-adapter.ts, which normalizes payloads and
//     subprocess-pipes into the byte-shared core hooks. A hook's working
//     directory is the directory holding hooks.json (.agents/), so every
//     command steps up to the project root first.
//   - .agents/skills/ is ALSO where Codex CLI discovers skills, and the Codex
//     harness emits its own skill tree there. The two harnesses therefore
//     cannot be installed in the same project; aidlc config says so.
import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

// The core persona files, all of which Antigravity discovers as subagents.
const PERSONA_AGENTS = [
  "aidlc-architect-agent",
  "aidlc-architecture-reviewer-agent",
  "aidlc-aws-platform-agent",
  "aidlc-compliance-agent",
  "aidlc-composer-agent",
  "aidlc-delivery-agent",
  "aidlc-design-agent",
  "aidlc-developer-agent",
  "aidlc-devsecops-agent",
  "aidlc-operations-agent",
  "aidlc-pipeline-deploy-agent",
  "aidlc-product-agent",
  "aidlc-product-lead-agent",
  "aidlc-quality-agent",
] as const;

// Antigravity's tool allowlist for a delegated persona: the file, search,
// task-management and shell tools a stage's work needs, and none of the
// delegation tools (invoke_subagent, define_subagent, manage_subagents,
// send_message, swarm, run_workflow, browser_subagent): agents never call each
// other; only the conductor hands out work. `mainAgent: false` keeps the
// personas out of the main-agent picker; they are reachable through
// `invoke_subagent` only.
const PERSONA_FRONTMATTER = [
  "tools:",
  "  - view_file",
  "  - list_dir",
  "  - find_by_name",
  "  - grep_search",
  "  - write_to_file",
  "  - replace_file_content",
  "  - multi_replace_file_content",
  "  - run_command",
  "  - manage_task",
  "  - read_url_content",
  "  - search_web",
  "mainAgent: false",
  "subagent: true",
];

const manifest: HarnessManifest = {
  name: "antigravity",
  productName: "Google Antigravity",
  configNextStep:
    "open this project in Antigravity (or run `agy` in it), then run `/aidlc --doctor`",
  harnessDir: ".agents",
  orchestratorSkillPath: ".agents/skills/aidlc/SKILL.md",
  tierFlavor: "antigravity",
  // Antigravity's `run_command` tool keeps a tail window of the last 8,000
  // bytes and head-truncates the start of stdout. Keeping every directive
  // under 7,500 bytes ensures the opening JSON keys (`kind`, `stage`, `part`,
  // `receipt`, `next`) always arrive whole in a single tool result.
  directiveMaxBytes: 7500,
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      shared: "identical",
      legacySignatures: {
        wholeFileHashes: [
          // The neutral root block is byte-identical across the sharing
          // harnesses, so the same earlier variants are recognizable here.
          "sha256:78c906200a55665f3a3ce410272c71d4bdcb5764174407da0f69d8ad6d143184",
          "sha256:2907b5293bfd8bd9d5f8b7a8025bfe23edd0ffcd31f925761916088517880936",
          "sha256:2ef8a8cd1b72e59d017013b8d261721b1c5dedb82499b44dc9a97be01b6a73cb",
          "sha256:eeabf9f9555124da3f5ad34eb3a26b9fcbf3e2ccd65610cb9f0182701cf3ef48",
          "sha256:6de1298dfa4c2b6916f66d372b844faf23481c8f258eedd595c1423dab8e106d",
          // The variant shipped before the onboarding listed Google Antigravity.
          "sha256:6d3bf5865f1836575715ea93d0042b9d08bcab918cc9a17a142848fe44e88bc7",
        ],
      },
    },
  ],

  // Same core projection as claude, into .agents/.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
    { src: "skills/aidlc-session-cost", dst: "skills/aidlc-session-cost" },
    { src: "skills/aidlc-replay", dst: "skills/aidlc-replay" },
    { src: "skills/aidlc-outcomes-pack", dst: "skills/aidlc-outcomes-pack" },
    { src: "skills/aidlc-knowledge", dst: "skills/aidlc-knowledge" },
  ],

  harnessFiles: [
    // The orchestrator skill — Antigravity-native layout, /aidlc invocation.
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "skills/aidlc/composer.md", dst: "skills/aidlc/composer.md" },
    { src: "skills/aidlc/tables.md", dst: "skills/aidlc/tables.md" },
    // Antigravity-native shortcut skills (slash-expanded like every skill).
    { src: "skills/aidlc-status/SKILL.md", dst: "skills/aidlc-status/SKILL.md" },
    { src: "skills/aidlc-jump/SKILL.md", dst: "skills/aidlc-jump/SKILL.md" },
    { src: "skills/aidlc-scope/SKILL.md", dst: "skills/aidlc-scope/SKILL.md" },
    // AIDLC method pointers: standing layers always apply; phase guidance is
    // agent-decided. Antigravity rules have no @-import expansion, so each
    // carries a READ instruction naming aidlc/active-memory/. /aidlc space
    // refreshes that copy (aidlc-includes.ts refreshActiveMemory).
    { src: "rules-aidlc.md", dst: "rules/aidlc.md" },
    { src: "rules-aidlc-phase-ideation.md", dst: "rules/aidlc-phase-ideation.md" },
    { src: "rules-aidlc-phase-inception.md", dst: "rules/aidlc-phase-inception.md" },
    { src: "rules-aidlc-phase-construction.md", dst: "rules/aidlc-phase-construction.md" },
    { src: "rules-aidlc-phase-operation.md", dst: "rules/aidlc-phase-operation.md" },
    // The hook shim + wiring (the adapter is authored; the core hook bodies
    // beside it are packaged byte-identical to the Claude harness).
    { src: "hooks/aidlc-antigravity-adapter.ts", dst: "hooks/aidlc-antigravity-adapter.ts" },
    { src: "hooks.json", dst: "hooks.json" },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // Every persona gets Antigravity's tool allowlist and subagent-only flags;
  // the packager errors if a core file ever declares one of these keys.
  frontmatterAdditions: PERSONA_AGENTS.map((agent) => ({
    file: `agents/${agent}.md`,
    lines: PERSONA_FRONTMATTER,
  })),

  // AGENTS.md at the project root — Antigravity auto-reads it as ambient
  // instructions (no @-import expansion). The native onboarding is an
  // always-on rule inside .agents/rules/.
  onboarding: {
    dst: "AGENTS.md",
    projectRoot: true,
    harnessDst: "rules/aidlc-onboarding.md",
    fills: onboardingFills,
  },

  // .agents/rules/ is Antigravity's native rules dir and our stubs deliberately
  // live there; core projects no rules/ dir, so nothing needs renaming.
  rulesRename: null,

  emit: null,

  // The standing rule names the doctor the way each install runs it: a copied
  // install through its own Bun dispatcher, the native release as `aidlc`.
  nativeReplacements: [{
    from: "run `bun .agents/tools/aidlc.ts doctor` (after installing Bun from https://bun.sh/install if `bun` is not found),",
    to: "run `aidlc doctor`,",
  }],

  // Antigravity reads a plugin from a directory holding plugin.json or
  // .antigravity-plugin/plugin.json, and its hooks.json from the plugin root
  // in the named-hook shape.
  plugin: { manifestDir: ".antigravity-plugin", kind: "antigravity" },
};

export default manifest;
