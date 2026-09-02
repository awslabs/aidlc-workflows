// harness/kiro/manifest.ts — the Kiro CLI distribution row.
//
// Projects the harness-neutral core/ tree into dist/kiro/.kiro/, plus Kiro's
// authored shell surfaces (orchestrator skill, agent JSON configs, the stdin
// adapter hook, settings/cli.json, AGENTS.md). Mirrors the proven
// package-kiro.ts spike, generalized onto the unified packager.
//
// Kiro specifics vs Claude:
//   - token → .kiro
//   - rules/ → steering/ (Kiro auto-loads steering; rules ARE the always-on
//     layer)
//   - the orchestrator skill is per-harness (authored here, NOT core), so it
//     is NOT in coreDirs — only the 3 session skills are.
//   - agents/ is MIXED: the persona .md files are core (copied + rules rename
//     n/a), the Kiro-native agent .json configs are authored (harnessFiles).
//   - hooks/ is MIXED: core hook bodies are copied; the one authored
//     aidlc-kiro-adapter.ts stdin shim is a harnessFile.
//   - AGENTS.md lands at the PROJECT ROOT (dist/kiro/AGENTS.md), outside .kiro/.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "kiro",
  productName: "Kiro CLI",
  configNextStep: "run `kiro-cli chat`, then `/aidlc --doctor`",
  harnessDir: ".kiro",
  orchestratorSkillPath: ".kiro/skills/aidlc/SKILL.md",
  tierFlavor: "kiro",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      legacySignatures: {
        wholeFileHashes: [
          "sha256:83449fdda4644b319cbea5dcbde11919722b5dd6761f4edb4caf0e0e53dc9c6b",
        ],
      },
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      legacySignatures: {
        wholeFileHashes: [
          "sha256:4f7133cc1a9bb1243245c25c28fad57c3660b35e251ea36cea3aa2db431bf55f",
          "sha256:992307cc3fac05d81958851b2ca51db3723fea604c8d2636814ef9b2e9f7a848",
          "sha256:b886d5b375f9ebc33ef206c4f6ad20630a13eb83d0f5838e9f71f483c040f362",
          "sha256:c6796d512752c8f4aa927c9de3fb794e3432f62dd85b77fe3da1101d90aa5a0b",
          "sha256:cd7c66ba1bdd67af0be6203a1d8928efc01733ef196201003e914051d1309a28",
          "sha256:e01ac1caf52a59d25faf859a03cfb65b803853c99298bbcbc80ef565e7628de6",
          "sha256:e3de4a295f9b9404b40678c28c0773ae432ac8d4aeacc07613ecfcdfbb4c866b",
          "sha256:e85a5d7ce13b676282dc99572f89c81256f2dada50b1881f4c9641e61339f5a4",
          // The pre-v2-sync shipped variant (2.6.123 merge changed the bytes).
          "sha256:67a57eddd94d613590d34ec2d0181398123d9e2d9f6382eb36c62233ce02b6f9",
        ],
      },
    },
  ],

  // Same core projection as claude, EXCEPT: rules→steering, and the
  // orchestrator skill (skills/aidlc/) is authored, not core.
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

  // Authored Kiro shell surfaces. These carry literal `.kiro` (harness-specific
  // by construction); they are .md/.json/.ts copied verbatim (the .md token
  // substitution is a no-op on them — no {{HARNESS_DIR}} token present).
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "agents/aidlc.json", dst: "agents/aidlc.json" },
    { src: "agents/aidlc-architect-agent.json", dst: "agents/aidlc-architect-agent.json" },
    { src: "agents/aidlc-developer-agent.json", dst: "agents/aidlc-developer-agent.json" },
    { src: "agents/aidlc-product-lead-agent.json", dst: "agents/aidlc-product-lead-agent.json" },
    { src: "agents/aidlc-architecture-reviewer-agent.json", dst: "agents/aidlc-architecture-reviewer-agent.json" },
    { src: "agents/aidlc-composer-agent.json", dst: "agents/aidlc-composer-agent.json" },
    // Ensemble collaborator configs (2.5.0 roster closure): lean read+shell
    // delegation targets so any stage can flip to an ensemble topology here.
    { src: "agents/aidlc-product-agent.json", dst: "agents/aidlc-product-agent.json" },
    { src: "agents/aidlc-design-agent.json", dst: "agents/aidlc-design-agent.json" },
    { src: "agents/aidlc-delivery-agent.json", dst: "agents/aidlc-delivery-agent.json" },
    { src: "agents/aidlc-aws-platform-agent.json", dst: "agents/aidlc-aws-platform-agent.json" },
    { src: "agents/aidlc-compliance-agent.json", dst: "agents/aidlc-compliance-agent.json" },
    { src: "agents/aidlc-devsecops-agent.json", dst: "agents/aidlc-devsecops-agent.json" },
    { src: "agents/aidlc-quality-agent.json", dst: "agents/aidlc-quality-agent.json" },
    { src: "agents/aidlc-pipeline-deploy-agent.json", dst: "agents/aidlc-pipeline-deploy-agent.json" },
    { src: "agents/aidlc-operations-agent.json", dst: "agents/aidlc-operations-agent.json" },
    { src: "hooks/aidlc-kiro-adapter.ts", dst: "hooks/aidlc-kiro-adapter.ts" },
    { src: "hooks/aidlc-record-human-turn.kiro.hook", dst: "hooks/aidlc-record-human-turn.kiro.hook" },
    { src: "hooks/aidlc-plan-approval-guard.kiro.hook", dst: "hooks/aidlc-plan-approval-guard.kiro.hook" },
    { src: "settings/cli.json", dst: "settings/cli.json" },
    { src: "settings/mcp.json", dst: "settings/mcp.json" },
    // Project-root .gitignore (beside .kiro/, not inside it) — re-rooted under
    // aidlc/spaces/* for the workspace layout (SEED): cursors + machine-local
    // runtime ignored, the shared work (memory/codekb/registry/state/audit
    // shards/artifacts) committed. Net-new for Kiro — it shipped none before.
    // Authored as dot-gitignore so it does not act as a live ignore inside
    // harness/kiro/. projectRoot routes it to dist/kiro/.gitignore + the --check
    // determinism guard.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // AGENTS.md renders from the shared skeleton with Kiro's fills, at the project
  // root (outside .kiro/). The {{HARNESS_DIR}} → .kiro substitution + rules/ →
  // steering/ rename run on it like any core .md. Replaces the hand-forked
  // harness/kiro/AGENTS.md (which had drifted to "two harnesses" + missing the
  // Documentation/Automated-Testing sections the skeleton now supplies for free).
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // rules/ → steering/ (applied after the token substitution, anchored).
  rulesRename: "steering",

  // Kiro ships no per-shell emissions — all its surfaces are authored files.
  emit: null,

  // Kiro has no host plugin store — AIDLC plugins arrive by folder-drop and use
  // the explicit composer. Agent-v1 reads hooks from agent configs; v3/KAS also
  // consumes the standalone .kiro.hook files projected above.
  plugin: { manifestDir: ".kiro-plugin", kind: "kiro" },
};

export default manifest;
