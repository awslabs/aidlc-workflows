# Baseline Recovery Rules

## Overview
These rules define the recovery strategy that MUST be applied across all AI-DLC phases. They are cross-cutting constraints that govern how systems are designed, built, and validated to recover from failure — at the instance, AZ, and region scope.

**Scope**: Recovery rules apply at three scopes. The model MUST evaluate which scopes apply to the architecture and enforce rules accordingly:
- **Instance recovery** — single compute resource failure within an AZ
- **AZ recovery** — all resources within an Availability Zone become impaired
- **Region recovery** — all resources within an AWS Region become impaired

**Signal-Specific Rules**: The STRAT rules below define **what** to build and **why**. The **how** is defined in scope-specific rule files in `extensions/recovery/`. The model MUST scan that directory and load `.md` files when recovery rules are active during NFR Design, Code Generation, and Operations stages.

**Observability Dependency**: Recovery rules have a dependency on the observability extension. See the **Extension Dependencies** section below for how to handle cases where observability is not active.

**Loading based on user's recovery answer:**
- **Answer A (AWS best-practice)**: Load all `.md` files in `extensions/recovery/` EXCEPT `recovery-custom.md`
- **Answer B (AWS + custom)**: Load all `.md` files in `extensions/recovery/` INCLUDING `recovery-custom.md`
- **Answer C (custom only)**: Load ONLY `recovery-custom.md` from `extensions/recovery/`. Skip all other files. STRAT rules in this baseline file still apply as context.

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message.

### Blocking Recovery Finding Behavior
A **blocking recovery finding** means:
1. The finding MUST be listed in the stage completion message under a "Recovery Findings" section with the AIREC rule ID
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the AIREC rule ID and stage context

### Default Enforcement
All rules in this document and in the loaded `extensions/recovery/` files are **blocking** by default. If any rule's verification criteria are not met, it is a blocking recovery finding — follow the blocking finding behavior above. If a rule is not applicable to the current architecture, mark it as **N/A** with a documented rationale — this is not a blocking finding. Silent omission is not acceptable — if a rule cannot be satisfied, the model MUST investigate whether the chosen services provide the capability, document the gap, and present it as a blocking finding. All gaps MUST be logged to audit.md with rule ID, rationale, and severity.

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

1. **Service classification** (AIREC-STRAT-003): Classify every AWS service in the architecture as zonal / regional with zonal recovery control / regional without zonal recovery control / global. Present for customer validation.
2. **Recovery objectives per scope** (AIREC-STRAT-004): Define RTO and RPO per applicable recovery scope. Present Recovery Objectives question to customer.
3. **Applicable scope determination**: Based on service classification and architecture, determine which recovery scopes apply (instance, AZ, region). Load the corresponding scope-specific rule files from `extensions/recovery/`.
4. **Recovery controls design**: For each applicable scope, design recovery controls per the loaded scope rules. Include observability triggers, automation approach, and runbook integration.
5. **Observability dependency evaluation**: If the observability extension is not active, evaluate the Extension Dependencies section and present the risk validation to the customer before proceeding.
6. **DR strategy selection** (AIREC-STRAT-011): Select and document the DR strategy (Active/Passive Backup and Restore, Active/Passive Pilot Light, Active/Passive Warm Standby, Active/Passive Hot Standby, Active/Active Asynchronous, Active/Active Synchronous) with rationale.

**Verification**: NFR Design stage MUST NOT complete until all 6 outputs above are present in the NFR design artifacts. Missing outputs are blocking findings.

#### Operations

The model MUST validate every loaded rule against the generated artifacts (code, IaC, design documents, chaos experiment definitions). For each rule:
- Compliant → mark as passed
- Non-compliant → blocking finding: list the rule ID, what was expected, and what was found
- Not applicable → mark N/A with rationale

The Operations phase MUST NOT complete until all blocking findings are resolved or explicitly accepted by the customer with the decision logged to audit.

