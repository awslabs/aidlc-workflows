// harness/devin/manifest.ts — the Devin CLI distribution row.
//
// One core, N harnesses (dist-unified). This manifest tells scripts/package.ts
// how to project the harness-neutral core/ tree into dist/devin/.devin/:
//   - the harness directory token substitution ({{HARNESS_DIR}} → .devin)
//   - the per-dir map (core/<src> → <harnessDir>/<dst>); Devin renames nothing
//   - which authored files live in harness/devin/ and where they land
//
// Devin is a peer harness, not the identity transform: its prose carries the
// same {{HARNESS_DIR}} token as every other harness; the packager substitutes
// `.devin` here. Devin is authored-files-only like Claude (no emit()): every
// harness-specific surface (the stdin adapter shim, hooks.v1.json wiring,
// config.json permissions, mcp_config.json, the rules/aidlc.md auto-load stub,
// the orchestrator SKILL.md) is a hand-authored harnessFile copied verbatim
// (with token substitution on .md). The plugin projection is omitted so the
// packager derives the default `.devin-plugin` + `kind:"store"` (Devin's native
// plugin format).

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "devin",
  harnessDir: ".devin",
  orchestratorSkillPath: ".devin/skills/aidlc/SKILL.md",
  tierFlavor: "devin",

  // core/<src> → <harnessDir>/<dst>. Devin keeps every core dir name as-is
  // (same projection as Claude). The method ("memory") is NO LONGER a core dir
  // projected into the harness tree — it relocated to the workspace-root
  // aidlc/spaces/default/memory/ (one hand-editable copy, emitted by the
  // packager's memory step), loaded by Devin via the .devin/rules/aidlc.md
  // auto-load stub (a harnessFile — Devin loads .devin/rules/*.md automatically,
  // no @-import needed).
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
    // The harness-neutral standalone skills ship in-tree under skills/.
    { src: "skills/aidlc-session-cost", dst: "skills/aidlc-session-cost" },
    { src: "skills/aidlc-replay", dst: "skills/aidlc-replay" },
    { src: "skills/aidlc-outcomes-pack", dst: "skills/aidlc-outcomes-pack" },
    { src: "skills/aidlc-knowledge", dst: "skills/aidlc-knowledge" },
  ],

  // Authored harness surfaces copied verbatim (with token substitution on .md)
  // from harness/devin/<src> → <harnessDir>/<dst>. The stdin adapter shim
  // re-wraps Devin's hook JSON onto the core hooks; hooks.v1.json wires Devin
  // events → adapter → core hooks; config.json holds Devin permissions;
  // mcp_config.json declares the MCP servers; rules/aidlc.md is the auto-loaded
  // method pointer; skills/aidlc/SKILL.md is the orchestrator.
  harnessFiles: [
    { src: "hooks/aidlc-devin-adapter.ts", dst: "hooks/aidlc-devin-adapter.ts" },
    { src: "hooks.v1.json", dst: "hooks.v1.json" },
    { src: "config.json", dst: "config.json" },
    { src: "mcp_config.json", dst: "mcp_config.json" },
    // The AIDLC method auto-load stub: .devin/rules/aidlc.md points at the
    // relocated method (aidlc/spaces/default/memory/*). Devin loads
    // .devin/rules/*.md into ambient context automatically (no @-import, unlike
    // Claude). The rules/ dir is no longer a core projection — this stub is the
    // only file in it.
    { src: "rules-aidlc.md", dst: "rules/aidlc.md" },
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    // Project-root install files (beside .devin/, not inside it). A user copies
    // `dist/devin/` wholesale, so these ship at the dist root. Authored here
    // (not core/) because they are Devin-specific: the .gitignore names
    // `.devin/config.local.json` etc. projectRoot routes them to
    // dist/devin/<dst> and brings them under the --check drift guard
    // (checkHarness diffs every projectRoot file). dot-gitignore is the
    // authored name so it does not act as a live ignore inside harness/devin/.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // The onboarding doc (AGENTS.md) renders from the shared skeleton
  // core/templates/onboarding.md with Devin's fills, then the standard
  // {{HARNESS_DIR}} → .devin transform. Landed at the dist root (beside .devin/,
  // like Kiro/Codex/Cursor), not inside the harness dir.
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // Devin renames no core dir.
  rulesRename: null,

  // No emit() plugin: Devin's runners come from the shared runner-gen
  // composition and its compiled data from graph compile, both driven by the
  // packager. Every Devin-specific surface is an authored harnessFile. (Codex is
  // the only harness that ships an emit.ts today.)
  emit: null,

  // plugin omitted → the packager derives the default `.devin-plugin` +
  // kind:"store" projection (Devin's native plugin format), per manifest-types.
};

export default manifest;
