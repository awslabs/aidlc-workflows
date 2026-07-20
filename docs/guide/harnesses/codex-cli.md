# AI-DLC on Codex CLI

`dist/codex/` is one of the framework's harness distributions, for the
OpenAI **Codex CLI** harness. One deterministic core, many harnesses: the
engine, state machine, audit log, graph, swarm referee, and learnings gate are
byte-identical across every distribution — only the shell differs. The
tree is **generated** from `core/` + `harness/codex/` by `bun scripts/package.ts codex`;
never hand-edit it (the drift guard fails CI).

## Prerequisites

- **Codex CLI ≥ 0.139.0** — earlier releases do not surface the real agent
  role in subagent hook payloads and do not resolve hyphenated agent TOMLs.
  `/aidlc --doctor` enforces the pin. Check with `codex --version`.
- **bun** — same requirement as the Claude harness; every tool and hook runs
  via bun.
- **A model provider** — the shipped `config.toml` defaults to **Amazon
  Bedrock** (`openai.gpt-5.5`; agents on `openai.gpt-5.4`). Set the AWS
  profile/region in `[model_providers.amazon-bedrock.aws]`. For OpenAI auth,
  comment out the provider lines. Note: `web_search` is unavailable on
  Bedrock; the market-research stage degrades gracefully.

## Install

1. Copy the distribution into your project (which must be a **git
   repository** — Codex only discovers a project `.codex/hooks.json` inside
   one):

   ```bash
   cp -r dist/codex/.codex/  your-project/.codex/
   cp -r dist/codex/.agents/ your-project/.agents/
   cp -r dist/codex/aidlc/   your-project/aidlc/      # the workspace shell (spaces/default/memory) — a sibling of .codex/, not inside it
   cp dist/codex/AGENTS.md   your-project/AGENTS.md   # or merge into yours
   ```

   The `aidlc/` directory is the workspace shell — it ships the pre-built
   `aidlc/spaces/default/memory/` method tree the engine reads. It is a
   **sibling** of `.codex/`, so copy it separately (or copy the whole
   `dist/codex/` tree at once). `$aidlc --doctor` fails its "workspace shell
   ready" check if it is missing.

2. Apply the `.gitignore` entries from the shipped `AGENTS.md` § "Git
   Integration" **before** starting a workflow — the per-clone audit shards
   under each intent's `audit/` are committed deliberately (each clone writes
   its own `<host>-<clone>.md`, so concurrent appends never git-conflict), while
   per-user cursors and machine-local runtime state stay ignored.

3. Trust the project and pre-seed hook trust. Codex never runs untrusted
   hooks (the `--dangerously-bypass-hook-trust` flag does not run them
   either). Either run one interactive TUI session and choose "Trust all and
   continue" at the hooks dialog, or pre-seed deterministically from the
   AI-DLC source checkout. Install its pinned development dependencies once,
   then generate the entries:

   ```bash
   bun install --frozen-lockfile
   bun scripts/package.ts codex trust --project "/abs/path/to/your project"
   ```

   The command prints ready-to-paste `[hooks.state]` entries for
   `$CODEX_HOME/config.toml`
   (the hash covers the hook identity, not the path — the printed entries are
   exact for the shipped `hooks.json`). The command serializes the complete
   output as TOML, so quoted paths, spaces, and Windows backslashes are
   preserved. If the hook manifest is not at `<project>/.codex/hooks.json`,
   pass its exact path explicitly:

   ```bash
   bun scripts/package.ts codex trust \
     --project "/abs/path/to/your project" \
     --hooks-json "/abs/custom path/hooks.json"
   ```

   Quote both arguments in the shell. `--hooks-json` is used verbatim as the
   Codex trust identity; do not normalize or replace it after generating the
   entries. Paste the command's complete stdout into the user config. If
   entries for the same `hooks.json` path already exist, replace that full set;
   do not append a second copy because duplicate TOML tables invalidate the
   entire config.

4. Merge the shipped `.codex/config.toml` into your `~/.codex/config.toml`
   (or keep it project-level — trusted projects read it). Verify with:

   ```bash
   bun .codex/tools/aidlc-utility.ts doctor
   ```

