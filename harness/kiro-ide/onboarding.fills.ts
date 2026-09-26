// harness/kiro-ide/onboarding.fills.ts — onboarding-doc fills for the Kiro row
// that serves both Kiro IDE 1.x and Kiro CLI v3.
// The packager fills core/templates/onboarding-harness.md into the always-on
// dist/kiro-ide/.kiro/steering/aidlc-onboarding.md, with .kiro token projection.
// The root AGENTS.md stays neutral, identical to the other sharing harnesses.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    frontmatter: "---\ninclusion: always\n---",
    title_block: `# AI-DLC on Kiro

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on **Kiro** — Kiro IDE and Kiro CLI read the same \`.kiro/\` tree. The workspace shell ships in \`.kiro/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Kiro IDE or Kiro CLI**: Sign in and select Claude Opus 4.8 as the chat model before starting a workflow (the model picker in Kiro IDE, \`/model\` in Kiro CLI).
- **Kiro CLI engine**: \`.kiro/settings/cli.json\` pins Kiro CLI to its v3 engine and the \`aidlc\` agent. Kiro CLI's older v2 engine runs none of the \`.kiro/hooks/\` registrations, so do not override the engine for this project.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns — these source \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash), NOT \`~/.zshrc\`.
- **Activation**: Open the project in Kiro IDE, or start \`kiro-cli\` in it, and invoke \`/aidlc\`; the command loads the shipped \`skills/aidlc/SKILL.md\`, which drives the workflow. The \`.kiro/hooks/aidlc-*.json\` hook files register when a session starts, on both surfaces.
- **Permissions**: the conductor and delegation-target agent \`.md\` files carry \`tools:\` grants and \`permissions.rules\` capability rules. The conductor delegates through the dispatch tool that runs each specialist under its own rules (\`invoke_sub_agent\` in Kiro IDE, \`orchestrate_subagent\` in Kiro CLI). The approval gates plus your Kiro permission settings remain the control boundary.`,

    prereq_bullets_tail: "",

    agents_note: `On Kiro the \`/aidlc\` command loads \`skills/aidlc/SKILL.md\` as the conductor, and \`agents/aidlc.md\` exposes that conductor in the agent selector (and is Kiro CLI's default agent). The full 14-role roster supplies the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests through Markdown personas with \`tools:\` grants and \`permissions.rules\`. This distribution ships no agent-v1 JSON files.`,

    structure_extra: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Kiro. On Kiro IDE and Kiro CLI:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- \`SESSION_STARTED\` is emitted when a new session takes its first prompt (via the \`SessionStart\` hook); resuming an existing session does not emit it. \`SESSION_ENDED\` is NOT emitted (Kiro's \`Stop\` trigger is turn-scoped, not session-scoped, so there is no safe registration for it). Kiro has no pre-compaction event, so \`SESSION_COMPACTED\` is not emitted.
- **MCP servers**: none ship, and the Kiro MCP config mechanism is not configured here (the Claude distribution ships five; Kiro ships zero today).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and Kiro installs (supported but untested — keep both \`.claude/\` and \`.kiro/\` in sync via the framework's packaging if you do this).

The guide for this Kiro distribution (install, hook wiring, and harness differences) is \`docs/guide/harnesses/kiro-ide.md\`.
`,

    sections_after_resumption: "",
  },
};

export default fills;
