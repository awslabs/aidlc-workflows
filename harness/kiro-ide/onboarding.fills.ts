// harness/kiro-ide/onboarding.fills.ts — Kiro IDE's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/kiro-ide/AGENTS.md (project root). {{HARNESS_DIR}} → .kiro and the
// rules/ → steering/ rename are applied by the packager transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Kiro IDE harness**. The workspace shell ships in \`.kiro/\` (no setup command); the engine auto-births the first intent when you describe what to build. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume. Run \`/aidlc compose "<task>"\` to have the adaptive composer propose a tailored EXECUTE/SKIP plan (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Kiro IDE**: Sign in and select Claude Opus 4.8 as the chat model before starting a workflow.
- **bun**: Required for the CLI tools and hook scripts (state management, audit logging, orchestration engine). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns — these source \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash), NOT \`~/.zshrc\`.
- **Activation**: Open the project in Kiro IDE and invoke \`/aidlc\`; the command loads the shipped \`skills/aidlc/SKILL.md\` conductor. The \`.kiro/hooks/*.kiro.hook\` files register in the IDE's Agent Hooks panel.
- **Permissions**: delegation-target agent \`.md\` files receive the IDE-native read/write/shell grants they need. The conductor's approval gates and your IDE permission settings remain the control boundary.`,

    prereq_bullets_tail: "",

    agents_note: `On Kiro IDE the \`/aidlc\` command loads \`skills/aidlc/SKILL.md\` as the conductor. The full 14-persona roster supplies workers for the four dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests through Markdown personas with IDE-native tool grants; the shipped agent-v1 JSON files and \`settings/cli.json\` are CLI-only compatibility surfaces and do not select an IDE default agent.`,

    structure_extra: "",

    guide_pointer: `The Kiro IDE-specific guide (install, hook wiring, and harness differences) is \`docs/guide/harnesses/kiro-ide.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness — one deterministic engine, state machine, audit trail, and stage set, rendered onto Kiro IDE. On Kiro IDE:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- \`SESSION_STARTED\` and \`SESSION_ENDED\` are emitted; Kiro IDE has no pre-compaction event, so \`SESSION_COMPACTED\` is not emitted.
- **MCP servers**: none ship, and the Kiro MCP config mechanism is not configured here (the Claude distribution ships five; Kiro ships zero today).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and Kiro IDE installs (supported but untested — keep both \`.claude/\` and \`.kiro/\` in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
