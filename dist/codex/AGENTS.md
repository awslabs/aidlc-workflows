# AI-DLC on Codex CLI

This project uses AI-DLC (AI-Driven Development Life Cycle) under the OpenAI
Codex CLI harness (minimum version 0.139.0). Invoke the orchestrator skill with
`$aidlc` (or `/skills` → aidlc) followed by a scope or project description.
The deterministic engine, state machine, audit log, and referee are
byte-identical to every other harness distribution; only the shell differs. Run
`$aidlc --status` for progress, `$aidlc --help` for usage, `$aidlc intent`
to list intents, `$aidlc --doctor` to validate setup, and
`$aidlc --stage <slug>` / `--phase <name>` / `--depth <level>` /
`--test-strategy <level>` for the usual overrides. Run `$aidlc compose
"<task>"` to have the adaptive composer propose a tailored EXECUTE/SKIP plan
(up front, from a scan report via `--report <path>`, or mid-workflow to
re-shape the pending stages - every proposal stops at an approve/edit/reject
gate).

## Prerequisites

- **Codex CLI ≥ 0.139.0**: earlier releases do not surface the real agent role in subagent hook payloads and do not resolve hyphenated agent TOMLs. `$aidlc --doctor` enforces the pin. Check with `codex --version`.
- **bun**: Required for CLI tools and hook scripts (state management, audit logging, jump orchestration). Install via `curl -fsSL https://bun.sh/install | bash`. On Windows: `npm install -g bun` or `powershell -c "irm bun.sh/install.ps1 | iex"`. `bun` must be on your PATH for the non-interactive shells the harness spawns — these source `~/.zshenv` (zsh) or `~/.bashrc` (bash), NOT `~/.zshrc`.
- **Model provider**: The shipped `.codex/config.toml` defaults to **Amazon Bedrock** — the session (and judgment-tier agents, which inherit it) on `openai.gpt-5.5`, balanced/templated agents pinned to `openai.gpt-5.4` (the tier projection). Set your AWS profile/region under `[model_providers.amazon-bedrock.aws]` (shipped defaults `profile = "default"`, `region = "us-east-1"`); you need Bedrock model access and AWS credentials on the default SDK credential chain. For OpenAI auth instead, comment out `model_provider` and the `[model_providers]` block. Note: `web_search` is unavailable on Bedrock, so the market-research stage degrades gracefully.
- **MCP servers (optional)**: Codex reads MCP server definitions from `[mcp_servers.<name>]` tables in `config.toml` (project `.codex/config.toml` or `~/.codex/config.toml`). The shipped config declares none — add the servers you need there. Credentials flow through your environment; a server you have no credentials for is simply unavailable and never blocks a workflow.
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Hook permissions**: All 12 hooks are TypeScript (`.ts`) and run via `bun`. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.
- **Permissions**: `.codex/rules/default.rules` (Starlark prefix rules) pre-allows the deterministic core's exact command prefixes — `bun .codex/tools/`, `bun .codex/hooks/`, and `git worktree`/`commit`/`add` — so workflows run without per-call prompts. The sandbox is `workspace-write`; commands outside the allowlist prompt.
- **Personal overrides**: Settings in `~/.codex/config.toml` merge over the project `.codex/config.toml`. Put machine-specific overrides (model, AWS profile/region, environment variables) there to avoid changing the shared project config.

## AI-DLC Structure

