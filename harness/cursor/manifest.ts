// harness/cursor/manifest.ts — the Cursor IDE distribution row.
//
// Projects the harness-neutral core/ tree into dist/cursor/.cursor/ (the same
// coreDirs set as Claude/opencode) and defers every Cursor-native surface that
// no declarative projection can express to emit.ts: the folder-per-rule
// `.cursor/rules/<name>/<name>.mdc` layers (with YAML frontmatter), the Cursor
// v1 `hooks.json` registry, the `commands/*.md` slash commands, the cursor-agent
// `cli.json` permission set, and the `.cursor-plugin/` store manifests.
//
// Cursor specifics vs Claude/opencode:
//   - token → .cursor (Cursor's native configuration directory).
//   - tierFlavor "claude": Cursor selects Anthropic models via its own picker,
//     so the persona surfaces use the Claude tier projection.
//   - rulesRename null: the emitter OWNS .cursor/rules/ entirely (it is not a
//     core-projected dir), so there is nothing for the packager to rename.
//   - skipRunnerGen false: stage/scope runners land in the standard
//     .cursor/skills/ location, exactly like Claude.
//   - the sole authored .cursor/ hook file is the aidlc-cursor-adapter.ts stdin
//     shim (a harnessFile) that bridges Cursor's JSON-permission-deny contract
//     onto the core Claude-shaped exit-code-2 hook bodies.
//
// The packager auto-discovers this file via its manifest.ts scan; no changes to
// scripts/package.ts are needed.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";
import emit from "./emit.ts";

const manifest: HarnessManifest = {
  name: "cursor",
  harnessDir: ".cursor",
  tierFlavor: "claude",

  // Same core projection as Claude/opencode, into .cursor/. The method
  // ("memory") is NOT a core dir here — emit.ts transposes it into the
  // .cursor/rules/ .mdc layers instead. The three harness-neutral session
  // skills ship in-tree under skills/ (skipRunnerGen is false).
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

  // Authored harness surfaces copied verbatim (with token substitution on .md)
  // from harness/cursor/<src> → <harnessDir>/<dst>.
  harnessFiles: [
    // The orchestrator skill, inside .cursor/skills/aidlc/ — Cursor exposes it
    // as the /aidlc slash command (name: aidlc must match the folder).
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    // The Cursor hook adapter: bridges Cursor's hook contract (JSON
    // permission-deny, beforeSubmitPrompt session init) onto the core
    // Claude-shaped hook bodies in .cursor/hooks/aidlc-*.ts.
    { src: "hooks/aidlc-cursor-adapter.ts", dst: "hooks/aidlc-cursor-adapter.ts" },
    // Project-root .gitignore (beside .cursor/, not inside it) for the workspace
    // layout. Authored as dot-gitignore so it does not act as a live ignore
    // inside harness/cursor/; projectRoot routes it to dist/cursor/.gitignore
    // and the --check drift guard.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // AGENTS.md at the project root — rendered by the packager from the shared
  // skeleton core/templates/onboarding.md with Cursor's fills, then the standard
  // {{HARNESS_DIR}} → .cursor transform. Same mechanism as Claude/opencode/Kiro.
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // The emitter owns .cursor/rules/ entirely; core's rules/ name has nothing to
  // collide with, so no rename.
  rulesRename: null,

  // Runners ship in .cursor/skills/ via the standard runner-gen step.
  skipRunnerGen: false,

  // Cursor-native surfaces: rules, hooks.json, commands, cli.json, plugin
  // manifests. Everything CODE, not declarative data.
  emit,

  // Host plugin projection: Cursor has a plugin store (kind "store"), so the
  // projection ships the uniform store layout under .cursor-plugin/.
  plugin: { manifestDir: ".cursor-plugin", kind: "store" },
};

export default manifest;
