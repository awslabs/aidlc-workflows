# Baseline Resiliency Rules

## Overview
These resiliency rules are MANDATORY cross-cutting constraints that apply across all AI-DLC phases. They are derived from established cloud reliability frameworks (such as the AWS Well-Architected Reliability Pillar and 
resilience best practices) and apply to workloads on any cloud provider. The rules are organized across six pillars: Business Goals, Change Management & Automation, Integrated Observability, High Availability, Disaster Recovery, and Continuous Improvement.

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message to the user.

### Blocking Resiliency Finding Behavior
A **blocking resiliency finding** means:
1. The finding MUST be listed in the stage completion message under a "Resiliency Findings" section with the RESILIENCY rule ID and description
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the RESILIENCY rule ID, description, and stage context

If a RESILIENCY rule is not applicable to the current project (e.g., RESILIENCY-07 when no stateful data exists), mark it as **N/A** in the compliance summary — this is not a blocking finding.

### Default Enforcement
All rules in this document are **blocking** by default. If any rule's verification criteria are not met, it is a blocking resiliency finding — follow the blocking finding behavior defined above.

### Verification Criteria Format
Verification items in this document are plain bullet points describing compliance checks. They are distinct from the `- [ ]` / `- [x]` progress-tracking checkboxes used in stage plan files. Each item should be evaluated as compliant or non-compliant during review.

### User Decision Points (the model MUST ask, NOT decide)
This extension follows the AI-DLC principle that architectural and process decisions belong to the user, not the LLM. The model MUST present the clarifying questions defined in the rules below and use the user's answers — it MUST NOT silently choose on the user's behalf. The decisions explicitly deferred to the user are:

| Decision | Rule | Question presented |
|---|---|---|
| RTO/RPO targets and DR strategy | RESILIENCY-02 | DR strategy selection (Backup&Restore → Active/Active) |
| Change management process | RESILIENCY-03 | Use existing org process vs propose vs exempt |
| CI/CD tooling | RESILIENCY-04 | Use existing pipeline vs propose |
| Rollback mechanism | RESILIENCY-04 | Version redeploy / blue-green / canary / DB-aware / existing |
| Deployment style | RESILIENCY-04 | Direct / rolling / blue-green / canary |
| Regional topology | RESILIENCY-08 | Single-region multi-zone vs multi-region active-passive/active |
| Incident response process | RESILIENCY-15 | Use existing org process vs propose |
| Resiliency testing approach | RESILIENCY-14 | Use existing practice vs propose vs defer to Operations |

Where an organization already has a process (change management, CI/CD, incident response, DR testing), the model MUST reference and conform to it rather than inventing a new one.

---

## PILLAR 1: BUSINESS GOALS

---

## Rule RESILIENCY-01: Critical Workload Identification and Prioritization

**Rule**: Every project MUST identify and document its critical workloads and their business impact:
- **Workload classification**: Each deployable component MUST be classified by business criticality (Critical, High, Medium, Low)
- **Business impact analysis**: The impact of each component's unavailability MUST be documented (revenue loss, user impact, regulatory consequences)
- **Dependency mapping**: Critical workloads MUST have their upstream and downstream dependencies identified and documented

**Verification**:
- Design documentation includes a workload criticality classification for each component
- Business impact of unavailability is documented for critical and high-priority components
- Dependency maps exist showing upstream and downstream service relationships

---

## Rule RESILIENCY-02: Availability and Recovery Targets

**Rule**: Every production workload MUST have defined availability and recovery targets aligned with business expectations:
- **SLA definition**: A target availability percentage MUST be defined (e.g., 99.9%, 99.99%)
- **RTO (Recovery Time Objective)**: The maximum acceptable downtime MUST be defined for each critical workload
- **RPO (Recovery Point Objective)**: The maximum acceptable data loss window MUST be defined for each workload with persistent state
- **Alignment**: Availability targets MUST be validated against business requirements — over-engineering and under-engineering are both findings

**Verification**:
- Each critical workload has a documented SLA target
- RTO is defined and documented for each critical workload
- RPO is defined and documented for each workload with persistent data
- Targets are justified by business requirements (not arbitrary)

