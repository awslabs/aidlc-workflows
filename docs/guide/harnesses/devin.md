# AI-DLC on Devin

`dist/devin/` is one of the framework's harness distributions, for
[Devin](https://devin.ai). One tree serves both the **Devin CLI** (terminal) and
**Devin Desktop**'s "Devin Local" agent, which the vendor documents as the same
agent harness reading the same project files. One deterministic core, many
harnesses: the engine, state machine, audit log, graph, swarm referee, and
learnings gate are byte-identical across every distribution - only the shell
differs. The tree is **generated** from `core/` + `harness/devin/` by
`bun scripts/package.ts`; never hand-edit it (the drift guard fails CI).

Two Devin surfaces are deliberately **not** targets:

- **Cascade**, the legacy agent inside the same IDE (Windsurf was rebranded to
  Devin Desktop in June 2026). It reads different files, and per the 2026-08-07
  release notes it is disabled by default for enterprises.
- **Devin Cloud**, which is **untested here**. Cloud runs one active skill at a
  time, has no repo hooks, and has no subagents - three assumptions this
  distribution relies on. Nothing in this chapter should be read as a Cloud
  claim.

## Layout

Devin is the closest peer to Claude Code of any harness, so the layout reads
almost identically to `dist/claude/`:

- **`.devin/`** - the framework tree. Devin reads a few subdirs as native
  meaning: `skills/` (the orchestrator, session skills, and generated stage
  runners - 42 in all), `agents/` (the 14 personas as subagents), `hooks/` plus
  `hooks.v1.json` (the hook wiring and adapter). The engine dirs beside them
  (`tools/`, `aidlc-common/`, `knowledge/`, `sensors/`, `scopes/`) are inert
  data to Devin and safely share the directory.
- **`aidlc/`** - the workspace shell (the pre-built
  `aidlc/spaces/default/memory/` method tree the engine reads), a sibling of
  `.devin/`.
- **`AGENTS.md`** - project-root ambient instructions Devin auto-reads, and the
  surface that names the method layers.

Two Devin paths this manifest does **not** use: `.devin/workflows/` (Cascade
only - Devin CLI and Devin Local never read it) and `.agents/skills/` (a valid
cross-vendor path, but `.devin/skills/` is already read by every targeted
surface; shipping both would surface each skill twice with location prefixes,
because Devin stopped deduplicating same-named skills in CLI v3000.2.17).

## Prerequisites

- **Devin CLI, or Devin Desktop** - both read this install's `.devin/`
  surfaces. Facts in this chapter were measured against CLI v3000.4.25 and
  re-verified on **3000.6.7** unless a different version is named. Devin
  auto-updates, so `/aidlc --doctor` checks a floor of 3000.3.22 — below that no
  hook can refuse a tool call.
- **bun** - same requirement as every harness; every tool and hook runs via
  bun. `bun` must be on the PATH the shells Devin spawns can see.
- **An Opus-class model for the orchestrator.** The conductor skill is a ~25 KB
  instruction set. SWE-1.6 was observed paraphrasing it back rather than
  executing step 1; the judgment-tier personas are pinned to `opus` at build
  time for the same reason (see below).

## Install

1. Copy the distribution into your project:

   ```bash
   cp -R dist/devin/.devin dist/devin/aidlc your-project/
   cp dist/devin/AGENTS.md your-project/          # see the collision note below
   ```

   The `aidlc/` shell ships the pre-built `aidlc/spaces/default/memory/` method
   tree the engine reads; `/aidlc --doctor` fails its "workspace shell ready"
   check without it. Copy or merge the AI-DLC section of
   `dist/devin/.gitignore` into your project's `.gitignore`.

   > **If your project already has an `AGENTS.md` or a `.gitignore`, do not
   > overwrite them.** MERGE the shipped content in. A plain copy over an
   > existing `AGENTS.md` silently destroys whatever instructions the project
   > already relied on. There is no `install.ts` for this harness yet, so this
   > step is yours to get right.

2. Start Devin in the project and run `/aidlc --doctor`, then `/aidlc` followed
   by what you want to build.

## What's different on this harness

- **Devin imports Claude Code's configuration by default - including its hooks.**
  Every key in `read_config_from` defaults to **true**. The `claude` key covers
  rules (`CLAUDE.md`, `~/.claude/CLAUDE.md`), skills
  (`.claude/skills/**/SKILL.md`), commands (`.claude/commands/**`, imported as
  skills), and MCP servers - and, per the hooks overview's "Where Hooks Live",
  **hooks too**: `.claude/settings.json`, `.claude/settings.local.json`,
  `~/.claude.json`, `~/.claude/settings.json` and `~/.claude/settings.local.json`
  are hook sources "loaded when `read_config_from.claude` is enabled (the
  default)". The read-config-from reference table omits hooks; it is incomplete.
  **So do not install this distribution into a project that already carries the
  AI-DLC Claude Code install** - both hook sets would load and each audit event
  would be written twice. One harness per project.
  Measured on CLI v3000.4.25: `devin rules list` in an empty directory still
  reported `CLAUDE [Claude] always-on` resolving to `~/.claude/CLAUDE.md`, so on a
  machine that has run Claude Code your personal global instructions are always-on
  in every Devin session. This distribution does **not** ship
  `{"read_config_from": {"claude": false}}` - narrowing that is your call, not the
  framework's. Note also that `AGENTS.md` is governed by the separate
  `agents_standard` key, so disabling `claude` alone would not stop it loading.
