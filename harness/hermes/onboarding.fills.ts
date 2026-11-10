// harness/hermes/onboarding.fills.ts — Hermes Agent's onboarding-doc fills.
// The packager fills core/templates/onboarding-harness.md (then the neutral
// onboarding) into the project-root `.hermes.md`, Hermes's always-on project
// context file, with .hermes token projection.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/skill aidlc",
  slots: {
    title_block: `# AI-DLC on Hermes Agent

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Hermes Agent** harness. The workspace shell ships in \`.hermes/\` (no setup command beyond approving the project's skills); describe what you want to build and it sets up the workflow for you. Type \`/skill aidlc\` to load the conductor, then describe the work. Everything the conductor runs is an engine command in the \`terminal\` tool: \`{{INVOKE}} --doctor\` validates the setup, \`{{INVOKE}} --version\` prints the framework version, \`{{INVOKE}} engine orchestrate next --stage <slug>\` jumps to a stage, \`--phase <name>\` jumps to a phase, \`--depth <level>\` overrides depth, \`--test-strategy <level>\` overrides test volume, and \`--review <class>\` caps stage reviews (adversarial, advisory, none). \`{{INVOKE}} engine orchestrate next compose "<task>"\` returns a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Hermes Agent**: \`hermes --version\` works (verified against v0.21.7). The CLI, the desktop app, and the gateway all run this same install: the harness is the project tree, not a particular surface.
- **A git repository**: Hermes finds the project root at the git root and only reads project skills from a trusted repository. Run \`git init\` first if the folder is not a repository, then run \`hermes skills trust\` once in the project so Hermes discovers \`.hermes/skills/aidlc\`.
- **bun 1.4.4 or newer** (copy channel) or the native \`aidlc\` command (release channel): the CLI tools that track progress, write the decision log and decide what runs next are TypeScript. The copy projection runs them through \`bun .hermes/tools/aidlc.ts\`; a native install runs them through \`aidlc\`. \`bun\` must be on the PATH of the shell Hermes's \`terminal\` tool starts.
- **Approvals**: Hermes asks before commands it judges destructive; AI-DLC's own engine commands are ordinary \`bun\`/\`aidlc\` invocations and normally run without a prompt. Keep \`approvals.mode\` at its default when a workflow needs its approval gates to stand.`,

    prereq_bullets_tail: `- **Hooks**: AI-DLC ships no hook wiring for Hermes. Hermes's shell hooks live in the person's own \`~/.hermes/config.yaml\` (they are not project-scoped), so a project install cannot register them; the engine's directives and this skill's prose bounds govern instead. Treat the automatic guards as advisory here: the review freeze, the reviewer read scope, and the plan-approval check are enforced by the workflow's own steps and by you, not by a hook that can refuse a tool call.`,

    agents_note: `On Hermes the persona files in \`.hermes/agents/\` are read by the conductor and adopted inline; the conductor hands a delegated stage (2.1, 2.2, 2.4, 3.5), a reviewer pass or a composer request to the \`delegate_task\` tool with that persona and the stage's brief in the child's context. Children run with their own terminal session and toolset and cannot delegate further (leaf role).`,

    structure_extra: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Hermes Agent. On Hermes:

- The entry is \`/skill aidlc\` (Hermes has no user-defined slash commands), and every engine call runs through the \`terminal\` tool.
- Approval gates and questions render as **numbered prose options**; no structured-question widget is wired, and the questions file with \`[Answer]:\` tags remains the source of truth.
- **Hooks are not wired**: Hermes keeps shell hooks in the person's own \`~/.hermes/config.yaml\`, outside the project, so this install registers none. The forwarding loop (asking the engine for the next step until a gate or a completion) is the skill's prose discipline, and the guards that other harnesses enforce before a tool call are advisory here.
- The AI-DLC method (\`aidlc/spaces/<space>/memory/*.md\`) reaches context because this file tells you to read it and because every stage directive carries its own \`rules_in_context\`. Edit the active space's memory files, never a copy.
- Subagent work uses \`delegate_task\`; there is no native subagent registry and no statusline. Surface progress with the progress line after each gate and \`{{INVOKE}} --status\` on demand.
- Hermes marks every command its agent runs with \`AI_AGENT=hermes-agent\`, which is how a multi-harness project tells this tree's commands apart.
- **MCP servers**: none ship; configure your own with \`hermes mcp add\` if a stage needs one.
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between harness installs (supported but untested — keep the trees in sync via the framework's packaging if you do this).

The Hermes-specific guide (install, what differs, verification) is \`docs/guide/harnesses/hermes.md\`.
`,

    sections_after_resumption: "",
  },
};

export default fills;