**Follow-up Question (ask before finalizing requirements)**:

Before finalizing the Requirements phase, the model MUST ask the user the following clarifying question to capture recovery targets and establish the Disaster Recovery strategy. The user's answer directly drives DR strategy selection in RESILIENCY-11 and data protection decisions in RESILIENCY-12.

```markdown
## Question: RTO/RPO Goals and Disaster Recovery Strategy
What are your Recovery Time Objective (RTO) and Recovery Point Objective (RPO) goals? These determine the appropriate Disaster Recovery strategy and infrastructure redundancy level.

A) RPO/RTO: Hours — Backup & Restore strategy. Lowest cost ($). Data backed up, no services deployed. Redeploy from IaC and restore from backups on failure. Suitable for non-critical workloads.

B) RPO/RTO: 10s of minutes — Pilot Light strategy. Cost: $$. Data live, services idle. Infrastructure deployed but not running, scaled up on failover. Suitable for important workloads.

C) RPO/RTO: Minutes — Warm Standby strategy. Cost: $$$. Data live, services run at reduced capacity. Scaled up during failover. Suitable for business-critical applications.

D) RPO/RTO: Near real-time — Multi-site Active/Active strategy. Highest cost ($$$$). Data live, live services in multiple regions simultaneously. Suitable for mission-critical, zero-downtime requirements.

E) N/A — Single-region deployment is acceptable, no cross-region DR needed. Rely on multi-zone availability within one region.

X) Other (please describe after [Answer]: tag below)

[Answer]: 
```

The user's selected RTO/RPO targets MUST be documented in the requirements output and propagated to all downstream stages (Application Design, NFR Requirements, NFR Design, Infrastructure Design).

---

## PILLAR 2: CHANGE MANAGEMENT & AUTOMATION

---

## Rule RESILIENCY-03: Change Management Process

**Rule**: Every project MUST integrate with a change management process that minimizes the risk of change-induced failures. The default expectation is that the organization already HAS a change management process — this rule directs the project to identify and conform to it, not to invent a new one.

**Clarifying Question (ask during Requirements; do not assume an answer)**:

```markdown
## Question: Change Management Process
How should production changes for this workload be governed? AI-DLC will conform the design to your answer rather than inventing a process.

A) Use our existing organizational change management process — provide the name/tool (e.g., ServiceNow, Jira Change, internal CAB). AI-DLC will reference it and ensure deployable artifacts fit that process (change records, approval gates).

B) No formal process exists yet — AI-DLC should propose a lightweight change management process (change record + approval + rollback note) for the team to adopt.

C) N/A — this workload is exempt from formal change management (e.g., internal tooling). Document the exemption rationale.

X) Other (describe after [Answer]: tag below)

[Answer]: 
```

**Verification**:
- The change management process is identified by name (existing org process) OR explicitly proposed/exempted per the user's answer
- Production changes reference the identified process for approval and change records
- Change history mechanism is identified (existing tool or proposed)

**Note**: If the user selects A, the model MUST NOT redefine the process — only reference it and ensure artifacts (e.g., deployment configs, runbooks) are compatible with it.

---

## Rule RESILIENCY-04: Automated Deployment and Rollback

**Rule**: All production deployments ideally should be automated, and the rollback approach MUST be explicitly chosen by the user — not inferred by the model. The project MUST reuse the organization's existing CI/CD tooling and deployment conventions where they exist.

**Definitions** (to remove ambiguity):
- **Rollback**: The defined mechanism to return the running workload to its last known-good state after a failed deployment. This rule does NOT assume a specific mechanism — the user selects one below.
- **Deployment style**: The strategy used to release a change (direct/in-place, rolling, blue/green, or canary).

**Clarifying Questions (ask during Requirements or NFR Design; do not assume answers)**:

