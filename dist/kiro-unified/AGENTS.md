# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Kiro unified agent harness** — the shared agent runtime behind **Kiro IDE 1.x** and **Kiro CLI v3** (`kiro-cli --v3`). One workspace shell serves both surfaces. The workspace shell ships in `.kiro/` (no setup command); describe what you want to build and it sets up the workflow for you. Run `/aidlc` followed by a scope or project description to begin. Run `/aidlc --doctor` to validate your setup, `/aidlc --version` to print the framework version, `/aidlc --stage <slug>` to jump to a specific stage, `/aidlc --phase <name>` to jump to a phase, `/aidlc --depth <level>` to override depth, `/aidlc --test-strategy <level>` to override test volume, `/aidlc --review <class>` to cap stage reviews (adversarial, advisory, none). Run `/aidlc compose "<task>"` to get a plan tailored to that task (works up front, from a scan report via `--report <path>`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).

## Prerequisites

- **Surface**: either **Kiro IDE 1.x** or **Kiro CLI v3**. Sign in first, then select Claude Opus 4.8 as the chat model — in the IDE from the model picker, in the CLI with `/model`. ⚠️ CLI v3 is an explicit opt-in: `kiro-cli --v3`. Without that flag the CLI runs its 2.x engine, which reads neither this shell's `permissions:` blocks nor its standalone hook manifests.
- **bun**: Required for the CLI tools and hook scripts (tracking progress, writing the decision log, deciding what runs next). Install via `curl -fsSL https://bun.sh/install | bash`. `bun` must be on your PATH for the non-interactive shells the harness spawns — these source `~/.zshenv` (zsh) or `~/.bashrc` (bash), NOT `~/.zshrc`.
- **Activation**: open the project on either surface and invoke `/aidlc`; the command loads the shipped `skills/aidlc/SKILL.md`, which drives the workflow. In the **IDE**, the `.kiro/hooks/aidlc-*.json` manifests register in the Agent Hooks panel. In the **CLI**, the same manifests activate at session start — select the conductor explicitly with `kiro-cli --v3 --agent aidlc`. The shipped `settings/cli.json` names it as the default agent, but Kiro reads CLI settings from the global scope only, so a workspace copy does not take effect.
- **Permissions**: delegation-target agent `.md` files receive the read/write/shell grants they need through their own `permissions:` blocks, which both surfaces evaluate the same way. The approval gates plus your own permission settings remain the control boundary.
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
- **Hook permissions**: All 16 hooks are TypeScript (`.ts`) and run via `bun`. No executable bits required — works identically on macOS, Linux, and native Windows PowerShell.

## What AI-DLC does for you

AI-DLC walks a piece of work from idea to shipped code in ordered steps, and
stops to ask you for approval at each one. You describe what you want built; it
works out how much process the change needs, asks the questions it actually
needs answered, writes the design and code, and keeps a written record of what
was decided and why. Nothing advances past a step without your say-so, and you
can change the plan, the depth, or the direction at any approval point.

The sections below describe where it keeps things in this project. You do not
need to read them to start: run the command in the header above and answer the
questions.

## AI-DLC Structure

