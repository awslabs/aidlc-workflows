// harness/kirocrew/manifest.ts — the Kiro Crew distribution row.
//
// Kiro Crew is an autonomous agent-management layer that drives the Kiro CLI:
// a Kiro Crew session runs `kiro-cli chat` under its gateway, so its hook
// payloads, agent model, and .kiro/ tree are the Kiro CLI's. This harness is
// therefore the Kiro CLI harness (harness/kiro/) projected under the Kiro Crew
// product identity — same core projection, same authored shell surfaces, same
// stdin hook adapter. Only the user-facing product name and onboarding differ.
//
// Kiro Crew specifics vs Kiro CLI:
//   - Hooks live in a GATEWAY-WATCHED store (~/.kiro/crew/hooks.json), so
//     `aidlc config` registers them through Kiro Crew's hook API / a gateway
//     reload rather than relying on a passive per-session file read. The
//     lifecycle events themselves (UserPromptSubmit / PreToolUse / PostToolUse
//     / Stop, exit-2 deny) match Kiro CLI's, which is why the authored adapter
//     is shared verbatim (see hooks/aidlc-kiro-adapter.ts).
//   - token → .kiro, rules/ → steering/, tierFlavor "kiro" — identical to Kiro
//     CLI because Kiro Crew IS a Kiro CLI layer.
//
// The adapter route: this harness reuses the recognized `engine adapter kiro`
// dispatch and ships aidlc-kiro-adapter.ts. core/tools/aidlc.ts resolves the
// embedded/native adapter for every kiro-family harness to that one file
// (adapterFile()), so the Kiro CLI route and adapter carry Kiro Crew's
// (identical) Kiro CLI payloads with zero core edits — the same way Kiro IDE
// reuses aidlc-kiro-adapter.ts.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import emit from "./emit.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "kirocrew",
  productName: "Kiro Crew",
  configNextStep: "start a Kiro Crew chat session, then run `/aidlc --doctor`",
  harnessDir: ".kiro",
  orchestratorSkillPath: ".kiro/skills/aidlc/SKILL.md",
  tierFlavor: "kiro",
  // A brand-new distribution: no shipped-release history exists, so no legacy
  // adoption hashes are declared here. writeProjectionData records the current
  // build's hash in aidlc-projection.json automatically, so `aidlc config`
  // still recognizes this build's own root files as framework-owned.
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
    },
  ],

  // Same core projection as kiro CLI: rules→steering, and the orchestrator
  // skill (skills/aidlc/) is authored, not core.
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

  // Authored Kiro CLI shell surfaces, shared verbatim because Kiro Crew runs
  // Kiro CLI. These carry literal `.kiro` (harness-specific by construction);
  // they are .md/.json/.ts copied verbatim (the .md token substitution is a
  // no-op on them — no {{HARNESS_DIR}} token present).
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
    // The stdin hook shim. Shared with Kiro CLI: Kiro Crew's gateway delivers
    // Kiro CLI-shaped hook payloads, so the same adapter normalizes them. The
    // agent JSONs wire it through the recognized `engine adapter kiro` route
    // (resolves this file for every kiro-family harness).
    { src: "hooks/aidlc-kiro-adapter.ts", dst: "hooks/aidlc-kiro-adapter.ts" },
    { src: "hooks/aidlc-record-human-turn.kiro.hook", dst: "hooks/aidlc-record-human-turn.kiro.hook" },
    { src: "hooks/aidlc-plan-approval-guard.kiro.hook", dst: "hooks/aidlc-plan-approval-guard.kiro.hook" },
    { src: "settings/cli.json", dst: "settings/cli.json" },
    { src: "settings/mcp.json", dst: "settings/mcp.json" },
    // Project-root .gitignore (beside .kiro/, not inside it) — the workspace
    // layout committed-vs-ignored split, identical to the Kiro CLI tree.
    // Authored as dot-gitignore so it does not act as a live ignore inside
    // harness/kirocrew/. projectRoot routes it to dist/kirocrew/.gitignore +
    // the --check determinism guard.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // Neutral root guidance is shared; native setup is loaded through agent resources.
  onboarding: { dst: "AGENTS.md", projectRoot: true, harnessDst: "steering/aidlc-onboarding.md", fills: onboardingFills },

  // rules/ → steering/ (applied after the token substitution, anchored).
  rulesRename: "steering",

  // Kiro Crew ships *.sh autoimport hook shims (emit.ts) into .kiro/hooks so
  // the AI-DLC lifecycle hooks actually fire under the gateway. The gateway
  // rebuilds the agent config from its own sources and does NOT read the
  // .kiro.hook manifests or the agent-JSON hooks block, but it DOES autoimport
  // executable *.sh from ~/.kiro/hooks — so the shims are the working inlet
  // (verified live: exit-2 blocks a real fs_write through the gateway).
  emit,

  // Kiro Crew has no host plugin store — like Kiro CLI, AIDLC plugins arrive by
  // folder-drop into the .kiro tree and use the explicit composer.
  plugin: { manifestDir: ".kiro-plugin", kind: "kiro" },
};

export default manifest;
