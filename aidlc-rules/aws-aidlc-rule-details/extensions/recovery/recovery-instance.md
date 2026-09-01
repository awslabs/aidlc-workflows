# Recovery — Instance Recovery Rules

## Overview
These rules define **how** to build, observe, test, and demonstrate instance-level recovery. They implement the recovery strategy defined in `extensions/recovery/recovery-baseline.md` for the instance recovery scope.

**Applies when**: The architecture contains horizontally scaled deployments (multiple instances of the same service). If all services are single-instance or serverless with no customer-controlled instance placement, skip this file entirely.

**Prefix**: `AIREC-INST-`

---

## Observability Dependency

Instance recovery rules depend on the following observability rules:

| AIREC Rule | Depends On | Why |
|---|---|---|
| AIREC-INST-001 | AIOBS-GFD-001, AIOBS-DIFF-001 | GFD-001 defines deep health checks; DIFF-001 drives Path A vs Path B decision |
| AIREC-INST-002 | AIOBS-GFD-001, AIOBS-DIFF-001 | Path B only applies when differential observability is active |
| AIREC-INST-003 | AIOBS-GFD-002 | Outlier detection is the trigger for targeted instance replacement |

When the observability extension is not active, these rules cannot be fully enforced. Apply the degradation behaviour defined in the Extension Dependencies section of `recovery-baseline.md`.

---

## Instance Recovery Strategy

### Rule AIREC-INST-000: Instance Recovery Strategy Selection

**Rule**: At the instance fault isolation boundary, the effective DR strategy (AIREC-STRAT-011) is **multi-site active/active**. Multiple instances run simultaneously behind a load balancer; traffic is routed around failed or degraded instances automatically. This is the standard pattern for horizontally scaled services.

This does not carry the metastable failure risks of active/active at region scope because: all instances share the same data tier (no write consistency trade-offs), and a load surge that overwhelms one instance is handled by auto scaling rather than by routing to a separate location that may also be overwhelmed.

| Strategy | Achievable RTO | Achievable RPO | Notes |
|---|---|---|---|
| Multi-site active/active | Sub-second–seconds | Zero | Standard pattern. Load balancer routes around failed instances immediately. No data loss — stateless compute, shared data tier. |

All other strategies are not applicable at instance scope.

**Verification**:
- Multiple instances are deployed behind a load balancer
- Load balancer health checks route around failed or degraded instances automatically

---

## Instance Recovery Architecture

### Rule AIREC-INST-000a: Implement Resilience Patterns for Instance Dependencies

**Rule**: All application components MUST implement resilience patterns to handle requests to instances that are impaired or being replaced. This mirrors the AZ-scope requirement (AIREC-AZ-004) applied at instance granularity:
- **Timeouts**: All outbound calls MUST have explicit timeouts — a slow instance must not block callers indefinitely
- **Retries with backoff and jitter**: Failed requests MUST be retried with exponential backoff and jitter; the load balancer will route retries to healthy instances
- **Circuit breakers**: Prevent cascading failures when a downstream instance is degraded
- **Graceful degradation**: Operations MUST degrade gracefully rather than failing the entire request

**Verification**:
- All outbound calls have explicit timeout configuration
- AWS SDK retry behaviour is configured
- Circuit breakers are implemented for all external dependencies
- Operations have graceful degradation paths

### Rule AIREC-INST-001: Choose a Health Check Strategy Based on Gray Failure Requirements

**Rule**: The model MUST select one of two health check strategies based on whether differential observability is active (`AIOBS-DIFF-001`). The choice determines how the load balancer health check and the auto scaling mechanism are wired together.

**Path A — Shallow health check (differential observability NOT active)**:
- Configure a shallow health check (TCP/HTTP liveness — is the process responding?) on the load balancer target group
- Wire the auto scaling mechanism health check type to `ELB` — the auto scaling mechanism uses the load balancer health check result to identify and replace genuinely unresponsive instances
- Simple, no additional mechanism required
- Limitation: does not detect gray failures (instance alive but degraded). Gray failure detection is out of scope when differential observability is not active.

**Path B — Deep health check + heartbeat mechanism (differential observability active, `AIOBS-DIFF-001`)**:
- Configure a deep health check (application logic + dependency connectivity) on the load balancer target group
- Do NOT wire the auto scaling mechanism health check type to `ELB` — this would cause fleeticide if a transient dependency failure causes all instances to fail the deep health check simultaneously, triggering bulk replacement of healthy capacity
- Implement a heartbeat mechanism to feed instance health to the auto scaling mechanism independently (see AIREC-INST-002)

**Decision rule**:
- `AIOBS-DIFF-001` active → Path B
- `AIOBS-DIFF-001` not active → Path A

**Verification**:
- Health check strategy is documented with rationale
- Path A: auto scaling mechanism health check type is set to `ELB`; health check is shallow
- Path B: auto scaling mechanism health check type is NOT set to `ELB`; deep health check is on the load balancer only; heartbeat mechanism is implemented (AIREC-INST-002)

---

### Rule AIREC-INST-002: Implement Heartbeat Mechanism for Path B

**Applies when**: Path B is selected (AIREC-INST-001).

**Rule**: When deep health checks are used for load balancer routing, a heartbeat mechanism MUST be implemented to provide the auto scaling mechanism with an independent signal of genuine instance unrecoverability. The recommended pattern:

