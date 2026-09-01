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
  <active-space>/memory/*.md. The method is authored ONCE at the workspace root
  under aidlc/spaces/default/memory/ (org/team/project + phases/), so edit it
  there, never in {{HARNESS_DIR}}/rules/aidlc.md.
-->

# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development. The workspace shell ships in \`.devin/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup. Run \`/aidlc --version\` to print the framework version. Run \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **bun**: Required for CLI tools and hook scripts (state management, audit logging, jump orchestration). Install via \`curl -fsSL https://bun.sh/install | bash\`. On Windows: \`npm install -g bun\` or \`powershell -c "irm bun.sh/install.ps1 | iex"\`. Startup is ~20ms. **Important**: \`bun\` must be on your PATH for non-interactive shells. Devin CLI runs your shell non-interactively, so it sources \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash) — NOT \`~/.zshrc\`. On Windows with Git Bash, \`~/.bashrc\` is the correct file. If \`which bun\` fails inside Devin CLI, add the bun PATH export to the appropriate file.
- **Model & environment (user-level)**: Model, environment, and effort settings are user-level on Devin — do NOT put them in the project config. Set your model in \`~/.config/devin/config.json\` (or \`%APPDATA%\\devin\\config.json\` on Windows). Full setup is in \`docs/guide/01-getting-started.md\` § "Devin CLI Setup".
- **MCP servers (optional)**: \`.devin/mcp_config.json\` (project root, beside \`.devin/\`) declares the MCP servers available to the framework. \`context7\` (library/SDK documentation lookups) is an HTTP server that reads \`CONTEXT7_API_KEY\` from your environment. The four AWS servers (\`aws-mcp\`, \`aws-pricing\`, \`aws-iac\`, \`aws-serverless\`) launch via \`uvx\` and authenticate with your standard AWS credential chain — they require an AWS account with IAM credentials available to your shell (install \`uv\`/\`uvx\` via \`curl -fsSL https://astral.sh/uv/install.sh | sh\`). All credentials flow through environment passthrough; no keys are committed. Servers you have no credentials for are simply unavailable and never block a workflow. Declared servers are provisioned to the session and **inherited by every agent** — there is no per-agent grant; agents that should be prevented from using a server are narrowed via their \`tools:\` allowlist with fully-qualified \`mcp__<server>__<tool>\` ids.`,

    prereq_bullets_tail: `- **Settings**: \`.devin/config.json\` pre-approves tools (reads, edits, writes, search, \`bun\`/\`git\`/\`node\`/\`npm\`/\`npx\`/\`uvx\` exec, subagent dispatch, structured questions, web fetch, all MCP tools) so workflows run without per-call permission prompts.
- **Personal overrides**: Create \`.devin/config.local.json\` (gitignored) for personal API keys and \`.devin/mcp_config.local.json\` (gitignored) for personal MCP credentials without affecting shared settings.`,

    hook_permissions_note: `After copying the project shell, approve its hooks via \`/hooks\`, then fully restart Devin CLI; \`/clear\` is not enough.`,

    agents_note: `Each is a flat \`.md\` file prefixed \`aidlc-<role>-agent.md\`; the \`/aidlc\` session takes on each expert role itself where the stage calls for it, and hands work to a separate agent for the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests via the \`run_subagent\` tool.`,

    structure_extra: `- **No custom statusline**: Devin CLI has no \`statusLine\`/\`status_bar\` config field, so the live workflow-position readout is unavailable as a persistent strip. Run \`/aidlc --status\` on demand for the current phase, stage, progress, and cost.`,

    guide_pointer: "",

    sections_before_resumption: `## AI-DLC Method (auto-loaded)

The AI-DLC method — the layered practice files (\`org.md\`, \`team.md\`, \`project.md\`, and the per-phase \`phases/<phase>.md\`) — is authored once at the workspace root under \`aidlc/spaces/<active-space>/memory/\` and pulled into Devin's ambient context by \`{{HARNESS_DIR}}/rules/aidlc.md\` (auto-loaded on session start, NOT an \`@\`-import chain). The shipped shell starts on \`default\`; switching spaces repoints the stub at \`aidlc/active-space\` to the selected space. Edit the active space's memory files — they are the single hand-editable source of truth, identical on every harness. (AI-DLC's own stage resolver reads the same tree directly, so each stage is method-correct without this ambient pointer.)
`,

    sections_after_resumption: "",

    gitignore_extra: `- \`.devin/config.local.json\`
- \`.devin/mcp_config.local.json\`
- \`AGENTS.local.md\``,
  },
};

export default fills;
