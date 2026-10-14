// harness/antigravity/onboarding.fills.ts — Antigravity's onboarding-doc fills.
// The packager fills core/templates/onboarding-harness.md into the always-on
// dist/antigravity/.agents/rules/aidlc-onboarding.md, with .agents token
// projection. The root AGENTS.md stays neutral, identical to the other sharing
// harnesses.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    frontmatter: "---\ntrigger: always_on\n---",
    title_block: `# AI-DLC on Antigravity

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Antigravity harness** (the Antigravity IDE and the Antigravity CLI \`agy\` share this install). The workspace shell ships in \`.agents/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Antigravity-native shortcuts expose \`/aidlc-status\`, \`/aidlc-jump --stage <slug>\` (or \`--phase <name>\`), and \`/aidlc-scope <name>\` through the same workflow. Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Antigravity**: the Antigravity IDE or the Antigravity CLI (invoked as \`agy\`). Both read this install's \`.agents/\` surfaces (rules, skills, agents, hooks). Verified against agy cli-2026.10 — hooks (\`.agents/hooks.json\`) and skills (\`.agents/skills/\`) are current-line features.
- **A trusted folder**: Antigravity loads a workspace's \`.agents/hooks.json\` once the folder is trusted, and without the hooks your approvals are never recorded. Trust the folder when Antigravity asks (or add it to \`trustedWorkspaces\` in your Antigravity settings), then send your next message in the same chat.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the shells Antigravity spawns.
- **Permissions**: every shell command, including AI-DLC's own engine calls, follows your Antigravity permission settings; choose "always allow" for the \`bun .agents/tools/aidlc.ts\` commands the first time they ask so the forwarding loop is not interrupted by a prompt per engine call. Headless \`agy -p\` runs cannot answer a permission prompt and run their commands in a sandbox, so they suit the read-only utilities (\`--status\`, \`--doctor\`, \`--version\`) only; gated workflows need an interactive session regardless, because an approval gate waits for the person's own message.`,

    prereq_bullets_tail: "",

    agents_note: `On Antigravity each expert role is a native subagent (discovered from the persona files in \`.agents/agents/\`); the \`/aidlc\` session takes on those roles itself for most stages and hands work off via the \`invoke_subagent\` tool for the two delegated stages (2.1, 3.5). They ship without \`model:\` pins — every agent inherits your session model.`,

    structure_extra: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Antigravity. On Antigravity:

- Approval gates and questions render through the native **\`ask_question\` modal** (the questions FILE with \`[Answer]:\` tags remains the source of truth).
- Hooks ride \`.agents/hooks.json\` through the AIDLC adapter (\`.agents/hooks/aidlc-antigravity-adapter.ts\`): state-transition, reviewer read-scope, review-freeze, and plan-approval guards block via Antigravity's \`decision: deny\` channel before tools; audit and sensors cover file writes and edits; stage-graph rebuilds run after shell commands; the human-turn record is written when a message of yours starts a turn.
- The forwarding-loop enforcement (the Stop hook) is **live**: Antigravity's Stop hook can send the agent back into the loop while a directive is pending.
- There is **no session-end event and no pre-compaction event** on this host: a session's end is not recorded, and state validation runs with the engine's own checks instead of before compaction.
- The AI-DLC method (\`aidlc/spaces/<space>/memory/*.md\`) reaches context through read instructions because Antigravity rules do not expand \`@\`-imports: \`.agents/rules/aidlc.md\` always points to org/team/project, while four model-decided \`.agents/rules/aidlc-phase-*.md\` files point to phase guidance only when relevant. The SessionStart hook separately injects live workflow state; \`/aidlc space <name>\` re-points all five rules in place.
- Subagent identity on hook payloads is **reconstructed by the adapter** from each conversation's own transcript and the \`invoke_subagent\` dispatch record: reviewer read-scope enforcement keys on that ledger.
- There is **no statusline** and **no welcome message**; use \`/aidlc-status\` (or \`/aidlc --status\`) and the progress lines at gates.
- Construction swarm runs as **\`invoke_subagent\` fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- **Codex CLI and Antigravity cannot share a project**: both discover skills in \`.agents/skills/\`.
- **MCP servers**: none ship (configure your own in Antigravity's MCP settings if needed).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between harness installs (supported but untested — keep the trees in sync via the framework's packaging if you do this).

The Antigravity-specific guide (install, what differs, verification) is \`docs/guide/harnesses/antigravity.md\`.
`,

    sections_after_resumption: "",
  },
};

export default fills;
