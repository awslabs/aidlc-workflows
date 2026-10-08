// harness/kiro-ide/manifest.ts — the Kiro distribution row for Kiro's unified
// agent harness, which Kiro IDE 1.x and Kiro CLI v3 both run and both read
// from the same .kiro/ tree.
//
//   - Agents ship as Markdown only. The conductor is an authored aidlc.md;
//     persona files come from core and receive native tools/permissions.
//   - settings/cli.json pins Kiro CLI to the v3 engine and to the aidlc agent.
//     The default v2 engine runs no .kiro/hooks at all, and a hook cannot
//     detect that from inside, so the pin is the only guard. Kiro IDE does not
//     read this file.
//   - Always-included steering carries the active-space memory text, written
//     by the engine (core/tools/aidlc-includes.ts kiroIdeSteering) and
//     gitignored; the shipped file is its reference form.
//   - Hooks ship as v1 .kiro/hooks/*.json only; both surfaces register them at
//     session start. IDE 0.x .kiro.hook files are not shipped: IDE 1.x never
//     executes them.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import {
  copyChannelDelegateShellDeny,
  nativeDelegateShellDeny,
  RISKY_SHELL_FORMS,
  riskyFormDenyLines,
  shellDenyLines,
} from "./delegate-shell-deny.ts";
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

// The composer's one file: the grid it writes before each validate-grid run
// (the proposalPath detect --json prints). It writes no scope and not the
// scope grid; saving a scope is the engine's `scope save`.
const composerProposalPath = "aidlc/spaces/*/intents/.aidlc-engine/composer-proposal.json";
const spacePaths = ["aidlc/spaces/**"];

const quoted = (paths: readonly string[]) =>
  paths.map((path) => `        - "${path}"`);

// Each persona's shell deny admits what the guard admits that persona, and
// refuses a risky shell form on any AI-DLC command.
const copyShellDeny = new Map<string, string[]>(
  DELEGATION_AGENTS.map((agent) => [agent, [
    ...shellDenyLines(copyChannelDelegateShellDeny(".kiro", agent)),
    ...riskyFormDenyLines(["bun .kiro/tools/aidlc"]),
  ]]),
);

// Shell forms that can run, expand, or redirect more than the one command a
// rule names. Kiro judges each part of a chain or substitution on its own
// (delegate-shell-deny.ts), but a variable, a redirect, or a PowerShell array
// or hashtable stays inside its part; the rest are listed too, so the rule
// does not rest on how a Kiro build splits a command. A bare PowerShell
// grouping is the terminal guard's (aidlcCodeArgumentHazard in the Kiro IDE
// adapter).
// Ask beats every allow, so a command holding one asks the person whatever it
// starts with. The conductor (agents/aidlc.md) carries the same list; t148
// checks every agent.
const SHELL_FORM_ASKS = RISKY_SHELL_FORMS.map((form) => `*${form}*`);

// A persona's own tools and permissions are enforced only when the conductor
// dispatches through invoke_sub_agent (IDE) or orchestrate_subagent (CLI); the
// conductor's tools list selects those (agents/aidlc.md). On that path its
// shell allow is not applied, the conductor's is (delegate-shell-deny.ts); the
// allow still serves a persona the person selects directly. tools is enforced on
// every dispatch path; it names no MCP server, so a persona reaches none (an
// @mcp wildcard would expose every user- and workspace-level server).
function personaFrontmatter(agent: string): string[] {
  const writePaths = agent === "aidlc-composer-agent" ? [composerProposalPath] : spacePaths;
  // Engine-owned trees are never a persona's to write; a deny beats every allow.
  return [
    `tools: ["read", "write", "shell"]`,
    "permissions:",
    "  rules:",
    "    - capability: shell",
    "      effect: allow",
    "      match:",
    `        - "bun .kiro/tools/aidlc-*"`,
    // Every engine command goes through the dispatcher, which the hyphen
    // pattern above does not reach. Its engine namespace only: the public
    // verbs that change the machine's install keep asking, as on native.
    `        - "bun .kiro/tools/aidlc.ts engine *"`,
    // A read-only version check the personas run before a project's tests;
    // the tests themselves keep asking.
    `        - "bun --version"`,
    // The conductor's asks: changing a setting and running a hook adapter
    // stay the person's to approve, whichever agent runs them.
    "    - capability: shell",
    "      effect: ask",
    "      match:",
    `        - "bun .kiro/tools/aidlc.ts engine config set *"`,
    `        - "bun .kiro/tools/aidlc.ts engine adapter *"`,
    ...quoted(SHELL_FORM_ASKS),
    ...(copyShellDeny.get(agent) ?? []),
    "    - capability: fs_read",
    "      effect: allow",
    "      match:",
    `        - "**"`,
    "    - capability: filesystem",
    "      effect: allow",
    "      match:",
    ...quoted(writePaths),
    "    - capability: fs_write",
    "      effect: deny",
    "      match:",
    `        - ".kiro/**"`,
    `        - "aidlc/.aidlc-sessions/**"`,
    // The person's words kept for a stage gate's Request Changes.
    `        - "aidlc/spaces/*/intents/*/.aidlc-engine/gate-words/**"`,
  ];
}

