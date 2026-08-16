// harness/kiro-unified/onboarding.fills.ts — the unified Kiro harness's
// onboarding-doc fills. Rendered with core/templates/onboarding.md by
// scripts/onboarding.ts into dist/kiro-unified/AGENTS.md (project root).
// {{HARNESS_DIR}} → .kiro and the rules/ → steering/ rename are applied by the
// packager transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Kiro unified agent harness** — the shared agent runtime behind **Kiro IDE 1.x** and **Kiro CLI v3** (\`kiro-cli --v3\`). One workspace shell serves both surfaces. The workspace shell ships in \`.kiro/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Surface**: either **Kiro IDE 1.x** or **Kiro CLI v3**. Sign in first, then select Claude Opus 4.8 as the chat model — in the IDE from the model picker, in the CLI with \`/model\`. ⚠️ CLI v3 is an explicit opt-in: \`kiro-cli --v3\`. Without that flag the CLI runs its 2.x engine, which reads neither this shell's \`permissions:\` blocks nor its standalone hook manifests.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns — these source \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash), NOT \`~/.zshrc\`.
- **Activation**: open the project on either surface and invoke \`/aidlc\`; the command loads the shipped \`skills/aidlc/SKILL.md\`, which drives the workflow. In the **IDE**, the \`.kiro/hooks/aidlc-*.json\` manifests register in the Agent Hooks panel. In the **CLI**, the same manifests activate at session start — select the conductor explicitly with \`kiro-cli --v3 --agent aidlc\`. The shipped \`settings/cli.json\` names it as the default agent, but Kiro reads CLI settings from the global scope only, so a workspace copy does not take effect.
- **Permissions**: delegation-target agent \`.md\` files receive the read/write/shell grants they need through their own \`permissions:\` blocks, which both surfaces evaluate the same way. The approval gates plus your own permission settings remain the control boundary.`,

    prereq_bullets_tail: "",

    agents_note: `The \`/aidlc\` command loads \`skills/aidlc/SKILL.md\`, which drives the workflow. The full 14-role roster supplies the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests. Agents ship as \`.md\` only, the conductor as \`agents/aidlc.md\` — the entry the workspace agent selector loads.`,

    structure_extra: "",

    guide_pointer: `The guide for this harness (install, hook wiring, and what differs between the two surfaces) is \`docs/guide/harnesses/kiro-unified.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto the Kiro unified agent harness. On both Kiro IDE 1.x and Kiro CLI v3:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates. (\`.kiro/hooks/aidlc-statusline.ts\` ships with the framework but is inert here — it renders into Claude Code's \`statusLine\` setting, and neither surface registers it.)
- Construction swarm runs as **subagent fan-out only**. \`AIDLC_USE_SWARM=1\` does not switch drivers here: the conductor runs the subagent floor and records the downgrade as a \`SWARM_DEGRADED\` audit event.
- **Not every shipped hook body is registered.** \`ls .kiro/hooks/*.json\` is the live view. \`aidlc-fold-usage.ts\` and \`aidlc-session-end.ts\` are Claude-Code-only producers (they read that harness's transcript and session-lifecycle events); \`aidlc-reviewer-scope.ts\` ships unregistered because a per-persona guard would have to fire for a **delegated** agent, and agent-scope hooks fire only for the active one.
- Which \`SESSION_*\` audit events actually fire is surface- and version-specific, so it is not asserted here. Read the audit trail of a real run (\`aidlc/spaces/<space>/intents/<record>/audit/*.md\`) for the live answer, and \`.aidlc-hooks-health/*.last\` for which hooks fired at all.
- **MCP servers**: \`.kiro/settings/mcp.json\` ships a registry with every server **disabled** — enable what you need there, or scope it to one agent with the \`includeMcpJson\` / \`mcpServers\` fields in its \`.md\`. That file is the live list.
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and Kiro installs (supported but untested — keep both \`.claude/\` and \`.kiro/\` in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
