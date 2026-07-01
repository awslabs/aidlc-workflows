# Differential Observability Rules

## Overview
These rules define differential observability — observing from multiple perspectives to detect failures that single-perspective server-side monitoring misses. They are conditionally applied based on architecture characteristics — the model MUST evaluate the "Applies to" criteria for each rule and skip rules that don't apply (marking them N/A).

These rules build on the baseline observability strategy (`extensions/observability/observability-baseline.md`) and the signal-specific rules in this directory.

---

## DIFFERENTIAL OBSERVABILITY

### Rule AIOBS-DIFF-001: Implement Both Client-Side and Server-Side Observability

**Rule**: All services MUST implement observability from both the client perspective and the server perspective. Server-side alone is insufficient — it cannot detect failures that occur between the caller and the service boundary.

**Step 1 — Determine internet accessibility**: The model MUST check requirements.md for signals indicating whether the workload is accessible over the public internet (e.g. public URL, web frontend, public API). If unclear, the model MUST ask:

```markdown
## Question: Internet Accessibility

Is this workload accessible over the public internet?

A) Yes — the workload has public internet endpoints
B) No — the workload is only accessible within a private network (VPC, corporate network)

[Answer]:
```

Log the answer to `aidlc-docs/audit.md`. This classification drives the client-side implementation approach.

**Step 2 — Design client-side observability**: Based on the internet accessibility answer:
- **Internet-accessible (A)**: The model MUST design CloudWatch Synthetics canaries per AIOBS-CLIENT-001. Canaries run from outside the service boundary over the public internet.
- **Private/VPC-only (B)**: The model MUST design VPC-attached Lambda canaries that exercise the same network path, security groups, and DNS resolution as real callers from within the VPC.

Both approaches provide the caller's perspective — the difference is where the caller sits (internet vs VPC).

**Verification**:
- Internet accessibility is confirmed in audit.md
- Both client-side and server-side availability metrics exist for every customer journey confirmed in the Customer Journey Classification question during Infrastructure Design
- Internet-accessible workloads have CloudWatch Synthetics canaries (AIOBS-CLIENT-001)
- VPC-only workloads have VPC-attached Lambda canaries
- Dashboards display both perspectives side-by-side
- Discrepancies between client-side and server-side metrics are detectable

---

### Rule AIOBS-DIFF-002: Detect All Four Observability Quadrants

**Applies to**: All workloads with client-side observability (AIOBS-DIFF-001)

**Rule**: Services MUST detect all four observability states:
1. **All Good** — System healthy, customer healthy
2. **Gray Failure** — System appears healthy but customer is unhealthy (the most dangerous state)
3. **Masked Failure** — System unhealthy but customer is healthy (e.g., redundancy absorbing the failure)
4. **Detected Failure** — System unhealthy, customer unhealthy (obvious, already alarming)

During NFR Design, the model MUST produce a quadrant coverage map — a table documenting which metrics and signals detect each of the four states. Gray failure MUST have explicit detection mechanisms documented (this is the state most likely to be missed without differential observability). The quadrant coverage map MUST be included in the NFR design artifacts.

**Verification**:
- NFR design artifacts include a quadrant coverage map
- Each quadrant has at least one identified detection signal
- Gray failure detection mechanisms are explicitly documented and tested
- Masked failure scenarios are identified and calibrated to reduce false positives

---

## CLIENT-SIDE METRICS

### Rule AIOBS-CLIENT-001: Implement Synthetic Canaries to Monitor Customer-Facing KPIs

**Applies to**: All workloads with customer-facing KPIs (AIOBS-STRAT-001)

**Rule**: All customer-facing KPIs confirmed during NFR Design (AIOBS-STRAT-001) MUST be monitored by synthetic canaries. Each canary MUST execute the same API calls a real client would make for that KPI — including authentication where required. The model MUST design canaries during NFR Design — absence of canary design is a blocking finding.

**Canary placement**:
- **Internet-facing workloads**: canaries MUST run from outside the service boundary over the public internet (e.g. CloudWatch Synthetics public canaries). This provides the most accurate representation of real client experience.
- **Private/internal workloads**: canaries MUST run from within the same network boundary as the clients (e.g. CloudWatch Synthetics VPC canaries). Running from outside would not reach the service.

