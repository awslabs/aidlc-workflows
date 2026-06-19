# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development. Run `/aidlc` followed by a scope or project description to begin. Run `/aidlc --init` to scaffold the full `aidlc-docs/` directory tree without starting a workflow (`--init --force` overwrites an existing workspace). Run `/aidlc --doctor` to validate your setup. Run `/aidlc --version` to print the framework version. Run `/aidlc --stage <slug>` to jump to a specific stage, `/aidlc --phase <name>` to jump to a phase, `/aidlc --depth <level>` to override depth, `/aidlc --test-strategy <level>` to override test volume, or `/aidlc --test-run` to auto-approve gates for CI/automated runs.

## Prerequisites

- **bun**: Required for CLI tools (state management, audit logging, jump orchestration). Install via `curl -fsSL https://bun.sh/install | bash`. On Windows: `npm install -g bun` or `powershell -c "irm bun.sh/install.ps1 | iex"`. Startup is ~20ms. **Important**: `bun` must be on your PATH for non-interactive shells. Pi runs your shell non-interactively, so it sources `~/.zshenv` (zsh) or `~/.bashrc` (bash) — NOT `~/.zshrc`. On Windows with Git Bash, `~/.bashrc` is the correct file.
- **AWS Bedrock access**: The shipped `.pi/settings.json` defaults the orchestrator to Opus 4.8 via AWS Bedrock (`us.anthropic.claude-opus-4-8`), sets `AWS_REGION` to `us-east-1`, and pins Bedrock model IDs for Opus, Sonnet, and Haiku. You need Bedrock model access enabled and AWS credentials on the default SDK credential chain to run the framework as shipped. If your region isn't `us-east-1`, override `AWS_REGION` in `.pi/settings.local.json`. Full setup (model access, IAM, credentials, region) is in `docs/guide/01-getting-started.md` § "AWS Bedrock Setup".
- **MCP servers (optional)**: Pi supports MCP via project-level configuration. `context7` (library/SDK documentation lookups) is the recommended addition. All credentials flow through environment passthrough; no keys are committed. Servers you have no credentials for are simply unavailable and never block a workflow.
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Extensions**: `aidlc-hooks` and `askuserquestion` run natively within Pi — no separate bun invocation required for lifecycle events. No executable bits required.
- **Settings**: `.pi/settings.json` registers the extensions (`["aidlc-hooks", "askuserquestion"]`) and pre-approves tools (Read, Edit, Write, Bash, Glob, Grep, Task, WebSearch) so workflows run without per-call permission prompts.
- **Personal overrides**: Copy `.pi/settings.local.json.example` to `.pi/settings.local.json` (gitignored) to override the model or set environment variables without affecting shared settings.

## AI-DLC Structure

- **Skill**: `.pi/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phase directories
- **Session skills** (read-only, user-invocable): `.pi/skills/aidlc-session-cost/`, `.pi/skills/aidlc-replay/`, `.pi/skills/aidlc-outcomes-pack/` — typed as `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Each pulls every count from `bun .pi/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `.pi/skills/aidlc-<stage>/` — one per runnable stage, typed as `/aidlc-<stage>` (e.g. `/aidlc-application-design`, `/aidlc-code-generation`). Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `/aidlc --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun .pi/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `/aidlc-init`, a thin wrapper over `/aidlc --init`.
- **Agents**: `.pi/agents/` — 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations). Each is a flat `.md` file prefixed `aidlc-<role>-agent.md`; the conductor adopts the persona inline, or delegates to it via the `Task` tool for the two subagent stages (2.1, 3.5).
- **Rules**: `.pi/rules/` — Flat layered files: `aidlc-org.md` (framework defaults + organisation-wide guardrails), `aidlc-team.md` (this team's affirmed practices), `aidlc-project.md` (project-specific specialisation), plus `aidlc-phase-<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `.pi/sensors/` — Deterministic verification manifests (advisory). Ships with framework defaults (`aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `.pi/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc-docs/knowledge/` — User-managed team and project knowledge (per-agent + cross-agent, scaffolded by `/aidlc --init` or auto-created on workflow start).
- **Tools**: `.pi/tools/` — Deterministic CLI tools (TypeScript, run via bun). All framework files prefixed `aidlc-*.ts`. They cover state management, audit emission, the orchestration engine (`aidlc-orchestrate.ts` with its `next`/`report` subcommands), graph compile, runner generation, sensor firing, the §13 learnings gate (`aidlc-learnings.ts`), and the swarm convergence referee (`aidlc-swarm.ts`).
- **Extensions**: `.pi/extensions/` — One consolidated `aidlc-hooks.ts` extension covering audit emission, sensor dispatch, runtime-graph compile, session lifecycle, state validation, subagent tracking, statusline rendering, and forwarding-loop enforcement. Plus `askuserquestion/` — the structured question-answering UI component used at every approval gate.

## Conventions

- All artifacts go to `aidlc-docs/` under the workspace root; application code goes to the workspace root
- Each stage keeps an observation diary at `aidlc-docs/<phase>/<stage>/memory.md`, auto-created from a template at stage start and maintained by the orchestrator — never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`.

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
- `.pi/settings.local.json`
