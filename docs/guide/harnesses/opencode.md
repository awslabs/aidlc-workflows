# AI-DLC on opencode

`dist/opencode/` is one of the framework's harness distributions, for the
open-source **opencode** harness (opencode.ai). One deterministic core, many
harnesses: the engine, state machine, audit log, graph, swarm referee, and
learnings gate are byte-identical across every distribution — only the shell
differs. The tree is **generated** from `core/` + `harness/opencode/` by
`bun scripts/package.ts opencode`; never hand-edit it (the drift guard fails CI).

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
- **bun** — same requirement as every harness; every tool and hook runs via
  bun. The adapter plugin resolves bun from `PATH`, then `~/.bun/bin/bun`.
- **A model provider** — the shipped project `opencode.json` pins no session
  model; your global opencode config supplies it. Tiered personas pin
  `amazon-bedrock/global.anthropic.claude-sonnet-4-6` — override per agent in
  the project `opencode.json` if your provider differs.

## Install

1. Copy the distribution into your project:

   ```bash
   cp -r dist/opencode/.aidlc/    your-project/.aidlc/
   cp -r dist/opencode/.opencode/ your-project/.opencode/
   cp -r dist/opencode/aidlc/     your-project/aidlc/      # the workspace shell — a sibling of .aidlc/, not inside it
   cp dist/opencode/opencode.json your-project/opencode.json  # or merge into yours
   cp dist/opencode/AGENTS.md     your-project/AGENTS.md      # or merge into yours
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

## What's different on this harness

- **Questions render as numbered prose options** (no structured-question
  widget); the questions FILE with `[Answer]:` tags remains the source of
  truth.
- **Hooks ride the adapter plugin.** opencode has no hooks.json/settings hook
  registry; `.opencode/plugin/aidlc-opencode-adapter.ts` maps opencode's
  plugin hook moments onto the core hook bodies in `.aidlc/hooks/` (run as bun
  subprocesses): reviewer read-scope and the AIDLC bash boundary before tool
  execution; audit + sensors on write/edit/apply_patch; runtime-compile on
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
bun .aidlc/tools/aidlc-utility.ts doctor    # all checks pass on a fresh copy
opencode run --command aidlc -- "--status"  # /aidlc --status through the harness
```

The doctor's opencode-specific checks: the adapter plugin present at
`.opencode/plugin/`, a project-root `opencode.json` or `opencode.jsonc`
present, and `.opencode/command/aidlc.md` present.
