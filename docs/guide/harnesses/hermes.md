# AI-DLC on Hermes Agent

The Hermes runtime is one of the framework's harness distributions, for
[Hermes Agent](https://github.com/NousResearch/hermes-agent). One tree serves
the CLI, the desktop app, and the gateway: they all run the same install and
read the same project files. One deterministic core, many harnesses: the
engine, state machine, audit log, graph, swarm referee, and learnings gate are
byte-identical across every distribution - only the shell differs. The
source/development tree is **generated** into ignored local `dist/hermes/` from
`core/` + `harness/hermes/` by `bun scripts/package.ts hermes`; never hand-edit
it.

Hermes-specific onboarding lives in `.hermes.md` at the project root, which
Hermes reads as always-on project context (walking up to the git root).

## Layout

Hermes consumes the standard core projection directly (no `emit.ts`, no split
dot-dir). The distribution is:

- **`.hermes/`** - the framework tree. Hermes reads one part of it natively:
  `skills/` (the orchestrator as the project skill `aidlc`, the five session
  and knowledge skills, and the generated stage runners). The other dirs -
  `agents/` (the 14 personas, adopted inline by the conductor), `tools/`,
  `aidlc-common/`, `knowledge/`, `sensors/`, `scopes/`, `hooks/` - are inert
  data to Hermes; the conductor reads them and the engine runs the tools.
- **`aidlc/`** - the workspace shell (the pre-built
  `aidlc/spaces/default/memory/` method tree the engine reads), a sibling of
  `.hermes/`.
- **`.hermes.md`** - the project-root always-on context file: prerequisites,
  the structure map, and what differs on this harness.

## Prerequisites

- **Hermes Agent** - `hermes --version` works. Verified against **v0.21.7**.
  The CLI, the desktop app, and the gateway all run this same install; the
  harness is the project tree, not a particular surface.
- **A git repository, trusted once** - Hermes finds the project root at the git
  root and loads project skills only from a repository you trust. Run
  `hermes skills trust` once in the project; `hermes skills untrust` revokes it.
  Without it the tree is on disk but `/skill aidlc` finds nothing.
- **bun 1.4.4 or newer** (copy channel) or the native `aidlc` command (release
  channel). The copy projection runs the engine through
  `bun .hermes/tools/aidlc.ts`; a native install runs it through `aidlc`. `bun`
  must be on the PATH of the shell Hermes's `terminal` tool starts.
- **No model setup** - Hermes runs every agent on the model and reasoning
  effort you chose in your session (`hermes model`), so AI-DLC ships no agent
  model or effort pins and asks no provider question for this harness.

## Install

### Native channel (recommended)

Install the native command as described in
[Install and Lifecycle](../18-install-and-lifecycle.md), then:

```bash
cd your-project
aidlc config --harness hermes
aidlc doctor
```

`git init` first if the project is not a repository yet. Then, once:

```bash
hermes skills trust
```

Start `hermes` in the project and type `/skill aidlc`, followed by what you
want to build.

### Versioned manual-copy alternative

Download and extract a specific release's
`aidlc-copy-runtime-X.Y.Z.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then copy that release's `runtime/hermes/` contents into your project:

```bash
cp -r "$RUNTIME_ROOT/hermes/." your-project/
cd your-project && hermes skills trust
```

The copied tree already carries `.hermes/`, `.hermes.md`, the root `.gitignore`
block, and the `aidlc/` shell. The copy does not need `aidlc config`; run
`bun .hermes/tools/aidlc.ts --doctor` to check the install. A refresh is a
fresh copy of the newer release (or `aidlc config --harness hermes` with the
native command). `aidlc config` merges its block into an existing `.hermes.md`
and `.gitignore`; it never replaces your own lines.

## What's different on this harness

- **The entry is a project skill, not a slash command.** Hermes has no
  user-defined slash commands, so `/skill aidlc` loads the conductor from
  `.hermes/skills/aidlc/SKILL.md`; every engine call then runs through the
  `terminal` tool. The session skills load the same way
  (`/skill aidlc-session-cost`, `/skill aidlc-status`-style stage runners as
  `/skill aidlc-<stage>`).
- **Questions render as numbered prose.** No structured-question widget is
  wired for the conductor; the questions file with `[Answer]:` tags remains the
  source of truth, and an approval gate always ends the turn.
- **Hooks are not wired.** Hermes keeps its shell hooks in the person's own
  `~/.hermes/config.yaml`, outside the project, so a project install cannot
  register them. The forwarding loop (ask the engine for the next step until a
  gate or a completion) is the skill's prose discipline, and the guards other
  harnesses enforce before a tool call - review freeze, reviewer read scope,
  plan approval - are advisory here: the stage steps and the conductor enforce
  them, nothing refuses a tool call. `aidlc doctor` reports the tree's surfaces
  (skill, personas, `.hermes.md`, git) and does not claim hook health.
- **Subagents run through `delegate_task`.** The conductor reads the persona in
  `.hermes/agents/` itself and passes the persona text plus the stage brief in
  the child's context. Children are leaf agents: they cannot delegate further.
  There is no native subagent registry.
- **The method reaches context by instruction.** `.hermes.md` tells the
  conductor to read `aidlc/spaces/<active-space>/memory/*.md`, and every stage
  directive carries its own `rules_in_context`. Edit the active space's memory
  files, never a copy.
- **No status line.** Surface progress with the progress line after each gate
  and `bun .hermes/tools/aidlc.ts --status` on demand.
- **`AI_AGENT=hermes-agent`** marks every command Hermes's agent runs; in a
  project with several harnesses installed, that is how the native engine
  picks this tree's steps.
- **No MCP servers ship.** Add your own with `hermes mcp add` when a stage
  needs one. AI-DLC itself needs none.
- A workflow's `aidlc/` workspace tree is harness-neutral: a project can move
  between harness installs (supported but untested - keep the trees in sync via
  the framework's packaging if you do this).

## Verifying an install

```bash
cd your-project
git rev-parse --is-inside-work-tree        # Hermes needs a git repo
hermes skills trust                        # once per repository
bun .hermes/tools/aidlc.ts --doctor        # or: aidlc doctor
```

A healthy tree reports `0 problems` and names the project as
`(.hermes, Hermes Agent)`. `hermes skills trust` prints the number of project
skills it will load; a full tree is 43 (the orchestrator, the five session and
knowledge skills, and the generated stage runners). Then start `hermes` in the
project and type `/skill aidlc` - the conductor's first reply asks for the work
or shows the plan offer.

## Next steps

- [Getting Started](../01-getting-started.md) - the first workflow on any
  harness.
- [Interaction modes and approval gates](../07-interaction-modes.md) - what the
  numbered gate choices mean.
- [Harness Engineer Guide](../../harness-engineering/00-overview.md) - reshaping
  stages, agents, rules, and sensors.
