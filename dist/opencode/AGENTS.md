# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **opencode harness**. The workspace shell ships in `.aidlc/` (no setup command); the engine auto-births the first intent when you describe what to build. Run `/aidlc` followed by a scope or project description to begin. Run `/aidlc --doctor` to validate your setup, `/aidlc --version` to print the framework version, `/aidlc --stage <slug>` to jump to a specific stage, `/aidlc --phase <name>` to jump to a phase, `/aidlc --depth <level>` to override depth, `/aidlc --test-strategy <level>` to override test volume. Run `/aidlc compose "<task>"` to have the adaptive composer propose a tailored EXECUTE/SKIP plan (works up front, from a scan report via `--report <path>`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).

## Prerequisites

- **opencode ≥ 1.17**: the plugin hook surface this install relies on (`tool.execute.before`, `tool.execute.after`, `chat.message`, `session.idle` on the event bus, `experimental.session.compacting`) and project-local `.aidlc/skills/` + `.opencode/agents/` discovery are current-line features. Check with `opencode --version`.
- **bun**: Required for the CLI tools and hook scripts (state management, audit logging, orchestration engine). Install via `curl -fsSL https://bun.sh/install | bash`. `bun` must be on your PATH for the shells opencode spawns; the AIDLC adapter plugin also probes `~/.bun/bin/bun` directly.
- **Model/provider**: the shipped `opencode.json` pins no model — your global opencode configuration (`~/.config/opencode/opencode.json`) supplies the default. Tiered personas pin `amazon-bedrock/global.anthropic.claude-sonnet-4-6`; override per agent under `agent:` in the project `opencode.json` if your provider differs.
- **Permissions**: the shipped project `opencode.json` pre-approves ONLY single invocations of the tool and hook entrypoints embedded at package time; the adapter rejects unshipped filenames, chaining, redirection, expansion, and command substitution. Edits under `.aidlc/tools/` and `.aidlc/hooks/` prompt. Every other bash command prompts. There is no blanket shell trust. In `opencode run` non-interactive sessions, pass `--auto` only if you accept auto-approval of the remaining prompts; prefer interactive sessions for gated workflows.
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Hook permissions**: All 13 hooks are TypeScript (`.ts`) and run via `bun`. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.

## AI-DLC Structure

