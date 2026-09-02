# AI-DLC on Codex CLI

The Codex runtime is one of the framework's harness distributions, for the
OpenAI **Codex CLI** harness. One deterministic core, many harnesses: the
engine, state machine, audit log, graph, swarm referee, and learnings gate are
byte-identical across every distribution — only the shell differs. The
source/development tree is **generated** into ignored local `dist/codex/` from
`core/` + `harness/codex/` by `bun scripts/package.ts codex`; never hand-edit it.

## Prerequisites

- **Codex CLI >= 0.145.0** - earlier releases defer compact-source
  `SessionStart` after a mid-turn auto-compaction, so one model continuation
  can run without the restored workflow mission. Releases before 0.139.0 also
  lack reliable subagent role attribution and hyphenated agent-TOML resolution.
  `/aidlc --doctor` advises on the pin. Check with `codex --version`.
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes are
  self-contained.
- **A Git repository for the target project** — Codex discovers project
  `.codex/hooks.json` only inside one. The native installer and AI-DLC runtime
  themselves do not depend on Git.
- **A model provider** — the shipped `config.toml` defaults to **Amazon
  Bedrock** (`openai.gpt-5.5`; agents on `openai.gpt-5.6-terra`). Set the AWS
  profile/region in `[model_providers.amazon-bedrock.aws]`. For OpenAI auth,
  comment out the provider lines. Note: `web_search` is unavailable on
  Bedrock; the market-research stage degrades gracefully.

## Install

### Native channel (recommended)

```bash
tmp="$(mktemp -d)"
gh release download --repo awslabs/aidlc-workflows-releases --dir "$tmp" \
  --pattern install.sh --pattern aidlc-release.intoto.jsonl
gh attestation verify "$tmp/install.sh" \
  --bundle "$tmp/aidlc-release.intoto.jsonl" \
  --repo awslabs/aidlc-workflows \
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config
aidlc doctor
codex
```

The installer verifies the release metadata, executable, and all-harness runtime archive against the published SHA-256 checksums. The installed runtime does not require Bun, Node.js, or Git. Harness selection happens in `aidlc config`.

On Windows, download `install.ps1` and run
`& $installer`. An interactive run may omit the flag;
redirected input, `pwsh -NonInteractive`, `--yes`, `--json`, and `--quiet`
require it. For an air-gapped package, use
`install.sh --from <release-directory> --offline` on Unix or
`& $installer -From <release-directory> -Offline` on Windows.

`aidlc config` projects the Codex shell, merges the AI-DLC blocks in `.gitignore`
and `AGENTS.md`, and writes `.codex/config.toml`, hooks, permission rules, and
the matching `.codex/trust-seed.toml`. Codex requires one project-specific hook
trust action before those hooks run:

- Start `codex` and choose **Trust all and continue** at the hooks dialog; or
- Replace `<PROJECT_DIR>` in `.codex/trust-seed.toml` with the absolute project
  path and merge its complete `[hooks.state]` set into
  `$CODEX_HOME/config.toml`. Replace an existing set for that hooks path rather
  than appending duplicate TOML tables.

Merge the generated `.codex/config.toml` settings into your user config as
needed. Then run `$aidlc --doctor` in Codex.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-runtime.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

1. Copy the distribution into your project (which must be a **git
   repository** — Codex only discovers a project `.codex/hooks.json` inside
   one):

   ```bash
   cp -r "$RUNTIME_ROOT/codex/.codex/"  your-project/.codex/
   cp -r "$RUNTIME_ROOT/codex/.agents/" your-project/.agents/
   cp -r "$RUNTIME_ROOT/codex/aidlc/"   your-project/aidlc/      # the workspace shell (spaces/default/memory) — a sibling of .codex/, not inside it
   cp "$RUNTIME_ROOT/codex/AGENTS.md"   your-project/AGENTS.md   # or merge into yours
   ```

   The `aidlc/` directory is the workspace shell — it ships the pre-built
   `aidlc/spaces/default/memory/` method tree the engine reads. It is a
   **sibling** of `.codex/`, so copy it separately (or copy the whole
   `$RUNTIME_ROOT/codex/` tree at once). `$aidlc --doctor` fails its "workspace shell
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

   Re-run this trust command whenever an AI-DLC upgrade changes `.codex/hooks.json`,
   including upgrades that add a new matcher. Replace the old tables before
   opening a fresh Codex session; otherwise Codex silently skips the new hook.

