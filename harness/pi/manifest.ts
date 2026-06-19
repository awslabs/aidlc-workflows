// harness/pi/manifest.ts — the Pi (earendil-works) distribution row.
//
// Projects the harness-neutral core/ tree into dist/pi/.pi/, plus Pi's
// authored shell surfaces (orchestrator skill, AskUserQuestion extension,
// consolidated aidlc-hooks extension, settings, statusline script). Pi is
// structurally similar to Claude but uses Pi's extension system instead of
// Claude's hook system.
//
// Pi specifics vs Claude:
//   - token → .pi
//   - rules/ stays rules/ (same as Claude — Pi auto-loads them)
//   - extensions/ replaces Claude hook files — Pi uses one consolidated
//     aidlc-hooks.ts extension plus the AskUserQuestion extension; NO core hooks are copied
//   - tools/ is canonical for Pi; all Pi-authored surfaces reference tools/
//     consistently
//   - settings.json carries Pi-specific model IDs (us.anthropic.*) and
//     extension registrations; it is harness-authored, not core
//   - The orchestrator skill file is harness-authored (Pi-specific tool paths
//     and Pi-specific conductor loop wording)
//   - CLAUDE.md (onboarding doc) lives inside .pi/ (not projectRoot)

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "pi",
  harnessDir: ".pi",

  // Core projection: identical to Claude except core hook files are excluded
  // (Pi uses extensions instead). rules/ keeps its name (same as Claude).
  // Session skills ship in-tree under skills/.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "rules", dst: "rules" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    // No core hook files — Pi uses extensions/ for lifecycle events.
    { src: "skills/aidlc-session-cost", dst: "skills/aidlc-session-cost" },
    { src: "skills/aidlc-replay", dst: "skills/aidlc-replay" },
    { src: "skills/aidlc-outcomes-pack", dst: "skills/aidlc-outcomes-pack" },
  ],

  // Authored Pi shell surfaces:
  //   - Orchestrator skill and question-rendering annex
  //   - Consolidated aidlc-hooks extension (audit, sensor, runtime-compile,
  //     session lifecycle, state validation, subagent tracking, stop hook,
  //     statusline sync — all in one Pi-native extension file)
  //   - AskUserQuestion extension (Pi-native structured question UI)
  //   - settings.json / settings.local.json.example (Pi-specific model IDs,
  //     extension registrations, permissions)
  //   - scripts/aidlc-statusline.ts (Pi statusline script)
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "extensions/aidlc-hooks.ts", dst: "extensions/aidlc-hooks.ts" },
    { src: "extensions/askuserquestion/component.ts", dst: "extensions/askuserquestion/component.ts" },
    { src: "extensions/askuserquestion/CREDIT.md", dst: "extensions/askuserquestion/CREDIT.md" },
    { src: "extensions/askuserquestion/index.ts", dst: "extensions/askuserquestion/index.ts" },
    { src: "extensions/askuserquestion/schema.ts", dst: "extensions/askuserquestion/schema.ts" },
    { src: "extensions/askuserquestion/validate.ts", dst: "extensions/askuserquestion/validate.ts" },
    { src: "settings.json", dst: "settings.json" },
    { src: "settings.local.json.example", dst: "settings.local.json.example" },
    { src: "scripts/aidlc-statusline.ts", dst: "scripts/aidlc-statusline.ts" },
  ],

  // CLAUDE.md rendered inside .pi/ (not projectRoot — same pattern as Claude's
  // .claude/CLAUDE.md). The {{HARNESS_DIR}} → .pi substitution runs on it.
  onboarding: { dst: "CLAUDE.md", fills: onboardingFills },

  // Pi keeps rules/ as rules/ (no rename — same as Claude).
  rulesRename: null,

  // The extensions/ dir is entirely harness-authored; exempt everything in it
  // from the orphan scan (none of those files come from core).
  authoredExempt: [/^extensions\//],

  // No emit() — Pi's runner-gen output goes into skills/ via the standard
  // pipeline, and all other Pi-specific surfaces are harnessFiles.
  emit: null,
};

export default manifest;
