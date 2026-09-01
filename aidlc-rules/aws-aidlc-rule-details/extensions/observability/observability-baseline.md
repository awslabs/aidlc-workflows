# Baseline Observability Rules

## Overview
These rules are the minimum observability floor for every deployable service. They are cross-cutting constraints enforced across all AI-DLC phases — during NFR Requirements, NFR Design, Code Generation, and Operations.

**Custom Rules**: Organisation-specific observability rules can be defined in `extensions/observability/observability-custom.md` using the `AIOBS-CUSTOM-` prefix. When present, custom rules are loaded and enforced alongside built-in rules.

**Signal-Specific Rules**: The STRAT rules below define **what** to observe and **why**. The **how** is defined in signal-specific rule files in `extensions/observability/`. The model MUST scan that directory and load `.md` files when observability rules are active during NFR Design, Code Generation, and Operations stages.

**Loading based on user's observability answer:**
- **Answer A (AWS best-practice)**: Load all `.md` files in `extensions/observability/` EXCEPT `observability-custom.md`
- **Answer B (AWS + custom)**: Load all `.md` files in `extensions/observability/` INCLUDING `observability-custom.md`
- **Answer C (custom only)**: Load ONLY `observability-custom.md` from `extensions/observability/`. Skip all other files. STRAT rules in this baseline file still apply as context.

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message.

### Blocking Observability Finding Behavior
A **blocking observability finding** means:
1. The finding MUST be listed in the stage completion message under an "Observability Findings" section with the AIOBS rule ID
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the AIOBS rule ID and stage context

### Default Enforcement
All rules in this document and in the loaded `extensions/observability/` files are **blocking** by default. If any rule's verification criteria are not met, it is a blocking observability finding — follow the blocking finding behavior above. If a rule is not applicable to the current architecture, mark it as **N/A** with a documented rationale — this is not a blocking finding. Silent omission is not acceptable — if a rule cannot be satisfied, the model MUST investigate whether the chosen libraries or services provide the capability, document the gap, and present it as a blocking finding. All gaps MUST be logged to audit.md with rule ID, rationale, and severity.

### Verification Criteria Format
Verification items in this document are plain bullet points describing compliance checks. Each item should be evaluated as compliant or non-compliant during review.

### Stage Enforcement

The following stages have mandatory enforcement of these rules. This is a minimum set — the model MUST enforce these rules at each stage listed below, and MAY also enforce them at other stages where relevant.

| Stage | Mandatory |
|-------|-----------|
| NFR Design | ✅ MUST enforce |
| Code Generation | ✅ MUST enforce |
| Operations | ✅ MUST enforce |

#### NFR Design

The model MUST produce design artifacts satisfying every loaded rule. The following are mandatory NFR Design outputs:

1. **Customer-facing KPIs** (AIOBS-STRAT-001): Identify KPIs from business logic and customer journeys. Present for user validation.
2. **Instrumentation library selection** (AIOBS-STRAT-005): Select the appropriate library for the tech stack.
3. **Structured log format** (AIOBS-LOG-001, AIOBS-LOG-002, AIOBS-LOG-003): Design log format with fault isolation fields including AZ-ID.
4. **Metric dimensions** (AIOBS-MET-001, AIOBS-MET-005): Design metric dimensions including fault isolation dimensions. AZ-ID MUST be included. For Lambda, use the metadata endpoint or Powertools metadata utility — not environment variables or log stream names.
5. **Metric emission method** (AIOBS-MET-002): For each required metric, determine the emission method top-down.
6. **Alarm design** (AIOBS-ALARM-001, AIOBS-ALARM-002): Design alarms aligned to the three observability goals (detect, assess, diagnose).
7. **Canary design** (AIOBS-DIFF-001, AIOBS-CLIENT-001, AIOBS-CLIENT-003): Design synthetic canaries for every confirmed customer-facing KPI. Select placement (public or VPC) based on workload accessibility. Each canary MUST execute the same API calls a real client would make for that KPI.
8. **Quadrant coverage map** (AIOBS-DIFF-002): Produce a table mapping signals to the four observability states (All Good, Gray Failure, Masked Failure, Detected Failure). Gray failure MUST have explicit detection mechanisms.
9. **Trace propagation** (AIOBS-TRACE-000, AIOBS-TRACE-001, AIOBS-TRACE-002): Design trace propagation approach.

