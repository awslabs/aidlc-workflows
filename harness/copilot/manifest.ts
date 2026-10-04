// harness/copilot/manifest.ts — the GitHub Copilot distribution row.
//
// ONE dist serves BOTH Copilot surfaces — Copilot CLI (1.0.74+) and VS Code
// agent mode (1.130+) — because GitHub converged them on the same project
// discovery paths: .github/skills/, .github/agents/, .github/hooks/, and the
// root AGENTS.md are read identically by both (compat spike, 10 live CLI
// probes + IDE parser extraction in the compatibility-spike evidence). Splitting
// cli/ide harnesses would ship two dists competing for the
// same .github file paths; the divergences are authoring rules instead:
//   - hooks registered under PascalCase event names → BOTH surfaces deliver
//     Claude-shaped snake_case payloads (one adapter path);
//   - agent `tools:` uses the UNION vocabulary (each surface silently ignores
//     the other's names — live-verified, no fallback-to-all);
//   - agents carry NO `model:` field (the CLI forwards IDE display names
//     verbatim to the BYOK provider → live-verified 400; tierFlavor copilot
//     is model-omitted by type).
//
// Copilot specifics vs Claude:
//   - token → .aidlc, NOT .copilot or .github. Project-level .copilot/ is not
//     a documented discovery root (only ~/.copilot has COPILOT_HOME
//     semantics), and .github/ is SHARED with real repo content (workflows,
//     templates) — the engine tree cannot own it. The engine ships at
//     .aidlc/ — a dir neither Copilot surface scans (the opencode precedent)
//     — and emit.ts writes only aidlc-named files into .github/.
//   - .github/ carries ONLY natively-consumed emissions (emit.ts): the hook
//     wiring (.github/hooks/aidlc.json → the adapter in .aidlc/hooks/), the
//     14 persona agents (.github/agents/aidlc-*-agent.md), and the full
//     skills tree (.github/skills/: orchestrator + generated runners +
//     session skills — Copilot discovers project skills there, so the
//     standard <harnessDir>/skills/ runner-gen step is skipped).
//   - Copilot auto-reads the project-root AGENTS.md (both surfaces).
//   - An .aidlc runtime dir is ALSO what the opencode harness ships; an
//     install is disambiguated by its wiring files (.github/hooks/aidlc.json
//     + .aidlc/hooks/aidlc-copilot-adapter.ts here vs .opencode/plugin/
//     there) — the doctor probes exactly that.

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";
import emit from "./emit.ts";

