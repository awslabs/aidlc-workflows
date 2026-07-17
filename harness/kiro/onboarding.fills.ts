// harness/kiro/onboarding.fills.ts — Kiro CLI's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/kiro/AGENTS.md (project root). {{HARNESS_DIR}} → .kiro and the
// rules/ → steering/ rename are applied by the packager transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Kiro CLI harness**. The workspace shell ships in \`.kiro/\` (no setup command); the engine auto-births the first intent when you describe what to build. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume. Run \`/aidlc compose "<task>"\` to have the adaptive composer propose a tailored EXECUTE/SKIP plan (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Kiro CLI ≥ 2.6**: the hooks/skills/agent features this install relies on (stop hook with blocking, preToolUse/postToolUse matchers, \`.kiro/skills/\` slash commands, workspace \`chat.defaultAgent\`) shipped in the 2.x line. Check with \`kiro-cli --version\`.
- **bun**: Required for the CLI tools and hook scripts (state management, audit logging, orchestration engine). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns — these source \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash), NOT \`~/.zshrc\`.
- **Activation**: this install ships \`.kiro/settings/cli.json\` setting \`chat.defaultAgent: "aidlc"\`, so a plain \`kiro-cli chat\` in this project uses the AI-DLC agent and \`/aidlc\` just works. **Note: the workspace default takes precedence over any global default agent you have configured.** If you prefer your own default, delete that settings line and start sessions with \`kiro-cli chat --agent aidlc\` instead.
- **Permissions**: the \`aidlc\` agent pre-approves ONLY \`bun .kiro/tools/*\` shell commands (plus read-only tools); everything else prompts. There is no blanket shell trust. In \`--no-interactive\` runs, tools that would prompt are auto-approved by the harness — prefer interactive sessions for gated workflows.`,

    prereq_bullets_tail: "",

    agents_note: `On Kiro the conductor is \`agents/aidlc.json\`; all 14 personas have JSON configs, and workers for the four dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests run through the Kiro \`subagent\` tool, while inline-stage personas are adopted in-context.`,

    structure_extra: "",

    guide_pointer: `The Kiro-specific guide (install, what differs, the live journey test) is \`docs/guide/harnesses/kiro-cli.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness — one deterministic engine, state machine, audit trail, and stage set, rendered onto Kiro CLI. On Kiro:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- Session-end and pre-compaction audit events (\`SESSION_ENDED\`, \`SESSION_COMPACTED\`) are not emitted — Kiro has no hooks for those moments.
- **MCP servers**: none ship, and the Kiro MCP config mechanism is not configured here (the Claude distribution ships five; Kiro ships zero today).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and Kiro CLI installs (supported but untested — keep both \`.claude/\` and \`.kiro/\` in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
