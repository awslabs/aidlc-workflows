// harness/omp/onboarding.fills.ts — oh-my-pi (omp)'s onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/omp/AGENTS.md (project root). {{HARNESS_DIR}} → .omp and the
// rules/ → aidlc-common/rules/ rename are applied by the packager transform.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **oh-my-pi** (omp) harness. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --init\` to scaffold the full \`aidlc-docs/\` directory tree without starting a workflow (\`--init --force\` overwrites an existing workspace). Run \`/aidlc --doctor\` to validate your setup. Run \`/aidlc --version\` to print the framework version. Run \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, or \`/aidlc --test-run\` to auto-approve gates for CI/automated runs.`,

    prereq_bullets: `- **bun**: Required for CLI tools and hook scripts (state management, audit logging, jump orchestration). oh-my-pi ships with bun; if \`which bun\` fails inside a hook, install via \`curl -fsSL https://bun.sh/install | bash\` (zsh: add the \`BUN_INSTALL\`/\`PATH\` export to \`~/.zshenv\`; bash: \`~/.bashrc\`; Windows Git Bash: \`~/.bashrc\`). Startup is ~20ms.
- **Model configuration**: The orchestrator defaults to whatever model your omp session is configured with. Configure models through omp's standard provider flow — \`anthropic/claude-opus-4-8\` for the orchestrator is the recommended default. Override per-session by passing \`--model <id>\` to \`omp\` at session start.
- **MCP servers (optional)**: omp supports MCP via \`mcp.json\` at your project root. \`context7\` (library/SDK documentation lookups) is the recommended addition. Configure via \`omp -p '/extensions'\` → MCP. All credentials flow through environment passthrough; no keys are committed.
- **Plugin install**: After copying \`{{HARNESS_DIR}}/\` into your project, run \`omp -p '/extensions'\` to confirm every skill, agent, hook, command, tool, and rule loaded from your project worked. Then \`/aidlc --doctor\` validates the methodology state.`,

    hook_permissions: `- **Hook permissions**: All 10 hooks are TypeScript (\`.ts\`) and run via \`bun\` under oh-my-pi's hook runner. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.`,

    prereq_bullets_tail: `- **Personal overrides**: omp reads \`~/.omp/agent/config.yml\` for user-scope configuration (skill allowlists, hook filters, TTSR settings). Edit that file directly; no project-level equivalent because user-level settings must persist across projects.`,

    agents_note: `Each is a flat \`.md\` file prefixed \`aidlc-<role>-agent.md\`; the conductor adopts the persona inline, or delegates via \`task\` for the two subagent stages (2.1, 3.5).`,

    hooks_or_extensions: `- **Hooks**: \`{{HARNESS_DIR}}/hooks/pre/\` and \`{{HARNESS_DIR}}/hooks/post/\` — Framework hooks for audit emission, session lifecycle, state sync, state validation, subagent tracking, and statusline rendering. All framework files prefixed \`aidlc-*.ts\`. Discovery is filesystem-driven (non-recursive, one level per subdirectory).`,

    structure_extra: `- **Slash commands**: \`{{HARNESS_DIR}}/commands/\` — One command per runnable stage (e.g. \`/aidlc-intent-capture\`), one per scope (e.g. \`/aidlc-bugfix\`), plus \`/aidlc\` (orchestrator), \`/aidlc-init\`, \`/aidlc-session-cost\`, \`/aidlc-replay\`, \`/aidlc-outcomes-pack\`. Each calls the \`aidlc_orchestrate\` custom tool; the skill set under \`{{HARNESS_DIR}}/skills/\` exposes the same stages as discoverable playbooks.
- **Custom tool**: \`{{HARNESS_DIR}}/tools/aidlc-orchestrate/index.ts\` — Exposes the orchestration engine as an omp custom tool (\`aidlc_orchestrate\`). Conductors call it instead of spawning a subprocess.
- **Rules**: Layered under \`{{HARNESS_DIR}}/aidlc-common/rules/\` (org/team/project/phase); engine merges the chain at compile time and writes the effective prose into \`{{HARNESS_DIR}}/RULES.md\` (omp's always-apply rule file, injected into every turn).
- **TTSR rules**: \`{{HARNESS_DIR}}/rules/\` and \`{{HARNESS_DIR}}/ttsr/\` — omp TTSR-style regex triggers (ship blank; add project-specific stream guards here).`,

    guide_pointer: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness, rendered onto oh-my-pi. On omp:

- The orchestrator is a **custom tool** (\`aidlc_orchestrate\`) rather than a Bash subprocess call. Conductors call it with a JSON schema.
- **Gates** and **questions** use omp's built-in question widget (same structured fields as AskUserQuestion on Claude Code).
- **Slash commands** at \`{{HARNESS_DIR}}/commands/\` provide native \`/aidlc-<stage>\` and \`/aidlc-<scope>\` shortcuts in addition to the skill-based runners.
- **Hooks** live in \`hooks/pre/\` and \`hooks/post/\` (omp filesystem discovery).
- **Rules** are at \`aidlc-common/rules/\` (inside aidlc-common, not top-level); the engine compiles them into \`{{HARNESS_DIR}}/RULES.md\` which omp injects as always-apply context.
- A workflow's \`aidlc-docs/\` is harness-neutral: a project can move between Claude Code and omp installs (keep both \`{{HARNESS_DIR}}/\` and \`.claude/\` in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: `## Automated Testing

The \`--test-run\` flag (\`/aidlc bugfix --test-run\`) auto-approves all approval gates and question stages for automated testing. It is intended for CI/test environments only — not for interactive use. State tracking, audit logging, and artifact generation all continue normally.
`,

    gitignore_extra: "",
  },
};

export default fills;
