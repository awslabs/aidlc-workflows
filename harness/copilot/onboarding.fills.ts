// harness/copilot/onboarding.fills.ts — Copilot's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/copilot/AGENTS.md (project root — BOTH Copilot surfaces auto-read it:
// Copilot CLI and VS Code agent mode). {{HARNESS_DIR}} → .aidlc is applied by
// the packager transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **GitHub Copilot harness** (one install serves Copilot CLI and VS Code agent mode). The workspace shell ships in \`.aidlc/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume. Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Copilot CLI ≥ 1.0.74 and/or VS Code ≥ 1.130**: the hook surface this install relies on (PascalCase-registered lifecycle hooks in \`.github/hooks/aidlc.json\`, blocking PreToolUse deny, blocking Stop) and \`.github/{skills,agents}\` discovery are current-line features. Check with \`copilot --version\` / \`code --version\`.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the shells Copilot spawns.
- **Folder trust (hooks are silent without it)**: repo hooks run only when this project's absolute path is listed in \`trustedFolders\` in \`~/.copilot/config.json\` (the CLI prompts on first interactive run). Headless \`copilot -p\` runs ADDITIONALLY need \`GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=1\` in the environment — without it every hook silently no-ops. \`/aidlc --doctor\` checks both.
- **Model/provider**: no model is pinned anywhere in this install — agents inherit the session model on both surfaces. On the CLI, BYOK env vars select the provider (e.g. Amazon Bedrock's Anthropic-compatible endpoint via \`COPILOT_PROVIDER_BASE_URL\`/\`COPILOT_PROVIDER_TYPE=anthropic\`; \`copilot help providers\` documents the set); in VS Code, use the model picker or a Custom Endpoint provider.`,

    prereq_bullets_tail: "",

    agents_note: `On Copilot the expert roles are native custom agents (\`.github/agents/aidlc-<role>-agent.md\`); the \`/aidlc\` session takes on those roles itself for most stages and hands work off to them for the delegated stages (2.1, 2.2, 2.4, 3.5). They carry no \`model:\` pin — the two Copilot surfaces disagree on model-value syntax, so agents always inherit the session model.`,

    structure_extra: "",

    guide_pointer: `The Copilot-specific guide (install, what differs, verification) is \`docs/guide/harnesses/copilot.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto GitHub Copilot. On Copilot:

- **One install, two surfaces**: Copilot CLI and VS Code agent mode read the same \`.github/{skills,agents,hooks}\` tree and this AGENTS.md. Skills, personas, and hooks behave identically; anything surface-specific is called out below.
- Approval gates and questions render as **numbered prose options** so the human's next chat message fires the trusted presence hook. Copilot's picker tools return answers as tool results and cannot satisfy that guard; the questions FILE with \`[Answer]:\` tags remains the source of truth.
- Hooks ride the **AIDLC adapter** (\`.aidlc/hooks/aidlc-copilot-adapter.ts\`, wired by \`.github/hooks/aidlc.json\`): reviewer read-scope enforcement and the workflow-command guard run before tools **and actually block** (PreToolUse deny is native; live-verified on the CLI, documented on VS Code); audit and sensors cover Write/Edit; stage-graph rebuilds, human-turn recording, and pre-compaction state validation run from the matching events.
- The forwarding-loop enforcement (the Stop hook) **blocks natively** (\`decision: block\`) — same contract as Claude Code.
- Reviewer identity on subagent tool calls is correlated from SubagentStart/SubagentStop (payloads carry no per-call agent field); with several subagents in flight the scope hook fails open for the ambiguous call and the prose §12a bound governs.
- The shared hook manifest omits VS Code's unsupported SessionEnd event. On both hosts, the adapter reconciles the prior session at the next SessionStart (inferred provenance).
- There is **no statusline**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- **MCP servers**: none ship (configure your own via \`copilot mcp add\` / \`.vscode/mcp.json\` if needed — note the two surfaces use different MCP config files).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between harness installs (supported but untested — keep the trees in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: `## Method include (do not remove)

Copilot expands \`@\`-imports in this file (live-verified on the CLI); these lines pull the
active space's method layers into ambient context (the native include —
\`/aidlc space <name>\` re-points them in place):

@aidlc/spaces/default/memory/org.md
@aidlc/spaces/default/memory/team.md
@aidlc/spaces/default/memory/project.md
@aidlc/spaces/default/memory/phases/ideation.md
@aidlc/spaces/default/memory/phases/inception.md
@aidlc/spaces/default/memory/phases/construction.md
@aidlc/spaces/default/memory/phases/operation.md
`,

    gitignore_extra: "",
  },
};

export default fills;
