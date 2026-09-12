// harness/devin/onboarding.fills.ts — Devin CLI's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/devin/AGENTS.md. {{HARNESS_DIR}} stays for the packager transform.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `<!--
  Devin CLI auto-loads {{HARNESS_DIR}}/rules/aidlc.md into ambient context on
  session start (no @-import line needed). That stub pulls the AIDLC method in
  by reference (NOT a copy): {{HARNESS_DIR}}/rules/aidlc.md → aidlc/spaces/
  <active-space>/memory/*.md. Edit the method there, never in
  {{HARNESS_DIR}}/rules/aidlc.md.
-->

# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development. The workspace shell ships in \`.devin/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup. Run \`/aidlc --version\` to print the framework version. Run \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Runtime**: Framework commands run through \`aidlc\`; keep that command and its runtime available.
- **Model & environment (user-level)**: Model, environment, and effort settings are user-level on Devin — do NOT put them in the project config. Set your model in \`~/.config/devin/config.json\` (or \`%APPDATA%\\devin\\config.json\` on Windows). Full setup is in \`docs/guide/01-getting-started.md\` § "Devin CLI Setup".
- **MCP servers (optional)**: \`.devin/mcp_config.json\`, inside \`.devin/\`, bundles the same five servers as Kiro. All five MCP servers are disabled by default. Review prerequisites, then enable selected entries with \`disabled: false\`; leave unused servers disabled. Disabled registrations expose no tools and do not start server processes. Context7 uses HTTP with the configured \`CONTEXT7_API_KEY\` header; supply the key securely through your environment or private \`.devin/mcp_config.local.json\` (gitignored), never in committed configuration or shell history. The four AWS servers (\`aws-mcp\`, \`aws-pricing\`, \`aws-iac\`, \`aws-serverless\`) need \`uvx\`, the selected package's supported Python runtime, and appropriate AWS credentials/permissions when enabled; review the \`us-east-1\` endpoint and metadata. Missing credentials are not a substitute for disabling a server. The retained \`@latest\` launchers match Kiro but can resolve changing third-party versions when enabled; default-off is not dependency pinning. MCP tool calls are not blanket-pre-approved; grant tools explicitly under your Devin policy. Only enabled, available servers are provisioned to the session and inherited by agents, subject to their \`tools:\` allowlists. MCP availability never blocks an AIDLC workflow.`,

    prereq_bullets_tail: `- **Settings**: \`.devin/config.json\` pre-approves file tools, delegation, questions, and web tools. Framework shell grants cover \`bun .devin/tools/*\`, \`bun run .devin/tools/*\`, and \`date -u\`. No deny list ships. Hooks are not a general destructive-command security boundary; use Devin/OS security controls.
- **Personal overrides**: Create \`.devin/config.local.json\` (gitignored) for personal API keys and \`.devin/mcp_config.local.json\` (gitignored) for personal MCP credentials without affecting shared settings.`,

    hook_permissions_note: `After copying the project shell, approve its hooks via \`/hooks\`, then fully restart Devin CLI; \`/clear\` is not enough.`,

    agents_note: `Each is a flat \`.md\` file prefixed \`aidlc-<role>-agent.md\`; the \`/aidlc\` session takes on each expert role itself where the stage calls for it, and hands work to a separate agent for the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests via the \`run_subagent\` tool.`,

    structure_extra: `- **No custom statusline**: Devin CLI has no \`statusLine\`/\`status_bar\` config field, so the live workflow-position readout is unavailable as a persistent strip. Run \`/aidlc --status\` on demand for the current phase, stage, progress, and cost.`,

    guide_pointer: "",

    sections_before_resumption: "",

    sections_after_resumption: "",

    gitignore_extra: `- \`.devin/config.local.json\`
- \`.devin/mcp_config.local.json\`
- \`AGENTS.local.md\``,
  },
};

export default fills;
