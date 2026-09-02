# AI-DLC on opencode

The opencode runtime is one of the framework's harness distributions, for the
open-source **opencode** harness (opencode.ai). One deterministic core, many
harnesses: the engine, state machine, audit log, graph, swarm referee, and
learnings gate are byte-identical across every distribution — only the shell
differs. The source/development tree is **generated** into ignored local
`dist/opencode/` from `core/` + `harness/opencode/` by
`bun scripts/package.ts opencode`; never hand-edit it.

## Layout: two dot-dirs, on purpose

opencode auto-imports every `*.ts` under `.opencode/tools/` and
`.opencode/tool/` as custom tool definitions, and importing a CLI-style engine
script (top-level dispatch, `process.exit`) crashes the session
(live-reproduced on opencode 1.17.18). So this distribution splits:

- **`.aidlc/`** — the AIDLC engine tree (tools, hooks, skills, agents,
  knowledge, scopes, sensors, aidlc-common). opencode never scans it; the
  shipped `opencode.json` registers `skills.paths: [".aidlc/skills"]` so the
  orchestrator skill and every generated runner are discovered there.
- **`.opencode/`** — only natively-consumed surfaces: the 14 persona
  subagents (`agents/*.md`, `mode: subagent`), the `/aidlc` command
  (`command/aidlc.md`), and the hook-adapter plugin
  (`plugin/aidlc-opencode-adapter.ts`, auto-discovered by opencode).

## Prerequisites

- **opencode ≥ 1.17** — the plugin hook surface this install relies on
  (`tool.execute.before`, `tool.execute.after`, `chat.message`, `session.idle`,
  `experimental.session.compacting`) and project-local skill/agent discovery.
  Check with `opencode --version`.
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes dispatch through
  the installed `aidlc` executable.
