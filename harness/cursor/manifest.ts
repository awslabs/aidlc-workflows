// harness/cursor/manifest.ts — the Cursor distribution row.
//
// Projects the harness-neutral core/ tree into dist/cursor/.cursor/, plus
// Cursor's authored shell surfaces (orchestrator skill, hooks.json, the stdin
// adapter hook, the always-apply rules stub, cli.json permissions, AGENTS.md).
//
// Cursor (the editor + the `agent` CLI, cursor.com) implements the open Agent
// Skills standard (SKILL.md) since 2.4, reads Claude-style subagent .md files
// from .cursor/agents/, and ships a hooks system whose wire protocol
// deliberately mirrors Claude Code's (JSON on stdin, exit 2 = block). That
// makes this the most declarative port after Claude itself:
//   - token → .cursor
//   - NO rules rename: .cursor/rules/ is Cursor's native rules dir and the one
//     file we ship there (rules/aidlc.mdc, alwaysApply) IS a Cursor rule —
//     unlike Codex, whose native rules dir holds Starlark and forces a rename.
//     Note the .mdc extension: Cursor IGNORES plain .md inside .cursor/rules/.
//   - the orchestrator skill is per-harness (authored here, NOT core); the
//     stage/scope runners come from the standard runner-gen step into
//     .cursor/skills/ (no skipRunnerGen, no emit — Cursor discovers skills
//     natively at .cursor/skills/).
//   - agents/ needs NO authored configs: Cursor reads the core persona .md
//     files directly as subagents (frontmatter name/description honored,
//     unknown keys ignored), so the delegation targets work as-shipped.
//   - hooks/ is MIXED: core hook bodies are copied; the one authored
//     aidlc-cursor-adapter.ts stdin shim is a harnessFile, registered by the
//     authored .cursor/hooks.json.
//   - AGENTS.md lands at the PROJECT ROOT (Cursor reads it natively and
//     always applies it).

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "cursor",
  harnessDir: ".cursor",
  // Cursor's subagent frontmatter carries `model:` only — effort rides on the
  // model ID as a bracket param (claude-sonnet-4-5[effort=medium]), never as a
  // separate key. That is its own TIER_PROJECTIONS column (core/tools/aidlc-tiers.ts).
  tierFlavor: "cursor",

  // Same core projection as claude: every core dir keeps its name.
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

  // Authored Cursor shell surfaces. These carry literal `.cursor` paths
  // (harness-specific by construction).
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    // The AIDLC method always-apply stub: .cursor/rules/aidlc.mdc pulls the
    // relocated method (aidlc/spaces/default/memory/*) into Cursor's ambient
    // context by reference. Cursor loads ONLY .mdc files from .cursor/rules/
    // (plain .md is ignored there), so this is the one non-.md rules stub in
    // the harness family. The rules/ dir is not a core projection — this stub
    // is the only file in it.
    { src: "rules-aidlc.mdc", dst: "rules/aidlc.mdc" },
    // Hook registration: Cursor reads <project>/.cursor/hooks.json (version 1,
    // camelCase events). Every command routes through the authored adapter.
    { src: "hooks.json", dst: "hooks.json" },
    // The stdin adapter shim (normalizes Cursor payloads → the Claude-shaped
    // core-hook contract). Lives beside the byte-shared core hook bodies.
    { src: "hooks/aidlc-cursor-adapter.ts", dst: "hooks/aidlc-cursor-adapter.ts" },
    // Deterministic CLI permission allowlist: pre-approve the framework's own
    // bun invocations so the forwarding loop (`next`/`report` on every stage)
    // does not prompt per call. Project-level cli.json carries permissions only.
    { src: "cli.json", dst: "cli.json" },
    // Project-root .gitignore (beside .cursor/, not inside it) — the same
    // committed-vs-ignored split as the other harnesses, re-rooted under
    // aidlc/spaces/*. Authored as dot-gitignore so it does not act as a live
    // ignore inside harness/cursor/.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // AGENTS.md renders from the shared skeleton with Cursor's fills, at the
  // project root (outside .cursor/) — Cursor reads root AGENTS.md natively.
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // Cursor renames no core dir: .cursor/rules/ is the native always-on layer
  // and our stub ships there as a real Cursor rule.
  rulesRename: null,

  // The authored adapter lives inside the otherwise core-copied hooks/ dir —
  // exempt it from the orphan scan (it is a harnessFile, not core-derived).
  authoredExempt: [/^hooks\/aidlc-cursor-[^/]+\.ts$/],

  // No emit() plugin: Cursor's runners come from the shared runner-gen
  // composition and its compiled data from graph compile, both driven by the
  // packager — the same fully-declarative shape as Claude.
  emit: null,

  // Plugin projection: the packager default (manifestDir ".cursor-plugin",
  // kind "store") happens to match Cursor's REAL plugin format — Cursor
  // plugins declare themselves via .cursor-plugin/plugin.json — so the
  // derived default is left in place deliberately rather than overridden.
};

export default manifest;
