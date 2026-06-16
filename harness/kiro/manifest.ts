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
  harnessDir: ".kiro",

  // Same core projection as claude, EXCEPT the orchestrator skill (skills/aidlc/)
  // is authored, not core. The method ("memory") is no longer projected into
  // .kiro/steering/ — it relocated to the workspace-root aidlc/spaces/default/
  // memory/ (emitted by the packager's memory step) and Kiro reads it via the
  // agent JSON `resources` globs (re-pointed to file://aidlc/spaces/default/
  // memory/**/*.md). rulesRename:"steering" stays — it still rewrites the
  // <harness>/rules/ prose mentions other core files carry.
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
    { src: "hooks/aidlc-kiro-adapter.ts", dst: "hooks/aidlc-kiro-adapter.ts" },
    { src: "settings/cli.json", dst: "settings/cli.json" },
  ],

  // AGENTS.md renders from the shared skeleton with Kiro's fills, at the project
  // root (outside .kiro/). The {{HARNESS_DIR}} → .kiro substitution + rules/ →
  // steering/ rename run on it like any core .md. Replaces the hand-forked
  // harness/kiro/AGENTS.md (which had drifted to "two harnesses" + missing the
  // Documentation/Automated-Testing sections the skeleton now supplies for free).
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // rules/ → steering/ (applied after the token substitution, anchored).
  rulesRename: "steering",

  // The authored agent .json configs and the kiro adapter live inside the
  // otherwise core-copied agents/ and hooks/ dirs — exempt them from the
  // orphan scan (they are harnessFiles, not core-derived).
  authoredExempt: [/^agents\/[^/]+\.json$/, /^hooks\/aidlc-kiro-[^/]+\.ts$/, /^hooks\/[^/]+\.kiro\.hook$/],

  // Kiro ships no per-shell emissions — all its surfaces are authored files.
  emit: null,
};

export default manifest;