```markdown
## Question: CI/CD and Deployment Tooling
What CI/CD tooling and deployment process should this workload use?

A) Use our existing CI/CD pipeline — provide the tool (e.g., GitHub Actions, GitLab CI, Jenkins, CodePipeline). AI-DLC will produce artifacts compatible with it.

B) No pipeline exists — AI-DLC should propose a CI/CD pipeline definition appropriate to the chosen IaC and runtime.

X) Other (describe after [Answer]: tag below)

[Answer]: 

## Question: Rollback Mechanism
How should a failed production deployment be rolled back?

A) Redeploy previous IaC/artifact version (version-pinned rollback)

B) Blue/green swap back to the previous environment

C) Canary auto-rollback on health/metric regression

D) Database-aware rollback required (schema/data migration reversal) — flag for explicit design

E) Use our organization's existing rollback procedure — provide reference

X) Other (describe after [Answer]: tag below)

[Answer]: 

## Question: Deployment Style
What deployment strategy is acceptable for this workload's risk profile?

A) Direct / in-place (lowest cost, highest blast radius) — acceptable for non-critical workloads

B) Rolling (gradual instance replacement)

C) Blue/green (zero-downtime cutover, higher cost)

D) Canary (progressive traffic shift with automated rollback)

X) Other (describe after [Answer]: tag below)

[Answer]: 
```

**Verification**:
- IaC tool is identified (existing org standard or user-selected)
- CI/CD pipeline is identified (existing) or proposed per the user's answer
- Rollback mechanism is explicitly selected by the user and documented (not inferred)
- Deployment style is explicitly selected by the user and matches the workload's criticality from RESILIENCY-01
- For database-aware rollbacks (Question 2, option D), a migration reversal approach is documented

---

## PILLAR 3: INTEGRATED OBSERVABILITY

---

## Rule RESILIENCY-05: Monitoring and Alerting for Critical Workloads

**Rule**: Every deployed workload MUST have monitoring configured across the three pillars of observability — metrics, logs, and traces:
- **Metrics**: Key operational metrics MUST be collected (latency, error rate, throughput, saturation) for each component
- **Logs**: Structured logging MUST be configured and routed to a centralized log service
- **Traces**: For distributed systems with multiple services, distributed tracing MUST be configured to track requests across service boundaries
- **Dashboards**: A monitoring dashboard MUST be defined showing key health indicators for the workload

**Verification**:
- Each component has metrics collection configured (using a cloud-native or third-party observability platform)
- Structured logging is routed to a centralized service
- Distributed tracing is configured for multi-service architectures (N/A for single-service)
- A dashboard definition or configuration exists for operational health monitoring

---

## Rule RESILIENCY-06: Health Checks

**Rule**: Every production component MUST implement health checks that accurately reflect its ability to serve traffic:
- **Shallow health checks**: Every service MUST expose a basic health endpoint that confirms the process is running
- **Deep health checks**: Critical services MUST implement deep health checks that verify connectivity to downstream dependencies (databases, caches, external APIs)
- **Load balancer integration**: Health checks MUST be integrated with load balancers or service discovery to enable automatic traffic routing away from unhealthy instances
- **Synthetic monitoring**: Public-facing endpoints SHOULD have synthetic canary monitoring to detect availability issues from the user's perspective

**Verification**:
- Each service exposes a health check endpoint
- Deep health checks verify downstream dependency connectivity for critical services
- Health checks are integrated with load balancers or routing mechanisms
- Synthetic monitoring is configured for public-facing endpoints (or documented as not applicable)

---

## Rule RESILIENCY-07: Resiliency Monitoring

**Rule**: The resiliency posture of deployed workloads MUST be actively monitored:
- **Resiliency assessment**: Workloads SHOULD be registered with a resiliency assessment tool (cloud-provider-native or third-party) for continuous resiliency posture evaluation
- **Alarm configuration**: Alarms MUST be configured for conditions that indicate resiliency degradation (e.g., single-zone operation, replication lag, backup failures)
- **Capacity monitoring**: Auto-scaling metrics and capacity utilization MUST be monitored to detect scaling limits before they cause outages

**Verification**:
- Resiliency-specific alarms are configured (not just operational alarms)
- Capacity and scaling metrics are monitored
- Resiliency assessment tooling is configured or documented as a future improvement

---

## PILLAR 4: HIGH AVAILABILITY

