# Recovery — AZ Recovery Rules

## Overview
These rules define **how** to build, observe, test, and demonstrate Availability Zone recovery. They implement the recovery strategy defined in `extensions/recovery/recovery-baseline.md` for the AZ recovery scope.

**Applies when**: The architecture contains at least one service classified as **zonal** or **regional with zonal recovery control** (AIREC-STRAT-003). If no such services exist, skip this file entirely.

**Prefix**: `AIREC-AZ-`

---

## AZ Recovery Strategy

### Rule AIREC-AZ-000: AZ Recovery Strategy Selection

**Rule**: At the AZ fault isolation boundary, the effective DR strategy (AIREC-STRAT-011) depends on the service architecture as determined by the service classification (AIREC-STRAT-003). Possible strategies at AZ scope:

| Recovery Model | Strategy | Achievable RTO | Achievable RPO | AZ-Scope Notes |
|---|---|---|---|---|
| Active/Active | Synchronous | Seconds | Near-zero | All AZs serve live traffic. Within-region replication is synchronous for most AWS services. Zonal shift or health check mechanism routes traffic away from an impaired AZ. |
| Active/Passive | Hot Standby | Seconds–low minutes | Near-zero | Passive capacity pre-provisioned in each AZ. Within-region replication is synchronous for most AWS services. Zonal shift or health check mechanism routes traffic to passive capacity on AZ failure. |
| Active/Passive | Warm Standby | Minutes | Near-zero | Zonal services only. Reduced capacity in each AZ — alarms trigger a runbook to scale before traffic can be routed. |
| Active/Passive | Pilot Light | Tens of minutes | Near-zero | Zonal services only. Minimal capacity per AZ — alarms trigger a runbook to scale before traffic can be routed. |
| Active/Passive | Backup and Restore | Hours | Hours | Zonal services only. No pre-provisioned capacity — alarms trigger a runbook to restore infrastructure stack and data before traffic can be routed. |

**Capacity**: At AZ scope, capacity is pre-provisioned in each AZ as part of normal multi-AZ deployment. No capacity reservations are required — the capacity already exists. Static stability (AIREC-STRAT-006) requires that each AZ has sufficient pre-provisioned capacity to absorb the load from a failed AZ without relying on auto scaling during the impairment.

**Verification**:
- AZ recovery architecture pre-provisions capacity in each AZ (Active/Active or Active/Passive Hot Standby)
- Zonal shift is configured as the traffic routing mechanism

---

## AZ Recovery Architecture

### Rule AIREC-AZ-001: Classify Each Service by AZ Recovery Responsibility

**Rule**: For every AWS service used in the architecture, the model MUST classify it using the taxonomy defined in AIREC-STRAT-002 and document the recovery responsibility:

| Classification | AZ Recovery Responsibility | Action Required |
|---|---|---|
| Zonal | Customer | Implement AZ recovery controls (AIREC-AZ-002 through AIREC-AZ-006) |
| Regional with zonal recovery control | Customer (operate the recovery control) | Configure and operate ARC Zonal Shift (AIREC-AZ-013) |
| Regional without zonal recovery control | AWS | Observability, resilience patterns, AWS assurance (AIREC-AZ-007) |
| Global | AWS | Observability and AWS assurance (AIREC-AZ-007) |

**Verification**:
- Every AWS service in the architecture is classified per AIREC-STRAT-002
- Classification reasoning is documented per service
- Zonal services have explicit AZ recovery controls designed
- Regional-with-zonal-recovery-control services have ARC Zonal Shift configured

---

### Rule AIREC-AZ-002: Implement AZ Traffic Evacuation for Zonal Services

**Rule**: For zonal services, the architecture MUST include a data plane-controlled mechanism to evacuate all inbound requests from a disrupted AZ. The evacuation mechanism MUST:
- Be data plane-controlled where possible (preferred over control plane-controlled) — see AIREC-STRAT-006
- Be statically stable (AIREC-STRAT-006) — it MUST function during the AZ disruption it is designed to recover from
- Evacuate all request types entering the service via the disrupted AZ

**Preferred evacuation patterns** (in order of preference):
1. **ARC Zonal Shift** — for services using Application Load Balancer (ALB) or Network Load Balancer (NLB) with cross-zone load balancing disabled. Zonal autoshift MUST be evaluated and enabled where appropriate.
2. **Route 53 ARC routing controls** — for DNS-based traffic management where ALB/NLB zonal shift is not sufficient or for non-HTTP traffic flows.
3. **Control plane-controlled evacuation** — only where data plane patterns are not available. Document the dependency and design compensating controls for static stability.

