# AI-DLC on Cursor

`dist/cursor/` is one of the framework's harness distributions, for
[Cursor](https://cursor.com). One tree serves both the **Cursor IDE** and the
**Cursor CLI** (`agent`): they share the same `.cursor/` discovery. One
deterministic core, many harnesses: the engine, state machine, audit log,
graph, swarm referee, and learnings gate are byte-identical across every
distribution - only the shell differs. The tree is **generated** from `core/` +
`harness/cursor/` by `bun scripts/package.ts cursor`; never hand-edit it (the
drift guard fails CI).

## Layout

Cursor is the most "native" port so far - it consumes the standard core
projection directly (no `emit.ts`, no split dot-dir). The distribution is:

- **`.cursor/`** - the framework tree. Cursor reads only a few subdirs as
  native meaning: `rules/` (one standing and four phase method pointers),
  `agents/` (the 14 personas as native subagents), `skills/` (the orchestrator,
  utility shortcuts, and generated stage runners), `hooks.json` + `hooks/`
  (the hook wiring and adapter), `cli.json` (permissions), and `mcp.json` (MCP
  servers, if you add one). The engine dirs beside them (`tools/`,
  `aidlc-common/`, `knowledge/`, `sensors/`, `scopes/`) are inert data to
  Cursor and safely share the directory.
- **`aidlc/`** - the workspace shell (the pre-built
  `aidlc/spaces/default/memory/` method tree the engine reads), a sibling of
  `.cursor/`.
- **`AGENTS.md`** - project-root ambient instructions Cursor auto-reads.

## Prerequisites

- **Cursor** - the IDE, or the Cursor CLI (install with
  `curl https://cursor.com/install -fsS | bash`; invoked as `agent`). Both read
  this install's `.cursor/` surfaces. Verified against cursor-agent 2026.07;
  hooks (`.cursor/hooks.json`) and skills (`.cursor/skills/`) are
  current-line features.
- **bun** - same requirement as every harness; every tool and hook runs via
  bun. `bun` must be on the PATH the shells Cursor spawns can see.
- **A paid Cursor plan for named models** - Free accounts can only use `Auto`.
  The tiered persona surfaces ship with **no model pins** (all tiers project to
  null on Cursor: model availability is plan-dependent), so every agent
  inherits your session model. Headless CLI runs that pass `--model` need a
  plan that allows it. Bedrock BYOK is IDE-only: static keys on Pro, an IAM role
  on Teams (doc-verified against Cursor's model settings, not live-verified
  here); the CLI routes models through Cursor's own backend.

## Install

1. Install the distribution into your project:

   ```bash
   bun dist/cursor/install.ts your-project
   ```

   The installer preflights the full copy, refuses project-owned collisions,
   preserves `.cursor/.gitignore` and existing method memory, structurally
   merges `.cursor/hooks.json` and `.cursor/cli.json`, and adds marked AI-DLC
   sections to existing `AGENTS.md` and `.gitignore` files instead of replacing
   them. It records framework ownership in `.cursor/aidlc-install.json`;
   re-running it upgrades managed files while preserving `aidlc/active-space`
   and explicit plugin selection/composed state, and reapplying that space to
   all mutable rule and persona pointers, including files restored after deletion.
   Plugin-composed stage files are preserved only when a contribution sidecar or
   seam sentinel identifies that stage, and the installer prints every managed
   path it preserves; unrelated core stages continue through normal receipt-hash
   collision/upgrade handling.
   The `aidlc/` shell ships the pre-built `aidlc/spaces/default/memory/` method
   tree the engine reads; `/aidlc --doctor` fails its "workspace shell ready"
   check without it.

2. Open the project in the Cursor IDE (or start `agent` in it) and run
   `/aidlc --doctor`, then `/aidlc` followed by what you want to build.
   Native utility shortcuts are `/aidlc-status`, `/aidlc-jump --stage <slug>`
   (or `--phase <name>`), and `/aidlc-scope <name>`.

## What's different on this harness

- **Questions render as numbered prose options** (no structured-question
  widget); the questions FILE with `[Answer]:` tags remains the source of
  truth.
- **Hooks ride `.cursor/hooks.json`** through the AIDLC adapter
  (`.cursor/hooks/aidlc-cursor-adapter.ts`), which maps Cursor's camelCase hook
  events (`sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `preToolUse`,
  `postToolUse`, `postToolUseFailure`, `preCompact`, `stop`) onto the byte-shared
  core hook bodies (run as bun subprocesses): human-turn recording on each human turn, the
  state-transition, reviewer read-scope, review-freeze, and plan-approval
  guards before a tool runs, audit +
  sensors on write/edit, failed-Task attribution cleanup, stage-graph rebuilds on
  shell, and state validation before compaction. The **PreToolUse guards**
  answer on Cursor's `{"permission":"allow"|"deny"}` stdout channel (`deny`
  may add `agent_message`) and register `failClosed: true`. Empty stdout is
  invalid JSON, so the IDE blocks the call; malformed input, a missing guard,
  or a crashing guard also denies the operation. Cursor names its shell tool `Shell`; the adapter
  maps it to the core hooks' `Bash`. Cursor's
    first-class `Delete` tool (unique to this harness - everywhere else deletion
    goes through the shell) is presented to the reviewer-scope guard as a write so a
    unit-scoped reviewer cannot delete a sibling unit's artifacts. Shell payloads'
    nested `cwd`/`working_directory` fields are promoted to the shared guard
    contract, so relative reads and writes are checked where Cursor will execute them.
- **Forwarding-loop enforcement is advisory.** Cursor's `stop` hook cannot
  refuse a stop, so when the core stop hook answers `block` the adapter surfaces
  a follow-up nudge instead (the same posture as opencode). Its host
  `loop_limit` is 10 rather than Cursor's default 5, which covers the core's
  autonomous no-progress cap of 8. The forwarding loop in the conductor skill
  is the real discipline.
- **A real session-end moment exists** (unlike Codex): `sessionEnd` fires, so
  `SESSION_ENDED` audit events are emitted. Pre-compaction validation also fires
  (`preCompact`).
- **Personas are native subagents.** The 14 persona `.md` files in
  `.cursor/agents/` are discovered by frontmatter `name`; the conductor adopts
  them inline for most stages and delegates via the `task` tool for the two
  subagent stages (2.1 reverse-engineering, 3.5 code-generation). Worker agents
  do not get the `task` tool, so a delegate cannot delegate again.
- **Subagent identity is reconstructed.** Cursor emits no per-subagent identity
  on hook payloads (its `subagentStart`/`subagentStop` events are documented but
  never fire on the CLI), so the adapter maintains a protected project-local
  runtime ledger under `aidlc/.aidlc-cursor-subagents/`: top-level conversations
  register themselves at `sessionStart`/`beforeSubmitPrompt`
  (subagent conversations get neither event), each Task spawn records its
  agent, and reviewer read-scope enforcement attributes calls from conversations
  that are not registered top-level sessions. A parent's next synchronous Task
  dispatch retires and logs its prior record (Cursor CLI emits no Task
  `postToolUse`); genuine cross-parent ambiguity stays conservative whenever a
  reviewer is live, so it cannot disable reviewer-scope enforcement. Delegated
  tools cannot access the ledger or dispatch record, including through ancestor
  deletes or unquoted shell glob/character-class paths; if attribution storage is
  missing or unreadable while a reviewer dispatch remains active, operations
  fail closed rather than escaping reviewer enforcement. Review delegates may
  use ordinary Shell commands, but general-purpose interpreters and dynamic
  command evaluation are denied; use Cursor's native read/search tools and let
  the parent conversation run executable probes.
- **Generated stage and scope runners are explicit-only.** Cursor receives
  `disable-model-invocation: true` on generated runner skills, including plugin
  runners, so ordinary coding prompts cannot auto-activate state-mutating
  workflow shortcuts.
- **Utility shortcuts are native skills.** `/aidlc-status`, `/aidlc-jump`, and
  `/aidlc-scope` improve slash-menu discovery without creating a second engine
  path. They all carry `disable-model-invocation: true`; Cursor invokes them
  only when the user chooses them. The legacy `.cursor/commands/` surface is
  not shipped.
- **Method rules are read instructions, not imports.** Cursor rules do not
  expand `@`-import lines. `.cursor/rules/aidlc.mdc` is always applied and
  points to the active space's org/team/project files; four
  `.cursor/rules/aidlc-phase-*.mdc` rules are agent-decided and point to the
  matching phase file only when relevant (live-verified on cursor-agent: a
  phase-framed prompt loads exactly the matching phase rule, an unrelated
  prompt loads none). The `sessionStart` hook separately
  injects live workflow context. `/aidlc space <name>` re-points all five rule
  files in place.
- **Construction swarm runs as task-tool fan-out only** (`AIDLC_USE_SWARM=1` is
  a loud no-op - no Workflow tool exists).
- **No statusline / welcome message** - use `/aidlc-status` (or
  `/aidlc --status`) and the progress lines at gates.
- **Tab autocomplete is untouched** by this install - it rides Cursor's own
  models regardless of configuration.
- **Permissions**: `.cursor/cli.json` pre-approves `Shell(bun)` only (a
  project-level `cli.json` carries permissions only); every other shell command
  follows your Cursor approval settings.
- **MCP servers**: none ship; configure your own under `.cursor/mcp.json` if
  needed.
- **Headless `agent -p` runs cannot pass approval gates.** The human-presence
  mint rides `beforeSubmitPrompt`, which Cursor fires only for an interactive
  submission (verified against cursor-agent 2026.07) - so a print-mode run
  records no `HUMAN_TURN` and a gated stage refuses its approval by design,
  rather than letting an unattended model approve its own work. Use headless
  mode for the read-only utilities (`--status`, `--doctor`, `--version`) and for
  autonomous Construction (which is exempt because it has no human at the gate);
  run gated workflows in an interactive Cursor session. This is a property of
  the framework's presence gate, not a Cursor limitation - every harness mints
  presence from a human-prompt event.

## Verifying an install

```bash
bun .cursor/tools/aidlc-utility.ts doctor        # all checks pass on a fresh copy
agent -p "/aidlc --status" --output-format text --trust   # /aidlc --status through the CLI
```

The doctor's Cursor-specific checks: the hook wiring at `.cursor/hooks.json`,
the `Shell(bun)` permission pre-approval at `.cursor/cli.json`, the standing
rule at `.cursor/rules/aidlc.mdc`, and all four phase-rule pointers.

> **Scripting trap: Cursor CLI always exits 0.** Headless `agent -p "<prompt>"
> --output-format text --trust` returns exit code 0 even when the run errors, so
> a CI check must assert on the emitted text, never on the exit status. Named
> models (`--model`) need a paid plan; without one, use `Auto`.

## Next steps

Installed and verified? The methodology is the same on every harness - keep
going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) - an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) - the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) - right-sizing a run.
- [Glossary](../glossary.md) - every term defined.

Other harnesses: [AI-DLC on opencode](opencode.md) · [the harness family index](README.md).