---

## RECOVERY STRATEGY

These rules define **what** recovery capability to build and **why**. They provide the strategic context that all scope-specific rules (instance, AZ, region) implement.

---

### Rule AIREC-STRAT-001: Accept Failure as Inevitable — Design for Recovery

**Rule**: Recovery-oriented architectures MUST start from the principle that failure will occur regardless of prevention effort. The model MUST design systems that limit the radius of failure impact, isolate customers from impairment, and recover rapidly — rather than relying solely on preventing failure.

The three metrics that define recovery capability are:
- **MTTR** (Mean Time To Recovery) — time from failure to restored normal operation
- **MTTD** (Mean Time To Detection) — time from failure to recovery start
- **MTBF** (Mean Time Between Failure) — time between normal operation and next failure

Recovery-oriented design reduces MTTR by: limiting blast radius, automating recovery controls, and enabling rapid isolation of customer impact before root cause analysis.

**Verification**:
- Recovery objectives (RTO, RPO) are defined per service and per recovery scope
- Architecture documentation explicitly addresses failure modes and recovery responses
- Recovery controls are designed to isolate customer impact first; root cause analysis is secondary

---

### Rule AIREC-STRAT-002: Understand Data Plane and Control Plane

**Rule**: Before classifying services for recovery responsibility, the model MUST understand the distinction between data plane and control plane functions. This distinction determines what recovery controls are possible and who is responsible for them.

**Data plane functions** deliver the core proposition of the service — the reason you buy it. If a data plane function is impaired, the service is not delivering its value to customers.

**Control plane functions** perform CRUDL (Create, Read, Update, Delete, List) operations *on* the data plane resources — they create and manage the environment in which the core proposition runs. If a control plane function is impaired, you cannot make changes, but the existing data plane continues to operate.

The same operation can be data plane in one service and control plane in another — it depends entirely on what the service is selling:

| Operation | Service | Plane | Why |
|---|---|---|---|
| Running a query | RDS | Data | Core proposition is a queryable database |
| Create DB instance | RDS | Control | CRUDL on a data plane resource |
| PutItem / GetItem | DynamoDB | Data | Core proposition is storing and retrieving items |
| CreateTable | DynamoDB | Control | CRUDL on a data plane resource (even though the table is the proposition — creating it is managing it, not using it) |
| Invoking a function | Lambda | Data | Core proposition is executing code on demand |
| Updating runtime environment | Lambda | Control | Configuring the managed execution environment AWS provides |
| Running an instance | EC2 | Data | Core proposition is a running virtual machine |
| Changing runtime / OS on an instance | EC2 | Data | Operating the VM you bought — the runtime is part of the proposition |
| Launching a new instance | EC2 | Control | CRUDL on a data plane resource |
| PutObject / GetObject | S3 | Data | Core proposition is object storage |
| CreateBucket | S3 | Control | CRUDL on a data plane resource |

**Verification**:
- Each AWS service in the architecture has its data plane proposition identified
- Data plane and control plane functions are distinguished in architecture documentation

---

### Rule AIREC-STRAT-003: Classify Services and Assign Recovery Responsibility

**Rule**: For every AWS service used in the architecture, the model MUST classify it into one of four categories and apply the corresponding recovery responsibility. Classification is based on whether the customer controls which AZ processes their request via a data plane mechanism.

**Zonal** — the customer specifies which AZ the data plane resource is deployed into. The data plane operates and fails independently per AZ.
- **Data plane blast radius**: Availability Zone — a failure is contained to the AZ the resource is deployed in
- Examples (from service documentation): EC2 (customer specifies AZ via subnet at launch), EBS (created in a specific AZ), RDS (customer specifies primary and standby AZ; the RDS console shows the AZ of the standby replica)
- Recovery responsibility: **Customer must build AZ recovery controls**

