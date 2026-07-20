@.claude/rules/aidlc.md

<!--
  The @-line above pulls the AIDLC method into Claude's ambient context. It is
  the first hop of a reference chain (NOT a copy): CLAUDE.md → @.claude/rules/
  aidlc.md → @../../aidlc/spaces/default/memory/*.md. The method is authored ONCE
  at the workspace root under aidlc/spaces/default/memory/ (org/team/project +
  phases/), so edit it there, never in .claude/rules/aidlc.md. Verified resolving
  (G1 PASS) — see tmp/workspace-vision/at-import-spike/RESULTS.md.
-->

# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development. The workspace shell ships in `.claude/` (no setup command); the engine auto-births the first intent when you describe what to build. Run `/aidlc` followed by a scope or project description to begin. Run `/aidlc --doctor` to validate your setup. Run `/aidlc --version` to print the framework version. Run `/aidlc --stage <slug>` to jump to a specific stage, `/aidlc --phase <name>` to jump to a phase, `/aidlc --depth <level>` to override depth, `/aidlc --test-strategy <level>` to override test volume. Run `/aidlc compose "<task>"` to have the adaptive composer propose a tailored EXECUTE/SKIP plan (works up front, from a scan report via `--report <path>`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).

## Prerequisites

- **bun**: Required for CLI tools and hook scripts (state management, audit logging, jump orchestration). Install via `curl -fsSL https://bun.sh/install | bash`. On Windows: `npm install -g bun` or `powershell -c "irm bun.sh/install.ps1 | iex"`. Startup is ~20ms. **Important**: `bun` must be on your PATH for non-interactive shells. Claude Code runs your shell non-interactively, so it sources `~/.zshenv` (zsh) or `~/.bashrc` (bash) — NOT `~/.zshrc`. On Windows with Git Bash, `~/.bashrc` is the correct file. If `which bun` fails inside Claude Code, add the bun PATH export to the appropriate file.
- **AWS Bedrock access**: The shipped `.claude/settings.json` defaults the orchestrator to Opus 4.8 with the 1M-context variant via AWS Bedrock (`global.anthropic.claude-opus-4-8[1m]`), sets `AWS_REGION` to `us-east-1`, and pins global Bedrock model IDs for Fable, Opus, Sonnet, and Haiku. You need Bedrock model access enabled and AWS credentials on the default SDK credential chain to run the framework as shipped. If your region isn't `us-east-1`, override `AWS_REGION` in `.claude/settings.local.json`. Full setup (model access, IAM, credentials, region) is in `docs/guide/01-getting-started.md` § "AWS Bedrock Setup".
- **MCP servers (optional)**: `.mcp.json` (project root, beside `.claude/`) declares the MCP servers available to the framework. `context7` (library/SDK documentation lookups) is an HTTP server that reads `CONTEXT7_API_KEY` from your environment. The four AWS servers (`aws-mcp`, `aws-pricing`, `aws-iac`, `aws-serverless`) launch via `uvx` and authenticate with your standard AWS credential chain — they require an AWS account with IAM credentials available to your shell (install `uv`/`uvx` via `curl -fsSL https://astral.sh/uv/install.sh | sh`). All credentials flow through environment passthrough; no keys are committed. Servers you have no credentials for are simply unavailable and never block a workflow. Declared servers are provisioned to the session and **inherited by every agent** — there is no per-agent grant; agents that should be prevented from using a server are narrowed via their `tools:` allowlist with fully-qualified `mcp__<server>__<tool>` ids.
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Hook permissions**: All 13 hooks are TypeScript (`.ts`) and run via `bun`. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.
- **Settings**: `.claude/settings.json` pre-approves tools (Read, Edit, Write, Bash, Glob, Grep, Task, WebSearch) so workflows run without per-call permission prompts.
- **Personal overrides**: Copy `.claude/settings.local.json.example` to `.claude/settings.local.json` (gitignored) to override the model or set environment variables without affecting shared settings.

## AI-DLC Structure

- **Skill**: `.claude/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phase directories
- **Session skills** (read-only, user-invocable): `.claude/skills/aidlc-session-cost/`, `.claude/skills/aidlc-replay/`, `.claude/skills/aidlc-outcomes-pack/` — typed as `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Each pulls every count from `bun .claude/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `.claude/skills/aidlc-<stage>/` — one per runnable core stage, typed as `/aidlc-<stage>` (e.g. `/aidlc-application-design`, `/aidlc-code-generation`); plugin-owned stages use their bare plugin-prefixed command name. Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `/aidlc --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun .claude/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `/aidlc-init`, which mints the first intent and builds its state in one step. (This is opt-in packaging: the engine normally auto-births the first intent the moment you describe what to build — no separate initialization command is needed.)
- **Agents**: `.claude/agents/` — 14 agents: 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations), 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer. Each is a flat `.md` file prefixed `aidlc-<role>-agent.md`; the conductor adopts domain personas inline where the stage mode calls for it and delegates workers for the four dispatched stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests via the `Task` tool.
- **Method/rules**: `aidlc/spaces/<active-space>/memory/` — Layered files authored once at the workspace root, read by each harness via its native include (no copy into `.claude/`): `org.md` (framework defaults + organisation-wide guardrails), `team.md` (this team's affirmed practices), `project.md` (project-specific specialisation), plus `phases/<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `.claude/sensors/` — Deterministic verification manifests (advisory). Ships with framework defaults (`aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `.claude/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc/spaces/<active-space>/knowledge/` — User-managed team and domain knowledge, a space-level sibling of `memory/`/`codekb/`/`intents/` that accumulates across every intent in the space. Free-form and empty at bootstrap (no fixed file set, no seeded READMEs); the engine ensure-exists the empty dir on your first `/aidlc`. Agents read `aidlc/spaces/<active-space>/knowledge/aidlc-shared/` (all agents) and `aidlc/spaces/<active-space>/knowledge/<agent>/` (that agent) if the team creates them.
- **Tools**: `.claude/tools/` — Deterministic CLI tools (TypeScript, run via bun). All framework files prefixed `aidlc-*.ts`. They cover state management, audit emission, the orchestration engine (`aidlc-orchestrate.ts` with exactly three subcommands: `next`, `report`, and `park`), graph compile, runner generation, sensor firing, the §13 learnings gate (`aidlc-learnings.ts`), and the swarm convergence referee (`aidlc-swarm.ts`).
- **Hooks**: `.claude/hooks/` — Framework hooks for audit emission, session lifecycle, state sync, state validation, subagent tracking, and statusline rendering. All framework files prefixed `aidlc-*.ts`.
## Conventions

- All artifacts go under the active intent's record dir — `aidlc/spaces/<active-space>/intents/<slug>-<id8>/` (shorthand `<record>/`) — beneath the neutral `aidlc/` workspace roof; application code goes to the workspace root (or a sibling repo). Single-team users only ever see `spaces/default/`.
- Each stage keeps an observation diary at `<record>/<phase>/<stage>/memory.md`, auto-created from a template at stage start and maintained by the orchestrator — never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`.
## AI-DLC Method (imported)

The AI-DLC method — the layered practice files (`org.md`, `team.md`, `project.md`, and the per-phase `phases/<phase>.md`) — is authored once at the workspace root under `aidlc/spaces/<active-space>/memory/` and imported into Claude's ambient context by reference (the `@.claude/rules/aidlc.md` import at the top of this file), never copied. The shipped shell starts on `default`; switching spaces repoints that stub to the selected space. Edit the active space's memory files — they are the single hand-editable source of truth, identical on every harness. (AI-DLC's own stage resolver reads the same tree directly, so each stage is method-correct without this ambient import.)

## Session Resumption

On startup, resolve the active intent (the `aidlc/spaces/<active-space>/intents/active-intent` cursor) and check for its `<record>/aidlc-state.md`. If found, load prior context and offer to resume from last checkpoint. (A brand-new workspace has no intent yet — the engine auto-births the first one on your first `/aidlc`.)
## Git Integration

Commit the `aidlc/` workspace tree — the record (state, the per-clone audit shards under `<record>/audit/`, `intents.json`), memory, codekb, and knowledge are all version-controlled. The shipped `.gitignore` excludes the per-user cursors and machine-local runtime (these may be per-clone or contain sensitive data):
- `aidlc/active-space` and `aidlc/spaces/*/intents/active-intent` (per-user cursors)
- `aidlc/.aidlc-clone-id` (per-clone audit-shard token) and `aidlc/.aidlc-sessions/`
- `aidlc/spaces/*/intents/*/runtime-graph.json` (also covers per-Bolt worktree fragments by relative-path glob)
- `aidlc/spaces/*/intents/*/.aidlc-*` (recovery, hooks-health, sensors scratch)
- `.claude/settings.local.json`
