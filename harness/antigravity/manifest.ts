// harness/antigravity/manifest.ts — the Antigravity distribution row.
//
// Projects the harness-neutral core/ tree into dist/antigravity/.agent/.
// Antigravity (Google's AI development environment — IDE and CLI) natively
// discovers workspace customizations under `.agent/`:
//   - `.agent/skills/<name>/SKILL.md` — Agent Skills (invoked via `/aidlc` etc.)
//   - `.agent/agents/<name>.md`       — Subagents (dispatched via `invoke_subagent`)
//   - `.agent/rules/*.md`             — Standing (`trigger: always_on`) and
//                                       phase (`trigger: model_decision`) rules
//   - `.agent/hooks.json`             — Native lifecycle hooks (`SessionStart`,
//                                       `PreInvocation`, `PreToolUse`,
//                                       `PostToolUse`, `Stop`)
//   - `AGENTS.md`                     — Project-root workspace instructions
import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

// In Antigravity (`agents_parser.go`), a Markdown agent (`agents/<name>.md`)
// that omits `tools:` receives `shared.DefaultTools` (read-only: `read_file`,
// `send_message`, `search_web`, `schedule`), without `write_file`, `edit_file`,
// or `run_command`. Every AI-DLC persona subagent (including the two reviewers,
// which write their review files to `.aidlc-engine/reviews/...`, and ensemble
// collaborators, which write `contributions/<agent>.md`) requires file-write
// and command tools.
const PERSONA_AGENTS = [
  "aidlc-architect-agent",
  "aidlc-developer-agent",
  "aidlc-product-lead-agent",
  "aidlc-architecture-reviewer-agent",
  "aidlc-composer-agent",
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

const PERSONA_PROMPT_LINES = [
  `tools: ["read_file", "write_file", "edit_file", "run_command", "manage_task", "send_message", "search_web"]`,
  "subagent: true",
];

const manifest: HarnessManifest = {
  name: "antigravity",
  productName: "Antigravity",
  configNextStep: "open this project in Antigravity, then run `/aidlc --doctor`",
  harnessDir: ".agent",
  orchestratorSkillPath: ".agent/skills/aidlc/SKILL.md",
  tierFlavor: "antigravity",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      shared: "identical",
    },
  ],

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
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    { src: "skills/aidlc/composer.md", dst: "skills/aidlc/composer.md" },
    { src: "skills/aidlc/tables.md", dst: "skills/aidlc/tables.md" },
    { src: "skills/aidlc-status/SKILL.md", dst: "skills/aidlc-status/SKILL.md" },
    { src: "skills/aidlc-jump/SKILL.md", dst: "skills/aidlc-jump/SKILL.md" },
    { src: "skills/aidlc-scope/SKILL.md", dst: "skills/aidlc-scope/SKILL.md" },
    { src: "rules-aidlc.md", dst: "rules/aidlc.md" },
    { src: "rules-phase-1-ideation.md", dst: "rules/phase-1-ideation.md" },
    { src: "rules-phase-2-inception.md", dst: "rules/phase-2-inception.md" },
    { src: "rules-phase-3-construction.md", dst: "rules/phase-3-construction.md" },
    { src: "rules-phase-4-operation.md", dst: "rules/phase-4-operation.md" },
    { src: "hooks/aidlc-antigravity-adapter.ts", dst: "hooks/aidlc-antigravity-adapter.ts" },
    { src: "hooks.json", dst: "hooks.json" },
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  onboarding: {
    dst: "AGENTS.md",
    projectRoot: true,
    harnessDst: "rules/aidlc-onboarding.md",
    fills: onboardingFills,
  },

  rulesRename: null,

  frontmatterAdditions: PERSONA_AGENTS.map((agent) => ({
    file: `agents/${agent}.md`,
    lines: PERSONA_PROMPT_LINES,
  })),
  pluginAgentFrontmatter: PERSONA_PROMPT_LINES,

  runnerFrontmatterAdditions: ["disable-model-invocation: true"],

  emit: null,

  nativeReplacements: [
    {
      from: "run `bun .agent/tools/aidlc.ts doctor` (after installing Bun from https://bun.sh/install if `bun` is not found),",
      to: "run `aidlc doctor`,",
    },
  ],

  plugin: { manifestDir: ".agent-plugin", kind: "store" },
};

export default manifest;
