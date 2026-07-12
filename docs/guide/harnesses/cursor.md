# AI-DLC on Cursor

`dist/cursor/` is one of the framework's harness distributions, for the
**Cursor** harness — the Cursor editor and its `agent` CLI. One deterministic
core, many harnesses: the engine, state machine, audit log, graph, swarm
referee, and learnings gate are byte-identical across every distribution —
only the shell differs. The tree is **generated** from `core/` +
`harness/cursor/` by `bun scripts/package.ts cursor`; never hand-edit it (the
drift guard fails CI).

Cursor implements the open Agent Skills standard, reads Claude-style subagent
`.md` files natively, and ships a hooks system whose wire protocol
deliberately mirrors Claude Code's — which makes this the most declarative
port after Claude itself: no rules rename, no `emit.ts`, no authored agent
configs.

## Prerequisites

- **Cursor ≥ 2.4** (editor or the `agent` CLI) — Agent Skills
  (`.cursor/skills/`), custom subagents (`.cursor/agents/*.md`), and the
  current hooks system (`.cursor/hooks.json`, including the stop hook's
  followup channel) shipped in the 2.4 line. Check with **Cursor → About** or
  `agent --version`.
- **bun** — same requirement as the Claude harness; every tool and hook runs
  via bun.

## Install

1. Copy the distribution into your project:

   ```bash
   cp -r dist/cursor/.cursor/  your-project/.cursor/
   cp -r dist/cursor/aidlc/    your-project/aidlc/     # the workspace shell (spaces/default/memory) — a sibling of .cursor/, not inside it
   cp dist/cursor/AGENTS.md    your-project/AGENTS.md  # or merge into yours
   cp dist/cursor/.gitignore   your-project/.gitignore # or merge into yours
   ```

   The `aidlc/` directory is the workspace shell — it ships the pre-built
   `aidlc/spaces/default/memory/` method tree the engine reads. It is a
   **sibling** of `.cursor/`, so copy it separately (or copy the whole
   `dist/cursor/` tree at once). `/aidlc --doctor` fails its "workspace shell
   ready" check if it is missing.

2. Keep the shipped `.gitignore` rules in place **before** starting a
   workflow (merge them if you already have a `.gitignore`) — the per-clone
   audit shards under each intent's `audit/` are committed deliberately,
   while per-user cursors and machine-local runtime state stay ignored. The
   shipped `AGENTS.md` § "Git Integration" explains the split.

3. Open the project in Cursor (or start `agent` in it). The hooks in
   `.cursor/hooks.json` and the always-apply method rule
   (`.cursor/rules/aidlc.mdc`) are picked up automatically. Verify with:

   ```bash
   bun .cursor/tools/aidlc-utility.ts doctor
   ```

## Use

Invoke the orchestrator with `/aidlc` followed by a scope or description —
same commands as the Claude harness (`/aidlc --status`, `/aidlc --help`, …).
Stage and scope runners are available the same way: `/aidlc-application-design`,
`/aidlc-bugfix`, etc. The 14 persona files under `.cursor/agents/` appear as
named Cursor subagents; the conductor delegates the subagent stages and the
reviewer step to them by name.

## Harness differences vs Claude Code

- **Gates and questions** render as **numbered prose options** (Cursor has no
  structured-question widget); the questions FILE with `[Answer]:` tags stays
  the source of truth. Gate semantics live in the engine either way.
- **The stop hook cannot hard-block.** On Claude the forwarding-loop backstop
  answers `{"decision":"block"}`; Cursor's stop hook instead returns a
  `followup_message` the harness auto-submits as the next user message — the
  same nudge, delivered as a continuation. `.cursor/hooks.json` caps this at
  `loop_limit: 12`, above the core hook's own interactive/autonomous ceilings
  (2/8), so the core's caps govern first.
- **Reviewer read-scope (§12a) is prose-governed.** Cursor's `preToolUse`
  payloads carry no subagent identity and hooks cannot be registered
  per-subagent, so the deterministic reviewer-scope hook ships **unwired**
  here (the Kiro IDE precedent); the stage-protocol §12a bound governs, and
  the dispatch record is still written as the audit surface.
- **No statusline is wired** — surface position with `/aidlc --status` and
  the progress lines at gates. (The Cursor CLI has a `statusLine` seam, but
  its stdin contract is undocumented; this install does not consume it.)
- **Session resume is not discriminated**: every session records as a fresh
  start (`SESSION_RESUMED` and the resume-rebind offer never fire — a
  documented harness limitation, as on Kiro).
- **Swarm floor = subagent fan-out** — one parallel subagent task per
  Construction unit in its Bolt worktree, with the same deterministic
  referee. `AIDLC_USE_SWARM=1` has no Workflow tool here and loud-degrades
  (`SWARM_DEGRADED` is audited).
- **AIDLC rule layers** live at the workspace root under
  `aidlc/spaces/<space>/memory/` (one hand-editable source, identical on
  every harness); Cursor pulls them into ambient context via the always-apply
  rule `.cursor/rules/aidlc.mdc` — note the `.mdc` extension is mandatory
  (Cursor ignores plain `.md` inside `.cursor/rules/`). `/aidlc space <name>`
  re-points the stub's `@`-references in place.
- **Permissions**: the shipped `.cursor/cli.json` pre-approves ONLY the
  framework's own `bun .cursor/...` invocations for the `agent` CLI;
  everything else follows your Run Mode. In the editor, Auto-review governs.
- **No welcome message**: the Claude harness renders the onboarding banner
  from `settings.json` `companyAnnouncements`; Cursor has no equivalent. The
  session-start hook injects resume context only.
- **MCP servers**: none ship (the Claude harness ships five via `.mcp.json`);
  add your own via `.cursor/mcp.json` if a stage needs one.

## Regenerating

```bash
bun scripts/package.ts cursor         # regenerate dist/cursor from core/ + harness/cursor/
bun scripts/package.ts --check        # CI drift guard (every harness)
```

Core `.ts` files are byte-identical to their `core/tools/` and `core/hooks/`
sources; prose carries the `{{HARNESS_DIR}}` token the packager substitutes to
`.cursor` (no rules rename — `.cursor/rules/` is Cursor's native always-on
layer and the shipped stub is a real Cursor rule). The hook-adapter contract
is pinned by `tests/unit/t222-cursor-hook-adapter.test.ts` over the
docs-derived payload corpus in `tests/fixtures/cursor-hook-payloads/` (to be
replaced with live captures when a Cursor validation spike runs).

## Next steps

Installed? The methodology is the same on every harness — keep going with the
neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 32 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other harnesses: [Running AI-DLC on Kiro IDE](kiro-ide.md) · [the harness family index](README.md).
