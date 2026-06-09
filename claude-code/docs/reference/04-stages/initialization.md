# Initialization Phase Stages (0.1-0.3)

## Phase Overview

The Initialization phase is the first of five phases in the AI-DLC workflow. It runs stages 0.1 through 0.3, bootstrapping the workspace with state files, directory scaffolding, workspace classification, and routing configuration.

All 3 stages in this phase execute for EVERY scope — there are no conditional stages. All stages auto-proceed with no approval gates.

The welcome message is rendered at session start via the `companyAnnouncements` entry in `settings.json`. It is not a stage — no stage file, no audit event, no checkbox.

All three stages run inside a single deterministic `bun .claude/tools/aidlc-utility.ts init --scope <scope>` call that completes in well under a second. The conductor creates 3 tasks in the sidebar (Workspace Scaffold, Workspace Detection, State Init) for observability, then marks them all completed once the tool returns.

## Scope-Driven Stage Inclusion

| Scope | Stages Included |
|-------|----------------|
| enterprise | All 0.1-0.3 |
| feature | All 0.1-0.3 |
| mvp | All 0.1-0.3 |
| poc | All 0.1-0.3 |
| bugfix | All 0.1-0.3 |
| refactor | All 0.1-0.3 |
| infra | All 0.1-0.3 |
| security-patch | All 0.1-0.3 |
| workshop | All 0.1-0.3 |

## Stage Summary

| Slug | # | Stage Name | Condition | Lead Agent | Mode |
|------|---|------------|-----------|------------|------|
| workspace-scaffold | 0.1 | Workspace Scaffold | ALWAYS | (orchestrator) | auto-proceed |
| workspace-detection | 0.2 | Workspace Detection | ALWAYS | (orchestrator) | auto-proceed |
| state-init | 0.3 | State Initialization | ALWAYS | (orchestrator) | auto-proceed |

---

## Stage 0.1 — Workspace Scaffold

| Field | Value |
|-------|-------|
| Stage # | 0.1 |
| Slug | workspace-scaffold |
| Phase | Initialization |
| Lead Agent | (orchestrator) |
| support_agents    | — |
| Execution | ALWAYS |
| Mode | Auto-proceed (no approval gate) |

### Steps
1. Create `aidlc-docs/` directory if needed
2. Load knowledge README template
3. Create knowledge directories with agent-specific READMEs
4. Create stage artifact directories for all 5 phases
5. Create `aidlc-docs/audit.md` header + emit `WORKFLOW_STARTED`
6. Append `STAGE_STARTED` + `WORKSPACE_SCAFFOLDED` + `STAGE_COMPLETED` events

### Inputs
- None (entry point)
- Knowledge README template from `.claude/knowledge/aidlc-shared/`

### Outputs
- `aidlc-docs/knowledge/` tree with per-agent READMEs
- `aidlc-docs/initialization/`, `ideation/`, `inception/`, `construction/`, `operation/` with stage subdirectories
- `aidlc-docs/verification/`
- `aidlc-docs/audit.md` (header + session + scaffold events)

### Notes
- Idempotent — skips directories and files that already exist
- Runs inside `aidlc-utility init`, not via LLM

---

## Stage 0.2 — Workspace Detection

| Field | Value |
|-------|-------|
| Stage # | 0.2 |
| Slug | workspace-detection |
| Phase | Initialization |
| Lead Agent | (orchestrator — deterministic rule-based scanner) |
| support_agents    | — |
| Execution | ALWAYS |
| Mode | Auto-proceed (no approval gate) |

### Steps
1. Walk the project directory one level deep, plus known source directories (`src/`, `app/`, `lib/`, `pages/`, `components/`, `tests/`) if present
2. Count files by extension to determine primary/secondary languages
3. Detect frameworks via known config filenames (Next.js, Vite, Angular, Nuxt, Remix, Gatsby, Astro, Svelte, NestJS) and React via `package.json` dependencies
4. Detect build system via manifest + lockfile (npm/yarn/pnpm/bun/poetry/uv/hatch/pip/cargo/go/maven/gradle/composer/bundler)
5. Classify greenfield vs brownfield using the rules in `stages/initialization/workspace-detection.md`
6. Append `STAGE_STARTED` + `WORKSPACE_SCANNED` + `STAGE_COMPLETED` events

### Inputs
- Project filesystem (read-only scan)

### Outputs
- Workspace classification (greenfield/brownfield)
- Technology stack (languages, frameworks, build system)
- `WORKSPACE_SCANNED` audit event capturing the scan result

### Notes
- Runs as a deterministic scanner inside `aidlc-utility init`. No LLM subagent dispatch.
- Symbolic links are not followed (cycle protection via `lstatSync`)
- Excludes `.claude/`, `aidlc-docs/`, `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `target/`, `vendor/`
- `package.json` with only `devDependencies` is treated as tooling/scaffolding and does not alone cause brownfield classification

---

## Stage 0.3 — State Initialization

| Field | Value |
|-------|-------|
| Stage # | 0.3 |
| Slug | state-init |
| Phase | Initialization |
| Lead Agent | (orchestrator) |
| support_agents    | — |
| Execution | ALWAYS |
| Mode | Auto-proceed (no approval gate) |

### Steps
1. Read state template
2. Apply scope mapping + depth + test strategy
3. For greenfield, mark `reverse-engineering` SKIP
4. Write full `aidlc-docs/aidlc-state.md` with the first post-init stage set to `[-]`
5. Append `STAGE_STARTED` + `WORKSPACE_INITIALISED` + `STAGE_COMPLETED` events

### Inputs
- Workspace classification from workspace-detection (same tool call)
- Scope configuration (from `--scope` flag or `poc` default)
- Depth / test-strategy overrides if passed
- State template from `.claude/knowledge/aidlc-shared/state-template.md`

### Outputs
- `aidlc-docs/aidlc-state.md` (fully populated)
- `WORKSPACE_INITIALISED` audit event

### Notes
- Brownfield projects route to reverse-engineering (Stage 2.1)
- Greenfield projects route to the first non-initialization stage (intent-capture for feature/poc; requirements-analysis for bugfix/refactor; practices-discovery for workshop, since workshop skips all of Ideation and reverse-engineering is downgraded to SKIP on greenfield)
- When invoked from `/aidlc --init`, the orchestrator stops after this stage
- When invoked from workflow start (`/aidlc <scope>`), the orchestrator continues into the first post-init stage

---

## `--force` re-initialization

`/aidlc --init --force` rewrites `aidlc-state.md` in-place. The existing `audit.md` is preserved; the init-sequence events (`WORKFLOW_STARTED`, `WORKSPACE_SCAFFOLDED`, etc.) are re-emitted to the same audit log. If any non-init artifacts exist under `aidlc-docs/ideation/`, `inception/`, `construction/`, `operation/`, or `verification/`, the tool prints a warning listing them — they're preserved on disk, not removed.

Without `--force`, re-running `/aidlc --init` on a project that already has `aidlc-state.md` exits non-zero with a helpful message.

## Notes

- All 3 stages auto-proceed — no approval gates in the Initialization phase
- All stages update the statusline via `Current Stage` in `aidlc-state.md`
- All stages update state checkboxes (`[ ]` → `[x]`) and append audit events directly from the tool
- The Initialization → Ideation phase transition has no governance boundary check

## Cross-References

- [Architecture](../01-architecture.md) — execution model overview
- [Orchestrator](../03-orchestrator.md) — routing logic
- [Stage Protocol](../04-stage-protocol.md) — state tracking rules
- [Ideation Stages](ideation.md) — next phase
