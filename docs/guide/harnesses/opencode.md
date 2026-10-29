# AI-DLC on opencode

The opencode runtime is one of the framework's harness distributions, for the
open-source **opencode** harness (opencode.ai). One deterministic core, many
harnesses: the engine, state machine, audit log, graph, swarm referee, and
learnings gate are byte-identical across every distribution — only the shell
differs. The source/development tree is **generated** into ignored local
`dist/opencode/` from `core/` + `harness/opencode/` by
`bun scripts/package.ts opencode`; never hand-edit it.

Harness-specific onboarding lives in `.aidlc/onboarding.md`, loaded by the
`instructions` list in `opencode.json`. The root `AGENTS.md` block is
harness-neutral and shared with other installed harnesses whose engine
directories differ; opencode and Copilot cannot share one `.aidlc/` install.

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
  The command prints the installed skill into itself each time it is typed
  (`aidlc engine skill-text --harness-dir .aidlc`), so the agent gets the skill whole: opencode
  cuts a skill loaded through its own skill tool at 50 KiB and saves the rest
  under its data folder, outside the project.

## Prerequisites

- **opencode 1.18.29 or newer, or OpenCode 2** — the adapter plugin
  default-exports one object that both lines load: opencode 1 calls its
  `server()` (the `tool.execute.before`, `tool.execute.after`, `chat.message`,
  `session.idle`, `experimental.session.compacting` and `shell.env` hooks;
  object entry points need 1.18.29), and OpenCode 2 calls its `setup()` (see
  [On OpenCode 2](#on-opencode-2)). Project-local skill and agent discovery
  works on both. Check with `opencode --version`.
- **bun** only when generating or running the source/development `dist/`
  projection. Native installs and versioned release runtimes dispatch through
  the installed `aidlc` executable.
- **A model provider** — the shipped project `opencode.json` and agent
  definitions pin no model. Your global opencode config supplies the provider
  and session model; balanced reviewers retain only their medium reasoning
  variant.

## Install

### Native channel (recommended)

```bash
tmp="$(mktemp -d)"
curl -fsSL \
  https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh \
  -o "$tmp/install.sh"
sh "$tmp/install.sh"
rm -rf "$tmp"
cd your-project
aidlc config
aidlc doctor
opencode
```

The installer verifies the release metadata, executable, and all-harness runtime archive against the published SHA-256 checksums. The installed runtime does not require Bun, Node.js, or Git. Harness selection happens in `aidlc config`.

On Windows, download `install.ps1` and run
`& $installer`. See [Windows installation](../18-install-and-lifecycle.md#windows-powershell)
for account scope, automatic User PATH registration, and `-NoModifyPath`.
For an air-gapped package, use
`install.sh --from <release-directory> --offline` on Unix or
`& $installer -From <release-directory> -Offline` on Windows.

`aidlc config` projects `.aidlc/`, `.opencode/`, the workspace shell,
`AGENTS.md`, the managed `.gitignore` block, and AI-DLC's entries in
`opencode.json`. Those entries discover the skill and method files, let
AI-DLC's own direct `aidlc engine *` commands run without a prompt, and ask
once before `rm -r...` and `git push`; every other shell command follows your
own opencode settings. A project that already has an `opencode.json` keeps
its model, provider, instructions, permission rules, and comments: AI-DLC
adds only its own entries, and its two asks go first in your `bash` map so
your own rules after them decide. In your global opencode config, write a
shell rule as a map (`"bash": {"*": "ask"}`): opencode replaces a global
short form `"bash": "ask"` with any project map, this file included. A
global `"git *": "allow"` still meets AI-DLC's `git push` ask once; "Allow
always" ends it. `aidlc config` and `aidlc doctor` say so in one line when
they find the short form in your global config. Start opencode in the project and
run `/aidlc --doctor`, then `/aidlc` followed by what you want to build.

### Versioned manual-copy alternative

Download and extract a specific release's `aidlc-copy-runtime-X.Y.Z.tar.gz` as described in
[Install and Lifecycle: Copy Channel](../18-install-and-lifecycle.md#copy-channel),
then set `RUNTIME_ROOT` to the extracted `runtime/` directory.

1. Copy the distribution into your project:

   ```bash
   cp -r "$RUNTIME_ROOT/opencode/.aidlc/"    your-project/.aidlc/
   cp -r "$RUNTIME_ROOT/opencode/.opencode/" your-project/.opencode/
   cp -r "$RUNTIME_ROOT/opencode/aidlc/"     your-project/aidlc/      # the workspace shell — a sibling of .aidlc/, not inside it
   ```

   The copy runtime has no `opencode.json`, so copying never replaces yours.
   Step 2 adds AI-DLC's three load-bearing parts to it, or writes the file
   when there is none: `skills.paths` (skill discovery from `.aidlc/skills`),
   `instructions` (both native onboarding at `.aidlc/onboarding.md` and the
   method glob `aidlc/active-memory/**/*.md`, the engine's git-ignored
   copy of the active space's method that `/aidlc space <name>` rewrites), and
   permission rules for AIDLC bash entrypoints plus edits under
   `.aidlc/tools/` and `.aidlc/hooks/`. If you keep an `opencode.jsonc`
   instead, step 2 adds those parts to it, comments kept, and creates no
   `opencode.json` beside it.
   The adapter enforces the permission boundary: the target must be an entrypoint
   embedded from the packaged tree, invoked as one direct command with no
   chaining, redirection, expansion, or command substitution. Engine-code edits
   prompt for approval.

2. Run the copy's own setup once, from the project:

   ```bash
   bun .aidlc/tools/aidlc.ts config --from "$RUNTIME_ROOT" --harness opencode
   ```

   It adds AI-DLC's lines to your `AGENTS.md` and `.gitignore`, after
   everything already there, and AI-DLC's entries to your `opencode.json`
   (or creates them), before your first workflow
   (per-clone audit shards are committed deliberately; cursors and
   machine-local runtime stay ignored).

3. Start opencode in the project and run `/aidlc --doctor`, then `/aidlc`
   followed by what you want to build.

Because opencode has no channel for the session-start hook's injected context,
the `/aidlc` skill performs one read-only status probe on a bare invocation. An
existing workflow carries on where it stopped, as with `/aidlc --resume` (ask
to redo, jump to a stage, or start fresh to do something else);
`/aidlc --resume` skips the probe and continues directly.

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
framework edits as conflicts. In `opencode.json`, a refresh updates only the
entries AI-DLC wrote that nobody changed; your own entries, and any AI-DLC
entry you edited, stay as they are.
A refresh while a workflow is open is done, like a settings change (`config
models`, `flags`, `providers`), and says your open work carries on.
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
  bash, which also shows an engine error's exact message as a TUI toast;
  statusline sync on todowrite; subagent logging on task; presence
  minting on each human turn; state validation before compaction.
- **Forwarding-loop enforcement is advisory.** The Stop seam is the
  `session.idle` event — reactive, not blocking. When the core stop hook
  answers `block`, the plugin re-engages the loop by injecting a nudge prompt
  (it knows the nudge by the id of the part it sent, so the nudge never counts
  as your turn). The nudge is a
  synthetic part: the agent reads it, and your chat does not show it. When you
  stop a turn with Esc, or reject a command the agent asked to run, no nudge
  follows until you write again. A chatting or
  pausing human is released by the hook's interactive cap.
- **`/aidlc` shows what you typed.** opencode would show the command's whole
  template as your message; the plugin keeps the template for the agent and
  shows your `/aidlc ...` line instead.
- **Only what you type is your reply.** When opencode adds your editor's open
  file or selection to a message (in Zed's terminal, or in VS Code's with the
  editor extension), the agent still sees it, and AI-DLC keeps only what you
  typed as your words.
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

## On OpenCode 2

OpenCode 2 does not run opencode 1 plugin functions, so the adapter also
carries a V2 entry point, `setup(ctx)`. It drives the same hook logic from
V2's plugin API (live-verified on 2.0.24):

| OpenCode 2 moment | Drives |
| --- | --- |
| `session.hook("prompt")` | presence minting and session-start (`chat.message`) |
| `tool.hook("execute.before")` / `("execute.after")` | the bash boundary, guards, reviewer scope, audit, sensors, stage graph, subagent log |
| `session.hook("compaction")` | state validation before compaction |
| `session.execution.succeeded` event | the Stop hook and its nudge (`session.idle`) |
| `session.execution.interrupted`, `permission.replied` events | no nudge after Esc or a rejected command |
| `shell.hook("create.before")` | each shell command acts on its own chat's work (`shell.env`) |

V2 renames the built-in tools (`bash` → `shell`, `task` → `subagent`,
`apply_patch` → `patch`); the adapter maps them back. Its tool events name the
calling agent, so reviewer identity comes from the event itself. The nudge is
sent as a synthetic message, which V2 never passes to the prompt hook, so it
can never count as a human turn. Subagent prompts do reach the prompt hook;
the adapter recognises child sessions by their parent and skips them.

OpenCode 2's shell event carries the command's environment but no session, so
the adapter takes the session from the shell tool call that precedes it. A
command typed in opencode's own terminal has no such call and names no chat,
as on opencode 1.

The shipped `opencode.json`, agent files and `/aidlc` command keep the
opencode 1 shapes, which OpenCode 2 reads unchanged. Leave them in that form:
`aidlc doctor` and `aidlc config` check those shapes.

Degradations compared with opencode 1:

- **No statusline sync.** OpenCode 2 has no todo tool, so the `todowrite`
  moment that runs `aidlc-sync-workflow-state.ts` never happens. Workflow
  state still advances through the engine's own commands; only the
  todo-driven statusline mirror is missing. Use `/aidlc --status`.
- **`/aidlc` shows its template.** OpenCode 2 has no `command.execute.before`
  hook, so your chat shows the command's template rather than the line you
  typed. The adapter reads the line you typed back out of the template, so a
  switch such as `/aidlc --review none` is kept and a bare `/aidlc` counts as a
  command, as on opencode 1.
- **No engine-error toast.** OpenCode 2 gives plugins no TUI toast channel; the
  conductor skill still prints the engine's error message verbatim.
- **Default shell dialect.** OpenCode 2 does not expose the `shell` setting to
  plugins, so the bash boundary reads commands the way the platform's default
  shell does (POSIX `sh` on Linux and macOS).

## Verifying an install

```bash
aidlc doctor                               # native install
bun .aidlc/tools/aidlc-utility.ts doctor   # source/development copy
opencode run --command aidlc -- "--status"  # /aidlc --status through the harness
```

The doctor's opencode-specific checks: the adapter plugin present at
`.opencode/plugin/`, a project-root `opencode.json` or `opencode.jsonc`
present, and `.opencode/command/aidlc.md` present.
