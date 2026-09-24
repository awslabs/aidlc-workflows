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

// The 14 delegation targets. Kiro documents that a delegate's capabilities come
// from its own agent config, so each persona carries its grants; the conductor
// (agents/aidlc.md) is authored separately and deliberately carries none of them.
// Measured on Kiro IDE 1.x, a persona's `fs_write` rules applied when it was the
// selected agent and NOT when the conductor delegated to it (a deny over `**`
// let a delegated write through). For delegated work the boundary is therefore
// core/hooks/runtime-integrity.ts, which runs on a delegate's tool calls too.
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
//
// Indented for a `permissions` rule's `match`/`exclude` list, which sits two levels
// deeper than the 2.x `fs_write.allowedPaths` these replaced. Emitted twice per
// reviewing persona - once as the deny's `exclude`, once as the allow's `match` - so the
// two can never drift apart into a deny that outlaws what the allow permits.
// The authority trees every worker persona is denied, less its own write paths. See
// `personaFrontmatter()` for why the deny stops at these instead of covering `**`.
export const PERSONA_WRITE_DENY = [".kiro/**", "aidlc/**", "aidlc/.aidlc-sessions/**"] as const;

function personaWritePaths(agent: string): string[] {
  return agent === "aidlc-composer-agent"
    ? [`        - ".kiro/scopes/**"`, `        - ".kiro/tools/data/scope-grid.json"`]
    : [`        - "aidlc/spaces/**"`];
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

// Persona frontmatter, in the 3.0 `permissions` schema.
//
// 🔴 It used to emit the 2.x `toolsSettings` / `allowedTools` shape, on the premise
// stated here that Kiro treats Markdown frontmatter and a JSON agent config as
// equivalent. That premise is FALSE on the engine this row pins (`chat.agentEngine:
// "v3"`), and the fields were inert. Two measurements, both on IDE 1.x:
//
//   - Kiro's own `/upgrade-agent` does NOT list a Markdown agent carrying
//     `toolsSettings` as out of sync, while the identical content as `.json` IS listed.
//     Markdown agents are treated as already-V3-native and receive no V2-to-V3
//     projection, so the JSON-to-Markdown conversion in this row removed the
//     translation that used to make these fields mean something.
//   - A dispatched persona was PROMPTED for a command its own `deniedCommands`
//     matched. `deny` has no approval path, so an ask where a deny was configured is
//     proof the field was never read.
//
// So the fields are gone rather than kept beside the new ones: shipping a rule that
// looks protective and enforces nothing is worse than shipping no rule, and this row
// spent a review cycle on exactly that.
//
// What each 2.x field became, and why:
//
//   tools: fs_read/fs_write/execute_bash  ->  the 3.0 CATEGORIES read/write/shell.
//     `thinking` and the two MCP servers stay as they are - `thinking` has no 3.0
//     permission equivalent (Kiro's own diagnostics says so and ignores it), and an
//     `@server` entry is a tool name in both schemas.
//   allowedTools: [fs_read, ...]          ->  `capability: fs_read` allow on `**`.
//     That field meant "never prompt for this tool"; in 3.0 that is an allow rule.
//   toolsSettings.execute_bash.allowedCommands -> `capability: shell` allow globs.
//   toolsSettings.execute_bash.deniedCommands  -> `capability: shell` deny globs.
//   fs_write.allowedPaths                 ->  `capability: fs_write` DENY on `**` with
//     the write paths EXCLUDED, plus an allow on those paths for the two personas that
//     had `fs_write` in `allowedTools`. `allowedPaths` did two things at once: it
//     scoped where a write could land AT ALL, and - combined with `allowedTools` -
//     decided whether it prompted. In 3.0 an allow suppresses the prompt but an
//     unmatched path defaults to `ask`, not to refusal, so the scope needs the deny.
//     `exclude` carving an exception out of a deny was measured working on IDE 1.x: a
//     write inside the excluded region landed silently, one outside was refused with
//     the rule quoted, and the file was verified absent afterwards.
//
// No `mcp` rule, deliberately: an MCP call must keep prompting, which t281 pins.
//
// 🔴 The shell allow globs are WIDER than the regex they replace, in the filename
// position only, and that is not a slip. A glob has `*` and nothing else - no character
// class - so it cannot say "not a slash", and `*` was measured crossing a path
// separator without `..` being canonicalized first. The containment that the regex's
// `[A-Za-z0-9._-]+` provided therefore cannot be expressed here at all; it lives in the
// adapter, which compares the filename against the set this build actually shipped and
// refuses anything else. See tests/unit/t218 for that boundary and tests/unit/t252 for
// the composition of the two layers.
//
// The deny globs are likewise an ENUMERATION of spellings where the 2.x regex had a
// character class (`-[A-Za-z]*[rR][A-Za-z]*` matched any flag cluster containing r or
// R). Any enumeration can be spelled around. That is tolerable because deny was never
// the containment: `rm` in any form matches no allow pattern, so it prompts on the
// strength of the allow list alone. Deny only removes the human's ability to approve
// the two operations this framework must never perform unattended.
function personaFrontmatter(agent: string): string[] {
  const writePaths = personaWritePaths(agent);
  return [
    "includeMcpJson: true",
    `tools: ["read", "write", "shell", "thinking", "@context7", "@aws-knowledge-mcp-server"]`,
    "permissions:",
    "  rules:",
    "    - capability: shell",
    "      effect: deny",
    "      match:",
    // Spelled out because a glob cannot carry the 2.x class. Both letter cases of the
    // recursive flag, the two orderings with `-f`, the long form, and each of those
    // reachable through an absolute or relative path prefix.
    `        - "rm -r*"`,
    `        - "rm -R*"`,
    `        - "rm -fr*"`,
    `        - "rm -fR*"`,
    `        - "rm --recursive*"`,
    `        - "*/rm -r*"`,
    `        - "*/rm -R*"`,
    `        - "*/rm -f*"`,
    `        - "*/rm --recursive*"`,
    `        - "git push*"`,
    `        - "git -* push*"`,
    `        - "*/git push*"`,
    `        - "*/git -* push*"`,
    "    - capability: shell",
    "      effect: allow",
    "      match:",
    `{{TOOL_COMMAND_GLOBS}}`,
    // The exact timestamp spellings the protocol instructs, not a tail wildcard: a
    // trailing `*` matched any tail, and this engine generation gates none of the
    // characters a tail can carry. The conductor carries the same four.
    `        - "date -u"`,
    `        - 'date -u +"%Y-%m-%dT%H:%M:%SZ"'`,
    `        - "date -u +'%Y-%m-%dT%H:%M:%SZ'"`,
    `        - "date -u +%Y-%m-%dT%H:%M:%SZ"`,
    // `allowedTools` listed fs_read for every persona: reading never prompted.
    "    - capability: fs_read",
    "      effect: allow",
    "      match:",
    `        - "**"`,
    // The two trees a persona must never write: `.kiro/` holds the tools the conductor
    // pre-approves, the hooks that guard it and these grants themselves, and `aidlc/`
    // outside the record holds the engine's own session state, the delegation ledger and
    // its witness among it. Everything else is deliberately NOT denied: Code Generation's
    // developer, CI Pipeline and the provisioning stages write application source, tests,
    // pipeline and IaC files at the workspace root, and a deny over `**` refused every
    // one of those writes. An unmatched write is not refused: Kiro asks or, under IDE
    // Autopilot, runs it without asking (measured). That is what these personas had
    // before this row, since their 2.x `allowedPaths` was never read on the pinned engine.
    // `aidlc/.aidlc-sessions/**` is spelled out rather than left to `aidlc/**`, so the
    // session state does not depend on how the matcher treats a dot-prefixed segment.
    "    - capability: fs_write",
    "      effect: deny",
    "      match:",
    ...PERSONA_WRITE_DENY.map((glob) => `        - "${glob}"`),
    "      exclude:",
    ...writePaths,
    // The prompt-suppression half, for the two personas that had fs_write in
    // `allowedTools` because they write their verdict into the workflow record.
    ...(FS_WRITE_AUTOAPPROVED.has(agent)
      ? [
        "    - capability: fs_write",
        "      effect: allow",
        "      match:",
        ...writePaths,
      ]
      : []),
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
      shared: "union",
      legacySignatures: {
        wholeFileHashes: [
          "sha256:83449fdda4644b319cbea5dcbde11919722b5dd6761f4edb4caf0e0e53dc9c6b",
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:469dbf89f83865b58b2ae4c51dd2f2fe51fd80a9e2033bfb233688141d0cf632",
          // Retired `kiro-ide` renders. That row shipped the same `.kiro`
          // directory, so an install made by it upgrades into this one and its
          // unmarked root files must be recognized as ours - otherwise they take
          // the ambiguity branch and the refresh exits on integrity.
          "sha256:648f12cb08d05e7bdf97ad4e69e36b7d2b76687d047811d58d196623fd9191bf",
          "sha256:e82d7773f981dabccc1a0a8a31dad4feb26c2af4a65cc7d686bb2a0581ce0ecb",
          "sha256:9dca2d16f38509dacc876574d67391f84476e9eea349c2f5250b0325895ce0b8",
        ],
      },
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      shared: "identical",
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
          // The variant shipped before this branch rewrote the shared onboarding
          // skeleton; an install from that release must still be recognised.
          "sha256:1989d45c43801ae58a6f0c9830d593a8ab17f5ada4cfa2cf03891b307a9d7634",
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:1abeb3cb19943bc1537c413dc45298c43a14ce7544444c88c13b53ea48a607a6",
          "sha256:ecb68f08789258e77c81488e98dd1632b607b567a2424311c4dcdc30ce3e768f",
          // Retired `kiro-ide` renders. That row shipped the same `.kiro`
          // directory, so an install made by it upgrades into this one and its
          // unmarked root files must be recognized as ours - otherwise they take
          // the ambiguity branch and the refresh exits on integrity.
          "sha256:4d539288363565feb6cf1a8d2468d1aca4373d46d354936d89e609f9862b2b9f",
          "sha256:8159f54fcfe2a2ef807227cb12a3c83327e3851672ea47294812dde411f0de69",
          "sha256:8d59f353b5575abe6ee12e8abd5ac75f55461bd7307d677d64388c16690e5afa",
          "sha256:aef608b826a4993d47e3de98679a81abe4823c7c73556def4a339c5cb92999e7",
          "sha256:b58a882d1b56bbb5cdb9a3c356b1428eb8d2593f4a9ca22118b98ca7cd0bae9c",
          "sha256:c5d2188b046cd75d8cb7214f32faa85cbc1539cddda4a0fae9bfe8fad90c237c",
          "sha256:dead4d5ea47849f489e05baeae418d5d26efc6cd14dd2201351a474376f8efde",
          "sha256:990d80744904bfa3f9923b8a04bbb2e69b454154346915edca1e1a4ef7e31c07",
          "sha256:025c596b2f44b688a329d419b5cd39fd2ee2a6d6cae4e6491dc6cd0f663c04ea",
          "sha256:68be79dc053e88931557484ef37b7f63248cddcf02cb44db89c5bd2522980967",
          "sha256:6735312a6ece44f0ba65b949ede2a241669fa422db584dadb2a9ed57e4e43be7",
          "sha256:94f27a88ddba31149876da0609e0eb9a36ce153f52f27898579c846daec2ff59",
          // The retired row's own pre-neutral variant (#1268 made the root block
          // harness-neutral). It shipped from harness/kiro-ide/manifest.ts, which this
          // branch deletes, so the unified row has to keep recognizing it.
          "sha256:5f6f076a5a9d8a11e1078f568c9dee091f399d9999fae89e9dffa62d8697b797",
          // The 2.9.0 shipped variant (#1131 changed the onboarding record-dir shape).
          "sha256:9ad7daa07cbafe9f149311b679281eecd991d2ec77787fc7751226ea0622522b",
          // The pre-neutral shipped variant (#1268 made the root block harness-neutral).
          "sha256:c8777a03505f11dcbb4fb339fef1a8072d9d2500ce401b69a06073b523ea2c67",
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
    { src: "hooks/aidlc-shell-boundary.json", dst: "hooks/aidlc-shell-boundary.json" },
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
    // Carried in from the pre-merge kiro row, where it rode a registration this
    // row does not have. Without this file the adapter's guard-tool-call branch
    // was reachable only by a hand-typed dispatcher call: both of its exit-2
    // branches - the first-`next` argument fidelity check and the same-turn
    // roll-forward backstop - enforced nothing in production while t180 kept
    // asserting them by invoking the target directly.
    { src: "hooks/aidlc-guard-tool-call.json", dst: "hooks/aidlc-guard-tool-call.json" },
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

  // Kiro documents that a delegated persona's capabilities come from that
  // persona's own frontmatter; measured on the IDE, its `fs_write` rules bind it
  // only as the selected agent (see DELEGATION_AGENTS). An unmatched operation is
  // not denied. No persona receives a subagent tool, so nested delegation stays
  // unavailable.
  frontmatterAdditions: DELEGATION_AGENTS.map((agent) => ({
    file: `agents/${agent}.md`,
    lines: personaFrontmatter(agent),
  })),

  // Neutral root guidance is shared; native setup is loaded through agent resources.
  onboarding: { dst: "AGENTS.md", projectRoot: true, harnessDst: "steering/aidlc-onboarding.md", fills: onboardingFills },

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
