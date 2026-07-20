# Initialization Phase Stages (0.1-0.3)

## Phase Overview

The Initialization phase is the first of five phases in the AI-DLC workflow. It runs stages 0.1 through 0.3, **birthing the intent** — minting its record dir at `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (written `<record>/` below) with state files, directory scaffolding, workspace classification, and routing configuration. There is no separate scaffold command: the workspace shell ships pre-built in `dist/<harness>/`, and the engine auto-births the first intent on the first `/aidlc` (or when you describe what to build).

All 3 stages in this phase execute for EVERY scope — there are no conditional stages. All stages auto-proceed with no approval gates.

The welcome message is rendered at session start via the `companyAnnouncements` entry in `settings.json`. It is not a stage — no stage file, no audit event, no checkbox.

All three stages run inside a single deterministic `bun .claude/tools/aidlc-utility.ts intent-birth --scope <scope>` call that completes in well under a second. The conductor creates 3 tasks in the sidebar (Workspace Scaffold, Workspace Detection, State Init) for observability, then marks them all completed once the tool returns.

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
1. Create `<record>/` directory if needed
2. Create stage artifact directories for all 5 phases + `<record>/verification/`
3. Create the empty space-level `aidlc/knowledge/` directory (free-form; no per-agent subdirs, no READMEs)
4. Create the intent's `audit/` shard dir header + emit `WORKFLOW_STARTED`
5. Append `STAGE_STARTED` + `WORKSPACE_SCAFFOLDED` + `STAGE_COMPLETED` events

### Inputs
- None (entry point)

### Outputs
- `<record>/initialization/`, `ideation/`, `inception/`, `construction/`, `operation/` with stage subdirectories
- `<record>/verification/`
- the empty space-level `aidlc/knowledge/` directory (a sibling of the space's `intents/`)
- the intent's `audit/` shard dir (header + session + scaffold events)

### Notes
- Idempotent — skips directories and files that already exist
- Runs inside `aidlc-utility intent-birth`, not via LLM

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
1. Walk the project directory one level deep, plus known source directories (`src/`, `app/`, `lib/`, `pages/`, `components/`, `tests/`) if present. When no top-level signal fires, fall back to scanning one level into each arbitrarily-named subdirectory with the same signal set, so a project nested in a container folder (e.g. `wordbook/`) is detected instead of misclassified greenfield
2. Count files by extension to determine primary/secondary languages
3. Detect frameworks via known config filenames (Next.js, Vite, Angular, Nuxt, Remix, Gatsby, Astro, Svelte, NestJS) and React via `package.json` dependencies
4. Detect build system via manifest + lockfile (npm/yarn/pnpm/bun/poetry/uv/hatch/pip/cargo/go/maven/gradle/composer/bundler)
5. Read `.gitmodules` (if present) for declared submodule paths, probing each for initialization
6. Classify greenfield vs brownfield using the rules in `stages/initialization/workspace-detection.md`
7. Append `STAGE_STARTED` + `WORKSPACE_SCANNED` + `STAGE_COMPLETED` events

### Inputs
- Project filesystem (read-only scan)

### Outputs
- Workspace classification (greenfield/brownfield)
- Technology stack (languages, frameworks, build system)
- `WORKSPACE_SCANNED` audit event capturing the scan result

### Notes
- Runs as a deterministic scanner inside `aidlc-utility intent-birth`. No LLM subagent dispatch.
- Symbolic links are not followed (cycle protection via `lstatSync`)
- Excludes `.claude/`, `<record>/`, `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `target/`, `vendor/`
- `package.json` with only `devDependencies` is treated as tooling/scaffolding and does not alone cause brownfield classification
- A parseable `.gitmodules` with at least one submodule path entry is a brownfield signal (repo metadata declares code even when the submodule dirs are uninitialized). When submodule paths are uninitialized, the scan warns and names `git submodule update --init --recursive` - surfaced in the `WORKSPACE_SCANNED` event (`Submodules` field + `Details` remedy) and on birth stdout so the conductor can relay it; languages stay as scanned

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
1. Read state contract
2. Apply scope mapping + depth + test strategy
3. For greenfield, mark `reverse-engineering` SKIP
4. Write full `<record>/aidlc-state.md` with the first post-init stage set to `[-]`
5. Append `STAGE_STARTED` + `WORKSPACE_INITIALISED` + `STAGE_COMPLETED` events

### Inputs
- Workspace classification from workspace-detection (same tool call)
- Scope configuration (from `--scope` flag or `poc` default)
- Depth / test-strategy overrides if passed
- State contract from `.claude/knowledge/aidlc-shared/state-template.md`
- Compiled `tools/data/stage-graph.json` and `tools/data/scope-grid.json`

### Outputs
- `<record>/aidlc-state.md` (fully populated)
- `WORKSPACE_INITIALISED` audit event

### Notes
- Brownfield projects route to reverse-engineering (Stage 2.1)
- Greenfield projects route to the first non-initialization stage (intent-capture for feature/poc; requirements-analysis for bugfix/refactor; practices-discovery for workshop, since workshop skips all of Ideation and reverse-engineering is downgraded to SKIP on greenfield)
- When invoked from `/aidlc-init` (the explicit birth packaging), the orchestrator stops after this stage
- When invoked from workflow start (`/aidlc <scope>` or describing what to build), the orchestrator continues into the first post-init stage

---

## Re-initialization

There is no re-init flag. Birthing the first intent runs once per intent; the
workspace shell itself ships pre-built and is never re-scaffolded. To start over,
birth a new intent (each gets its own `<record>/`), or — for a clean slate —
archive the active intent's record dir under `aidlc/spaces/<space>/intents/` and
let the engine birth a fresh one. A second `/aidlc` over an existing intent
resumes it rather than re-initialising.

## Notes

- All 3 stages auto-proceed — no approval gates in the Initialization phase
- The deterministic initialization tool reports each completed stage; the
  engine updates `Current Stage`, state checkboxes, and audit events atomically
- Conductors never edit initialization lifecycle state directly
- The Initialization → Ideation phase transition has no governance boundary check

## Cross-References

- [Architecture](../01-architecture.md) — execution model overview
- [Orchestrator](../03-orchestrator.md) — routing logic
- [Stage Protocol](../04-stage-protocol.md) — state tracking rules
- [Ideation Stages](ideation.md) — next phase
