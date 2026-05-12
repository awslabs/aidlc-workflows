# Baseline Resiliency Rules

## Overview
These resiliency rules are MANDATORY cross-cutting constraints that apply across all AI-DLC phases. They are derived from the AWS Resilience Readiness Review (RRR) assessment framework, which evaluates workloads across six pillars: Business Goals, Change Management & Automation, Integrated Observability, High Availability, Disaster Recovery, and Continuous Improvement.

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

---

## PILLAR 2: CHANGE MANAGEMENT & AUTOMATION

---

## Rule RESILIENCY-03: Change Management Process

**Rule**: Every project MUST have a documented change management process that minimizes the risk of change-induced failures:
- **Change documentation**: All production changes MUST be documented with scope, risk assessment, and rollback plan
- **Change approval**: Changes to critical workloads MUST require explicit approval before deployment
- **Change history**: A record of all production changes MUST be maintained for post-incident analysis

**Verification**:
- A change management process is documented (or referenced from organizational standards)
- Production changes include rollback plans
- Change history is auditable

---

## Rule RESILIENCY-04: Automated Deployment and Rollback

**Rule**: All production deployments MUST be automated with clearly defined rollback procedures:
- **Infrastructure as Code**: All infrastructure MUST be defined using IaC (CloudFormation, Terraform, CDK, or equivalent) — no manual console changes in production
- **Automated deployment**: A CI/CD pipeline or automated deployment process MUST be defined
- **Rollback procedure**: Every deployment MUST have a documented and tested rollback mechanism
- **Blue/green or canary**: Critical workloads SHOULD use progressive deployment strategies (blue/green, canary, or rolling) to limit blast radius

**Verification**:
- All infrastructure is defined in IaC templates (no manual resource creation)
- Deployment steps are automated or scripted (not manual console clicks)
- Rollback procedures are documented for each deployable component
- Deployment strategy is documented (direct, rolling, blue/green, canary)

---

## PILLAR 3: INTEGRATED OBSERVABILITY

---

## Rule RESILIENCY-05: Monitoring and Alerting for Critical Workloads

**Rule**: Every deployed workload MUST have monitoring configured across the three pillars of observability — metrics, logs, and traces:
- **Metrics**: Key operational metrics MUST be collected (latency, error rate, throughput, saturation) for each component
- **Logs**: Structured logging MUST be configured and routed to a centralized log service (see also SECURITY-03 if security extension is enabled)
- **Traces**: For distributed systems with multiple services, distributed tracing MUST be configured to track requests across service boundaries
- **Dashboards**: A monitoring dashboard MUST be defined showing key health indicators for the workload

**Verification**:
- Each component has metrics collection configured (CloudWatch, Prometheus, or equivalent)
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
- **Resiliency assessment**: Workloads SHOULD be registered with AWS Resilience Hub (or equivalent) for continuous resiliency assessment
- **Alarm configuration**: Alarms MUST be configured for conditions that indicate resiliency degradation (e.g., single-AZ operation, replication lag, backup failures)
- **Capacity monitoring**: Auto-scaling metrics and capacity utilization MUST be monitored to detect scaling limits before they cause outages

**Verification**:
- Resiliency-specific alarms are configured (not just operational alarms)
- Capacity and scaling metrics are monitored
- Resiliency assessment tooling is configured or documented as a future improvement

---

## PILLAR 4: HIGH AVAILABILITY

---

## Rule RESILIENCY-08: Multi-AZ Deployment

**Rule**: All production workloads MUST be deployed across multiple Availability Zones to mitigate datacenter-level failures:
- **Compute**: Compute resources (EC2, ECS, EKS) MUST be distributed across at least 2 AZs. Serverless services (Lambda, Fargate) are inherently multi-AZ.
- **Data stores**: Databases and caches MUST use multi-AZ configurations (RDS Multi-AZ, ElastiCache Multi-AZ, DynamoDB global tables or on-demand)
- **Load balancing**: Traffic MUST be distributed across AZs using a load balancer (ALB, NLB) or DNS-based routing
- **Static stability**: The architecture MUST be able to continue operating if one AZ becomes unavailable, without requiring control plane operations to recover

**Verification**:
- Compute resources are deployed across 2+ AZs (or use inherently multi-AZ serverless services)
- Data stores use multi-AZ configurations
- Load balancing distributes traffic across AZs
- Architecture documentation confirms static stability (no control plane dependency for AZ failover)

---

## Rule RESILIENCY-09: Auto-Scaling and Capacity Management

