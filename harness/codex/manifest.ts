// harness/codex/manifest.ts — the Codex CLI distribution row.
//
// Projects core/ into dist/codex/.codex/ (rules → aidlc-rules, D-10) and defers
// every codex-specific surface to emit.ts (config.toml, hooks.json, trust-seed,
// AGENTS.md, 11 agent TOMLs, the .agents/skills/ tree). Mirrors the proven
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
  harnessDir: ".codex",
  tierFlavor: "codex",

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
    // --check drift guard.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  rulesRename: "aidlc-rules",

  // Skills go to .agents/skills/ via emit, not <harnessDir>/skills/ via runner-gen.
  skipRunnerGen: true,

  emit,
};

export default manifest;
