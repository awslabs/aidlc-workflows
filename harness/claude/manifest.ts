// harness/claude/manifest.ts — the Claude Code distribution row.
//
// One core, N harnesses (dist-unified). This manifest tells scripts/package.ts
// how to project the harness-neutral core/ tree into dist/claude/.claude/:
//   - the harness directory token substitution ({{HARNESS_DIR}} → .claude)
//   - the per-dir map (core/<src> → <harnessDir>/<dst>); Claude renames nothing
//   - which authored files live in harness/claude/ and where they land
//
// Claude is a peer harness, not the identity transform: its prose carries the
// same {{HARNESS_DIR}} token as every other harness; the packager substitutes
// `.claude` here. Because that substitution restores exactly today's `.claude/`
// literals, the regenerated dist/claude is byte-identical to the hand-authored
// tree it replaces (the MR-1 keystone gate).

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "claude",
  harnessDir: ".claude",
  tierFlavor: "claude",

  // core/<src> → <harnessDir>/<dst>. Claude keeps every core dir name as-is.
  // The method ("memory") is NO LONGER a core dir projected into the harness
  // tree — it relocated to the workspace-root aidlc/spaces/default/memory/ (one
  // hand-editable copy, emitted by the packager's memory step), read by Claude
  // via the .claude/rules/aidlc.md @-stub (a harnessFile). The rulesRename
  // machinery (steering/aidlc-rules) still rewrites the <harness>/rules/ prose
  // mentions other core files carry, so it stays.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
    // The three harness-neutral session skills ship in-tree under skills/.
    { src: "skills/aidlc-session-cost", dst: "skills/aidlc-session-cost" },
    { src: "skills/aidlc-replay", dst: "skills/aidlc-replay" },
    { src: "skills/aidlc-outcomes-pack", dst: "skills/aidlc-outcomes-pack" },
  ],

  // Authored harness surfaces copied verbatim (with token substitution on .md)
  // from harness/claude/<src> → <harnessDir>/<dst>.
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    // The AIDLC method @-import stub: .claude/rules/aidlc.md pulls the relocated
    // method (aidlc/spaces/default/memory/*) into Claude's ambient context by
    // reference (explicit @-imports, no copy). The rules/ dir is no longer a
    // core projection — this stub is the only file in it.
    { src: "rules-aidlc.md", dst: "rules/aidlc.md" },
    { src: "settings.json", dst: "settings.json" },
    { src: "settings.local.json.example", dst: "settings.local.json.example" },
    // Project-root install files (beside .claude/, not inside it). A user copies
    // `dist/claude/` wholesale, so these ship at the dist root. Authored here
    // (not core/) because they are Claude-Code-specific: .mcp.json is the
    // Claude MCP-server registry (Kiro/Codex configure MCP differently and ship
    // none), and the .gitignore names `.claude/settings.local.json`. projectRoot
    // routes them to dist/claude/<dst> and brings them under the --check drift
    // guard (checkHarness diffs every projectRoot file). dot-gitignore is the
    // authored name so it does not act as a live ignore inside harness/claude/.
    { src: ".mcp.json", dst: ".mcp.json", projectRoot: true },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // The onboarding doc (CLAUDE.md) renders from the shared skeleton
  // core/templates/onboarding.md with Claude's fills, then the standard
  // {{HARNESS_DIR}} → .claude transform. Single source across every harness.
  onboarding: { dst: "CLAUDE.md", fills: onboardingFills },

  // Claude renames no core dir.
  rulesRename: null,

  // No emit() plugin: Claude's runners come from the shared runner-gen
  // composition and its compiled data from graph compile, both driven by the
  // packager. (Codex is the only harness that ships an emit.ts today.)
  emit: null,
};

export default manifest;
