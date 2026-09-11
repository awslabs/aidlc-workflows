// harness/kiro/manifest.ts — the Kiro distribution row.
//
// One row for the unified agent harness: the same `.kiro/` shell serves Kiro IDE
// 1.x and Kiro CLI, because both run the same agent runtime. Projects the
// harness-neutral core/ tree into dist/kiro/.kiro/, plus Kiro's authored shell
// surfaces (orchestrator skill, agent configs, the stdin adapter hook,
// settings/cli.json, AGENTS.md).
//
// Kiro specifics vs Claude:
//   - token → .kiro
//   - rules/ → steering/ (Kiro auto-loads steering; rules ARE the always-on
//     layer)
//   - the orchestrator skill is per-harness (authored here, NOT core), so it
//     is NOT in coreDirs — only the 3 session skills are.
//   - agents/ is MIXED: the persona .md files are core (copied + rules rename
//     n/a), the conductor agents/aidlc.md is authored (harnessFiles).
//   - hooks/ is MIXED: core hook bodies are copied; the one authored
//     aidlc-kiro-adapter.ts stdin shim is a harnessFile.
//   - AGENTS.md lands at the PROJECT ROOT (dist/kiro/AGENTS.md), outside .kiro/.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import { TRUSTED_COMMAND_PREFIX } from "../../core/tools/aidlc-command.ts";
import onboardingFills from "./onboarding.fills.ts";

// The 14 delegation targets. Kiro resolves a delegate's capabilities from its
// own agent config, so each persona carries its grants; the conductor
// (agents/aidlc.md) is authored separately and deliberately carries none of them.
const DELEGATION_AGENTS = [
  "aidlc-architect-agent",
  "aidlc-architecture-reviewer-agent",
  "aidlc-aws-platform-agent",
  "aidlc-compliance-agent",
  "aidlc-composer-agent",
  "aidlc-delivery-agent",
  "aidlc-design-agent",
  "aidlc-developer-agent",
  "aidlc-devsecops-agent",
  "aidlc-operations-agent",
  "aidlc-pipeline-deploy-agent",
  "aidlc-product-agent",
  "aidlc-product-lead-agent",
  "aidlc-quality-agent",
] as const;

// The two reviewing personas write their verdict into the workflow record, so
// they pre-approve fs_write; the rest ask for it.
const FS_WRITE_AUTOAPPROVED = new Set([
  "aidlc-architecture-reviewer-agent",
  "aidlc-product-lead-agent",
]);

// The composer owns the scope grid rather than a space, so its write scope is
// the scope tree instead of aidlc/spaces/**.
function personaWritePaths(agent: string): string[] {
  return agent === "aidlc-composer-agent"
    ? [`      - '.kiro/scopes/**'`, `      - '.kiro/tools/data/scope-grid.json'`]
    : [`      - 'aidlc/spaces/**'`];
}

// A reviewing persona reads the record it judges and nothing agent-specific; the
// others preload their own brief and knowledge shard.
function personaResources(agent: string): string[] {
  const shared = [
    `  - 'file://.kiro/knowledge/aidlc-shared/*.md'`,
    `  - 'file://aidlc/spaces/default/memory/**/*.md'`,
  ];
  if (FS_WRITE_AUTOAPPROVED.has(agent)) return shared;
  return [
    `  - 'file://.kiro/agents/${agent}.md'`,
    agent === "aidlc-composer-agent"
      ? `  - 'file://.kiro/scopes/*.md'`
      : `  - 'file://.kiro/knowledge/${agent}/*.md'`,
    ...shared,
  ];
}