**Regional with zonal recovery control** — AWS manages AZ distribution internally but exposes ARC Zonal Shift as a data plane mechanism to evacuate an AZ. ARC documentation confirms zonal shift is supported for: Application Load Balancers, Network Load Balancers, EC2 Auto Scaling groups, and Amazon EKS.
- **Data plane blast radius**: Region — a complete regional failure affects the entire data plane; zonal shift only helps within a region
- Recovery responsibility: **Customer must configure and operate the zonal shift recovery control**

**Regional without zonal recovery control** — AWS manages routing and AZ recovery entirely. No data plane mechanism exists for the customer to control AZ-level request routing.
- **Data plane blast radius**: Region — a complete regional failure affects the entire data plane; no customer recovery control exists at any sub-regional scope
- Examples (from service documentation): Lambda ("Lambda runs your function in multiple Availability Zones" — customer has no AZ control), ECS Fargate (task placement strategies and constraints are not supported), Amazon SQS, Amazon DynamoDB, Amazon S3
- Note: ECS on EC2 allows task placement constraints by AZ, but these are best-effort placement hints — not a data plane routing control. Recovery control for ECS on EC2 must be implemented at the load balancer layer (ALB/NLB zonal shift).
- Recovery responsibility: **Customer focuses on observability, resilience patterns, and AWS assurance**

**Global** — control plane functions are global; the data plane is distributed across regions or edge locations.
- **Data plane blast radius**: Varies — the data plane (e.g. IAM AuthN/AuthZ, DNS resolution, CloudFront serving) is distributed and resilient to regional failures. However, the control plane (e.g. CreateRole, UpdateResourceRecordSet) is global — a misconfiguration propagates globally across all regions simultaneously.
- Examples: IAM, Route 53, CloudFront
- Recovery responsibility: **Customer focuses on observability and AWS assurance; avoid control plane operations in the recovery path (AIREC-REG-009)**

**Multi-region evaluation**: The data plane blast radius classification feeds the multi-region architecture decision during NFR Design (AIREC-REG-000). Any architecture containing non-zonal services (regional with zonal recovery control, regional without zonal recovery control, or global) has at least one service whose data plane blast radius extends beyond an Availability Zone. If the stated RTO requires bounded recovery from a failure beyond an AZ, multi-region resilience must be evaluated.

#### Classification Heuristic for Unlisted Services

When a service is not listed above, the model MUST apply this heuristic and document the reasoning:

1. Does the service expose ARC Zonal Shift support? (Check ARC supported resources documentation.) If yes → Regional with zonal recovery control.
2. Does the customer specify the AZ at resource creation and does the data plane run in that AZ? If yes → Zonal.
3. Does AWS manage AZ distribution with no customer recovery control? If yes → Regional without zonal recovery control or Global.
4. Flag uncertain classifications for human validation.

For services where the customer is not responsible for AZ recovery, the model MUST design:
- Observability to detect and scope the impact of an impairment
- Application-level resilience patterns (timeouts, retries, circuit breakers, graceful degradation)
- Assurance mechanisms (AWS Artifact, AWS Health Dashboard, AWS Audit Symposiums)

**Verification**:
- Each AWS service is classified as zonal, regional with zonal recovery control, regional without zonal recovery control, or global
- Classification reasoning is documented per service
- Zonal services have AZ recovery controls designed
- Regional-with-zonal-recovery-control services have ARC Zonal Shift configured
- Regional-without-zonal-recovery-control and global services have observability and resilience patterns designed

**Customer Validation**: Service classification drives all downstream recovery control decisions. The model MUST present the classification table to the customer for explicit approval before proceeding to recovery control design. Uncertain classifications flagged during the heuristic MUST be highlighted for human review.