const manifest: HarnessManifest = {
  name: "copilot",
  productName: "GitHub Copilot",
  configNextStep: "start Copilot CLI or VS Code agent mode, then run `/aidlc --doctor`",
  // VS Code runs repo hooks only in a trusted workspace with Chat: Use Hooks
  // on, which an organization policy can switch off, and skips them without a
  // word in the chat; the CLI runs them only in a folder it trusts. The adapter
  // leaves a heartbeat at a chat's SessionStart before the first workflow, and
  // the PreToolUse guards leave one in the record before each engine command
  // the agent runs, so a working install never sees notRunYet after a chat or
  // the agent step at all. Measured live: the agent's own edit of the folder
  // setting works for the person's next message in the same chat, with no
  // reload; an untrusted folder needs no line, since VS Code asks on the first
  // message. The agent step reads any "fix it" as this setting, because a
  // person asked "can you fix it?" near the old notice and the agent changed
  // their project instead.
  hookActivation: {
    recovery:
      'In VS Code, turn on Chat: Use Hooks for this folder ("chat.useHooks": true in ' +
      ".vscode/settings.json), then send your next message in the same chat. If your " +
      "organization has switched it off, ask your administrator to turn it on. In the Copilot " +
      "CLI, start it again in this folder and trust the folder when it asks. Headless " +
      "`copilot -p` runs need GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=1.",
    notRunYet:
      "This is expected before your first Copilot chat in this folder. If you already started " +
      'one, turn on Chat: Use Hooks in VS Code for this folder ("chat.useHooks": true in ' +
      ".vscode/settings.json; if your organization has switched it off, ask your administrator " +
      "to turn it on), or in the Copilot CLI trust this folder when it asks, then send a " +
      "message and run doctor again.",
    notRunInWorkflow:
      "Turn on Chat: Use Hooks in VS Code for this folder (in the Copilot CLI, trust this folder " +
      "when it asks), then carry on.",
    agentStep:
      "Copilot is not running AI-DLC's hooks in this folder. In VS Code: open " +
      "`.vscode/settings.json` by its path (VS Code's file search skips it, so do not search), " +
      'set `"chat.useHooks": true`, keep every other key as it is, and create the file if it ' +
      'does not exist. Then show the person this line: "Fixed. Send your next message here to ' +
      'carry on." If a question was waiting for their answer, show this line instead, then that ' +
      'question: "Fixed. Answer the question below to carry on." If the file already said ' +
      '`true`, show this line instead: "Your organization has switched off Chat: Use Hooks in ' +
      'VS Code. Ask your administrator to turn it on." In the Copilot CLI, change no file and ' +
      'show this line instead: "Quit Copilot, start it again in this folder and trust the folder ' +
      'when it asks, then type <entry> to carry on." In a headless `copilot -p` run, show this ' +
      'line instead: "Set GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=1 for headless copilot -p runs, ' +
      'then run it again." Until the person has done their step, do not touch the project\'s ' +
      'files or the workflow, and read any "fix it" as this setting. End your turn right after ' +
      "the line: your own next command in this turn would still run without the change.",
  },
  harnessDir: ".aidlc",
  orchestratorSkillPath: ".github/skills/aidlc/SKILL.md",
  tierFlavor: "copilot",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
      legacySignatures: {
        wholeFileHashes: [
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:f52e6097d36c2e5bc199a2529469a4c6e7c507f7960f94a0b2b46f9aeee60e56",
          // The variant shipped before the block listed aidlc.settings.local.json.
          "sha256:1a25bf94915b9f1c67136cfb36f5c82c03c6f6540deddd2af9e760e0f93069df",
          // The variant shipped with a generic template above the AI-DLC lines.
          "sha256:a739ce7cf309c603b4c962313a53cb2a238888b73c204a86f928cd61dcb3e548",
          // The variant shipped with notes above each group of lines.
          "sha256:d23129d2d4de49fdd943b9966c2995cc5064b365a2741c8b4a8f50c0facf2c1a",
        ],
      },
    },
    {
      // VS Code pauses agent mode after `chat.agent.maxRequests` requests in
      // one turn (default 50) to ask "Continue to iterate?", and the chat sits
      // silent until someone answers; one Construction stage passes that
      // (#1411). VS Code runs repo hooks only with `chat.useHooks` on, and a
      // folder's value beats a user setting that is off (measured live). Config
      // adds each when the project does not set it, and never changes a value
      // the team set, other keys, or comments. Optional: the
      // copy runtime leaves the file out (copyChannelOmits), since copying it
      // would replace the team's own.
      path: ".vscode/settings.json",
      policy: "jsonc-settings",
      optional: true,
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      legacySignatures: {
        wholeFileHashes: [
          // Keep pre-engine-directory unmarked root files recognizable.
          "sha256:9550b31b8f3f32992c1ae1035bfa57a782f04821530214a2f2e1fd1690e209ab",
          "sha256:1b8b3b4b10de3307a927429a676f5dd7440099a6d18859f603328b5ed239e6c7",
          // The 2.9.0 shipped variant (#1131 changed the onboarding record-dir shape).
          "sha256:bf3077a6520e2735f618bad386858afc57edceaa791d98de7a6c269d71861e56",
          // The pre-neutral shipped variant (#1268 made the root block harness-neutral).
          "sha256:55b31ba55f6e7ebc47fe76a00039e2ec16e020503fb63791cbd8665438ff32ac",
          // The pre-Guards shipped variant (the onboarding gained its Guards section).
          "sha256:7a3a19981ba7a3c447b54eb0d0b1e96f8c9931687595967103cb5dfbb3c2b309",
          // The pre-skill-prefix shipped variant (#1341: user-typed skill
          // names rendered the shell invocation instead of the skill command).
          "sha256:622ebad60ee4fed6a2a9811e7378ccbff6b76d651aaee00fd079b02471d8cf06",
          // The pre-plan-offer shipped variant (its onboarding said the init
          // runner always creates the first record in one step).
          "sha256:a25a15052889fe6b5900f0fef5262cc50cb00bb436e52f1eb1abe62db35b2f50",
          // The variant whose folder-trust bullet said both Copilot surfaces
          // read trustedFolders (VS Code never does).
          "sha256:2f43e54233a3feefa17e8dd3c6fd65f0ef50268d7fe46b3adb93c1d6bcf15a89",
          // The variant shipped before runners became typed-only (it had no
          // line on reading a runner typed in a headless run).
          "sha256:1095316799b8630bcb498539cb82b9b0907fa7aa69cdfb3ee6a9b489c8ed42e3",
          // The variant shipped before the onboarding named the command for a
          // model or effort request.
          "sha256:d35dbc2ff6a2cad09144e8a625144bfbce4c0e91212a2da39d45da11198474f4",
          // The pre-person-drives shipped variant (its Guards section named a
          // command for the person to type; now the agent runs the setter).
          "sha256:33c0f4b7fc213c3bddcc81d33de244e07a05659d1fc8ac474da63f4b4d19b2d6",
        ],
      },
    },
  ],

  // Same core projection as claude, into .aidlc/. The runtime files ARE
  // core (the conductor adopts them inline from .aidlc/agents/); the
  // Copilot-native agent copies in .github/agents/ are emitted.
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
    // NO skills/ inside the engine dir: Copilot discovers project skills at
    // .github/skills/ only, so emit composes the whole skill set there
    // (orchestrator + runners + session skills) from core — the codex idiom.
  ],

  harnessFiles: [
    // The hook adapter, beside the core hook bodies it pipes into.
    { src: "hooks/aidlc-copilot-adapter.ts", dst: "hooks/aidlc-copilot-adapter.ts" },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
    // The VS Code settings AI-DLC adds when absent (the jsonc-settings integration).
    { src: "dot-vscode-settings.json", dst: ".vscode/settings.json", projectRoot: true },
  ],

  // AGENTS.md at the project root — both Copilot surfaces auto-read it.
  onboarding: { dst: "AGENTS.md", projectRoot: true, fills: onboardingFills },

  // .aidlc/ is AIDLC's own dir; core's rules/ name has nothing to collide with.
  rulesRename: null,

  // Runners are typed-only on both surfaces: a typed `/aidlc-<runner>` still
  // runs, the agent never starts one itself, and their descriptions stay out of
  // Copilot's skill list. A headless `copilot -p` run hands the typed line to
  // the agent as text, so the root AGENTS.md tells it to read the runner file.
  runnerFrontmatterAdditions: ["disable-model-invocation: true"],

  // VS Code's run_in_terminal tool keeps a result whole only up to 20,000
  // characters (MAX_OUTPUT_LENGTH in microsoft/vscode src/vs/workbench/contrib/
  // terminalContrib/chatAgentTools/browser/outputHelpers.ts). A longer one is
  // saved to a file and the chat and the PostToolUse hook get a 500-character
  // preview and the tail, so the adapter cannot read the directive (#1411).
  // 19,000 bytes are never more than 19,000 characters, which leaves room for
  // the newline and anything the terminal adds.
  directiveMaxBytes: 19000,

  // Copilot discovers project skills at .github/skills/ (and .agents/skills/,
  // .claude/skills/) — never inside .aidlc/. emit.ts composes the full skill
  // tree there from runner-gen's render fns; graph compile still runs.
  skipRunnerGen: true,

  emit,

  // Copilot recognizes .plugin/plugin.json as a native plugin manifest.
  // The harnessDir-derived ".aidlc-plugin" default is not a discovery path.
  plugin: { manifestDir: ".plugin", kind: "store" },
};

export default manifest;
