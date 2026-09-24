// harness/opencode/manifest.ts — the opencode distribution row.
//
// Projects the harness-neutral core/ tree into dist/opencode/.aidlc/ and defers
// every opencode-native surface to emit.ts (the .opencode/ shell: subagent .md
// files, the /aidlc command, the hook-adapter plugin). Verified live against
// opencode 1.17.18.
//
// opencode specifics vs Claude:
//   - token → .aidlc, NOT .opencode. opencode auto-imports every *.ts under
//     .opencode/tools/ and .opencode/tool/ as custom tool definitions
//     (live-verified: a CLI-style script there crashes the session), so the
//     engine tree cannot live inside .opencode/. It ships at .aidlc/ — a dir
//     opencode never scans — and the shipped opencode.json registers
//     `skills.paths: [".aidlc/skills"]` so skills are discovered there
//     (live-verified).
//   - .opencode/ carries ONLY natively-consumed emissions (emit.ts): the 14
//     persona subagents (.opencode/agents/*.md, mode: subagent + projected
//     tier keys), the /aidlc command (.opencode/command/aidlc.md), and the
//     hook-adapter plugin (.opencode/plugin/aidlc-opencode-adapter.ts, the
//     auto-discovered plugin seam mapping opencode hook moments onto the core
//     hook bodies in .aidlc/hooks/).
//   - the method tree reaches ambient context via the `instructions` glob in
//     the shipped opencode.json ("aidlc/spaces/default/memory/**/*.md",
//     live-verified) — opencode's native include surface, re-pointed on a
//     space switch by aidlc-includes.ts.
//   - opencode auto-reads the project-root AGENTS.md (its primary rules file).

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";
import emit from "./emit.ts";

const manifest: HarnessManifest = {
  name: "opencode",
  productName: "opencode",
  configNextStep: "run `opencode`, then `/aidlc --doctor`",
  harnessDir: ".aidlc",
  orchestratorSkillPath: ".aidlc/skills/aidlc/SKILL.md",
  tierFlavor: "opencode",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
      legacySignatures: {
        wholeFileHashes: [
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:d2569b56aef154c3c04766ed3263947a2d8026c99546a3006775526641951db9",
        ],
      },
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      shared: "identical",
      legacySignatures: {
        wholeFileHashes: [
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:d791057d6b667517197a450bc6ba633c36e148d62e09c90a8992d787c914a44f",
          "sha256:d86a61b7376772dcc7afdaefd63ce185f99d9c32d0e455668cf3b52f91a13d40",
          // The 2.9.0 shipped variant (#1131 changed the onboarding record-dir shape).
          "sha256:db6e65ed85d6b47ca47d72b5a323ddc4dca76d021cce92591c1a28b26d9f237a",
          // The pre-neutral shipped variant (#1268 made the root block harness-neutral).
          "sha256:c5b990429fe6dfa084d58fc592d1d22c1170cc35aa98f9cbb2c82b9924520eda",
        ],
      },
    },
    {
      path: "opencode.json",
      policy: "whole-file",
      legacySignatures: {
        wholeFileHashes: [
          // The pre-neutral shipped variant (#1268 changed this file).
          "sha256:3be60b2be72b7a423fdaa90fd7d0d9d19613875c05ad5f1a2b6e20fcb54cd1e5",
          "sha256:bc216975f2d614214fc6b6cc612c78f7da3f2b3f56492f0c252297fdc51fb928",
        ],
      },
    },
  ],

  // Same core projection as claude, into .aidlc/. The persona .md files ARE
  // core (the conductor adopts them inline from .aidlc/agents/); the
  // opencode-native subagent copies in .opencode/agents/ are emitted.
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
    // The orchestrator skill, inside .aidlc/skills/ (discovered via the
    // opencode.json skills.paths glob, like every generated runner).
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    // Project config at the dist ROOT (opencode reads ./opencode.json):
    // skills.paths (skill discovery), instructions glob (the method include),
    // and the native aidlc command permissions.
    { src: "opencode.json", dst: "opencode.json", projectRoot: true },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // Neutral root guidance is shared; opencode.json loads the native setup separately.
  onboarding: { dst: "AGENTS.md", projectRoot: true, harnessDst: "onboarding.md", fills: onboardingFills },

  // .aidlc/ is AIDLC's own dir; core's rules/ name has nothing to collide with.
  rulesRename: null,

  emit,

  // Host plugin projection: opencode's own plugin store is JS-module-shaped
  // (not folder-drop stage bundles), so the projection ships the uniform
  // store layout for manual composition. The compose hooks.json wiring is not
  // executable by opencode today — documented limitation.
  plugin: {
    manifestDir: ".opencode-plugin",
    kind: "store",
    installRoots: [".opencode"],
  },
};

export default manifest;
