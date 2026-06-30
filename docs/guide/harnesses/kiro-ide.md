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

- `.kiro/settings/cli.json` with `chat.defaultAgent: "aidlc"`, so the AI-DLC
  conductor agent is active by default — `/aidlc` just works.
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

| Hook | IDE event | Purpose |
|------|-----------|---------|
| `aidlc-session-start` | `promptSubmit` | Injects workflow resume context |
| `aidlc-mint` | `promptSubmit` | Stamps a human-presence marker on every prompt (issue #451 gate) |
| `aidlc-session-end` | `agentStop` | Emits `SESSION_ENDED` (observability) |
| `aidlc-stop` | `agentStop` | Forwarding-loop continuation |
| `aidlc-block` | `preToolUse` | Hard-blocks tool calls while an approval gate is open and no human has acted since (issue #451 floor) |
| `aidlc-audit-logger` | `postToolUse` (write) | Logs artifact create/update |
| `aidlc-sensor-fire` | `postToolUse` (write) | Fires applicable sensors |
| `aidlc-runtime-compile` | `postToolUse` (shell) | Recompiles the runtime graph |
| `aidlc-sync-statusline` | `postToolUse` (spec) | Syncs state on task transitions |

You will see a "Run Command Hook" line in chat each time one fires.

## What's different on Kiro IDE

| Area | Claude Code | Kiro IDE |
|------|-------------|----------|
| Hook registration | `settings.json` `hooks` block | `.kiro/hooks/*.kiro.hook` files (shown in the Agent Hooks panel) |
| Gates & questions | `AskUserQuestion` widget | Numbered prose options (reply with a number); the questions FILE with `[Answer]:` tags stays the source of truth |
| Statusline | Current stage + model + context % | Not available — use `/aidlc --status` and the progress line at each gate |
| Subagent stages (2.1, 3.5) | `Task` tool | Kiro `subagent` tool → `aidlc-developer-agent` / `aidlc-architect-agent` configs |
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
(`skills/aidlc/`), the agent JSONs (`agents/`), the hook adapter and
`.kiro.hook` files (`hooks/`), `settings/cli.json`, and `AGENTS.md` — edit
those (or `core/`), never the generated `dist/kiro-ide`.

The IDE harness differs from the CLI harness (`harness/kiro/`) in exactly two
ways: it ships `.kiro.hook` files (the CLI relies on the agent-JSON `hooks`
block, which the IDE ignores), and its `aidlc.json` omits that dead `hooks`
block. See [Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md).

## Next steps

Installed and activated? The methodology is the same on every harness — keep
going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 32 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [AI-DLC on Codex CLI](codex-cli.md) · [the harness family index](README.md).
