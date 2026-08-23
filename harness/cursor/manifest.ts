// harness/cursor/manifest.ts — the Cursor distribution row.
//
// Projects the harness-neutral core/ tree into dist/cursor/.cursor/. Cursor is
// the most "native" port so far: unlike opencode (engine hidden in .aidlc/) or
// codex (skills composed by emit.ts), Cursor consumes the standard projection
// directly — no emit.ts at all.
//
// Cursor specifics vs Claude (all live-verified against cursor-agent
// 2026.07.23 on Linux; the IDE shares the same .cursor/ discovery):
//   - token → .cursor. Cursor scans ONLY .cursor/rules/, .cursor/agents/,
//     .cursor/skills/, .cursor/commands/, .cursor/hooks.json, .cursor/mcp.json
//     and .cursor/cli.json for native meaning; the engine dirs (tools/,
//     aidlc-common/, knowledge/, sensors/, scopes/, hooks/) are inert data to
//     Cursor and safely share the directory.
//   - the 14 core persona .md files in .cursor/agents/ ARE live native
//     subagents: Cursor's agent frontmatter (name/description/model) is a
//     subset of core's and unknown keys are tolerated (live-verified with the
//     full core frontmatter incl. display_name/examples/disallowedTools).
//     The task tool targets them by name — no emitted twins.
//   - skills: .cursor/skills/<name>/SKILL.md is Cursor's native skill layout,
//     invoked as /<name> with inline argument forwarding (live-verified). The
//     generated stage runners land there via the standard runner-gen step;
//     three authored utility skills add /aidlc-status, /aidlc-jump, and
//     /aidlc-scope without relying on Cursor's legacy commands directory.
//   - rules: Cursor loads ONLY .mdc files with frontmatter from
//     .cursor/rules/ (a plain .md there is ignored, and @-import lines do NOT
//     expand — both live-verified). The method include is therefore split:
//     rules/aidlc.mdc always carries org/team/project, while four agent-decided
//     phase pointers keep phase guidance relevant (live-verified: a phase
//     question loads only the matching phase rule; an off-topic prompt loads
//     none). The sessionStart hook injects the live workflow context.
//   - hooks: .cursor/hooks.json wires camelCase events (matcher-free; the
//     adapter self-filters) to aidlc-cursor-adapter.ts, which normalizes
//     payloads and subprocess-pipes into the byte-shared core hooks.
import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "cursor",
  harnessDir: ".cursor",
  orchestratorSkillPath: ".cursor/skills/aidlc/SKILL.md",
  tierFlavor: "cursor",

  // Same core projection as claude, into .cursor/.
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
    // The orchestrator skill — Cursor-native layout, /aidlc invocation.
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    // Cursor-native shortcut skills. Cursor's commands/ surface is legacy;
    // skills are the current slash-invocation primitive.
    { src: "skills/aidlc-status/SKILL.md", dst: "skills/aidlc-status/SKILL.md" },
    { src: "skills/aidlc-jump/SKILL.md", dst: "skills/aidlc-jump/SKILL.md" },
    { src: "skills/aidlc-scope/SKILL.md", dst: "skills/aidlc-scope/SKILL.md" },
    // AIDLC method pointers: standing layers always apply; phase guidance is
    // agent-decided. Cursor has no @-import expansion, so each carries a READ
    // instruction naming the active-space file. /aidlc space re-points every
    // explicit path in place (aidlc-includes.ts cursor arm).
    { src: "rules-aidlc.mdc", dst: "rules/aidlc.mdc" },
    { src: "rules-aidlc-phase-ideation.mdc", dst: "rules/aidlc-phase-ideation.mdc" },
    { src: "rules-aidlc-phase-inception.mdc", dst: "rules/aidlc-phase-inception.mdc" },
    { src: "rules-aidlc-phase-construction.mdc", dst: "rules/aidlc-phase-construction.mdc" },
    { src: "rules-aidlc-phase-operation.mdc", dst: "rules/aidlc-phase-operation.mdc" },
    // The hook shim + wiring (the adapter is authored; the core hook bodies
    // beside it are packaged byte-identical to the Claude harness).
    { src: "hooks/aidlc-cursor-adapter.ts", dst: "hooks/aidlc-cursor-adapter.ts" },
    { src: "hooks.json", dst: "hooks.json" },
    // Project-level permissions: pre-approve bun (the engine/tool runner) so
    // the forwarding loop is not interrupted by a prompt per engine call.
    // .cursor/cli.json is the ONLY project-level CLI config Cursor reads
    // (permissions only, documented contract).
    { src: "cli.json", dst: "cli.json" },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
    // Distribution-local, non-destructive install command. It merges the
    // project-owned Cursor config and onboarding surfaces before copying.
    { src: "install.ts", dst: "install.ts", projectRoot: true },
  ],

  // AGENTS.md at the project root — Cursor auto-reads it (root + nested) as
  // plain ambient instructions (no @-import expansion; live-verified).
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // .cursor/rules/ is Cursor's native rules dir and our stub deliberately
  // lives there; core projects no rules/ dir, so nothing needs renaming.
  rulesRename: null,

  // Runners generate into .cursor/skills/ and remain explicit-only. Cursor
  // otherwise lets the model auto-activate a relevant skill even when
  // user-invocable is true, which is unsafe for state-mutating stage runners.
  runnerFrontmatterAdditions: ["disable-model-invocation: true"],

  emit: null,

  plugin: { manifestDir: ".cursor-plugin", kind: "cursor" },
};

export default manifest;