4. Back in `your-project/` (step 3 ran from the AI-DLC source checkout), merge
   the shipped `.codex/config.toml` into your `~/.codex/config.toml` (or keep
   it project-level — trusted projects read it). Verify with:

   ```bash
   cd your-project
   bun .codex/tools/aidlc-utility.ts doctor
   ```

The versioned runtime uses the native `aidlc` command. Framework developers who
need the Bun-shaped projection can clone the repository, run
`bun install --frozen-lockfile` and `bun scripts/package.ts`, then use the
ignored local `dist/codex/` output. The source-checkout trust generator is
specific to those Bun-shaped hook commands and is not used by the native
runtime.

## Refresh and version skew

`aidlc update` updates the machine runtime but does not rewrite projects.
`aidlc doctor` compares the project runtime stamp with the selected engine.
Between workflows, preview and apply the project refresh:

```bash
aidlc config --dry-run
aidlc config
```

Config preserves user-owned content and reports local framework edits as
conflicts. It refuses refresh while any workflow is active; complete the
workflow first. Upgrade and rollback remain safe during a workflow because
they do not touch project files. A refresh can change Codex hook identities, so
approve the new trust dialog or replace the matching trust-seed entries after
config when Codex requests it.

## Use

Invoke the orchestrator with `$aidlc` (or `/skills` → aidlc) followed by a
scope or description — same commands as the Claude harness (`$aidlc --status`,
`$aidlc --config [section]`, `$aidlc --help`, and related forms). Stage runners are explicit-only:
`$aidlc-domain-design`, `$aidlc-bugfix`, etc. (they are excluded from
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
  emitted Construction Unit in the isolated worktree for that Unit's Bolt
  (always `< /dev/null`), with the
  same deterministic referee. `AIDLC_USE_SWARM=1` has no Workflow tool here
  and loud-degrades (`SWARM_DEGRADED` is audited).
- **Session lifecycle**: Codex has no SessionEnd event; an unclosed session
  is reconciled as an inferred `SESSION_ENDED` audit row at the next session
  start. After compaction, Codex emits SessionStart with `source=compact`;
  that supported event re-injects the workflow mission before the first
  post-compaction continuation. This immediate drain is why AI-DLC requires
  Codex >= 0.145.0.
- **Artifact audit fidelity**: in headless `codex exec` runs the model often
  writes files via shell heredocs, which bypass the `apply_patch` hook
  matcher — `ARTIFACT_*` rows can be sparse. Interactive TUI sessions (where
  the system prompt mandates `apply_patch`) are the high-fidelity audit mode.
- **AIDLC rule layers** live at the workspace root under `aidlc/spaces/<active-space>/memory/` (one hand-editable source, identical on every harness); the `AIDLC_RULES_DIR` env seam in `config.toml` points the resolver there and the orchestrator injects an `@aidlc/spaces/<active-space>/memory/...` prompt mention. Codex's native `.codex/rules/` directory holds Starlark permission rules — distinct from the AIDLC method.
- **No welcome message**: the Claude harness renders the Phases/Stages/Scopes
  onboarding banner from `settings.json` `companyAnnouncements` at session start;
  Codex has no equivalent. The session-start path injects workflow context only.
- **MCP servers**: Codex reads MCP definitions from `[mcp_servers.<name>]`
  tables in `config.toml` (project `.codex/config.toml` or `~/.codex/config.toml`)
  — add the servers you need there. The shipped config declares **none** (the
  Claude harness ships five via `.mcp.json`; Codex ships zero by default).

## Regenerating

```bash
bun scripts/package.ts codex          # regenerate dist/codex from core/ + harness/codex/
bun scripts/package.ts --check        # build twice and byte-compare (every harness)
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
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [Running AI-DLC on Kiro IDE](kiro-ide.md) · [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md).