```markdown
## Question: Service Classification Validation

Based on the architecture, the following service classifications have been identified:

| Service | Classification | Recovery Responsibility |
|---|---|---|
| [service] | [zonal / regional with zonal recovery control / regional without zonal recovery control / global] | [what must be done] |

A) Approve — these classifications are correct
B) Modify — one or more classifications need to change (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

---

### Rule AIREC-STRAT-004: Define Recovery Objectives Per Scope

**Rule**: Recovery objectives MUST be defined for each applicable recovery scope. The model MUST capture these during NFR Requirements and use them to drive recovery control design.

| Objective | Definition |
|-----------|-----------|
| RTO (Recovery Time Objective) | Maximum acceptable time from failure detection to restored service |
| RPO (Recovery Point Objective) | Maximum acceptable data loss measured in time |
| MTTR target | Target mean time to recovery across all failure events |

Recovery objectives drive the choice of recovery control:
- **RTO within minutes**: Requires automated recovery controls (zonal shift, auto scaling, automated failover)
- **RTO within hours**: May tolerate manual recovery procedures with runbook support
- **RTO within a business day**: May rely on AWS to resolve the underlying cause

**Verification**:
- RTO and RPO are defined for each service and each applicable recovery scope
- Recovery control design is traceable to the stated RTO
- Where RTO requires automation, automated controls are implemented — not just runbooks

**Customer Validation**: RTO and RPO are business decisions that cannot be inferred from architecture. The model MUST ask the customer to state them explicitly before designing recovery controls — every downstream design decision (automated vs manual, zonal shift vs runbook) depends on these values.

```markdown
## Question: Recovery Objectives

What are the recovery objectives for this system? Please complete the table for each applicable scope.

| Scope | RTO (max time to restore service) | RPO (max acceptable data loss) |
|---|---|---|
| Instance | | |
| AZ | | |
| Region (if applicable) | | |

