# AI-DLC on Devin CLI

`dist/devin/` is the framework's harness distribution for the **Devin CLI**
harness. One deterministic core, many harnesses: the engine, state machine,
audit log, graph, swarm referee, and learnings gate are byte-identical across
every distribution — only the shell differs. The tree is **generated** from
`core/` + `harness/devin/` by `bun scripts/package.ts devin`; never hand-edit it
(the drift guard fails CI).

## Prerequisites

- **Devin CLI ≥ 3000.10.21** — the selected AIDLC support baseline, shared by
  config diagnostics and `/aidlc --doctor`. This baseline does not claim that
  every required capability first appeared in this release. Check with
  `devin --version`.
- **bun** — same requirement as every harness; every tool and hook runs via
  bun. Install via `curl -fsSL https://bun.sh/install | bash` (or
  `npm install -g bun` / `powershell -c "irm bun.sh/install.ps1 | iex"` on
  Windows). `bun` must be on PATH for non-interactive shells — Devin sources
  `~/.zshenv`/`~/.bashrc`.
- **Model & environment (user-level)** — model/env/effort are user-level on
  Devin, NOT in the project config. Set your model in
  `~/.config/devin/config.json` (or `%APPDATA%\devin\config.json` on Windows).
- **MCP servers (optional)** — `.devin/mcp_config.json` bundles the same five
  servers as Kiro: `context7`, `aws-mcp`, `aws-pricing`, `aws-iac`, and
  `aws-serverless`. All five MCP servers are disabled by default. Disabled
  registrations provide no tools to the session and do not start server
  processes. MCP availability is not a prerequisite for an AIDLC workflow.

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

