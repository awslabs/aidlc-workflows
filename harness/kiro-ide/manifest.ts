// harness/kiro-ide/manifest.ts — the Kiro IDE distribution row.
//
// Kiro IDE-native format. Descends from the Kiro CLI harness (harness/kiro/)
// but drops the CLI surfaces the IDE does not read and adds IDE-native ones:
//
//   - Agents ship as Markdown only. The conductor is an authored aidlc.md;
//     persona files come from core and receive IDE-native tools/permissions.
//   - The CLI's 15 agent-v1 JSON files and settings/cli.json are omitted.
//   - Always-included steering preloads the active-space memory tree.
//   - V2 hook JSON files serve IDE >=1.0, with legacy .kiro.hook files retained
//     for pre-1.0 coexistence.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const DELEGATION_AGENTS = [
  "aidlc-composer-agent",
  "aidlc-developer-agent",
  "aidlc-architect-agent",
  "aidlc-product-lead-agent",
  "aidlc-architecture-reviewer-agent",
  "aidlc-product-agent",
  "aidlc-design-agent",
  "aidlc-delivery-agent",
  "aidlc-aws-platform-agent",
  "aidlc-compliance-agent",
  "aidlc-devsecops-agent",
  "aidlc-quality-agent",
  "aidlc-pipeline-deploy-agent",
  "aidlc-operations-agent",
] as const;

const composerPaths = [
  `        - ".kiro/scopes/**"`,
  `        - ".kiro/tools/data/scope-grid.json"`,
];
const spacePaths = [`        - "aidlc/spaces/**"`];

function personaFrontmatter(agent: string): string[] {
  const filesystemPaths =
    agent === "aidlc-composer-agent" ? composerPaths : spacePaths;
  return [
    `tools: ["read", "write", "shell"]`,
    "permissions:",
    "  rules:",
    "    - capability: shell",
    "      effect: allow",
    "      match:",
    `        - "bun .kiro/tools/aidlc-*"`,
    `        - "date -u *"`,
    "    - capability: filesystem",
    "      effect: allow",
    "      match:",
    ...filesystemPaths,
  ];
}

