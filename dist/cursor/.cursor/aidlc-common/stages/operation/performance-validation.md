---
slug: performance-validation
phase: operation
execution: CONDITIONAL
condition: Execute when NFR performance targets need validation under load
lead_agent: aidlc-quality-agent
support_agents: []
mode: inline
summary_confirmation: required
produces:
  - load-test-plan
  - load-test-results
  - nfr-validation-matrix
  - performance-validation-questions
consumes:
  - artifact: performance-requirements
    required: true
  - artifact: scalability-requirements
    required: true
  - artifact: performance-design
    required: true
  - artifact: scalability-design
    required: true
  - artifact: dashboards
    required: true
requires_stage:
  - nfr-requirements
  - nfr-design
  - observability-setup
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - classic
  - workshop
inputs: NFR requirements from nfr-requirements stage, NFR design from nfr-design stage, deployed application, observability data from observability-setup stage
outputs: load-test-plan.md, test-results.md, nfr-validation-matrix.md, performance-validation-questions.md (under this stage's record dir, engine-resolved)
---

# Performance Validation & Load Testing

## Steps

### Step 1: Load Prior Context

- Read NFR requirements from `<record>/construction/nfr-requirements/`
- Read NFR design from `<record>/construction/nfr-design/`
- Read observability configuration from `<record>/operation/observability-setup/`

### Step 2: Generate Clarifying Questions

Create questions file covering:
- What are the expected traffic patterns (steady state, peak, burst)?
- What are the target latency percentiles (p50, p95, p99)?
- What throughput must the system sustain?
- Where are the likely bottlenecks?

Follow stage-protocol.md question flow.

### Step 3: Design and Execute Tests

Design load test plan, execute performance tests against production-like environments, analyze results using CloudWatch/X-Ray evidence.

### Step 4: Generate Artifacts

Create load test plan, performance test results (latency, throughput, error rates), bottleneck analysis, auto-scaling validation report, capacity planning recommendations, and NFR validation matrix (target vs. actual).

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .cursor/tools/aidlc-orchestrate.ts report --stage performance-validation --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :zap:
Review path: `<record>/operation/performance-validation/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/performance-validation/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `performance-requirements`, `scalability-requirements`, `performance-design`, `scalability-design`, `dashboards`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