**Verification**: NFR Design stage MUST NOT complete until all 9 outputs above are present in the NFR design artifacts. Missing outputs are blocking findings.

#### Operations

The model MUST validate every loaded rule against the generated artifacts (code, IaC, design documents). For each rule:
- Compliant → mark as passed
- Non-compliant → blocking finding: list the rule ID, what was expected, and what was found
- Not applicable → mark N/A with rationale

The Operations phase MUST NOT complete until all blocking findings are resolved or explicitly accepted by the customer with the decision logged to audit.

### Follow-Up Questions

These questions are presented during Requirements Analysis after the user opts in (answers A, B, or C):

```markdown
## Question: Telemetry Collection Pipeline
How should telemetry (metrics, logs, traces) be collected and shipped?

A) AWS Native — CloudWatch Agent, X-Ray daemon, CloudWatch Logs (recommended for AWS-only workloads)
B) OpenTelemetry — AWS Distro for OpenTelemetry (ADOT) Collector for metrics, logs, and traces (recommended for multi-backend or vendor-neutral requirements)
C) Hybrid — specify which signals use which pipeline after [Answer]: tag below

[Answer]:
```

```markdown
## Question: Closed-Loop Observability
Do you want to implement closed-loop observability? This builds componentry that monitors steady-state and peak traffic patterns, learns production baselines, and triggers updates to alarm thresholds, dashboard descriptions, and capacity projections as behaviour evolves.

A) Yes — build automated baselining and closed-loop refinement (recommended for production services with evolving traffic patterns)
B) No — use static thresholds set during construction (suitable for stable, predictable workloads)

**Note: Closed-loop observability is a future capability. This question is included for planning purposes only. The model MUST NOT implement AIOBS-LOOP rules at this time regardless of the user's answer.**

[Answer]:
```

---

## OBSERVABILITY STRATEGY

These rules define **what** we observe and **why**. They provide the strategic context that all signal-specific rules (MET, LOG, TRACE, ALARM) implement. The model MUST understand these goals before making any instrumentation decisions.

### Rule AIOBS-STRAT-001: Derive Observability from Customer-Facing KPIs

**Rule**: Before defining any metrics, the model MUST identify customer-facing KPIs by analysing the application design and user stories. These KPIs represent business outcomes from the customer's perspective (e.g., order completion rate, payment success rate, search result relevance). The model presents the identified KPIs to the user for validation. Once confirmed, all observability decisions — metric selection, dashboard design, alarm thresholds — MUST trace back to these KPIs.

**Execution**:
- During **Application Design / User Stories**: Infer KPIs from business logic and customer journeys
- During **NFR Design**: Present KPIs for user validation using the format below
- During **Code Generation and Operations**: Use confirmed KPIs as the foundation for all instrumentation decisions

**KPI Validation Format**: The model MUST present identified KPIs using this format:

