---
slug: performance-validation
phase: operation
execution: CONDITIONAL
condition: Execute when NFR performance targets need validation under load
lead_agent: aidlc-quality-agent
support_agents: []
mode: inline
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
  - workshop
inputs: NFR requirements from nfr-requirements stage, NFR design from nfr-design stage, deployed application, observability data from observability-setup stage
outputs: load-test-plan.md, test-results.md, nfr-validation-matrix.md, performance-validation-questions.md (under this stage's record dir, engine-resolved)
---

# Performance Validation & Load Testing

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-quality-agent persona from `agents/aidlc-quality-agent.md` and knowledge from `.codex/knowledge/aidlc-quality-agent/`.

### Step 2: Load Prior Context

- Read NFR requirements from `<record>/construction/nfr-requirements/`
- Read NFR design from `<record>/construction/nfr-design/`
- Read observability configuration from `<record>/operation/observability-setup/`

### Step 3: Generate Clarifying Questions

Create questions file covering:
- What are the expected traffic patterns (steady state, peak, burst)?
- What are the target latency percentiles (p50, p95, p99)?
- What throughput must the system sustain?
- Where are the likely bottlenecks?

Follow stage-protocol.md question flow.

### Step 4: Design and Execute Tests

Design load test plan, execute performance tests against production-like environments, analyze results using CloudWatch/X-Ray evidence.

### Step 5: Generate Artifacts

Create load test plan, performance test results (latency, throughput, error rates), bottleneck analysis, auto-scaling validation report, capacity planning recommendations, and NFR validation matrix (target vs. actual).

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .codex/tools/aidlc-orchestrate.ts report --stage performance-validation --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 7: Present Completion & Request Approval

Completion emoji: :zap:
Review path: `<record>/operation/performance-validation/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/performance-validation/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `performance-requirements`, `scalability-requirements`, `performance-design`, `scalability-design`, `dashboards`).

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
