# AI-DLC on Devin CLI

`dist/devin/` is the framework's harness distribution for the **Devin CLI**
harness. One deterministic core, many harnesses: the engine, state machine,
audit log, graph, swarm referee, and learnings gate are byte-identical across
every distribution — only the shell differs. The tree is **generated** from
`core/` + `harness/devin/` by `bun scripts/package.ts devin`; never hand-edit it
(the drift guard fails CI).

## Prerequisites

- **Devin CLI ≥ 3000.3.0** — earlier versions lack the dedicated
  `mcp_config.json` files and the modern `.devin/` config layout
  (`hooks.v1.json` as the whole-hooks-object file, project config limited to
  permissions/read_config_from/hooks). `/aidlc --doctor` enforces the pin. Check
  with `devin --version`.
- **bun** — same requirement as every harness; every tool and hook runs via
  bun. Install via `curl -fsSL https://bun.sh/install | bash` (or
  `npm install -g bun` / `powershell -c "irm bun.sh/install.ps1 | iex"` on
  Windows). `bun` must be on PATH for non-interactive shells — Devin sources
  `~/.zshenv`/`~/.bashrc`.
- **Model & environment (user-level)** — model/env/effort are user-level on
  Devin, NOT in the project config. Set your model in
  `~/.config/devin/config.json` (or `%APPDATA%\devin\config.json` on Windows).
- **MCP servers (optional)** — `.devin/mcp_config.json` declares context7
  (HTTP, needs `CONTEXT7_API_KEY`) and four AWS servers (uvx, standard AWS
  credential chain). Servers you have no credentials for are simply unavailable
  and never block a workflow.

## Install

The copies below come from a clone of the
[aidlc-workflows](https://github.com/awslabs/aidlc-workflows) repository on the
`v2` branch:

```bash
git clone https://github.com/awslabs/aidlc-workflows.git
cd aidlc-workflows
git checkout v2
```

1. Copy the distribution into your project:

   ```bash
   cp -r dist/devin/.devin/ your-project/.devin/
   cp -r dist/devin/aidlc/   your-project/aidlc/      # the workspace shell (spaces/default/memory) — a sibling of .devin/
   cp dist/devin/AGENTS.md   your-project/AGENTS.md   # or merge into yours
   cp dist/devin/.gitignore  your-project/.gitignore  # or merge the AI-DLC section
   ```

   The `aidlc/` directory is the workspace shell — it ships the pre-built
   `aidlc/spaces/default/memory/` method tree the engine reads. It is a
   **sibling** of `.devin/`, so copy it separately (or copy the whole
   `dist/devin/` tree at once). `/aidlc --doctor` fails its "workspace shell
   ready" check if it is missing.

2. Apply the `.gitignore` entries from the shipped `.gitignore` **before**
   starting a workflow — the per-clone audit shards under each intent's
   `audit/` are committed deliberately (each clone writes its own
   `<host>-<clone>.md`, so concurrent appends never git-conflict), while
   per-user cursors and machine-local runtime state stay ignored.

## Approve hooks

Devin prompts to approve project hooks on first run. Run `/hooks`, approve the
AI-DLC hooks, then **fully restart Devin CLI** (`/clear` is not enough —
unapproved hooks silently no-op). This is the one manual step; the doctor
surfaces an advisory if hooks are unapproved.

## Use

Invoke the orchestrator with `/aidlc` followed by a scope or description — same
commands as the Claude harness (`/aidlc --status`, `/aidlc --help`, …). Stage
runners are explicit-only: `/aidlc-domain-design`, `/aidlc-bugfix`, etc.

## What's different on Devin

- **No custom statusline** — Devin has no `statusLine`/`status_bar` config
  field. Run `/aidlc --status` on demand for the current phase, stage, progress,
  and cost.
- **Welcome message** — delivered via the SessionStart hook's
  `additionalContext` (Devin has no equivalent broadcast field).
- **Structured gates** — render via Devin's native `ask_user_question` tool
  (per `question-rendering.md`). Gate semantics live in the engine.
- **Subagent dispatch** — uses `run_subagent` (Devin's subagent tool); the
  engine binary is invoked via `exec` (`bun .devin/tools/...`).
- **Method ambient context** — `.devin/rules/aidlc.md` is auto-loaded by Devin
  (no `@`-import chain, unlike Claude). AIDLC's stage resolver reads
  `aidlc/spaces/<space>/memory/` directly, so stage correctness is unaffected.
- **Hook wiring** — `.devin/hooks.v1.json` (the whole file IS the hooks object
  — no `"hooks"` wrapper key). Seven events map onto the adapter's 15 targets.
- **Permissions** — `.devin/config.json` pre-approves reads, edits, writes,
  search, `bun`/`git`/`node`/`npm`/`npx`/`uvx` exec, subagent dispatch,
  structured questions, web fetch, and all MCP tools — so workflows run without
  per-call permission prompts. Personal overrides via `.devin/config.local.json`
  and `.devin/mcp_config.local.json` (both gitignored).

## Git integration

Same as every harness — commit the `aidlc/` workspace tree (state, audit
shards, memory, codekb, knowledge); the shipped `.gitignore` excludes per-user
cursors and machine-local runtime.

## Doctor

Run `/aidlc --doctor` after install. It checks the adapter, the four wiring
files, the Devin CLI version, and surfaces the hook-approval advisory.

## Regenerating

```bash
bun scripts/package.ts devin          # regenerate dist/devin from core/ + harness/devin/
bun scripts/package.ts --check        # CI drift guard (every harness)
```

Core `.ts` files are byte-identical to their `core/tools/` and `core/hooks/`
sources (pinned by `tests/unit/t331-devin-packaging.test.ts`); prose carries the
`{{HARNESS_DIR}}` token the packager substitutes to `.devin`, the one permitted
transform class.

## Next steps

Installed and hooks approved? The methodology is the same on every harness —
keep going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [AI-DLC on Codex CLI](codex-cli.md) · [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md).
