// harness/kiro-ide/onboarding.fills.ts — Kiro IDE's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/kiro-ide/AGENTS.md (project root). {{HARNESS_DIR}} → .kiro and the
// rules/ → steering/ rename are applied by the packager transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Kiro IDE harness**. The workspace shell ships in \`.kiro/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Kiro IDE**: Sign in and select Claude Opus 4.8 as the chat model before starting a workflow.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns — these source \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash), NOT \`~/.zshrc\`.
- **Activation**: Open the project in Kiro IDE and invoke \`/aidlc\`; the command loads the shipped \`skills/aidlc/SKILL.md\`, which drives the workflow. The \`.kiro/hooks/aidlc-*.json\` v2 hook files register in the IDE's Agent Hooks panel.
- **Permissions**: the conductor and delegation-target agent \`.md\` files carry IDE-native \`tools:\` grants and \`permissions.rules\` capability rules. The approval gates plus your IDE permission settings remain the control boundary.`,

    prereq_bullets_tail: "",

    agents_note: `On Kiro IDE the \`/aidlc\` command loads \`skills/aidlc/SKILL.md\` as the conductor, and \`agents/aidlc.md\` exposes that conductor in the IDE agent selector. The full 14-role roster supplies the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests through Markdown personas with IDE-native \`tools:\` grants and \`permissions.rules\`. The IDE distribution ships no agent-v1 JSON files or \`settings/cli.json\`; those are Kiro CLI surfaces.`,

    structure_extra: "",

    guide_pointer: `The Kiro IDE-specific guide (install, hook wiring, and harness differences) is \`docs/guide/harnesses/kiro-ide.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Kiro IDE. On Kiro IDE:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- \`SESSION_STARTED\` is emitted on IDE 1.x (via the \`SessionStart\` v2 hook); \`SESSION_ENDED\` is NOT emitted on 1.x (the IDE's \`Stop\` trigger is turn-scoped, not session-scoped, so there is no safe registration for it). Kiro IDE has no pre-compaction event, so \`SESSION_COMPACTED\` is not emitted.
- **MCP servers**: none ship, and the Kiro MCP config mechanism is not configured here (the Claude distribution ships five; Kiro ships zero today).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and Kiro IDE installs (supported but untested — keep both \`.claude/\` and \`.kiro/\` in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
