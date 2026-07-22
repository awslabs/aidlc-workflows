// harness/codex/onboarding.fills.ts — Codex CLI's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts inside
// emit.ts into dist/codex/AGENTS.md (project root). emit() applies the
// {{HARNESS_DIR}} → .codex substitution + rules/ → aidlc-rules/ rename itself.
//
// This RETIRES the old read-CLAUDE.md + regex-rewrite path: Codex no longer
// derives its onboarding doc from Claude's, so Claude prose can no longer leak
// through (the F-ONBOARDING-LEAK class). The Codex-specific header + Prerequisites
// are authored here directly.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "$aidlc",
  slots: {
    title_block: `# AI-DLC on Codex CLI

This project uses AI-DLC (AI-Driven Development Life Cycle) under the OpenAI
Codex CLI harness (minimum version 0.139.0). Invoke the orchestrator skill with
\`$aidlc\` (or \`/skills\` → aidlc) followed by a scope or project description.
The deterministic engine, state machine, audit log, and referee are
byte-identical to every other harness distribution; only the shell differs. Run
\`$aidlc --status\` for progress, \`$aidlc --help\` for usage, \`$aidlc intent\`
to list intents, \`$aidlc --doctor\` to validate setup, and
\`$aidlc --stage <slug>\` / \`--phase <name>\` / \`--depth <level>\` /
\`--test-strategy <level>\` for the usual overrides. Run \`$aidlc compose
"<task>"\` to have the adaptive composer propose a tailored EXECUTE/SKIP plan
(up front, from a scan report via \`--report <path>\`, or mid-workflow to
re-shape the pending stages - every proposal stops at an approve/edit/reject
gate).`,

    prereq_bullets: `- **Codex CLI ≥ 0.139.0**: earlier releases do not surface the real agent role in subagent hook payloads and do not resolve hyphenated agent TOMLs. \`$aidlc --doctor\` enforces the pin. Check with \`codex --version\`.
- **bun**: Required for CLI tools and hook scripts (state management, audit logging, jump orchestration). Install via \`curl -fsSL https://bun.sh/install | bash\`. On Windows: \`npm install -g bun\` or \`powershell -c "irm bun.sh/install.ps1 | iex"\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns — these source \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash), NOT \`~/.zshrc\`.
- **Model provider**: The shipped \`.codex/config.toml\` defaults to **Amazon Bedrock** — the session (and judgment-tier agents, which inherit it) on \`openai.gpt-5.5\`, balanced/templated agents pinned to \`openai.gpt-5.4\` (the tier projection). Set your AWS profile/region under \`[model_providers.amazon-bedrock.aws]\` (shipped defaults \`profile = "default"\`, \`region = "us-east-1"\`); you need Bedrock model access and AWS credentials on the default SDK credential chain. For OpenAI auth instead, comment out \`model_provider\` and the \`[model_providers]\` block. Note: \`web_search\` is unavailable on Bedrock, so the market-research stage degrades gracefully.
- **MCP servers (optional)**: Codex reads MCP server definitions from \`[mcp_servers.<name>]\` tables in \`config.toml\` (project \`.codex/config.toml\` or \`~/.codex/config.toml\`). The shipped config declares none — add the servers you need there. Credentials flow through your environment; a server you have no credentials for is simply unavailable and never blocks a workflow.`,

    prereq_bullets_tail: `- **Permissions**: \`.codex/rules/default.rules\` (Starlark prefix rules) pre-allows the deterministic core's exact command prefixes — \`bun .codex/tools/\`, \`bun .codex/hooks/\`, and \`git worktree\`/\`commit\`/\`add\` — so workflows run without per-call prompts. The sandbox is \`workspace-write\`; commands outside the allowlist prompt.
- **Personal overrides**: Settings in \`~/.codex/config.toml\` merge over the project \`.codex/config.toml\`. Put machine-specific overrides (model, AWS profile/region, environment variables) there to avoid changing the shared project config.`,

    agents_note: `On Codex all 14 agent personas are transposed into \`.codex/agents/\` TOMLs (the conductor reads the persona \`.md\` bodies as prose); workers for the four dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests run through Codex subagent roles.`,

    structure_extra: "",

    guide_pointer: `The Codex-specific guide (prerequisites, trust pre-seed, Bedrock config, the git-repo requirement) is \`docs/guide/harnesses/codex-cli.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness, rendered onto Codex CLI. On Codex:

- **Gates** render as structured questions via the \`request_user_input\` tool when the shipped config flags enable it, with a numbered-prose fallback otherwise. Gate semantics live in the engine either way.
- **No custom statusline and no welcome message**: workflow position rides the \`update_plan\` tool and \`$aidlc --status\`.
- **Git under the sandbox**: \`workspace-write\` keeps \`.git\` read-only in-sandbox; interactive sessions auto-escalate and \`.codex/rules/default.rules\` pre-allows \`git worktree\`/\`commit\`/\`add\`. Headless runs need \`writable_roots\` (template in the shipped \`config.toml\`).
- **Swarm floor** is \`codex exec\`-per-unit workers; \`AIDLC_USE_SWARM=1\` has no Workflow tool here and loud-degrades (\`SWARM_DEGRADED\`).
- **Session lifecycle**: Codex has no SessionEnd event (an unclosed session is reconciled as an inferred \`SESSION_ENDED\` at the next start); after compaction, Codex emits SessionStart with \`source=compact\`, which re-injects the workflow mission.
- **The AIDLC method** (the layered practice files \`org.md\`, \`team.md\`, \`project.md\`, and the per-phase \`phases/<phase>.md\`) lives once at the workspace root under \`aidlc/spaces/<active-space>/memory/\` — the single hand-editable source of truth, identical on every harness, NOT a per-harness copy. Codex auto-merges the root \`AGENTS.md\` and the orchestrator injects the active-space memory paths into context on demand; AI-DLC's own stage resolver reads the same tree directly (via the \`AIDLC_RULES_DIR\` seam in the shipped \`config.toml\`). Edit the method there, never under \`.codex/\`. (\`.codex/rules/default.rules\` remains Codex's native Starlark permission-rules file — distinct from the AIDLC method, and the two must not collide.)
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
