// harness/kiro-ide/manifest.ts — the Kiro IDE distribution row.
//
// Kiro IDE 1.0 native format. Descends from the Kiro CLI harness (harness/kiro/)
// but drops the CLI surfaces the IDE does not read and adds the IDE-native ones:
//
//   - Agents ship as .md ONLY (the IDE resolves agents from Markdown frontmatter,
//     not the CLI's agent-v1 JSON). The 15 agent JSONs the CLI tree ships are
//     omitted here, along with settings/cli.json (CLI-only activation).
//   - The conductor ships as an authored agents/aidlc.md so it appears in the
//     IDE agent selector (the CLI's aidlc.json is not read by the IDE).
//   - Each delegation-target agent .md gets a `tools:` grant AND a
//     `permissions.rules` block (IDE 1.0's capability model), and drops the
//     CLI-only `disallowedTools` field (frontmatterAdditions + frontmatterRemovals).
//   - Hooks register via v2 JSON manifests (aidlc-*.json, "version":"v1") for
//     IDE >=1.0.1xx, plus legacy .kiro.hook files for pre-1.0 coexistence (no
//     double-firing on any generation tested). Unchanged by this row.
//
// The hook adapter and TS hook bodies stay byte-shared with every other harness.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

// The 14 delegation-target personas. All but the composer get the same lean
// grant (shell for the engine CLIs + write into their space); the composer
// additionally reaches the scope grid it authors. Declared once and expanded
// into frontmatterAdditions so the roster is a single list, not 14 stanzas.
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

// The filesystem allow-list differs for the composer (it writes the scope grid,
// not artifacts under a space). Everyone else writes into the active space.
// frontmatterAdditions are injected AFTER the {{HARNESS_DIR}} token transform,
// so the harness dir is written literally here (this row is .kiro-only).
const composerPaths = [`        - ".kiro/scopes/**"`, `        - ".kiro/tools/data/scope-grid.json"`];
const spacePaths = [`        - "aidlc/spaces/**"`];

// tools: grant + permissions.rules block, appended to each persona .md during
// projection. The IDE 1.0 permission model is capability/effect/match; the
// grant is the IDE analogue of the CLI JSON's allowedTools + toolsSettings.
//
// SCOPE of the shell rule. The CLI JSON grants the regex `bun \.kiro/tools/.*`;
// the IDE matches GLOBS, so the equivalent is `bun .kiro/tools/aidlc-*`. The
// prefix is deliberately as narrow as the engine's real surface: every command a
// conductor or delegate issues is `bun .kiro/tools/aidlc-<tool>.ts <verb>` (the
// eight referenced by the conductor prose today: orchestrate, state, log,
// utility, learnings, graph, swarm, worktree). A bare `bun *` would additionally
// pre-approve `bun -e <arbitrary code>` and any workspace script — which can
// write outside the filesystem paths granted below — so it is not the faithful
// translation of the CLI grant.
//
// These rules are AUTOAPPROVALS, not a sandbox: Kiro defaults an unmatched
// operation to `ask`, not `deny`. So the lists decide what proceeds without a
// consent prompt; they do not bound where a delegate can ultimately write.
function personaFrontmatter(agent: string): string[] {
  const fsPaths = agent === "aidlc-composer-agent" ? composerPaths : spacePaths;
  return [
    `tools: ["read", "write", "shell"]`,
    `permissions:`,
    `  rules:`,
    `    - capability: shell`,
    `      effect: allow`,
    `      match:`,
    `        - "bun .kiro/tools/aidlc-*"`,
    `        - "date -u *"`,
    `    - capability: filesystem`,
    `      effect: allow`,
    `      match:`,
    ...fsPaths,
  ];
}

