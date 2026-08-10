// harness/cursor/onboarding.fills.ts — Cursor's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/cursor/AGENTS.md (project root — Cursor auto-reads it as plain ambient
// instructions; no @-import expansion, live-verified). {{HARNESS_DIR}} →
// .cursor is applied by the packager transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Cursor harness** (the Cursor IDE and the Cursor CLI \`agent\` share this install). The workspace shell ships in \`.cursor/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Cursor-native shortcuts expose \`/aidlc-status\`, \`/aidlc-jump --stage <slug>\` (or \`--phase <name>\`), and \`/aidlc-scope <name>\` through the same workflow. Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Cursor**: the IDE, or the Cursor CLI (\`curl https://cursor.com/install -fsS | bash\`; invoked as \`agent\`). Both read this install's \`.cursor/\` surfaces (rules, skills, agents, hooks). Verified against cursor-agent 2026.07 — hooks (\`.cursor/hooks.json\`) and skills (\`.cursor/skills/\`) are current-line features.
- **A paid Cursor plan for named models**: Free accounts can only use \`Auto\`; the tiered persona surfaces ship with no model pins so every agent inherits your session model, but headless CLI runs that pass \`--model\` need a plan that allows it.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the shells Cursor spawns.
- **Permissions**: the shipped \`.cursor/cli.json\` pre-approves \`Shell(bun)\` so the forwarding loop's engine calls do not prompt; every other shell command follows your Cursor approval settings. In headless \`agent -p\` runs, pass \`--force\` only if you accept auto-approval of the remaining prompts. Gated workflows need an interactive session regardless: Cursor fires the human-presence hook (\`beforeSubmitPrompt\`) only on an interactive submission, so a print-mode run records no human turn and an approval gate refuses by design. Headless mode suits the read-only utilities (\`--status\`, \`--doctor\`, \`--version\`) and autonomous Construction.`,

    prereq_bullets_tail: "",

    agents_note: `On Cursor each expert role is a native subagent (discovered from the persona files in \`.cursor/agents/\`); the \`/aidlc\` session takes on those roles itself for most stages and hands work off via the \`task\` tool for the two delegated stages (2.1, 3.5). They ship without \`model:\` pins — every agent inherits your session model (model availability is plan-dependent on Cursor).`,

    structure_extra: "",

    guide_pointer: `The Cursor-specific guide (install, what differs, verification) is \`docs/guide/harnesses/cursor.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Cursor. On Cursor:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- Hooks ride \`.cursor/hooks.json\` through the AIDLC adapter (\`.cursor/hooks/aidlc-cursor-adapter.ts\`): state-transition, reviewer read-scope, review-freeze, and plan-approval guards block via Cursor's \`permission: deny\` channel before tools; audit and sensors cover write and edit; stage-graph rebuilds, human-turn recording, and pre-compaction state validation run from the matching Cursor moments.
- The forwarding-loop enforcement (the Stop hook) is **advisory**: Cursor's stop hook cannot refuse a stop, so a pending directive surfaces as a follow-up nudge instead of a block.
- The AI-DLC method (\`aidlc/spaces/<space>/memory/*.md\`) reaches context through read instructions because Cursor rules do not expand \`@\`-imports: \`.cursor/rules/aidlc.mdc\` always points to org/team/project, while four agent-decided \`.cursor/rules/aidlc-phase-*.mdc\` files point to phase guidance only when relevant. The sessionStart hook separately injects live workflow state; \`/aidlc space <name>\` re-points all five rules in place.
- Subagent identity on hook payloads is **reconstructed by the adapter** (Cursor emits no per-subagent identity): reviewer read-scope enforcement keys on the Task-spawn ledger the adapter maintains.
- There is **no statusline** and **no welcome message**; use \`/aidlc-status\` (or \`/aidlc --status\`) and the progress lines at gates.
- Construction swarm runs as **task-tool fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- **Tab autocomplete** is untouched by this install — it rides Cursor's own models regardless of configuration.
- **MCP servers**: none ship (configure your own in \`.cursor/mcp.json\` if needed).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between harness installs (supported but untested — keep the trees in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