## Use

Invoke the orchestrator with `$aidlc` (or `/skills` → aidlc) followed by a
scope or description — same commands as the Claude harness (`$aidlc --status`,
`$aidlc --help`, …). Stage runners are explicit-only:
`$aidlc-application-design`, `$aidlc-bugfix`, etc. (they are excluded from
implicit skill matching so 37 runner descriptions don't pollute the index).

## Harness differences vs Claude Code

- **Gates** render via the `request_user_input` tool when the shipped config
  flags enable it, with a numbered-prose fallback otherwise (answer with a
  number or free text). Gate semantics live in the engine either way.
- **No custom statusline** — workflow position rides the `update_plan` tool
  (the `task-progress` statusline item) and `$aidlc --status`.
- **Git under the sandbox**: `workspace-write` keeps `.git` read-only
  in-sandbox by design. Interactive sessions auto-escalate, and the shipped
  `.codex/rules/default.rules` pre-allows `git worktree`/`commit`/`add`.
  Headless runs (CI, exec workers) need
  `writable_roots = ["<main repo>/.git"]` — template in the shipped
  `config.toml` (linked worktrees resolve into `<main>/.git/worktrees/*`,
  so it must be the main repo's `.git`).
- **Swarm floor = `codex exec` workers** — one headless worker per
  Construction unit in its Bolt worktree (always `< /dev/null`), with the
  same deterministic referee. `AIDLC_USE_SWARM=1` has no Workflow tool here
  and loud-degrades (`SWARM_DEGRADED` is audited).
- **Session lifecycle**: Codex has no SessionEnd event; an unclosed session
  is reconciled as an inferred `SESSION_ENDED` audit row at the next session
  start. The Codex-only PostCompact event re-injects the workflow mission
  after compaction — a determinism upgrade over the Claude harness.
- **Artifact audit fidelity**: in headless `codex exec` runs the model often
  writes files via shell heredocs, which bypass the `apply_patch` hook
  matcher — `ARTIFACT_*` rows can be sparse. Interactive TUI sessions (where
  the system prompt mandates `apply_patch`) are the high-fidelity audit mode.
- **AIDLC rule layers** live at the workspace root under `aidlc/spaces/<active-space>/memory/` (one hand-editable source, identical on every harness); the `AIDLC_RULES_DIR` env seam in `config.toml` points the resolver there and the orchestrator injects an `@aidlc/spaces/<active-space>/memory/...` prompt mention. Codex's native `.codex/rules/` directory holds Starlark permission rules — distinct from the AIDLC method.
- **No welcome message**: the Claude harness renders the Phases/Stages/Scopes
  onboarding banner from `settings.json` `companyAnnouncements` at session start;
  Codex has no equivalent. The session-start path injects resume context only.
- **MCP servers**: Codex reads MCP definitions from `[mcp_servers.<name>]`
  tables in `config.toml` (project `.codex/config.toml` or `~/.codex/config.toml`)
  — add the servers you need there. The shipped config declares **none** (the
  Claude harness ships five via `.mcp.json`; Codex ships zero by default).

## Regenerating

```bash
bun scripts/package.ts codex          # regenerate dist/codex from core/ + harness/codex/
bun scripts/package.ts --check        # CI drift guard (every harness)
```

Core `.ts` files are byte-identical to their `core/tools/` and `core/hooks/`
sources (pinned by `tests/unit/t150-codex-packaging.test.ts`); prose carries the
`{{HARNESS_DIR}}` token the packager substitutes to `.codex` (plus the
`rules/` → `aidlc-rules/` rename), the one permitted transform class. The live
end-to-end journey is `tests/e2e/t-exec-codex-status.serial.test.ts` (gate:
`AIDLC_CODEX_EXEC_LIVE=1`).

## Next steps

Installed and trusted? The methodology is the same on every harness — keep going
with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 32 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [Running AI-DLC on Kiro IDE](kiro-ide.md) · [the harness family index](README.md).