- **A model provider** — the shipped project `opencode.json` pins no session
  model; your global opencode config supplies it. Tiered personas pin
  `amazon-bedrock/global.anthropic.claude-sonnet-4-6` — override per agent in
  the project `opencode.json` if your provider differs.

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
opencode
```

The installer verifies the release metadata, executable, and all-harness runtime archive against the published SHA-256 checksums. The installed runtime does not require Bun, Node.js, or Git. Harness selection happens in `aidlc config`.

On Windows, download `install.ps1` and run
`& $installer`. An interactive run may omit the flag;
redirected input, `pwsh -NonInteractive`, `--yes`, `--json`, and `--quiet`
require it. For an air-gapped package, use
`install.sh --from <release-directory> --offline` on Unix or
`& $installer -From <release-directory> -Offline` on Windows.

`aidlc config` projects `.aidlc/`, `.opencode/`, the workspace shell,
`AGENTS.md`, the managed `.gitignore` block, and `opencode.json`. The generated
config discovers the skill and method files and allows direct `aidlc engine *`
commands; other shell commands still prompt. Start opencode in the project and
run `/aidlc --doctor`, then `/aidlc` followed by what you want to build.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-runtime.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

1. Copy the distribution into your project:

   ```bash
   cp -r "$RUNTIME_ROOT/opencode/.aidlc/"    your-project/.aidlc/
   cp -r "$RUNTIME_ROOT/opencode/.opencode/" your-project/.opencode/
   cp -r "$RUNTIME_ROOT/opencode/aidlc/"     your-project/aidlc/      # the workspace shell — a sibling of .aidlc/, not inside it
   cp "$RUNTIME_ROOT/opencode/opencode.json" your-project/opencode.json  # or merge into yours
   cp "$RUNTIME_ROOT/opencode/AGENTS.md"     your-project/AGENTS.md      # or merge into yours
   ```

   `opencode.json` carries three load-bearing blocks: `skills.paths` (skill
   discovery from `.aidlc/skills`), `instructions` (the method-tree include —
   `/aidlc space <name>` re-points it), and permission rules for AIDLC bash
   entrypoints plus edits under `.aidlc/tools/` and `.aidlc/hooks/`. If you
   merge into an existing `opencode.json` or `opencode.jsonc`, keep all three.
   The adapter enforces the permission boundary: the target must be an entrypoint
   embedded from the packaged tree, invoked as one direct command with no
   chaining, redirection, expansion, or command substitution. Engine-code edits
   prompt for approval.

2. Apply the `.gitignore` entries from the shipped `AGENTS.md` § "Git
   Integration" before starting a workflow (per-clone audit shards are
   committed deliberately; cursors and machine-local runtime stay ignored).

3. Start opencode in the project and run `/aidlc --doctor`, then `/aidlc`
   followed by what you want to build.

Because opencode has no channel for the session-start hook's injected context,
the `/aidlc` skill performs one read-only status probe on a bare invocation. An
existing workflow gets the standard Resume / Redo / Jump / Start Fresh menu;
`/aidlc --resume` skips both the probe and menu and continues directly.

The versioned runtime uses the native `aidlc` command. Framework developers who
need the Bun-shaped projection can clone the repository, run
`bun install --frozen-lockfile` and `bun scripts/package.ts`, then use the
ignored local `dist/opencode/` output.

## Refresh and version skew

`aidlc update` updates the machine runtime without rewriting projects.
`aidlc doctor` reports a project stamp that differs from the selected engine.
Between workflows, preview and apply a refresh:

```bash
aidlc config --dry-run
aidlc config
```

Config preserves managed root blocks and user-owned files, and reports local
framework edits as conflicts. Because `opencode.json` is a whole-file
integration, a local edit is preserved as a conflict rather than overwritten.
Config refuses refresh while any workflow is active; complete the workflow first.
Upgrade and rollback remain safe during a workflow because they do not touch
the project.

## What's different on this harness

- **Questions render as numbered prose options** (no structured-question
  widget); the questions FILE with `[Answer]:` tags remains the source of
  truth.
- **Hooks ride the adapter plugin.** opencode has no hooks.json/settings hook
  registry; `.opencode/plugin/aidlc-opencode-adapter.ts` maps opencode's
  plugin hook moments onto the core hook bodies in `.aidlc/hooks/` (run as bun
  subprocesses): reviewer read-scope and the AIDLC bash boundary before tool
  execution; audit + sensors on write/edit/apply_patch; rebuild-stage-graph on
  bash; statusline sync on todowrite; subagent logging on task; presence
  minting on each human turn; state validation before compaction.
- **Forwarding-loop enforcement is advisory.** The Stop seam is the
  `session.idle` event — reactive, not blocking. When the core stop hook
  answers `block`, the plugin re-engages the loop by injecting a nudge prompt
  (marked with a sentinel so it never mints human presence). A chatting or
  pausing human is released by the hook's interactive cap.
- **Personas are native subagents** (`mode: subagent`); the conductor adopts
  them inline for most stages and delegates via the `task` tool for the two
  subagent stages (2.1 reverse-engineering, 3.5 code-generation). Their native
  permission map denies `task`, so delegated agents cannot delegate again.
  Plugin composition emits the same `.opencode/agents/` twin for plugin personas.
- **Space switches preserve JSONC.** `/aidlc space <name>` updates the method
  glob in either `opencode.json` or `opencode.jsonc` without stripping comments
  or trailing commas, and keeps explicit persona memory paths aligned.
- **Construction swarm runs as task-tool fan-out only** (`AIDLC_USE_SWARM=1`
  is a loud no-op — no Workflow tool exists).
- **No session-end moment** — `SESSION_ENDED` audit events are not emitted.
  Pre-compaction validation DOES fire (`experimental.session.compacting`).
- **No statusline / welcome message** — use `/aidlc --status` and the progress
  lines at gates.
- **MCP servers**: none ship; configure your own under `mcp:` in
  `opencode.json` if needed.

## Verifying an install

```bash
aidlc doctor                               # native install
bun .aidlc/tools/aidlc-utility.ts doctor   # source/development copy
opencode run --command aidlc -- "--status"  # /aidlc --status through the harness
```

The doctor's opencode-specific checks: the adapter plugin present at
`.opencode/plugin/`, a project-root `opencode.json` or `opencode.jsonc`
present, and `.opencode/command/aidlc.md` present.