- **Skill**: `.aidlc/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phase directories
- **Session skills** (read-only, user-invocable): `.aidlc/skills/aidlc-session-cost/`, `.aidlc/skills/aidlc-replay/`, `.aidlc/skills/aidlc-outcomes-pack/` — typed as `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Each pulls every count from `bun .aidlc/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `.aidlc/skills/aidlc-<stage>/` — one per runnable core stage, typed as `/aidlc-<stage>` (e.g. `/aidlc-application-design`, `/aidlc-code-generation`); plugin-owned stages use their bare plugin-prefixed command name. Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `/aidlc --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun .aidlc/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `/aidlc-init`, which mints the first intent and builds its state in one step. (This is opt-in packaging: the engine normally auto-births the first intent the moment you describe what to build — no separate initialization command is needed.)
- **Agents**: `.aidlc/agents/` — 14 agents: 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations), 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer. On opencode the personas are native subagents (`mode: subagent` in each `.opencode/agents/aidlc-<role>-agent.md`); the conductor adopts them inline for most stages and delegates via the `task` tool for the two subagent stages (2.1, 3.5).
- **Method/rules**: `aidlc/spaces/<active-space>/memory/` — Layered files authored once at the workspace root, read by each harness via its native include (no copy into `.aidlc/`): `org.md` (framework defaults + organisation-wide guardrails), `team.md` (this team's affirmed practices), `project.md` (project-specific specialisation), plus `phases/<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `.aidlc/sensors/` — Deterministic verification manifests (advisory). Ships with framework defaults (`aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `.aidlc/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc/spaces/<active-space>/knowledge/` — User-managed team and domain knowledge, a space-level sibling of `memory/`/`codekb/`/`intents/` that accumulates across every intent in the space. Free-form and empty at bootstrap (no fixed file set, no seeded READMEs); the engine ensure-exists the empty dir on your first `/aidlc`. Agents read `aidlc/spaces/<active-space>/knowledge/aidlc-shared/` (all agents) and `aidlc/spaces/<active-space>/knowledge/<agent>/` (that agent) if the team creates them.
- **Tools**: `.aidlc/tools/` — Deterministic CLI tools (TypeScript, run via bun). All framework files prefixed `aidlc-*.ts`. They cover state management, audit emission, the orchestration engine (`aidlc-orchestrate.ts` with exactly three subcommands: `next`, `report`, and `park`), graph compile, runner generation, sensor firing, the §13 learnings gate (`aidlc-learnings.ts`), and the swarm convergence referee (`aidlc-swarm.ts`).
- **Hooks**: `.aidlc/hooks/` — Framework hooks for audit emission, session lifecycle, state sync, state validation, subagent tracking, and statusline rendering. All framework files prefixed `aidlc-*.ts`.
## Conventions

- All artifacts go under the active intent's record dir — `aidlc/spaces/<active-space>/intents/<slug>-<id8>/` (shorthand `<record>/`) — beneath the neutral `aidlc/` workspace roof; application code goes to the workspace root (or a sibling repo). Single-team users only ever see `spaces/default/`.
- Each stage keeps an observation diary at `<record>/<phase>/<stage>/memory.md`, auto-created from a template at stage start and maintained by the orchestrator — never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`. The opencode-specific guide (install, what differs, verification) is `docs/guide/harnesses/opencode.md`.
## What's different on this harness

This is the same AI-DLC core that ships to every harness — one deterministic engine, state machine, audit trail, and stage set, rendered onto opencode. On opencode:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with `[Answer]:` tags remains the source of truth.
- Hooks ride the **AIDLC adapter plugin** (`.opencode/plugin/aidlc-opencode-adapter.ts`): reviewer read-scope enforcement and the AIDLC bash-command boundary run before tools; audit and sensors cover write, edit, and apply_patch; runtime-compile, presence minting, and pre-compaction state validation run from the matching opencode moments.
- The forwarding-loop enforcement (the Stop hook) rides `session.idle` and re-engages the loop by **injecting a nudge prompt** — advisory, not blocking; a chatting or pausing human is released by the hook's interactive cap.
- The AI-DLC method (`aidlc/spaces/<space>/memory/*.md`) reaches ambient context via the `instructions` glob in the project `opencode.json` or `opencode.jsonc`; `/aidlc space <name>` re-points every present config without removing JSONC comments.
- There is **no statusline** and **no welcome message**; use `/aidlc --status` and the progress lines at gates.
- Construction swarm runs as **task-tool fan-out only** (`AIDLC_USE_SWARM=1` is a loud no-op).
- Session-end audit events (`SESSION_ENDED`) are not emitted — opencode has no session-end hook moment; pre-compaction validation DOES fire (`experimental.session.compacting`).
- **MCP servers**: none ship (configure your own under `mcp:` in `opencode.json` if needed).
- A workflow's `aidlc/` workspace tree is harness-neutral: a project can move between harness installs (supported but untested — keep the trees in sync via the framework's packaging if you do this).

## Session Resumption

On startup, resolve the active intent (the `aidlc/spaces/<active-space>/intents/active-intent` cursor) and check for its `<record>/aidlc-state.md`. If found, load prior context and offer to resume from last checkpoint. (A brand-new workspace has no intent yet — the engine auto-births the first one on your first `/aidlc`.)
## Git Integration

Commit the `aidlc/` workspace tree — the record (state, the per-clone audit shards under `<record>/audit/`, `intents.json`), memory, codekb, and knowledge are all version-controlled. The shipped `.gitignore` excludes the per-user cursors and machine-local runtime (these may be per-clone or contain sensitive data):
- `aidlc/active-space` and `aidlc/spaces/*/intents/active-intent` (per-user cursors)
- `aidlc/.aidlc-clone-id` (per-clone audit-shard token) and `aidlc/.aidlc-sessions/`
- `aidlc/spaces/*/intents/*/runtime-graph.json` (also covers per-Bolt worktree fragments by relative-path glob)
- `aidlc/spaces/*/intents/*/.aidlc-*` (recovery, hooks-health, sensors scratch)
