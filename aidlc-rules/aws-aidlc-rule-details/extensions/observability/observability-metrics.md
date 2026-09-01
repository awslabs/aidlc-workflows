# Metrics Rules

## Overview
These rules define **how** metrics implement the observability strategy defined in `extensions/observability/observability-baseline.md`. Every metric rule traces back to one or more STRAT rules. Load this file during NFR Design, Code Generation, and Operations stages.

---

### Rule AIOBS-MET-001: Implement Three Metric Sets for Detect, Assess Impact, and Diagnose

**Rule**: Implementing AIOBS-STRAT-002 for metrics, the model MUST design metrics organised into three sets:

1. **Customer Experience Metrics** (Detect) — Detect that the customer has a problem and the service is not responding to them. These are derived from the validated KPIs (AIOBS-STRAT-001) and measure business outcomes from the customer's perspective.
2. **Impact Assessment Metrics** (Assess Impact) — Measure the number and percentage of customers, resources, or workloads impacted. Once a problem is detected, these metrics answer "how bad is it?" by articulating scope and scale.
3. **Operational Health Metrics** (Diagnose) — Determine why the impact is occurring. These are per-component diagnostic metrics (load, latency, errors, resource utilisation) that enable responders and automation to identify what is causing the customer pain and take action to mitigate.

None of these metrics are identifying root cause — they are telling us how to stop the customer pain.

**Verification**:
- Each validated KPI has at least one Customer Experience metric with a documented emission method (synthetics, application logs, or AWS service metrics)
- Impact Assessment metrics exist that measure scope and scale of impact (number/percentage of affected customers, resources, or workloads)
- Every component has Operational Health metrics for load and latency enabling diagnosis
- The three metric sets are documented and traceable in observability artifacts

---

### Rule AIOBS-MET-002: Select Emission Method Top-Down Per Metric

**Rule**: Implementing AIOBS-STRAT-003 for metrics, the model MUST determine the emission method for each required metric by evaluating in order:

1. Does an AWS-native metric already provide this signal? (e.g., ALB RequestCount, API Gateway 5XXError, CloudFront CacheHitRate)
2. Can a synthetic canary measure this from the customer's perspective?
3. Must this be derived from a structured application log entry exposed as a custom metric (via EMF, CloudWatch metric filter, or equivalent)?

Where application logs are the emission method, the log entry MUST conform to the base structured log format (AIOBS-LOG-003) and include the EMF `_aws` metadata block to expose metrics. The log entry MUST be purpose-built for metric extraction — not retrofitted from debug logging.

**Verification**:
- Each metric has a documented emission method (AWS-native, synthetic, or application log)
- AWS-native metrics are used where they provide the required signal — no redundant custom metrics
- Application log entries intended as metric sources are structured with the required dimensions and designed for metric extraction

---

### Rule AIOBS-MET-003: Include AWS Infrastructure True Error Metrics

**Rule**: True error metrics from AWS infrastructure (ALB 4xx/5xx, API Gateway 4xx/5xx, Lambda errors/throttles) MUST be included for every resource of every AWS service. These are AWS-native signals that require no custom instrumentation and provide immediate Detect and Diagnose value (AIOBS-STRAT-002).

During NFR Design, the model MUST enumerate every AWS service, then enumerate every resource of that service, and identify the applicable AWS-native error metrics from the `AWS/` namespace. For each identified metric, an alarm MUST be designed. This is a systematic step — not opportunistic.

**Verification**:
- Every AWS service has been enumerated, and every resource of each service has been identified
- True error metrics from AWS infrastructure are identified for every resource of every AWS service
- Alarms exist on these metrics with appropriate thresholds
- These metrics are included in operational dashboards

---

### Rule AIOBS-MET-004: Separate Client Errors from Server Errors

**Rule**: Error metrics MUST separately track 4xx and 5xx errors. They MUST NOT be aggregated. This supports accurate Detect and Assess Impact (AIOBS-STRAT-002) — a spike in 4xx errors has different operational meaning than a spike in 5xx errors.

**Verification**:
- Separate metrics exist for 4xx and 5xx error counts per API
- Percent of customers affected is tracked alongside percent of requests with errors

---

### Rule AIOBS-MET-005: Include Fault Isolation Dimensions on Metrics

**Rule**: Implementing AIOBS-STRAT-004 for metrics, all custom metrics MUST include application-specific dimensions that enable fault isolation beyond AWS infrastructure boundaries. At minimum: service name, instance/container ID, availability zone, and software version. Where the architecture supports it: tenant ID, deployment ID, feature flag state, API version, cell/shard ID. For Lambda, `instance_id` is replaced by `function_name` + `function_version` (Lambda has no stable instance ID).

