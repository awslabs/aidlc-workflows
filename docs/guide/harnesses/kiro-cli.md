# Running AI-DLC on Kiro CLI

> [!NOTE]
> AI-DLC on Kiro CLI works best with **Claude Opus 4.8**, which requires a
> **paid Kiro plan**. On weaker models the conductor may skip optional stage
> steps (reviewer pass, learnings ritual) or rush approval gates. The
> IDE-targeted distribution is documented separately in
> [Running AI-DLC on Kiro IDE](kiro-ide.md).

One of the framework's harnesses: the Kiro runtime runs the same AI-DLC
methodology on [Kiro CLI](https://kiro.dev/docs/cli/). One deterministic core
— the tools, 33 stage files, protocols, knowledge, sensors, scopes, and rules
— is byte-shared across every harness; only the shell (skills, agent
configs, hook wiring, activation) differs.

Harness-specific onboarding lives in `.kiro/steering/aidlc-onboarding.md`,
loaded through the conductor agent's `resources`. The root `AGENTS.md` block
is harness-neutral and shared with other installed harnesses; engine directories
must still differ (Kiro CLI and Kiro IDE cannot share one `.kiro/` install).

## Prerequisites

- **Kiro CLI ≥ 2.6** (`kiro-cli --version`), logged in (`kiro-cli login`)
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes are
  self-contained.

## Install

### Native channel (recommended)

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config
aidlc doctor
```

The installer verifies the release metadata, executable, and all-harness runtime archive against the published SHA-256 checksums. The installed runtime does not require Bun, Node.js, or Git. Harness selection happens in `aidlc config`.

On Windows, download `install.ps1` and run
`& $installer`. See [Windows installation](../18-install-and-lifecycle.md#windows-powershell)
for account scope, automatic User PATH registration, and `-NoModifyPath`.
For an air-gapped package, use
`install.sh --from <release-directory> --offline` on Unix or
`& $installer -From <release-directory> -Offline` on Windows.

`aidlc config` projects the Kiro shell before the first chat session. Then start
Kiro from the project root:

```bash
kiro-cli chat
```

The native projection allows `aidlc engine *` engine commands and the exact
read-only and turn-back-on commands (`aidlc doctor`, `aidlc config <section> --show --json`
and the others listed under the session start below). It also ships
`.kiro/settings/cli.json` with `chat.defaultAgent: "aidlc"`, so `/aidlc` is
active without an agent flag. Run `/aidlc --doctor` in chat before the first
workflow.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-copy-runtime-X.Y.Z.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

```bash
mkdir -p your-project/.kiro your-project/aidlc
cp -R "$RUNTIME_ROOT/kiro/.kiro/." your-project/.kiro/
cp -R "$RUNTIME_ROOT/kiro/aidlc/." your-project/aidlc/    # the workspace shell (spaces/default/memory) — a sibling of .kiro/, not inside it
cd your-project && bun .kiro/tools/aidlc.ts config --from "$RUNTIME_ROOT" --harness kiro
```

The `aidlc/` directory is the workspace shell — it ships the pre-built
`aidlc/spaces/default/memory/` method tree the engine reads. It is a **sibling**
of `.kiro/`, so copy it separately (or copy the whole
`$RUNTIME_ROOT/kiro/` tree at once).
`/aidlc --doctor` fails its "workspace shell ready" check if it is missing.

The versioned runtime uses the native `aidlc` command. Framework developers who
need the Bun-shaped source projection can clone the repository, run
`bun install --frozen-lockfile` and `bun scripts/package.ts`, then use the
ignored local `dist/kiro/` output instead.

The shipped `.gitignore` carries the workspace's commit/ignore split: the
per-user cursors (`aidlc/active-space`, `aidlc/spaces/*/intents/active-intent`)
and machine-local runtime (`aidlc/.aidlc-clone-id`, `runtime-graph.json`, sensor
caches, `spaces/*/knowledge/.sources.local.json`) stay untracked, while the
shared records — method memory, state, audit shards, artifacts — travel with
git. The last line, the copy's own setup, adds those lines and AI-DLC's part of
`AGENTS.md` after everything already in your files, or creates the files when
the project has none, so the AI-DLC rules are in place before your first
workflow.

Then start a session in your project:

```bash
cd your-project && kiro-cli chat
```

The install ships `.kiro/settings/cli.json` with `chat.defaultAgent: "aidlc"`,
so the AI-DLC conductor agent is active by default — `/aidlc` just works.
**This workspace setting takes precedence over a global default agent you may
have configured**; if you prefer your own default, remove that setting and use
`kiro-cli chat --agent aidlc` instead.

No shipped agent pins a model: a pinned ID resolves only when that
model is enabled on the user's Kiro install, so the conductor and all 14
personas inherit your session model (`/model`).

### Session model and effort

Kiro CLI runs each AI-DLC session on one model and has no per-agent effort
surface, so AI-DLC keeps the session's model and effort in your **personal**
Kiro settings (`~/.kiro/settings/cli.json`, the file Kiro's own
`/model set-current-as-default` writes), never in the project. Model lists
differ per Kiro account, and a project model a teammate's account lacks fails
every prompt they send. A project `chat.modelDefaults` would also replace your
whole personal map inside the project, so the shipped `cli.json` carries none.

First-run setup's step 2, "Session model", lists the models your Kiro account
offers, in Kiro's order, with each model's credit multiplier and a `preview` or
`internal` tag. Under Kiro auto (Kiro's own default, where Kiro picks the model
for each task), AI-DLC recommends choosing a model, so your effort preset
applies to it. The preset then sets one effort for the whole session:

| Preset | Session effort |
|--------|----------------|
| `minimal` | `low` |
| `balanced` | `medium` |
| `thorough` | `xhigh` (extra-high) |

A model without that level gets its next level down, and a model with no
effort setting keeps only the model. `aidlc config models` offers the same
choice later ("1 session model, 2 preset"), and
`aidlc config models --session-model <id>` saves a model from your account's
list without prompts. A saved model your account no longer offers fails every
prompt, so setup asks for another instead of keeping it. `--dry-run` shows the
personal Kiro settings change too and writes nothing. When Kiro refuses a write,
AI-DLC says exactly what was saved and `config models` exits 5 (action needed).
`aidlc doctor` checks the live setting: the model is still offered, the effort
matches the preset, and no project file overrides it. Refreshing a project set
up by an earlier release removes AI-DLC's old effort map (`claude-opus-4.8` at
extra-high) from `.kiro/settings/cli.json` and says so; run
`aidlc config models` to choose the session model.
Override one session with `/effort <level>` in chat or `kiro-cli chat --effort
<level>` (low|medium|high|xhigh|max). The Kiro IDE does not read `cli.json`.

## Refresh and version skew

`aidlc update` updates the machine runtime but leaves project files unchanged.
`aidlc doctor` reports a project stamp that differs from the selected engine.
Between workflows, preview and apply the refresh with:

```bash
aidlc config --dry-run
aidlc config
```

Config preserves user-owned content and reports local framework edits as
conflicts. A refresh while a workflow is open is done and says your open work
carries on. Upgrade and rollback remain safe during a workflow because they do
not modify the project.

## Usage

Start `kiro-cli chat` in the project, then invoke the conductor with
`/aidlc <description>`. `/aidlc --status` reports position;
`/aidlc --config [section]` gathers project configuration changes in-session;
`/aidlc --doctor`, `--stage`, `--phase`, `--depth`, and `--test-strategy` all work. Workspace
navigation uses `/aidlc intent [name]`, `/aidlc space [name]`, and
`/aidlc space-create <name>`. The per-stage (`/aidlc-domain-design`) and
per-scope (`/aidlc-feature`) runner skills are installed too.

Status, doctor, help, version, and workspace-navigation commands are dispatched
by the Kiro hook before the model can turn them into workflow work. Their child
output is decoded as UTF-8 and terminal protocol/control bytes are removed only
at that plain-text relay boundary; ordinary Unicode, paths, tabs, newlines, and
literal escape-looking text remain unchanged.

**Start the session from the project root.** Native installs pre-approve the
installed `aidlc engine ...` commands and, exactly as written, the same
read-only and turn-back-on commands listed next, run as `aidlc ...`.
Source/development copies pre-approve only
AI-DLC's own workflow commands, run project-relative: the engine commands
(`bun .kiro/tools/aidlc.ts engine ...`), the read-only `doctor`, `version`,
`--version`, `--doctor`, `status`, `--status`, `config --help`,
`config <section> --show` with or without `--json`, and
`config <section> --help`, turning a check back on with
`config flags --clear-bypass <switch> --yes`, and the AI-DLC tool scripts
(`bun .kiro/tools/aidlc-<tool>.ts`). Any other `config` change (turning a check
off included), the commands that change
the machine's AI-DLC install (`use`, `update`, `rollback`, `uninstall`,
`system`) with the tool scripts behind them (`aidlc-doctor.ts`, `aidlc-init.ts`,
`aidlc-lifecycle.ts`, `aidlc-machine-config.ts`), absolute paths,
`KIRO_PROJECT_DIR` expansion, and a line that adds a command that is not
pre-approved (a `cd` before it, or a pipe or `&&` into another command) still
ask.

**What still asks you.** The developer agent and the `aidlc` agent write
project files without asking: any path inside the project whose top-level name
does not start with a dot. Their writes into `.kiro/` (apart from the `aidlc` agent's own
`.kiro/sensors/` files), `.git/`, or any other
top-level dot entry, and anything outside the project, still ask. Your
project's own test and build commands (`bun test`, `npm test`, `pytest`, and so
on) still ask, so you see each one before it runs.

**Sessions with no approver stall rather than prompt.** Anything outside the
pre-approved set needs an interactive answer. Under `kiro-cli chat
--no-interactive` there is nobody to ask, so Kiro refuses the command outright
with `non-interactive mode (no user to approve)`. Over ACP, your client must
answer `session/request_permission`; a client that ignores those requests looks
exactly like a permission failure. `--trust-all-tools` bypasses both the allow
and deny lists, including the recursive-`rm` and `git push` denials. Use it only
inside a disposable sandbox where blanket shell access is acceptable.

**The hooks run on Kiro CLI's v2 engine, including over ACP.** This
distribution registers its hooks in `.kiro/agents/aidlc.json`. Kiro CLI runs
that block on its v2 engine while the `aidlc` agent is active. `kiro-cli acp`
picks the agent from `chat.defaultAgent`, the same way `kiro-cli chat` does.
Kiro CLI's v3 engine does not run the file as AI-DLC ships it, so if a session
starts on v3 (for example when a client starts `kiro-cli acp --agent-engine v3`)
or switches to another agent, none of these hooks run. With no hooks, no
`HUMAN_TURN` receipts are recorded, so every approval and confirmation is
refused. No write events are recorded either, so reviews are refused.
After the first workflow stage, `/aidlc --doctor` reports this as "Hooks have
never executed". Before that, doctor warns that AI-DLC's hooks have not run in
this project yet and names the same step. Restarting on the v3
engine does not fix it. With another agent picked, type `/agent` and pick
`aidlc`, then carry on in the same chat. On the 3.0 engine (Kiro prints
`agent "aidlc" needs upgrading for this agent engine` under its replies), quit
and start `kiro-cli chat --agent-engine v2 --agent aidlc` in this folder
instead (an ACP client starts `kiro-cli acp --agent-engine v2`). To run Kiro
CLI on its v3 engine, use the
[Kiro IDE](kiro-ide.md) distribution instead; in an existing project,
`aidlc config --harness kiro-ide` switches `.kiro/` to it in place and keeps
`aidlc/`. See
[Kiro CLI hooks not running](../15-troubleshooting.md#kiro-cli-hooks-not-running).

## What's different on Kiro

| Area | Claude Code | Kiro CLI |
|------|-------------|----------|
| Gates & questions | `AskUserQuestion` widget | Numbered prose options (reply with a number); the questions FILE with `[Answer]:` tags stays the source of truth |
| Statusline | Current stage + model + context % | Not available — use `/aidlc --status` and the progress line at each gate |
| Dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent) | `Task` tool | Kiro `subagent` tool → the agent configs (all 14 personas ship configs) |
| Construction swarm | Parallel `Task` floor, optional ultracode Workflow | Subagent fan-out only; `AIDLC_USE_SWARM=1` is announced as a no-op |
| Session audit events | `SESSION_STARTED/RESUMED/ENDED`, `SESSION_COMPACTED` | `SESSION_STARTED` only (Kiro has no session-end / pre-compaction hooks) |
| Forwarding-loop enforcement (Stop hook) | Interactive + headless | Interactive sessions only — `--no-interactive` runs do not honor the stop-hook block |
| Permissions | `settings.json` allowlist | Source-generated projection: AI-DLC's own project-relative workflow commands (engine, read-only dispatcher commands, AI-DLC tool scripts) and `date -u`; native and versioned release runtimes: `aidlc engine *`. Other shell commands prompt. |
| Welcome message | Rendered at session start from `settings.json` `companyAnnouncements` | None — Kiro has no welcome-render equivalent; the session-start hook injects resume context only |
| MCP servers | Ships 5 (`.mcp.json`: `context7` + four AWS servers) | Ships the same 5 in `.kiro/settings/mcp.json`, all disabled by default; flip `"disabled": false` per server to enable it. Context7 is keyless on Kiro because Kiro sends configured HTTP header values verbatim instead of expanding environment placeholders. All 14 delegated personas opt in through `includeMcpJson: true` plus `@<server>` tool grants; the conductor gets none. |

Everything else — state machine, audit trail, artifacts under the intent
record dirs (`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`), the learnings
ritual, sensors, scopes, depth/test-strategy — behaves identically, because it
IS identical: native installs dispatch through `aidlc`, while source copies run
the corresponding tools from `.kiro/tools/`.

A project's `aidlc/` workspace is harness-neutral. Moving a project between
harnesses (or running both side by side) is supported-but-untested; `/aidlc
--doctor` will warn if it detects a conflicting harness setup with an active workflow.

## For framework developers

`dist/kiro` is **generated** from `core/` + `harness/kiro/` by
`bun scripts/package.ts kiro` (core copy with the `{{HARNESS_DIR}}` token
substituted to `.kiro` and the `rules/` → `steering/` rename). The output is
ignored and local. `bun scripts/package.ts --check` builds twice in independent
temporary roots and byte-compares the results as the CI determinism guard. The
authored Kiro surfaces live in `harness/kiro/`: the orchestrator skill
(`skills/aidlc/`), the agent JSONs (`agents/`), the hook adapter
(`hooks/aidlc-kiro-adapter.ts`), `settings/cli.json`, `settings/mcp.json`, and `onboarding.fills.ts` — edit
those (or `core/`), never hand-edit the generated `dist/kiro`. See
[Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md).

A live TUI journey test exists alongside the Claude twins:
`tests/e2e/t-tui-kiro-intent-capture.serial.test.ts` drives `kiro-cli chat`
by keystroke against the shipped tree (numbered-prose gates answered with
"1" = the recommended option, terminating on disk state). Opt in with
`AIDLC_KIRO_TUI_LIVE=1`; it skips with a reason when tmux, `kiro-cli`, or a
logged-in Kiro session is absent.

## Next steps

Installed and activated? The methodology is the same on every harness — keep
going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [AI-DLC on Codex CLI](codex-cli.md) · [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md).
