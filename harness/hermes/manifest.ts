// harness/hermes/manifest.ts — the Hermes Agent distribution row.
//
// Projects the harness-neutral core/ tree into dist/hermes/.hermes/ and ships
// the orchestrator skill where Hermes discovers project-local skills:
// `.hermes/skills/aidlc/SKILL.md` (a trusted project's skills are scanned
// recursively; `hermes skills trust` approves the repo once).
//
// Hermes specifics vs Claude:
//   - token -> .hermes. Hermes discovers project skills under `.hermes/skills/`
//     and `.agents/skills/`; the engine tree lives in `.hermes/` so the whole
//     install is one directory.
//   - the entry is the discovered skill command `/aidlc`,
//     and every engine call runs through the `terminal` tool.
//   - `.hermes.md` at the project root is Hermes's always-on project context
//     (walked up to the git root), so the onboarding doc lands there.
//   - shell hook registration is a manual profile opt-in; the bundled adapter
//     covers only a subset of tools and guards. See the Hermes guide.
//   - no statusline and no MCP servers ship.
//
// Verified against Hermes Agent v0.21.7.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const manifest: HarnessManifest = {
  name: "hermes",
  productName: "Hermes Agent",
  // The discovered skill command `/aidlc` loads the
  // conductor, and the conductor runs the engine through its terminal tool.
  configNextStep:
    "start `hermes` in this project (run `hermes skills trust` once so it loads the project's skills), then type `/aidlc`",
  // Every command Hermes's agent runs carries AI_AGENT=hermes-agent.
  hostShell: { env: ["AI_AGENT=hermes-agent"] },
  // /new starts a clean session; load the conductor again with /aidlc.
  newChatStep: { text: "type `/new`, then `/aidlc`" },
  harnessDir: ".hermes",
  orchestratorSkillPath: ".hermes/skills/aidlc/SKILL.md",
  // Persona files are inline prose the conductor adopts; no native subagent
  // discovery, no model or effort keys, and no status line.
  tierFlavor: "hermes",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
    },
    {
      // Hermes reads `.hermes.md` from the project root (and its parents, up
      // to the git root) as always-on project context; the onboarding doc
      // lands there and `aidlc config` merges it as a managed block so a
      // project's own `.hermes.md` keeps every line it has.
      path: ".hermes.md",
      policy: "managed-block",
      marker: "agents",
    },
  ],

  // Same core projection as claude, into .hermes/.
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
    { src: "skills/aidlc-issue-report", dst: "skills/aidlc-issue-report" },
    { src: "skills/aidlc-knowledge", dst: "skills/aidlc-knowledge" },
  ],

  harnessFiles: [
    { src: "hooks/aidlc-hermes-adapter.ts", dst: "hooks/aidlc-hermes-adapter.ts" },
    // The orchestrator skill: Hermes discovers it as the project skill `aidlc`.
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "skills/aidlc/composer.md", dst: "skills/aidlc/composer.md" },
    { src: "skills/aidlc/tables.md", dst: "skills/aidlc/tables.md" },
    // Project-root ignore block (the git-ignored working files).
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // Hermes reads `.hermes.md` from the project root (and its parents, up to the
  // git root) as always-on project context, so both onboarding parts ship there.
  onboarding: { dst: ".hermes.md", projectRoot: true, fills: onboardingFills },

  rulesRename: null,

  // No emit() plugin: skills and the engine tree come from the declarative
  // projection, and Hermes needs no host settings file.
  emit: null,
};

export default manifest;