const manifest: HarnessManifest = {
  name: "kiro-ide",
  harnessDir: ".kiro",
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
  ],

  // Authored surfaces: the orchestrator skill, the conductor aidlc.md (IDE
  // selector entry — the CLI's aidlc.json is not read by the IDE), the shared
  // hook adapter, and the hook manifests. NO agent-v1 JSONs and NO
  // settings/cli.json — those are CLI-only surfaces the IDE does not read.
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "agents/aidlc.md", dst: "agents/aidlc.md" },
    { src: "hooks/aidlc-kiro-adapter.ts", dst: "hooks/aidlc-kiro-adapter.ts" },
    { src: "hooks/aidlc-audit-logger.json", dst: "hooks/aidlc-audit-logger.json" },
    { src: "hooks/aidlc-mint.json", dst: "hooks/aidlc-mint.json" },
    { src: "hooks/aidlc-block.json", dst: "hooks/aidlc-block.json" },
    { src: "hooks/aidlc-log-subagent.json", dst: "hooks/aidlc-log-subagent.json" },
    { src: "hooks/aidlc-runtime-compile.json", dst: "hooks/aidlc-runtime-compile.json" },
    // No v2 session-end registration: the IDE's Stop trigger fires at the end
    // of every assistant turn (not at conversation close), so a v2 registration
    // would append a spurious SESSION_ENDED between prompts. session-end stays
    // legacy-only (below) until the IDE exposes a genuine session-end event.
    { src: "hooks/aidlc-session-start.json", dst: "hooks/aidlc-session-start.json" },
    { src: "hooks/aidlc-stop.json", dst: "hooks/aidlc-stop.json" },
    { src: "hooks/aidlc-sync-statusline.json", dst: "hooks/aidlc-sync-statusline.json" },
    // Legacy .kiro.hook files (pre-1.0 IDE format): retained for coexistence
    // with IDE builds <1.0. On 1.x+ these are inert (struck-through, never fire);
    // on pre-1.0 they are the only mechanism that executes. Safe to ship both:
    // no double-firing observed on any IDE generation tested.
    { src: "hooks/aidlc-audit-logger.kiro.hook", dst: "hooks/aidlc-audit-logger.kiro.hook" },
    { src: "hooks/aidlc-mint.kiro.hook", dst: "hooks/aidlc-mint.kiro.hook" },
    { src: "hooks/aidlc-block.kiro.hook", dst: "hooks/aidlc-block.kiro.hook" },
    { src: "hooks/aidlc-log-subagent.kiro.hook", dst: "hooks/aidlc-log-subagent.kiro.hook" },
    { src: "hooks/aidlc-runtime-compile.kiro.hook", dst: "hooks/aidlc-runtime-compile.kiro.hook" },
    { src: "hooks/aidlc-session-end.kiro.hook", dst: "hooks/aidlc-session-end.kiro.hook" },
    { src: "hooks/aidlc-session-start.kiro.hook", dst: "hooks/aidlc-session-start.kiro.hook" },
    { src: "hooks/aidlc-stop.kiro.hook", dst: "hooks/aidlc-stop.kiro.hook" },
    { src: "hooks/aidlc-sync-statusline.kiro.hook", dst: "hooks/aidlc-sync-statusline.kiro.hook" },
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

  // IDE-native frontmatter for the delegation targets (the agents the conductor
  // dispatches via the `subagent` tool). The IDE reads a delegate's tool grant
  // and permission rules from its .md frontmatter, not the CLI's agent-v1 JSON.
  // `tools:` names the capability categories; `permissions.rules` is the IDE 1.0
  // capability/effect/match model (the analogue of the CLI JSON's allowedTools +
  // toolsSettings autoapproval lists — see personaFrontmatter on why these grant
  // consent-free operations rather than bound them). Reviewers get "write" too
  // (they append a `## Review` section to the primary artifact); the ensemble
  // collaborators get write to author their own contribution files.
  // Never grant a delegation tool here —
  // delegates must not nest.
  frontmatterAdditions: DELEGATION_AGENTS.map((agent) => ({
    file: `agents/${agent}.md`,
    lines: personaFrontmatter(agent),
  })),

  // Drop the CLI-only `disallowedTools` field from each persona .md: the IDE
  // expresses the no-nesting bound through the omitted `subagent` category in
  // `tools:` above, not a disallowedTools list (a Claude Code / CLI field the
  // IDE ignores). Removing it keeps the IDE frontmatter free of dead keys.
  frontmatterRemovals: DELEGATION_AGENTS.map((agent) => ({
    file: `agents/${agent}.md`,
    keys: ["disallowedTools"],
  })),

  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  rulesRename: "steering",

  emit: null,

  // Folder-drop + .kiro.hook, same as Kiro CLI (both .kiro trees). No host store.
  plugin: { manifestDir: ".kiro-plugin", kind: "kiro" },
};

export default manifest;
