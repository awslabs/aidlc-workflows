// harness/pi/onboarding.fills.ts — Pi's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/pi/.pi/CLAUDE.md. {{HARNESS_DIR}} → .pi is applied by the packager.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --init\` to scaffold the full \`aidlc-docs/\` directory tree without starting a workflow (\`--init --force\` overwrites an existing workspace). Run \`/aidlc --doctor\` to validate your setup. Run \`/aidlc --version\` to print the framework version. Run \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, or \`/aidlc --test-run\` to auto-approve gates for CI/automated runs.`,

    prereq_bullets: `- **bun**: Required for CLI tools (state management, audit logging, jump orchestration). Install via \`curl -fsSL https://bun.sh/install | bash\`. On Windows: \`npm install -g bun\` or \`powershell -c "irm bun.sh/install.ps1 | iex"\`. Startup is ~20ms. **Important**: \`bun\` must be on your PATH for non-interactive shells. Pi runs your shell non-interactively, so it sources \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash) — NOT \`~/.zshrc\`. On Windows with Git Bash, \`~/.bashrc\` is the correct file.
- **AWS Bedrock access**: The shipped \`{{HARNESS_DIR}}/settings.json\` defaults the orchestrator to Opus 4.8 via AWS Bedrock (\`us.anthropic.claude-opus-4-8\`), sets \`AWS_REGION\` to \`us-east-1\`, and pins Bedrock model IDs for Opus, Sonnet, and Haiku. You need Bedrock model access enabled and AWS credentials on the default SDK credential chain to run the framework as shipped. If your region isn't \`us-east-1\`, override \`AWS_REGION\` in \`{{HARNESS_DIR}}/settings.local.json\`. Full setup (model access, IAM, credentials, region) is in \`docs/guide/01-getting-started.md\` § "AWS Bedrock Setup".
- **MCP servers (optional)**: Pi supports MCP via project-level configuration. \`context7\` (library/SDK documentation lookups) is the recommended addition. All credentials flow through environment passthrough; no keys are committed. Servers you have no credentials for are simply unavailable and never block a workflow.`,

    hook_permissions: `- **Extensions**: \`aidlc-hooks\` and \`askuserquestion\` run natively within Pi — no separate bun invocation required for lifecycle events. No executable bits required.`,

    prereq_bullets_tail: `- **Settings**: \`{{HARNESS_DIR}}/settings.json\` registers the extensions (\`["aidlc-hooks", "askuserquestion"]\`) and pre-approves tools (Read, Edit, Write, Bash, Glob, Grep, Task, WebSearch) so workflows run without per-call permission prompts.
- **Personal overrides**: Copy \`{{HARNESS_DIR}}/settings.local.json.example\` to \`{{HARNESS_DIR}}/settings.local.json\` (gitignored) to override the model or set environment variables without affecting shared settings.`,

    agents_note: `Each is a flat \`.md\` file prefixed \`aidlc-<role>-agent.md\`; the conductor adopts the persona inline, or delegates to it via the \`Task\` tool for the two subagent stages (2.1, 3.5).`,

    hooks_or_extensions: `- **Extensions**: \`{{HARNESS_DIR}}/extensions/\` — One consolidated \`aidlc-hooks.ts\` extension covering audit emission, sensor dispatch, runtime-graph compile, session lifecycle, state validation, subagent tracking, statusline rendering, and forwarding-loop enforcement. Plus \`askuserquestion/\` — the structured question-answering UI component used at every approval gate.`,

    structure_extra: "",

    guide_pointer: "",

    sections_before_resumption: "",

    sections_after_resumption: `## Automated Testing

The \`--test-run\` flag (\`/aidlc bugfix --test-run\`) auto-approves all approval gates and question stages for automated testing. It is intended for CI/test environments only — not for interactive use. State tracking, audit logging, and artifact generation all continue normally.
`,

    gitignore_extra: `- \`{{HARNESS_DIR}}/settings.local.json\``,
  },
};

export default fills;
