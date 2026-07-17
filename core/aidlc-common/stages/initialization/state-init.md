---
slug: state-init
phase: initialization
execution: ALWAYS
condition: Creates full populated state file and determines routing — auto-proceeds
lead_agent: orchestrator
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage:
  - workspace-detection
sensors: []
scopes:
  - enterprise
  - feature
  - mvp
  - poc
  - bugfix
  - refactor
  - infra
  - security-patch
  - workshop
inputs: workspace classification from workspace-detection, scope from orchestrator
outputs: <record>/aidlc-state.md (full populated version, engine-resolved)
---

# State Initialization

Runs deterministically inside `aidlc-utility init`. Kept as reference for state-file contract.

MANDATORY: Follow stage-protocol.md for state tracking and audit logging.

## Steps

### Step 1: Update State

1. Update `<record>/aidlc-state.md`: set `Current Stage` to `initializing state`
2. Mark state-init as `[-]` in progress

### Step 2: Create Full State File

Read the state contract from `{{HARNESS_DIR}}/knowledge/aidlc-shared/state-template.md`.
Overwrite `<record>/aidlc-state.md` with the full populated version generated
from the compiled stage graph and scope grid:
- Project description (from orchestrator's $ARGUMENTS or `<record>/audit/<host>-<clone>.md`)
- Project type (greenfield/brownfield from workspace-detection)
- Workspace state (languages, frameworks, build system from workspace-detection)
- Start date — run `date -u +'%Y-%m-%dT%H:%M:%SZ'` via Bash
- Scope configuration (stages to execute/skip per scope routing)
- Full stage progress checkboxes (all stages, with INITIALIZATION stages marked [x] for workspace-scaffold, workspace-detection)
- Mark state-init as `[-]` in progress
- Total Stages: count EXECUTE stages only (not SKIP). Authoritative counts come
  from the compiled scope grid (`{{HARNESS_DIR}}/tools/data/scope-grid.json`),
  transposed from each stage's `scopes:` frontmatter. Run
  `bun {{HARNESS_DIR}}/tools/aidlc-utility.ts scope-table` for the live scope
  counts and `bun {{HARNESS_DIR}}/tools/aidlc-utility.ts stage-table` for the
  live compiled stage list.
- Completed: set to number of completed INITIALIZATION stages (typically 3)
- In Progress: set to first post-initialization stage name
- Active Agent: set to lead agent of the first post-initialization stage (from Stage Graph)

### Step 3: Determine Routing

Based on project type:
- **Brownfield** → First post-initialization stage: reverse-engineering (Inception)
- **Greenfield** → First post-initialization stage: requirements-analysis (Inception), skip reverse-engineering

Update aidlc-state.md with the routing decision:
- Set `Stages to Execute` and `Stages to Skip` based on scope + project type
- Mark reverse-engineering as SKIP for greenfield projects

### Step 4: Finalize State

**If invoked from `--init`:**
- Set Lifecycle Phase to READY
- Set Current Stage to `workspace initialized — run /aidlc [scope] to start`
- Do NOT continue to the Ideation phase

**If invoked from workflow start:**
- Set Lifecycle Phase to the first post-initialization phase (IDEATION or INCEPTION depending on scope)
- Set Current Stage to the first post-initialization stage

### Step 5: Update State and Audit

1. Mark state-init as `[x]` completed in `<record>/aidlc-state.md`
2. Append WORKSPACE_INITIALISED event to `<record>/audit/<host>-<clone>.md` with project type and tech stack summary

### Step 6: Auto-Proceed

This stage has NO approval gate — it auto-proceeds to the first post-initialization stage (or stops if invoked from --init).

## Sensors

This stage writes `<record>/aidlc-state.md` deterministically through
`aidlc-state.ts`. The state file is a structured manifest, not the kind
of free-form artefact the markdown-shape sensors target — so the
frontmatter `sensors:` list is empty.

A future check that validates state-file shape (heading set, required
fields) would land as its own manifest, imported here via `sensors:`.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

This is an auto-proceeding bootstrap stage (`gate: false`), so it has no
approval gate. Keep `memory.md` as the stage's permanent execution record, but
do not surface or persist §13 learnings and do not ask the mandatory
"Anything to add for next time?" question here. The gate-bound learnings ritual
begins with the first post-initialization stage.
