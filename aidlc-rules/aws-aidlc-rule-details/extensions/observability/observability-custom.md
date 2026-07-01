# Custom Observability Rules

## Overview

This file is for your organisation's custom observability rules. Rules defined here are loaded and enforced alongside the built-in AIOBS rules when this file is present.

**How it works**:
- Place this file in `extensions/observability/` alongside the signal-specific rule files
- The AI-DLC extension loader automatically discovers and loads all `.md` files in this directory
- Custom rules are enforced with the same blocking behavior as built-in rules
- Custom rules can reference built-in rules (e.g., "extends AIOBS-STRAT-002")

**Rule ID convention**: Use the prefix `AIOBS-CUSTOM-` followed by the signal type:
- `AIOBS-CUSTOM-STRAT-` — Custom strategy rules (what/why)
- `AIOBS-CUSTOM-MET-` — Custom metrics rules
- `AIOBS-CUSTOM-LOG-` — Custom logging rules
- `AIOBS-CUSTOM-TRACE-` — Custom tracing rules
- `AIOBS-CUSTOM-ALARM-` — Custom alarm rules
- `AIOBS-CUSTOM-DASH-` — Custom dashboard rules
- `AIOBS-CUSTOM-DETECT-` — Custom detection rules

**Rule format**: Each rule MUST follow this structure:

```
### Rule AIOBS-CUSTOM-{TYPE}-{NNN}: {Rule Name}

**Applies to**: {Optional — specify conditions, or remove if always applicable}

**Rule**: {What the rule requires and why.}

**Verification**:
- {Compliance check 1}
- {Compliance check 2}
```

---

## Custom Strategy Rules

<!-- Place custom strategy rules here. These define organisation-specific observability
     goals that apply across all signal types (metrics, logs, traces). -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIOBS-CUSTOM-STRAT-001: Track Regulatory Compliance KPIs

**Rule**: All services handling PII must include data access audit rate and consent
verification success rate as customer-facing KPIs (extends AIOBS-STRAT-001). These KPIs
must be validated alongside the standard KPIs during NFR Design.

**Verification**:
- PII-handling services have regulatory KPIs documented and validated
- Audit rate and consent verification metrics exist and are alarmed
- Regulatory KPIs are traceable in the observability summary

-->

---

## Custom Metrics Rules

<!-- Place custom metrics rules here. These define organisation-specific metric
     requirements beyond the built-in AIOBS-MET rules. -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIOBS-CUSTOM-MET-001: Track Cost Attribution Metrics

**Rule**: All services must emit cost-attribution metrics (request count, compute
duration, storage consumed) with a CostCentre dimension so that operational costs
can be attributed to business units.

**Verification**:
- Cost-attribution metrics are emitted for every service
- CostCentre dimension is present on all cost-related metrics
- Cost metrics are visible on a dedicated cost dashboard

-->

---

## Custom Logging Rules

<!-- Place custom logging rules here. These define organisation-specific structured
     log requirements beyond the built-in AIOBS-LOG rules. -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIOBS-CUSTOM-LOG-001: Include Data Classification Field

**Rule**: All structured log entries for services handling PII must include a
data_classification field (public, internal, confidential, restricted) per the
organisation's data classification policy. This field must be present in the
base log format (extends AIOBS-LOG-003).

**Verification**:
- data_classification field is present on all log entries for PII-handling services
- Field values conform to the organisation's classification taxonomy
- Field is included in the LOG-003 base format for applicable services

-->

---

## Custom Tracing Rules

<!-- Place custom tracing rules here. These define organisation-specific trace
     requirements beyond the built-in AIOBS-TRACE rules. -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIOBS-CUSTOM-TRACE-001: Include Business Transaction ID on Spans

**Applies to**: Services processing business transactions (orders, payments, claims)

**Rule**: Trace spans must include a business_transaction_id attribute linking the
technical trace to the business transaction for end-to-end business process visibility.

**Verification**:
- business_transaction_id attribute is present on trace spans for transaction-processing services
- Attribute value matches the business transaction identifier used in logs and metrics

-->

---

## Custom Alarm Rules

<!-- Place custom alarm rules here. These define organisation-specific alarm
     requirements beyond the built-in AIOBS-ALARM rules. -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIOBS-CUSTOM-ALARM-001: Notify Compliance Team on PII Access Anomalies

**Applies to**: Services handling PII

**Rule**: A dedicated alarm must notify the compliance team when PII data access
patterns deviate from established baselines (e.g., unusual volume of data exports,
access from unexpected principals). This alarm is separate from operational alarms
and routes to the compliance notification channel.

**Verification**:
- PII access anomaly alarm exists for every PII-handling service
- Alarm routes to the compliance notification channel, not the operational channel
- Alarm threshold is based on established access baselines

-->

---

## Custom Dashboard Rules

<!-- Place custom dashboard rules here. These define organisation-specific dashboard
     requirements beyond the built-in AIOBS-DASH rules. -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIOBS-CUSTOM-DASH-001: Include SLA Compliance Dashboard

**Rule**: Every externally-facing service must have an SLA compliance dashboard
showing contractual SLA metrics (availability, latency, error rate) against
committed thresholds, with monthly and quarterly roll-up views.

**Verification**:
- SLA compliance dashboard exists for every externally-facing service
- Dashboard shows contractual thresholds as horizontal annotations
- Monthly and quarterly roll-up views are available

-->

---

## Custom Detection Rules

<!-- Place custom detection rules here. These define organisation-specific detection
     requirements beyond the built-in AIOBS-DIFF, CLIENT, SERVER, and GFD rules. -->

<!-- EXAMPLE (remove this comment block and uncomment to use):

### Rule AIOBS-CUSTOM-DETECT-001: Detect Data Pipeline Staleness

**Applies to**: Services with data ingestion pipelines

**Rule**: Data pipelines must have staleness detection — an alarm that fires when
no new data has been ingested within the expected freshness window. The freshness
window must be defined per pipeline based on the data source's expected update frequency.

**Verification**:
- Staleness alarm exists for every data pipeline
- Freshness window is documented and configured per pipeline
- Alarm fires when no new data arrives within the freshness window

-->
