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

This project uses AI-DLC (AI-Driven Development Life Cycle). Run \`/aidlc\` with a scope or description to begin; use \`/aidlc --doctor\`, \`/aidlc --version\`, and \`/aidlc --help\` for setup checks, version, and commands. \`/aidlc compose "<task>"\` proposes a plan behind an approve/edit/reject gate.`,

    prereq_bullets: `- **Runtime**: Framework commands run through \`aidlc\`; keep that command and its runtime available.
- **Model & environment (user-level)**: Model, environment, and effort settings are user-level on Devin — do NOT put them in the project config. Set your model in \`~/.config/devin/config.json\` (or \`%APPDATA%\\devin\\config.json\` on Windows). Full setup is in \`docs/guide/01-getting-started.md\` § "Devin CLI Setup".
- **Subagent model**: Shipped AI-DLC custom profiles omit \`model:\` and use the organization's **Default subagent model**, not automatic parent-model inheritance. The documented router default is SWE-1.6; \`/aidlc --doctor\` warns about this policy but does not inspect the effective organization setting/model. Ask an organization/enterprise admin to select the desired model there; **None** disables subagents. Custom profile \`model:\` pins are a separate Devin override. See [Devin subagent models](https://docs.devin.ai/cli/subagents#which-model-does-a-subagent-use).
- **MCP servers (optional)**: \`.devin/mcp_config.json\` bundles five servers. All five MCP servers are disabled by default. Review prerequisites, then enable selected entries with \`disabled: false\`; leave unused servers disabled. Disabled entries expose no tools and start no processes. Context7 uses HTTP and the \`CONTEXT7_API_KEY\` header; supply the key via the environment or gitignored \`.devin/mcp_config.local.json\`, never committed config or shell history. The AWS servers (\`aws-mcp\`, \`aws-pricing\`, \`aws-iac\`, \`aws-serverless\`) need \`uvx\`, a supported Python runtime, and AWS credentials/permissions; review the \`us-east-1\` endpoint. Missing credentials do not disable servers. Retained \`@latest\` launchers can resolve changing versions; default-off is not dependency pinning. MCP tool calls are not blanket-pre-approved. Enabled, available servers can be accessed through generic MCP tools, subject to their \`allowed-tools\` lists and host permissions. MCP availability never blocks an AIDLC workflow.`,

    prereq_bullets_tail: `- **Settings**: \`.devin/config.json\` pre-approves file tools, delegation, questions, and web tools. Framework shell grants cover \`bun .devin/tools/*\`, \`bun run .devin/tools/*\`, and \`date -u\`. No deny list ships. Hooks are not a general destructive-command security boundary; use Devin/OS security controls.
- **Personal overrides**: Use gitignored \`.devin/config.local.json\` for personal settings and \`.devin/mcp_config.local.json\` for MCP credentials; never commit secrets.`,

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
