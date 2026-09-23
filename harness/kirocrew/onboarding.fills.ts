// harness/kirocrew/onboarding.fills.ts — Kiro Crew's onboarding-doc fills.
// The packager fills core/templates/onboarding-harness.md into
// dist/kirocrew/.kiro/steering/aidlc-onboarding.md, loaded by agent resources.
// The root AGENTS.md stays neutral, identical to the other sharing harnesses.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# AI-DLC on Kiro Crew

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Kiro Crew harness**. Kiro Crew is an autonomous agent-management layer that drives the Kiro CLI, so this shell IS the Kiro CLI shell (it ships in \`.kiro/\`, no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Kiro CLI ≥ 2.6**: Kiro Crew runs \`kiro-cli chat\` under its gateway, so the same hooks/skills/agent features apply (stop hook with blocking, preToolUse/postToolUse matchers, \`.kiro/skills/\` slash commands, workspace \`chat.defaultAgent\`), all shipped in the 2.x line. Check the underlying CLI with \`kiro-cli --version\`.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on the PATH of the non-interactive shells the harness spawns — under Kiro Crew those are the gateway's hook subprocesses, whose PATH is the gateway environment's, NOT your interactive \`~/.zshrc\`.
- **Hook registration via \`*.sh\` autoimport**: Kiro Crew's gateway rebuilds its agent config from its own controlled sources and does NOT read a project's \`.kiro.hook\` manifests or agent-JSON \`hooks\` block. Its sanctioned inlet for external hooks is \`*.sh\` autoimport from \`~/.kiro/hooks\` — an executable \`*.sh\` with a \`# event:\` header (or a \`-pre/-post/-prompt/-stop.sh\` suffix). \`aidlc config\` ships the AI-DLC lifecycle hooks as such shims (in \`.kiro/hooks/\`) and installs them into \`~/.kiro/hooks\`; the gates then fire via Kiro Crew's exit-2 deny contract. This takes effect on the gateway's next (re)load, so **restart the gateway once after \`aidlc config\`** (\`kirocrew restart\`). Do NOT hand-edit the gateway's \`~/.kiro/crew/hooks.json\` API store — the running gateway owns it and reconciles a hand-added entry away; the \`*.sh\` autoimport files are the durable path.
- **Activation**: this install ships \`.kiro/settings/cli.json\` setting \`chat.defaultAgent: "aidlc"\`, so a Kiro Crew session in this project uses the AI-DLC conductor agent and \`/aidlc\` just works. **Note: the workspace default takes precedence over any global default agent you have configured.** If you prefer your own default, delete that settings line and start sessions with the \`aidlc\` agent explicitly instead.
- **Permissions**: the \`aidlc\` agent pre-approves ONLY project-relative \`bun .kiro/tools/<tool>.ts\` calls (including the \`bun run\` and quoted-path spellings), \`date -u\`, and its listed read-only native tools; everything else prompts. There is no blanket shell trust. Start the session from the project root so those relative tool paths resolve correctly. In unattended runs, a command that would prompt is refused because no approver is present.`,

    prereq_bullets_tail: "",

    agents_note: `On Kiro Crew the \`/aidlc\` session runs from \`agents/aidlc.json\`; all 14 expert roles have JSON configs, and the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests run through the Kiro \`subagent\` tool, while inline-stage personas are adopted in-context.`,

    structure_extra: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Kiro Crew. Because Kiro Crew drives the Kiro CLI, the shell behaves like the Kiro CLI harness, with these Kiro Crew specifics:

- **Hooks fire from \`*.sh\` autoimport, not the gateway API store.** Kiro Crew's gateway rebuilds the agent config from its own sources, so a project's \`.kiro.hook\` manifests and agent-JSON \`hooks\` block are inert here. \`aidlc config\` instead ships the lifecycle hooks as executable \`*.sh\` shims and installs them into \`~/.kiro/hooks\`, which the gateway autoimports into the agent-config \`hooks\` block the underlying kiro-cli fires — the same door native Kiro CLI uses for hooks, so the plan-approval and review guards hard-block via the exit-2 deny contract. Restart the gateway once after \`aidlc config\` so it picks the shims up. (The gateway \`~/.kiro/crew/hooks.json\` API store is gateway-owned and reconciles hand-added entries away; the \`*.sh\` shims are the durable inlet.)
- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- Session-end and pre-compaction audit events (\`SESSION_ENDED\`, \`SESSION_COMPACTED\`) are not emitted — the Kiro CLI has no hooks for those moments.
- **MCP servers**: five ship in \`.kiro/settings/mcp.json\`, all disabled by default. Flip \`"disabled": false\` on each server you want to enable. Context7 is keyless because the Kiro CLI sends configured HTTP header values verbatim instead of expanding environment placeholders. All 14 delegated personas opt in through \`includeMcpJson: true\` plus \`@<server>\` tool grants; the conductor gets none.
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code, Kiro CLI, and Kiro Crew installs (supported but untested — keep the trees in sync via the framework's packaging if you do this).

The Kiro Crew-specific guide (install, what differs, the live journey) is \`docs/guide/harnesses/kirocrew.md\`.
`,

    sections_after_resumption: "",
  },
};

export default fills;