**Verification**:
- An AZ evacuation mechanism is designed for every zonal service
- ALB/NLB deployments have cross-zone load balancing disabled to enable zonal shift
- ARC Zonal Shift is configured for all eligible load balancers
- Zonal autoshift is evaluated; if not enabled, the decision is documented with rationale
- Control plane dependencies in recovery controls are documented

---

### Rule AIREC-AZ-003: Implement AZ Independence for Critical Workloads

**Rule**: For workloads with low-latency requirements or where AZ-level shared fate must be minimised, the architecture MUST implement Availability Zone Independence (AZI):
- Per-AZ endpoints MUST be created for services where AZI is applicable
- Application logic MUST prioritise communicating with endpoints in the same AZ
- Cross-AZ traffic MUST be minimised to reduce shared fate risk and data transfer costs

**AZI implementation patterns**:
- Use zonal DNS names provided by AWS PrivateLink, ALB, and NLB for per-AZ endpoint resolution
- Use Amazon EFS which automatically resolves DNS to an IP in the same AZ
- For Amazon RDS: use zonal read replicas for read operations; design application to use the local read replica so read operations continue during primary node failover

Where AZI cannot be fully implemented (e.g., RDS write operations restricted to a single primary node), the model MUST document the limitation and design compensating controls.

**Verification**:
- AZI applicability is evaluated for each service in the architecture
- Per-AZ endpoints are used where AZI is implemented
- Application routing logic prioritises same-AZ endpoints
- AZI limitations are documented with compensating controls

---

### Rule AIREC-AZ-004: Implement Resilience Patterns for Cross-AZ Dependencies

**Rule**: All application components MUST implement resilience patterns to handle requests to endpoints in an impaired AZ:

- **Timeouts**: All outbound calls MUST have explicit timeouts configured — a slow AZ endpoint must not block callers indefinitely.

- **Adaptive retries with backoff and jitter**: Failed requests MUST be retried using AWS SDK **adaptive retry mode** (retry quota) in preference to standard retry mode. Standard retries amplify load on a failing dependency by retrying unconditionally; adaptive retries back off when the retry quota is exhausted, preventing work amplification during systemic failures. Retries help for transient failures (individual component failure); they harm for systemic failures (AZ impairment, dependency overload) — the retry quota limits the damage in the systemic case.

- **AZI-aware retry routing** (where AZ Independence is implemented, AIREC-AZ-003): The retry strategy MUST be aware of per-AZ endpoints:
  - First retry → same AZ endpoint (handles transient instance failure without cross-AZ traffic)
  - Subsequent retries → cross-AZ endpoint (the AZ may be impaired; retrying the same AZ endpoint is futile)
  - This buys time for zonal shift to execute while limiting unnecessary cross-AZ traffic

- **Per-AZ circuit breakers**: Circuit breakers MUST be scoped per AZ endpoint — not a single circuit breaker across all AZs. A single circuit breaker would open on AZ failure and block requests to healthy AZs. Per-AZ circuit breakers isolate the impaired AZ while allowing healthy AZs to continue serving requests.

- **Graceful degradation**: Operations MUST degrade gracefully where the architecture supports it — either returning a response with the feature removed or accepting the request and completing it asynchronously via loose coupling.

**Verification**:
- All outbound calls have explicit timeout configuration
- AWS SDK retry mode is set to adaptive (not standard) or equivalent retry quota is implemented
- Where AZI is implemented, retry routing is AZI-aware (same AZ first, cross-AZ on subsequent retries)
- Circuit breakers are scoped per AZ endpoint, not across all AZs
- Operations have graceful degradation paths documented and implemented

---

### Rule AIREC-AZ-005: Ensure Compute Capacity Spans Multiple AZs

**Rule**: Compute resources MUST be distributed across a minimum of two AZs (three recommended). Auto Scaling groups and container services MUST be configured to:
- Distribute capacity evenly across AZs
- Replace capacity in healthy AZs when an AZ becomes impaired (not attempt to replace in the disrupted AZ)
- Not attempt to scale into a disrupted AZ during an impairment

**Verification**:
- Compute resources are deployed across a minimum of two AZs
- Auto Scaling groups span multiple AZs with balanced distribution
- Auto Scaling is configured to replace capacity in healthy AZs during AZ impairment

---

### Rule AIREC-AZ-006: Ensure Data Tier Supports AZ Recovery

