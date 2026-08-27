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
  - classic
  - workshop
  - express
inputs: none (first stage after session start)
outputs: the per-intent record tree (one dir per in-scope phase + verification dir) and the space-level knowledge/ dir
---

# Workspace Scaffold

Runs deterministically inside `aidlc-utility intent-create`. The workspace shell ships in `dist/` (the SEED); intent creation only ensures the per-intent record and its in-scope phase dirs exist (created on demand, idempotently). Kept as reference for audit event semantics.

## Steps

### Step 1: Update State

1. Update `<record>/aidlc-state.md`: set `Current Stage` to `scaffolding workspace`
2. Mark workspace-scaffold as `[-]` in progress

### Step 2: Ensure the Space Shared Directories

Ensure-exists the empty space-level CodeKB parent
`aidlc/spaces/<space>/codekb/`. This makes the shared store safe to inspect
before Reverse Engineering runs. Repository directories remain lazy:
`codekb/<repo>/` appears only when Reverse Engineering writes that repo's
artifacts.

Ensure-exists the space-level domain-knowledge directory
`aidlc/spaces/<space>/knowledge/` (shorthand `aidlc/knowledge/`). It is
**free-form and empty at bootstrap** — no fixed file set, no per-agent
subdirectories, no seeded READMEs. A team adds its own markdown here over time;
the directory is a sibling of `memory/`, `codekb/`, and `intents/`, so domain
knowledge accumulates across every intent in the space rather than being trapped
in one intent's record. The agent personas read team knowledge from
`aidlc/knowledge/aidlc-shared/` and `aidlc/knowledge/<agent>/` if those exist.
The team creates them; the intent-creation step does not. (The engine's per-agent METHODOLOGY
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

Imports: none.

A customised setup report should import the relevant manifests here.

## Learn

Follow stage-protocol.md §13 by maintaining
`<record>/<phase>/<stage>/memory.md` under the four standard headings; the
memory file stays in the artefact directory and the stage file remains
immutable. This auto-proceeding bootstrap stage (`gate: false`) has no
approval gate, so skip surfacing and persisting learnings and the mandatory
"Anything to add for next time?" question; the gate-bound ritual begins with
the first post-initialization stage.
