# Dashboard Rules

## Overview
These rules define **how** operational dashboards implement the observability strategy. Dashboards are the primary tool for Assess Impact and Diagnose during incidents — they support operators, they do not replace automated detection (AIOBS-ALARM rules). Load this file during Operations stages.

---

## DASHBOARD TYPE AND DESIGN

### Rule AIOBS-DASH-001: Select Dashboard Types from the Standard Hierarchy

**Rule**: The model MUST determine which dashboard types are needed based on the architecture and intended audience. Dashboards MUST be selected from the following hierarchy, with customer experience dashboards as the highest priority:

1. **Customer Experience Dashboards** (highest priority) — Overall service health from the customer's perspective. Broad audience.
2. **System-Level Dashboards** — Entry points for web services, per-API interface-level data.
3. **Service Instance Dashboards** — Single instance, partition, or cell focus.
4. **Service Audit Dashboards** — Cross-instance, cross-AZ, cross-Region comparison.
5. **Capacity Planning Dashboards** — Long-term forecasting and quota consumption (AIOBS-MET-006).
6. **Microservice-Specific Dashboards** — Implementation-specific monitoring.
7. **Infrastructure Dashboards** — Compute resources (EC2, ECS/EKS, Lambda).
8. **Dependency Dashboards** — Upstream and downstream dependency health.
9. **Client Dashboards** — Client-side metrics (AIOBS-CLIENT-001, AIOBS-CLIENT-002).

Not every service needs all nine types. The model MUST select based on architecture complexity and operational needs.

**Verification**:
- Dashboard types are selected with documented rationale
- Customer experience dashboard exists for every service
- Dashboard types match the architecture's operational needs

---

### Rule AIOBS-DASH-002: Design Dashboards from KPIs Down, Not Metrics Up

**Rule**: Implementing AIOBS-STRAT-001 for dashboards, the model MUST design dashboards starting from validated customer-facing KPIs and working down to supporting metrics. Dashboards MUST NOT be designed by listing available metrics and grouping them — they must answer specific operational questions for a specific audience.

**Verification**:
- Each dashboard has a documented purpose and target audience
- Dashboard content traces back to validated KPIs (AIOBS-STRAT-001)
- Dashboards are organised around operational questions, not metric availability

---

## LAYOUT AND ORGANISATION

### Rule AIOBS-DASH-003: Place Critical Metrics at the Top

**Rule**: Customer Experience metrics (AIOBS-MET-001) MUST appear in the top section of every dashboard, visible without scrolling. Customer-facing metrics (Detect — AIOBS-STRAT-002) MUST be prioritised over internal operational metrics (Diagnose).

**Verification**:
- Customer experience and SLO metrics appear in the top 20% of the dashboard
- Health indicators are visible without scrolling
- Metric placement priority is documented

---

### Rule AIOBS-DASH-004: Align Graph Widths for Time Correlation

**Rule**: All graphs within a dashboard section MUST share identical horizontal width so that time axes align vertically. This enables operators to visually correlate events across multiple metrics during incident investigation.

**Verification**:
- All graphs in a section share identical width
- Time axes align vertically across stacked graphs
- Zoom and pan operations affect all graphs in a section uniformly

---

### Rule AIOBS-DASH-005: Group Related Metrics in Logical Sections

**Rule**: Metrics MUST be grouped by functional category — input, processing, and output — within each dashboard. Each section MUST have clear visual separation and a descriptive header.

**Verification**:
- Metrics grouped by functional category
- Each section has clear visual separation and a header
- Related metrics are adjacent, not scattered across the dashboard

---

## DATA PRESENTATION

### Rule AIOBS-DASH-006: Keep High-Level Dashboards Focused

**Applies to**: Customer Experience, System-Level, Service Audit Dashboards

**Rule**: High-level dashboards MUST show aggregated data only. Implementation details MUST be relegated to linked drill-down dashboards. A high-level dashboard MUST NOT exceed 20 graphs.

**Verification**:
- High-level dashboards show aggregated metrics only
- Links to detailed drill-down dashboards exist
- No high-level dashboard exceeds 20 graphs

---

### Rule AIOBS-DASH-007: Display Input, Processing, and Output Metrics Per API

**Applies to**: System-Level, Microservice-Specific Dashboards

**Rule**: For each API, the dashboard MUST display three categories of monitoring data aligned to the request lifecycle:

1. **Input** — Request counts, request size percentiles, authentication/authorisation failures
2. **Processing** — Business logic paths, backend requests, faults/errors, trace links
3. **Output** — Response types, response sizes, time-to-first-byte, time-to-complete

**Verification**:
- All three data categories are represented for each API
- Metric coverage is documented per API

---

## GRAPH DESIGN

### Rule AIOBS-DASH-008: Limit Metrics Per Graph

**Rule**: A single graph MUST NOT contain more than 5 metrics. All metrics on a graph MUST share a common unit and scale. The graph title MUST clearly describe what is being measured.

**Verification**:
- No graph contains more than 5 metrics
- All metrics on a graph share a common unit/scale
- Every graph has a descriptive title

---

### Rule AIOBS-DASH-009: Separate Graphs for Different Metric Categories

**Rule**: The model MUST create separate graphs for different metric categories. Availability, latency, and error counts MUST NOT be mixed on the same graph.

