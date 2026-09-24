// harness/copilot/manifest.ts — the GitHub Copilot distribution row.
//
// ONE dist serves BOTH Copilot surfaces — Copilot CLI (1.0.74+) and VS Code
// agent mode (1.130+) — because GitHub converged them on the same project
// discovery paths: .github/skills/, .github/agents/, .github/hooks/, and the
// root AGENTS.md are read identically by both (compat spike, 10 live CLI
// probes + IDE parser extraction in the compatibility-spike evidence). Splitting
// cli/ide harnesses would ship two dists competing for the
// same .github file paths; the divergences are authoring rules instead:
//   - hooks registered under PascalCase event names → BOTH surfaces deliver
//     Claude-shaped snake_case payloads (one adapter path);
//   - agent `tools:` uses the UNION vocabulary (each surface silently ignores
//     the other's names — live-verified, no fallback-to-all);
//   - agents carry NO `model:` field (the CLI forwards IDE display names
//     verbatim to the BYOK provider → live-verified 400; tierFlavor copilot
//     is model-omitted by type).
//
// Copilot specifics vs Claude:
//   - token → .aidlc, NOT .copilot or .github. Project-level .copilot/ is not
//     a documented discovery root (only ~/.copilot has COPILOT_HOME
//     semantics), and .github/ is SHARED with real repo content (workflows,
//     templates) — the engine tree cannot own it. The engine ships at
//     .aidlc/ — a dir neither Copilot surface scans (the opencode precedent)
//     — and emit.ts writes only aidlc-named files into .github/.
//   - .github/ carries ONLY natively-consumed emissions (emit.ts): the hook
//     wiring (.github/hooks/aidlc.json → the adapter in .aidlc/hooks/), the
//     14 persona agents (.github/agents/aidlc-*-agent.md), and the full
//     skills tree (.github/skills/: orchestrator + generated runners +
//     session skills — Copilot discovers project skills there, so the
//     standard <harnessDir>/skills/ runner-gen step is skipped).
//   - Copilot auto-reads the project-root AGENTS.md (both surfaces).
//   - An .aidlc runtime dir is ALSO what the opencode harness ships; an
//     install is disambiguated by its wiring files (.github/hooks/aidlc.json
//     + .aidlc/hooks/aidlc-copilot-adapter.ts here vs .opencode/plugin/
//     there) — the doctor probes exactly that.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";
import emit from "./emit.ts";

const manifest: HarnessManifest = {
  name: "copilot",
  productName: "GitHub Copilot",
  configNextStep: "start Copilot CLI or VS Code agent mode, then run `/aidlc --doctor`",
  harnessDir: ".aidlc",
  orchestratorSkillPath: ".github/skills/aidlc/SKILL.md",
  tierFlavor: "copilot",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
      legacySignatures: {
        wholeFileHashes: [
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:f52e6097d36c2e5bc199a2529469a4c6e7c507f7960f94a0b2b46f9aeee60e56",
        ],
      },
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      legacySignatures: {
        wholeFileHashes: [
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:9550b31b8f3f32992c1ae1035bfa57a782f04821530214a2f2e1fd1690e209ab",
          "sha256:1b8b3b4b10de3307a927429a676f5dd7440099a6d18859f603328b5ed239e6c7",
          // The 2.9.0 shipped variant (#1131 changed the onboarding record-dir shape).
          "sha256:bf3077a6520e2735f618bad386858afc57edceaa791d98de7a6c269d71861e56",
          // The pre-neutral shipped variant (#1268 made the root block harness-neutral).
          "sha256:55b31ba55f6e7ebc47fe76a00039e2ec16e020503fb63791cbd8665438ff32ac",
          // The pre-Guards shipped variant (the onboarding gained its Guards section).
          "sha256:7a3a19981ba7a3c447b54eb0d0b1e96f8c9931687595967103cb5dfbb3c2b309",
          // The pre-skill-prefix shipped variant (#1341: user-typed skill
          // names rendered the shell invocation instead of the skill command).
          "sha256:622ebad60ee4fed6a2a9811e7378ccbff6b76d651aaee00fd079b02471d8cf06",
        ],
      },
    },
  ],

  // Same core projection as claude, into .aidlc/. The runtime files ARE
  // core (the conductor adopts them inline from .aidlc/agents/); the
  // Copilot-native agent copies in .github/agents/ are emitted.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
    // NO skills/ inside the engine dir: Copilot discovers project skills at
    // .github/skills/ only, so emit composes the whole skill set there
    // (orchestrator + runners + session skills) from core — the codex idiom.
  ],

  harnessFiles: [
    // The hook adapter, beside the core hook bodies it pipes into.
    { src: "hooks/aidlc-copilot-adapter.ts", dst: "hooks/aidlc-copilot-adapter.ts" },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // AGENTS.md at the project root — both Copilot surfaces auto-read it.
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // .aidlc/ is AIDLC's own dir; core's rules/ name has nothing to collide with.
  rulesRename: null,

  // Copilot discovers project skills at .github/skills/ (and .agents/skills/,
  // .claude/skills/) — never inside .aidlc/. emit.ts composes the full skill
  // tree there from runner-gen's render fns; graph compile still runs.
  skipRunnerGen: true,

  emit,

  // Copilot recognizes .plugin/plugin.json as a native plugin manifest.
  // The harnessDir-derived ".aidlc-plugin" default is not a discovery path.
  plugin: { manifestDir: ".plugin", kind: "store" },
};

export default manifest;
