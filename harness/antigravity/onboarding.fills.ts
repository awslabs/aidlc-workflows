// harness/antigravity/onboarding.fills.ts — Antigravity's onboarding-doc fills.
// The packager fills core/templates/onboarding-harness.md into the always-on
// dist/antigravity/.agent/rules/aidlc-onboarding.md, with .agent token projection.
// The root AGENTS.md stays neutral, identical to the other sharing harnesses.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    frontmatter: "---\ntrigger: always_on\n---",
    title_block: `# AI-DLC on Antigravity

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Antigravity harness** (the Antigravity IDE and the Antigravity CLI \`agy\` share this install). The workspace shell ships in \`.agent/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Antigravity-native shortcuts expose \`/aidlc-status\`, \`/aidlc-jump --stage <slug>\` (or \`--phase <name>\`), and \`/aidlc-scope <name>\` through the same workflow. Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Antigravity**: the IDE, or the Antigravity CLI (\`agy\`). Both read this install's \`.agent/\` surfaces (rules, skills, agents, hooks).
- **A git repository**: Run \`git init\` in the project first if it is not a repository yet.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the shells Antigravity spawns.`,

    prereq_bullets_tail: "",

    agents_note: `On Antigravity each expert role is a native subagent (discovered from the persona files in \`.agent/agents/\`); the \`/aidlc\` session takes on those roles itself for most stages and hands work off via the \`invoke_subagent\` tool for the two delegated stages (2.1, 3.5). They ship without \`model:\` pins — every agent inherits your session model.`,

    structure_extra: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Antigravity. On Antigravity:

- Approval gates and questions render via Antigravity's native **\`ask_question\` modal tool** (or numbered prose fallback); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- Hooks ride \`.agent/hooks.json\` through the AIDLC adapter (\`.agent/hooks/aidlc-antigravity-adapter.ts\`): state-transition, reviewer read-scope, review-freeze, and plan-approval guards block via \`decision: "deny"\` before tools; audit and sensors cover write and edit; stage-graph rebuilds, human-turn recording, and stop-loop continuation run from the matching Antigravity hook events (\`SessionStart\`, \`PreInvocation\`, \`PreToolUse\`, \`PostToolUse\`, \`Stop\`).
- The AI-DLC method (\`aidlc/spaces/<space>/memory/*.md\`) reaches context through read instructions: \`.agent/rules/aidlc.md\` (\`trigger: always_on\`) always points to \`aidlc/active-memory/{org,team,project}.md\`, while four \`.agent/rules/phase-*.md\` (\`trigger: model_decision\`) files point to phase guidance when relevant.
- There is **no statusline** and **no welcome message**; use \`/aidlc-status\` (or \`/aidlc --status\`) and the progress lines at gates.

The Antigravity-specific guide (install, what differs, verification) is \`docs/guide/harnesses/antigravity.md\`.
`,

    sections_after_resumption: "",
  },
};

export default fills;
