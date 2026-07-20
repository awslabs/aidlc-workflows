---
slug: workspace-scaffold
phase: initialization
execution: ALWAYS
condition: Ensure-exists the per-intent record and artifact dirs — idempotent (creates on demand, skips existing)
lead_agent: orchestrator
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage: []
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
inputs: none (first stage after session start)
outputs: the per-intent record tree (stage artifact dirs + verification dir) and the space-level knowledge/ dir
---

# Workspace Scaffold

Runs deterministically inside `aidlc-utility intent-birth`. The workspace shell ships in `dist/` (the SEED); birth only ensure-exists the per-intent record and artifact dirs (creates them on demand, idempotent). Kept as reference for audit event semantics.

MANDATORY: Follow stage-protocol.md for state tracking and audit logging.

## Steps

### Step 1: Update State

1. Update `<record>/aidlc-state.md`: set `Current Stage` to `scaffolding workspace`
2. Mark workspace-scaffold as `[-]` in progress

### Step 2: Ensure the Space Knowledge Directory

Ensure-exists the space-level domain-knowledge directory
`aidlc/spaces/<space>/knowledge/` (shorthand `aidlc/knowledge/`). It is
**free-form and empty at bootstrap** — no fixed file set, no per-agent
subdirectories, no seeded READMEs. A team adds its own markdown here over time;
the directory is a sibling of `memory/`, `codekb/`, and `intents/`, so domain
knowledge accumulates across every intent in the space rather than being trapped
in one intent's record. The agent personas read team knowledge from
`aidlc/knowledge/aidlc-shared/` and `aidlc/knowledge/<agent>/` if those exist —
the team creates them; birth does not. (The engine's per-agent METHODOLOGY
knowledge ships separately and read-only under `.aidlc/knowledge/`.)

### Step 3: Ensure Stage Artifact Directories

Ensure-exists the empty per-intent stage artifact directories under the active
intent's record dir `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (no READMEs) —
idempotent (created on demand):

- `<record>/initialization/` — workspace-scaffold/, workspace-detection/, state-init/
- `<record>/ideation/` — intent-capture/, market-research/, feasibility/, scope-definition/, team-formation/, rough-mockups/, approval-handoff/
- `<record>/inception/` — reverse-engineering/, requirements-analysis/, user-stories/, refined-mockups/, application-design/, units-generation/, delivery-planning/
- `<record>/construction/` — build-and-test/, ci-pipeline/
- `<record>/operation/` — deployment-pipeline/, environment-provisioning/, deployment-execution/, observability-setup/, incident-response/, performance-validation/, feedback-optimization/
- `<record>/verification/`

### Step 4: Display Confirmation

List the created directory structure for user awareness.

### Step 5: Update State and Audit

1. Mark workspace-scaffold as `[x]` completed in `<record>/aidlc-state.md`
2. Append WORKSPACE_SCAFFOLDED event to `<record>/audit/<host>-<clone>.md`

### Step 6: Auto-Proceed

This stage has NO approval gate — it auto-proceeds to the next stage (workspace-detection).

## Sensors

This stage runs deterministic setup logic inside `aidlc-utility intent-birth` —
it ensure-exists the per-intent record and artifact dirs and emits state events. No
agent-authored markdown lands here, so the frontmatter `sensors:` list
is empty.

If a fork later customises this stage to write markdown reports, import
the relevant manifests via `sensors:` in this file's frontmatter; the
resolver will populate `sensors_applicable` at the next compile.

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
