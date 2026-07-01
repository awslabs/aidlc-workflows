# Alarm Rules

## Overview
These rules define **how** alarms bridge metrics and human action. Alarms are the mechanism that turns observability data into operational response. Every alarm rule traces back to one or more STRAT rules. Load this file during NFR Design, Code Generation, and Operations stages.

---

### Rule AIOBS-ALARM-001: Align Alarms to the Three Observability Goals

**Rule**: Every alarm MUST map to one of the three observability goals (AIOBS-STRAT-002). The model MUST design alarms starting from KPIs (AIOBS-STRAT-001) working down, not from infrastructure metrics working up.

- **Detect alarms** (highest priority) — Fire when customers are in pain. These alarm on Customer Experience metrics (AIOBS-MET-001) and indicate KPI degradation. These are the alarms that page on-call.
- **Assess Impact alarms** — Fire when the scope of impact is widening. These alarm on Impact Assessment metrics and indicate the problem is growing.
- **Diagnose alarms** — Fire when a specific component is degrading. These alarm on Operational Health metrics and capacity/quota metrics (AIOBS-MET-006). These support investigation, not necessarily paging.

**Verification**:
- Every alarm is mapped to one of the three observability goals
- Detect alarms exist for every validated KPI
- Alarm priority/severity is tied to customer impact, not component importance
- Alarms are designed starting from KPIs, not from infrastructure metrics

---

### Rule AIOBS-ALARM-002: Use Composite Alarms for Detection

**Rule**: Individual metric alarms are noisy — a single 5xx spike or a brief CPU spike doesn't necessarily mean customers are impacted. For Detect-tier alerting, the model MUST design composite alarms that combine multiple signals to increase detection confidence and reduce false positives.

A composite Detect alarm combines signals such as: "Customer Experience metric degraded AND error rate elevated AND latency increased." This is a much stronger signal than any one alarm alone.

Individual metric alarms MUST be created for every resource where it is technically possible, for Diagnose-tier investigation — they pinpoint which component is degrading once a composite Detect alarm has fired.

**Verification**:
- Detect-tier alarms use composite alarms combining multiple signals
- Composite alarm logic is documented with rationale
- Individual metric alarms are available for Diagnose-tier investigation
- False positive rate of Detect alarms is tracked and reviewed

---

### Rule AIOBS-ALARM-003: Alarm on Missing Data

**Rule**: A metric that stops emitting is often a more severe signal than a metric that spikes. Every metric alarm MUST define a missing-data treatment. For Customer Experience metrics, missing data MUST be treated as breaching (alarm state) — if you can't confirm customers are healthy, assume they're not.

When designing alarms during NFR Design, the model MUST reason about each alarm's missing-data treatment by asking: **is missing data expected and benign for this metric?**

- **Missing data is NOT expected** (e.g. payment success rate, login success rate — should always be emitting while the service is running) → set `treat_missing_data: breaching`
- **Missing data IS expected** (e.g. 4xx error count — no errors means no data, which is healthy) → set `treat_missing_data: not_breaching` or `ignore`
- **Uncertain** → default to `treat_missing_data: breaching` (fail safe) and document the assumption

The reasoning and chosen treatment MUST be documented for each alarm. Default to `breaching` unless there is a documented reason why missing data is expected and benign.

**Verification**:
- Every metric alarm has a defined missing-data treatment
- Customer Experience metric alarms treat missing data as breaching
- The reasoning for each missing-data treatment is documented
- Missing-data behavior is tested as part of chaos experiments

---

### Rule AIOBS-ALARM-004: Every Alarm Must Have a Documented Response

**Rule**: An alarm without a response action is noise. Every alarm MUST have a corresponding runbook entry that documents: (1) what the alarm means in plain language, (2) what to look at first (dashboard, log query, trace search), and (3) what mitigation action to consider.

The alarm notification MUST link to the runbook so responders can act immediately without searching for documentation.

**Runbook dependency**: This rule depends on the runbooks extension (AIRUN-CONTENT-001). The model MUST create a runbook entry for each alarm as part of runbook generation.

**When runbooks extension is not active**: The model MUST document the alarm response inline in the alarm definition itself (meaning, first-look guidance, mitigation). Flag the absence of a runbook as a gap in the Operations phase validation.

**Verification**:
- Every alarm has a corresponding runbook entry per AIRUN-CONTENT-001
- Alarm notifications include a link to the runbook
- When runbooks are not active, inline response documentation exists for every alarm


---

### Rule AIOBS-ALARM-005: Create Composite Alarms Per Fault Isolation Boundary

**Rule**: For multi-AZ and multi-service architectures, the model MUST create composite alarms scoped to each fault isolation boundary so that the health of each boundary can be assessed independently. At minimum:

- **Per-AZ composite alarms** — combining health signals (availability, latency, error rate) for each AZ. Enables detection of AZ-level degradation (supports AIOBS-GFD-003).
- **Per-service composite alarms** — combining health signals for each service in a microservice architecture. Enables scoping impact to a specific service.
- **Per-region composite alarms** — for multi-region deployments, combining per-AZ composites into a regional health signal.

Per-instance alarms are NOT required as composites — instance-level issues are handled by outlier detection (AIOBS-GFD-002), not composite alarms.

**Verification**:
- Composite alarms exist per AZ for multi-AZ deployments
- Composite alarms exist per service for multi-service architectures
- Composite alarms exist per region for multi-region deployments
- Each composite combines relevant child alarms (availability, latency, error rate) for that boundary
- Composite alarm state is visible on operational dashboards