1. On each load balancer health check poll, each instance performs a local health check and writes the result (healthy/unhealthy, timestamp) to a shared heartbeat store (e.g. DynamoDB table) keyed by instance ID
2. A periodic scanner (e.g. Lambda function on a schedule) reads the heartbeat store and identifies instances that are unhealthy or have not written within a defined staleness threshold (e.g. 5 minutes)
3. For each identified instance, the scanner calls the auto scaling `SetInstanceHealth` API to mark it unhealthy — the auto scaling mechanism then replaces it

**The heartbeat mechanism is itself a recovery control and MUST comply with**:
- `AIREC-STRAT-005` (static stability) — the heartbeat store and scanner MUST be outside the blast radius of the instances being monitored
- `AIREC-STRAT-006` (safe) — the scanner MUST implement velocity control: cap the number of instances marked unhealthy per invocation; when the cap is reached, stop and raise an alarm per `AIREC-STRAT-007`
- `AIREC-STRAT-007` (observable) — the heartbeat mechanism MUST be observable: alert if the scanner stops running or if the heartbeat store stops receiving writes

**Verification**:
- Heartbeat store is implemented and instances write to it on each health check poll
- Scanner runs on a schedule and identifies stale or unhealthy entries
- Scanner calls `SetInstanceHealth` for identified instances
- Scanner has velocity control — maximum instances marked unhealthy per invocation is bounded
- Heartbeat store and scanner are deployed outside the blast radius of the monitored instances
- Alerts exist for scanner failure and heartbeat store write failure

---

### Rule AIREC-INST-003: Trigger Targeted Replacement via Outlier Detection

**Rule**: Instance replacement for gray failures MUST be triggered by outlier detection (see `AIOBS-GFD-002`), not by bulk health check failure. When an instance is identified as a statistical outlier (disproportionate errors or latency), the recovery action MUST:
1. Remove the instance from load balancer routing (drain connections)
2. Terminate only the identified outlier instance
3. Wait for the replacement instance to pass health checks before considering further replacements

**Why**: Outlier detection identifies the specific instance causing disproportionate impact. Targeted replacement of that instance is precise and bounded — it cannot cascade into fleet-wide capacity loss.

**Verification**:
- Outlier detection alarms (see `AIOBS-GFD-002`) are wired to a targeted replacement action
- Replacement is scoped to the identified outlier only — not a bulk action
- Connection draining is configured before termination
- Replacement waits for health confirmation before proceeding

---

### Rule AIREC-INST-004: Rate-Limit All Capacity Removal Mechanisms

**Rule**: Every mechanism that removes compute capacity — auto scaling replacement, outlier-triggered termination, rolling deployments, automated runbook actions — MUST enforce a rate limit and a capacity safety check. No automated action may remove capacity if doing so would leave insufficient healthy capacity to serve current load.

**Rate limiting requirements**:
- Auto scaling replacement: configure maximum instance replacement rate (e.g. max 10% of desired capacity per replacement batch, with health check grace period between batches)
- Outlier-triggered termination: one instance at a time; next termination only after replacement is confirmed healthy
- Rolling deployments: minimum healthy percentage MUST be enforced (recommended: ≥ 50% healthy at all times during deployment)
- Automated runbook actions: any step that removes capacity MUST include a pre-check that verifies remaining capacity is sufficient

**Safety interlock**: If multiple instances are simultaneously identified as unhealthy or as outliers, this is a signal of a broader failure (AZ-level or dependency-level) — not an instance-level failure. In this case:
- Automated instance replacement MUST be suspended
- The AZ-level safety interlock (AIREC-AZ-008) MUST be evaluated
- The service team MUST be notified

**Verification**:
- Auto scaling mechanism has a maximum replacement rate configured
- Outlier-triggered termination is rate-limited to one instance at a time
- Rolling deployment minimum healthy percentage is configured
- A safety interlock exists that suspends automated replacement when multiple instances fail simultaneously
- Capacity safety checks are present in any automated runbook step that removes instances

---

## Instance Recovery Testing

### Rule AIREC-INST-005: Design Instance-Level Chaos Experiments

**Rule**: For each instance recovery control, the model MUST design a chaos experiment that validates the control works as designed. Experiments MUST cover both hard failure and gray failure scenarios.

**Hard failure experiment** (instance becomes unresponsive):
- Use AWS FIS `aws:ec2:stop-instances` or `aws:ecs:stop-task` to terminate a single instance
- Validate: load balancer routes around immediately; auto scaling mechanism replaces; service continues without customer impact

**Gray failure experiment** (instance alive but degraded):
- Use AWS FIS network latency injection or SSM-based application fault injection on a single instance
- Validate: deep health check routes around the degraded instance; outlier detection alarm fires; targeted replacement triggered; auto scaling mechanism does NOT bulk-replace the fleet

**Fleeticide prevention experiment** (transient dependency failure):
- Simulate a transient dependency failure affecting all instances simultaneously (e.g. brief database connectivity loss)
- Validate: deep health check causes routing changes but does NOT trigger auto scaling replacement; instances recover when dependency recovers; no capacity is lost

**Verification**:
- Chaos experiments exist for hard failure, gray failure, and fleeticide prevention scenarios
- Experiments validate that rate limiting prevents bulk capacity removal
- Experiments validate that the safety interlock fires when multiple instances fail simultaneously
- FIS safety controls are configured to stop experiments if unexpected alarms fire
- Experiments answer the three demonstration questions (AIREC-STRAT-009): recovery completes within RTO; traffic routes around the impaired instance; alarms detect and validate recovery
- Experiments are re-run after any significant architecture change
