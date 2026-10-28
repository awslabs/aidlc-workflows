// harness/grok/manifest.ts — the Grok Build distribution row.
//
// Projects the harness-neutral core/ tree into dist/grok/.grok/. Same shape as
// Cursor: no emit.ts, engine dirs sit inert beside the native dirs Grok Build
// reads (rules/, agents/, skills/, hooks/).
//
// Grok Build specifics vs Cursor:
//   - token → .grok. Skills, agents, and rules/*.md are native. Hooks are
//     .grok/hooks/aidlc.json (nested PascalCase), not a root hooks.json.
//     Cursor-shaped hook entries do not run.
//   - the 14 core persona .md files in .grok/agents/ are live native subagents.
//     spawn_subagent targets them with subagent_type. Depth limit is 1.
//   - rules: every *.md directly in .grok/rules/ loads on every turn. There is
//     no alwaysApply frontmatter and no .mdc. The method include is five READ
//     pointers into aidlc/active-memory/.
//   - Stop can block ({"decision":"block","reason"}). SubagentStart/Stop fire
//     and carry subagentType, so the adapter does not keep a spawn ledger.
//   - questions use ask_user_question. The tool adds Other.
//   - model pins are null on every tier (session model). tierFlavor is "grok",
//     not "cursor": the cursor flavor also rewrites cli.json permissions.
//   - shell results are middle-cut past 20,000 characters, so directives cap
//     at 19000 bytes.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "grok",
  productName: "Grok Build",
  choiceName: "Grok",
  configNextStep: "open this project in Grok Build, trust the folder, then run `/aidlc --doctor`",
  harnessDir: ".grok",
  orchestratorSkillPath: ".grok/skills/aidlc/SKILL.md",
  tierFlavor: "grok",
  directiveMaxBytes: 19000,
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
      legacySignatures: {
        wholeFileHashes: [
          "sha256:b4bf7694361e76aae9feabc5d985d09afb7863cf8458b0c9aaa73f20a589582f",
          "sha256:a87496436cb23f303dee533322bd0896e981e14be1a7abd18e76aa5e113be02c",
          "sha256:f9fbe33a3e622010a8a45ef199e104077db6ee7ee27137c08c34e81c1a0c24a4",
          "sha256:8c5a09fbee163fa2a02fbccb1695c2f66a79507a180456240dd380b681b97506",
          "sha256:cf4554ef90011ebc4bc70c7fbc6ca572c513d5c1e7daa328e406d1069f98e635",
          "sha256:ae1878ec98301ceb4510e711cf79f58dfb44cb486744007acd03ae5e61860665",
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
          "sha256:78c906200a55665f3a3ce410272c71d4bdcb5764174407da0f69d8ad6d143184",
          "sha256:2907b5293bfd8bd9d5f8b7a8025bfe23edd0ffcd31f925761916088517880936",
          "sha256:2ef8a8cd1b72e59d017013b8d261721b1c5dedb82499b44dc9a97be01b6a73cb",
          "sha256:eeabf9f9555124da3f5ad34eb3a26b9fcbf3e2ccd65610cb9f0182701cf3ef48",
          "sha256:6de1298dfa4c2b6916f66d372b844faf23481c8f258eedd595c1423dab8e106d",
        ],
      },
    },
  ],

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
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "skills/aidlc/composer.md", dst: "skills/aidlc/composer.md" },
    { src: "skills/aidlc/tables.md", dst: "skills/aidlc/tables.md" },
    { src: "skills/aidlc-status/SKILL.md", dst: "skills/aidlc-status/SKILL.md" },
    { src: "skills/aidlc-jump/SKILL.md", dst: "skills/aidlc-jump/SKILL.md" },
    { src: "skills/aidlc-scope/SKILL.md", dst: "skills/aidlc-scope/SKILL.md" },
    { src: "rules-aidlc.md", dst: "rules/aidlc.md" },
    { src: "rules-aidlc-phase-ideation.md", dst: "rules/aidlc-phase-ideation.md" },
    { src: "rules-aidlc-phase-inception.md", dst: "rules/aidlc-phase-inception.md" },
    { src: "rules-aidlc-phase-construction.md", dst: "rules/aidlc-phase-construction.md" },
    { src: "rules-aidlc-phase-operation.md", dst: "rules/aidlc-phase-operation.md" },
    { src: "hooks/aidlc-grok-adapter.ts", dst: "hooks/aidlc-grok-adapter.ts" },
    { src: "hooks/aidlc.json", dst: "hooks/aidlc.json" },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  onboarding: {
    dst: "AGENTS.md",
    projectRoot: true,
    harnessDst: "rules/aidlc-onboarding.md",
    fills: onboardingFills,
  },

  rulesRename: null,

  runnerFrontmatterAdditions: ["disable-model-invocation: true"],

  emit: null,

  nativeReplacements: [{
    from: "run `bun .grok/tools/aidlc.ts doctor` (after installing Bun from https://bun.sh/install if `bun` is not found),",
    to: "run `aidlc doctor`,",
  }, {
    // The copy channel allows the bun scripts. The native tree's leftover
    // check rejects any bun .grok/tools|hooks/aidlc spelling, and native
    // commands are the aidlc binary.
    from: '["Bash(aidlc *)", "Bash(bun .grok/tools/aidlc*)", "Bash(bun .grok/hooks/aidlc*)"]',
    to: '["Bash(aidlc *)"]',
  }, {
    from: "Add an allow entry that names `aidlc` (the native command) or the copy-channel `bun` scripts, and keep every other line you already have:",
    to: "Add an allow entry that names `aidlc`, and keep every other line you already have:",
  }],
};

export default manifest;