---

## Rule RESILIENCY-08: Multi-Zone and Multi-Region Deployment

**Rule**: Production workloads MUST have an explicitly chosen fault-isolation topology. The multi-zone baseline is required for production; the multi-region decision MUST be made by the user (driven by the RTO/RPO answer in RESILIENCY-02), not inferred by the model.

**Multi-zone baseline (required for production)**:
- **Compute**: Compute resources (VMs, container clusters) MUST be distributed across at least 2 availability zones. Serverless services are typically multi-zone by default.
- **Data stores**: Databases and caches MUST use multi-zone configurations (replicated, clustered, or globally distributed)
- **Load balancing**: Traffic MUST be distributed across zones using a load balancer or DNS-based routing
- **Static stability**: The architecture MUST continue operating if one zone becomes unavailable, without requiring control plane operations to recover

**Multi-region decision (user-driven — do not infer)**:

The choice between single-region multi-zone and multi-region is a cost/complexity tradeoff that MUST be made by the user. If the RESILIENCY-02 answer was D (Active/Active) or C (Warm Standby with cross-region scope), multi-region is implied — confirm with the user. Otherwise ask:

```markdown
## Question: Regional Topology
Does this workload require multi-region deployment, or is single-region with multi-zone redundancy sufficient?

A) Single-region, multi-zone — tolerates zone failure, not full-region failure. Lower cost. (Aligns with RTO/RPO options A/B/E.)

B) Multi-region active-passive — survives region failure with failover. Higher cost. (Aligns with Warm Standby / Pilot Light cross-region.)

C) Multi-region active-active — survives region failure with no downtime. Highest cost. (Aligns with Active/Active.)

X) Other (describe after [Answer]: tag below)

[Answer]: 
```

**Verification**:
- Compute resources are deployed across 2+ availability zones (or use inherently multi-zone serverless services)
- Data stores use multi-zone configurations
- Load balancing distributes traffic across zones
- The multi-region topology is explicitly selected by the user and consistent with the RTO/RPO target from RESILIENCY-02
- Architecture documentation confirms static stability (no control plane dependency for zone failover)

---

## Rule RESILIENCY-09: Auto-Scaling and Capacity Management

**Rule**: Production workloads MUST implement auto-scaling to handle load variations and prevent capacity-induced outages:
- **Auto-scaling policies**: Compute resources MUST have auto-scaling configured with appropriate scaling triggers (CPU, memory, request count, custom metrics)
- **Scaling limits**: Minimum and maximum capacity limits MUST be defined to prevent both under-provisioning and runaway scaling
- **Pre-warming**: For workloads with predictable traffic patterns, scheduled scaling or pre-warming SHOULD be configured
- **Serverless limits**: Serverless functions MUST have concurrency limits configured to prevent downstream service overload
- **Service quota awareness**: Teams MUST identify cloud provider service quotas and limits relevant to the workload (e.g., function concurrency, API request rates, storage request limits) and document any quotas that require increases before production launch. Quota utilization SHOULD be monitored and alarmed at an 80% threshold.

**Verification**:
- Auto-scaling is configured for compute resources (or serverless is used)
- Minimum and maximum scaling limits are defined
- Scaling triggers are appropriate for the workload pattern
- Serverless concurrency limits are configured where applicable
- Relevant cloud provider service quotas are identified and documented
- Quota increase requests are planned for any limits that may be exceeded under expected load

---

## Rule RESILIENCY-10: Dependency Isolation and Circuit Breaking

**Rule**: Applications MUST implement patterns to prevent cascading failures from dependency outages:
- **Timeouts**: All external calls (HTTP, database, cache) MUST have explicit timeouts configured — no unbounded waits
- **Circuit breakers**: Services calling external dependencies SHOULD implement circuit breaker patterns to fail fast when a dependency is unhealthy
- **Bulkheads**: Critical workloads SHOULD isolate dependency pools (connection pools, thread pools) to prevent one failing dependency from exhausting shared resources
- **Graceful degradation**: Applications MUST define degraded-mode behavior when non-critical dependencies are unavailable

