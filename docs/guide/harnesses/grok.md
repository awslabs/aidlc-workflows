# AI-DLC on Grok Build

The Grok Build runtime is one of the framework's harness distributions, for
[Grok Build](https://x.ai). One tree serves the Grok Build session that opens
this project: it reads `.grok/` for rules, skills, agents, and hooks. One
deterministic core, many harnesses: the engine, state machine, audit log,
graph, swarm referee, and learnings gate are byte-identical across every
distribution - only the shell differs. The source/development tree is
**generated** into ignored local `dist/grok/` from `core/` +
`harness/grok/` by `bun scripts/package.ts grok`; never hand-edit it.

Harness-specific onboarding lives in `.grok/rules/aidlc-onboarding.md`.
Grok Build loads every `rules/*.md` file on each turn. There is no
`alwaysApply` frontmatter and no `.mdc`. The root `AGENTS.md` block is
harness-neutral and shared with other installed harnesses whose engine
directories differ.

## Layout

Grok Build consumes the standard core projection directly (no `emit.ts`).
The distribution is:

- **`.grok/`** - the framework tree. Grok Build reads `rules/` (onboarding,
  one standing method pointer, and four phase pointers), `agents/` (the 14
  personas as native subagents), `skills/` (the orchestrator, utility
  shortcuts, and generated stage runners), and `hooks/aidlc.json` plus
  `hooks/aidlc-grok-adapter.ts`. The engine dirs beside them (`tools/`,
  `aidlc-common/`, `knowledge/`, `sensors/`, `scopes/`) are inert data to
  Grok Build and safely share the directory. There is no `cli.json` and no
  status line command.
- **`aidlc/`** - the workspace shell (the pre-built
  `aidlc/spaces/default/memory/` method tree the engine reads), a sibling of
  `.grok/`.
- **`AGENTS.md`** - project-root ambient instructions.

## Prerequisites

- **Grok Build** - open this project in Grok Build. It reads this install's
  `.grok/` surfaces.
- **A git repository, and folder trust.** Grok Build skips project hooks in a
  folder that is not a git repository, and it skips them until you trust the
  folder (`/hooks-trust`, or start with `--trust`). Without those hooks your
  approvals are never recorded. If the project is not a repository yet, run
  `git init` in it before opening it in Grok Build.
- **The session model.** Persona surfaces ship with no model pins, so every
  agent inherits the model of this Grok Build session. A model or effort
  recorded for another harness is kept and changes nothing here.
- **bun** only for source development or the copy-channel hook scripts. Once
  installed, native and versioned release runtimes invoke `aidlc`.

## Install

### Native channel (recommended)

Install the native command as described in
[Install and Lifecycle](../18-install-and-lifecycle.md), then:

```bash
cd your-project
aidlc config --harness grok
aidlc doctor
```

Open the project in Grok Build, trust the folder, and run `/aidlc --doctor`,
then `/aidlc` followed by what you want to build. Native utility shortcuts
are `/aidlc-status`, `/aidlc-jump --stage <slug>` (or `--phase <name>`), and
`/aidlc-scope <name>`.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-copy-runtime-X.Y.Z.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then copy that version's `runtime/grok/` tree into the project. This harness
does not ship an `install.ts` helper. Multi-harness projects should add Grok
Build with `aidlc config --harness grok` so the shared `AGENTS.md` and
`.gitignore` blocks stay managed.

The `aidlc/` shell ships the pre-built `aidlc/spaces/default/memory/` method
tree the engine reads; `/aidlc --doctor` fails its "workspace shell ready"
check without it.

## What's different on this harness

- **Questions use `ask_user_question`.** The tool adds Other, so the conductor
  does not add it and does not echo the `question` fence. A pick in that box
  is recorded as the person's reply. The questions FILE with `[Answer]:` tags
  remains the source of truth.
- **Hooks ride `.grok/hooks/aidlc.json`** through the AIDLC adapter
  (`.grok/hooks/aidlc-grok-adapter.ts`). PreToolUse denies with
  `{"decision":"deny","reason"}`. The Stop hook can block a real completion
  with `{"decision":"block","reason"}`. A stop fired because the session is
  closing (`channel_closed`, `shutdown`) is not a gate.
- **Subagents are `spawn_subagent`.** Set `subagent_type` to the persona name
  and `background: false`. Depth limit is 1, so personas do not spawn further
  agents. Hook payloads carry `subagentType`. There is no reconstructed
  subagent ledger.
- **Rules are read pointers.** `.grok/rules/aidlc.md` points at
  `aidlc/active-memory/` org, team, and project. Four phase files point at
  the phase layers. Grok Build does not expand `@`-imports.
- **Shell output is middle-cut past 20,000 characters.** Directives cap at
  19000 bytes so a stage result stays intact.
- **No status line and no shipped MCP servers.** Use `/aidlc-status` (or
  `/aidlc --status`). AI-DLC does not write `.grok/config.toml`. Add an allow
  entry yourself and keep every other line you already have:

```toml
[permission]
allow = ["Bash(aidlc *)", "Bash(bun .grok/tools/aidlc*)", "Bash(bun .grok/hooks/aidlc*)"]
```

`/aidlc --doctor` warns when no `[permission]` allow entry mentions `aidlc`,
and when `grok` is not on `PATH`.

- **Gated workflows need a person at the keyboard.** A headless `grok -p` run
  does not mint a human turn, so an approval gate refuses by design. Headless
  mode suits the read-only utilities (`--status`, `--doctor`, `--version`).
- **Swarm fan-out is `spawn_subagent` only.** `AIDLC_USE_SWARM=1` is a loud
  no-op. Grok Build has no Workflow tool.
