# Running AI-DLC on Kiro CLI

> [!NOTE]
> AI-DLC on Kiro CLI works best with **Claude Opus 4.8**, which requires a
> **paid Kiro plan**. On weaker models the conductor may skip optional stage
> steps (reviewer pass, learnings ritual) or rush approval gates. The
> IDE-targeted distribution is documented separately in
> [Running AI-DLC on Kiro IDE](kiro-ide.md).

One of the framework's harnesses: the Kiro runtime runs the same AI-DLC
methodology on [Kiro CLI](https://kiro.dev/docs/cli/). One deterministic core
— the tools, 33 stage files, protocols, knowledge, sensors, scopes, and rules
— is byte-shared across every harness; only the shell (skills, agent
configs, hook wiring, activation) differs.

## Prerequisites

- **Kiro CLI ≥ 2.6** (`kiro-cli --version`), logged in (`kiro-cli login`)
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes are
  self-contained.

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
```

The installer verifies the release metadata, executable, and all-harness runtime archive against the published SHA-256 checksums. The installed runtime does not require Bun, Node.js, or Git. Harness selection happens in `aidlc config`.

On Windows, download `install.ps1` and run
`& $installer`. For an air-gapped package, use
`install.sh --from <release-directory> --offline` on Unix or
`& $installer -From <release-directory> -Offline` on Windows.

`aidlc config` projects the Kiro shell before the first chat session. Then start
Kiro from the project root:

```bash
kiro-cli chat
```

The native projection allows `aidlc engine *` engine commands. It also ships
`.kiro/settings/cli.json` with `chat.defaultAgent: "aidlc"`, so `/aidlc` is
active without an agent flag. Run `/aidlc --doctor` in chat before the first
workflow.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-runtime.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

```bash
mkdir -p your-project/.kiro your-project/aidlc
cp -R "$RUNTIME_ROOT/kiro/.kiro/." your-project/.kiro/
cp -R "$RUNTIME_ROOT/kiro/aidlc/." your-project/aidlc/    # the workspace shell (spaces/default/memory) — a sibling of .kiro/, not inside it
cp "$RUNTIME_ROOT/kiro/AGENTS.md" your-project/AGENTS.md  # merge if you already have one
# Existing .gitignore: preserve it and merge only the section beginning "# AI-DLC".
if [ ! -e your-project/.gitignore ]; then
  cp "$RUNTIME_ROOT/kiro/.gitignore" your-project/.gitignore
fi
```

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

Start `kiro-cli chat` in the project, then invoke the conductor with
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

## What's different on Kiro

| Area | Claude Code | Kiro CLI |
|------|-------------|----------|
| Gates & questions | `AskUserQuestion` widget | Numbered prose options (reply with a number); the questions FILE with `[Answer]:` tags stays the source of truth |
| Statusline | Current stage + model + context % | Not available — use `/aidlc --status` and the progress line at each gate |
| Dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent) | `Task` tool | Kiro `subagent` tool → the agent configs (all 14 personas ship configs) |
| Construction swarm | Parallel `Task` floor, optional ultracode Workflow | Subagent fan-out only; `AIDLC_USE_SWARM=1` is announced as a no-op |
| Session audit events | `SESSION_STARTED/RESUMED/ENDED`, `SESSION_COMPACTED` | `SESSION_STARTED` only (Kiro has no session-end / pre-compaction hooks) |
| Forwarding-loop enforcement (Stop hook) | Interactive + headless | Interactive sessions only — `--no-interactive` runs do not honor the stop-hook block |
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
temporary roots and byte-compares the results as the CI determinism guard. The
authored Kiro surfaces live in `harness/kiro/`: the orchestrator skill
(`skills/aidlc/`), the agent JSONs (`agents/`), the hook adapter
(`hooks/aidlc-kiro-adapter.ts`), `settings/cli.json`, `settings/mcp.json`, and `AGENTS.md` — edit
those (or `core/`), never hand-edit the generated `dist/kiro`. See
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
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [AI-DLC on Codex CLI](codex-cli.md) · [AI-DLC on Cursor](cursor.md) · [the harness family index](README.md).
