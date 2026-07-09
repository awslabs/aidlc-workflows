# Running AI-DLC on Kiro CLI

> [!NOTE]
> AI-DLC on Kiro CLI works best with **Claude Opus 4.8**, which requires a
> **paid Kiro plan**. On weaker models the conductor may skip optional stage
> steps (reviewer pass, learnings ritual) or rush approval gates. The
> IDE-targeted distribution is documented separately in
> [Running AI-DLC on Kiro IDE](kiro-ide.md).

One of the framework's harnesses: `dist/kiro/` runs the same AI-DLC
methodology on [Kiro CLI](https://kiro.dev/docs/cli/). One deterministic core
— the tools, 32 stage files, protocols, knowledge, sensors, scopes, and rules
— is byte-shared across every harness; only the shell (skills, agent
configs, hook wiring, activation) differs.

## Prerequisites

- **Kiro CLI ≥ 2.6** (`kiro-cli --version`), logged in (`kiro-cli login`)
- **bun** on your PATH (`curl -fsSL https://bun.sh/install | bash`)

## Install

```bash
cp -r dist/kiro/.kiro your-project/.kiro
cp -r dist/kiro/aidlc your-project/aidlc       # the workspace shell (spaces/default/memory) — a sibling of .kiro/, not inside it
cp dist/kiro/AGENTS.md your-project/AGENTS.md   # merge if you already have one
```

The `aidlc/` directory is the workspace shell — it ships the pre-built
`aidlc/spaces/default/memory/` method tree the engine reads. It is a **sibling**
of `.kiro/`, so copy it separately (or copy the whole `dist/kiro/` tree at once).
`/aidlc --doctor` fails its "workspace shell ready" check if it is missing.

Then start a session in your project:

```bash
kiro-cli chat
```

The install ships `.kiro/settings/cli.json` with `chat.defaultAgent: "aidlc"`,
so the AI-DLC conductor agent is active by default — `/aidlc` just works.
**This workspace setting takes precedence over a global default agent you may
have configured**; if you prefer your own default, remove that setting and use
`kiro-cli chat --agent aidlc` instead.

The same `cli.json` also ships per-model reasoning-effort defaults via
`chat.modelDefaults`: `xhigh` for the pinned orchestrator model
(`claude-opus-4.8`) so the conductor reasons at full depth out of the box, and
`high` for `claude-sonnet-4.5`, the model the balanced/templated agent tiers
pin (Kiro has no per-agent effort surface, so effort rides on the model; two
tiers sharing a model share its effort — the higher tier's value wins).
Judgment-tier agents pin no model at all: they follow your `/model` default
at that model's own default effort. This file is read by the Kiro CLI only —
the Kiro IDE ignores `cli.json` and applies its extension's per-model
defaults instead. Override per session with `/effort <level>` in chat or
`kiro-cli chat --effort <level>` (low|medium|high|xhigh|max) — a session flag
and your user-level `~/.kiro/settings/cli.json` both take precedence over the
workspace default.

## Usage

Identical to the Claude Code harness: `/aidlc <description>` starts a
workflow, `/aidlc --status` reports position, `--doctor`,
`--stage`, `--phase`, `--depth`, `--test-strategy` all work, and
the per-stage (`/aidlc-application-design`) and per-scope (`/aidlc-feature`)
runner skills are installed.

## What's different on Kiro

| Area | Claude Code | Kiro CLI |
|------|-------------|----------|
| Gates & questions | `AskUserQuestion` widget | Numbered prose options (reply with a number); the questions FILE with `[Answer]:` tags stays the source of truth |
| Statusline | Current stage + model + context % | Not available — use `/aidlc --status` and the progress line at each gate |
| Subagent stages (2.1, 3.5) | `Task` tool | Kiro `subagent` tool → `aidlc-developer-agent` / `aidlc-architect-agent` configs |
| Construction swarm | Parallel `Task` floor, optional ultracode Workflow | Subagent fan-out only; `AIDLC_USE_SWARM=1` is announced as a no-op |
| Session audit events | `SESSION_STARTED/RESUMED/ENDED`, `SESSION_COMPACTED` | `SESSION_STARTED` only (Kiro has no session-end / pre-compaction hooks) |
| Forwarding-loop enforcement (Stop hook) | Interactive + headless | Interactive sessions only — `--no-interactive` runs do not honor the stop-hook block |
| Permissions | `settings.json` allowlist | `aidlc` agent config: only `bun .kiro/tools/*` is pre-approved; other shell commands prompt |
| Welcome message | Rendered at session start from `settings.json` `companyAnnouncements` | None — Kiro has no welcome-render equivalent; the session-start hook injects resume context only |
| MCP servers | Ships 5 (`.mcp.json`: `context7` + four AWS servers) | None shipped, and the Kiro MCP config mechanism is not yet documented here — Claude-only today in practice |

Everything else — state machine, audit trail, artifacts under the intent
record dirs (`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`), the learnings
ritual, sensors, scopes, depth/test-strategy — behaves identically, because it
IS identical: the same tools run from `.kiro/tools/`.

A project's `aidlc/` workspace is harness-neutral. Moving a project between
harnesses (or running both side by side) is supported-but-untested; `/aidlc
--doctor` will warn if it detects a conflicting harness setup with an active workflow.

## For framework developers

`dist/kiro` is **generated** from `core/` + `harness/kiro/` by
`bun scripts/package.ts kiro` (core copy with the `{{HARNESS_DIR}}` token
substituted to `.kiro` and the `rules/` → `steering/` rename). `bun
scripts/package.ts --check` is the drift guard and runs in CI (t145). The
authored Kiro surfaces live in `harness/kiro/`: the orchestrator skill
(`skills/aidlc/`), the agent JSONs (`agents/`), the hook adapter
(`hooks/aidlc-kiro-adapter.ts`), `settings/cli.json`, and `AGENTS.md` — edit
those (or `core/`), never the generated `dist/kiro`. See
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
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 32 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [AI-DLC on Codex CLI](codex-cli.md) · [the harness family index](README.md).