```markdown
## Question: Customer-Facing KPI Validation

Based on the application design, the following customer-facing KPIs have been identified:

| # | KPI | Description |
|---|-----|-------------|
| 1 | [KPI name] | [What it measures from the customer's perspective] |
| 2 | [KPI name] | [What it measures from the customer's perspective] |

A) Approve — these KPIs correctly represent the key business outcomes
B) Modify — I want to adjust, add, or remove KPIs (describe changes after [Answer]: tag below)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**Verification**:
- A documented list of customer-facing KPIs exists, validated by the user
- Every custom metric can be traced to at least one KPI
- Dashboards are organised around KPIs, not just per-service technical views
- Alarms are tied to KPI degradation, not arbitrary thresholds

---

### Rule AIOBS-STRAT-002: Three Observability Goals — Detect, Assess Impact, Diagnose

**Rule**: All observability instrumentation — metrics, logs, and traces — serves one of three goals. The model MUST design observability using these three goals as the organising framework:

1. **Detect** — Identify that customers have a problem. The service is not meeting its obligations. This is the first signal that something is wrong, derived from the validated KPIs (AIOBS-STRAT-001).
2. **Assess Impact** — Determine how bad it is. How many customers, resources, or workloads are affected? What is the scope and scale? This answers "how bad is it?" so responders can prioritise.
3. **Diagnose** — Understand why the impact is occurring. Per-component signals (load, latency, errors, resource utilisation, request flow) that enable responders and automation to identify what is causing the customer pain and take action to mitigate.

None of these goals are about identifying root cause — they are about stopping the customer pain. Each signal type (metrics, logs, traces) contributes to these goals differently, and the signal-specific rules (AIOBS-MET-001, AIOBS-LOG-001, AIOBS-TRACE-001) define how.

**Verification**:
- Every metric, structured log entry, and trace span can be mapped to at least one of the three goals
- Detect signals exist for each validated KPI
- Assess Impact signals exist that measure scope and scale of impact
- Diagnose signals exist for every component enabling identification of the cause
- The three goals are documented and traceable in observability artifacts

---

### Rule AIOBS-STRAT-003: Evaluate Signal Strategy Holistically

**Rule**: For each observability goal, the model MUST reason about which signal type (metric, log, or trace) best serves that goal before deciding on implementation. A single observability need may be served by an AWS-native metric, a synthetic canary, a structured log entry exposed as a custom metric, a trace span, or a combination. The model MUST evaluate the options holistically rather than defaulting to a single signal type.

The evaluation order for each observability need is:
1. Does an existing AWS-native signal already provide this? (e.g., ALB metrics, CloudWatch service metrics, X-Ray service map)
2. Can a synthetic canary or external probe measure this from the customer's perspective?
3. Must this be emitted by the application itself — and if so, as a metric, a structured log entry designed for metric extraction, a trace span, or a combination?

This rule ensures the model thinks strategically about signal selection. The signal-specific rules (MET, LOG, TRACE) then govern how each chosen signal is implemented.

**Verification**:
- Each observability need has a documented signal strategy with rationale
- AWS-native signals are used where they provide the required information — no redundant custom instrumentation
- The model has considered multiple signal types before selecting an implementation approach

---

### Rule AIOBS-STRAT-004: Enable Fault Isolation to the Narrowest Boundary

**Rule**: Every piece of telemetry — metrics, logs, and traces — MUST enable isolating failures to the narrowest possible application boundary. When a problem is detected, responders must be able to scope it: is it all customers or one tenant? All versions or one deployment? All infrastructure or one AZ? One cell or the whole fleet?

The model MUST analyse the architecture to identify the relevant fault isolation boundaries, which typically include: availability zone, software version, service name, instance/container, and where applicable: tenant, deployment, feature flag state, API version, cell/shard.

The signal-specific rules (AIOBS-MET-005, AIOBS-LOG-002, AIOBS-TRACE-002) define how each signal type implements fault isolation dimensions.

**Verification**:
- Fault isolation boundaries are identified and documented for the architecture
- Every signal type includes the relevant fault isolation context
- Dashboards and alarms can filter by fault isolation boundaries
- Responders can scope a failure to a specific version, tenant, AZ, or deployment using the available telemetry

---

### Rule AIOBS-STRAT-005: Use Standardised Instrumentation Libraries

**Rule**: All services MUST use a standard instrumentation library appropriate to the tech stack. This ensures consistent signal emission across metrics, logs, and traces without per-developer instrumentation decisions. The library selection is made during NFR Design based on the workload type (e.g., Lambda Powertools for Lambda workloads, OpenTelemetry for container/ECS/EKS workloads, Embedded Metrics Format for CloudWatch-native stacks).

**Verification**:
- A single standard instrumentation library is selected and documented for the project
- The library covers structured logging, metric emission, and trace context propagation
- Middleware produces consistent core metrics automatically
- Trace context headers are injected automatically via middleware
- No per-developer or per-component instrumentation library choices

