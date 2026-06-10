---
slug: workspace-scaffold
phase: initialization
execution: ALWAYS
condition: Scaffolds aidlc-docs/ directory tree — idempotent (skips existing dirs/files)
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
outputs: aidlc-docs/ directory tree (knowledge dirs, stage artifact dirs, verification dir)
---

# Workspace Scaffold

Runs deterministically inside `aidlc-utility init`. Kept as reference for audit event semantics.

MANDATORY: Follow stage-protocol.md for state tracking and audit logging.

## Steps

### Step 1: Update State

1. Update `aidlc-docs/aidlc-state.md`: set `Current Stage` to `scaffolding workspace`
2. Mark workspace-scaffold as `[-]` in progress

### Step 2: Load Knowledge README Template

Read the knowledge README template from `.claude/knowledge/aidlc-shared/knowledge-readme-template.md`.

### Step 3: Create Knowledge Directories with READMEs

Idempotent — skip any directories/files that already exist.

- `aidlc-docs/knowledge/README.md` — top-level README (use template content)
- `aidlc-docs/knowledge/aidlc-shared/README.md` — "Add files here that ALL agents should load — company standards, project context, domain glossary."
- Per-agent directories with READMEs: `aidlc-product-agent/`, `aidlc-design-agent/`, `aidlc-delivery-agent/`, `aidlc-architect-agent/`, `aidlc-developer-agent/`, `aidlc-quality-agent/`, `aidlc-devsecops-agent/`, `aidlc-aws-platform-agent/`, `aidlc-compliance-agent/`, `aidlc-pipeline-deploy-agent/`, `aidlc-operations-agent/`
- Each agent README follows this format:
  ```
  # [Agent Name] Knowledge

  Add markdown files here to customize [agent-name] behavior for your project.

  Examples of what to include:
  - [2-3 agent-specific examples from the template table]

  Files here are loaded at step 5 of the knowledge loading order, after built-in methodology.
  ```

### Step 4: Create Stage Artifact Directories

Create empty stage artifact directories (no READMEs) — idempotent:

- `aidlc-docs/initialization/` — workspace-scaffold/, workspace-detection/, state-init/
- `aidlc-docs/ideation/` — intent-capture/, market-research/, feasibility/, scope-definition/, team-formation/, rough-mockups/, approval-handoff/
- `aidlc-docs/inception/` — reverse-engineering/, requirements-analysis/, user-stories/, refined-mockups/, application-design/, units-generation/, delivery-planning/
- `aidlc-docs/construction/` — build-and-test/, ci-pipeline/
- `aidlc-docs/operation/` — deployment-pipeline/, environment-provisioning/, deployment-execution/, observability-setup/, incident-response/, performance-validation/, feedback-optimization/
- `aidlc-docs/verification/`

### Step 5: Display Confirmation

List the created directory structure for user awareness.

### Step 6: Update State and Audit

1. Mark workspace-scaffold as `[x]` completed in `aidlc-docs/aidlc-state.md`
2. Append WORKSPACE_SCAFFOLDED event to `aidlc-docs/audit.md`

### Step 7: Auto-Proceed

This stage has NO approval gate — it auto-proceeds to the next stage (workspace-detection).

## Sensors

This stage runs deterministic setup logic inside `aidlc-utility init` —
it scaffolds the `aidlc-docs/` directory tree and emits state events. No
agent-authored markdown lands here, so the frontmatter `sensors:` list
is empty.

If a fork later customises this stage to write markdown reports, import
the relevant manifests via `sensors:` in this file's frontmatter; the
resolver will populate `sensors_applicable` at the next compile.

## Learn

While running this stage, maintain a running log in
`aidlc-docs/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Before the approval gate, read memory.md and surface candidates via
`AskUserQuestion`. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → `.claude/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.claude/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.claude/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