Recommended separation:
- Availability percentage in its own graph
- P50 and P90 latency in one graph
- P99 and P99.9 latency in a separate graph
- Error counts (4xx and 5xx separate per AIOBS-MET-004) in their own graphs

**Verification**:
- Availability, latency, and error metrics are on separate graphs
- Latency percentiles are split between typical (P50/P90) and tail (P99/P99.9)

---

### Rule AIOBS-DASH-010: No Disparate Value Ranges on the Same Axis

**Rule**: Metrics with disparate value ranges (more than one order of magnitude apart) MUST NOT be plotted on the same y-axis. Split them into separate graphs instead. Dual y-axis graphs MUST NOT be used — split into two single-axis graphs stacked vertically to maintain time correlation.

**Verification**:
- Metrics on the same graph have similar value ranges
- No dual y-axis graphs exist in any dashboard
- Disparate metrics are split into separate vertically-stacked graphs

---

### Rule AIOBS-DASH-011: Annotate Graphs with Alarm Thresholds and Limits

**Rule**: Graphs MUST display alarm thresholds as horizontal lines so operators can immediately see how current values relate to alert conditions. Known limits (tested capacity limits, hard resource limits, SLO targets) MUST also be annotated. Warning and critical thresholds MUST use different colours.

**Verification**:
- Static alarm thresholds shown as horizontal lines on relevant graphs
- Threshold lines are labelled with values
- Warning and critical thresholds use distinct colours
- Known capacity limits and SLO targets are annotated where applicable

---

### Rule AIOBS-DASH-012: Emit Zeros for Sparse Metrics

**Rule**: Metrics that are only emitted during error conditions (sparse metrics) MUST be supplemented with continuous zero-value emission during normal operation. Absence of data on a graph MUST indicate a telemetry problem, not normal operation. This aligns with AIOBS-LOG-001 (log both success and failure) and AIOBS-ALARM-003 (alarm on missing data).

**Verification**:
- Services emit zero values when error conditions don't exist
- Absence of data triggers telemetry health investigation
- No dashboard graph relies solely on sparse metrics for operational visibility

---

## CONTEXT AND DOCUMENTATION

### Rule AIOBS-DASH-013: Include Metric Descriptions on Every Graph

**Rule**: The model MUST NOT assume dashboard users know what metrics mean. Every graph MUST include descriptive text explaining the metric, what it measures, and why it matters. Implementation-specific metrics MUST have detailed explanations.

**Verification**:
- Every graph includes descriptive text
- Implementation-specific metrics have detailed explanations
- Technical terms and acronyms are defined

---

### Rule AIOBS-DASH-014: Describe Expected Behaviour and Concerning Deviations

**Rule**: Each graph MUST include description text explaining the expected behaviour based on the application design, and what deviations might indicate. Where production baselines are not yet established (e.g., during Construction), the model MUST describe expected behaviour from the design (e.g., "latency expected under 500ms based on downstream call pattern") and include placeholder notes for operators to refine after baselining with production traffic.

**Verification**:
- Each graph has a description of expected behaviour with design-based rationale
- Descriptions identify concerning deviations and their potential meaning
- Descriptions suggest next steps for investigation
- Placeholder notes exist for values that require production baselining

---

### Rule AIOBS-DASH-015: Link to Runbooks, Drill-Down Dashboards, and Related Resources

**Rule**: Every dashboard MUST include links to related resources: runbooks, drill-down dashboards, equivalent dashboards for other environments/regions, deployment pipelines, and dependency team contacts. This ties to AIOBS-ALARM-004 (every alarm has a documented response).

**Verification**:
- Links to relevant runbooks are included
- Links to drill-down dashboards are included
- Links to equivalent dashboards for other environments/regions are included
- Dependency contact information is accessible

---

## ALARM INTEGRATION

### Rule AIOBS-DASH-016: Dashboards Support Investigation, Not Detection

**Rule**: Dashboards MUST NOT be relied upon for detection — that is the role of alarms (AIOBS-ALARM rules). No operational process MUST require manual dashboard monitoring to detect issues. Dashboards are for investigation and diagnosis after an alarm fires.

**Verification**:
- All critical conditions have automated alarms (not just dashboard visibility)
- No operational procedure requires manual dashboard monitoring for detection
- Dashboards are designed to support investigation workflows triggered by alarms

---

### Rule AIOBS-DASH-017: Alarm Notifications Must Link to Dashboards

**Rule**: Alarm notifications MUST include direct links to the relevant dashboard and runbook so that operators can immediately begin investigation when paged. Links MUST be specific to the affected resource and region.

**Verification**:
- Alarm notifications include dashboard URLs
- Alarm notifications include runbook URLs
- Links are specific to the affected resource/region

---

## CLIENT/SERVER SIDE-BY-SIDE

### Rule AIOBS-DASH-018: Implement Side-by-Side Client/Server Dashboards

**Applies to**: Services with both client-side and server-side observability (AIOBS-DIFF-001)

**Rule**: Every customer journey confirmed during Infrastructure Design Step 11 MUST have a dashboard displaying client-side and server-side metrics for the same time window, side-by-side. Dashboard priority order: (1) Customer Perspective, (2) Service Perspective, (3) Infrastructure Perspective.

**Verification**:
- Dashboard includes: client-side availability, server-side availability, client-side P99 latency, server-side P99 latency
- Graphs are time-aligned
- Dashboard includes a discrepancy metric (Client Availability minus Server Availability)
