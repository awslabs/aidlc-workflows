// harness/kiro-unified/manifest.ts — the Kiro unified-agent-harness row.
//
// One tree for both surfaces that run Kiro's unified agent harness: Kiro IDE
// 1.x and Kiro CLI v3 (`kiro-cli --v3`). Both read the same Markdown agent
// definitions, the same `.kiro/hooks/aidlc-*.json` standalone manifests, and
// the same `permissions:` blocks, so the compatibility layer the kiro-ide row
// carries for the older surfaces has nothing to serve here.
//
// Differences from harness/kiro-ide/ (which stays as it is, for IDE builds
// <1.0 and Kiro CLI 2.x):
//   - No agent-v1 JSON configs. README.md:138 calls those "a Kiro CLI-only
//     compatibility surface"; the unified harness resolves an agent from its
//     .md, so a JSON beside it is dead weight that also splits the roster
//     across two formats.
//   - No legacy .kiro.hook files (the pre-1.0 IDE format). Only the .json
//     manifests ship.
//   - The conductor ships as agents/aidlc.md. It is the entry the workspace
//     agent selector loads on both surfaces; there is no JSON equivalent that
//     either surface reads.
//   - Four more hook registrations than kiro-ide: review-freeze,
//     plan-approval-guard, state-transition-guard and verb-intercept. Their
//     PreToolUse exit-2 hard block is spike-proven on BOTH surfaces here,
//     which is the condition docs/harness-engineering/09-porting-to-a-new-harness.md
//     Step 2 sets for registering them.
//   - settings/mcp.json ships (every server disabled), because both surfaces
//     read the same Kiro MCP registry and the agent .md files opt in per-agent
//     via `includeMcpJson`.
//   - The delegation targets carry `permissions:` and `resources:` in their
//     .md frontmatter (frontmatterAdditions below), not just a `tools:` grant.
//     Both surfaces evaluate those; the kiro-ide row cannot use them because
//     its CLI-facing half reads the JSON sandbox instead.
//
// NOT registered here, deliberately: the per-persona reviewer-scope and
// state-transition-guard hooks that the Kiro CLI agent JSONs carry. Agent-scope
// hooks fire for the ACTIVE agent, not for a DELEGATED one, and these personas
// are only ever reached by delegation — measured inert on CLI 2.18.1 --v3 and
// IDE 1.0.309. Per 09-porting-to-a-new-harness.md:104-107 the gap is documented
// in docs/guide/harnesses/kiro-unified.md rather than wired dead.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

// Frontmatter fragments shared by the delegation targets. Kept as named
// fragments so the per-agent entries below show only what actually varies:
// which files that persona may read, and (composer) what it may write.
const NATIVE_GRANTS = [
  `tools: ["read", "write", "shell", "thinking", "@mcp"]`,
  "includeMcpJson: true",
];

// Every persona reads the cross-agent knowledge and the active space's memory.
const SHARED_RESOURCES = [
  "  - file://.kiro/knowledge/aidlc-shared/*.md",
  "  - file://aidlc/spaces/default/memory/**/*.md",
];

// The engine forwarding loop plus a UTC clock, and a denylist for the
// destructive shell verbs no persona has any reason to reach for. The
// filesystem allow-match is per-agent (the last three lines of each entry).
const PERMISSIONS_HEAD = [
  "permissions:",
  "  rules:",
  "    - capability: shell",
  "      effect: allow",
  "      match:",
  `        - "bun .kiro/tools/aidlc*"`,
  `        - "bun run .kiro/tools/aidlc*"`,
  `        - "date -u *"`,
  "    - capability: shell",
  "      effect: deny",
  "      match:",
  `        - "rm -rf *"`,
  `        - "rm -r *"`,
  `        - "rm -R *"`,
  `        - "rm --recursive *"`,
  `        - "git push *"`,
  "    - capability: filesystem",
  "      effect: allow",
  "      match:",
];

// The workspace tree: where a persona's contribution files and the workflow
// record live. Everything outside it is read-only to a delegate.
const WORKSPACE_WRITE = [`        - "aidlc/spaces/**"`];

