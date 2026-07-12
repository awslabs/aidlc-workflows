# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Cursor harness** (the Cursor editor and the `agent` CLI). The workspace shell ships in `.cursor/` (no setup command); the engine auto-births the first intent when you describe what to build. Run `/aidlc` followed by a scope or project description to begin. Run `/aidlc --doctor` to validate your setup, `/aidlc --version` to print the framework version, `/aidlc --stage <slug>` to jump to a specific stage, `/aidlc --phase <name>` to jump to a phase, `/aidlc --depth <level>` to override depth, `/aidlc --test-strategy <level>` to override test volume. Run `/aidlc compose "<task>"` to have the adaptive composer propose a tailored EXECUTE/SKIP plan (works up front, from a scan report via `--report <path>`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).

## Prerequisites

- **Cursor ≥ 2.4** (editor or the `agent` CLI): the surfaces this install relies on — Agent Skills (`.cursor/skills/`, invoked `/aidlc`), custom subagents (`.cursor/agents/*.md`), and the hooks system (`.cursor/hooks.json`, incl. the stop hook's followup channel) — shipped in the 2.4 line. Check with **Cursor → About** in the editor or `agent --version` on the CLI.
- **bun**: Required for the CLI tools and hook scripts (state management, audit logging, orchestration engine). Install via `curl -fsSL https://bun.sh/install | bash`. `bun` must be on your PATH for the non-interactive shells the harness spawns — these source `~/.zshenv` (zsh) or `~/.bashrc` (bash), NOT `~/.zshrc`.
- **Permissions**: this install ships `.cursor/cli.json` pre-approving ONLY the framework's own `bun .cursor/...` invocations for the `agent` CLI; everything else follows your Run Mode. In the editor, Auto-review governs — the framework's bun calls are read-mostly state bookkeeping and safe to allow. There is no blanket shell trust.
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Hook permissions**: All 12 hooks are TypeScript (`.ts`) and run via `bun`. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.

## AI-DLC Structure

- **Skill**: `.cursor/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phase directories
- **Session skills** (read-only, user-invocable): `.cursor/skills/aidlc-session-cost/`, `.cursor/skills/aidlc-replay/`, `.cursor/skills/aidlc-outcomes-pack/` — typed as `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Each pulls every count from `bun .cursor/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `.cursor/skills/aidlc-<stage>/` — one per runnable stage, typed as `/aidlc-<stage>` (e.g. `/aidlc-application-design`, `/aidlc-code-generation`). Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `/aidlc --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun .cursor/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `/aidlc-init`, which mints the first intent and builds its state in one step. (This is opt-in packaging: the engine normally auto-births the first intent the moment you describe what to build — no separate initialization command is needed.)
- **Agents**: `.cursor/agents/` — 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations). On Cursor the persona `.md` files under `.cursor/agents/` are read natively as subagents (frontmatter `name`/`description`; unknown keys are ignored). The conductor delegates the subagent stages (2.1, 3.5) and the §12a reviewer step to them by name; the other personas are adopted inline.
- **Method/rules**: `aidlc/spaces/<space>/memory/` — Layered files authored once at the workspace root, read by each harness via its native include (no copy into `.cursor/`): `org.md` (framework defaults + organisation-wide guardrails), `team.md` (this team's affirmed practices), `project.md` (project-specific specialisation), plus `phases/<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `.cursor/sensors/` — Deterministic verification manifests (advisory). Ships with framework defaults (`aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `.cursor/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc/knowledge/` (i.e. `aidlc/spaces/<space>/knowledge/`) — User-managed team and domain knowledge, a space-level sibling of `memory/`/`codekb/`/`intents/` that accumulates across every intent in the space. Free-form and empty at bootstrap (no fixed file set, no seeded READMEs); the engine ensure-exists the empty dir on your first `/aidlc`. Agents read `aidlc/knowledge/aidlc-shared/` (all agents) and `aidlc/knowledge/<agent>/` (that agent) if the team creates them.
- **Tools**: `.cursor/tools/` — Deterministic CLI tools (TypeScript, run via bun). All framework files prefixed `aidlc-*.ts`. They cover state management, audit emission, the orchestration engine (`aidlc-orchestrate.ts` with its `next`/`report` subcommands), graph compile, runner generation, sensor firing, the §13 learnings gate (`aidlc-learnings.ts`), and the swarm convergence referee (`aidlc-swarm.ts`).
- **Hooks**: `.cursor/hooks/` — Framework hooks for audit emission, session lifecycle, state sync, state validation, subagent tracking, and statusline rendering. All framework files prefixed `aidlc-*.ts`.
## Conventions

- All artifacts go under the active intent's record dir — `aidlc/spaces/<space>/intents/<slug>-<id8>/` (shorthand `<record>/`) — beneath the neutral `aidlc/` workspace roof; application code goes to the workspace root (or a sibling repo). Single-team users only ever see `spaces/default/`.
- Each stage keeps an observation diary at `<record>/<phase>/<stage>/memory.md`, auto-created from a template at stage start and maintained by the orchestrator — never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`. The Cursor-specific guide (install, what differs, the live journey test) is `docs/guide/harnesses/cursor.md`.
## What's different on this harness

This is the same AI-DLC core that ships to every harness — one deterministic engine, state machine, audit trail, and stage set, rendered onto Cursor. On Cursor:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with `[Answer]:` tags remains the source of truth.
- **No statusline is wired** (the Cursor CLI's statusLine contract is not consumed by this install); use `/aidlc --status` and the progress lines at gates.
- The **stop hook cannot hard-block** on Cursor: a mid-workflow early stop comes back as an auto-submitted follow-up message (Cursor's `followup_message` channel) instead of a blocked turn — same forwarding discipline, different mechanics. `.cursor/hooks.json` caps this at `loop_limit: 12`, above the framework's own interactive/autonomous ceilings (2/8), so the core hook's caps govern.
- The **reviewer read-scope bound (§12a) is prose-governed, not hook-enforced**: Cursor's `preToolUse` payloads carry no subagent identity and hooks cannot be registered per-subagent, so the deterministic reviewer-scope hook ships unwired here (the dispatch record is still written; the stage-protocol §12a bound governs, as on Kiro IDE).
- Construction swarm runs as **subagent fan-out only** (`AIDLC_USE_SWARM=1` is a loud no-op).
- Session resume is not discriminated by the hooks (`SESSION_RESUMED` / the resume-rebind offer never fire); every session records as a fresh start.
- **MCP servers**: none ship (the Claude distribution ships five; Cursor ships zero today — add your own via `.cursor/mcp.json` if needed).
- A workflow's `aidlc/` workspace tree is harness-neutral: a project can move between Claude Code and Cursor installs (supported but untested — keep both `.claude/` and `.cursor/` in sync via the framework's packaging if you do this).

## Session Resumption

On startup, resolve the active intent (the `aidlc/spaces/<space>/intents/active-intent` cursor) and check for its `<record>/aidlc-state.md`. If found, load prior context and offer to resume from last checkpoint. (A brand-new workspace has no intent yet — the engine auto-births the first one on your first `/aidlc`.)
## Git Integration

Commit the `aidlc/` workspace tree — the record (state, the per-clone audit shards under `<record>/audit/`, `intents.json`), memory, codekb, and knowledge are all version-controlled. The shipped `.gitignore` excludes the per-user cursors and machine-local runtime (these may be per-clone or contain sensitive data):
- `aidlc/active-space` and `aidlc/spaces/*/intents/active-intent` (per-user cursors)
- `aidlc/.aidlc-clone-id` (per-clone audit-shard token) and `aidlc/.aidlc-sessions/`
- `aidlc/spaces/*/intents/*/runtime-graph.json` (also covers per-Bolt worktree fragments by relative-path glob)
- `aidlc/spaces/*/intents/*/.aidlc-*` (recovery, hooks-health, sensors scratch)
