// harness/antigravity/onboarding.fills.ts — Google Antigravity onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/antigravity/AGENTS.md (project root). {{HARNESS_DIR}} → .aidlc is applied
// by the packager transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Google Antigravity harness** (supporting Antigravity CLI \`agy\` and Antigravity IDE). The engine runtime lives in \`.aidlc/\` with workspace customizations surfaced via \`.agents/\`. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume. Run \`/aidlc compose "<task>"\` to get a plan tailored to that task.`,

    prereq_bullets: `- **Google Antigravity (IDE or \`agy\` CLI)**: workspace skills in \`.agents/skills/\`, rules in \`.agents/rules/\`, and hooks in \`.agents/hooks.json\` are active automatically.
- **bun**: Required for executing the TypeScript CLI tools and hook scripts. Install via \`curl -fsSL https://bun.sh/install | bash\` (or \`powershell -c "irm bun.sh/install.ps1 | iex"\` on Windows). \`bun\` must be available on your PATH.
- **Model**: agents inherit the active session model across subagent swarms and delegations.`,

    prereq_bullets_tail: "",

    agents_note: `On Antigravity, expert personas are defined as workspace agents and subagent templates under \`.agents/\` and \`.aidlc/agents/\`. The conductor coordinates with subagent swarms and delegative tools throughout the lifecycle.`,

    structure_extra: "",

    guide_pointer: `The Antigravity-specific guide is in \`docs/guide/harnesses/antigravity.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Google Antigravity. On Antigravity:

- **Workspace customizations**: Skills live in \`.agents/skills/\`, rules in \`.agents/rules/\`, and hooks in \`.agents/hooks.json\`.
- **Approval gates**: Questions render as structured numbered prose options, allowing direct selection and natural interaction.
- **Hook integration**: The adapter (\`.aidlc/hooks/aidlc-antigravity-adapter.ts\`) maps Antigravity tool and lifecycle events to the core engine verification, sensor, and state transitions.
- **Swarm and worktrees**: Worktree tasks and subagent swarms dispatch with isolated intent and state tracking.
`,

    sections_after_resumption: `## Method include (do not remove)

These references pull the active space's method layers into ambient context:

@aidlc/spaces/default/memory/org.md
@aidlc/spaces/default/memory/team.md
@aidlc/spaces/default/memory/project.md
@aidlc/spaces/default/memory/phases/ideation.md
@aidlc/spaces/default/memory/phases/inception.md
@aidlc/spaces/default/memory/phases/construction.md
@aidlc/spaces/default/memory/phases/operation.md
`,

    gitignore_extra: "",
  },
};

export default fills;
