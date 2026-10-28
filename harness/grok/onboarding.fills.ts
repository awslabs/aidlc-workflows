// harness/grok/onboarding.fills.ts — Grok Build's onboarding-doc fills.
// The packager fills core/templates/onboarding-harness.md into
// dist/grok/.grok/rules/aidlc-onboarding.md. The root AGENTS.md stays neutral.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    frontmatter: "---\ndescription: AI-DLC onboarding for Grok Build\n---",
    title_block: `# AI-DLC on Grok Build

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Grok Build harness**. The workspace shell ships in \`.grok/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Grok-native shortcuts expose \`/aidlc-status\`, \`/aidlc-jump --stage <slug>\` (or \`--phase <name>\`), and \`/aidlc-scope <name>\` through the same workflow. Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Grok Build**: open this project in Grok Build. It reads this install's \`.grok/\` surfaces (rules, skills, agents, hooks). Project hooks run only after you trust the folder, and only inside a git repository.
- **A git repository**: Grok Build skips project hooks in a folder that is not in one, and without them your approvals are never recorded. Run \`git init\` in the project first if it is not a repository yet, then trust the folder.
- **The session model**: persona surfaces ship with no model pins, so every agent inherits the model of this Grok Build session.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the shells Grok Build spawns.`,

    prereq_bullets_tail: "",

    agents_note: `On Grok Build each expert role is a native subagent (discovered from the persona files in \`.grok/agents/\`). The \`/aidlc\` session takes on those roles itself for most stages and hands work off with \`spawn_subagent\`, \`subagent_type\` set to the persona name, waiting in the foreground (\`background: false\`). Personas do not spawn further agents. They ship without \`model:\` pins — every agent inherits your session model.`,

    structure_extra: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Grok Build. On Grok Build:

- Approval gates and questions are presented with \`ask_user_question\`. The tool adds Other. The questions FILE with \`[Answer]:\` tags remains the source of truth.
- Hooks ride \`.grok/hooks/aidlc.json\` through the AIDLC adapter (\`.grok/hooks/aidlc-grok-adapter.ts\`): state-transition, reviewer read-scope, review-freeze, and plan-approval guards block with \`{"decision":"deny","reason"}\` before tools; audit and sensors cover write and edit; stage-graph rebuilds, human-turn recording, and pre-compaction state validation run from the matching Grok moments.
- The forwarding-loop enforcement (the Stop hook) can **block**: a pending directive returns \`{"decision":"block","reason"}\` and the session continues. A stop fired because the session is closing (\`channel_closed\`, \`shutdown\`) is not a gate.
- The AI-DLC method (\`aidlc/spaces/<space>/memory/*.md\`) reaches context through read instructions because Grok Build rules do not expand \`@\`-imports: \`.grok/rules/aidlc.md\` points to org/team/project, and four \`.grok/rules/aidlc-phase-*.md\` files point to phase guidance. Grok Build loads every rules file each turn. The sessionStart hook separately injects live workflow state; \`/aidlc space <name>\` re-points the copy those rules read.
- Subagent identity arrives on the hook payload as \`subagentType\`. Reviewer read-scope uses that field. There is no reconstructed ledger.
- There is **no statusline**; use \`/aidlc-status\` (or \`/aidlc --status\`) and the progress lines at gates.
- Construction swarm runs as **\`spawn_subagent\` fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op; Grok Build has no Workflow tool). Each call waits in the foreground (\`background: false\`).
- **MCP servers**: none ship.
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between harness installs (supported but untested — keep the trees in sync via the framework's packaging if you do this).
- Gated workflows need a person at the keyboard. A headless \`grok -p\` run does not mint a human turn, so an approval gate refuses by design. Headless mode suits the read-only utilities (\`--status\`, \`--doctor\`, \`--version\`).

## Shell allow list

Grok Build reads project permissions from \`.grok/config.toml\`. AI-DLC does not write that file. Add an allow entry that names \`aidlc\` (the native command) or the copy-channel \`bun\` scripts, and keep every other line you already have:

\`\`\`toml
[permission]
allow = ["Bash(aidlc *)", "Bash(bun .grok/tools/aidlc*)", "Bash(bun .grok/hooks/aidlc*)"]
\`\`\`

\`/aidlc --doctor\` warns when no \`[permission]\` allow entry mentions \`aidlc\`. Trust this folder as well: project hooks do not run until you do, and they do not run outside a git repository.

The Grok Build guide (install, what differs, verification) is \`docs/guide/harnesses/grok.md\`.
`,

    sections_after_resumption: "",
  },
};

export default fills;
