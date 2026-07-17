# Running AI-DLC on Kiro IDE

One of the framework's harnesses: `dist/kiro-ide/` runs the same AI-DLC
methodology inside [Kiro IDE](https://kiro.dev/). One deterministic core —
the tools, 32 stage files, protocols, knowledge, sensors, scopes, and rules —
is byte-shared across every harness; only the shell (skills, agent configs,
hook wiring, activation) differs.

> [!IMPORTANT]
> **Run AI-DLC on Kiro IDE with Claude Opus 4.8.** The conductor drives a
> multi-step ritual per stage — clarifying questions, artifact generation, a
> reviewer pass, the learnings ritual, then the approval gate. Opus 4.8
> follows the full ritual and pauses correctly at every gate. Weaker models
> skip optional steps (the reviewer pass and the learnings ritual) and may
> rush gates. Set the chat model to **Claude Opus 4.8** before starting a
> workflow.

## Prerequisites

- **Kiro IDE**, signed in
- **Claude Opus 4.8** selected as the chat model (see the note above)
- **bun** on your PATH (`curl -fsSL https://bun.sh/install | bash`)

> [!TIP]
> bun must be on the PATH that *non-interactive* shells see — that's what the
> IDE uses to run a hook or tool. Those shells read `~/.zshenv` (zsh) or
> `~/.bashrc` (bash), not `~/.zshrc`, but the bun installer writes to
> `~/.zshrc`. If `which bun` works in your terminal yet hooks can't find bun,
> copy the `BUN_INSTALL`/`PATH` export into `~/.zshenv` (or `~/.bashrc`).

## Install

```bash
cp -r dist/kiro-ide/.kiro your-project/.kiro
cp -r dist/kiro-ide/aidlc your-project/aidlc        # the workspace shell (spaces/default/memory) — a sibling of .kiro/, not inside it
cp dist/kiro-ide/AGENTS.md your-project/AGENTS.md   # merge if you already have one
```

The `aidlc/` directory is the workspace shell — it ships the pre-built
`aidlc/spaces/default/memory/` method tree the engine reads. It is a **sibling**
of `.kiro/`, so copy it separately (or copy the whole `dist/kiro-ide/` tree at
once). `/aidlc --doctor` fails its "workspace shell ready" check if it is missing.

Open `your-project/` in Kiro IDE. The install ships:

- `.kiro/skills/aidlc/SKILL.md` — the conductor loaded when you invoke
  `/aidlc`. The shipped `.kiro/settings/cli.json` and agent-v1 JSON files are
  CLI-only compatibility surfaces; they do not select an IDE default agent.
- `.kiro/hooks/*.kiro.hook` — the framework hooks registered in the IDE's
  native hook format. They appear in the IDE's Agent Hooks panel.

In the chat panel, run `/aidlc --doctor` to verify the setup, then
`/aidlc <description>` to start a workflow.

## Usage

Identical to the Claude Code harness: `/aidlc <description>` starts a
workflow, `/aidlc --status` reports position, `/aidlc --doctor`, `--stage`,
`--phase`, `--depth`, `--test-strategy` all work, and the
per-stage (`/aidlc-application-design`) and per-scope (`/aidlc-feature`) runner
skills are installed. There is no init command — the shipped shell scaffolds
the workspace and the first intent auto-births on your first `/aidlc`.

## How hooks work on Kiro IDE

Kiro IDE registers hooks through `.kiro.hook` files under `.kiro/hooks/` (a
different mechanism from Kiro CLI, which reads a `hooks` block inside the agent
JSON). Each `.kiro.hook` runs a command that routes through the shared
`aidlc-kiro-adapter.ts` shim, which normalizes the IDE's hook event into the
shape the byte-shared core hooks expect.

The IDE delivers hook context through the **`USER_PROMPT` environment variable**
(not stdin — the IDE opens stdin but never writes to it). `USER_PROMPT` is a JSON
string `{ toolName, toolArgs, toolResult, toolSuccess }`. The IDE leaves
`toolArgs` empty, so the adapter recovers the written file path from the
`toolResult` text and drives the payload-free hooks (`runtime-compile`,
`sync-statusline`) off the audit trail instead of a tool payload.

| Hook | IDE event | Purpose |
|------|-----------|---------|
| `aidlc-session-start` | `promptSubmit` | Injects workflow resume context |
| `aidlc-mint` | `promptSubmit` | Records a human-turn event on every prompt (human-presence gate) |
| `aidlc-session-end` | `agentStop` | Emits `SESSION_ENDED` (observability) |
| `aidlc-stop` | `agentStop` | Forwarding-loop continuation |
| `aidlc-block` | `preToolUse` | Hard-blocks tool calls while an approval gate is open and no human has acted since (human-presence floor) |
| `aidlc-audit-logger` | `postToolUse` (write) | Logs artifact create/update (path from `toolResult`) |
| `aidlc-sensor-fire` | `postToolUse` (write) | Fires applicable sensors (path from `toolResult`) |
| `aidlc-runtime-compile` | `postToolUse` (shell) | Recompiles the runtime graph (gated on the audit tail) |
| `aidlc-sync-statusline` | `postToolUse` (shell) | Forward-only sync of `Current Stage` from the latest `STAGE_STARTED` in the audit (the `spec` event never fires in the IDE) |

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

## What's different on Kiro IDE

| Area | Claude Code | Kiro IDE |
|------|-------------|----------|
| Hook registration | `settings.json` `hooks` block | `.kiro/hooks/*.kiro.hook` files (shown in the Agent Hooks panel) |
| Gates & questions | `AskUserQuestion` widget | Numbered prose options (reply with a number); the questions FILE with `[Answer]:` tags stays the source of truth |
| Statusline | Current stage + model + context % | Not available — use `/aidlc --status` and the progress line at each gate |
| Dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent) | `Task` tool | Kiro `subagent` tool → the agent configs (all 14 personas); the IDE reads a delegate's tool grants from the agent `.md` frontmatter (`tools:`), injected at packaging - the agent-v1 JSONs are CLI-only |
| Construction swarm | Parallel `Task` floor, optional ultracode Workflow | Subagent fan-out only; `AIDLC_USE_SWARM=1` is announced as a no-op |
| Session audit events | `SESSION_STARTED/RESUMED/ENDED`, `SESSION_COMPACTED` | `SESSION_STARTED` / `SESSION_ENDED` (no pre-compaction event) |
| MCP servers | Ships 5 (`.mcp.json`: `context7` + four AWS servers) | None shipped |

