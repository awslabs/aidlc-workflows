// harness/opencode/onboarding.fills.ts — opencode's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/opencode/AGENTS.md (project root — opencode auto-reads it as its
// primary rules file). {{HARNESS_DIR}} → .opencode is applied by the packager
// transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **opencode harness**. The workspace shell ships in \`.aidlc/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **opencode ≥ 1.17**: the plugin hook surface this install relies on (\`tool.execute.before\`, \`tool.execute.after\`, \`chat.message\`, \`session.idle\` on the event bus, \`experimental.session.compacting\`) and project-local \`.aidlc/skills/\` + \`.opencode/agents/\` discovery are current-line features. Check with \`opencode --version\`.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the shells opencode spawns; the AIDLC adapter plugin also probes \`~/.bun/bin/bun\` directly.
- **Model/provider**: the shipped \`opencode.json\` pins no model — your global opencode configuration (\`~/.config/opencode/opencode.json\`) supplies the default. Tiered personas pin \`amazon-bedrock/global.anthropic.claude-sonnet-4-6\`; override per agent under \`agent:\` in the project \`opencode.json\` if your provider differs.
- **Permissions**: the shipped project \`opencode.json\` pre-approves only direct projected framework tool invocations; the adapter rejects chaining, redirection, expansion, and command substitution. Edits under \`.aidlc/tools/\` and \`.aidlc/hooks/\` prompt. Every other bash command prompts. There is no blanket shell trust. In \`opencode run\` non-interactive sessions, pass \`--auto\` only if you accept auto-approval of the remaining prompts; prefer interactive sessions for gated workflows.`,

    prereq_bullets_tail: "",

    agents_note: `On opencode each expert role is a native subagent (\`mode: subagent\` in each \`.opencode/agents/aidlc-<role>-agent.md\`); the \`/aidlc\` session takes on those roles itself for most stages and hands work off via the \`task\` tool for the two delegated stages (2.1, 3.5).`,

    structure_extra: "",

    guide_pointer: `The opencode-specific guide (install, what differs, verification) is \`docs/guide/harnesses/opencode.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto opencode. On opencode:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- Hooks ride the **AIDLC adapter plugin** (\`.opencode/plugin/aidlc-opencode-adapter.ts\`): reviewer read-scope enforcement and the AIDLC bash-command boundary run before tools; audit and sensors cover write, edit, and apply_patch; stage-graph rebuilds, human-turn recording, and pre-compaction state validation run from the matching opencode moments.
- The forwarding-loop enforcement (the Stop hook) rides \`session.idle\` and re-engages the loop by **injecting a nudge prompt** — advisory, not blocking; a chatting or pausing human is released by the hook's interactive cap.
- The AI-DLC method (\`aidlc/spaces/<space>/memory/*.md\`) reaches ambient context via the \`instructions\` glob in the project \`opencode.json\` or \`opencode.jsonc\`; \`/aidlc space <name>\` re-points every present config without removing JSONC comments.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **task-tool fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- Session-end audit events (\`SESSION_ENDED\`) are not emitted — opencode has no session-end hook moment; pre-compaction validation DOES fire (\`experimental.session.compacting\`).
- **MCP servers**: none ship (configure your own under \`mcp:\` in \`opencode.json\` if needed).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between harness installs (supported but untested — keep the trees in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