- **Hooks ride `.devin/hooks.v1.json`** through the AIDLC adapter
  (`.devin/hooks/aidlc-devin-adapter.ts`). Devin uses Claude Code's hook JSON
  *shape* and its "exit 2 blocks, reason on stderr" convention, so the core hook
  bodies need no change - but it uses its own **lowercase snake_case tool
  names** (`exec` not `Bash`, `edit` not `Edit`, `run_subagent` not `Task`,
  `todo_write` not `TaskUpdate`). Renaming only the matchers would not be
  enough: three core hooks compare `tool_name` *internally*
  (`aidlc-review-freeze.ts`, `aidlc-reviewer-scope.ts`,
  `aidlc-state-transition-guard.ts`), so they would load, match, and silently
  no-op - enforcement that looks installed and does nothing. The adapter
  translates the names before the core body sees them. In `hooks.v1.json`
  specifically the hooks object **is** the whole file; there is no `"hooks"`
  wrapper key.
- **Seven hook events are wired**: `SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostCompaction`, and `Stop`.
  Devin also has `PermissionRequest`, which AI-DLC does not use.
- **Two events do not exist on Devin. Neither weakens enforcement**, and it is
  worth being precise about what each actually costs:
  - **No `SubagentStop`.** `SUBAGENT_COMPLETED` is instead emitted from
    `PostToolUse` on `run_subagent` (live-verified: the event lands
    in the audit shard, attributed to the profile that ran). That covers
    **foreground** delegates, where the parent waits and the tool result *is* the
    completion; a **backgrounded** delegate is not individually audited, because
    its tool call has already returned. `read_subagent` is deliberately *not*
    wired: it is a poll an agent may repeat on the same delegate, and the audit
    ledger is append-only with no per-delegate key, so each read would append a
    duplicate completion attributed to `unknown` (a poll payload carries no agent
    type). Auditing a backgrounded delegate needs a real completion signal, which
    Devin does not currently provide. It does **not** weaken reviewer read-scope,
    which identifies a reviewer from the on-disk dispatch record
    (`<record>/.aidlc-reviewer-dispatch.json`), not from a subagent event - so the
    guard behaves identically here. Cursor also ships without a working subagent
    stop event.
  - **No `PreCompact`.** Devin has `PostCompaction`, which fires after a
    successful compaction. In practice this costs very little: the core
    compaction hook does not veto anything on *any* harness - it writes a health
    heartbeat, checks the state file's sections, drops a recovery breadcrumb, and
    emits `SESSION_COMPACTED`. Everything it reads is on disk, not in the
    conversation, so running afterwards still reads the same bytes; only the audit
    timestamp lands later.
  - Devin has no `Notification` event either, but **no harness wires one** and the
    framework never uses it, so it costs nothing and is not counted above.
- **Forwarding-loop enforcement survives.** Devin's `Stop` hook can block via
  `{"decision":"block","reason":...}`, so the core stop gate works here rather
  than degrading to an advisory nudge.
