# AI-DLC on Cursor

This project uses AI-DLC (AI-Driven Development Life Cycle) under the **Cursor**
harness (Cursor IDE, cursor-agent CLI, and cloud agents all read the same
`.cursor/` surfaces). Invoke the orchestrator by typing `/aidlc` in
Cursor chat, followed by a scope or a plain-English description of what to build
(scope is auto-detected). The deterministic engine, state machine, audit log, and
referee are byte-identical to every other harness distribution; only the shell
differs. Run `/aidlc-status` for progress, `/aidlc --help` for usage,
`/aidlc --doctor` to validate setup, `/aidlc-jump` to move to a stage or
phase, and `/aidlc-scope` to set the scope. Run `/aidlc compose "<task>"` to
have the adaptive composer propose a tailored EXECUTE/SKIP plan (up front, from a
scan report via `--report <path>`, or mid-workflow to re-shape the pending
stages - every proposal stops at an approve/edit/reject gate).

## Prerequisites

- **Cursor ≥ 3.11**: the hook surface this install relies on (`beforeSubmitPrompt` for cloud-compatible session init, `beforeShellExecution`, `preToolUse`, `afterFileEdit`, `subagentStop`, `preCompact`, `stop`) and the folder-per-rule `.cursor/rules/<name>/<name>.mdc` format are current-line features. Check with `cursor --version`.
- **bun**: Required for the CLI tools and hook scripts (state management, audit logging, orchestration engine). Install via `curl -fsSL https://bun.sh/install | bash`. `bun` must be on your PATH for the non-interactive shells Cursor spawns.
- **Model provider**: Cursor selects the model via its own UI picker — pick an Anthropic Claude model. The harness pins no model; the tiered personas request the Claude tier projection and Cursor honors your picker selection.
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Hook permissions**: All 13 hooks are TypeScript (`.ts`) and run via `bun`. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.
- **Permissions**: `.cursor/cli.json` (read by cursor-agent) pre-allows the deterministic core's command prefixes — `bun *` and the safe `git add`/`commit`/`status`/`log`/`diff` verbs — and denies destructive, history-rewriting, network, and privilege-escalation commands (`rm -rf`, `git push`, `git reset --hard`, `curl`, `wget`, `sudo`). In the IDE the `beforeShellExecution` hook additionally gates shell commands against the workflow state (fail-closed).
- **Personal overrides**: keep machine-specific settings (model choice, provider credentials) in your Cursor user settings rather than the shared project surfaces.

## AI-DLC Structure

