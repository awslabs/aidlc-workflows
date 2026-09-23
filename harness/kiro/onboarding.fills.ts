// harness/kiro/onboarding.fills.ts — the Kiro row's onboarding-doc fills.
// One row serves Kiro IDE and Kiro CLI, so this text must not name one of them
// as if it were the harness. It renders into the native onboarding file, which is
// always loaded - a false sentence here is read every session.
// The packager fills core/templates/onboarding-harness.md into
// dist/kiro/.kiro/steering/aidlc-onboarding.md, loaded by agent resources.
// The root AGENTS.md stays neutral, identical to the other sharing harnesses.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    // Kiro IDE reads `.kiro/steering/*.md` only with this frontmatter; the CLI
    // reaches the same file through the aidlc agent's steering resource glob,
    // which already loads aidlc-active-memory.md carrying the identical block.
    frontmatter: "---\ninclusion: always\n---",

    title_block: `# AI-DLC on Kiro

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Kiro harness** (Kiro IDE or Kiro CLI). The workspace shell ships in \`.kiro/\` (no setup command); describe what you want to build and it sets up the workflow for you. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume, \`/aidlc --review <class>\` to cap stage reviews (adversarial, advisory, none). Run \`/aidlc compose "<task>"\` to get a plan tailored to that task (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Kiro IDE**, or **Kiro CLI ≥ 2.21.1** (\`kiro-cli --version\`): the hook, skill and agent features this install relies on (a \`Stop\` trigger — advisory here, since it cannot refuse a turn on either surface — PreToolUse/PostToolUse matchers, and \`.kiro/skills/\` slash commands). Either surface reads the same \`.kiro/\` tree. That floor is where the engine pin below was measured, not where the engine first appeared — the CLI has carried it behind \`kiro-cli --v3\` since 2.8.0, so an older 2.x can enter it with that flag, untested by us.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the non-interactive shells the harness spawns — these source \`~/.zshenv\` (zsh) or \`~/.bashrc\` (bash), NOT \`~/.zshrc\`.
- **Activation**: this install ships \`.kiro/settings/cli.json\`, **read by the Kiro CLI only — the IDE ignores it**. It pins the agent engine, sets \`chat.defaultAgent: "aidlc"\`, and carries one conditional reasoning-effort default (\`xhigh\` on \`claude-opus-4.8\`, inert on any other model), so a plain \`kiro-cli\` in this project uses the AI-DLC agent and \`/aidlc\` just works. **Note: that workspace default takes precedence over any global default agent you have configured**; if you prefer your own, delete the line and start sessions with \`kiro-cli chat --agent aidlc\` instead. In the IDE none of that applies — pick the \`aidlc\` agent in the chat panel.
- **Permissions**: the \`aidlc\` agent pre-approves the dispatcher's engine routes (\`bun .kiro/tools/aidlc.ts engine …\`) and four exact \`date -u\` timestamp spellings, writes under \`aidlc/spaces/\` and \`.kiro/sensors/\`, and spawning the framework's own personas; \`rm -rf\` and \`git push\` are denied outright, and everything else prompts — the dispatcher's other routes (\`config\`, \`compose\`, \`intent\`, \`space\`) included, deliberately. There is no blanket shell trust, and each delegated persona carries its own narrower allowlist. **Two limits are enforced by a hook rather than by those patterns, because a pattern cannot express either one, and both are final — there is no approval prompt behind them.** A pre-approved command must be ONE simple command: chaining, backgrounding, command substitution, redirection, and newline-separated commands are refused, with a single trailing \`2>&1\` as the only exception. A pattern ending in a wildcard matches any trailing text and this engine generation does not treat those characters as command boundaries, so a redirection would otherwise write a file without ever presenting as a file write. And a tool call must name a shipped tool directly, as \`.kiro/tools/<tool>.ts\`: a path that leaves that directory, or a filename this build did not ship, is refused even though the configured pattern appears to cover it, because a shell-pattern wildcard matches a path separator and is not canonicalized first. If you need a command's output in a file, run the command and write the file with a file tool. On the IDE, **Agent Autonomy** applies before any of this: Supervised mode prompts regardless of what is pre-approved here. Start Kiro from the project root so those relative tool paths resolve correctly. In \`--no-interactive\` runs, a command that would prompt is refused because no approver is present. \`--trust-all-tools\` bypasses the deny list too; use it only in a disposable sandbox.`,

    prereq_bullets_tail: "",

    agents_note: `On Kiro the \`/aidlc\` session runs from \`agents/aidlc.md\`; all 14 ship as Markdown agents alongside it, and the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests run through Kiro's delegation tools, while inline-stage personas are adopted in-context.`,

    structure_extra: "",

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto Kiro. On Kiro:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **subagent fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- Session-end and pre-compaction audit events (\`SESSION_ENDED\`, \`SESSION_COMPACTED\`) are not emitted — Kiro's \`Stop\` trigger fires at the end of every turn, not at conversation close, so there is no genuine session-end moment to hook.
- **MCP servers**: two ship in \`.kiro/settings/mcp.json\` — \`context7\` and \`aws-knowledge-mcp-server\`, both keyless HTTP and both disabled by default. Flip \`"disabled": false\` on each server you want to enable. This row ships no uvx launcher: an entry that spawns a local process from a floating package version is a heavier default than a row serving both surfaces wants, and the knowledge server covers the AWS documentation case over plain HTTP. Context7 is keyless on Kiro because Kiro sends configured HTTP header values verbatim instead of expanding environment placeholders. All 14 delegated personas opt in through \`includeMcpJson: true\` plus \`@<server>\` tool grants; the conductor gets none.
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between Claude Code and Kiro installs (supported but untested — keep both \`.claude/\` and \`.kiro/\` in sync via the framework's packaging if you do this).

The Kiro-specific guide (install, what differs, the live journey test) is \`docs/guide/harnesses/kiro.md\`. This install ships the workspace shell only and carries no \`docs/\` tree: every \`docs/…\` path cited here, and in the shipped skills, protocols, and tools, names a file in the AI-DLC Workflows repository rather than one beside you.
`,

    sections_after_resumption: "",
  },
};

export default fills;
