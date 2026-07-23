# AI-DLC on GitHub Copilot

This project uses AI-DLC (AI-Driven Development Life Cycle) under the GitHub
Copilot harness (VS Code agent mode). Invoke the orchestrator skill with the
`/aidlc` slash command in Copilot chat, followed by a scope or project
description. The deterministic engine, state machine, audit log, and referee are
byte-identical to every other harness distribution; only the shell differs. Run
`/aidlc --status` for progress, `/aidlc --help` for usage, `/aidlc intent`
to list intents, `/aidlc --doctor` to validate setup, and
`/aidlc --stage <slug>` / `--phase <name>` / `--depth <level>` /
`--test-strategy <level>` for the usual overrides. Run `/aidlc compose
"<task>"` to have the adaptive composer propose a tailored EXECUTE/SKIP plan
(up front, from a scan report via `--report <path>`, or mid-workflow to
re-shape the pending stages - every proposal stops at an approve/edit/reject
gate).

## Prerequisites

- **VS Code ≥ 1.102 with GitHub Copilot agent mode**: the harness ships as `.github/agents/`, `.github/skills/`, and `.github/hooks/` — agent mode, custom skills, subagent delegation, and hooks all require VS Code 1.102 or newer. Enable Copilot agent mode in the Copilot chat view. `/aidlc --doctor` validates the install layout.
- **GitHub Copilot subscription**: an active Copilot subscription (or org seat) with agent mode entitlement. Model access follows your Copilot plan; the shipped agents omit a `model:` pin and inherit the session model.
- **bun**: Required for CLI tools and hook scripts (state management, audit logging, jump orchestration). Install via `curl -fsSL https://bun.sh/install | bash`. On Windows: `npm install -g bun` or `powershell -c "irm bun.sh/install.ps1 | iex"`. `bun` must be on your PATH for the non-interactive shells the harness spawns.
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Hook permissions**: All 13 hooks are TypeScript (`.ts`) and run via `bun`. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.
- **Install path**: copy the generated `dist/copilot/` tree into your project — it lays down `.github/agents/`, `.github/skills/aidlc/`, `.github/hooks/`, and a project-root `AGENTS.md`. Copilot auto-detects all four. After copying, run `/aidlc --doctor` to confirm the layout is correct.
- **Personal overrides**: user-level VS Code and Copilot settings merge over the project config; put machine-specific overrides in your VS Code user settings to avoid changing the shared `.github/` tree.

## AI-DLC Structure

