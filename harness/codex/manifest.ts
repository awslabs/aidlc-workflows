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

  // Core projection: NO session skills (emitted to .agents/skills/ by emit).
  // Persona .md files ARE core (the conductor reads them as prose; Codex agent
  // discovery reads only the emitted .toml). The method ("memory") is no longer
  // projected into .codex/aidlc-rules/ — it relocated to the workspace-root
  // aidlc/spaces/default/memory/ (emitted by the packager's memory step) and is
  // reached via the auto-merged root AGENTS.md + the orchestrator's @aidlc/...
  // prompt-mention (AIDLC_RULES_DIR in config.toml re-points the resolver seam).
  // rulesRename:"aidlc-rules" stays — it still rewrites the <harness>/rules/
  // prose mentions other core files carry.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
  ],

  // The one authored .codex/ surface: the stdin adapter shim. The orchestrator
  // skill is authored too but is EMITTED into .agents/skills/aidlc/ by emit().
  harnessFiles: [
    { src: "hooks/aidlc-codex-adapter.ts", dst: "hooks/aidlc-codex-adapter.ts" },
  ],

  rulesRename: "aidlc-rules",

  // The codex adapter lives inside the core-copied hooks/ dir — exempt it from
  // the orphan scan. (Agent TOMLs are emitted, not authored — they are part of
  // emit's expected set, scanned by emit's own check.)
  authoredExempt: [/^hooks\/aidlc-codex-[^/]+\.ts$/],

  // Skills go to .agents/skills/ via emit, not <harnessDir>/skills/ via runner-gen.
  skipRunnerGen: true,

  emit,
};

export default manifest;
