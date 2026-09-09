# Running AI-DLC on Kiro

One of the framework's harnesses: the Kiro runtime runs the same AI-DLC
methodology on [Kiro IDE](https://kiro.dev/) and
[Kiro CLI](https://kiro.dev/docs/cli/). Both surfaces run the same agent
runtime, so they share ONE distribution: the same `.kiro/` tree, the same hook
manifests, the same conductor. One deterministic core — the tools, 33 stage
files, protocols, knowledge, sensors, scopes, and rules — is byte-shared across
every harness; only the shell (skills, agent surfaces, hook wiring, activation)
differs.

> [!IMPORTANT]
> **Run AI-DLC on Kiro with Claude Opus 4.8.** The conductor drives a
> multi-step ritual per stage — clarifying questions, artifact generation, a
> reviewer pass, the learnings ritual, then the approval gate. Opus 4.8 follows
> the full ritual and pauses correctly at every gate. Weaker models skip
> optional steps (the reviewer pass and the learnings ritual) and may rush
> gates. Opus 4.8 requires a **paid Kiro plan**; in the IDE, set the chat model
> before starting a workflow.

> [!NOTE]
> Kiro IDE 0.x is not supported. Update to a current Kiro IDE, or use Kiro CLI.
> On 0.x a single legacy hook denies each tool call and says so; that host has no
> way for a hook to refuse outright, so the denial is an instruction its agent is
> told to honour rather than a block the IDE enforces. A supported IDE never runs
> that hook, but it does list it as `legacy` with a **Migrate** button: leave it
> alone. Migrating it is not needed and not supported — the notice checks the host
> version and stays silent on a supported one either way.

## Prerequisites

- **Kiro IDE**, signed in, with **Claude Opus 4.8** selected as the chat model —
  or **Kiro CLI ≥ 2.21.1** (`kiro-cli --version`), logged in (`kiro-cli login`).
  This row targets the unified agent harness, and `.kiro/settings/cli.json` pins
  the engine so a plain `kiro-cli` reaches it. 2.21.1 is where that pin was
  measured; the engine itself has been reachable behind `kiro-cli --v3` since
  2.8.0, so an older 2.x can opt in with the flag, on a path we have not tested.
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes are
  self-contained.

> [!TIP]
> For a source-generated `dist/` install, bun must be on the PATH that
> *non-interactive* shells see — that's what Kiro uses to run a hook or tool.
> Those shells read `~/.zshenv` (zsh) or `~/.bashrc` (bash), not `~/.zshrc`, but
> the bun installer writes to `~/.zshrc`. If `which bun` works in your terminal
> yet hooks can't find bun, copy the `BUN_INSTALL`/`PATH` export into
> `~/.zshenv` (or `~/.bashrc`).

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
`& $installer`. For an air-gapped package, use
`install.sh --from <release-directory> --offline` on Unix or
`& $installer -From <release-directory> -Offline` on Windows.

`aidlc config` projects the Kiro shell before the first chat session. Then open
the project from its root, on either surface:

```bash
kiro .        # Kiro IDE
kiro-cli      # Kiro CLI
```

The native projection allows `aidlc engine *` engine commands. It also ships
`.kiro/settings/cli.json`, which selects the `aidlc` agent as the workspace
default so `/aidlc` is active without an agent flag. Run `/aidlc --doctor`
before the first workflow.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-runtime-X.Y.Z.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

```bash
mkdir -p your-project/.kiro your-project/aidlc
# Safe on fresh installs; required when upgrading an older Kiro install.
for retired_hook in \
  audit-logger block mint runtime-compile stop sync-statusline
do
  rm -f \
    "your-project/.kiro/hooks/aidlc-${retired_hook}.json" \
    "your-project/.kiro/hooks/aidlc-${retired_hook}.kiro.hook"
done
# The agent-v1 generation: an agent-JSON conductor and personas, and the legacy
# `.kiro.hook` registrations. This row ships a Markdown conductor and hook
# manifests, and an overlay copy cannot delete what it no longer ships.
rm -f \
  your-project/.kiro/agents/aidlc.json \
  your-project/.kiro/agents/aidlc-*-agent.json \
  your-project/.kiro/hooks/aidlc-*.kiro.hook
cp -R "$RUNTIME_ROOT/kiro/.kiro/." your-project/.kiro/
cp -R "$RUNTIME_ROOT/kiro/aidlc/." your-project/aidlc/    # the workspace shell (spaces/default/memory) — a sibling of .kiro/, not inside it
cp "$RUNTIME_ROOT/kiro/AGENTS.md" your-project/AGENTS.md  # merge if you already have one
# Existing .gitignore: preserve it and merge only the section beginning "# AI-DLC".
if [ ! -e your-project/.gitignore ]; then
  cp "$RUNTIME_ROOT/kiro/.gitignore" your-project/.gitignore
fi
```

The removal loop is the hook-name migration; the second removal clears the
agent-v1 surfaces. Both are no-ops on a fresh install. After that cleanup, the
`cp -R <src>/. <dst>/` form copies the tree **contents** whether
`your-project/.kiro` already exists or not.

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
git. The guarded command copies the complete starter file only when the project
has no `.gitignore`. If one exists, preserve every project-owned rule and merge
only the section from `# AI-DLC` through the end of the shipped file; do not
copy its generic starter rules. The `## Git Integration` section of the
installed `AGENTS.md` assumes the AI-DLC rules are in place before your first
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
personas inherit your session model (`/model`). The same `cli.json` also
ships one CONDITIONAL per-model reasoning-effort default via
`chat.modelDefaults`: `xhigh` for `claude-opus-4.8`, applied only when your
session actually runs that model (the recommended setup) — inert otherwise.
Kiro has no per-agent effort surface, so effort can only ride on the model
this way. This file is read by the Kiro CLI only — the Kiro IDE ignores
`cli.json` and applies its extension's per-model defaults instead. Override
per session with `/effort <level>` in chat or `kiro-cli chat --effort
<level>` (low|medium|high|xhigh|max) — a session flag and your user-level
`~/.kiro/settings/cli.json` both take precedence over the workspace default.

## Refresh and version skew

`aidlc update` updates the machine runtime but leaves project files unchanged.
`aidlc doctor` reports a project stamp that differs from the selected engine.
Between workflows, preview and apply the refresh with:

```bash
aidlc config --dry-run
aidlc config
```

Config preserves user-owned content and reports local framework edits as
conflicts. It refuses refresh while any workflow is active; complete the
workflow first. Upgrade and rollback remain safe during a workflow because
they do not modify the project.

## Usage

Open the project in Kiro IDE or start `kiro-cli` in it, then invoke the conductor with
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
installed `aidlc` command. Source/development copies pre-approve only
project-relative `bun .kiro/tools/<tool>.ts` commands; absolute paths,
`KIRO_PROJECT_DIR` expansion, and command chains remain gated.

**Sessions with no approver stall rather than prompt.** Anything outside the
pre-approved set needs an interactive answer. Under `kiro-cli chat
--no-interactive` there is nobody to ask, so Kiro refuses the command outright
with `non-interactive mode (no user to approve)`. Over ACP, your client must
answer `session/request_permission`; a client that ignores those requests looks
exactly like a permission failure. `--trust-all-tools` bypasses both the allow
and deny lists, including the recursive-`rm` and `git push` denials. Use it only
inside a disposable sandbox where blanket shell access is acceptable.

## How hooks work on Kiro

Kiro registers hooks through standalone manifests under `.kiro/hooks/`
(`{"version":"v1","hooks":[{name,trigger,matcher,action}]}`, PascalCase
triggers). Both surfaces read the same files. Native hook commands route through
`aidlc engine adapter kiro`; source/development copies route through the
projected `aidlc-kiro-adapter.ts` shim. Both normalize the Kiro event into the
shape the shared core hooks expect.

Two triggers are surface-specific, and the row registers both so a
responsibility is not dead on one of them: **Session Start is IDE-only and Agent
Spawn is CLI-only**. Only **Prompt Submit**, **Pre Tool Use** and **Pre Task
Execution** can refuse a call; `Post*` and `Stop` cannot, which is why every
guard below that must refuse sits on `PreToolUse`.

| Manifest | Trigger (matcher) | Adapter target |
|---|---|---|
| `aidlc-session-start.json` | `SessionStart` (IDE) + `AgentSpawn` (CLI) | `session-start` |
| `aidlc-terminal-command.json` | `UserPromptSubmit` | `verb-intercept` |
| `aidlc-record-human-turn.json` | `UserPromptSubmit` | `record-human-turn` |
| `aidlc-continue-workflow.json` | `Stop` | `continue-workflow` |
| `aidlc-plan-approval-guard.json` | `PreToolUse` | `plan-approval-guard` |
| `aidlc-enforce-approval-gate.json` | `PreToolUse` | `enforce-approval-gate` |
| `aidlc-terminal-command-guard.json` | `PreToolUse` (terminal tools) | `terminal-command-guard` |
| `aidlc-review-freeze.json` | `PreToolUse` (write + terminal tools) | `review-freeze` |
| `aidlc-state-transition-guard.json` | `PreToolUse` (terminal tools) | `state-transition-guard` |
| `aidlc-reviewer-scope.json` | `PreToolUse` (read + write + terminal tools) | `reviewer-scope` |
| `aidlc-write-audit-log.json` | `PostToolUse` (write tools) | `audit-and-sensors` |
| `aidlc-rebuild-stage-graph.json` | `PostToolUse` (`execute_bash`) | `rebuild-stage-graph` |
| `aidlc-sync-workflow-state.json` | `PostToolUse` (`execute_bash`) | `sync-workflow-state` |
| `aidlc-log-subagent.json` | `PreToolUse` + `PostToolUse` (delegation tools) | `log-subagent` |

`aidlc-log-subagent` is registered on BOTH edges of a delegation for a reason
the payload forces: a Kiro hook payload carries no acting-agent field, so a
delegate's own tool calls arrive anonymous. They do arrive — they are nested
inside the dispatch event's own `PreToolUse`..`PostToolUse` window — so the
adapter opens a delegation window on the dispatch's `PreToolUse`, closes it on
the matching `PostToolUse`, and attributes what happens in between. That is what
gives `reviewer-scope` and `state-transition-guard` the persona they enforce
against. When two different personas are delegated in parallel, the acting one
cannot be determined and the adapter says so rather than guessing.

`aidlc-session-end` has no registration: Kiro's `Stop` trigger fires at the end
of every assistant turn, not at conversation close, so registering it would
append a spurious `SESSION_ENDED` between prompts in the same session. No
`SESSION_ENDED` is recorded.

You will see a "Run Command Hook" line in chat each time one fires.

### Debugging hooks

If a hook isn't behaving as expected, turn on debug logging and each hook
appends its decision path (which gate it took, the resolved paths, why it
exited) to `<record>/.aidlc-hooks-health/hook-debug.log`. It is **off by
default** — no log is written and there is no overhead on a normal run. Two
ways to enable it, either works:

- **Filesystem marker (easiest on Kiro IDE):** `touch aidlc/.aidlc-hook-debug`
  in your project. It takes effect on the very next hook fire — no IDE restart —
  and `rm aidlc/.aidlc-hook-debug` turns it back off.
- **Environment variable:** `export AIDLC_HOOK_DEBUG=1`. Because the IDE runs
  hooks in non-interactive shells, set it where those shells read it — add the
  export to `~/.zshenv` (zsh) or `~/.bashrc` (bash), then restart the IDE.

## What's different on Kiro

| Area | Claude Code | Kiro |
|------|-------------|----------|
| Gates & questions | `AskUserQuestion` widget | Numbered prose options (reply with a number); the questions FILE with `[Answer]:` tags stays the source of truth |
| Statusline | Current stage + model + context % | Not available — use `/aidlc --status` and the progress line at each gate |
| Hook registration | `settings.json` `hooks` block | Standalone `.kiro/hooks/aidlc-*.json` manifests, read by both surfaces |
| Dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent) | `Task` tool | Kiro delegation tools → all 14 Markdown personas |
| Construction swarm | Parallel `Task` floor, optional ultracode Workflow | Subagent fan-out only; `AIDLC_USE_SWARM=1` is announced as a no-op |
| Session audit events | `SESSION_STARTED/RESUMED/ENDED`, `SESSION_COMPACTED` | `SESSION_STARTED` only (Kiro has no genuine session-end or pre-compaction event) |
| Forwarding-loop enforcement (Stop hook) | Interactive + headless | Advisory: `Stop` cannot block on Kiro, and CLI `--no-interactive` runs do not honor a stop-hook block either — enforcement relies on the conductor's own Stop protocol |
| Permissions | `settings.json` allowlist | Source-generated projection: project-relative framework `bun .kiro/tools/<tool>.ts` calls and `date -u`; native and versioned release runtimes: `aidlc engine *`. Other shell commands prompt. |
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
temporary roots and byte-compares the results as the CI determinism guard.

The authored Kiro surfaces live in `harness/kiro/`: the orchestrator skill and
its question-rendering annex (`skills/aidlc/`), always-included active-memory
steering (`steering/`), the conductor Markdown (`agents/aidlc.md`), the hook
adapter and the hook manifests (`hooks/`), `settings/cli.json`,
`settings/mcp.json`, and onboarding fills — edit those (or `core/`), never
hand-edit the generated `dist/kiro`.

This row replaced two: an IDE-targeted row and a CLI-targeted row that
maintained the same `.kiro/` shell twice, in two adapters implementing the same
contract. They were merged because both surfaces run the same agent runtime, so
the split cost two maintenance passes per generation and bought nothing. The
CLI-only surfaces of the old split (agent-v1 JSON configs and the agent-JSON
`hooks` block) are gone; registration is the manifests, and the conductor is
Markdown.
See [Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md).

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