- **Persona models are rewritten at build time.** The packager projects core's
  judgment tier through Claude's flavour, which emits `model: inherit` - a
  Claude sentinel Devin does not understand. A Devin subagent profile whose
  model is unrecognised *or absent* runs on Devin's **default subagent model**
  rather than the session model, so judgment work would silently downshift.
  `harness/devin/emit.ts` therefore rewrites `inherit` to an explicit `opus`.
  Devin's model names are `opus`, `sonnet`, `swe`, `codex`, and `gemini`.
- **Method rules are read instructions, not imports.** Measured on CLI
  v3000.4.25: `devin rules show AGENTS` prints an `@`-import line *verbatim*, so
  Devin does not expand it. The project-root `AGENTS.md` therefore names the
  method layers under an explicit **"Read these before acting on a development
  request"** instruction - a pointer the conductor is obliged to follow, not
  content the host injects.
  A Devin-native alternative does exist, contrary to what `devin rules paths`
  suggests: that command lists only `.windsurf/rules/*.md`, but a
  `.devin/rules/*.md` file carrying `trigger: always_on` **does** load (verified -
  it is reported as `[Devin] always-on`), and `.devin/` takes precedence over
  `.windsurf/`. It is not used here only because `AGENTS.md` is already always-on
  and already carries the pointer, and neither surface expands `@`-imports - so a
  second file would spend context restating the same thing.
- **Keep `AGENTS.md` small; there is a 32 KiB always-on budget.** Per the Devin
  CLI changelog (v2026.4.17-0) an oversized always-on file is truncated with a
  path hint rather than rejected. Treat the figure as a working budget rather than
  a verified constant: the current docs state no limit, and it is not reproducible
  through `devin rules show`, which returned a deliberately oversized file in
  full. The shipped file is ~17.5 KB and a packaging test asserts it stays under
  32 KiB, so the framework side is guarded - the caution is about what *you* add.
- **Question-asking stages run inline.** Devin withholds its ask-human tool from
  subagents, so a stage that must ask the human cannot be delegated.
- **Restricted Mode (Devin Desktop) disables every agent and every hook,
  silently.** A workspace opened in Restricted Mode makes Cascade, Devin Local and
  every ACP agent unavailable, and hooks neither load nor run. The install then
  looks broken in a way indistinguishable from a bad copy, so make it the first
  thing you check on Desktop. This is a Desktop workspace mode; it does not apply
  to the CLI.
- **`devin doctor` is not the AI-DLC doctor**, and it appears in `--help` even
  where it does not exist - it ships only in air-gapped builds. Use
  `/aidlc --doctor` (below).
- **Headless runs cannot pass approval gates.** The human-presence mint rides
  `UserPromptSubmit`; an unattended driver that submits prompts programmatically
  records no genuine `HUMAN_TURN`, and a gated stage refuses its approval by
  design rather than letting a model approve its own work. Set
  `AIDLC_UNATTENDED=1` when you know no human is present. This is a property of
  the framework's presence gate, not a Devin limitation - every harness mints
  presence from a human-prompt event.

## Verifying an install

```bash
bun .devin/tools/aidlc-utility.ts doctor        # all checks pass on a fresh copy
devin doctor --json                             # host-side; ok: true, with 14 informational warnings
```

`aidlc-utility.ts doctor` reports **41 passed, 0 failed** on a freshly generated
tree. The Devin-specific checks cover the hook wiring at
`.devin/hooks.v1.json`, the adapter beside it, `.devin/config.json`, and the
method pointer in the project-root `AGENTS.md`.

**`devin doctor` reports `ok: true` with 14 `CFG005` warnings, and that is the
expected steady state.** Each persona surfaces `unsupported frontmatter key(s)
ignored: display_name, examples`. Those two are documentation keys AI-DLC's own
schema check *requires* on every persona `.md`; stripping them for Devin trades
Devin's informational notice (the host prints "keys ignored" and carries on) for
a real failure in `aidlc-utility.ts doctor`. So they ship. Warnings naming any
key **other** than those two are worth reporting.

## Next steps

Installed and verified? The methodology is the same on every harness - keep
going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) - an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) - the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) - right-sizing a run.
- [Glossary](../glossary.md) - every term defined.

Other harnesses: [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md).