// The one Kiro IDE step for AI-DLC that is not running in this window, word
// for word wherever it appears (doctor, the refusals, the missed-reply line).
const KIRO_IDE_TRUST_STEP =
  "In Kiro IDE, trust this folder: choose Trust Folder & Continue when Kiro asks whether you " +
  "trust it, or select Manage on the Restricted Mode banner, then Trust. Then run Developer: " +
  "Reload Window from the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS), and say " +
  "carry on.";

// The same step outside Kiro IDE, for Kiro CLI and an ACP client on this tree.
const KIRO_CLI_ACP_STEP =
  "In Kiro CLI, quit Kiro and start `kiro-cli` again in this folder. If you drive Kiro from an ACP client, " +
  "the Kiro IDE guide names what that client must send.";

// The words the agent relays when the person's answer was not recorded.
const ANSWER_NOT_RECORDED = "Your answer was not recorded, so you don't need to answer again.";

const manifest: HarnessManifest = {
  name: "kiro-ide",
  productName: "Kiro IDE",
  configNextStep: "open this project in Kiro IDE; if the Restricted Mode banner shows at the top of the window and you know what is in this folder, select Manage on it, then Trust; run `Developer: Reload Window` from the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS), choose the aidlc agent in the chat panel's agent picker, then run `/aidlc --doctor` (in Kiro CLI, start `kiro-cli` in the project instead and run `/aidlc --doctor`)",
  // Kiro IDE runs a folder's hooks and loads its aidlc agent only after the
  // folder is trusted and the window reloads; until then the first approval
  // gate cannot see the human's reply, so those steps come before the first
  // prompt. An untrusted folder opens in Restricted Mode: its banner offers
  // Manage, which opens the Workspace Trust page with the Trust button. Trust
  // lets the folder's hooks run commands, so it is offered for a known folder.
  firstRunSteps: [
    "1. Open this folder in Kiro IDE. If the Restricted Mode banner shows at the",
    "   top of the window and you know what is in this folder, select Manage on",
    "   it, then Trust.",
    '2. Run "Developer: Reload Window" from the Command Palette',
    "   (Ctrl+Shift+P, or Cmd+Shift+P on macOS) so Kiro loads the AIDLC hooks",
    "   and the aidlc agent.",
    "3. Choose the aidlc agent in the chat panel's agent picker.",
    '4. /aidlc "what you want built"  describe your first intent',
    "",
    "Using Kiro CLI instead? Start `kiro-cli` in this folder, then step 4.",
  ],
  // Kiro IDE has no CLI of its own to probe. Its integrated terminal sets
  // TERM_PROGRAM=kiro (captured from Kiro IDE 1.1.14 on Windows), and its git
  // askpass helper (VSCODE_GIT_ASKPASS_NODE) is the Kiro executable. A miss
  // only loses the default choice. KIRO_* variables are not a signal: that
  // terminal sets none, and Kiro CLI users set them in any shell.
  editorTerminalApp: "kiro",
  // Measured live: the only cause seen of Kiro IDE running no hooks is a
  // folder it has not been allowed to run commands in. Then every agent
  // command comes back with no output and exit code -1, so no AI-DLC message
  // can run; the agent's step sits in what it reads first (its orchestrator
  // skill). Trust takes effect only after a window reload: a trusted folder ran
  // no hook until Developer: Reload Window (measured 2026-10-05 on Kiro IDE
  // 1.1.14 from the Restricted Mode banner, and on 1.2.4 from both the banner
  // and Trust Folder & Continue), so every copy of the step names both.
  // Another agent in the picker did not stop the hooks. What an ACP client
  // must send to run hooks is in the Kiro IDE guide. The approval refusal
  // (hooks/aidlc-kiro-adapter.ts) gives a Kiro IDE person the text before
  // " In Kiro CLI," alone, so that sentence keeps its place and spelling.
  hookActivation: {
    recovery: `${KIRO_IDE_TRUST_STEP} ${KIRO_CLI_ACP_STEP}`,
    // Says what happened, asks for nothing again, and gives the person the step
    // for the tool they are in, in fixed words the agent relays without
    // explaining why. Inside Kiro IDE (VSCODE_IPC_HOOK or VSCODE_PID set, the
    // adapter's own signal) that is the Kiro IDE step alone; elsewhere Kiro
    // CLI and an ACP client, which nothing tells apart, each get their line.
    missedReply:
      "If the person already replied, that reply was not recorded. Do not ask them to answer again. " +
      "Tell them exactly this, with nothing about why, then only the line below for the tool they are in: " +
      `"${ANSWER_NOT_RECORDED}" ${KIRO_CLI_ACP_STEP}`,
    missedReplyInHost: {
      env: ["VSCODE_IPC_HOOK", "VSCODE_PID"],
      text:
        "If the person already replied, that reply was not recorded. Do not ask them to answer again. " +
        `Tell them exactly this, with nothing about why: "${ANSWER_NOT_RECORDED} ${KIRO_IDE_TRUST_STEP}"`,
    },
    // hooks/aidlc-kiro-adapter.ts leaves a heartbeat on every chat message
    // before the first workflow, so doctor warns only while none exists.
    notRunYet:
      "This is expected before your first chat message here. If you already sent one, trust this " +
      "folder in Kiro IDE: choose Trust Folder & Continue when Kiro asks whether you trust it, or " +
      "select Manage on the Restricted Mode banner, then Trust. Then run Developer: Reload Window " +
      "from the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS), send a message and run " +
      "doctor again. In Kiro CLI, quit Kiro and start `kiro-cli` again in this folder.",
  },
  harnessDir: ".kiro",
  orchestratorSkillPath: ".kiro/skills/aidlc/SKILL.md",
  tierFlavor: "kiro",
  kiroLayout: "kas",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
      legacySignatures: {
        wholeFileHashes: [
          "sha256:648f12cb08d05e7bdf97ad4e69e36b7d2b76687d047811d58d196623fd9191bf",
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:e82d7773f981dabccc1a0a8a31dad4feb26c2af4a65cc7d686bb2a0581ce0ecb",
          // The variant shipped before the block listed aidlc.settings.local.json.
          "sha256:9dca2d16f38509dacc876574d67391f84476e9eea349c2f5250b0325895ce0b8",
          // The variant shipped with a generic template above the AI-DLC lines.
          "sha256:e0829e668399a331c6fda7c267e3983b56ee23029ce8d5520394e3e70cf7d21d",
          // The variant shipped with notes above each group of lines.
          "sha256:88d6960720e5cd14f848a5e93ba9a503322518fe180c4bf55bcc3a6b8c151394",
          // The variant shipped before AI-DLC wrote the memory text into the steering file.
          "sha256:28a69800dcac189aa2a976820db237b45bcf6dd7d7e6d4fae5c1603225b9957a",
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
          "sha256:4d539288363565feb6cf1a8d2468d1aca4373d46d354936d89e609f9862b2b9f",
          "sha256:8159f54fcfe2a2ef807227cb12a3c83327e3851672ea47294812dde411f0de69",
          "sha256:8d59f353b5575abe6ee12e8abd5ac75f55461bd7307d677d64388c16690e5afa",
          "sha256:aef608b826a4993d47e3de98679a81abe4823c7c73556def4a339c5cb92999e7",
          "sha256:b58a882d1b56bbb5cdb9a3c356b1428eb8d2593f4a9ca22118b98ca7cd0bae9c",
          "sha256:c5d2188b046cd75d8cb7214f32faa85cbc1539cddda4a0fae9bfe8fad90c237c",
          "sha256:dead4d5ea47849f489e05baeae418d5d26efc6cd14dd2201351a474376f8efde",
          "sha256:e01ac1caf52a59d25faf859a03cfb65b803853c99298bbcbc80ef565e7628de6",
          // The pre-v2-sync shipped variant (2.6.123 merge changed the bytes).
          "sha256:990d80744904bfa3f9923b8a04bbb2e69b454154346915edca1e1a4ef7e31c07",
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:025c596b2f44b688a329d419b5cd39fd2ee2a6d6cae4e6491dc6cd0f663c04ea",
          "sha256:68be79dc053e88931557484ef37b7f63248cddcf02cb44db89c5bd2522980967",
          "sha256:6735312a6ece44f0ba65b949ede2a241669fa422db584dadb2a9ed57e4e43be7",
          // The 2.9.0 shipped variant (#1131 changed the onboarding record-dir shape).
          "sha256:94f27a88ddba31149876da0609e0eb9a36ce153f52f27898579c846daec2ff59",
          // The pre-neutral shipped variant (#1268 made the root block harness-neutral).
          "sha256:5f6f076a5a9d8a11e1078f568c9dee091f399d9999fae89e9dffa62d8697b797",
          // The variant shipped before the onboarding waited for the person to invoke AI-DLC.
          "sha256:6de1298dfa4c2b6916f66d372b844faf23481c8f258eedd595c1423dab8e106d",
        ],
      },
    },
  ],
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

  // Authored surfaces. Persona Markdown files are core projections.
  harnessFiles: [
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "skills/aidlc/composer.md", dst: "skills/aidlc/composer.md" },
    // The reference form; the packager writes the shipped memory's text over
    // it, as the engine does with the project's own memory for every chat.
    { src: "steering/aidlc-active-memory.md", dst: "steering/aidlc-active-memory.md" },
    { src: "agents/aidlc.md", dst: "agents/aidlc.md" },
    { src: "settings/cli.json", dst: "settings/cli.json" },
    { src: "hooks/aidlc-kiro-adapter.ts", dst: "hooks/aidlc-kiro-adapter.ts" },
    { src: "hooks/aidlc-kiro-tool-names.ts", dst: "hooks/aidlc-kiro-tool-names.ts" },
    // Kiro IDE shows a card for every hook run, so one registration runs the two
    // hooks for each message and another the five tool-call checks (#2022). What
    // ran after a write or a command is done by the next card (catch-up).
    { src: "hooks/aidlc-record-human-turn.json", dst: "hooks/aidlc-record-human-turn.json" },
    { src: "hooks/aidlc-guard-tool-call.json", dst: "hooks/aidlc-guard-tool-call.json" },
    { src: "hooks/aidlc-log-subagent.json", dst: "hooks/aidlc-log-subagent.json" },
    // No session-end registration: Kiro's Stop trigger fires at the end of every
    // assistant turn (not at conversation close) on both surfaces, so a
    // registration would append a spurious SESSION_ENDED between prompts.
    // session-end stays unregistered until Kiro exposes a genuine session-end
    // event.
    { src: "hooks/aidlc-session-start.json", dst: "hooks/aidlc-session-start.json" },
    { src: "hooks/aidlc-continue-workflow.json", dst: "hooks/aidlc-continue-workflow.json" },
    // Project-root .gitignore (beside .kiro/, not inside it) — same workspace-layout
    // committed-vs-ignored split as the Kiro CLI tree: per-user cursors + machine-local
    // runtime ignored, the shared work (memory/codekb/registry/state/audit shards/
    // artifacts) committed. Authored as dot-gitignore so it does not act as a live
    // ignore inside harness/kiro-ide/; projectRoot routes it to dist/kiro-ide/.gitignore
    // + the --check determinism guard. (Kiro IDE DOES support a promptSubmit seam (the
    // human-turn mint hook) and a preToolUse seam (the exit-2 human-presence hard
    // block) - both spike-proven on the IDE; the latch lines describe what is wired,
    // not a platform limit.)
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // Delegated capabilities come from persona Markdown frontmatter. tools binds
  // on every dispatch path; permissions bind only on the invoke_sub_agent /
  // orchestrate_subagent path the conductor selects (the shell allow aside,
  // see delegate-shell-deny.ts). The allows are autoapprovals: unmatched operations
  // still ask rather than being denied.
  // Delegates intentionally receive no subagent tool, so nested delegation
  // remains unavailable.
  frontmatterAdditions: DELEGATION_AGENTS.map((agent) => ({
    file: `agents/${agent}.md`,
    lines: personaFrontmatter(agent),
  })),
  // The native release keys the persona shell deny on the `aidlc engine`
  // routes its conductor allow covers (delegate-shell-deny.ts), one rule per
  // distinct persona deny.
  nativeReplacements: [...new Map([...copyShellDeny].map(([agent, lines]) => [lines.join("\n"), agent])).entries()]
    .map(([from, agent]) => ({
      from,
      to: [
        ...shellDenyLines(nativeDelegateShellDeny(agent)),
        ...riskyFormDenyLines(["aidlc"]),
      ].join("\n"),
    })),

  onboarding: { dst: "AGENTS.md", projectRoot: true, harnessDst: "steering/aidlc-onboarding.md", fills: onboardingFills },

  rulesRename: "steering",

  emit: null,

  // Folder-drop with a v2 SessionStart registration under .kiro/hooks/. Kiro
  // has no host plugin store, but Kiro IDE 1.x and Kiro CLI v3 both execute
  // this JSON schema.
  plugin: { manifestDir: ".kiro-plugin", kind: "kiro-ide" },
};

export default manifest;
