// harness/copilot/manifest.ts — the GitHub Copilot (VS Code agent mode) row.
//
// Projects the harness-neutral core/ tree into dist/copilot/.github/ and defers
// the Copilot-specific structural divergence to emit.ts: the 14 agent .md files
// are transposed to Copilot-native .agent.md frontmatter, and a single
// hooks.json wires the lifecycle events to the aidlc-copilot-adapter shim.
// Modeled on harness/codex/manifest.ts (the other emit()-driven harness).
//
// Copilot specifics vs Claude/Kiro/Codex:
//   - token → .github (Copilot's zero-config discovery root).
//   - rulesRename null: the method rule layers land at .github/rules/ (a plain
//     coreDirs copy of core/memory), referenced from the root AGENTS.md — there
//     is no confirmed Copilot auto-discovery of a renamed dir, so no rename.
//   - skipRunnerGen false: the packager's standard runner-gen writes the stage +
//     scope runners into <harnessDir>/skills/ = .github/skills/, which is exactly
//     Copilot's skill discovery path, so no replication in emit() is needed.
//   - onboarding is rendered INSIDE emit() (the codex pattern): the root
//     AGENTS.md needs the same render-from-skeleton path, and the test capability
//     matrix requires onboarding:null whenever a harness emits it via emit().
//   - the two authored .github/ surfaces are the orchestrator SKILL.md and the
//     aidlc-copilot-adapter.ts stdin shim; the 14 .agent.md files are EMITTED.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import emit from "./emit.ts";

const manifest: HarnessManifest = {
  name: "copilot",
  harnessDir: ".github",
  tierFlavor: "copilot",

  // core/<src> → <harnessDir>/<dst>. The agents dir is copied here as the SOURCE
  // for two consumers: the packager's runner-gen step (loadAgents() reads the
  // core .md frontmatter to validate stage lead/support slugs) AND emit(), which
  // reads core/agents/*.md directly and clean-sweeps this dir to replace the
  // core .md with Copilot-native .agent.md. The method ("memory") is projected to
  // .github/rules/ for Copilot's rules surface AND (by the packager's dedicated
  // memory step) to the workspace-root aidlc/spaces/default/memory/ shell — the
  // single hand-editable source of truth every harness shares.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "hooks", dst: "hooks" },
    { src: "memory", dst: "rules" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "agents", dst: "agents" },
    // The three harness-neutral session skills ship in-tree under skills/
    // (runner-gen only emits stage/scope runners, not these).
    { src: "skills/aidlc-session-cost", dst: "skills/aidlc-session-cost" },
    { src: "skills/aidlc-replay", dst: "skills/aidlc-replay" },
    { src: "skills/aidlc-outcomes-pack", dst: "skills/aidlc-outcomes-pack" },
  ],

  // Authored harness surfaces copied verbatim (token substitution on .md). The
  // orchestrator SKILL.md lands in .github/skills/aidlc/ (Copilot's skill path),
  // the adapter beside the copied core hooks in .github/hooks/. The 14 agent
  // .agent.md files are NOT here — emit() transposes them from core/agents/.
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "hooks/aidlc-copilot-adapter.ts", dst: "hooks/aidlc-copilot-adapter.ts" },
    // Project-root .gitignore (beside .github/, not inside it) — re-rooted under
    // aidlc/spaces/* for the workspace layout (SEED): per-user cursors +
    // machine-local runtime ignored, the shared work committed. Authored as
    // dot-gitignore so it does not act as a live ignore inside harness/copilot/;
    // projectRoot routes it to dist/copilot/.gitignore + the --check drift guard.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // Copilot renders its onboarding doc (root AGENTS.md) INSIDE emit(), so the
  // manifest leaves onboarding null (the codex pattern; the test capability
  // matrix enforces onboarding:null for an emit()-rendered onboarding doc).
  onboarding: null,

  // Rules land at .github/rules/ under their core names — no rename.
  rulesRename: null,

  // Standard runner-gen writes .github/skills/ (Copilot's discovery path).
  skipRunnerGen: false,

  emit,
};

export default manifest;