// Persona frontmatter. Kiro treats Markdown frontmatter and a JSON agent config
// as equivalent, so this is the same grant model the row shipped as agent JSON
// before the two Kiro rows merged — minus the per-persona hook registrations,
// which the workspace hooks plus the delegation ledger now supply.
//
// `allowedCommands`/`deniedCommands` are Rust `regex` patterns anchored
// full-string by Kiro; `deniedCommands` is evaluated first and beats any allow.
// The allowlist is deliberately project-relative: a grant for any
// `/…/.kiro/tools/*.ts` would pre-approve running a file from a world-writable
// directory. See tests/unit/t252 for the behavioural contract.
function personaFrontmatter(agent: string): string[] {
  return [
    "includeMcpJson: true",
    "tools:",
    "  - fs_read",
    "  - fs_write",
    "  - execute_bash",
    "  - thinking",
    "  - '@context7'",
    "  - '@aws-knowledge-mcp-server'",
    "allowedTools:",
    "  - fs_read",
    ...(FS_WRITE_AUTOAPPROVED.has(agent) ? ["  - fs_write"] : []),
    "  - thinking",
    "toolsSettings:",
    "  execute_bash:",
    "    allowedCommands:",
    `      - 'bun (run )?["'']?\\.kiro/tools/[A-Za-z0-9._-]+\\.ts["'']?( .*)?'`,
    `      - 'date -u( .*)?'`,
    "    deniedCommands:",
    `      - '([^\\s]*/)?rm( [^\\s]+)* -[A-Za-z]*[rR][A-Za-z]*( .*)?'`,
    `      - '([^\\s]*/)?rm( [^\\s]+)* --recursive( .*)?'`,
    `      - '([^\\s]*/)?git( -[^\\s]+( ("[^"]*"|''[^'']*''|[^\\s]+))?)* push( .*)?'`,
    "  fs_write:",
    "    allowedPaths:",
    ...personaWritePaths(agent),
    "resources:",
    ...personaResources(agent),
  ];
}

