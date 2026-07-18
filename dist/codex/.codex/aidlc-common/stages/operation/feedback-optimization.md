---
slug: feedback-optimization
phase: operation
execution: CONDITIONAL
condition: Execute when ongoing operational monitoring and optimization are needed
lead_agent: aidlc-operations-agent
support_agents:
  - aidlc-aws-platform-agent
mode: inline
produces:
  - slo-report
  - cost-analysis
  - drift-report
  - feedback-loop
  - feedback-optimization-questions
consumes:
  - artifact: dashboards
    required: true
  - artifact: alarms
    required: true
  - artifact: slo-config
    required: true
  - artifact: deployment-log
    required: true
  - artifact: load-test-results
    required: false
  - artifact: incident-plan
    required: false
requires_stage:
  - observability-setup
  - deployment-execution
  - incident-response
  - performance-validation
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - workshop
inputs: All Operation phase artifacts, production monitoring data
outputs: slo-report.md, cost-analysis.md, drift-report.md, feedback-loop.md, feedback-optimization-questions.md (under this stage's record dir, engine-resolved)
---

# Continuous Feedback & Optimization

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-operations-agent persona from `agents/aidlc-operations-agent.md` and knowledge from `.codex/knowledge/aidlc-operations-agent/`.

### Step 2: Load Prior Context

- Read observability setup from `<record>/operation/observability-setup/`
- Read performance validation results from `<record>/operation/performance-validation/`
- Read SLO/SLI configuration
- Read infrastructure design for drift comparison

### Step 3: Generate Questions

Create questions file covering:
- Are SLOs being met? What is the error budget burn rate?
- Are there cost optimization opportunities?
- Is there configuration or infrastructure drift?
- What user behavior patterns suggest new features or issues?
- What operational toil can be automated?

Follow stage-protocol.md question flow.

### Step 4: Generate Artifacts

Create SLO compliance report, AWS Cost Explorer analysis & optimization recommendations, AWS Config drift detection report, Trusted Advisor recommendations review, operational insights & improvement proposals, and feedback loop document (inputs to next Ideation cycle).

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .codex/tools/aidlc-orchestrate.ts report --stage feedback-optimization --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 6: Present Completion & Request Approval

Completion emoji: :recycle:
Review path: `<record>/operation/feedback-optimization/`
Approval gate: Approve (workflow complete) / Request Changes / Start New Ideation Cycle.

This is the final stage. Upon approval, the full AI-DLC workflow is complete. The feedback loop document feeds insights back into the next Ideation cycle if the user chooses to continue iterating.

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/feedback-optimization/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `dashboards`, `alarms`, `slo-config`, `deployment-log`, `load-test-results`, `incident-plan`).

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

- Prescriptive rule → a practice line under the routed heading in
  `aidlc/spaces/<active-space>/memory/project.md` (default) or `team.md` (promoted)
- Verification check → new manifest at `.codex/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