**Verification**:
- All external calls have explicit timeouts configured
- Circuit breaker patterns are implemented for critical external dependencies (or documented as not applicable)
- Graceful degradation behavior is documented for non-critical dependency failures
- Connection pools and resource limits are configured to prevent resource exhaustion

---

## PILLAR 5: DISASTER RECOVERY

---

## Rule RESILIENCY-11: DR Strategy Selection

**Rule**: Every production workload with persistent state MUST have a documented disaster recovery strategy appropriate to its RTO/RPO targets:
- **Strategy selection**: Choose from established DR strategies based on business requirements:
  - Backup & Restore (RTO/RPO: hours) — lowest cost
  - Pilot Light (RTO/RPO: tens of minutes) — data live, services idle
  - Warm Standby (RTO/RPO: minutes) — data live, services at reduced capacity
  - Hot Standby / Active-Passive (RTO/RPO: minutes) — data live, services ready
  - Active/Active (RTO/RPO: real-time) — highest cost, zero downtime
- **Cost alignment**: The DR strategy cost MUST be justified by the business impact of downtime
- **Documentation**: The chosen DR strategy MUST be documented with clear failover and failback procedures

**Verification**:
- A DR strategy is selected and documented for each critical workload
- The strategy aligns with defined RTO/RPO targets (RESILIENCY-02)
- Failover and failback procedures are documented
- DR strategy cost is justified against business impact

---

## Rule RESILIENCY-12: Data Backup and Replication

**Rule**: All persistent data MUST be backed up and/or replicated according to the defined RPO:
- **Automated backups**: Database and storage backups MUST be automated using a managed backup service or scheduled job (e.g., automated database snapshots, object storage versioning, or equivalent)
- **Cross-region replication**: Critical data SHOULD be replicated to a secondary region for regional disaster scenarios
- **Backup validation**: Backup integrity MUST be periodically validated through test restores
- **Retention policy**: Backup retention periods MUST be defined and aligned with business and compliance requirements
- **Encryption**: Backups MUST be encrypted at rest

**Verification**:
- Automated backup is configured for all persistent data stores
- Cross-region replication is configured for critical data (or documented as not required with justification)
- Backup retention policies are defined
- Backup encryption is enabled
- A backup validation process is documented (even if manual)

---

## Rule RESILIENCY-13: Failover and Recovery Procedures

**Rule**: Every DR strategy MUST have documented and tested failover and recovery procedures:
- **Runbooks**: Step-by-step failover and failback runbooks MUST be documented
- **Automation**: Failover procedures SHOULD be automated where possible (e.g., DNS health-check based routing, managed database global replication, dedicated disaster recovery services)
- **Communication plan**: A communication plan for stakeholders during DR events MUST be defined
- **Recovery validation**: Post-failover validation steps MUST be documented to confirm the workload is operating correctly in the DR environment

**Verification**:
- Failover runbooks exist with step-by-step procedures
- Failback procedures are documented
- Automated failover mechanisms are configured where applicable
- Post-failover validation steps are defined

---

## PILLAR 6: CONTINUOUS IMPROVEMENT

---

## Rule RESILIENCY-14: Chaos Engineering and DR Testing

**Rule**: Resiliency mechanisms MUST have a defined testing approach. Where the organization already has DR testing or chaos engineering practices, this rule directs the project to reference them rather than invent new ones.

**Clarifying Question (ask during NFR Design; do not assume)**:

```markdown
## Question: Resiliency Testing Approach
How will resiliency mechanisms (failover, recovery) be validated?

A) Use our existing DR testing / game day / chaos engineering practice — provide the reference. AI-DLC will document test scenarios that fit it.

B) No practice exists — AI-DLC should propose a DR testing schedule and chaos experiment plan for adoption.

C) Defer to the Operations phase — capture test scenarios now, execute during Operations.

X) Other (describe after [Answer]: tag below)

[Answer]: 
```

