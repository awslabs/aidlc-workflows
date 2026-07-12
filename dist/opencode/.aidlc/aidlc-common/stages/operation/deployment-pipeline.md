---
slug: deployment-pipeline
phase: operation
execution: CONDITIONAL
condition: Execute when CD pipeline needs creation or significant modification
lead_agent: aidlc-pipeline-deploy-agent
support_agents: []
mode: inline
produces:
  - cd-config
  - deployment-strategy
  - rollback-runbook
  - deployment-pipeline-questions
consumes:
  - artifact: ci-config
    required: true
  - artifact: quality-gates
    required: true
  - artifact: deployment-architecture
    required: true
  - artifact: cicd-pipeline
    required: true
requires_stage:
  - ci-pipeline
  - infrastructure-design
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - infra
  - security-patch
  - workshop
inputs: CI pipeline config from ci-pipeline stage, infrastructure design from infrastructure-design stage
outputs: cd-config.md, deployment-strategy.md, rollback-runbook.md, deployment-pipeline-questions.md (under this stage's record dir, engine-resolved)
---

# Deployment Pipeline Configuration

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-pipeline-deploy-agent persona from `agents/aidlc-pipeline-deploy-agent.md` and knowledge from `.aidlc/knowledge/aidlc-pipeline-deploy-agent/`.

### Step 2: Load Prior Context

- Read CI pipeline config from `<record>/construction/ci-pipeline/` (if exists)
- Read infrastructure design from `<record>/construction/infrastructure-design/` (if exists)
- Read NFR design (deployment-related NFRs) from `<record>/construction/nfr-design/` (if exists)

Incremental scopes (security-patch) skip ci-pipeline and infrastructure-design by design; a brownfield production system already has CI and deployment infrastructure. When those inputs are absent, inspect the workspace's existing pipeline and infrastructure configuration (and the code knowledge base on brownfield) and design the CD path against what is actually deployed — never invent the content of a missing artifact.

### Step 3: Generate Clarifying Questions

Create questions file covering:
- What deployment strategy (blue/green, canary, rolling)?
- What environment promotion gates (dev → staging → prod)?
- What approval workflows for production?
- What rollback procedure?
- What feature flag strategy (CloudWatch Evidently, AppConfig)?

Follow stage-protocol.md question flow.

### Step 4: Generate Artifacts

Create CD pipeline configuration, deployment strategy document, rollback runbook, feature flag configuration, and environment promotion matrix.

### Step 5: Update State

Mark deployment-pipeline as `[x]` completed in `<record>/aidlc-state.md`.

### Step 6: Present Completion & Request Approval

Completion emoji: :rocket:
Review path: `<record>/operation/deployment-pipeline/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/deployment-pipeline/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `ci-config`, `quality-gates`, `deployment-architecture`, `cicd-pipeline`).

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

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → `.aidlc/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.aidlc/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.aidlc/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