A) Confirm — objectives are as stated above
B) Modify — I want to adjust the objectives (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

---

### Rule AIREC-STRAT-005: Prefer Evacuation Over Fix

**Rule**: Recovery controls MUST prioritise isolating customers from an impairment over fixing the underlying cause. The most effective recovery controls evacuate all requests from the impaired scope (instance, AZ, or region) and redirect them to healthy capacity.

This principle applies at every scope:
- **Instance**: Terminate and replace the impaired instance; redirect traffic to healthy instances
- **AZ**: Evacuate all traffic from the impaired AZ; redirect to healthy AZs
- **Region**: Fail over to a secondary region; redirect traffic away from the impaired region

Recovery controls MUST NOT require destructive changes or root cause resolution to restore customer service. Root cause analysis occurs after customer impact is mitigated.

**Verification**:
- Recovery controls are designed to evacuate/isolate, not to fix in place
- Recovery actions do not require changes to application code or configuration to execute
- Root cause analysis is decoupled from the recovery execution path
- Every recovery control satisfies AIREC-STRAT-006 (statically stable), AIREC-STRAT-008 (observable), and AIREC-STRAT-012 (customer-controllable)

---

### Rule AIREC-STRAT-006: Design Statically Stable Recovery Controls

**Rule**: Recovery controls MUST be statically stable — they MUST continue to function during the failure they are designed to recover from. A recovery control that depends on the same infrastructure it is recovering is not a recovery control.

Specifically:
- Recovery controls MUST NOT rely on control plane operations in the impaired scope where possible
- Data plane-controlled evacuation patterns are preferred over control plane-controlled patterns
- Recovery control infrastructure (automation, state stores, orchestration) MUST be outside the blast radius of the failure being recovered

Where control plane operations are unavoidable, the model MUST document the dependency and design compensating controls.

**Verification**:
- Every recovery control satisfies AIREC-STRAT-005 (evacuate over fix), AIREC-STRAT-008 (observable), and AIREC-STRAT-012 (customer-controllable)
- Static stability is documented in architecture artifacts

---

### Rule AIREC-STRAT-007: Recovery Controls Must Be Safe

**Rule**: Every recovery control MUST include safety checks to prevent the control itself from causing a failure. A recovery control that removes impaired capacity MUST NOT remove so much capacity that it starves the system.

Safety checks MUST verify before executing a recovery action:
- The remaining healthy capacity is sufficient to absorb the evacuated load
- The recovery action is scoped to the impaired boundary only (not broader)
- Multi-scope impairment is detected and automated recovery is disabled when more than one scope is simultaneously impaired

**When a safety limit is reached**: The recovery control MUST stop executing further actions immediately AND raise an alarm to notify the service team. Silent capping — where the control stops acting but does not alert — is not acceptable. A safety limit being reached is a signal that the failure scope is broader than the recovery control was designed for; human intervention is required.

**Verification**:
- Recovery controls include capacity safety checks before executing
- Automated recovery is disabled when multi-scope impairment is detected
- When a safety limit is reached, the control stops AND raises an alarm — it does not silently cap
- Safety check logic is tested as part of chaos experiments

---

### Rule AIREC-STRAT-008: Recovery Controls Must Be Observable

**Rule**: Every recovery control MUST be observable. The observability foundation is defined by the observability extension (see `AIOBS-STRAT-002` — Detect/Assess Impact/Diagnose goals; `AIOBS-STRAT-004` — fault isolation to the narrowest boundary). When both extensions are active, recovery rules extend observability — they do not replace it.

Recovery adds one specific requirement beyond the observability strategy: alarms MUST be designed to answer three questions before triggering a recovery action:
1. Is the abnormal behaviour impacting customer experience?
2. Is the scope of the abnormality limited to the boundary being evacuated/isolated?
3. Are the remaining healthy scopes ready to absorb the evacuated load?

When the observability extension is not active, recovery rules define the minimum observability floor needed to operate recovery controls safely.

**Verification**:
- Alarms exist that detect customer impact
- Alarms exist that identify the impaired scope (instance, AZ, or region)
- Alarms exist that validate healthy capacity before recovery is triggered
- Post-recovery alarms validate that customer impact has cleared
- Every recovery control satisfies AIREC-STRAT-005 (evacuate over fix), AIREC-STRAT-006 (statically stable), and AIREC-STRAT-012 (customer-controllable)

---

### Rule AIREC-STRAT-009: Recovery Must Be Demonstrable

**Rule**: Recovery controls MUST be tested to demonstrate they work as designed. Testing MUST answer three questions:
1. Do all people, process, and technology steps of the recovery plan work as expected and complete within the defined RTO?
2. Do recovery controls successfully isolate customers from the impairment?
3. Do system metrics and alarms correctly detect the impairment and validate recovery?

Testing MUST use chaos engineering to simulate failure outcomes. The model MUST design chaos experiments for each recovery control as part of the recovery design. Experiments MUST be integrated into the release pipeline for appropriate environments.

**Verification**:
- Chaos experiments are designed for each recovery control
- Experiments are integrated into the release pipeline or scheduled as game days
- Experiment results are documented and lessons learned are actioned
- Recovery controls are validated in production or a live-like environment

**Customer Validation**: The AI designs experiments but cannot confirm they ran, passed, or that lessons learned were actioned. The customer MUST confirm the demonstration status before the Operations phase is marked complete.

```markdown
## Question: Recovery Demonstration Status

Recovery chaos experiments have been designed. What is the current demonstration status?

A) Designed only — experiments will be run post-deployment (game day scheduled)
B) Experiments run and passed — results documented, lessons learned actioned
C) Experiments run with gaps identified — gaps recorded and scheduled for resolution
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

---

### Rule AIREC-STRAT-010: Embed Recovery in the Development Lifecycle

**Rule**: Recovery capability MUST be built into the development lifecycle — not added after deployment. The model MUST integrate recovery controls, observability, and testing into the design and build phases.

The recovery lifecycle MUST include:
- Recovery objectives defined during requirements
- Recovery controls designed during NFR Design
- Recovery controls implemented during Code Generation (application code and IaC)
- Recovery controls validated during Operations
- Chaos experiments integrated into release pipelines
- Game days scheduled as post-deployment activities
- Lessons learned from incidents fed back into recovery design

**Verification**:
- Recovery objectives are captured in NFR Requirements artifacts
- Recovery controls are present in IaC and application code
- Chaos experiments exist for each recovery control
- A process exists for feeding incident lessons learned back into recovery design

**Recovery Lifecycle Guidance**: The following process commitments represent best practice for sustaining recovery capability. They cannot be verified by the AI or checked in code — they are organisational responsibilities. The model MUST surface this guidance at Operations phase completion and log it to `aidlc-docs/audit.md`.

```markdown
## Recovery Lifecycle Guidance

The following best-practice processes support sustained recovery capability.
These are organisational commitments that cannot be verified automatically:

| Process | Best Practice |
|---|---|
| Chaos experiments in pipeline | Integrate experiments into the release pipeline for pre-production environments so recovery is validated on every deployment |
| Game days | Schedule post-deployment game days to validate recovery controls with production workload and volumes, including all relevant stakeholders |
| Incident feedback | Establish a process to feed lessons learned from production incidents back into recovery design — new failure modes discovered in production MUST update chaos experiment hypotheses |

AWS guidance:
- Chaos engineering and game days: AWS Fault Injection Service documentation
- Incident feedback and operational learning: AWS Well-Architected Framework — Operational Excellence pillar
```

---

### Rule AIREC-STRAT-011: DR Strategy Framework

**Rule**: The model MUST understand the five DR strategies before evaluating recovery controls for any fault isolation scope. Each strategy defines what is deployed in the secondary location and how recovery is executed. RTO/RPO ranges, risks, and guidance for each strategy at a specific fault isolation boundary are defined in the scope-specific HOW rules.

| Recovery Model | Strategy | Data Tier | Compute Tier | Cost |
|---|---|---|---|---|
| Active/Passive | Backup and restore | Point-in-time backup — restore required on failover | Not deployed | Lowest |
| Active/Passive | Pilot light | Continuously replicated — in-flight writes at time of failure require reconciliation | Scaled to 0 — scale to production on failover | Low |
| Active/Passive | Warm standby | Continuously replicated — in-flight writes at time of failure require reconciliation | Scaled to reduced capacity — scale to production on failover | Medium |
| Active/Passive | Hot standby | Continuously replicated — in-flight writes at time of failure require reconciliation | Full production capacity — passive; secondary does not serve live traffic | High |
| Active/Active | Asynchronous | Each location accepts writes; application implements write-global, write-local, or write-partitioned; conflict resolution required | Full capacity in all locations; all serve live traffic | Highest |
| Active/Active | Synchronous | Writes committed to all locations before succeeding; zero data loss; introduces write latency and correlated failure risk; requires quorum design | Full capacity in all locations; all serve live traffic | Highest |

**Key principle**: The data tier is staged and ready in all strategies except backup and restore. The strategies differ in how much compute is pre-provisioned and therefore how fast failover can complete.

**Verification**:
- The model can identify which strategy is in use for each fault isolation scope
- Strategy selection is documented with rationale per scope
- For active/active: the replication approach (async with write consistency strategy, or synchronous) is explicitly documented

---
---
### Rule AIREC-STRAT-012: Recovery Controls MUST Be Customer-Controllable

**Rule**: Every recovery control MUST provide an explicit mechanism that the customer can trigger via CLI or API. Where technically possible, the mechanism MUST be a data plane operation that satisfies AIREC-STRAT-006. If no data plane mechanism exists for the service, a control plane mechanism is acceptable provided it is documented with rationale and the customer explicitly accepts the risk that it may be unavailable during the failure it is designed to recover from. Automatic health check-based failover alone does not satisfy this requirement — it provides no explicit customer-triggered recovery control for testing, game days, or manual intervention.

**Verification**:
- Every recovery control has a documented CLI or API command the customer can use to explicitly trigger it
- Every recovery control satisfies AIREC-STRAT-005 (evacuate over fix), AIREC-STRAT-006 (statically stable, data plane operation), and AIREC-STRAT-008 (observable)

---
## Extension Dependencies

### Observability Extension

Recovery rules depend on the observability extension for alarm-driven automated recovery. When the observability extension is not active, affected rules are degraded to manual-only. Once the customer accepts the degradation (via the risk validation below), the degraded rules are treated as **non-blocking** — they are enforced in their manual-only form and do not prevent stage completion.

The following AIREC rules reference AIOBS rules directly:

| AIREC Rule | Depends On |
|---|---|
| AIREC-STRAT-008 | AIOBS-STRAT-002, AIOBS-STRAT-004 |
| AIREC-INST-001 | AIOBS-GFD-001, AIOBS-DIFF-001 |
| AIREC-INST-002 | AIOBS-GFD-001, AIOBS-DIFF-001 |
| AIREC-INST-003 | AIOBS-GFD-002 |
| AIREC-REG-003 | AIOBS-ALARM-005, AIOBS-CLIENT-001 |
| AIREC-AZ-007 | AIOBS-MET-005, AIOBS-ALARM-005, AIOBS-GFD-003 |
| AIREC-AZ-008 | AIOBS-ALARM-002, AIOBS-ALARM-005 |
| AIREC-AZ-009 | AIOBS-CLIENT-001, AIOBS-CLIENT-003, AIOBS-DIFF-001 |
| AIREC-AZ-011 | AIOBS-GFD-003 |
| AIREC-AZ-013 | AIOBS-ALARM-005, AIOBS-CLIENT-001 (required for autoshift) |

**When the observability extension is active**: Recovery rules apply in full. Automated recovery controls are driven by observability alarms as designed.

**When the observability extension is NOT active**: The model MUST:

1. **Degrade automated recovery to manual-only** — all recovery controls that would be triggered by an alarm MUST be redesigned as manually triggered only. No automated recovery action may execute without explicit human initiation.
2. **Flag the affected rules** — list each AIREC rule above that cannot be fully enforced, with the specific AIOBS dependency that is missing.
3. **Present the risk for customer validation** — using the format below. The model MUST NOT proceed past this point until the customer explicitly acknowledges.
4. **Log to audit** — record the customer's acknowledgement in `aidlc-docs/audit.md` with: the AIREC rule IDs affected, the missing AIOBS dependencies, the manual-only constraint applied, and the customer's explicit acceptance.

**Risk validation format**:

```markdown
## Recovery Dependency Risk: Observability Extension Not Active

The following recovery rules have dependencies on the observability extension, which is not active for this project:

| AIREC Rule | Missing Dependency | Impact |
|---|---|---|
| AIREC-AZ-007 | AIOBS-MET-005, AIOBS-ALARM-005, AIOBS-GFD-003 | AZ-scoped detection cannot be fully enforced |
| AIREC-AZ-008 | AIOBS-ALARM-002, AIOBS-ALARM-005 | Automated recovery triggering cannot be implemented |
| AIREC-AZ-009 | AIOBS-CLIENT-001, AIOBS-CLIENT-003, AIOBS-DIFF-001 | Per-AZ customer experience signals cannot be enforced |
| AIREC-AZ-011 | AIOBS-GFD-003 | Gray failure detection cannot be validated |
| AIREC-REG-003 | AIOBS-ALARM-005, AIOBS-CLIENT-001 | Per-region trigger signals cannot be enforced |

**Constraint applied**: All recovery controls will be manual-only. No automated recovery action will execute without explicit human initiation.

**Risk**: Without observability-driven automation, recovery time depends on human detection and manual execution. This may prevent meeting RTO objectives that require automated recovery.

Do you accept this risk and wish to proceed with manual-only recovery controls?

A) Yes — accept the risk, proceed with manual-only recovery controls, log to audit
B) No — enable the observability extension to support automated recovery
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

---