**Verification**:
- A resiliency testing approach is identified (existing practice, proposed plan, or deferred to Operations per the user's answer)
- DR test scenarios are documented for the selected DR strategy (RESILIENCY-11)
- Test results tracking mechanism is identified (existing or proposed)

**Note**: Execution of chaos experiments and DR drills is an Operations-phase activity. This rule ensures the test scenarios and schedule are captured at design time so Operations has a defined starting point.

---

## Rule RESILIENCY-15: Incident Response and Correction of Errors

**Rule**: Every project MUST integrate with an incident response process. As with change management, the default expectation is that the organization already HAS an incident response process — this rule directs the project to reference and conform to it.

**Clarifying Question (ask during Requirements or NFR Design; do not assume)**:

```markdown
## Question: Incident Response Process
How are production incidents handled for this workload?

A) Use our existing incident response process — provide the reference (e.g., PagerDuty runbooks, internal IR/on-call process). AI-DLC will align alerting and runbooks to it.

B) No formal process exists — AI-DLC should propose a lightweight incident response and Correction of Errors (COE) process for adoption.

X) Other (describe after [Answer]: tag below)

[Answer]: 
```

**Verification**:
- The incident response process is identified by name (existing) or proposed per the user's answer
- A COE/post-mortem mechanism is identified (existing org practice or proposed)
- Alerting from RESILIENCY-05 routes into the identified incident response process
- Corrective action tracking mechanism is identified

**Note**: If the user selects A, the model MUST reference the existing process and ensure observability/alerting integrates with it — not redefine it.

---

## Enforcement Integration

These rules are cross-cutting constraints that apply to every AI-DLC stage. At each stage:
- Evaluate all RESILIENCY rule verification criteria against the artifacts produced
- Include a "Resiliency Compliance" section in the stage completion summary listing each rule as compliant, non-compliant, or N/A
- If any rule is non-compliant, this is a blocking resiliency finding — follow the blocking finding behavior defined in the Overview
- Include resiliency rule references in design documentation, infrastructure templates, and test instructions

---

## Appendix: Reliability Pillar Mapping (AWS Well-Architected)

The following table maps each rule to a corresponding concept in the AWS Well-Architected Reliability Pillar. This mapping is informational and demonstrates alignment with one of the most established cloud reliability frameworks. The rules themselves are cloud-provider-agnostic.

| RESILIENCY Rule | Reliability Concept |
|---|---|
| RESILIENCY-01 | Workload architecture — understand business impact |
| RESILIENCY-02 | Design for availability — define recovery objectives |
| RESILIENCY-03 | Change management — control changes |
| RESILIENCY-04 | Deployment automation — automate changes |
| RESILIENCY-05 | Monitor workload resources — observability |
| RESILIENCY-06 | Design interactions to prevent failures — health checks |
| RESILIENCY-07 | Monitor workload resources — resiliency posture |
| RESILIENCY-08 | Use fault isolation — multi-zone |
| RESILIENCY-09 | Design for horizontal scaling — auto-scaling |
| RESILIENCY-10 | Design interactions to prevent failures — circuit breaking |
| RESILIENCY-11 | Plan for disaster recovery — strategy selection |
| RESILIENCY-12 | Back up data — automated backups |
| RESILIENCY-13 | Design for recovery — failover procedures |
| RESILIENCY-14 | Test reliability — chaos engineering and DR testing |
| RESILIENCY-15 | Operate and observe — incident response and learning |

## Appendix: Resilience Readiness Pillar Mapping (AWS RRR)

The following table maps each rule to a pillar in the AWS Resilience Readiness Review (RRR) framework. This mapping is informational; the rules apply to any cloud provider.

| Resiliency Assessment Area | RESILIENCY Rules |
|---|---|
| Business Goals | RESILIENCY-01, RESILIENCY-02 |
| Change Management & Automation | RESILIENCY-03, RESILIENCY-04 |
| Integrated Observability | RESILIENCY-05, RESILIENCY-06, RESILIENCY-07 |
| High Availability | RESILIENCY-08, RESILIENCY-09, RESILIENCY-10 |
| Disaster Recovery | RESILIENCY-11, RESILIENCY-12, RESILIENCY-13 |
| Continuous Improvement | RESILIENCY-14, RESILIENCY-15 |
