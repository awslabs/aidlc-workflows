// harness/opencode/manifest.ts — the opencode distribution row.
//
// Projects the harness-neutral core/ tree into dist/opencode/.aidlc/ and defers
// every opencode-native surface to emit.ts (the .opencode/ shell: subagent .md
// files, the /aidlc command, the hook-adapter plugin). Verified live against
// opencode 1.17.18.
//
// opencode specifics vs Claude:
//   - token → .aidlc, NOT .opencode. opencode auto-imports every *.ts under
//     .opencode/tools/ and .opencode/tool/ as custom tool definitions
//     (live-verified: a CLI-style script there crashes the session), so the
//     engine tree cannot live inside .opencode/. It ships at .aidlc/ — a dir
//     opencode never scans — and the shipped opencode.json registers
//     `skills.paths: [".aidlc/skills"]` so skills are discovered there
//     (live-verified).
//   - .opencode/ carries ONLY natively-consumed emissions (emit.ts): the 14
//     persona subagents (.opencode/agents/*.md, mode: subagent + projected
//     tier keys), the /aidlc command (.opencode/command/aidlc.md), and the
//     hook-adapter plugin (.opencode/plugin/aidlc-opencode-adapter.ts, the
//     auto-discovered plugin seam mapping opencode hook moments onto the core
//     hook bodies in .aidlc/hooks/).
//   - the method tree reaches ambient context via the `instructions` glob in
//     the shipped opencode.json ("aidlc/spaces/default/memory/**/*.md",
//     live-verified) — opencode's native include surface, re-pointed on a
//     space switch by aidlc-includes.ts.
//   - opencode auto-reads the project-root AGENTS.md (its primary rules file).

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";
import emit from "./emit.ts";

const manifest: HarnessManifest = {
  name: "opencode",
  harnessDir: ".aidlc",
  tierFlavor: "opencode",

  // Same core projection as claude, into .aidlc/. The persona .md files ARE
  // core (the conductor adopts them inline from .aidlc/agents/); the
  // opencode-native subagent copies in .opencode/agents/ are emitted.
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

  harnessFiles: [
    // The orchestrator skill, inside .aidlc/skills/ (discovered via the
    // opencode.json skills.paths glob, like every generated runner).
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    // Project config at the dist ROOT (opencode reads ./opencode.json):
    // skills.paths (skill discovery), instructions glob (the method include),
    // and the bun tool-command permissions.
    { src: "opencode.json", dst: "opencode.json", projectRoot: true },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // AGENTS.md at the project root — opencode auto-reads it (its primary rules
  // file), the same skeleton + fills mechanism as Kiro/Claude.
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // .aidlc/ is AIDLC's own dir; core's rules/ name has nothing to collide with.
  rulesRename: null,

  emit,

  // Host plugin projection: opencode's own plugin store is JS-module-shaped
  // (not folder-drop stage bundles), so the projection ships the uniform
  // store layout for manual composition. The compose hooks.json wiring is not
  // executable by opencode today — documented limitation.
  plugin: { manifestDir: ".opencode-plugin", kind: "store" },
};

export default manifest;