These dimensions enable scoping failures to specific application boundaries during investigation (e.g., "failures are isolated to version 2.3.1 in us-east-1a on the order-processing service").

**Verification**:
- All custom metrics include at minimum: service name, instance/container ID, availability zone, and software version as dimensions
- Additional dimensions (tenant ID, deployment ID, etc.) are included where the architecture supports them
- Dashboards and alarms can filter by these application-specific dimensions

---

### Rule AIOBS-MET-006: Track Capacity and Quota Consumption Per Resource

**Rule**: The model MUST identify the relevant capacity constraints and service quotas for every resource of every AWS service, and define metrics that track consumption against those limits. "Capacity" means different things for different service types — the model MUST reason about what capacity looks like for each service rather than applying a one-size-fits-all approach.

For each service, the model MUST determine:
1. **Capacity metrics** — What are the resource constraints that, when exhausted, cause customer impact? How are they measured for this service type?
2. **Quota metrics** — What AWS service quotas apply? How is current consumption tracked against the quota limit?

Capacity and quota consumption MUST be expressed as a percentage of the limit (current usage / limit × 100), not as raw absolute values. Raw values like "ConcurrentExecutions = 780" are meaningless without context — "78% of quota" immediately communicates proximity to the cliff. Alarms MUST be set on percentage thresholds so they remain valid when quotas change.

The model MUST evaluate the signal strategy (AIOBS-STRAT-003) for each capacity and quota metric — many are available as AWS-native metrics, some require custom calculation (e.g., percentage consumed = current usage / quota limit).

**Examples of service-specific capacity reasoning:**

| Service type | Capacity concern | Metric approach |
|-------------|-----------------|-----------------|
| EC2 | CPU, memory, disk, network | Direct utilisation metrics (CPUUtilization, mem_used_percent) |
| Lambda | Compute capacity | ConcurrentExecutions vs. account/function concurrency quota |
| Lambda | Duration budget | Duration vs. configured timeout |
| API Gateway | Request throughput | Request count vs. requests-per-second quota |
| DynamoDB | Read/write throughput | ConsumedReadCapacityUnits / ProvisionedReadCapacityUnits (provisioned); ThrottledRequests (on-demand) |
| SQS | Queue depth / processing rate | ApproximateNumberOfMessagesVisible, ApproximateAgeOfOldestMessage |
| ECS/Fargate | Task capacity | RunningTaskCount vs. desired/max; CPU/memory utilisation per task |
| ALB | Connection capacity | ActiveConnectionCount, RejectedConnectionCount |

**Verification**:
- Every AWS service has been enumerated, and every resource of each service has been identified
- Capacity constraints are documented for every resource of every AWS service
- Service quotas are identified for every resource of every AWS service
- Consumption-against-quota metrics are expressed as percentages of the limit, not raw absolute values
- Alarms exist that fire before quota exhaustion (e.g., at 80% consumption), not after
- The capacity metric approach is appropriate for the service type — not a generic "CPU utilisation" applied to serverless services

---

### Rule AIOBS-MET-007: Calculate Availability Correctly

**Rule**: Availability MUST be calculated as `Successful units of work / Total valid units of work`. Not uptime pings. Not health check pass rates. This provides an accurate Detect signal (AIOBS-STRAT-002) tied to real customer experience.

**Verification**:
- Availability dashboards use the correct formula
- MTBF and MTTR are tracked per service
- Availability is measured per API endpoint, not as a single site-wide average

---

### Rule AIOBS-MET-008: Instrument Latency P50 and P99 Per API Operation

**Rule**: Latency MUST be measured per API operation. Both P50 and P99 MUST be emitted. This provides Diagnose value (AIOBS-STRAT-002) — P50 shows typical experience, P99 shows tail latency affecting the worst-served customers.

**Verification**:
- P50 and P99 latency metrics are emitted per API operation at regular intervals
- Latency metrics include fault isolation dimensions (AIOBS-MET-005)
- Latency metrics are independent per API operation
- Latency metrics are visible on dashboards alongside availability and error rate

---

### Rule AIOBS-MET-009: Distinguish Request Error Rate from Customer Impact Rate

**Applies to**: Multi-tenant services

**Rule**: Server-side error metrics MUST separately track: (1) Percent of Requests with Errors and (2) Percent of Customers Affected. A 1% request error rate concentrated on a single tenant is different from 1% spread evenly. This supports accurate Assess Impact (AIOBS-STRAT-002).

**Verification**:
- Separate metrics exist for request error rate and customer impact rate
- Both metrics are visible on operational dashboards
