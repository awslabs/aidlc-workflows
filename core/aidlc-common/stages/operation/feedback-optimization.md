---
slug: feedback-optimization
name: Feedback & Optimization
phase: operation
execution: CONDITIONAL
condition: Execute when ongoing operational monitoring and optimization are needed
lead_agent: aidlc-operations-agent
support_agents:
  - aidlc-aws-platform-agent
mode: inline
summary_confirmation: required
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

## Steps

### Step 1: Load Prior Context

- Read observability setup from `<record>/operation/observability-setup/`
- Read performance validation results from `<record>/operation/performance-validation/`
- Read SLO/SLI configuration
- Read infrastructure design for drift comparison

### Step 2: Generate Questions

Create questions file covering:
- Are SLOs being met? What is the error budget burn rate?
- Are there cost optimization opportunities?
- Is there configuration or infrastructure drift?
- What user behavior patterns suggest new features or issues?
- What operational toil can be automated?

Follow stage-protocol.md question flow.

### Step 3: Generate Artifacts

Create SLO compliance report, AWS Cost Explorer analysis & optimization recommendations, AWS Config drift detection report, Trusted Advisor recommendations review, operational insights & improvement proposals, and feedback loop document (inputs to next Ideation cycle).

### Step 4: Completion Handoff

Hand completion to `stage-protocol.md` via
`{{INVOKE}} engine orchestrate report --stage feedback-optimization --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 5: Present Completion & Request Approval

Completion emoji: :recycle:
Review path: `<record>/operation/feedback-optimization/`
Approval gate: Approve (workflow complete) / Request Changes / Start New Ideation Cycle.

This is the final stage. Upon approval, the full AI-DLC workflow is complete. The feedback loop document feeds insights back into the next Ideation cycle if the user chooses to continue iterating.

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/feedback-optimization/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `dashboards`, `alarms`, `slo-config`, `deployment-log`, `load-test-results`, `incident-plan`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