**Rule**: Data tier services MUST be configured to support AZ recovery without data loss:
- **Multi-AZ clusters**: Database clusters MUST use synchronous replication across AZs. Primary node failover to a secondary node in a healthy AZ MUST be automatic.
- **Failover time**: Automated failover MUST complete within the stated RTO
- **Read replicas**: Where AZI is implemented, zonal read replicas MUST be deployed and application logic MUST route reads to the local replica
- **Caches**: Distributed caches MUST be configured in cluster mode across multiple AZs

**Verification**:
- Database clusters use synchronous multi-AZ replication
- Automated failover is enabled and tested
- Failover time is validated against the stated RTO
- Zonal read replicas are deployed where AZI is implemented

---

## AZ Recovery Observability

### Rule AIREC-AZ-007: Implement AZ-Scoped Observability for All Services

**Rule**: For all services (zonal, regional, and global), the architecture MUST include observability that can detect and scope an AZ impairment. This applies even where the customer is not responsible for AZ recovery — observability is required to detect impact, assess scope, and validate AWS recovery.

The observability foundation is provided by:
- `AIOBS-MET-005` — fault isolation dimensions on metrics (per-AZ dimensions required)
- `AIOBS-ALARM-005` — composite alarms per fault isolation boundary (per-AZ composite alarms required)
- `AIOBS-GFD-003` — AZ-level gray failure detection

Recovery adds the requirement that observability MUST address all three AZ impairment patterns:

1. **Single AZ clearly impacted**: One AZ is significantly worse than others. Per-AZ composite alarms (`AIOBS-ALARM-005`) produce the confident single-AZ impairment signal.
2. **Multiple AZs show impact, one is an outlier**: Outlier detection across per-AZ metrics (`AIOBS-GFD-003`) identifies the statistically different AZ.
3. **All AZs show impact via a shared resource**: A single primary node (e.g., RDS primary) is impaired. Primary-node-specific metrics and dimensions detect and scope this pattern.

**Verification**:
- All metrics are published with per-AZ dimensions (see `AIOBS-MET-005`)
- Per-AZ composite alarms exist (see `AIOBS-ALARM-005`)
- AZ-level gray failure detection is implemented (see `AIOBS-GFD-003`)
- Observability covers all three AZ impairment patterns above

---

### Rule AIREC-AZ-008: Design Recovery-Triggering Observability

**Rule**: The observability used to trigger AZ recovery controls extends the per-AZ composite alarms defined in `AIOBS-ALARM-005` and the composite alarm design in `AIOBS-ALARM-002`. Recovery adds the requirement that those alarms MUST be wired into two specific alarm flows:

**Single-AZ impairment alarm flow**:
1. Overall customer impact alarm fires
2. Per-AZ impairment alarm identifies the specific impaired AZ
3. Per-AZ alarm triggers the recovery control to evacuate the impaired AZ
4. Overall customer impact alarm clears (validates recovery success)
5. Per-AZ impairment alarm clears (validates AZ health restored)
6. Service team returns the evacuated AZ to service

**Multi-AZ impairment safety interlock** (prevents automated recovery from removing healthy capacity during a broader failure):
1. Overall customer impact alarm fires
2. All-AZs-impaired alarm fires (detects multi-AZ scope)
3. All-AZs alarm triggers safety interlock:
   - Disables automated recovery controls
   - Disables change pipelines
   - Notifies the service team of multi-AZ impairment
4. Service team responds manually

**Verification**:
- Per-AZ composite alarms are wired to trigger the AZ evacuation recovery control
- An all-AZs-impaired alarm exists as a safety interlock
- Automated recovery controls are disabled when multi-AZ impairment is detected
- Both alarm flows are documented and validated by chaos experiments

---

### Rule AIREC-AZ-009: Include Customer Experience Metrics with AZ Scope

**Rule**: Customer experience metrics with AZ scope are defined by `AIOBS-CLIENT-001` (synthetic canaries for all customer journeys confirmed during Infrastructure Design), `AIOBS-CLIENT-003` (fault isolation dimensions on client-side metrics), and `AIOBS-DIFF-001` (both client-side and server-side observability).

Recovery adds one specific requirement: canaries MUST target each AZ endpoint individually. Canaries that only target an aggregate DNS alias cannot identify which AZ is impacted and MUST NOT be used as the sole customer experience signal for recovery triggering.

