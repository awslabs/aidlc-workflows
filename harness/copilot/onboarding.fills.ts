// harness/copilot/onboarding.fills.ts — GitHub Copilot's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts (invoked
// from the packager) into dist/copilot/AGENTS.md (project root). The packager's
// transform() applies the {{HARNESS_DIR}} → .github substitution itself, so this
// file authors the Copilot-specific header + Prerequisites as prose and leaves
// {{HARNESS_DIR}} tokens for the packager (rulesRename is null on this harness).
//
// Copilot auto-reads AGENTS.md at the project root, giving the agent always-on
// context — same pattern every other harness follows. Authored here directly
// (never derived from Claude's CLAUDE.md) so no Claude-specific prose can leak
// through.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# AI-DLC on GitHub Copilot

This project uses AI-DLC (AI-Driven Development Life Cycle) under the GitHub
Copilot harness (VS Code agent mode). Invoke the orchestrator skill with the
\`/aidlc\` slash command in Copilot chat, followed by a scope or project
description. The deterministic engine, state machine, audit log, and referee are
byte-identical to every other harness distribution; only the shell differs. Run
\`/aidlc --status\` for progress, \`/aidlc --help\` for usage, \`/aidlc intent\`
to list intents, \`/aidlc --doctor\` to validate setup, and
\`/aidlc --stage <slug>\` / \`--phase <name>\` / \`--depth <level>\` /
\`--test-strategy <level>\` for the usual overrides. Run \`/aidlc compose
"<task>"\` to have the adaptive composer propose a tailored EXECUTE/SKIP plan
(up front, from a scan report via \`--report <path>\`, or mid-workflow to
re-shape the pending stages - every proposal stops at an approve/edit/reject
gate).`,

    prereq_bullets: `- **VS Code ≥ 1.102 with GitHub Copilot agent mode**: the harness ships as \`.github/agents/\`, \`.github/skills/\`, and \`.github/hooks/\` — agent mode, custom skills, subagent delegation, and hooks all require VS Code 1.102 or newer. Enable Copilot agent mode in the Copilot chat view. \`/aidlc --doctor\` validates the install layout.
- **GitHub Copilot subscription**: an active Copilot subscription (or org seat) with agent mode entitlement. Model access follows your Copilot plan; the shipped agents omit a \`model:\` pin and inherit the session model.
- **bun**: Required for CLI tools and hook scripts (state management, audit logging, jump orchestration). Install via \`curl -fsSL https://bun.sh/install | bash\`. On Windows: \`npm install -g bun\` or \`powershell -c "irm bun.sh/install.ps1 | iex"\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns.`,

    prereq_bullets_tail: `- **Install path**: copy the generated \`dist/copilot/\` tree into your project — it lays down \`.github/agents/\`, \`.github/skills/aidlc/\`, \`.github/hooks/\`, and a project-root \`AGENTS.md\`. Copilot auto-detects all four. After copying, run \`/aidlc --doctor\` to confirm the layout is correct.
- **Personal overrides**: user-level VS Code and Copilot settings merge over the project config; put machine-specific overrides in your VS Code user settings to avoid changing the shared \`.github/\` tree.`,

    agents_note: `On Copilot all 14 agent personas are transposed into \`.github/agents/aidlc-<role>-agent.agent.md\` files; the orchestrator addresses them through Copilot's native subagent delegation (its \`agents:\` roster + the \`agent\` tool). Workers for the four dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests all run through that delegation.`,

    structure_extra: "",

    guide_pointer: `The Copilot-specific guide (prerequisites, install steps, agent-mode setup) is \`docs/guide/harnesses/copilot.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness, rendered onto GitHub Copilot (VS Code agent mode). On Copilot:

- **Gates** render as numbered chat prompts (agent mode has no dedicated question widget); the markdown Q&A file is always the source of truth. Gate semantics live in the engine either way.
- **No custom statusline and no welcome message**: workflow position is available on demand via \`/aidlc --status\`.
- **Subagent delegation**: the 14 agent personas live in \`.github/agents/\` as \`.agent.md\` files and are reachable through Copilot's native subagent delegation.
- **Hooks** register in \`.github/hooks/hooks.json\` and fire on \`SessionStart\`, \`UserPromptSubmit\`, \`PreToolUse\`, \`PostToolUse\`, \`PreCompact\`, \`SubagentStop\`, and \`Stop\`. The \`aidlc-copilot-adapter.ts\` shim normalizes Copilot's tool vocabulary (\`runTerminalCommand\` → \`Bash\`, \`editFiles\` → \`Edit\`, …) and camelCase \`tool_input\` keys before delegating to the byte-shared core hooks.
- **Session lifecycle**: an unclosed session is reconciled as an inferred \`SESSION_ENDED\` at the next start; the \`PreCompact\` event re-injects the workflow mission after compaction.
- **The AIDLC method** (the layered practice files \`org.md\`, \`team.md\`, \`project.md\`, and the per-phase \`phases/<phase>.md\`) lives once at the workspace root under \`aidlc/spaces/<active-space>/memory/\` — the single hand-editable source of truth, identical on every harness, NOT a per-harness copy. Copilot auto-reads the root \`AGENTS.md\` and the orchestrator injects the active-space memory paths into context on demand. Edit the method there, never under \`.github/\`.
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
