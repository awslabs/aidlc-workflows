// harness/cursor/onboarding.fills.ts — Cursor's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/cursor/AGENTS.md (project root — Cursor reads it natively and always
// applies it). {{HARNESS_DIR}} → .cursor is applied by the packager transform
// afterwards; Cursor has no rules rename.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Cursor harness** (the Cursor editor and the \`agent\` CLI). The workspace shell ships in \`.cursor/\` (no setup command); the engine auto-births the first intent when you describe what to build. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume. Run \`/aidlc compose "<task>"\` to have the adaptive composer propose a tailored EXECUTE/SKIP plan (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Cursor ≥ 2.4** (editor or the \`agent\` CLI): the surfaces this install relies on — Agent Skills (\`.cursor/skills/\`, invoked \`/aidlc\`), custom subagents (\`.cursor/agents/*.md\`), and the hooks system (\`.cursor/hooks.json\`, incl. the stop hook's followup channel) — shipped in the 2.4 line. Check with **Cursor → About** in the editor or \`agent --version\` on the CLI.
- **bun**: Required for the CLI tools and hook scripts (state management, audit logging, orchestration engine). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns — these source \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash), NOT \`~/.zshrc\`.
- **Permissions**: this install ships \`.cursor/cli.json\` pre-approving ONLY the framework's own \`bun .cursor/...\` invocations for the \`agent\` CLI; everything else follows your Run Mode. In the editor, Auto-review governs — the framework's bun calls are read-mostly state bookkeeping and safe to allow. There is no blanket shell trust.`,

    prereq_bullets_tail: "",

    agents_note: `On Cursor the persona \`.md\` files under \`.cursor/agents/\` are read natively as subagents (frontmatter \`name\`/\`description\`; unknown keys are ignored). The conductor delegates the subagent stages (2.1, 3.5) and the §12a reviewer step to them by name; the other personas are adopted inline.`,

    structure_extra: "",

    guide_pointer: `The Cursor-specific guide (install, what differs, the live journey test) is \`docs/guide/harnesses/cursor.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness — one deterministic engine, state machine, audit trail, and stage set, rendered onto Cursor. On Cursor:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- **No statusline is wired** (the Cursor CLI's statusLine contract is not consumed by this install); use \`/aidlc --status\` and the progress lines at gates.
- The **stop hook cannot hard-block** on Cursor: a mid-workflow early stop comes back as an auto-submitted follow-up message (Cursor's \`followup_message\` channel) instead of a blocked turn — same forwarding discipline, different mechanics. \`.cursor/hooks.json\` caps this at \`loop_limit: 12\`, above the framework's own interactive/autonomous ceilings (2/8), so the core hook's caps govern.
- The **reviewer read-scope bound (§12a) is prose-governed, not hook-enforced**: Cursor's \`preToolUse\` payloads carry no subagent identity and hooks cannot be registered per-subagent, so the deterministic reviewer-scope hook ships unwired here (the dispatch record is still written; the stage-protocol §12a bound governs, as on Kiro IDE).
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- Session resume is not discriminated by the hooks (\`SESSION_RESUMED\` / the resume-rebind offer never fire); every session records as a fresh start.
- **MCP servers**: none ship (the Claude distribution ships five; Cursor ships zero today — add your own via \`.cursor/mcp.json\` if needed).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and Cursor installs (supported but untested — keep both \`.claude/\` and \`.cursor/\` in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