- **Skill**: `.agents/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phase directories
- **Session skills** (read-only, user-invocable): `.agents/skills/aidlc-session-cost/`, `.agents/skills/aidlc-replay/`, `.agents/skills/aidlc-outcomes-pack/` — typed as `$aidlc-session-cost`, `$aidlc-replay`, `$aidlc-outcomes-pack`. Each pulls every count from `bun .codex/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `.agents/skills/aidlc-<stage>/` — one per runnable stage, typed as `$aidlc-<stage>` (e.g. `$aidlc-application-design`, `$aidlc-code-generation`). Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `$aidlc --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun .codex/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `$aidlc-init`, which mints the first intent and builds its state in one step. (This is opt-in packaging: the engine normally auto-births the first intent the moment you describe what to build — no separate initialization command is needed.)
- **Agents**: `.codex/agents/` — 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations). On Codex the agent personas are transposed into `.agents/` TOMLs (the conductor reads the persona `.md` bodies as prose); the two subagent stages (2.1, 3.5) run as `codex exec` workers.
- **Method/rules**: `aidlc/spaces/<space>/memory/` — Layered files authored once at the workspace root, read by each harness via its native include (no copy into `.codex/`): `org.md` (framework defaults + organisation-wide guardrails), `team.md` (this team's affirmed practices), `project.md` (project-specific specialisation), plus `phases/<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `.codex/sensors/` — Deterministic verification manifests (advisory). Ships with framework defaults (`aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `.codex/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc/knowledge/` (i.e. `aidlc/spaces/<space>/knowledge/`) — User-managed team and domain knowledge, a space-level sibling of `memory/`/`codekb/`/`intents/` that accumulates across every intent in the space. Free-form and empty at bootstrap (no fixed file set, no seeded READMEs); the engine ensure-exists the empty dir on your first `$aidlc`. Agents read `aidlc/knowledge/aidlc-shared/` (all agents) and `aidlc/knowledge/<agent>/` (that agent) if the team creates them.
- **Tools**: `.codex/tools/` — Deterministic CLI tools (TypeScript, run via bun). All framework files prefixed `aidlc-*.ts`. They cover state management, audit emission, the orchestration engine (`aidlc-orchestrate.ts` with its `next`/`report` subcommands), graph compile, runner generation, sensor firing, the §13 learnings gate (`aidlc-learnings.ts`), and the swarm convergence referee (`aidlc-swarm.ts`).
- **Hooks**: `.codex/hooks/` — Framework hooks for audit emission, session lifecycle, state sync, state validation, subagent tracking, and statusline rendering. All framework files prefixed `aidlc-*.ts`.
## Conventions

- All artifacts go under the active intent's record dir — `aidlc/spaces/<space>/intents/<slug>-<id8>/` (shorthand `<record>/`) — beneath the neutral `aidlc/` workspace roof; application code goes to the workspace root (or a sibling repo). Single-team users only ever see `spaces/default/`.
- Each stage keeps an observation diary at `<record>/<phase>/<stage>/memory.md`, auto-created from a template at stage start and maintained by the orchestrator — never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`. The Codex-specific guide (prerequisites, trust pre-seed, Bedrock config, the git-repo requirement) is `docs/guide/harnesses/codex-cli.md`.
## What's different on this harness

This is the same AI-DLC core that ships to every harness, rendered onto Codex CLI. On Codex:

- **Gates** render as structured questions via the `request_user_input` tool when the shipped config flags enable it, with a numbered-prose fallback otherwise. Gate semantics live in the engine either way.
- **No custom statusline and no welcome message**: workflow position rides the `update_plan` tool and `$aidlc --status`.
- **Git under the sandbox**: `workspace-write` keeps `.git` read-only in-sandbox; interactive sessions auto-escalate and `.codex/rules/default.rules` pre-allows `git worktree`/`commit`/`add`. Headless runs need `writable_roots` (template in the shipped `config.toml`).
- **Swarm floor** is `codex exec`-per-unit workers; `AIDLC_USE_SWARM=1` has no Workflow tool here and loud-degrades (`SWARM_DEGRADED`).
- **Session lifecycle**: Codex has no SessionEnd event (an unclosed session is reconciled as an inferred `SESSION_ENDED` at the next start); the Codex-only PostCompact event re-injects the workflow mission after compaction.
- **The AIDLC method** (the layered practice files `org.md`, `team.md`, `project.md`, and the per-phase `phases/<phase>.md`) lives once at the workspace root under `aidlc/spaces/default/memory/` — the single hand-editable source of truth, identical on every harness, NOT a per-harness copy. Codex auto-merges the root `AGENTS.md` and the orchestrator injects an `@aidlc/spaces/default/memory/…` prompt mention to pull specific method files into context on demand; AI-DLC's own stage resolver reads the same tree directly (via the `AIDLC_RULES_DIR` seam in the shipped `config.toml`). Edit the method there, never under `.codex/`. (`.codex/rules/default.rules` remains Codex's native Starlark permission-rules file — distinct from the AIDLC method, and the two must not collide.)

## Session Resumption

On startup, resolve the active intent (the `aidlc/spaces/<space>/intents/active-intent` cursor) and check for its `<record>/aidlc-state.md`. If found, load prior context and offer to resume from last checkpoint. (A brand-new workspace has no intent yet — the engine auto-births the first one on your first `$aidlc`.)
## Git Integration

Commit the `aidlc/` workspace tree — the record (state, the per-clone audit shards under `<record>/audit/`, `intents.json`), memory, codekb, and knowledge are all version-controlled. The shipped `.gitignore` excludes the per-user cursors and machine-local runtime (these may be per-clone or contain sensitive data):
- `aidlc/active-space` and `aidlc/spaces/*/intents/active-intent` (per-user cursors)
- `aidlc/.aidlc-clone-id` (per-clone audit-shard token) and `aidlc/.aidlc-sessions/`
- `aidlc/spaces/*/intents/*/runtime-graph.json` (also covers per-Bolt worktree fragments by relative-path glob)
- `aidlc/spaces/*/intents/*/.aidlc-*` (recovery, hooks-health, sensors scratch)
