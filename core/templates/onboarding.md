{{SLOT:title_block}}

## Prerequisites

{{SLOT:prereq_bullets}}
- **Locking**: Audit log file locking is handled portably using mkdir-based locking in the system temp directory (no external dependencies).
{{SLOT:hook_permissions}}
{{SLOT:prereq_bullets_tail}}

## AI-DLC Structure

- **Skill**: `{{HARNESS_DIR}}/skills/aidlc/` — Orchestrator (`SKILL.md`), stage protocol, and 32 stage files across 5 phase directories
- **Session skills** (read-only, user-invocable): `{{HARNESS_DIR}}/skills/aidlc-session-cost/`, `{{HARNESS_DIR}}/skills/aidlc-replay/`, `{{HARNESS_DIR}}/skills/aidlc-outcomes-pack/` — typed as `{{INVOKE}}-session-cost`, `{{INVOKE}}-replay`, `{{INVOKE}}-outcomes-pack`. Each pulls every count from `bun {{HARNESS_DIR}}/tools/aidlc-runtime.ts summary --json` (no LLM-side counting). Classified `read-only`: they never advance the workflow stage pointer and never emit audit events. `aidlc-session-cost` and `aidlc-replay` print to the terminal only; `aidlc-outcomes-pack` is the only one that writes a file (`OUTCOMES.md`).
- **Stage-runner skills** (user-invocable): `{{HARNESS_DIR}}/skills/aidlc-<stage>/` — one per runnable stage, typed as `{{INVOKE}}-<stage>` (e.g. `{{INVOKE}}-application-design`, `{{INVOKE}}-code-generation`). Each runs that single stage in isolation via the engine's `--single` mode (`aidlc-orchestrate next --stage <slug> --single`) and **never advances your main workflow's `Current Stage`** — a single-stage run is isolated by design (the tool refuses to advance the main workflow). They are opt-in packaging: the same stage is reachable via `{{INVOKE}} --stage <slug> --single` without a runner. The runner set is generated from the compiled stage graph by `bun {{HARNESS_DIR}}/tools/aidlc-runner-gen.ts write` and kept in sync by its `check` drift guard, so adding a stage file and regenerating adds its runner. The three bootstrap **initialization** stages ship no per-stage runner (they have no standalone meaning); the whole initialization phase is packaged as `{{INVOKE}}-init`, a thin wrapper over `{{INVOKE}} --init`.
- **Agents**: `{{HARNESS_DIR}}/agents/` — 11 domain-expert personas (product, design, delivery, architect, aws-platform, compliance, devsecops, developer, quality, pipeline-deploy, operations). {{SLOT:agents_note}}
- **Rules**: `{{HARNESS_DIR}}/rules/` — Flat layered files: `aidlc-org.md` (framework defaults + organisation-wide guardrails), `aidlc-team.md` (this team's affirmed practices), `aidlc-project.md` (project-specific specialisation), plus `aidlc-phase-<phase>.md` for ideation, inception, construction, and operation (initialization is bootstrap-only and ships no rule file). Resolution is a strict-additive five-layer chain — `org → team → project → phase → stage` — where every applicable rule appears in `rules_in_context` at runtime. Conflicts (narrower contradicting broader policy) are rejected at the §13 learning admission check before the learning reaches disk. See `docs/reference/01-architecture.md` § "Configuration layers" and `docs/reference/08-rule-system.md` for the schema.
- **Sensors**: `{{HARNESS_DIR}}/sensors/` — Deterministic verification manifests (advisory). Ships with framework defaults (`aidlc-required-sections.md`, `aidlc-upstream-coverage.md`, `aidlc-linter.md`, `aidlc-type-check.md`); forks may add custom `aidlc-<id>.md` manifests. Stages declare which sensors fire via the frontmatter `sensors: [<id>]` list — a pull import resolved at compile time. The PostToolUse hook reads the compile-resolved `sensors_applicable` array off the stage graph node.
- **Knowledge**: `{{HARNESS_DIR}}/knowledge/` — Methodology reference. Per-agent under `aidlc-<agent>-agent/` subfolders; `aidlc-shared/` holds cross-agent material. Ships with framework.
- **Team Knowledge**: `aidlc-docs/knowledge/` — User-managed team and project knowledge (per-agent + cross-agent, scaffolded by `{{INVOKE}} --init` or auto-created on workflow start).
- **Tools**: `{{HARNESS_DIR}}/tools/` — Deterministic CLI tools (TypeScript, run via bun). All framework files prefixed `aidlc-*.ts`. They cover state management, audit emission, the orchestration engine (`aidlc-orchestrate.ts` with its `next`/`report` subcommands), graph compile, runner generation, sensor firing, the §13 learnings gate (`aidlc-learnings.ts`), and the swarm convergence referee (`aidlc-swarm.ts`).
{{SLOT:hooks_or_extensions}}
{{SLOT:structure_extra}}
## Conventions

- All artifacts go to `aidlc-docs/` under the workspace root; application code goes to the workspace root
- Each stage keeps an observation diary at `aidlc-docs/<phase>/<stage>/memory.md`, auto-created from a template at stage start and maintained by the orchestrator — never hand-edited
- Use emojis as defined in skill/stage files — reproduce them exactly
- Validate Mermaid diagram syntax before writing; include text fallback
- Validate all generated content for character escaping issues

## Documentation

For full documentation, see `docs/guide/` (User Guide), `docs/harness-engineering/` (Harness Engineer Guide), and `docs/reference/` (Developer Reference); start at `docs/README.md`. {{SLOT:guide_pointer}}
{{SLOT:sections_before_resumption}}
## Session Resumption

On startup, check for `aidlc-docs/aidlc-state.md`. If found, load prior context and offer to resume from last checkpoint.
{{SLOT:sections_after_resumption}}
## Git Integration

Commit `aidlc-docs/` (except the entries below, which may contain sensitive data). Add these to `.gitignore`:
- `aidlc-docs/audit.md`
- `aidlc-docs/.aidlc-recovery.md`
- `aidlc-docs/runtime-graph.json` (also covers per-Bolt worktree fragments at `<worktree>/aidlc-docs/runtime-graph.json` by relative-path glob semantics)
- `aidlc-docs/.aidlc-hooks-health/`
- `aidlc-docs/.aidlc-sensors/`
{{SLOT:gitignore_extra}}
