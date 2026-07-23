# AI-DLC on GitHub Copilot

`dist/copilot/` is one of the framework's harness distributions, for **GitHub
Copilot** in VS Code agent mode. One deterministic core, many harnesses: the
engine, state machine, audit log, graph, swarm referee, and learnings gate are
byte-identical across every distribution — only the shell differs. The tree is
**generated** from `core/` + `harness/copilot/` by `bun scripts/package.ts
copilot`; never hand-edit it (the drift guard fails CI).

## Prerequisites

- **VS Code ≥ 1.102 with GitHub Copilot agent mode.** The harness ships as
  `.github/agents/`, `.github/skills/`, and `.github/hooks/` — agent mode,
  custom skills, subagent delegation, and hooks all require VS Code 1.102 or
  newer. Enable Copilot agent mode in the Copilot chat view.
- **A GitHub Copilot subscription** (or org seat) with agent-mode entitlement.
  Model access follows your Copilot plan; the shipped agents omit a `model:`
  pin and inherit the session model.
- **bun** on your PATH — the CLI tools and hook scripts run under bun. Install
  via `curl -fsSL https://bun.sh/install | bash`.

## Layout: everything under `.github/`

Copilot's zero-config discovery paths all start at `.github/`, so that is the
harness directory:

- **`.github/agents/`** — the 14 agent personas, each transposed to a
  Copilot-native `<slug>.agent.md` file (`name`, `description`, a `tools:`
  allowlist, `user-invocable: false`; `model:` is omitted so each agent inherits
  the session model). The orchestrator reaches them through Copilot's native
  subagent delegation.
- **`.github/skills/aidlc/`** — the `/aidlc` orchestrator skill plus every
  generated stage and scope runner (Copilot's skill discovery path).
- **`.github/hooks/`** — the byte-shared core hook bodies plus a single
  `hooks.json` wiring `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PreCompact`, `SubagentStop`, and `Stop` to the
  `aidlc-copilot-adapter.ts` shim. The shim normalizes Copilot's tool
  vocabulary (`runTerminalCommand` → `Bash`, `editFiles` → `Edit`, …) and
  camelCase `tool_input` keys to what the core hooks expect.
- **`.github/rules/`, `.github/tools/`, `.github/knowledge/`, …** — the method
  rule layers and the deterministic engine, copied verbatim from `core/`.
- **`AGENTS.md`** (project root) — Copilot auto-reads it as always-on context.
- **`aidlc/`** (project root) — the workspace shell: the active-space method
  tree at `aidlc/spaces/default/memory/`, plus state, audit, and artifacts.

## Install

Copy the generated tree into your project:

```bash
cp -R dist/copilot/.github <project>/
cp -R dist/copilot/aidlc    <project>/
cp    dist/copilot/AGENTS.md <project>/
```

Copilot auto-detects `.github/agents/`, `.github/skills/`, `.github/hooks/`, and
the root `AGENTS.md`. Then, in the Copilot chat view, run `/aidlc` followed by a
scope or a description of what you want to build.

## Verify the install

Run the doctor to confirm the layout:

```
/aidlc --doctor
```

## What's different on this harness

- **Gates** render as numbered chat prompts (agent mode has no dedicated
  question widget); the markdown Q&A file is always the source of truth.
- **No custom statusline and no welcome message** — workflow position is
  available on demand via `/aidlc --status`.
- **Model pinning is deferred**: the shipped `.agent.md` files omit `model:`
  (null projection), so every agent runs on the session's current model. This
  is a documented initial-delivery choice; tier-appropriate model selection is
  a validated follow-up.
- **The AIDLC method** lives once at the workspace root under
  `aidlc/spaces/<active-space>/memory/` — edit it there, never under `.github/`.