Devin may prompt to approve project hooks on first run. Inspect the loaded
hooks via `/hooks` — per the official
[hooks reference](https://docs.devin.ai/cli/extensibility/hooks/overview),
`/hooks` lists the currently loaded hooks and their source files — approve the
AI-DLC hooks if prompted, then **fully restart Devin CLI** (`/clear` is not
enough — unapproved hooks silently no-op). The SessionStart adapter records
each successful run in `.devin/.aidlc-session-start.local.json` (gitignored,
machine-local); `/aidlc --doctor` fails when that evidence is absent or
invalid. A valid marker is historical execution evidence only — it does not
verify current hook approval, that every hook/gate works, or that approval was
not later revoked.

## Optional MCP setup

Review the server you want to use and supply its prerequisites before enabling
it. In `.devin/mcp_config.json`, change only that entry's `"disabled": true` to
`"disabled": false`. Leave unused servers disabled; the registry already ships
with the installation, so there is no separate example file to copy.

Alternatively, use the native project-scoped commands:

```bash
devin mcp enable -s project context7
devin mcp disable -s project context7
devin mcp list
```

The enable and disable commands are alternatives for the desired state, not
steps to run together. `/mcp` shows MCP status. After changing settings, restart
the session if needed before verifying the selected server. Live MCP
verification is optional and does not gate an AIDLC workflow.

- **Context7** — the existing HTTP header uses the literal placeholder
  `${CONTEXT7_API_KEY}`. When opting in, supply `CONTEXT7_API_KEY` securely
  through the environment or private local configuration. Never commit a
  literal key or put it in shell history.
- **AWS servers** — install `uvx` and the chosen package's supported Python
  runtime, and supply appropriate AWS credentials and permissions when enabled.
  The shipped AWS proxy endpoint and metadata retain `us-east-1`; review them
  for your account. Missing credentials are not a substitute for `disabled: true`.
- **Package versions** — the four `@latest` launchers are retained to match
  Kiro. Enabling a server can resolve a changing third-party package version;
  default-off behavior is not dependency pinning or a supply-chain lock. You
  may pin your own enabled configuration to reviewed versions.
- **Permissions** — MCP tool calls are not blanket-pre-approved. Enabling a
  server and approving its tools are separate decisions; approve only the tools
  or servers you intend to use, subject to Devin's effective permission mode
  and user/team policies.

The project registry `.devin/mcp_config.json` is shared with the team. Keep
personal MCP settings and credentials in `.devin/mcp_config.local.json` and
keep that file gitignored. User-wide MCP configuration lives in
`~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows).
Use personal settings for individual choices without changing shared defaults;
inspect local and user configurations when checking the effective server state.

**Existing installs:** these flags apply to the shipped defaults, not an
automatic migration. Before replacing or merging configuration, preserve custom
server entries and deliberate enablement choices. To adopt default-off behavior
in an existing install, explicitly set `disabled: true` on the relevant entries
and inspect local/user overrides. Do not delete your configurations.

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
  engine binary is invoked via `exec` (`bun .devin/tools/...`). The agent slug
  is passed as the `profile` field of each `run_subagent` call (the adapter and
  the `deliver-stage-rules` / `plan-approval-guard` hooks match on
  `tool_input.profile`, not the prompt text). **Dispatched agents run on the
  default subagent model (SWE-1.6 by default), not the parent's model** — the
  AIDLC agent files carry no `model:` frontmatter. To run dispatched agents on
  your primary model, set the org/enterprise "Default subagent model" to it.
- **Method ambient context** — `.devin/rules/aidlc.md` is auto-loaded by Devin
  (no `@`-import chain, unlike Claude). AIDLC's stage resolver reads
  `aidlc/spaces/<space>/memory/` directly, so stage correctness is unaffected.
- **Hook wiring** — `.devin/hooks.v1.json` (the whole file IS the hooks object
  — no `"hooks"` wrapper key). Seven events map onto the adapter's 15 targets.
- **Permissions** — `.devin/config.json` pre-approves reads, edits, writes,
  search, subagent dispatch, structured questions, web search, and web fetch.
  Copy installs pre-approve `bun .devin/tools/*`, `bun run .devin/tools/*`, and
  `date -u`; native installs pre-approve the installed `aidlc engine` command
  prefix and `date -u`. General Bun, Git, Node, npm, npx, and uvx commands are
  not blanket-pre-approved. Personal overrides live in
  `.devin/config.local.json` and `.devin/mcp_config.local.json` (both
  gitignored).

### Permission and guard boundaries

The shipped configuration uses an allow-list only; it does not enforce a
general prohibition on destructive commands. Removing the previous deny rules
also removes their explicit restrictions on `sudo`, matching `rm -rf` commands,
and matching `.env*` writes. An unmatched operation follows Devin's effective
permission mode and other configured rules; absence from the allow-list is not
an unconditional denial.

AI-DLC guard hooks enforce workflow-specific invariants: state-transition
ownership, reviewer scope, review-artifact freezes, and approval before code
generation. They are conditional workflow guards, not a general
destructive-command security boundary or a replacement for Devin permission
policies, organization controls, and appropriate OS sandboxing. Inspect project
hooks via `/hooks`, approve them if prompted, and fully restart Devin CLI to
activate them.

The allow-only shape and broad file-tool grants follow Claude Code;
framework-scoped shell grants follow both Claude Code and Kiro CLI. This does
not copy Kiro's explicit recursive-`rm` and `git push` denials. The
`read_config_from` settings for Cursor, Windsurf, and Claude remain `false`
intentionally.

For existing installs, review the generated configuration before applying or
merging it. Preserve deliberate local/team policy; local or user-level grants
may still pre-approve commands or MCP tools removed from these shipped
defaults. No workflow-record migration is required.

## Git integration

Same as every harness — commit the `aidlc/` workspace tree (state, audit
shards, memory, codekb, knowledge); the shipped `.gitignore` excludes per-user
cursors and machine-local runtime.

## Doctor

Run `/aidlc --doctor` after install. It checks the adapter and the four wiring
files (`hooks.v1.json`, `config.json`, `mcp_config.json`, and `rules/aidlc.md`),
checks the Devin CLI version, and verifies hook execution evidence: the
SessionStart adapter writes `.devin/.aidlc-session-start.local.json` after a
successful run, and doctor fails when that marker is absent or invalid —
inspect `/hooks`, approve the AI-DLC hooks if prompted, fully restart Devin
CLI, then rerun doctor (if evidence is still missing, check
`.devin/hooks.v1.json`, the hook runtime, and `.devin` write permissions). A
valid marker is historical execution evidence only; it does not verify current
hook approval. The marker path is ignored by the shipped `.gitignore`;
existing installs must update the adapter and doctor together, merge the new
ignore entry, and fully restart Devin CLI to generate evidence. The MCP check
verifies registry presence, not live MCP availability; disabled servers do not
fail it.

`devin doctor --json` emits CFG005 warnings for `display_name`, `examples`,
`disallowedTools`, and `maxTurns` on `.devin/agents/*.md` when those fields are
present. This is expected and does not indicate a broken install — those
fields are authored once in `core/agents/` for the harnesses that consume them,
and Devin's native agent loader simply ignores them.

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