- **Skill**: `.cursor/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phase directories
- **Session skills** (read-only, user-invocable): `.cursor/skills/aidlc-session-cost/`, `.cursor/skills/aidlc-replay/`, `.cursor/skills/aidlc-outcomes-pack/` — typed as `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Each pulls every count from `bun .cursor/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `.cursor/skills/aidlc-<stage>/` — one per runnable core stage, typed as `/aidlc-<stage>` (e.g. `/aidlc-application-design`, `/aidlc-code-generation`); plugin-owned stages use their bare plugin-prefixed command name. Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `/aidlc --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun .cursor/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `/aidlc-init`, which mints the first intent and builds its state in one step. (This is opt-in packaging: the engine normally auto-births the first intent the moment you describe what to build — no separate initialization command is needed.)
- **Agents**: `.cursor/agents/` — 14 agents: 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations), 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer. On Cursor all 14 agent personas ship in `.cursor/agents/` (the conductor reads the persona `.md` bodies as prose); reviewer passes and dispatched-stage workers run through Cursor's subagent mechanism, tracked via the `subagentStop` hook.
- **Method/rules**: `aidlc/spaces/<active-space>/memory/` — Layered files authored once at the workspace root, read by each harness via its native include (no copy into `.cursor/`): `org.md` (framework defaults + organisation-wide guardrails), `team.md` (this team's affirmed practices), `project.md` (project-specific specialisation), plus `phases/<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `.cursor/sensors/` — Deterministic verification manifests (advisory). Ships with framework defaults (`aidlc-claim-sources.md`, `aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `.cursor/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc/spaces/<active-space>/knowledge/` — User-managed team and domain knowledge, a space-level sibling of `memory/`/`codekb/`/`intents/` that accumulates across every intent in the space. Free-form and empty at bootstrap (no fixed file set, no seeded READMEs); the engine ensure-exists the empty dir on your first `/aidlc`. Agents read `aidlc/spaces/<active-space>/knowledge/aidlc-shared/` (all agents) and `aidlc/spaces/<active-space>/knowledge/<agent>/` (that agent) if the team creates them.
- **Tools**: `.cursor/tools/` — Deterministic CLI tools (TypeScript, run via bun). All framework files prefixed `aidlc-*.ts`. They cover state management, audit emission, the orchestration engine (`aidlc-orchestrate.ts` with exactly three subcommands: `next`, `report`, and `park`), graph compile, runner generation, sensor firing, the §13 learnings gate (`aidlc-learnings.ts`), and the swarm convergence referee (`aidlc-swarm.ts`).
- **Hooks**: `.cursor/hooks/` — Framework hooks for audit emission, session lifecycle, state sync, state validation, subagent tracking, and statusline rendering. All framework files prefixed `aidlc-*.ts`.
## Conventions

- All artifacts go under the active intent's record dir — `aidlc/spaces/<active-space>/intents/<slug>-<id8>/` (shorthand `<record>/`) — beneath the neutral `aidlc/` workspace roof; application code goes to the workspace root (or a sibling repo). Single-team users only ever see `spaces/default/`.
- Each stage keeps an observation diary at `<record>/<phase>/<stage>/memory.md`, auto-created from a template at stage start and maintained by the orchestrator — never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`. The Cursor-specific guide (install, hooks, rules, what differs, verification) is `docs/guide/harnesses/cursor.md`.
## What's different on this harness

This is the same AI-DLC core that ships to every harness — one deterministic engine, state machine, audit trail, and stage set, rendered onto Cursor. On Cursor:

- **Rules** ship as folder-per-rule `.cursor/rules/<name>/<name>.mdc` files with YAML frontmatter (NOT the legacy single-file `.cursorrules`): `aidlc-method` is always applied (org + team + project), and the four `aidlc-phase-*` rules are agent-decided (loaded when the workflow enters that phase).
- **Session init** rides `beforeSubmitPrompt` (not `sessionStart`) so it works identically in Cursor IDE, cursor-agent CLI, and cloud agents; a first-prompt marker prevents duplicate session-start fires.
- **Hooks** ride the `.cursor/hooks/aidlc-cursor-adapter.ts` shim, which bridges Cursor's JSON permission-deny contract onto the core Claude-shaped exit-code-2 hook bodies: the state-transition guard and reviewer read-scope gate are fail-closed; audit, sensors, subagent tracking, and pre-compaction state validation are advisory (fail-open).
- **Self-correction** rides the `stop` hook, which maps a core `decision:block` to a Cursor `followup_message`, capped by `loop_limit` in `hooks.json`.
- **Gates and questions** render as numbered-prose options; the questions FILE with `[Answer]:` tags remains the source of truth.
- **The AIDLC method** (the layered practice files `org.md`, `team.md`, `project.md`, and the per-phase `phases/<phase>.md`) lives once at the workspace root under `aidlc/spaces/<active-space>/memory/` — the single hand-editable source of truth, identical on every harness. The `.cursor/rules/` `.mdc` layers are a GENERATED transposition of that method for Cursor's rule surface; edit the method under `aidlc/spaces/<space>/memory/`, never the generated `.mdc` files.

## Session Resumption

On startup, resolve the active intent (the `aidlc/spaces/<active-space>/intents/active-intent` cursor) and check for its `<record>/aidlc-state.md`. If found, load prior context and offer to resume from last checkpoint. (A brand-new workspace has no intent yet — the engine auto-births the first one on your first `/aidlc`.)
## Git Integration

Commit the `aidlc/` workspace tree — the record (state, the per-clone audit shards under `<record>/audit/`, `intents.json`), memory, codekb, and knowledge are all version-controlled. The shipped `.gitignore` excludes the per-user cursors and machine-local runtime (these may be per-clone or contain sensitive data):
- `aidlc/active-space` and `aidlc/spaces/*/intents/active-intent` (per-user cursors)
- `aidlc/.aidlc-clone-id` (per-clone audit-shard token) and `aidlc/.aidlc-sessions/`
- `aidlc/spaces/*/intents/*/runtime-graph.json` (also covers per-Bolt worktree fragments by relative-path glob)
- `aidlc/spaces/*/intents/*/.aidlc-*` (recovery, hooks-health, sensors scratch)
