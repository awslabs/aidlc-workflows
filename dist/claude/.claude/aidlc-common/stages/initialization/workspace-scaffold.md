---
slug: workspace-scaffold
phase: initialization
execution: ALWAYS
condition: Ensure-exists the per-intent record and in-scope phase dirs, idempotent (creates on demand, skips existing)
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
outputs: the per-intent record tree (one dir per in-scope phase + verification dir) and the space-level knowledge/ dir
---

# Workspace Scaffold

Runs deterministically inside `aidlc-utility intent-create`. The workspace shell ships in `dist/` (the SEED); creation only ensure-exists the per-intent record and its in-scope phase dirs (creates them on demand, idempotent). Kept as reference for audit event semantics.

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
knowledge ships separately and read-only under `.claude/knowledge/`.)

### Step 3: Ensure Phase Artifact Directories

Ensure-exists the empty per-intent phase artifact directories under the active
intent's record dir `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (no READMEs),
idempotent (created on demand):

- one directory per phase the SCOPE RUNS: `<record>/initialization/`, and each of
  `ideation/`, `inception/`, `construction/`, `operation/` that holds at least one
  EXECUTE stage under the active scope
- `<record>/verification/` (scope-independent)

A phase the scope excludes entirely gets NO directory. An empty `operation/` in a
bugfix record would read as work that was planned and skipped, when that phase was
never in the plan; the phases that appear are exactly the phases the workflow will
run, and the audit trail's `PHASE_SKIPPED` events name the rest.

Per-STAGE directories are NOT created here. A stage's directory
(`<record>/<phase>/<slug>/`) appears when that stage first writes an artifact, so
the record only ever shows stages that produced something. This is also why
`reverse-engineering/` never appears up front: that stage writes its 9
deliverables to the space-level per-repo store `aidlc/spaces/<space>/codekb/<repo>/`
(one shared view per repo, rewritten by each brownfield rerun), not into the intent
record, and only its own `memory.md` diary lands at
`<record>/inception/reverse-engineering/` when the stage runs. See the stage file
for the write paths.

### Step 4: Display Confirmation

Confirm in one plain line that the workspace is ready and name the single
directory the user's work will live in. Do not print the directory tree: the
folder layout is framework housekeeping, not something they need to read.

### Step 5: Update State and Audit

1. Mark workspace-scaffold as `[x]` completed in `<record>/aidlc-state.md`
2. Append WORKSPACE_SCAFFOLDED event to `<record>/audit/<host>-<clone>.md`

### Step 6: Auto-Proceed

This stage has NO approval gate — it auto-proceeds to the next stage (workspace-detection).

## Sensors

This stage runs deterministic setup logic inside `aidlc-utility intent-create` —
it ensure-exists the per-intent record and its in-scope phase dirs and emits state events. No
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
