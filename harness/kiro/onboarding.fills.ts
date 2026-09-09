// harness/kiro/onboarding.fills.ts — the Kiro row's onboarding-doc fills.
// One row serves Kiro IDE and Kiro CLI, so this text must not name one of them
// as if it were the harness. It renders into the shipped AGENTS.md, which is
// always loaded - a false sentence here is read every session.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/kiro/AGENTS.md (project root). {{HARNESS_DIR}} → .kiro and the
// rules/ → steering/ rename are applied by the packager transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Kiro harness** (Kiro IDE or Kiro CLI). The workspace shell ships in \`.kiro/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Kiro IDE**, or **Kiro CLI ≥ 2.21.1** (\`kiro-cli --version\`): the hook, skill and agent features this install relies on (a \`Stop\` trigger — advisory here, since it cannot refuse a turn on either surface — PreToolUse/PostToolUse matchers, and \`.kiro/skills/\` slash commands). Either surface reads the same \`.kiro/\` tree. That floor is where the engine pin below was measured, not where the engine first appeared — the CLI has carried it behind \`kiro-cli --v3\` since 2.8.0, so an older 2.x can enter it with that flag, untested by us.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns — these source \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash), NOT \`~/.zshrc\`.
- **Activation**: this install ships \`.kiro/settings/cli.json\`, **read by the Kiro CLI only — the IDE ignores it**. It pins the agent engine, sets \`chat.defaultAgent: "aidlc"\`, and carries one conditional reasoning-effort default (\`xhigh\` on \`claude-opus-4.8\`, inert on any other model), so a plain \`kiro-cli\` in this project uses the AI-DLC agent and \`/aidlc\` just works. **Note: that workspace default takes precedence over any global default agent you have configured**; if you prefer your own, delete the line and start sessions with \`kiro-cli chat --agent aidlc\` instead. In the IDE none of that applies — pick the \`aidlc\` agent in the chat panel.
- **Permissions**: the \`aidlc\` agent pre-approves ONLY project-relative \`bun .kiro/tools/<tool>.ts\` calls (including the \`bun run\` and quoted-path spellings), \`date -u\`, and its listed read-only native tools; everything else prompts. There is no blanket shell trust. Start Kiro from the project root so those relative tool paths resolve correctly. In \`--no-interactive\` runs, a command that would prompt is refused because no approver is present. \`--trust-all-tools\` bypasses the deny list too; use it only in a disposable sandbox.`,

    prereq_bullets_tail: "",

    agents_note: `On Kiro the \`/aidlc\` session runs from \`agents/aidlc.md\`; all 14 ship as Markdown agents alongside it, and the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests run through Kiro's delegation tools, while inline-stage personas are adopted in-context.`,

    structure_extra: "",

    guide_pointer: `The Kiro-specific guide (install, what differs, the live journey test) is \`docs/guide/harnesses/kiro.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Kiro. On Kiro:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- Session-end and pre-compaction audit events (\`SESSION_ENDED\`, \`SESSION_COMPACTED\`) are not emitted — Kiro's \`Stop\` trigger fires at the end of every turn, not at conversation close, so there is no genuine session-end moment to hook.
- **MCP servers**: five ship in \`.kiro/settings/mcp.json\`, all disabled by default. Flip \`"disabled": false\` on each server you want to enable. Context7 is keyless on Kiro because Kiro sends configured HTTP header values verbatim instead of expanding environment placeholders. All 14 delegated personas opt in through \`includeMcpJson: true\` plus \`@<server>\` tool grants; the conductor gets none.
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and Kiro installs (supported but untested — keep both \`.claude/\` and \`.kiro/\` in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
