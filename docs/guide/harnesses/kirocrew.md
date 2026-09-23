# Running AI-DLC on Kiro Crew

> [!NOTE]
> Kiro Crew is an autonomous agent-management layer that drives the Kiro CLI: a
> Kiro Crew session runs `kiro-cli chat` under its gateway, adding persistent
> memory, scheduled jobs, and background subagents. Because it IS a Kiro CLI
> layer, AI-DLC on Kiro Crew is the Kiro CLI distribution under the Kiro Crew
> product identity — the same core, the same `.kiro/` tree, the same hook
> adapter. It works best with **Claude Opus 4.8**, which requires a **paid Kiro
> plan**. The Kiro CLI distribution is documented separately in
> [Running AI-DLC on Kiro CLI](kiro-cli.md).

One of the framework's harnesses: the Kiro Crew runtime runs the same AI-DLC
methodology through [Kiro Crew](https://kiro.dev/docs/cli/). One deterministic
core — the tools, 33 stage files, protocols, knowledge, sensors, scopes, and
rules — is byte-shared across every harness; only the shell (skills, agent
configs, hook wiring, activation) differs, and here that shell is the Kiro CLI's.

Harness-specific onboarding lives in `.kiro/steering/aidlc-onboarding.md`,
loaded through the conductor agent's `resources`. The root `AGENTS.md` block is
harness-neutral and shared with other installed harnesses; engine directories
must still differ (Kiro CLI, Kiro IDE, and Kiro Crew all use `.kiro/`, so a
single project configures one of them at a time).

## Prerequisites

- **Kiro CLI ≥ 2.6** (`kiro-cli --version`), logged in — Kiro Crew runs the CLI
  under its gateway
- **Kiro Crew** installed and its gateway running (the layer that manages the
  session, its memory, and the gateway-watched hook store)
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes are
  self-contained.

## Install

### Native channel (recommended)

Download and run the published installer (verify it, then run it as a local
file rather than piping the network straight to a shell):

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config --harness kirocrew
aidlc doctor
```

The installer verifies the release metadata, executable, and all-harness runtime
archive against the published SHA-256 checksums. The installed runtime does not
require Bun, Node.js, or Git. Harness selection is `aidlc config --harness
kirocrew`.

On Windows, download `install.ps1` and run `& $installer`. For an air-gapped
package, use `install.sh --from <release-directory> --offline` on Unix or
`& $installer -From <release-directory> -Offline` on Windows.

`aidlc config --harness kirocrew` projects the Kiro Crew shell into the project
and, on Kiro Crew, **registers the AI-DLC lifecycle hooks in the gateway-watched
hook store** (`~/.kiro/crew/hooks.json`) through Kiro Crew's hook API and routes
the gated tools through permission requests. That registration is what makes the
approval gates work with **zero manual steps** — you do not hand-edit the hook
store, because the running gateway owns it and resets a hand-added entry. Then
start a Kiro Crew session in the project and run `/aidlc --doctor` before the
first workflow.

The native projection allows `aidlc engine *` engine commands. It also ships
`.kiro/settings/cli.json` with `chat.defaultAgent: "aidlc"`, so `/aidlc` is
active without an agent flag.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-copy-runtime-X.Y.Z.tar.gz` as
described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

```bash
mkdir -p your-project/.kiro your-project/aidlc
cp -R "$RUNTIME_ROOT/kirocrew/.kiro/." your-project/.kiro/
cp -R "$RUNTIME_ROOT/kirocrew/aidlc/." your-project/aidlc/    # the workspace shell (spaces/default/memory) — a sibling of .kiro/, not inside it
cp "$RUNTIME_ROOT/kirocrew/AGENTS.md" your-project/AGENTS.md  # merge if you already have one
# Existing .gitignore: preserve it and merge only the section beginning "# AI-DLC".
if [ ! -e your-project/.gitignore ]; then
  cp "$RUNTIME_ROOT/kirocrew/.gitignore" your-project/.gitignore
fi
```

The `aidlc/` directory is the workspace shell — it ships the pre-built
`aidlc/spaces/default/memory/` method tree the engine reads. It is a **sibling**
of `.kiro/`, so copy it separately (or copy the whole `$RUNTIME_ROOT/kirocrew/`
tree at once). `/aidlc --doctor` fails its "workspace shell ready" check if it is
missing.

The copy channel does not register the gateway hooks for you — after copying,
run `aidlc config --harness kirocrew` (or the native install path above) so Kiro
Crew wires the lifecycle hooks and gated-tool permissions. The shipped
`.gitignore` carries the workspace's commit/ignore split: per-user cursors and
machine-local runtime stay untracked, while the shared records — method memory,
state, audit shards, artifacts — travel with git. If a `.gitignore` already
exists, preserve every project-owned rule and merge only the section from
`# AI-DLC` through the end of the shipped file.

## Refresh and version skew

`aidlc update` updates the machine runtime but leaves project files unchanged.
`aidlc doctor` reports a project stamp that differs from the selected engine.
Between workflows, preview and apply the refresh with:

```bash
aidlc config --dry-run
aidlc config
```

Config preserves user-owned content and reports local framework edits as
conflicts. It refuses refresh while any workflow is active; complete the workflow
first. On Kiro Crew, `aidlc config` also re-registers the hooks in the
gateway-watched store, so a refresh keeps the gates wired.

## Usage

Start a Kiro Crew session in the project, then invoke the conductor with `/aidlc
<description>`. `/aidlc --status` reports position; `/aidlc --config [section]`
gathers project configuration changes in-session; `/aidlc --doctor`, `--stage`,
`--phase`, `--depth`, and `--test-strategy` all work. Workspace navigation uses
`/aidlc intent [name]`, `/aidlc space [name]`, and `/aidlc space-create <name>`.
The per-stage (`/aidlc-domain-design`) and per-scope (`/aidlc-feature`) runner
skills are installed too.

Status, doctor, help, version, and workspace-navigation commands are dispatched
by the Kiro hook before the model can turn them into workflow work — the same
`aidlc-kiro-adapter.ts` shim the Kiro CLI uses, reached through the recognized
`engine adapter kiro` route.

**Start the session from the project root.** Native installs pre-approve the
installed `aidlc` command. Source/development copies pre-approve only
project-relative `bun .kiro/tools/<tool>.ts` commands; absolute paths and command
chains remain gated. Anything outside the pre-approved set needs an approval; an
unattended Kiro Crew run with no approver present refuses such a command rather
than stalling.

## What's different on Kiro Crew

| Area | Kiro CLI | Kiro Crew |
|------|----------|-----------|
| Hook registration | `settings`/agent-config hooks read per session | Gateway-watched store `~/.kiro/crew/hooks.json`; `aidlc config` registers the lifecycle hooks through Kiro Crew's hook API / gateway reload, and the running gateway owns the store |
| Gate enforcement | kiro-cli lifecycle hooks (exit-2 deny) | Kiro Crew's own hook engine re-implements the same lifecycle events with the same exit-2 blocking contract; `aidlc config` routes the gated tools through permission requests so the guards can hard-block |
| Hook adapter | `aidlc-kiro-adapter.ts` via `engine adapter kiro` | The same file and route — Kiro Crew delivers Kiro CLI-shaped payloads, so the shim normalizes them unchanged |
| Session lifecycle | One `kiro-cli chat` | A gateway-managed session with persistent memory and background subagents, still running one `kiro-cli chat` underneath |
| Model access | Comes with Kiro | Comes with Kiro (no provider answer needed) |

Everything else — the state machine, audit trail, artifacts under the intent
record dirs (`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`), the learnings
ritual, sensors, scopes, depth/test-strategy — behaves identically to the Kiro
CLI, because the shell IS the Kiro CLI's. See
[Running AI-DLC on Kiro CLI](kiro-cli.md) for the full table of Kiro-vs-Claude
differences that apply here too (numbered-prose gates, no statusline, subagent
fan-out for the construction swarm, `SESSION_STARTED`-only audit events, the five
disabled-by-default MCP servers).

A project's `aidlc/` workspace is harness-neutral. Moving a project between the
Kiro CLI, Kiro IDE, and Kiro Crew distributions (or running them side by side) is
supported-but-untested; `/aidlc --doctor` warns if it detects a conflicting
harness setup with an active workflow.

## For framework developers

`dist/kirocrew` is **generated** from `core/` + `harness/kirocrew/` by
`bun scripts/package.ts kirocrew` (core copy with the `{{HARNESS_DIR}}` token
substituted to `.kiro` and the `rules/` → `steering/` rename). The output is
ignored and local. `bun scripts/package.ts --check` builds twice in independent
temporary roots and byte-compares the results as the CI determinism guard. The
authored Kiro Crew surfaces live in `harness/kirocrew/`: the orchestrator skill
(`skills/aidlc/`), the agent JSONs (`agents/`), the hook adapter
(`hooks/aidlc-kiro-adapter.ts`, shared with the Kiro CLI), `settings/cli.json`,
`settings/mcp.json`, and `onboarding.fills.ts` — edit those (or `core/`), never
hand-edit the generated `dist/kirocrew`. See
[Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md).

Because Kiro Crew runs the Kiro CLI, this harness reuses the Kiro CLI hook
adapter verbatim and dispatches it through the recognized `engine adapter kiro`
route (`core/tools/aidlc.ts` resolves that route to `aidlc-kiro-adapter.ts` for
every kiro-family harness). The Kiro CLI's live TUI journey test
(`tests/e2e/t-tui-kiro-intent-capture.serial.test.ts`) exercises the same shell.

## Next steps

Installed and activated? The methodology is the same on every harness — keep
going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [AI-DLC on Kiro CLI](kiro-cli.md) · [AI-DLC on Kiro IDE](kiro-ide.md) · [the harness family index](README.md).
