# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **oh-my-pi** (omp) harness. Run `/aidlc` followed by a scope or project description to begin. Run `/aidlc --init` to scaffold the full `aidlc-docs/` directory tree without starting a workflow (`--init --force` overwrites an existing workspace). Run `/aidlc --doctor` to validate your setup. Run `/aidlc --version` to print the framework version. Run `/aidlc --stage <slug>` to jump to a specific stage, `/aidlc --phase <name>` to jump to a phase, `/aidlc --depth <level>` to override depth, `/aidlc --test-strategy <level>` to override test volume, or `/aidlc --test-run` to auto-approve gates for CI/automated runs.

## Prerequisites

- **bun**: Required for CLI tools and hook scripts (state management, audit logging, jump orchestration). oh-my-pi ships with bun; if `which bun` fails inside a hook, install via `curl -fsSL https://bun.sh/install | bash` (zsh: add the `BUN_INSTALL`/`PATH` export to `~/.zshenv`; bash: `~/.bashrc`; Windows Git Bash: `~/.bashrc`). Startup is ~20ms.
- **Model configuration**: The orchestrator defaults to whatever model your omp session is configured with. Configure models through omp's standard provider flow — `anthropic/claude-opus-4-8` for the orchestrator is the recommended default. Override per-session by passing `--model <id>` to `omp` at session start.
- **MCP servers (optional)**: omp supports MCP via `mcp.json` at your project root. `context7` (library/SDK documentation lookups) is the recommended addition. Configure via `omp -p '/extensions'` → MCP. All credentials flow through environment passthrough; no keys are committed.
- **Plugin install**: After copying `.omp/` into your project, run `omp -p '/extensions'` to confirm every skill, agent, hook, command, tool, and rule loaded from your project worked. Then `/aidlc --doctor` validates the methodology state.
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Hook permissions**: All 10 hooks are TypeScript (`.ts`) and run via `bun` under oh-my-pi's hook runner. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.
- **Personal overrides**: omp reads `~/.omp/agent/config.yml` for user-scope configuration (skill allowlists, hook filters, TTSR settings). Edit that file directly; no project-level equivalent because user-level settings must persist across projects.

## AI-DLC Structure

- **Skill**: `.omp/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phase directories
- **Session skills** (read-only, user-invocable): `.omp/skills/aidlc-session-cost/`, `.omp/skills/aidlc-replay/`, `.omp/skills/aidlc-outcomes-pack/` — typed as `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Each pulls every count from `bun .omp/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `.omp/skills/aidlc-<stage>/` — one per runnable stage, typed as `/aidlc-<stage>` (e.g. `/aidlc-application-design`, `/aidlc-code-generation`). Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `/aidlc --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun .omp/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `/aidlc-init`, a thin wrapper over `/aidlc --init`.
- **Agents**: `.omp/agents/` — 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations). Each is a flat `.md` file prefixed `aidlc-<role>-agent.md`; the conductor adopts the persona inline, or delegates via `task` for the two subagent stages (2.1, 3.5).
- **Rules**: `.omp/aidlc-common/rules/` — Flat layered files: `aidlc-org.md` (framework defaults + organisation-wide guardrails), `aidlc-team.md` (this team's affirmed practices), `aidlc-project.md` (project-specific specialisation), plus `aidlc-phase-<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `.omp/sensors/` — Deterministic verification manifests (advisory). Ships with framework defaults (`aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `.omp/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc-docs/knowledge/` — User-managed team and project knowledge (per-agent + cross-agent, scaffolded by `/aidlc --init` or auto-created on workflow start).
- **Tools**: `.omp/tools/` — Deterministic CLI tools (TypeScript, run via bun). All framework files prefixed `aidlc-*.ts`. They cover state management, audit emission, the orchestration engine (`aidlc-orchestrate.ts` with its `next`/`report` subcommands), graph compile, runner generation, sensor firing, the §13 learnings gate (`aidlc-learnings.ts`), and the swarm convergence referee (`aidlc-swarm.ts`).
- **Hooks**: `.omp/hooks/pre/` and `.omp/hooks/post/` — Framework hooks for audit emission, session lifecycle, state sync, state validation, subagent tracking, and statusline rendering. All framework files prefixed `aidlc-*.ts`. Discovery is filesystem-driven (non-recursive, one level per subdirectory).
- **Slash commands**: `.omp/commands/` — One command per runnable stage (e.g. `/aidlc-intent-capture`), one per scope (e.g. `/aidlc-bugfix`), plus `/aidlc` (orchestrator), `/aidlc-init`, `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Each calls the `aidlc_orchestrate` custom tool; the skill set under `.omp/skills/` exposes the same stages as discoverable playbooks.
- **Custom tool**: `.omp/tools/aidlc-orchestrate/index.ts` — Exposes the orchestration engine as an omp custom tool (`aidlc_orchestrate`). Conductors call it instead of spawning a subprocess.
- **Rules**: Layered under `.omp/aidlc-common/rules/` (org/team/project/phase); engine merges the chain at compile time and writes the effective prose into `.omp/RULES.md` (omp's always-apply rule file, injected into every turn).
- **TTSR rules**: `.omp/aidlc-common/rules/` and `.omp/ttsr/` — omp TTSR-style regex triggers (ship blank; add project-specific stream guards here).
## Conventions

- All artifacts go to `aidlc-docs/` under the workspace root; application code goes to the workspace root
- Each stage keeps an observation diary at `aidlc-docs/<phase>/<stage>/memory.md`, auto-created from a template at stage start and maintained by the orchestrator — never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`.
## What's different on this harness

This is the same AI-DLC core that ships to every harness, rendered onto oh-my-pi. On omp:

- The orchestrator is a **custom tool** (`aidlc_orchestrate`) rather than a Bash subprocess call. Conductors call it with a JSON schema.
- **Gates** and **questions** use omp's built-in question widget (same structured fields as AskUserQuestion on Claude Code).
- **Slash commands** at `.omp/commands/` provide native `/aidlc-<stage>` and `/aidlc-<scope>` shortcuts in addition to the skill-based runners.
- **Hooks** live in `hooks/pre/` and `hooks/post/` (omp filesystem discovery).
- **Rules** are at `aidlc-common/rules/` (inside aidlc-common, not top-level); the engine compiles them into `.omp/RULES.md` which omp injects as always-apply context.
- A workflow's `aidlc-docs/` is harness-neutral: a project can move between Claude Code and omp installs (keep both `.omp/` and `.claude/` in sync via the framework's packaging if you do this).

## Session Resumption

On startup, check for `aidlc-docs/aidlc-state.md`. If found, load prior context and offer to resume from last checkpoint.
## Automated Testing

The `--test-run` flag (`/aidlc bugfix --test-run`) auto-approves all approval gates and question stages for automated testing. It is intended for CI/test environments only — not for interactive use. State tracking, audit logging, and artifact generation all continue normally.

## Git Integration

Commit `aidlc-docs/` (except the entries below, which may contain sensitive data). Add these to `.gitignore`:
- `aidlc-docs/audit.md`
- `aidlc-docs/.aidlc-recovery.md`
- `aidlc-docs/runtime-graph.json` (also covers per-Bolt worktree fragments at `<worktree>/aidlc-docs/runtime-graph.json` by relative-path glob semantics)
- `aidlc-docs/.aidlc-hooks-health/`
- `aidlc-docs/.aidlc-sensors/`

