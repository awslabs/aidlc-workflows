# Initialization Phase Stages (0.1-0.3)

## Phase Overview

The Initialization phase is the first of five phases in the AI-DLC workflow. It runs stages 0.1 through 0.3, **creating the intent**, minting its record dir at `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (written `<record>/` below) with state files, one directory per in-scope phase, workspace classification, and routing configuration. There is no separate scaffold command: the workspace shell ships pre-built in the installed or versioned `runtime/<harness>/` projection, and the engine creates the intent once the person describes what to build and picks the plan it proposes, or names a scope with a description (`/aidlc --scope <name> "<description>"` or `/aidlc <name> "<description>"`). A bare `/aidlc` in a project with no work says so and names both ways to start.

All 3 stages in this phase execute for EVERY scope — there are no conditional stages. All stages auto-proceed with no approval gates.

On Claude Code the welcome message is rendered at session start via the `companyAnnouncements` entry in `.claude/settings.json`; the other harnesses ship none. It is not a stage: no stage file, no audit event, no checkbox.

All three stages run inside one deterministic call, the creation command the engine names when the work starts, and it finishes in well under a second. On a native install, in an empty project:

```text
$ aidlc engine intent create --scope feature --arguments "A notes app where I can tag notes and search them" --label "tagged notes"
Intent created: 261013-tagged-notes (space: default)
State initialized: feature scope, 32 stages, Standard depth
Project type: Greenfield
Languages: Unknown
Frameworks: Unknown
Build System: Unknown
First post-init stage: intent-capture (IDEATION)
```

The record dir name is the creation date and the label (`<YYMMDD>-<label>`); the full description is kept in `<record>/project-description.json`.

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
| classic | All 0.1-0.3 |
| workshop | All 0.1-0.3 |
| express | All 0.1-0.3 |

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
2. Create an artifact directory for each phase the scope runs, plus `<record>/verification/`
3. Create the empty space-level `aidlc/spaces/<space>/knowledge/` directory (free-form; no per-agent subdirs, no READMEs) and the empty CodeKB parent `aidlc/spaces/<space>/codekb/` (a repo's folder in it appears when Reverse Engineering writes it)
4. Create the intent's `audit/` shard and record `WORKFLOW_STARTED` and `PHASE_STARTED` for initialization
5. Record `STAGE_STARTED`, `WORKSPACE_SCAFFOLDED` and `STAGE_COMPLETED`

### Inputs
- None (entry point)

### Outputs
- one artifact directory per phase the scope runs: `<record>/initialization/`, plus each of `ideation/`, `inception/`, `construction/`, `operation/` holding at least one EXECUTE stage. A phase the scope excludes gets no directory (a bugfix record has no `ideation/`), and per-stage subdirectories are not created here: a stage's directory appears when it first writes an artifact
- `<record>/verification/` (created for every scope)
- the empty space-level `aidlc/spaces/<space>/knowledge/` directory and `aidlc/spaces/<space>/codekb/` parent (siblings of the space's `intents/`)
- the intent's `audit/` shard (its header, the workflow and phase start rows, and the scaffold rows)

### Notes
- Idempotent — skips directories and files that already exist
- Runs inside `aidlc-utility intent-create`, not via LLM

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
1. Count the source files directly in the project folder and, down to six levels, in the known source folders (`src/`, `app/`, `lib/`, `pages/`, `components/`, `tests/`), and read the manifest and framework signals at the top. When nothing at the top marks existing code, look for a project in a container folder: walk folders up to three levels down with the same signals, stopping a branch at the first folder that has code, and skip hidden folders, the excluded folders below, the known source folders, and folders named like samples or docs (`doc`/`docs`, `example`/`examples`, `sample`/`samples`, `demo`/`demos`, `reference`, `testdata`, `fixtures`, `templates`, `scripts`, `aidlc`). A project in `apps/wordbook/` is found this way instead of being classified greenfield
2. Count files by extension to determine primary/secondary languages, never counting a file AI-DLC wrote whole into the project (such as Cursor's root `install.ts`): each installed harness lists those in `<harness directory>/tools/data/aidlc-projection.json`
3. Detect frameworks via known config filenames (Next.js, Vite, Angular, Nuxt, Remix, Gatsby, Astro, Svelte, NestJS), React via `package.json` dependencies, Django via `manage.py`, Rails via a `Gemfile` that names it, and Spring Boot via a `pom.xml` that names it
4. Detect build system via manifest + lockfile (npm/yarn/pnpm/bun/poetry/uv/hatch/python/setuptools/pip/cargo/go/maven/gradle/composer/bundler)
5. Read `.gitmodules` (if present) for declared submodule paths, probing each for initialization
6. Classify greenfield vs brownfield using the rules in `stages/initialization/workspace-detection.md`
7. Append `STAGE_STARTED` + `WORKSPACE_SCANNED` + `STAGE_COMPLETED` events

### Inputs
- Project filesystem (read-only scan)

### Outputs
- Workspace classification (greenfield/brownfield)
- Technology stack (languages, frameworks, build system)
- `WORKSPACE_SCANNED` audit event capturing the scan result. For a project whose code sits in `apps/wordbook/` under the project folder:

```text
## Workspace Scanned
**Timestamp**: 2026-10-13T12:59:58Z
**Event**: WORKSPACE_SCANNED
**Project Type**: Brownfield
**Languages**: TypeScript
**Frameworks**: React
**Build System**: npm (package.json)
**Nested Root**: apps/wordbook
**Details**: Deterministic rule-based scan
```

### Notes
- Runs as a deterministic scanner inside `aidlc-utility intent-create`. No LLM subagent dispatch.
- Symbolic links are not followed (cycle protection via `lstatSync`)
- Never counts files in `.claude/`, `.kiro/`, `.codex/`, `.opencode/`, `.aidlc/`, `.cursor/`, `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `target/` or `vendor/`; the `aidlc/` tree is not counted either (the top-level count reads only the project folder's own files, and the container walk skips `aidlc/`)
- `package.json` with only `devDependencies` is treated as tooling/scaffolding and does not alone cause brownfield classification
- A parseable `.gitmodules` with at least one submodule path entry is a brownfield signal (repo metadata declares code even when the submodule dirs are uninitialized). When submodule paths are uninitialized, the scan warns and names `git submodule update --init --recursive` - surfaced in the `WORKSPACE_SCANNED` event (`Submodules` field + `Details` remedy) and on creation stdout so the conductor can relay it; languages stay as scanned
- The person's word wins over the scan: `intent-create --project-type <greenfield|brownfield>` sets `Project Type` and writes `Project Type Source: you` (otherwise `workspace scan`). Later, `workspace reclassify --project-type <t>` rescans and records the type as theirs, and `next` asks once when work the scan set up as greenfield gains code before Construction (see `/aidlc --project-type` in the [CLI guide](../../guide/12-cli-commands.md)); never at a home whose teams were chosen (`Home Location`), where the code is what the teams' Units merged, nor in a Unit's build (`Project Type Source: the home`)

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
1. Build the state file (its fields are documented in `.claude/knowledge/aidlc-shared/state-template.md`; the tool writes it from code)
2. Apply scope mapping + depth + test strategy
3. For greenfield, mark `reverse-engineering` SKIP
4. Write full `<record>/aidlc-state.md` with the first post-init stage set to `[-]`
5. Record `STAGE_STARTED`, `WORKSPACE_INITIALISED` and `STAGE_COMPLETED`, then the hand-off to the first phase the plan runs: `PHASE_COMPLETED`, `PHASE_VERIFIED` and `PHASE_STARTED`, and `STAGE_STARTED` for its first stage

### Inputs
- Workspace classification from workspace-detection (same tool call)
- Scope: the `--scope` the creation command carries (the plan the person picked); run by hand without one, `AWS_AIDLC_DEFAULT_SCOPE` from the environment or the AI-DLC settings, else `classic`
- Depth / test-strategy overrides if passed
- Compiled `tools/data/stage-graph.json` and `tools/data/scope-grid.json`

### Outputs
- `<record>/aidlc-state.md` (fully populated)
- `WORKSPACE_INITIALISED` audit event

### Notes
- The first stage after initialization is the first stage, in stage order, that the plan runs, with reverse-engineering set to SKIP on greenfield. A scope that runs Ideation starts at intent-capture on existing code too, and reverse-engineering runs later, in Inception. For the shipped scopes:

| Scope | Greenfield starts at | Brownfield starts at |
|-------|----------------------|----------------------|
| enterprise, feature, mvp, poc | intent-capture | intent-capture |
| bugfix, express, refactor, security-patch | requirements-analysis | reverse-engineering |
| classic, workshop | practices-discovery | reverse-engineering |
| infra | practices-discovery | practices-discovery |

For a bugfix in a folder that already holds an npm project:

```text
$ aidlc engine intent create --scope bugfix --arguments "Prices with an odd number of cents round the wrong way" --label "price rounding"
Intent created: 261013-price-rounding (space: default)
State initialized: bugfix scope, 9 stages, Minimal depth
Project type: Brownfield
Languages: TypeScript
Frameworks: Unknown
Build System: npm (package.json)
First post-init stage: reverse-engineering (INCEPTION)
```

- When invoked from `/aidlc-init --scope <name> <description>` (the explicit creation packaging), the orchestrator stops after this stage; `/aidlc-init --scope <name>` alone asks what the work is for first; `/aidlc-init` with only a description shows the plan offer first and then continues as `/aidlc` does
- When creation comes from `/aidlc` (a description of the work and the plan the person picked, or a named scope with a description), the conductor runs `next` again after it and carries on into the first post-init stage in the same chat

---

## Re-initialization

There is no re-init flag. Creation runs once per intent; the workspace shell
itself ships pre-built and is never re-scaffolded. A second `/aidlc` over an
existing intent resumes it rather than re-initialising. To start over, set the
work aside with `/aidlc intent archive <name>` and describe the new work with
`/aidlc "<what to build>"`; the new work gets its own `<record>/`. Archiving
keeps the old record and its audit trail on disk (the arrow in the first line
is shown here as `->`):

```text
$ aidlc engine intent archive tagged-notes --reason "starting over with a smaller first step"
Archived intent -> 261013-tagged-notes (space: default). Its record and audit trail stay on disk; /aidlc intent list --all shows it and /aidlc intent unarchive 261013-tagged-notes brings it back.
$ aidlc engine intent list --all
Intents in space "default":
  261013-tagged-notes  [archived]

(no active intent - switch with /aidlc intent <name>)
```

## Notes

- All 3 stages auto-proceed — no approval gates in the Initialization phase
- The creation tool writes `Current Stage`, the state checkboxes and the audit
  rows itself, in the same call
- Conductors never edit initialization lifecycle state directly
- The hand-off from Initialization to the first phase the plan runs has no
  governance boundary check: creation writes its `PHASE_COMPLETED`,
  `PHASE_VERIFIED` and `PHASE_STARTED` rows with no check behind them

## Cross-References

- [Architecture](../01-architecture.md) — execution model overview
- [Orchestrator](../03-orchestrator.md) — routing logic
- [Stage Protocol](../04-stage-protocol.md) — state tracking rules
- [Ideation Stages](ideation.md) — next phase