Everything else — state machine, audit trail, artifacts under the per-intent
record dir (`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`), the learnings
ritual, sensors, scopes, depth/test-strategy — behaves identically, because it
IS identical: the same tools run from `.kiro/tools/`.

A project's `aidlc/` workspace is harness-neutral. Moving a project between
harnesses (or running both side by side) is supported-but-untested; `/aidlc
--doctor` will warn if it detects a conflicting harness setup with an active
workflow.

## For framework developers

`dist/kiro-ide` is **generated** from `core/` + `harness/kiro-ide/` by
`bun scripts/package.ts kiro-ide` (core copy with the `{{HARNESS_DIR}}` token
substituted to `.kiro` and the `rules/` → `steering/` rename). `bun
scripts/package.ts --check` is the drift guard and runs in CI. The authored
Kiro IDE surfaces live in `harness/kiro-ide/`: the orchestrator skill
(`skills/aidlc/`), CLI-compatibility agent JSONs (`agents/`), the hook adapter
and `.kiro.hook` files (`hooks/`), CLI-only `settings/cli.json`, and
`AGENTS.md` — edit those (or `core/`), never the generated `dist/kiro-ide`.

The IDE harness differs from the CLI harness (`harness/kiro/`) in three ways:
the `/aidlc` skill is its conductor rather than an agent selected through
`settings/cli.json`; it ships `.kiro.hook` files (the CLI relies on the
agent-JSON `hooks` block, which the IDE ignores); and its manifest injects a
`tools:` frontmatter grant into the delegation-target agent `.md` files
(`frontmatterAdditions`), because the IDE resolves a delegated subagent's tools
from the `.md` frontmatter rather than the agent-v1 JSON - without the grant an
IDE delegate runs toolless. Note the frontmatter grant is unscoped (the IDE has
no `allowedCommands`/`allowedPaths` equivalent there), wider than the CLI JSON
sandbox.
See [Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md).

## Next steps

Installed and activated? The methodology is the same on every harness — keep
going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 32 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [AI-DLC on Codex CLI](codex-cli.md) · [the harness family index](README.md).
