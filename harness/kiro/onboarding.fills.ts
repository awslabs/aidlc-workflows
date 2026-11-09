// harness/kiro/onboarding.fills.ts — Kiro CLI's onboarding-doc fills.
// The packager fills core/templates/onboarding-harness.md into
// dist/kiro/.kiro/steering/aidlc-onboarding.md, loaded by agent resources.
// The root AGENTS.md stays neutral, identical to the other sharing harnesses.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# AI-DLC on Kiro CLI

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Kiro CLI harness**. The workspace shell ships in \`.kiro/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Kiro CLI ≥ 2.6**: the hooks/skills/agent features this install relies on (stop hook with blocking, preToolUse/postToolUse matchers, \`.kiro/skills/\` slash commands, workspace \`chat.defaultAgent\`) shipped in the 2.x line. Check with \`kiro-cli --version\`; \`/aidlc --doctor\` warns about an older one.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. Its hooks run with the PATH of the terminal you start \`kiro-cli\` from, so \`bun --version\` working there is enough; \`/aidlc --doctor\` checks it.
- **Activation**: this install ships \`.kiro/settings/cli.json\` setting \`chat.defaultAgent: "aidlc"\`, so \`kiro-cli --v2\` (Kiro CLI 2.21.4 or later; for an older one, see the AI-DLC Kiro CLI guide) in this project starts the AI-DLC agent on Kiro CLI's V2 engine and \`/aidlc\` just works. **Note: the workspace default takes precedence over any global default agent you have configured.** If you prefer your own default, delete that settings line and start sessions with \`kiro-cli --v2 --agent aidlc\` instead.
- **Kiro CLI engine**: this install is for Kiro CLI's V2 engine, and nothing in it tells you which engine this chat runs on. \`kiro-cli --v2\` starts the V2 engine (Kiro CLI 2.21.4 or later) and \`kiro-cli --v3\` the v3 engine; a plain \`kiro-cli\` follows Kiro CLI's own engine setting. In a Kiro CLI chat, when the person asks which engine it runs on, or whether to switch, and has not said how they started it, tell them which command starts which engine. Kiro IDE and Kiro CLI on its v3 engine are the Kiro harness (\`--harness kiro\`, Kiro CLI 2.24.1 or later), not this one. On the v3 engine this install's hooks run only when Kiro has rewritten this install's agent files for that engine; otherwise the chat runs on Kiro's Default agent, which cannot record the person's answers, so AI-DLC refuses every approval and confirmation there until the project is switched to Kiro or the chat runs on the V2 engine. When the person asks to switch this project to Kiro, the switch is \`{{INVOKE}} config --harness kiro --yes\`: it switches \`.kiro/\` to Kiro in place and keeps \`aidlc/\` (an AI-DLC release older than this project's may refresh Kiro CLI (V2) instead, and its output says which). With \`--yes\` it also takes AI-DLC's recommended answer to each Kiro setting AI-DLC has neither asked about nor been given an answer for on this machine, settings that apply to all the person's projects: it turns Kiro IDE's and Kiro CLI's Workflows feature off when it is on (AI-DLC's reviews and helpers do not run with it on), and on Windows it sets Kiro IDE's terminal to PowerShell when it is Command Prompt. So before you run it, tell them in one line that it may download the AI-DLC release files it rebuilds \`.kiro/\` from, and may change these Kiro settings for all their projects (Workflows off in Kiro IDE and in Kiro CLI; on Windows, Kiro IDE's terminal to PowerShell), and run the switch only once they have agreed with that line in front of them; when you offer the switch yourself, say it in the same reply. If the switch then stops saying that switching \`.kiro\` needs the release files (a copy install, which holds only its own tree), the \`fix:\` command it names adds \`--download\` to the same switch: run it at once. For any other step it names (a dry run whose plan is then applied with the \`--plan-token\` it prints), say what it printed and carry out each step only once they agree to what it says. Once it has switched, say what it printed, and in a Kiro CLI chat only the Kiro CLI part of its next step, which the person does after quitting this chat; after that, run no other AI-DLC command in this chat.
- **Permissions**: the \`aidlc\` agent pre-approves ONLY AI-DLC's own project-relative workflow commands (including the \`bun run\` and quoted-path spellings): \`bun .kiro/tools/aidlc.ts engine ...\`, the read-only \`doctor\`, \`version\`, \`--doctor\`, \`status\`, \`config <section> --show --json\` and \`config <section> --help\`, and the \`bun .kiro/tools/aidlc-<tool>.ts\` tool scripts; plus its listed read-only native tools. Every other command prompts, including a \`config\` change and the commands that change the machine's AI-DLC install (\`use\`, \`update\`, \`rollback\`, \`uninstall\`, \`system\`). There is no blanket shell trust. Start Kiro from the project root so those relative tool paths resolve correctly. In \`--no-interactive\` runs, a command that would prompt is refused because no approver is present. \`--trust-all-tools\` runs every command without asking, a \`git push\` and a recursive delete included; use it only in a disposable sandbox.
- **Project writes**: apart from those commands, the developer and \`aidlc\` agents also write project files without asking when the path's top-level name does not start with a dot, and in a side-by-side build the files in each Unit's checkout under \`.aidlc/worktrees/<unit>/\` by the same rule (on Kiro CLI's v2 engine, the checkout's dot folders too); writes into \`.kiro/\` (other than the \`aidlc\` agent's own \`.kiro/sensors/\` files), \`.git/\`, other top-level dot entries, or outside the project prompt.`,

    prereq_bullets_tail: "",

    agents_note: `On Kiro the \`/aidlc\` session runs from \`agents/aidlc.json\`; all 14 expert roles have JSON configs, and the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests run through the Kiro \`subagent\` tool, while inline-stage personas are adopted in-context.`,

    structure_extra: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Kiro CLI. On Kiro:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- Session-end and pre-compaction audit events (\`SESSION_ENDED\`, \`SESSION_COMPACTED\`) are not emitted — Kiro has no hooks for those moments.
- **MCP servers**: five ship in \`.kiro/settings/mcp.json\`, all disabled by default. Flip \`"disabled": false\` on each server you want to enable. Context7 is keyless on Kiro because Kiro sends configured HTTP header values verbatim instead of expanding environment placeholders. AI-DLC's own chat and its 14 delegated personas get every server in this file and in your \`~/.kiro/settings/mcp.json\` as of the last time config ran, and each call asks you first; a server you add later reaches them after you run config again. On Kiro CLI's v3 engine a persona gets every server in those files without a config run, from its second step.
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and Kiro CLI installs (supported but untested — keep both \`.claude/\` and \`.kiro/\` in sync via the framework's packaging if you do this).

The Kiro-specific guide (install, what differs, the live journey test) is the Kiro CLI (V2) section of the Kiro guide, \`docs/guide/harnesses/kiro.md#kiro-cli-v2\`.
`,

    sections_after_resumption: "",
  },
};

export default fills;
