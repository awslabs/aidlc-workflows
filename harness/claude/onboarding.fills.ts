// harness/claude/onboarding.fills.ts — Claude Code's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/claude/.claude/CLAUDE.md. {{HARNESS_DIR}} stays for the packager transform.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `@.claude/rules/aidlc.md

<!--
  The @-line above pulls the AIDLC method into Claude's ambient context. It is
  the first hop of a reference chain (NOT a copy): CLAUDE.md → @.claude/rules/
  aidlc.md → @../../aidlc/spaces/default/memory/*.md. The method is authored ONCE
  at the workspace root under aidlc/spaces/default/memory/ (org/team/project +
  phases/), so edit it there, never in .claude/rules/aidlc.md. Verified resolving
  (G1 PASS) — see tmp/workspace-vision/at-import-spike/RESULTS.md.
-->

# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development. The workspace shell ships in \`.claude/\` (no setup command); the engine auto-births the first intent when you describe what to build. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup. Run \`/aidlc --version\` to print the framework version. Run \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume. Run \`/aidlc compose "<task>"\` to have the adaptive composer propose a tailored EXECUTE/SKIP plan (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **bun**: Required for CLI tools and hook scripts (state management, audit logging, jump orchestration). Install via \`curl -fsSL https://bun.sh/install | bash\`. On Windows: \`npm install -g bun\` or \`powershell -c "irm bun.sh/install.ps1 | iex"\`. Startup is ~20ms. **Important**: \`bun\` must be on your PATH for non-interactive shells. Claude Code runs your shell non-interactively, so it sources \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash) — NOT \`~/.zshrc\`. On Windows with Git Bash, \`~/.bashrc\` is the correct file. If \`which bun\` fails inside Claude Code, add the bun PATH export to the appropriate file.
- **AWS Bedrock access**: The shipped \`.claude/settings.json\` defaults the orchestrator to Opus 4.8 with the 1M-context variant via AWS Bedrock (\`global.anthropic.claude-opus-4-8[1m]\`), sets \`AWS_REGION\` to \`us-east-1\`, and pins global Bedrock model IDs for Fable, Opus, Sonnet, and Haiku. You need Bedrock model access enabled and AWS credentials on the default SDK credential chain to run the framework as shipped. If your region isn't \`us-east-1\`, override \`AWS_REGION\` in \`.claude/settings.local.json\`. Full setup (model access, IAM, credentials, region) is in \`docs/guide/01-getting-started.md\` § "AWS Bedrock Setup".
- **MCP servers (optional)**: \`.mcp.json\` (project root, beside \`.claude/\`) declares the MCP servers available to the framework. \`context7\` (library/SDK documentation lookups) is an HTTP server that reads \`CONTEXT7_API_KEY\` from your environment. The four AWS servers (\`aws-mcp\`, \`aws-pricing\`, \`aws-iac\`, \`aws-serverless\`) launch via \`uvx\` and authenticate with your standard AWS credential chain — they require an AWS account with IAM credentials available to your shell (install \`uv\`/\`uvx\` via \`curl -fsSL https://astral.sh/uv/install.sh | sh\`). All credentials flow through environment passthrough; no keys are committed. Servers you have no credentials for are simply unavailable and never block a workflow. Declared servers are provisioned to the session and **inherited by every agent** — there is no per-agent grant; agents that should be prevented from using a server are narrowed via their \`tools:\` allowlist with fully-qualified \`mcp__<server>__<tool>\` ids.`,

    prereq_bullets_tail: `- **Settings**: \`.claude/settings.json\` pre-approves tools (Read, Edit, Write, Bash, Glob, Grep, Task, WebSearch) so workflows run without per-call permission prompts.
- **Personal overrides**: Copy \`.claude/settings.local.json.example\` to \`.claude/settings.local.json\` (gitignored) to override the model or set environment variables without affecting shared settings.`,

    agents_note: `Each is a flat \`.md\` file prefixed \`aidlc-<role>-agent.md\`; the conductor adopts domain personas inline where the stage mode calls for it and delegates the two subagent stages, reviewer passes, and composer requests via the \`Task\` tool.`,

    structure_extra: "",

    guide_pointer: "",

    sections_before_resumption: `## AI-DLC Method (imported)

The AI-DLC method — the layered practice files (\`org.md\`, \`team.md\`, \`project.md\`, and the per-phase \`phases/<phase>.md\`) — is authored once at the workspace root under \`aidlc/spaces/default/memory/\` and imported into Claude's ambient context by reference (the \`@{{HARNESS_DIR}}/rules/aidlc.md\` import at the top of this file), never copied. That stub \`@\`-imports each method file from \`aidlc/spaces/default/memory/\`; Claude resolves the nested chain. Edit the method there — it is the single hand-editable source of truth, identical on every harness. (AI-DLC's own stage resolver reads the same tree directly, so each stage is method-correct without this ambient import.)
`,

    sections_after_resumption: "",

    gitignore_extra: `- \`.claude/settings.local.json\``,
  },
};

export default fills;