**Verification**:
- Canaries exist for every confirmed KPI and execute at a defined frequency
- Read the actual canary code and verify it uses the same endpoints, authentication flow, and request sequence as the customer journey — not just a health check endpoint
- Canary placement, dimensions, and per-region requirements are as defined by AIOBS-CLIENT-003

---

### Rule AIOBS-CLIENT-002: Measure Client-Side Availability Independently

**Applies to**: All workloads with client-side observability (AIOBS-DIFF-001)

**Rule**: Client-side availability MUST be `Successful client requests / Total client requests` — including timeouts and connection failures not visible server-side.

**Verification**:
- Client-side availability metric exists independently from server-side metrics
- Includes request timeouts and connection failures

---

### Rule AIOBS-CLIENT-003: Emit Client-Side Metrics with Fault Isolation Dimensions

**Applies to**: Multi-AZ, multi-instance, or multi-region deployments

**Rule**: Client-side metrics — whether from external synthetic canaries or VPC-attached Lambda canaries — MUST include fault isolation dimensions that enable measuring the health of each recovery boundary independently: Region, AZ-ID, Target Instance/Container ID (where available), API Operation, and Request Trace ID.

For multi-AZ deployments, canaries MUST target AZ-specific endpoints (e.g., zonal DNS, AZ-affinity load balancer targets) so that per-AZ health can be measured from the caller's perspective. For multi-region deployments, canaries MUST run in each region to measure per-region health independently.

**Verification**:
- Client-side metrics include Region and AZ-ID dimensions
- Canaries target AZ-specific endpoints where supported (not just the regional endpoint)
- Multi-region deployments have canaries running in each region
- Client SDKs or canaries propagate trace context headers
- Client-side error metrics can be grouped by Region and AZ independently

---

## GRAY FAILURE DETECTION

### Rule AIOBS-GFD-001: Implement Deep Health Checks

**Rule**: All services MUST implement deep health checks verifying application logic and all dependencies. Shallow health checks MUST NOT be the sole routing signal.

**Verification**:
- Deep health check verifies: application logic, downstream dependency connectivity, local instance state
- Deep health checks are used for load balancer routing decisions
- Shallow health checks are used exclusively for Auto Scaling replacement
- A heartbeat mechanism tracks per-instance health state across Availability Zones
- Deep health checks are NOT integrated with Auto Scaling group replacement

---

### Rule AIOBS-GFD-002: Implement Outlier Detection for Single-Instance Failures

**Applies to**: Horizontally scaled deployments (multiple instances)

**Rule**: Services MUST implement automated outlier detection to identify instances contributing disproportionately to errors or latency.

**Verification**:
- At least one outlier detection algorithm is implemented (Chi-squared, IQR, MAD, or Z-score)
- Contributor Insights rules (or equivalent) are configured with InstanceId as a dimension
- Metrics enable identification of disproportionate error contributors

---

### Rule AIOBS-GFD-003: Implement AZ-Level Gray Failure Detection

**Applies to**: Multi-AZ deployments

**Rule**: Detection MUST identify when ALL three conditions are simultaneously true: (1) measurable customer impact, (2) one AZ is a statistical outlier, (3) impact is not attributable to a single instance.

During NFR Design, the model MUST design a composite alarm that enforces all three conditions independently and simultaneously:
- **Condition 1** — a customer impact alarm (from AIOBS-ALARM-001 Detect tier)
- **Condition 2** — a per-AZ outlier detection alarm (one AZ's error/latency distribution differs statistically from the others)
- **Condition 3** — a not-single-instance alarm (more than one instance in the impacted AZ is contributing to the signal)

All three MUST be true for the composite to fire. This prevents false positives from single-instance failures (covered by AIOBS-GFD-002) and from fleet-wide issues (covered by standard alarms).

**Verification**:
- AZ-specific metrics are emitted from synthetic canaries or client-side measurements
- A composite alarm exists combining all three conditions
- Detection logic enforces all three conditions independently
