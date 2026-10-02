# AI-DLC on Google Antigravity

The Antigravity runtime is one of the framework's harness distributions, for
**Google Antigravity** (both the **Antigravity IDE** and the **Antigravity CLI** `agy`).

One deterministic core, many harnesses: the engine, state machine, audit log,
graph, swarm referee, and learnings gate are byte-identical across every
distribution — only the shell differs. The source tree is **generated** into
the ignored local `dist/antigravity/` directory from `core/` +
`harness/antigravity/` via `bun scripts/package.ts antigravity`; never hand-edit
generated outputs.

## Layout

Antigravity uses a split structure with native workspace customization in
`.agents/` and engine data isolated in `.aidlc/`:

- **`.agents/`** — the workspace customization surface:
  - `skills/aidlc/` — the orchestrator skill (`SKILL.md`), question rendering, and stage runners (`aidlc-stage-*.md`, `aidlc-session-*.md`).
  - `hooks.json` — hook lifecycle configuration invoking the Antigravity adapter.
  - `rules/` — ambient workspace rules and phase pointers.
- **`.aidlc/`** — the inert engine directory containing `tools/`, `hooks/` (including `aidlc-antigravity-adapter.ts`), `aidlc-common/`, `knowledge/`, `sensors/`, and `scopes/`.
- **`aidlc/`** — the workspace shell (`aidlc/spaces/default/memory/` method tree).
- **`AGENTS.md`** — project-root ambient instructions auto-read by Antigravity agents.

## Prerequisites

- **Google Antigravity** — Antigravity IDE or Antigravity CLI (`agy`).
- **Bun** (for local development or running hook commands in the background).
- **Model** — Antigravity agents inherit the active session model configured in your IDE or CLI environment. Capable reasoning models (such as Claude Opus 4.8 / Claude 3.7 Sonnet / Gemini 2.5 Pro) are recommended.

## Install

### Native channel (recommended)

Install the native command as described in
[Install and Lifecycle](../18-install-and-lifecycle.md), then:

```bash
cd your-project
aidlc config --harness antigravity
aidlc doctor
```

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-copy-runtime-X.Y.Z.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then install that versioned projection:

```bash
bun "$RUNTIME_ROOT/antigravity/install.ts" your-project
```

Open the project in Antigravity IDE (or start `agy` in your terminal) and describe what you want to build:

```text
/aidlc Build a REST API for inventory management
```

## What's different on this harness

- **Questions render as numbered prose options** when interactive multi-choice widgets are not active; the questions file with `[Answer]:` tags remains the canonical source of truth.
- **Hooks ride `.agents/hooks.json`** through the Antigravity adapter (`.aidlc/hooks/aidlc-antigravity-adapter.ts`), normalizing Antigravity hook events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `SubagentStop`, `Stop`) into core hook contracts.
- **Session model inheritance**: Personas project with no hard-coded model pins, cleanly adopting your session-level model configuration.
