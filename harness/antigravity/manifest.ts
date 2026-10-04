// harness/antigravity/manifest.ts — Google Antigravity (CLI & IDE) distribution row.
//
// Projects the harness-neutral core/ tree into dist/antigravity/.aidlc/ and emits
// Antigravity-native workspace customizations into .agents/ (skills, rules, hooks.json)
// and project-root AGENTS.md.
//
// Antigravity specifics vs Claude / Codex:
//   - token → .aidlc (engine tree lives in .aidlc/ to avoid tool reflection collisions)
//   - skills: Antigravity discovers workspace skills under .agents/skills/<name>/SKILL.md,
//     so skipRunnerGen is true and emit.ts composes the full skill tree there.
//   - hooks: .agents/hooks.json wires Antigravity lifecycle and subagent events to
//     aidlc-antigravity-adapter.ts in .aidlc/hooks/.
//   - onboarding: project-root AGENTS.md rendered from core/templates/onboarding.md.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";
import emit from "./emit.ts";

const manifest: HarnessManifest = {
  name: "antigravity",
  productName: "Google Antigravity",
  configNextStep: "open this project in Antigravity IDE or run `agy`, then `/aidlc --doctor`",
  harnessDir: ".aidlc",
  orchestratorSkillPath: ".agents/skills/aidlc/SKILL.md",
  tierFlavor: "copilot",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
    },
  ],

  // Core projection into .aidlc/
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
  ],

  harnessFiles: [
    { src: "hooks/aidlc-antigravity-adapter.ts", dst: "hooks/aidlc-antigravity-adapter.ts" },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  rulesRename: null,

  skipRunnerGen: true,

  emit,

  plugin: {
    manifestDir: ".agents/plugins",
    kind: "store",
  },
};

export default manifest;
