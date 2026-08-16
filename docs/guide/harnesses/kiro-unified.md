# AI-DLC on the Kiro unified agent harness

> [!NOTE]
> AI-DLC on Kiro works best with **Claude Opus 4.8**, which requires a **paid
> Kiro plan**. On weaker models the conductor may skip optional stage steps
> (reviewer pass, learnings ritual) or rush approval gates.

One of the framework's harnesses: `dist/kiro-unified/` runs the same AI-DLC
methodology on the agent runtime that **Kiro IDE 1.x** and **Kiro CLI v3**
(`kiro-cli --v3`) share. Both surfaces resolve an agent from its Markdown
definition — persona body, `tools:` grant, `resources:` list and `permissions:`
rules all in one file — and both execute the standalone `.kiro/hooks/aidlc-*.json`
manifests. One deterministic core — the tools, 33 stage files, protocols,
knowledge, sensors, scopes, and rules — is byte-shared across every harness;
only the shell differs.

**Which Kiro tree do I install?** Pick by the runtime you launch:

| Tree | Serves | Carries |
| --- | --- | --- |
| `dist/kiro-unified/` | Kiro IDE 1.x · Kiro CLI `--v3` | Markdown agents only, `permissions:` in the agent file, 12 hook manifests |
| `dist/kiro-ide/` | Kiro IDE, any generation | The same plus the pre-1.0 compatibility surfaces: legacy `.kiro.hook` files and agent-v1 JSON |
| `dist/kiro/` | Kiro CLI 2.x | Agent-v1 JSON configs, whose `toolsSettings` sandbox is what that engine reads |

Installing more than one into the same project is not supported: they occupy the
same `.kiro/` paths.

## Prerequisites

- **Kiro IDE ≥ 1.0**, or **Kiro CLI ≥ 2.6 started with `--v3`** (`kiro-cli --v3`),
  logged in. Verified against IDE 1.0.309 and CLI 2.18.1 `--v3`.
- **bun** on your PATH (`curl -fsSL https://bun.sh/install | bash`). It must be
  on the PATH of the non-interactive shells the harness spawns for hooks — those
  source `~/.zshenv` (zsh) or `~/.bashrc` (bash), not `~/.zshrc`.
- **Claude Opus 4.8** selected as the model: in the IDE from the model picker,
  in the CLI with `/model`.

> [!IMPORTANT]
> `--v3` is an explicit opt-in. Without it the CLI runs its 2.x engine, which
> reads neither this tree's `permissions:` blocks nor its standalone hook
> manifests — install `dist/kiro/` for that engine instead.

## Install

```bash
mkdir -p your-project/.kiro your-project/aidlc
cp -R dist/kiro-unified/.kiro/. your-project/.kiro/
cp -R dist/kiro-unified/aidlc/. your-project/aidlc/     # the workspace shell — a sibling of .kiro/, not inside it
cp dist/kiro-unified/AGENTS.md your-project/AGENTS.md   # merge if you already have one
```

The `aidlc/` shell ships the pre-built `aidlc/spaces/default/memory/` method
tree the engine reads; `/aidlc --doctor` fails its "workspace shell ready" check
without it.

## Usage

Open the project on either surface and run `/aidlc --doctor` first: it should
report 39 checks passed. Then `/aidlc <description>` to start.

On the **CLI**, select the conductor explicitly:

```bash
kiro-cli --v3 --agent aidlc
```

The shipped `.kiro/settings/cli.json` names `aidlc` as the default agent, but
Kiro reads CLI settings from the global scope only, so a copy inside the project
does not take effect — hence the explicit `--agent`.

On the **IDE**, the conductor appears in the agent selector as the entry loaded
from `.kiro/agents/aidlc.md`, and the hook manifests appear in the Agent Hooks
panel.

## What's different here

- Approval gates and questions render as **numbered prose options** (no
  structured-question widget); the questions file with `[Answer]:` tags remains
  the source of truth.
