// harness/codex/manifest.ts — the Codex CLI distribution row.
//
// Projects core/ into dist/codex/.codex/ (rules → aidlc-rules, D-10) and defers
// every codex-specific surface to emit.ts (config.toml, hooks.json, trust-seed,
// AGENTS.md, 14 agent TOMLs, the .agents/skills/ tree). Mirrors the proven
// package-codex.ts spike, generalized onto the unified packager.
//
// Codex specifics vs Claude/Kiro:
//   - token → .codex
//   - rules/ → aidlc-rules/ (Codex's native .codex/rules/ is Starlark
//     permission rules; the AIDLC markdown layers live in aidlc-rules/)
//   - skills are NOT shipped in .codex/skills/ — Codex discovers skills at
//     <project>/.agents/skills/, so skipRunnerGen is set and emit() composes
//     the whole skill set (orchestrator + runners + session skills) there.
//   - the only authored .codex/ file is the aidlc-codex-adapter.ts stdin shim
//     (a harnessFile); the agent TOMLs in .codex/agents/ are emitted.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import emit from "./emit.ts";

const manifest: HarnessManifest = {
  name: "codex",
  productName: "Codex CLI",
  configNextStep: "run `codex`, then `$aidlc --doctor`",
  harnessDir: ".codex",
  orchestratorSkillPath: ".agents/skills/aidlc/SKILL.md",
  tierFlavor: "codex",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      legacySignatures: {
        wholeFileHashes: [
          "sha256:f919e4bac1790bd1a371d371af473ccbc644f3bb80e4569d190c9364fad771b3",
        ],
      },
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      legacySignatures: {
        wholeFileHashes: [
          "sha256:30a9f5f43d87cd29b63e75333b8ef6695f8f4e11909fd6af64e2b6cf0b8cb292",
          "sha256:47678f42e0233de9b0164eb4ec318a3ba3196074d6ec88f69aa7980bc1f2fd0d",
          "sha256:821b2149c7c6c2b6592eecd10623823fc5579fc4ae52f2ad272e00c93013d027",
          "sha256:83c6e5141646dc604c87d80622fc898761a69bd0c9caebb398441bce9f1d0727",
          "sha256:b3a07e9bb603fb0a2328004fc7cf2294afc670ec6f350a43de9c15d6e27aa04e",
          "sha256:bfc2adb83e00041750b1d19c9f3167cb7f5f5502a62af83a58d0a2828890febf",
          "sha256:d8afae6a0813f5298cf873a047664cf485308c6e0dad41dde53d8dcb27dd7769",
          "sha256:f1deb7dc72a78fe7d39c71ad2fe6c0f41248c03cde7fb36b7a478f5b9233881c",
          "sha256:f7c55e9917d3801f676fba066fdd78d8df2c36311e8d6e78068965fc7b4371fa",
          "sha256:457ff3626bf6ff4a0f6f1f7a44a1d2cbcd91490600e2332742dcf655da25b7f3",
          "sha256:9be9c5cc4a25e5b4c71b3ae35188e1a543504f19cbd5d0a20892777b0904800e",
          "sha256:bc41aca84970977673af3c0b8212a1f7a4d995a4b47fc7894b1c5b342e4a3601",
          "sha256:b3d4d0d178a01591629dbf79083b00e7a3ad42f59f79cbfc88d05b7615704a70",
          // The pre-v2-sync shipped variant (2.6.123 merge changed the bytes).
          "sha256:d9be36630b49183203ae4d97946c243e3b8840202ee6f080c738e0f01343e33a",
        ],
      },
    },
  ],

  // Core projection: rules→aidlc-rules, NO session skills (emitted to
  // .agents/skills/ by emit). Persona .md files ARE core (the conductor reads
  // them as prose; Codex agent discovery reads only the emitted .toml).
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "rules", dst: "aidlc-rules" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
  ],

  // The one authored .codex/ surface: the stdin adapter shim. The orchestrator
  // skill is authored too but is EMITTED into .agents/skills/aidlc/ by emit().
  harnessFiles: [
    { src: "hooks/aidlc-codex-adapter.ts", dst: "hooks/aidlc-codex-adapter.ts" },
    // Project-root .gitignore (beside .codex/, not inside it) — re-rooted under
    // aidlc/spaces/* for the workspace layout (SEED): cursors + machine-local
    // runtime ignored, the shared work (memory/codekb/registry/state/audit
    // shards/artifacts) committed. Net-new for Codex — it shipped none before.
    // Authored as dot-gitignore so it does not act as a live ignore inside
    // harness/codex/. projectRoot routes it to dist/codex/.gitignore + the
    // --check determinism guard.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  rulesRename: "aidlc-rules",

  // Skills go to .agents/skills/ via emit, not <harnessDir>/skills/ via runner-gen.
  skipRunnerGen: true,

  emit,
};

export default manifest;