**Verification**:
- Synthetic canaries target each AZ endpoint individually (see `AIOBS-CLIENT-001`)
- Client-side metrics include per-AZ dimensions (see `AIOBS-CLIENT-003`)
- No recovery-triggering alarm relies solely on an aggregate DNS alias metric

---

## AZ Recovery Testing

### Rule AIREC-AZ-010: Design AZ Chaos Experiments

**Rule**: For each AZ recovery control, the model MUST design a chaos experiment that simulates the outcome of an AZ power interruption. The experiment MUST simulate:
- All resources in the disrupted AZ becoming uncontactable (pause network connectivity to/from all subnets in the AZ)
- Capacity loss in the disrupted AZ (terminate/stop zonal service resources)
- Primary node failover for clusters with a primary in the disrupted AZ
- Auto Scaling stopping attempts to replace capacity in the disrupted AZ

**AWS FIS actions to use**:
- `aws:network:disrupt-connectivity` — pause subnet connectivity to simulate AZ network failure
- `aws:ec2:asg-insufficient-instance-capacity-error` with `availabilityZoneIdentifiers` — simulate EC2 capacity unavailability in the AZ
- `aws:ec2:stop-instances` / `aws:ecs:stop-task` — terminate zonal resources
- FIS AZ power interruption scenario — for zonal compute and storage/database services

**Verification**:
- A chaos experiment is designed for each AZ recovery control
- Experiments simulate AZ power interruption outcomes (not just partial failures)
- FIS safety controls are configured to stop experiments if alarms fire unexpectedly
- Automated rollback mechanisms are implemented for all custom SSM-based experiments

---

### Rule AIREC-AZ-011: Design Gray Failure AZ Chaos Experiments

**Rule**: In addition to hard failure experiments (AIREC-AZ-010), the model MUST design gray failure experiments that simulate partial AZ impairment — specifically increased latency affecting a subset of consumers in one AZ. The observability that detects gray failure is defined in `AIOBS-GFD-003`.

Recovery adds the requirement to validate that the gray failure detection alarms are correctly wired to recovery controls — specifically that recovery is NOT triggered by gray failure alone, only by confirmed customer impact + AZ scope.

**Gray failure simulation patterns**:
- Add latency and jitter to network interfaces of in-scope resources using FIS native actions (ECS/EKS on EC2)
- Use AWS FIS `aws:ssm:send-command` with `AWSFIS-Run-Network-Latency` SSM document for EC2-based resources
- Use SSM parameter-triggered application logic to inject request latency for Fargate/Lambda workloads

**Hypothesis to validate**:
- Per-AZ outlier detection alarms fire when one AZ shows statistically different latency (see `AIOBS-GFD-003`)
- Recovery controls are NOT triggered by gray failure alone — only by customer impact + AZ scope confirmation
- Customer experience metrics detect the gray failure before system metrics

**Verification**:
- Gray failure chaos experiments are designed for each AZ
- Outlier detection alarms are validated by gray failure experiments
- Experiments confirm that recovery controls are not triggered prematurely

---

### Rule AIREC-AZ-012: Validate Recovery Experiments Answer the Three Demonstration Questions

**Rule**: Every AZ recovery chaos experiment MUST be designed to answer the three demonstration questions:
1. Do all people, process, and technology steps of the recovery plan work as expected and complete within the defined RTO?
2. Do recovery controls successfully evacuate all requests from the impaired AZ?
3. Do system metrics and alarms correctly detect the impairment and validate that requests are isolated from the impaired AZ after recovery?

Experiments MUST be run in a live-like environment before production. Game days MUST be scheduled as post-deployment activities to validate all recovery components with production workload and volumes.

**Verification**:
- Each experiment has a documented hypothesis addressing all three demonstration questions (AIREC-STRAT-009): recovery completes within RTO; all requests are evacuated from the impaired AZ; alarms detect the impairment and validate recovery
- Experiment results are documented with pass/fail against each hypothesis
- Game days are scheduled and include all relevant stakeholders (service team, incident management, technology risk)
- Lessons learned from experiments are actioned before the next experiment cycle
- Experiments are re-run after any significant architecture change

---

## AZ Recovery Tooling

### Rule AIREC-AZ-013: Use ARC for AZ Recovery Control

**Rule**: Amazon Route 53 Application Recovery Controller (ARC) MUST be evaluated as the primary AZ recovery control mechanism. ARC provides:
- **Zonal Shift**: Immediately shifts traffic away from an impaired AZ for ALB/NLB with cross-zone load balancing disabled
- **Zonal Autoshift**: Automatically shifts traffic when AWS identifies a potential AZ impairment; includes practice runs that regularly test the shift mechanism
- **Readiness Checks**: Continuously monitors resource quotas, capacity, and configuration
- **Safety Rules**: Configurable rules that prevent recovery actions which would be unsafe (e.g., removing too much capacity)
- **Routing Controls**: DNS-based recovery controls integrated with Route 53 for complex failover scenarios