**Rule**: Production workloads MUST implement auto-scaling to handle load variations and prevent capacity-induced outages:
- **Auto-scaling policies**: Compute resources MUST have auto-scaling configured with appropriate scaling triggers (CPU, memory, request count, custom metrics)
- **Scaling limits**: Minimum and maximum capacity limits MUST be defined to prevent both under-provisioning and runaway scaling
- **Pre-warming**: For workloads with predictable traffic patterns, scheduled scaling or pre-warming SHOULD be configured
- **Serverless limits**: Serverless functions MUST have concurrency limits configured to prevent downstream service overload
- **Service quota awareness**: Teams MUST identify AWS service quotas relevant to the workload (e.g., Lambda concurrency, API Gateway request rates, S3 request limits) and document any quotas that require increases before production launch. Quota utilization SHOULD be monitored and alarmed at 80% threshold.

**Verification**:
- Auto-scaling is configured for compute resources (or serverless is used)
- Minimum and maximum scaling limits are defined
- Scaling triggers are appropriate for the workload pattern
- Serverless concurrency limits are configured where applicable
- Relevant AWS service quotas are identified and documented
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
- **Automated backups**: Database and storage backups MUST be automated (AWS Backup, RDS automated backups, S3 versioning, or equivalent)
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
- **Automation**: Failover procedures SHOULD be automated where possible (Route 53 health checks, Aurora Global Database failover, Elastic Disaster Recovery)
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

**Rule**: Resiliency mechanisms MUST be tested regularly to validate they work as expected:
- **DR drills**: DR failover procedures MUST be tested at least annually (more frequently for critical workloads)
- **Chaos experiments**: Production or pre-production environments SHOULD run controlled chaos experiments (AWS Fault Injection Service or equivalent) to discover unknown failure modes
- **Game days**: Teams SHOULD conduct periodic game days to practice incident response and validate runbooks
- **Test documentation**: All resiliency tests MUST be documented with results, findings, and remediation actions

**Verification**:
- DR testing schedule is defined (at minimum annually)
- Chaos engineering approach is documented (even if planned for future implementation)
- Test results and findings are tracked and remediated
- Game day or incident simulation exercises are planned or conducted

---

## Rule RESILIENCY-15: Incident Response and Correction of Errors

**Rule**: Every project MUST have an incident response process and a mechanism for learning from failures:
- **Incident response plan**: A documented incident response process MUST exist covering detection, triage, mitigation, and resolution
- **Correction of Errors (COE)**: Post-incident reviews MUST be conducted for all significant outages, documenting root cause, timeline, impact, and corrective actions
- **Action tracking**: Corrective actions from COEs MUST be tracked to completion
- **Knowledge sharing**: Lessons learned from incidents MUST be shared with the broader team

**Verification**:
- An incident response plan is documented (or referenced from organizational standards)
- A COE/post-mortem process is defined
- Corrective action tracking mechanism exists
- Knowledge sharing process is documented

---

## Enforcement Integration

These rules are cross-cutting constraints that apply to every AI-DLC stage. At each stage:
- Evaluate all RESILIENCY rule verification criteria against the artifacts produced
- Include a "Resiliency Compliance" section in the stage completion summary listing each rule as compliant, non-compliant, or N/A
- If any rule is non-compliant, this is a blocking resiliency finding — follow the blocking finding behavior defined in the Overview
- Include resiliency rule references in design documentation, infrastructure templates, and test instructions

---

## Appendix: AWS Well-Architected Reliability Pillar Mapping

| RESILIENCY Rule | Well-Architected Reliability Concept |
|---|---|
| RESILIENCY-01 | Workload architecture — understand business impact |
| RESILIENCY-02 | Design for availability — define recovery objectives |
| RESILIENCY-03 | Change management — control changes |
| RESILIENCY-04 | Deployment automation — automate changes |
| RESILIENCY-05 | Monitor workload resources — observability |
| RESILIENCY-06 | Design interactions to prevent failures — health checks |
| RESILIENCY-07 | Monitor workload resources — resiliency posture |
| RESILIENCY-08 | Use fault isolation — multi-AZ |
| RESILIENCY-09 | Design for horizontal scaling — auto-scaling |
| RESILIENCY-10 | Design interactions to prevent failures — circuit breaking |
| RESILIENCY-11 | Plan for disaster recovery — strategy selection |
| RESILIENCY-12 | Back up data — automated backups |
| RESILIENCY-13 | Design for recovery — failover procedures |
| RESILIENCY-14 | Test reliability — chaos engineering and DR testing |
| RESILIENCY-15 | Operate and observe — incident response and learning |

## Appendix: RRR Assessment Pillar Mapping

| RRR Assessment Pillar | RESILIENCY Rules |
|---|---|
| Business Goals | RESILIENCY-01, RESILIENCY-02 |
| Change Management & Automation | RESILIENCY-03, RESILIENCY-04 |
| Integrated Observability | RESILIENCY-05, RESILIENCY-06, RESILIENCY-07 |
| High Availability | RESILIENCY-08, RESILIENCY-09, RESILIENCY-10 |
| Disaster Recovery | RESILIENCY-11, RESILIENCY-12, RESILIENCY-13 |
| Continuous Improvement | RESILIENCY-14, RESILIENCY-15 |