- There is **no statusline** and **no welcome message**; use `/aidlc --status`
  and the progress lines at gates. `.kiro/hooks/aidlc-statusline.ts` ships with
  the framework but is inert here — it renders into Claude Code's `statusLine`
  setting, and neither surface registers it.
- Construction swarm runs as **subagent fan-out only**. `AIDLC_USE_SWARM=1` does
  not switch drivers: the conductor runs the subagent floor and records the
  downgrade as a `SWARM_DEGRADED` audit event.
- **Twelve hooks are registered**, one `.json` manifest each:
  `write-audit-log`, `record-human-turn`, `session-start`, `sync-workflow-state`,
  `rebuild-stage-graph`, `log-subagent`, `continue-workflow`,
  `enforce-approval-gate`, `review-freeze`, `plan-approval-guard`,
  `state-transition-guard`, `verb-intercept`. The last four are PreToolUse
  guards: a non-zero exit blocks the tool call on both surfaces.
- **`aidlc-reviewer-scope.ts` ships unregistered.** It is a per-persona read
  and write bound, so it would have to fire for a **delegated** agent — and an
  agent-scope hook fires for the active agent only. A reviewer's scope is
  therefore prose-enforced by the stage protocol here, not machine-enforced.
  `aidlc-fold-usage.ts` and `aidlc-session-end.ts` are likewise unregistered:
  both are Claude-Code-only producers that read that harness's transcript and
  session-lifecycle events. `ls .kiro/hooks/*.json` is the live view of what is
  registered.
- **No session-end registration.** The Stop trigger fires at the end of every
  assistant turn rather than at conversation close, so registering it would
  append a spurious `SESSION_ENDED` between prompts. Which `SESSION_*` events do
  fire is surface- and version-specific: read the audit trail of a real run
  (`aidlc/spaces/<space>/intents/<record>/audit/*.md`) for the live answer, and
  `.aidlc-hooks-health/*.last` for which hooks fired at all.
- **MCP servers**: `.kiro/settings/mcp.json` ships a registry with every server
  **disabled**. Enable what you need there, or scope a server to one agent with
  the `includeMcpJson` / `mcpServers` fields in that agent's `.md`.
- **Delegate permissions live in the agent file.** Each of the 14 delegation
  targets carries its own `permissions:` rules: the engine forwarding loop plus
  a UTC clock allowed, the destructive shell verbs denied, and a filesystem
  allow-match scoped to the workspace tree (the composer's is scoped to the
  scope assets it composes instead). The grant is coarser than a per-stage path
  bound — the persona's Boundaries prose and the conductor's gates remain the
  behavioural constraint.

## For framework developers

`dist/kiro-unified` is **generated** from `core/` + `harness/kiro-unified/` by
`bun scripts/package.ts` (core copy with the `{{HARNESS_DIR}}` token substituted
to `.kiro` and the `rules/` → `steering/` rename). `bun scripts/package.ts --check`
is the drift guard and runs in CI. The authored surfaces live in
`harness/kiro-unified/`: the orchestrator skill (`skills/aidlc/`), the conductor
(`agents/aidlc.md`), the hook adapter (`hooks/aidlc-kiro-adapter.ts`), the twelve
hook manifests, `settings/cli.json`, `settings/mcp.json`, the steering file, and
the onboarding fills — edit those (or `core/`), never the generated
`dist/kiro-unified`.

The per-agent `tools:`, `resources:` and `permissions:` frontmatter is manifest
data (`frontmatterAdditions` in `harness/kiro-unified/manifest.ts`), not a fork
of the core persona files. See
[Porting to a New Harness](../../harness-engineering/09-porting-to-a-new-harness.md).

## Next steps

Installed and activated? The methodology is the same on every harness — keep
going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) — an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) — the 5 phases and 33 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) — right-sizing a run.
- [Glossary](../glossary.md) — every term defined.

Other Kiro trees: [Running AI-DLC on Kiro IDE](kiro-ide.md) · [Running AI-DLC on Kiro CLI](kiro-cli.md) · [the harness family index](README.md).