const manifest: HarnessManifest = {
  name: "kiro-ide",
  harnessDir: ".kiro",
  orchestratorSkillPath: ".kiro/skills/aidlc/SKILL.md",
  tierFlavor: "kiro",

  // Same core projection as kiro CLI.
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

  // Authored IDE surfaces. Persona Markdown files are core projections.
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "steering/aidlc-active-memory.md", dst: "steering/aidlc-active-memory.md" },
    { src: "agents/aidlc.md", dst: "agents/aidlc.md" },
    { src: "hooks/aidlc-kiro-adapter.ts", dst: "hooks/aidlc-kiro-adapter.ts" },
    { src: "hooks/aidlc-write-audit-log.json", dst: "hooks/aidlc-write-audit-log.json" },
    { src: "hooks/aidlc-record-human-turn.json", dst: "hooks/aidlc-record-human-turn.json" },
    { src: "hooks/aidlc-terminal-command.json", dst: "hooks/aidlc-terminal-command.json" },
    { src: "hooks/aidlc-terminal-command-guard.json", dst: "hooks/aidlc-terminal-command-guard.json" },
    { src: "hooks/aidlc-enforce-approval-gate.json", dst: "hooks/aidlc-enforce-approval-gate.json" },
    { src: "hooks/aidlc-plan-approval-guard.json", dst: "hooks/aidlc-plan-approval-guard.json" },
    { src: "hooks/aidlc-log-subagent.json", dst: "hooks/aidlc-log-subagent.json" },
    { src: "hooks/aidlc-rebuild-stage-graph.json", dst: "hooks/aidlc-rebuild-stage-graph.json" },
    // No v2 session-end registration: the IDE's Stop trigger fires at the end
    // of every assistant turn (not at conversation close), so a v2 registration
    // would append a spurious SESSION_ENDED between prompts. session-end stays
    // legacy-only (below) until the IDE exposes a genuine session-end event.
    { src: "hooks/aidlc-session-start.json", dst: "hooks/aidlc-session-start.json" },
    { src: "hooks/aidlc-continue-workflow.json", dst: "hooks/aidlc-continue-workflow.json" },
    { src: "hooks/aidlc-sync-workflow-state.json", dst: "hooks/aidlc-sync-workflow-state.json" },
    // Legacy .kiro.hook files (pre-1.0 IDE format): retained for coexistence
    // with IDE builds <1.0. On 1.x+ these are inert (struck-through, never fire);
    // on pre-1.0 they are the only mechanism that executes. Safe to ship both:
    // no double-firing observed on any IDE generation tested.
    { src: "hooks/aidlc-write-audit-log.kiro.hook", dst: "hooks/aidlc-write-audit-log.kiro.hook" },
    { src: "hooks/aidlc-record-human-turn.kiro.hook", dst: "hooks/aidlc-record-human-turn.kiro.hook" },
    { src: "hooks/aidlc-terminal-command.kiro.hook", dst: "hooks/aidlc-terminal-command.kiro.hook" },
    { src: "hooks/aidlc-terminal-command-guard.kiro.hook", dst: "hooks/aidlc-terminal-command-guard.kiro.hook" },
    { src: "hooks/aidlc-enforce-approval-gate.kiro.hook", dst: "hooks/aidlc-enforce-approval-gate.kiro.hook" },
    { src: "hooks/aidlc-plan-approval-guard.kiro.hook", dst: "hooks/aidlc-plan-approval-guard.kiro.hook" },
    { src: "hooks/aidlc-log-subagent.kiro.hook", dst: "hooks/aidlc-log-subagent.kiro.hook" },
    { src: "hooks/aidlc-rebuild-stage-graph.kiro.hook", dst: "hooks/aidlc-rebuild-stage-graph.kiro.hook" },
    { src: "hooks/aidlc-session-end.kiro.hook", dst: "hooks/aidlc-session-end.kiro.hook" },
    { src: "hooks/aidlc-session-start.kiro.hook", dst: "hooks/aidlc-session-start.kiro.hook" },
    { src: "hooks/aidlc-continue-workflow.kiro.hook", dst: "hooks/aidlc-continue-workflow.kiro.hook" },
    { src: "hooks/aidlc-sync-workflow-state.kiro.hook", dst: "hooks/aidlc-sync-workflow-state.kiro.hook" },
    // Project-root .gitignore (beside .kiro/, not inside it) — same workspace-layout
    // committed-vs-ignored split as the Kiro CLI tree: per-user cursors + machine-local
    // runtime ignored, the shared work (memory/codekb/registry/state/audit shards/
    // artifacts) committed. Authored as dot-gitignore so it does not act as a live
    // ignore inside harness/kiro-ide/; projectRoot routes it to dist/kiro-ide/.gitignore
    // + the --check drift guard. (Kiro IDE DOES support a promptSubmit seam (the
    // human-turn mint hook) and a preToolUse seam (the exit-2 human-presence hard
    // block) - both spike-proven on the IDE; the latch lines describe what is wired,
    // not a platform limit.)
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // The IDE resolves delegated capabilities from persona Markdown
  // frontmatter. These grants are autoapprovals: unmatched operations still
  // ask rather than being sandbox-denied. Delegates intentionally receive no
  // subagent tool, so nested delegation remains unavailable.
  frontmatterAdditions: DELEGATION_AGENTS.map((agent) => ({
    file: `agents/${agent}.md`,
    lines: personaFrontmatter(agent),
  })),

  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  rulesRename: "steering",

  emit: null,

  // Folder-drop with a v2 SessionStart registration under .kiro/hooks/. Kiro
  // IDE has no host plugin store, but current IDEs execute this JSON schema.
  plugin: { manifestDir: ".kiro-plugin", kind: "kiro-ide" },
};

export default manifest;