- **Skill**: `.kiro/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and the stage files across the phase directories (the enabled set depends on the composed plugins: see the compiled `.kiro/tools/data/stage-graph.json` or run `/aidlc --doctor`)
- **Session skills** (read-only, user-invocable): `.kiro/skills/aidlc-session-cost/`, `.kiro/skills/aidlc-replay/`, `.kiro/skills/aidlc-outcomes-pack/` — typed as `/aidlc-session-cost`, `/aidlc-replay`, `/aidlc-outcomes-pack`. Each pulls every count from `bun .kiro/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `.kiro/skills/aidlc-<stage>/` — one per runnable core stage, typed as `/aidlc-<stage>` (e.g. `/aidlc-domain-design`, `/aidlc-code-generation`); plugin-owned stages use their bare plugin-prefixed command name. Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `/aidlc --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun .kiro/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `/aidlc-init`, which creates the first workflow record and its starting state in one step. (This is opt-in packaging: describing what to build normally sets up the first piece of work by itself — no separate initialization command is needed.)
- **Agents**: `.kiro/agents/` — the base framework ships 14 agents: 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations), 2 review-only agents (product-lead, architecture-reviewer), and the adaptive-workflows composer. A plugin install may add more; the enabled set is discovered from the files present under that directory. The `/aidlc` command loads `skills/aidlc/SKILL.md`, which drives the workflow. The full 14-role roster supplies the four delegated stages (2.1 pipeline, 2.2 subagent, 2.4 mob, 3.5 subagent), reviewer passes, and composer requests. Agents ship as `.md` only, the conductor as `agents/aidlc.md` — the entry the workspace agent selector loads.
- **Method/rules**: `aidlc/spaces/<active-space>/memory/` — Layered files authored once at the workspace root, read by each harness via its native include (Claude `@`-import stub, Kiro CLI resources or IDE steering, Codex `AIDLC_RULES_DIR`, opencode `instructions` glob, Copilot `AGENTS.md` `@`-imports; no copy into `.kiro/`): `org.md` (framework defaults + organisation-wide guardrails), `team.md` (this team's affirmed practices), `project.md` (project-specific specialisation), plus `phases/<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `.kiro/sensors/`: automatic checks that run against what gets written (they report, they never block). Ships with framework defaults (`aidlc-claim-sources.md`, `aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-traceability.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `.kiro/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc/spaces/<active-space>/knowledge/` — User-managed team and domain knowledge, a space-level sibling of `memory/`/`codekb/`/`intents/` that accumulates across every intent in the space. Free-form and empty at bootstrap (no fixed file set, no seeded READMEs); the engine ensure-exists the empty dir on your first `/aidlc`. Agents read `aidlc/spaces/<active-space>/knowledge/aidlc-shared/` (all agents) and `aidlc/spaces/<active-space>/knowledge/<agent>/` (that agent) if the team creates them.
- **Tools**: `.kiro/tools/`: small command-line programs (TypeScript, run via bun) that do the parts which must be exact rather than judged: tracking where the workflow is, writing the decision log, deciding what runs next (`aidlc-orchestrate.ts`, with exactly four subcommands: `next`, `continue`, `report`, and `park`; `continue` is internal steering transport), running the automatic checks, recording what the team learned (`aidlc-learnings.ts`), and refereeing parallel Construction work (`aidlc-swarm.ts`). All framework files prefixed `aidlc-*.ts`.
- **Hooks**: `.kiro/hooks/`: scripts your CLI runs automatically at set moments, so the decision log, saved progress, and status display stay correct without anyone remembering to update them. All framework files prefixed `aidlc-*.ts`.

## Plugins

AI-DLC is open-world. Plugins under `plugins/<name>/` contribute additional stages, scopes, and agents, and `select-plugins` chooses which are enabled in this install. The counts above describe the base framework; your enabled set may differ. The compiled `.kiro/tools/data/stage-graph.json` and `/aidlc --doctor` are the authoritative live view of what is enabled here.

## Conventions

- All artifacts go under the active intent's record dir — `aidlc/spaces/<active-space>/intents/<slug>-<id8>/` (shorthand `<record>/`) — beneath the neutral `aidlc/` workspace roof; application code goes to the workspace root (or a sibling repo). Single-team users only ever see `spaces/default/`.
- Each stage keeps an observation diary at `<record>/<phase>/<stage>/memory.md`, auto-created from a template at stage start and kept up to date automatically as the stage runs, never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`. The guide for this harness (install, hook wiring, and what differs between the two surfaces) is `docs/guide/harnesses/kiro-unified.md`.
## What's different on this harness

This is the same AI-DLC core that ships to every harness: the same ordered steps, the same approval gates, and the same written record of what was decided, rendered onto the Kiro unified agent harness. On both Kiro IDE 1.x and Kiro CLI v3:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with `[Answer]:` tags remains the source of truth.
- There is **no statusline** and **no welcome message**; use `/aidlc --status` and the progress lines at gates. (`.kiro/hooks/aidlc-statusline.ts` ships with the framework but is inert here — it renders into Claude Code's `statusLine` setting, and neither surface registers it.)
- Construction swarm runs as **subagent fan-out only**. `AIDLC_USE_SWARM=1` does not switch drivers here: the conductor runs the subagent floor and records the downgrade as a `SWARM_DEGRADED` audit event.
- **Not every shipped hook body is registered.** `ls .kiro/hooks/*.json` is the live view. `aidlc-fold-usage.ts` and `aidlc-session-end.ts` are Claude-Code-only producers (they read that harness's transcript and session-lifecycle events); `aidlc-reviewer-scope.ts` ships unregistered because a per-persona guard would have to fire for a **delegated** agent, and agent-scope hooks fire only for the active one.
- Which `SESSION_*` audit events actually fire is surface- and version-specific, so it is not asserted here. Read the audit trail of a real run (`aidlc/spaces/<space>/intents/<record>/audit/*.md`) for the live answer, and `.aidlc-hooks-health/*.last` for which hooks fired at all.
- **MCP servers**: `.kiro/settings/mcp.json` ships a registry with every server **disabled** — enable what you need there, or scope it to one agent with the `includeMcpJson` / `mcpServers` fields in its `.md`. That file is the live list.
- A workflow's `aidlc/` workspace tree is harness-neutral: a project can move between Claude Code and Kiro installs (supported but untested — keep both `.claude/` and `.kiro/` in sync via the framework's packaging if you do this).

## Session Resumption

On startup, resolve the active intent (the `aidlc/spaces/<active-space>/intents/active-intent` cursor) and check for its `<record>/aidlc-state.md`. If found, load prior context and offer to resume from last checkpoint. (A brand-new project has no work recorded yet; the first `/aidlc` creates that record for you.)
## Git Integration

Commit the `aidlc/` workspace tree — the record (state, the per-clone audit shards under `<record>/audit/`, `intents.json`), memory, codekb, and knowledge are all version-controlled. The shipped `.gitignore` excludes the per-user cursors and machine-local runtime (these may be per-clone or contain sensitive data):
- `aidlc/active-space` and `aidlc/spaces/*/intents/active-intent` (per-user cursors)
- `aidlc/.aidlc-clone-id` (per-clone audit-shard token) and `aidlc/.aidlc-sessions/`
- `aidlc/spaces/*/intents/.aidlc-*` (pre-intent hooks-health scratch)
- `aidlc/spaces/*/intents/*/runtime-graph.json` (also covers per-Bolt worktree fragments by relative-path glob)
- `aidlc/spaces/*/intents/*/.aidlc-*` (recovery, hooks-health, sensors scratch)