- **Skill**: `.github/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phase directories
- **Session skills** (read-only, user-invocable): `.github/skills/aidlc-session-cost/`, `.github/skills/aidlc-replay/`, `.github/skills/aidlc-outcomes-pack/` — typed as `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Each pulls every count from `bun .github/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `.github/skills/aidlc-<stage>/` — one per runnable core stage, typed as `/aidlc-<stage>` (e.g. `/aidlc-application-design`, `/aidlc-code-generation`); plugin-owned stages use their bare plugin-prefixed command name. Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `/aidlc --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun .github/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `/aidlc-init`, which mints the first intent and builds its state in one step. (This is opt-in packaging: the engine normally auto-births the first intent the moment you describe what to build — no separate initialization command is needed.)
- **Agents**: `.github/agents/` — 14 agents: 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations), 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer. On Copilot all 14 agent personas are transposed into `.github/agents/aidlc-<role>-agent.agent.md` files; the orchestrator addresses them through Copilot's native subagent delegation (its `agents:` roster + the `agent` tool). Workers for the four dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests all run through that delegation.
- **Method/rules**: `aidlc/spaces/<active-space>/memory/` — Layered files authored once at the workspace root, read by each harness via its native include (no copy into `.github/`): `org.md` (framework defaults + organisation-wide guardrails), `team.md` (this team's affirmed practices), `project.md` (project-specific specialisation), plus `phases/<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `.github/sensors/` — Deterministic verification manifests (advisory). Ships with framework defaults (`aidlc-claim-sources.md`, `aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `.github/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc/spaces/<active-space>/knowledge/` — User-managed team and domain knowledge, a space-level sibling of `memory/`/`codekb/`/`intents/` that accumulates across every intent in the space. Free-form and empty at bootstrap (no fixed file set, no seeded READMEs); the engine ensure-exists the empty dir on your first `/aidlc`. Agents read `aidlc/spaces/<active-space>/knowledge/aidlc-shared/` (all agents) and `aidlc/spaces/<active-space>/knowledge/<agent>/` (that agent) if the team creates them.
- **Tools**: `.github/tools/` — Deterministic CLI tools (TypeScript, run via bun). All framework files prefixed `aidlc-*.ts`. They cover state management, audit emission, the orchestration engine (`aidlc-orchestrate.ts` with exactly three subcommands: `next`, `report`, and `park`), graph compile, runner generation, sensor firing, the §13 learnings gate (`aidlc-learnings.ts`), and the swarm convergence referee (`aidlc-swarm.ts`).
- **Hooks**: `.github/hooks/` — Framework hooks for audit emission, session lifecycle, state sync, state validation, subagent tracking, and statusline rendering. All framework files prefixed `aidlc-*.ts`.
## Conventions

- All artifacts go under the active intent's record dir — `aidlc/spaces/<active-space>/intents/<slug>-<id8>/` (shorthand `<record>/`) — beneath the neutral `aidlc/` workspace roof; application code goes to the workspace root (or a sibling repo). Single-team users only ever see `spaces/default/`.
- Each stage keeps an observation diary at `<record>/<phase>/<stage>/memory.md`, auto-created from a template at stage start and maintained by the orchestrator — never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`. The Copilot-specific guide (prerequisites, install steps, agent-mode setup) is `docs/guide/harnesses/copilot.md`.
## What's different on this harness

This is the same AI-DLC core that ships to every harness, rendered onto GitHub Copilot (VS Code agent mode). On Copilot:

- **Gates** render as numbered chat prompts (agent mode has no dedicated question widget); the markdown Q&A file is always the source of truth. Gate semantics live in the engine either way.
- **No custom statusline and no welcome message**: workflow position is available on demand via `/aidlc --status`.
- **Subagent delegation**: the 14 agent personas live in `.github/agents/` as `.agent.md` files and are reachable through Copilot's native subagent delegation.
- **Hooks** register in `.github/hooks/hooks.json` and fire on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `SubagentStop`, and `Stop`. The `aidlc-copilot-adapter.ts` shim normalizes Copilot's tool vocabulary (`runTerminalCommand` → `Bash`, `editFiles` → `Edit`, …) and camelCase `tool_input` keys before delegating to the byte-shared core hooks.
- **Session lifecycle**: an unclosed session is reconciled as an inferred `SESSION_ENDED` at the next start; the `PreCompact` event re-injects the workflow mission after compaction.
- **The AIDLC method** (the layered practice files `org.md`, `team.md`, `project.md`, and the per-phase `phases/<phase>.md`) lives once at the workspace root under `aidlc/spaces/<active-space>/memory/` — the single hand-editable source of truth, identical on every harness, NOT a per-harness copy. Copilot auto-reads the root `AGENTS.md` and the orchestrator injects the active-space memory paths into context on demand. Edit the method there, never under `.github/`.

## Session Resumption

On startup, resolve the active intent (the `aidlc/spaces/<active-space>/intents/active-intent` cursor) and check for its `<record>/aidlc-state.md`. If found, load prior context and offer to resume from last checkpoint. (A brand-new workspace has no intent yet — the engine auto-births the first one on your first `/aidlc`.)
## Git Integration

Commit the `aidlc/` workspace tree — the record (state, the per-clone audit shards under `<record>/audit/`, `intents.json`), memory, codekb, and knowledge are all version-controlled. The shipped `.gitignore` excludes the per-user cursors and machine-local runtime (these may be per-clone or contain sensitive data):
- `aidlc/active-space` and `aidlc/spaces/*/intents/active-intent` (per-user cursors)
- `aidlc/.aidlc-clone-id` (per-clone audit-shard token) and `aidlc/.aidlc-sessions/`
- `aidlc/spaces/*/intents/*/runtime-graph.json` (also covers per-Bolt worktree fragments by relative-path glob)
- `aidlc/spaces/*/intents/*/.aidlc-*` (recovery, hooks-health, sensors scratch)
