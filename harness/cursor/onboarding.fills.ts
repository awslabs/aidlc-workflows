// harness/cursor/onboarding.fills.ts — Cursor IDE's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/cursor/AGENTS.md (project root — Cursor auto-reads AGENTS.md as its
// primary rules file). The packager applies {{HARNESS_DIR}} → .cursor to the
// rendered output afterwards, so slot bodies use the token, never a literal
// `.cursor`.
//
// Modeled on harness/codex/onboarding.fills.ts and harness/opencode/onboarding.fills.ts.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# AI-DLC on Cursor

This project uses AI-DLC (AI-Driven Development Life Cycle) under the **Cursor**
harness (Cursor IDE, cursor-agent CLI, and cloud agents all read the same
\`{{HARNESS_DIR}}/\` surfaces). Invoke the orchestrator by typing \`/aidlc\` in
Cursor chat, followed by a scope or a plain-English description of what to build
(scope is auto-detected). The deterministic engine, state machine, audit log, and
referee are byte-identical to every other harness distribution; only the shell
differs. Run \`/aidlc-status\` for progress, \`/aidlc --help\` for usage,
\`/aidlc --doctor\` to validate setup, \`/aidlc-jump\` to move to a stage or
phase, and \`/aidlc-scope\` to set the scope. Run \`/aidlc compose "<task>"\` to
have the adaptive composer propose a tailored EXECUTE/SKIP plan (up front, from a
scan report via \`--report <path>\`, or mid-workflow to re-shape the pending
stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Cursor ≥ 3.11**: the hook surface this install relies on (\`beforeSubmitPrompt\` for cloud-compatible session init, \`beforeShellExecution\`, \`preToolUse\`, \`afterFileEdit\`, \`subagentStop\`, \`preCompact\`, \`stop\`) and the folder-per-rule \`{{HARNESS_DIR}}/rules/<name>/<name>.mdc\` format are current-line features. Check with \`cursor --version\`.
- **bun**: Required for the CLI tools and hook scripts (state management, audit logging, orchestration engine). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the non-interactive shells Cursor spawns.
- **Model provider**: Cursor selects the model via its own UI picker — pick an Anthropic Claude model. The harness pins no model; the tiered personas request the Claude tier projection and Cursor honors your picker selection.`,

    prereq_bullets_tail: `- **Permissions**: \`{{HARNESS_DIR}}/cli.json\` (read by cursor-agent) pre-allows the deterministic core's command prefixes — \`bun *\` and the safe \`git add\`/\`commit\`/\`status\`/\`log\`/\`diff\` verbs — and denies destructive, history-rewriting, network, and privilege-escalation commands (\`rm -rf\`, \`git push\`, \`git reset --hard\`, \`curl\`, \`wget\`, \`sudo\`). In the IDE the \`beforeShellExecution\` hook additionally gates shell commands against the workflow state (fail-closed).
- **Personal overrides**: keep machine-specific settings (model choice, provider credentials) in your Cursor user settings rather than the shared project surfaces.`,

    agents_note: `On Cursor all 14 agent personas ship in \`{{HARNESS_DIR}}/agents/\` (the conductor reads the persona \`.md\` bodies as prose); reviewer passes and dispatched-stage workers run through Cursor's subagent mechanism, tracked via the \`subagentStop\` hook.`,

    structure_extra: "",

    guide_pointer: `The Cursor-specific guide (install, hooks, rules, what differs, verification) is \`docs/guide/harnesses/cursor.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness — one deterministic engine, state machine, audit trail, and stage set, rendered onto Cursor. On Cursor:

- **Rules** ship as folder-per-rule \`{{HARNESS_DIR}}/rules/<name>/<name>.mdc\` files with YAML frontmatter (NOT the legacy single-file \`.cursorrules\`): \`aidlc-method\` is always applied (org + team + project), and the four \`aidlc-phase-*\` rules are agent-decided (loaded when the workflow enters that phase).
- **Session init** rides \`beforeSubmitPrompt\` (not \`sessionStart\`) so it works identically in Cursor IDE, cursor-agent CLI, and cloud agents; a first-prompt marker prevents duplicate session-start fires.
- **Hooks** ride the \`{{HARNESS_DIR}}/hooks/aidlc-cursor-adapter.ts\` shim, which bridges Cursor's JSON permission-deny contract onto the core Claude-shaped exit-code-2 hook bodies: the state-transition guard and reviewer read-scope gate are fail-closed; audit, sensors, subagent tracking, and pre-compaction state validation are advisory (fail-open).
- **Self-correction** rides the \`stop\` hook, which maps a core \`decision:block\` to a Cursor \`followup_message\`, capped by \`loop_limit\` in \`hooks.json\`.
- **Gates and questions** render as numbered-prose options; the questions FILE with \`[Answer]:\` tags remains the source of truth.
- **The AIDLC method** (the layered practice files \`org.md\`, \`team.md\`, \`project.md\`, and the per-phase \`phases/<phase>.md\`) lives once at the workspace root under \`aidlc/spaces/<active-space>/memory/\` — the single hand-editable source of truth, identical on every harness. The \`{{HARNESS_DIR}}/rules/\` \`.mdc\` layers are a GENERATED transposition of that method for Cursor's rule surface; edit the method under \`aidlc/spaces/<space>/memory/\`, never the generated \`.mdc\` files.
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