const manifest: HarnessManifest = {
  name: "kiro",
  productName: "Kiro",
  configNextStep:
    "open this project in Kiro IDE, or run `kiro-cli` in it, then run `/aidlc --doctor`",
  harnessDir: ".kiro",
  orchestratorSkillPath: ".kiro/skills/aidlc/SKILL.md",
  tierFlavor: "kiro",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      legacySignatures: {
        wholeFileHashes: [
          "sha256:83449fdda4644b319cbea5dcbde11919722b5dd6761f4edb4caf0e0e53dc9c6b",
        ],
      },
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      legacySignatures: {
        wholeFileHashes: [
          "sha256:4f7133cc1a9bb1243245c25c28fad57c3660b35e251ea36cea3aa2db431bf55f",
          "sha256:992307cc3fac05d81958851b2ca51db3723fea604c8d2636814ef9b2e9f7a848",
          "sha256:b886d5b375f9ebc33ef206c4f6ad20630a13eb83d0f5838e9f71f483c040f362",
          "sha256:c6796d512752c8f4aa927c9de3fb794e3432f62dd85b77fe3da1101d90aa5a0b",
          "sha256:cd7c66ba1bdd67af0be6203a1d8928efc01733ef196201003e914051d1309a28",
          "sha256:e01ac1caf52a59d25faf859a03cfb65b803853c99298bbcbc80ef565e7628de6",
          "sha256:e3de4a295f9b9404b40678c28c0773ae432ac8d4aeacc07613ecfcdfbb4c866b",
          "sha256:e85a5d7ce13b676282dc99572f89c81256f2dada50b1881f4c9641e61339f5a4",
          // The pre-v2-sync shipped variant (2.6.123 merge changed the bytes).
          "sha256:67a57eddd94d613590d34ec2d0181398123d9e2d9f6382eb36c62233ce02b6f9",
          // The variant shipped while this row's onboarding text still called
          // itself the Kiro CLI harness and described an agent-v1 conductor. An
          // upgrade must recognize it as ours and replace it, not treat it as
          // user-owned content.
          "sha256:3aea80a2afde8bb2a222b329bcfc2855b4207a53f7fbfbc3abbfb4aadbafc53b",
          "sha256:8f3b3bbadb9047992b4e5c402e47f75388cbfad6e4d9c1d73397beb626a697e9",
        ],
      },
    },
  ],

  // The IDE surface needs its hook and tool invocations pre-trusted, or an
  // untrusted project command silently never runs. Native-channel only: the Bun
  // copy channel invokes through `bun .kiro/...`, which the IDE already allows.
  // Carried over from the folded row - one row serves both surfaces, so the
  // integration follows the surface that needs it rather than the row name.
  nativeRootIntegrations: [
    {
      content: `${JSON.stringify({
        "kiroAgent.trustedCommands": [`${TRUSTED_COMMAND_PREFIX} *`],
      }, null, 2)}\n`,
      path: ".vscode/settings.json",
      policy: "json-array",
      jsonKey: "kiroAgent.trustedCommands",
    },
  ],

  // Same core projection as claude, EXCEPT: rules→steering, and the
  // orchestrator skill (skills/aidlc/) is authored, not core.
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

  // Authored Kiro shell surfaces. These carry literal `.kiro` (harness-specific
  // by construction); they are .md/.json/.ts copied verbatim (the .md token
  // substitution is a no-op on them — no {{HARNESS_DIR}} token present).
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "steering/aidlc-active-memory.md", dst: "steering/aidlc-active-memory.md" },
    // One conductor agent in Markdown. The v2 engine's agent-v1 JSON configs are
    // gone with the row merge: hook wiring lives in the standalone manifests below,
    // so a JSON twin would only restate the persona and drift from it.
    { src: "agents/aidlc.md", dst: "agents/aidlc.md" },
    { src: "hooks/aidlc-kiro-adapter.ts", dst: "hooks/aidlc-kiro-adapter.ts" },
    // Standalone hook manifests - the registration channel both supported
    // surfaces read.
    { src: "hooks/aidlc-write-audit-log.json", dst: "hooks/aidlc-write-audit-log.json" },
    { src: "hooks/aidlc-record-human-turn.json", dst: "hooks/aidlc-record-human-turn.json" },
    { src: "hooks/aidlc-terminal-command.json", dst: "hooks/aidlc-terminal-command.json" },
    { src: "hooks/aidlc-terminal-command-guard.json", dst: "hooks/aidlc-terminal-command-guard.json" },
    { src: "hooks/aidlc-enforce-approval-gate.json", dst: "hooks/aidlc-enforce-approval-gate.json" },
    { src: "hooks/aidlc-plan-approval-guard.json", dst: "hooks/aidlc-plan-approval-guard.json" },
    { src: "hooks/aidlc-log-subagent.json", dst: "hooks/aidlc-log-subagent.json" },
    { src: "hooks/aidlc-rebuild-stage-graph.json", dst: "hooks/aidlc-rebuild-stage-graph.json" },
    { src: "hooks/aidlc-session-start.json", dst: "hooks/aidlc-session-start.json" },
    { src: "hooks/aidlc-continue-workflow.json", dst: "hooks/aidlc-continue-workflow.json" },
    { src: "hooks/aidlc-sync-workflow-state.json", dst: "hooks/aidlc-sync-workflow-state.json" },
    // Blocking guards. PreToolUse is the only trigger that can refuse these
    // tool calls; the PostToolUse audit hook sees the same tools and cannot.
    { src: "hooks/aidlc-review-freeze.json", dst: "hooks/aidlc-review-freeze.json" },
    { src: "hooks/aidlc-state-transition-guard.json", dst: "hooks/aidlc-state-transition-guard.json" },
    { src: "hooks/aidlc-reviewer-scope.json", dst: "hooks/aidlc-reviewer-scope.json" },
    // The ONE legacy `.kiro.hook` that still ships. It fires only on an
    // unsupported Kiro IDE 0.x host - that generation is the only one that reads
    // this manifest format - and its sole job is to say so and stop the turn.
    { src: "hooks/aidlc-legacy-ide-notice.kiro.hook", dst: "hooks/aidlc-legacy-ide-notice.kiro.hook" },
    { src: "settings/cli.json", dst: "settings/cli.json" },
    { src: "settings/mcp.json", dst: "settings/mcp.json" },
    // Authored as dot-gitignore so it does not act as a live ignore inside
    // harness/, and lands at the project root.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // Kiro resolves a delegated persona's capabilities from that persona's own
  // frontmatter. These grants are autoapprovals: an unmatched operation still
  // asks rather than being denied. No persona receives a subagent tool, so
  // nested delegation stays unavailable.
  frontmatterAdditions: DELEGATION_AGENTS.map((agent) => ({
    file: `agents/${agent}.md`,
    lines: personaFrontmatter(agent),
  })),

  // AGENTS.md renders from the shared skeleton with Kiro's fills, at the project
  // root (outside .kiro/). The {{HARNESS_DIR}} → .kiro substitution + rules/ →
  // steering/ rename run on it like any core .md. Replaces the hand-forked
  // harness/kiro/AGENTS.md (which had drifted to "two harnesses" + missing the
  // Documentation/Automated-Testing sections the skeleton now supplies for free).
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // rules/ → steering/ (applied after the token substitution, anchored).
  rulesRename: "steering",

  // Kiro ships no per-shell emissions — all its surfaces are authored files.
  emit: null,

  // Kiro has no host plugin store — AIDLC plugins arrive by folder-drop and use
  // the explicit composer. Hook wiring is the standalone manifests projected
  // above; both supported surfaces read them.
  plugin: { manifestDir: ".kiro-plugin", kind: "kiro" },
};

export default manifest;
