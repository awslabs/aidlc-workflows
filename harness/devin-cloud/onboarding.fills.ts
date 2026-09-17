// harness/devin-cloud/onboarding.fills.ts — Devin Cloud's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/devin-cloud/AGENTS.md. {{HARNESS_DIR}} stays for the packager transform.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `<!--
  Devin Cloud reads this AGENTS.md at session start — it is the ambient
  channel. The AIDLC method (org/team/project + phase rules) is authored ONCE
  at the workspace root under aidlc/spaces/<active-space>/memory/ (the shipped
  seed is aidlc/spaces/default/memory/), loaded by the engine's stage resolver
  at runtime. Edit the method there.

  Enforcement on this harness is COOPERATIVE: Devin Cloud sessions have no
  repo-local hook transport, so no file here intercepts tool calls. The engine
  under {{HARNESS_DIR}}/tools/ verifies every transition at call time and the
  doctor scans the audit trail for transitions that bypassed a gate.
-->

# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) on Devin Cloud. Ask Devin to run the \`aidlc\` skill (\`@skills:aidlc\`) with a scope or description to begin; use \`@skills:aidlc --doctor\`, \`@skills:aidlc --version\`, and \`@skills:aidlc --help\` for setup checks, version, and commands. \`@skills:aidlc compose "<task>"\` proposes a plan behind an approve/edit/reject gate.`,

    prereq_bullets: `- **Runtime**: Framework commands run through \`bun {{HARNESS_DIR}}/tools/aidlc.ts\`; keep Bun available — the environment blueprint template \`blueprint.aidlc.yaml\` at the repo root installs it in the Devin environment.
- **Skill discovery**: The orchestrator and stage skills live at \`.agents/skills/\`, the path Devin Cloud scans at session start (documented). Skills appear after the session that installed them ends — changes apply to the next session.
- **Session identity**: On first skill invocation in a session, the conductor mints one AIDLC session id through \`{{HARNESS_DIR}}/hooks/aidlc-session-start.ts\` and reuses it for every \`--session\`-accepting engine call. Do not mint a second id mid-session.
- **Cooperative enforcement**: no hook intercepts tool calls on this harness. Gates are verified by engine state at call time; \`--doctor\` reports gate transitions whose audit checkpoint is missing.
- **MCP servers (optional)**: \`{{HARNESS_DIR}}/mcp_config.json\` bundles five servers, all disabled by default — a template for Customize → MCPs, not an auto-loaded config. Context7 uses HTTP and the \`CONTEXT7_API_KEY\` header supplied via \`\${env:CONTEXT7_API_KEY}\`; never commit the key.`,

    prereq_bullets_tail: `- **Delegation**: Cloud has no same-VM subagent tool. Dispatched topologies (\`subagent\`/\`pipeline\`/\`mob\`) run as inline personas; separate managed Devin sessions do not share this engine's session state and are not a substitution.
- **Personal overrides**: Use gitignored \`{{HARNESS_DIR}}/config.local.json\` and \`{{HARNESS_DIR}}/mcp_config.local.json\` for local settings; never commit secrets.`,

    hook_permissions_note: `Devin Cloud has no repo-local hook wiring to approve — there is nothing to trust. The enforcement surface is the engine call itself plus the audit trail.`,

    agents_note: `Persona files under \`{{HARNESS_DIR}}/agents/\` are read as prose and adopted inline by the conductor. Cloud's managed-Devins delegation is a separate surface (separate VM, separate session) and is not used for stage dispatch.`,

    structure_extra: `- **No live statusline**: Run \`@skills:aidlc --status\` on demand for the current phase, stage, progress, and cost.`,

    guide_pointer: "",

    sections_before_resumption: "",

    sections_after_resumption: "",

    gitignore_extra: `- \`{{HARNESS_DIR}}/config.local.json\`
- \`{{HARNESS_DIR}}/mcp_config.local.json\`
- \`{{HARNESS_DIR}}/.aidlc-session-start.local.json\`
- \`AGENTS.local.md\``,
  },
};

export default fills;
