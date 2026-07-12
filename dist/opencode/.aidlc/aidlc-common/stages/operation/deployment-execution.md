---
slug: deployment-execution
phase: operation
execution: CONDITIONAL
condition: Execute after deployment pipeline and environment are ready
lead_agent: aidlc-pipeline-deploy-agent
support_agents:
  - aidlc-developer-agent
mode: inline
produces:
  - deployment-log
  - smoke-test-results
  - health-check-report
  - deployment-execution-questions
consumes:
  - artifact: cd-config
    required: true
  - artifact: deployment-strategy
    required: true
  - artifact: environment-inventory
    required: true
  - artifact: build-test-results
    required: true
requires_stage:
  - deployment-pipeline
  - environment-provisioning
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - infra
  - security-patch
  - workshop
inputs: CD pipeline config from deployment-pipeline stage, provisioned environments from environment-provisioning stage, built artifacts from Construction
outputs: deployment-log.md, smoke-test-results.md, health-check-report.md, deployment-execution-questions.md (under this stage's record dir, engine-resolved)
---

# Deployment Execution

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-pipeline-deploy-agent persona from `agents/aidlc-pipeline-deploy-agent.md` and knowledge from `.aidlc/knowledge/aidlc-pipeline-deploy-agent/`.

### Step 2: Load Prior Context

- Read CD pipeline config and deployment strategy from `<record>/operation/deployment-pipeline/` (if they exist)
- Read environment inventory from `<record>/operation/environment-provisioning/` (if exists)
- Read build/test results from `<record>/construction/build-and-test/` (if exists)
- Read rollback runbook (if exists)

Incremental scopes (security-patch, infra) skip environment-provisioning or build-and-test by design; a brownfield production system already has environments and a deploy path. When those inputs are absent, inventory the actual environments from the workspace's existing configuration and deploy through the pipeline that exists — never invent the content of a missing artifact.

### Step 3: Pre-Deployment Checks

Create questions file covering:
- Are all pre-deployment checks passing?
- Are database migrations required and tested?
- Are dependent services available and healthy?
- What is the deployment window?

Follow stage-protocol.md question flow.

### Step 4: Execute Deployment

Push artifacts through the pipeline. Run smoke tests. Validate health checks. Execute database migrations if needed: delegate to Task tool with subagent_type="aidlc-developer-agent" for migration execution.

### Step 5: Generate Artifacts

Create deployment execution log, smoke test results, health check validation report, and database migration log (if applicable).

### Step 6: Update State

Mark deployment-execution as `[x]` completed in `<record>/aidlc-state.md`.

### Step 7: Present Completion & Request Approval

Completion emoji: :package:
Review path: `<record>/operation/deployment-execution/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/deployment-execution/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `cd-config`, `deployment-strategy`, `environment-inventory`, `build-test-results`).

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
