// harness/devin-cloud/manifest.ts — the Devin Cloud distribution row.
//
// Devin Cloud sessions (app.devin.ai / API-spawned) have NO lifecycle-hook
// transport in the project tree: a session exposes AGENTS.md at the repo root,
// skills discovered at .agents/skills/<name>/SKILL.md, knowledge, playbooks,
// MCP servers configured in Customize, and the environment blueprint — nothing
// that intercepts tool calls from a repo file. Hooks DO exist in Cloud via
// scope manifests (Customize → Hooks edit a scope's hooks.json), but that is an
// org-level control surface, not a file this distribution can ship.
//
// Consequence (the whole point of this harness): enforcement is COOPERATIVE.
// Where the CLI harness intercepts tool calls, Cloud verifies at the gate: the
// orchestrator skill instructs the conductor to call the engine at every
// transition, and the engine's state/receipt checks refuse invalid advances.
// The audit trail plus `aidlc --doctor`'s gate-checkpoint scan are the
// after-the-fact detection surface.
//
// Layout: the engine ships at .aidlc/ (shared with copilot/opencode — an
// install is disambiguated by tools/data/harness.json + .agents/skills/).
// Skills emit to .agents/skills/ (Cloud's documented discovery path), so
// skipRunnerGen is set and emit.ts composes the tree — the codex/copilot idiom.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";
import emit from "./emit.ts";

const manifest: HarnessManifest = {
  name: "devin-cloud",
  productName: "Devin Cloud",
  configNextStep:
    "start a Devin session on this repository, then ask Devin to run the aidlc skill (`@skills:aidlc --doctor`)",
  harnessDir: ".aidlc",
  orchestratorSkillPath: ".agents/skills/aidlc/SKILL.md",
  tierFlavor: "devin",
  rootIntegrations: [
    { path: ".gitignore", policy: "managed-block", marker: "gitignore" },
    { path: "AGENTS.md", policy: "managed-block", marker: "agents" },
    { path: "blueprint.aidlc.yaml", policy: "whole-file" },
    { path: "aidlc.devin.md", policy: "whole-file" },
  ],

  // Same core projection as claude, into .aidlc/. The hooks/ dir is projected
  // because the conductor invokes aidlc-session-start.ts DIRECTLY at session
  // start (there is no host SessionStart event to fire it): that call mints the
  // AIDLC session record and binding the rest of the engine resolves against.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
  ],

  // Authored harness surfaces copied verbatim (with token substitution on .md)
  // from harness/devin-cloud/<src> into each channel. config.json and
  // mcp_config.json are AIDLC harness configuration + an MCP template — Cloud
  // does not auto-load either; they document intent and seed Customize setup.
  harnessFiles: [
    { src: "config.json", dst: "config.json" },
    { src: "mcp_config.json", dst: "mcp_config.json" },
    // Entry/install surface for Cloud: the blueprint snippet (initialize +
    // maintenance for the AIDLC runtime prerequisites) and the entry playbook
    // a user attaches to start an AIDLC-driven session.
    { src: "blueprint.aidlc.yaml", dst: "blueprint.aidlc.yaml", projectRoot: true },
    { src: "aidlc.devin.md", dst: "aidlc.devin.md", projectRoot: true },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // AGENTS.md at the project root — Cloud sessions read it unconditionally.
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // .aidlc/ is AIDLC's own dir; core's rules/ name has nothing to collide with.
  rulesRename: null,

  // Cloud discovers skills at .agents/skills/, never inside .aidlc/ — emit.ts
  // composes the full skill tree there (orchestrator + generated runners +
  // session skills), the codex/copilot idiom.
  skipRunnerGen: true,

  emit,

  // Devin Cloud has no host plugin wiring (no SessionStart transport) —
  // plugins arrive by folder-drop and compose explicitly via
  // `.aidlc/tools/aidlc-plugin.ts`, same shape as the Kiro CLI projection.
  plugin: { manifestDir: ".aidlc-plugin", kind: "kiro" },
};

export default manifest;
