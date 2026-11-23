// harness/devin/onboarding.fills.ts — Devin CLI's onboarding-doc fills.
// Rendered with core/templates/onboarding-harness.md by scripts/onboarding.ts
// into dist/devin/.devin/rules/aidlc-onboarding.md; the neutral
// core/templates/onboarding.md lands separately as dist/devin/AGENTS.md.
// {{HARNESS_DIR}} stays for the packager transform.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    // `.devin/rules/*.md` files are user-invoked by default; `always_on` makes
    // Devin load this onboarding into every session's context.
    frontmatter: "---\ndescription: AI-DLC onboarding for Devin CLI\ntrigger: always_on\n---",

    title_block: `# AI-DLC on Devin CLI

For natural-language build, implementation, or change requests, read \`{{HARNESS_DIR}}/skills/aidlc/SKILL.md\` and enter its workflow with the person's request before doing the work. They need not type \`/aidlc\`. Preserve explicit \`/aidlc\` arguments. A question alone does not start a run.

Show questions in the person's language, preserving meaning and Plan Approval labels. Follow wait or stop directions. Name work artifacts and settings when needed, not instruction files unless asked.`,

    prereq_bullets: `- **Runtime:** Keep \`aidlc\` and its runtime available.
- **Model & environment:** Set model, environment, and effort in the Devin user configuration, not the project config. With \`model: inherit\`, shipped subagents use the session's model and effort. Otherwise the organization's **Default subagent model** applies (**None** disables subagents). Pin a profile with \`aidlc config models --agent <name> --model <id>\` using \`devin models list\`. Doctor checks model pins, but does not inspect the effective organization setting/model.
- **Optional MCP:** All five MCP servers are disabled by default. Review the prerequisites, then enable selected entries with \`disabled: false\`. Context7 reads \`\${env:CONTEXT7_API_KEY}\` from the environment; use gitignored \`.devin/mcp_config.local.json\` for local settings and never commit credentials. AWS servers require \`uvx\`, Python, and AWS credentials and permissions. Enabled tools remain subject to their \`allowed-tools\` lists and host permissions. MCP tool calls are not blanket-pre-approved.`,

    prereq_bullets_tail: `- **Settings:** Shell grants cover the \`aidlc.ts engine\` prefix and listed commands/scripts. By default, compatibility imports from other tools are off except standard \`AGENTS.md\` and Windsurf (needed for rules delivery on older Devin builds). Hooks are not a general destructive-command security boundary; use Devin and OS controls.`,

    hook_permissions_note: `Inspect \`/hooks\`, approve if prompted, and restart Devin CLI (not \`/clear\`). Doctor requires SessionStart evidence, not proof of current approval.`,

    agents_note: `Flat \`aidlc-<role>-agent.md\` profiles load via \`run_subagent\` for delegated stages, reviews, and composition; inline stages use the parent session. Shipped core profiles receive a Devin-native \`allowed-tools\` list without \`run_subagent\`, \`read_subagent\`, or \`skill\`; the parent conductor owns delegation. The allowlist restricts tool availability, not permission approval or shell behavior.`,

    structure_extra: `- **No custom statusline**: Devin CLI has no \`statusLine\`/\`status_bar\` config field, so the live workflow-position readout is unavailable as a persistent strip. Run \`/aidlc --status\` on demand for the current phase, stage, progress, and cost.`,

    guide_pointer: "",

    sections_before_resumption: "",

    sections_after_resumption: "",

    gitignore_extra: `- \`.devin/config.local.json\`
- \`.devin/mcp_config.local.json\`
- \`.devin/.aidlc-session-start.local.json\`
- \`AGENTS.local.md\``,
  },
};

export default fills;