const manifest: HarnessManifest = {
  name: "kiro-unified",
  harnessDir: ".kiro",
  tierFlavor: "kiro",

  // Same core projection as the other two Kiro rows.
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
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "steering/aidlc-active-memory.md", dst: "steering/aidlc-active-memory.md" },
    // The conductor. Markdown, because that is the form both surfaces load
    // into the agent selector; loadAgents() skips it (it declares `name` only
    // and is not a stage lead/support agent).
    { src: "agents/aidlc.md", dst: "agents/aidlc.md" },
    { src: "hooks/aidlc-kiro-adapter.ts", dst: "hooks/aidlc-kiro-adapter.ts" },
    // Hook registrations. Both surfaces execute these .json manifests.
    { src: "hooks/aidlc-write-audit-log.json", dst: "hooks/aidlc-write-audit-log.json" },
    { src: "hooks/aidlc-record-human-turn.json", dst: "hooks/aidlc-record-human-turn.json" },
    { src: "hooks/aidlc-enforce-approval-gate.json", dst: "hooks/aidlc-enforce-approval-gate.json" },
    { src: "hooks/aidlc-log-subagent.json", dst: "hooks/aidlc-log-subagent.json" },
    { src: "hooks/aidlc-rebuild-stage-graph.json", dst: "hooks/aidlc-rebuild-stage-graph.json" },
    // No session-end registration: the Stop trigger fires at the end of every
    // assistant turn, not at conversation close, so registering it would
    // append a spurious SESSION_ENDED between prompts (same reason kiro-ide
    // leaves it legacy-only).
    { src: "hooks/aidlc-session-start.json", dst: "hooks/aidlc-session-start.json" },
    { src: "hooks/aidlc-continue-workflow.json", dst: "hooks/aidlc-continue-workflow.json" },
    { src: "hooks/aidlc-sync-workflow-state.json", dst: "hooks/aidlc-sync-workflow-state.json" },
    // The four PreToolUse guards. A non-zero exit blocks the call on both
    // surfaces (spike-proven), which is what Step 2 of the porting guide asks
    // for before a guard may be registered.
    { src: "hooks/aidlc-review-freeze.json", dst: "hooks/aidlc-review-freeze.json" },
    { src: "hooks/aidlc-plan-approval-guard.json", dst: "hooks/aidlc-plan-approval-guard.json" },
    { src: "hooks/aidlc-state-transition-guard.json", dst: "hooks/aidlc-state-transition-guard.json" },
    { src: "hooks/aidlc-verb-intercept.json", dst: "hooks/aidlc-verb-intercept.json" },
    { src: "settings/cli.json", dst: "settings/cli.json" },
    // Every server disabled: the file is the registry an install edits, and
    // the per-agent `includeMcpJson` above is how a persona opts in.
    { src: "settings/mcp.json", dst: "settings/mcp.json" },
    // Project-root .gitignore (beside .kiro/, not inside it) — the same
    // committed-vs-ignored split as the other two Kiro trees. Authored as
    // dot-gitignore so it does not act as a live ignore inside
    // harness/kiro-unified/.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // Harness-native frontmatter for the delegation targets (the agents the
  // conductor dispatches via the `subagent` tool). Both surfaces resolve a
  // delegate's tool grants, its readable resources and its permission rules
  // from the agent .md — there is no agent-v1 JSON in this tree to carry them.
  // Never grant a delegation tool here: delegates must not nest.
  frontmatterAdditions: [
    {
      file: "agents/aidlc-product-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-product-agent.md",
        "  - file://.kiro/knowledge/aidlc-product-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-design-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-design-agent.md",
        "  - file://.kiro/knowledge/aidlc-design-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-delivery-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-delivery-agent.md",
        "  - file://.kiro/knowledge/aidlc-delivery-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-architect-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-architect-agent.md",
        "  - file://.kiro/knowledge/aidlc-architect-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-aws-platform-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-aws-platform-agent.md",
        "  - file://.kiro/knowledge/aidlc-aws-platform-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-compliance-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-compliance-agent.md",
        "  - file://.kiro/knowledge/aidlc-compliance-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-devsecops-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-devsecops-agent.md",
        "  - file://.kiro/knowledge/aidlc-devsecops-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-developer-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-developer-agent.md",
        "  - file://.kiro/knowledge/aidlc-developer-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-quality-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-quality-agent.md",
        "  - file://.kiro/knowledge/aidlc-quality-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-pipeline-deploy-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-pipeline-deploy-agent.md",
        "  - file://.kiro/knowledge/aidlc-pipeline-deploy-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    {
      file: "agents/aidlc-operations-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-operations-agent.md",
        "  - file://.kiro/knowledge/aidlc-operations-agent/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        ...WORKSPACE_WRITE,
      ],
    },
    // The two review-only agents read the artifact under review from the
    // workspace tree, not a knowledge folder of their own.
    {
      file: "agents/aidlc-product-lead-agent.md",
      lines: [...NATIVE_GRANTS, "resources:", ...SHARED_RESOURCES, ...PERMISSIONS_HEAD, ...WORKSPACE_WRITE],
    },
    {
      file: "agents/aidlc-architecture-reviewer-agent.md",
      lines: [...NATIVE_GRANTS, "resources:", ...SHARED_RESOURCES, ...PERMISSIONS_HEAD, ...WORKSPACE_WRITE],
    },
    // The composer reads the scope catalogue and writes the composed scope, so
    // its filesystem grant is the scope assets rather than the workspace tree.
    {
      file: "agents/aidlc-composer-agent.md",
      lines: [
        ...NATIVE_GRANTS,
        "resources:",
        "  - file://.kiro/agents/aidlc-composer-agent.md",
        "  - file://.kiro/scopes/*.md",
        ...SHARED_RESOURCES,
        ...PERMISSIONS_HEAD,
        `        - ".kiro/scopes/**"`,
        `        - ".kiro/tools/data/scope-grid.json"`,
      ],
    },
  ],

  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  rulesRename: "steering",

  emit: null,

  // Folder-drop, no host store, like the other two .kiro trees — but the
  // compose trigger ships as a standalone `.json` hook manifest, not the legacy
  // `.kiro.hook` this shell deliberately excludes and the unified runtime
  // ignores. See docs/reference/kiro-ide-hook-payload.md.
  plugin: { manifestDir: ".kiro-plugin", kind: "kiro-unified" },
};

export default manifest;