**Zonal Autoshift — observability dependency and customer decision**:

Zonal Autoshift MUST NOT be enabled unless the observability extension is active with per-AZ composite alarms (`AIOBS-ALARM-005`) and per-AZ customer experience metrics (`AIOBS-CLIENT-001`). Without these, practice runs execute but you cannot validate whether they succeeded or caused customer impact, and autoshift triggers cannot be confirmed as effective.

If observability is active, the model MUST present autoshift as a customer decision with the following trade-offs:

```markdown
## Question: Zonal Autoshift

ARC Zonal Autoshift automatically shifts traffic away from an AZ when AWS internal
telemetry detects a potential impairment — before your own alarms may fire.

Trade-offs to consider:

For autoshift:
- Faster recovery — AWS may detect and shift before your alarms trigger
- Practice runs regularly validate the shift mechanism with real traffic
- Reduces MTTD and MTTR for AZ impairments

Against autoshift:
- AWS triggers based on its own telemetry, not yours — may shift when your
  application is unaffected (false positive), causing unnecessary capacity reduction
- Shifts and practice runs occur on AWS's schedule — may happen during peak
  traffic or maintenance windows
- You lose direct control over when AZ shifts are initiated

A) Enable autoshift — accept AWS-triggered shifts; configure practice runs
B) Disable autoshift — use manual zonal shift only, triggered by your own alarms
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**Verification**:
- ARC is evaluated for all multi-AZ services
- Zonal Shift is configured for all ALB/NLB deployments with cross-zone load balancing disabled
- Zonal Autoshift is only enabled if observability extension is active with AIOBS-ALARM-005 and AIOBS-CLIENT-001
- If autoshift is enabled, customer has explicitly accepted the trade-offs and practice runs are configured
- If autoshift is disabled, the decision is documented with rationale
- ARC Readiness Checks are configured for all resources
- ARC Safety Rules are configured to prevent unsafe recovery actions
- Return-to-AZ procedures use ARC Readiness Checks or health-based thresholds — not immediate re-enablement after an impairment clears
- For ALB deployments with cross-zone load balancing disabled, `target_group_health.dns_failover.minimum_healthy_targets.count` is configured to prevent overwhelming pre-scaled capacity as the AZ is reactivated

---

### Rule AIREC-AZ-014: Use AWS FIS for AZ Recovery Testing

**Rule**: AWS Fault Injection Service (FIS) MUST be used as the primary chaos engineering tool for AZ recovery testing. FIS provides:
- API-driven integration with pipeline automation
- Fine-grained resource targeting with IAM-controlled permissions
- Experiment scope aligned to AWS fault isolation boundaries
- Automated safety controls that respond to CloudWatch alarms
- Automated rollback on experiment completion or stop
- Native AZ-specific actions (AZ power interruption, ASG capacity errors)

For services without native FIS actions, SSM documents MUST be used with FIS to create custom actions. Custom SSM automation MUST implement rollback mechanisms that capture pre-experiment state and restore it on experiment completion.

**Verification**:
- FIS is used for all AZ chaos experiments
- FIS experiments have CloudWatch alarm-based safety controls configured
- FIS experiments have automated rollback configured
- Custom SSM-based experiments implement state capture and rollback
- Custom experiment infrastructure is deployed outside the experiment blast radius

---

### Rule AIREC-AZ-015: Integrate AZ Recovery into the Release Pipeline

**Rule**: AZ recovery validation MUST be integrated into the release pipeline for appropriate environments:
- Automated configuration rules MUST evaluate AWS resource configurations in pre-production and production to alert when resources are not using desired recovery-oriented services and configurations
- Chaos experiments MUST be integrated into the release pipeline for environments where they are practical to execute
- Game days MUST be scheduled as post-deployment activities for production validation
- Recovery control effectiveness MUST be re-validated after any significant architecture change

**Verification**:
- Automated configuration checks exist for recovery-critical resource settings (e.g., cross-zone load balancing disabled, ARC configured)
- Chaos experiments are integrated into the release pipeline for at least one pre-production environment
- Game days are scheduled post-deployment
- A process exists to re-validate recovery controls after architecture changes
