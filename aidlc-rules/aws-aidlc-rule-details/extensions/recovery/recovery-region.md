# Recovery — Region Recovery Rules

## Overview
These rules define **how** to build, observe, test, and demonstrate region-level recovery. They implement the recovery strategy defined in `extensions/recovery/recovery-baseline.md` for the region recovery scope.

**Applies when**: The customer selects multi-region architecture (Answer A to AIREC-REG-000) during NFR Design. If the customer selects single-region (Answer B), skip this file and log the accepted trade-off to audit.

**Prerequisite**: Multi-region recovery is only appropriate after single-region resilience is in place. The model MUST verify that AZ recovery rules (`recovery-az.md`) have been applied before designing region recovery controls. A multi-region architecture built on a fragile single-region foundation will not improve overall availability and may reduce it.

**Prefix**: `AIREC-REG-`

---

## Observability Dependency

Region recovery detection uses the same observability stack as AZ recovery — per-region composite alarms, customer experience metrics, and canaries. The AIOBS rules cover this. Region recovery rules add only the recovery control requirements.

| AIREC Rule | Depends On | Why |
|---|---|---|
| AIREC-REG-003 | AIOBS-ALARM-005, AIOBS-CLIENT-001 | Per-region alarms and canaries are the trigger signal for region failover |

When the observability extension is not active, apply the degradation behaviour defined in the Extension Dependencies section of `recovery-baseline.md`.

---

## Multi-Region Architecture Decision

### Rule AIREC-REG-000: Evaluate Multi-Region Need During NFR Design

**Applies at**: NFR Design stage — after service classification (AIREC-STRAT-003) is customer-validated and RTO/RPO (AIREC-STRAT-004) is captured.

**Rule**: The model MUST evaluate whether multi-region resilience is required by applying the following logic:

1. **Identify non-zonal services**: From the customer-validated service classification (AIREC-STRAT-003), identify any service classified as regional with zonal recovery control, regional without zonal recovery control, or global. These services have a data plane blast radius that extends beyond an Availability Zone.

2. **Evaluate RTO against blast radius**: If the stated RTO requires bounded recovery from a failure beyond an Availability Zone — i.e. the RTO is short enough that waiting for AWS to recover a regional service is not acceptable — then multi-region resilience is required to meet the stated objectives.

3. **Check data localisation**: Before presenting the multi-region question, the model MUST first confirm that using a secondary region is permitted. Present the data localisation check:

```markdown
## Question: Data Localisation and Region Eligibility

Before evaluating multi-region architecture, confirm that using a secondary AWS Region
is permitted for this workload. Consider all of the following:

- **Regulatory requirements**: Laws and regulations that restrict data to specific
  geographies (e.g. GDPR, financial services regulations, healthcare data laws,
  government data sovereignty requirements)
- **Internal policy**: Organisational data classification policies that limit certain
  data types to specific regions or jurisdictions
- **Contractual obligations**: Customer contracts, SLAs, or data processing agreements
  that specify where data may be processed or stored
- **Third-party dependencies**: SaaS providers or on-premises systems that may only
  be accessible from certain regions

A) Confirmed — using a secondary AWS Region is permitted for this workload and its data
B) Excluded — data localisation requirements prevent the use of a secondary region.
   Log to audit and skip all AIREC-REG rules.

[Answer]:
```

If Answer B → log to audit with the specific constraint and skip all AIREC-REG rules.

4. **Present multi-region trade-off question** (only if data localisation confirmed):

```markdown
## Question: Multi-Region Architecture

Your architecture includes non-zonal services whose data plane blast radius extends
beyond an Availability Zone: [list services and their classification].

Combined with your stated RTO of [X], a failure beyond an Availability Zone would
exceed your recovery objectives without multi-region resilience.

A) Design for multi-region — accept the cost and complexity to meet the stated RTO
B) Stay single-region — accept that a failure beyond an Availability Zone will exceed
   your RTO of [X]. This decision will be logged to audit as an accepted trade-off.

[Answer]:
```

**Audit logging**: The model MUST log the decision to `aidlc-docs/audit.md` with:
- Rule: AIREC-REG-000
- Non-zonal services identified: [list with classification]
- Stated RTO: [value] from NFR [reference]
- Data localisation: [confirmed / excluded with reason]
- Decision: [A — multi-region / B — single-region accepted trade-off]
- If B: explicit statement that a failure beyond an AZ will exceed RTO [X]

**Verification**:
- Service classification is customer-validated before this rule executes
- RTO/RPO is captured before this rule executes
- Data localisation is confirmed or excluded before the multi-region question is presented
- Customer decision is logged to audit with full traceability to the NFR that stated the RTO

---

## Region Recovery Strategy

### Rule AIREC-REG-001: Select Region Recovery Strategy from RTO and RPO

**Rule**: The model MUST select a region recovery strategy using the DR Strategy Framework (AIREC-STRAT-011) and the RTO/RPO defined in AIREC-STRAT-004. The following table defines achievable RTO/RPO ranges, risks, and guidance for each strategy at the region fault isolation boundary.

| Recovery Model | Strategy | Achievable RTO | Achievable RPO | Region-Scope Guidance and Risk | Recommended |
|---|---|---|---|---|---|
| Active/Passive | Backup and restore | Hours–days | Hours–days | Cross-region replication is not used — data is restored from point-in-time backup. Requires functions that may be single-region — if the disaster affects that region, the restore process itself may be unavailable. | Only for non-critical workloads with relaxed objectives |
| Active/Passive | Pilot light | Tens of minutes–hours | Minutes–hours | Cross-region replication is async — in-flight writes at time of failure are lost until reconciliation completes. Capacity availability risk — on-demand capacity may not be available during a regional event; mitigated by capacity reservations. | Suitable when cost constraints prevent warm standby |
| Active/Passive | Warm standby | Minutes–tens of minutes | Seconds–minutes | Cross-region replication is async — in-flight writes at time of failure are lost until reconciliation completes. Capacity availability risk (lower) — mitigated by capacity reservations. | Suitable for most workloads with moderate RTO requirements |
| Active/Passive | Hot Standby | Minutes | Near-zero | Cross-region replication is async — in-flight writes at time of failure are lost until reconciliation completes. Lowest operational risk — failover is a data plane routing operation with no dependency on capacity availability or single-region functions. | **Preferred** for workloads with aggressive RTO/RPO requirements |
| Active/Active | Asynchronous | Near-zero | Near-zero | Write consistency strategy required (write-global, write-local, or write-partitioned); metastable failure risk — excessive load or poison pill failures are shared across all active regions. | Only adopt with explicit business justification and accepted risks |
| Active/Active | Synchronous | Near-zero | Zero | Write latency proportional to inter-region distance; correlated failure risk; requires quorum design (typically 3 regions) and application designed for this from the start. | Only adopt with explicit business justification and accepted risks |

**Recommended strategy**: Active/Passive Hot Standby is the preferred strategy for workloads with aggressive RTO/RPO requirements. Active/Active should only be adopted when mandated by a customer requirement or an unavoidable technology constraint that arises during design that can only be satisfied by Active/Active. The customer must explicitly accept the write consistency and metastable failure risks before proceeding.

**Progressive strategy validation**: After the initial strategy is derived from RTO/RPO, the model MUST apply the following progressive checks in order. Each check may upgrade the strategy.

**Check 1 — Canary requirement (observability extension active)**:
If the observability extension is active and canaries are required (`AIOBS-CLIENT-001`), the secondary region must have running compute to serve as canary targets. Pilot light (compute scaled to 0) and backup and restore (no compute) cannot support canaries. If canaries are required and the derived strategy is pilot light or backup and restore, the strategy MUST be upgraded to warm standby minimum.

**Check 2 — Subset faster recovery (warm standby only)**:
If the strategy is warm standby (derived or upgraded), the model MUST ask:

```markdown
## Question: Subset Faster Recovery

Warm standby requires a scale-up period before full capacity is available in the
secondary region. During this window, some customers may experience degraded service.

Do you need to offer a subset of your users faster recovery — i.e. traffic served
immediately on failover without waiting for scale-up to complete?

A) No — all users can tolerate the warm standby scale-up window
B) Yes — a subset of users require faster recovery. Approximately what percentage
   of your user base requires immediate failover? [provide percentage]
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

If answer B: the architecture MUST include two distinct endpoints and two recovery paths:
- **Fast recovery endpoint** — routes to pre-provisioned capacity sized for the stated percentage; available immediately on failover
- **Standard endpoint** — routes to warm standby capacity; available after scale-up completes

This is a design requirement fed into NFR Design: the cell router or load balancer must support routing customer segments to different endpoints, and the Region Switch plan must handle both paths.

**Check 3 — Traffic flip sequencing (warm standby confirmed)**:
If warm standby is confirmed after checks 1 and 2, the model MUST ask:

```markdown
## Question: Warm Standby Traffic Flip Sequencing

When failing over to warm standby, how should traffic be introduced to the secondary region?

A) Scale up first, then flip — scale secondary region to full capacity before routing
   traffic. Lower risk of overload but longer RTO.
B) Flip traffic and load shed while scaling — route traffic immediately, shed excess
   load until scale-up completes. Faster RTO but some requests will be rejected during
   scale-up.
C) Dial up traffic incrementally while scaling — gradually increase traffic percentage
   as capacity scales. Balances RTO and overload risk.
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**Customer Validation**: The strategy choice has significant cost and architecture implications. The model MUST present the derived strategy to the customer for explicit approval before designing region recovery controls.

```markdown
## Question: Region Recovery Strategy

Based on the stated RTO and RPO, the following region recovery strategy is proposed:

**Proposed strategy**: [strategy name]
**Rationale**: RTO of [X] and RPO of [Y] at region scope require [reasoning]
**Data tier**: [from AIREC-STRAT-011]
**Compute tier**: [from AIREC-STRAT-011]
**Region-scope risk**: [from table above]
**Estimated cost implication**: [relative cost — low / medium / high]

A) Approve — proceed with this strategy
B) Modify — I want a different strategy (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**Verification**:
- Strategy is derived from AIREC-STRAT-011 and customer-validated RTO/RPO (AIREC-STRAT-004)
- Customer has explicitly approved the strategy and its risk profile
- Secondary region architecture matches the approved strategy
- If active/active is selected, write consistency and metastable failure risks are explicitly documented and accepted

---

### Rule AIREC-REG-002: Capacity in the Secondary Region

**Rule**: The strategy for ensuring capacity is available in the secondary region at failover time MUST match the approved DR strategy. On-demand capacity cannot be assumed to be available during a regional event — demand across the region may be elevated as other customers also attempt to scale.

- **Active/Passive Hot Standby**: Full capacity is pre-provisioned and running in the secondary region. No scaling required on failover.
- **Warm standby / Pilot light**: Reduced or zero application capacity is running. The model MUST present the capacity availability risk to the customer and ask them to choose between reserving capacity or accepting the risk.
- **Backup and restore**: No capacity is pre-provisioned. Capacity reservations are not practical — the RTO must account for the risk that on-demand capacity may not be immediately available.

**Customer Validation** (warm standby and pilot light only): Capacity reservations guarantee access to specific instance types regardless of regional demand but incur ongoing cost. The model MUST present this trade-off before generating IaC.

```markdown
## Question: Secondary Region Capacity Strategy

For [warm standby / pilot light], on-demand capacity in the secondary region may not be
available during a regional event when demand is elevated.

Options:
A) Reserve capacity — configure On-Demand Capacity Reservations for critical compute
   resources in the secondary region. Guarantees availability. Incurs ongoing cost
   even when not in use.
B) Accept the risk — do not reserve capacity. Lower cost. RTO may be extended if
   on-demand capacity is unavailable during a regional event. This accepted risk
   will be logged to audit.
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**Verification**:
- Active/Passive Hot Standby: secondary region runs full production capacity
- Warm standby / pilot light: customer has explicitly chosen to reserve capacity or accepted the risk; choice is logged to audit
- Backup and restore: RTO estimate explicitly accounts for capacity provisioning time and availability risk
- Capacity adequacy is validated by ARC Readiness Checks (AIREC-REG-004)

---

## Region Recovery Controls

### Rule AIREC-REG-003: Use ARC Region Switch as the Preferred Recovery Control

**Rule**: ARC Region Switch MUST be the primary region recovery control mechanism. The model MUST evaluate Region Switch before considering any alternative.

The recovery mechanism MUST satisfy two strategy requirements:
- **AIREC-STRAT-005 (static stability)**: The mechanism must function even when the primary region is impaired — it must not depend on the region it is recovering from
- **AIREC-STRAT-008 (demonstrable)**: The mechanism must have an explicit recovery control the customer can trigger to force recovery, and that recovery control must be testable

**Why Region Switch**: Region Switch executes via a data plane in each region — it satisfies both STRAT-005 and STRAT-008. Manual Route 53 DNS updates are control plane operations that may be unavailable during a regional failure and do not satisfy STRAT-005. Route 53 automatic health check-based failover is acceptable as a fallback because health check evaluation is a data plane operation.

**Region Switch provides**:
- Plan-based orchestration of complex, multi-step recovery across accounts and regions
- Support for active/passive (failover/failback) and active/active (shift-away/return) configurations
- CloudWatch alarm-triggered automatic execution or manual execution
- A data plane in each AWS Region — plans execute without depending on the impaired region (static stability)
- Full-featured dashboards for real-time recovery visibility

**Mandatory evaluation — decision tree**: The model MUST work through the following options in order, documenting the rationale at each step:

**Step 1 — ARC Region Switch** (preferred):
Evaluate whether Region Switch is applicable by consulting the ARC documentation for the current list of supported resources and execution block types. A service can be included in a Region Switch plan via a current service execution block, via an execution block that controls a Route 53 health check, or via an execution block that triggers a custom Lambda. Document the evaluation for each service in the architecture. If applicable → use Region Switch.

**Step 2 — ARC Routing Controls with Route 53 automatic health check failover** (fallback):
If Region Switch is not applicable, evaluate ARC Routing Controls. Route 53 automatic health check-based failover is a data plane operation and satisfies AIREC-STRAT-005 and AIREC-STRAT-008. If applicable → use ARC Routing Controls. Document why Region Switch was not used.

**Step 3 — Alternative mechanism** (last resort):
If neither Region Switch nor ARC Routing Controls are applicable, the model MUST analyse what alternative mechanism satisfies AIREC-STRAT-005 (static stability — functions when primary region is impaired), AIREC-STRAT-008 (demonstrable — has an explicit recovery control the customer can trigger), and AIREC-STRAT-012 (customer-controllable via CLI or API using a data plane operation). Present the proposed alternative to the customer for explicit validation. Log to audit with: why Region Switch was not used, why ARC Routing Controls were not used, what alternative was proposed, and the customer's explicit acceptance.

**Customer Validation** (required at every step):

```markdown
## Question: Region Recovery Control Mechanism

The following region recovery control mechanism has been evaluated:

**Step 1 — ARC Region Switch**: [Applicable / Not applicable — reason]
**Step 2 — ARC Routing Controls**: [Applicable / Not applicable — reason, if Step 1 not applicable]
**Step 3 — Alternative**: [Proposed mechanism and rationale, if Steps 1 and 2 not applicable]

**Proposed mechanism**: [chosen mechanism]
**Satisfies AIREC-STRAT-005 (static stability)**: [Yes / No — explanation]
**Satisfies AIREC-STRAT-008 (demonstrable recovery control)**: [Yes / No — explanation]
**Satisfies AIREC-STRAT-012 (customer-controllable via CLI or API)**: [Yes / No — explanation]

A) Approve — proceed with this recovery control mechanism
B) Modify — I want a different mechanism (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**Region Switch plan requirements** (when applicable):
- A Region Switch plan MUST be created for each recovery scenario (failover to secondary, failback to primary)
- Plans MUST be tested regularly — after initial setup and after any significant architecture change
- Plans MUST use data plane API operations for execution during an event
- DNS TTL for records involved in failover MUST be set to 60–120 seconds to minimise propagation delay
- Purpose-built, long-lived IAM credentials for DR tasks MUST be created and stored securely outside the primary region

**When a native Region Switch execution block does not exist for a service**: Use the Lambda execution block. Write the recovery task using the AWS SDK in a Lambda function and wire it into the Region Switch plan. The Lambda function MUST comply with AIREC-STRAT-005 (static stability) — deployed in the secondary region, no dependency on the primary region.

**When Region Switch is genuinely not applicable** (document the specific reason): Use ARC Routing Controls with Route 53 automatic health check-based failover as the fallback. Health check evaluation is a data plane operation and satisfies AIREC-STRAT-005. Manual Route 53 DNS updates MUST NOT be used as the failover mechanism — they are control plane operations that may be unavailable during a regional failure and do not satisfy AIREC-STRAT-005 or AIREC-STRAT-008. The reason Region Switch was not used MUST be documented and logged to audit.

**Verification**:
- ARC Region Switch applicability has been explicitly evaluated and documented
- Customer has approved the recovery control mechanism choice
- If Region Switch is used: plans exist for failover and failback/return scenarios, plans have been tested
- If Region Switch is not used: the specific reason is documented and logged to audit
- DNS TTL for failover records is ≤ 120 seconds
- DR credentials are stored securely outside the primary region
- ARC Region Switch plans exist for failover and failback/return scenarios
- Plans have been tested and results documented
- DNS TTL for failover records is ≤ 120 seconds
- DR credentials are stored securely outside the primary region
- Data plane API operations are used for plan execution

---

### Rule AIREC-REG-004: Implement Continuous Region Health Observability for Failover and Failback Decisions

**Rule**: Both the primary and secondary regions MUST have continuous health observability that enables informed failover and failback decisions. This MUST be implemented via the observability extension (AIOBS-ALARM-005, AIOBS-MET-*, AIOBS-DASH-*) rather than ARC Readiness Checks, which are deprecated.

**Why**: Failover and failback decisions require continuous visibility of both regions — not just whether the secondary can receive traffic, but whether the primary is degraded enough to warrant failover, and whether replication lag is low enough to failback safely. Per-region alarms and dashboards provide this visibility as a standard operational capability rather than a separate monitoring service.

**What to implement**:
- **Per-region health alarms** (AIOBS-ALARM-005): composite alarm per region aggregating key health signals. A firing alarm signals the region is degraded and may warrant failover.
- **Replication health monitoring** (AIOBS-MET-*): for every data store that replicates across regions, monitor the replication health metrics provided by that service (e.g. replication lag, sync status, replica health). Alarm when replication is degraded — high lag or failed replication means failback is unsafe.
- **Dual-region dashboard** (AIOBS-DASH-*): side-by-side view of primary and secondary region health indicators, enabling operators to compare both regions before triggering failover or failback.
- **Capacity monitoring** (AIOBS-MET-*): for services with capacity limits (concurrency, throughput, connections), monitor utilisation in both regions. A region approaching its limits is not ready to receive full traffic.

**Verification**:
- Per-region composite health alarm exists for both primary and secondary regions (AIOBS-ALARM-005)
- For every data store that replicates across regions, a replication health alarm exists with a documented threshold
- Dashboard shows both regions' health indicators side by side (AIOBS-DASH-*)
- Capacity utilisation alarms exist for services with throughput or concurrency limits in both regions

---

### Rule AIREC-REG-005: Design Region Failover Observability and Safety Interlock

**Rule**: Region failover is a high-impact, difficult-to-reverse action. The observability used to trigger region failover MUST be more stringent than AZ-level recovery.

**Failover decision vs execution**: The failover action MUST be fully automated (executed via ARC Region Switch plan), but the decision to activate failover MUST be made by a predetermined set of human decision-makers. Automated execution without human decision-making is not acceptable for region failover. The criteria for making the failover decision MUST be clearly defined, documented, and understood across the organisation before an event occurs.

**Static stability** (AIREC-STRAT-006): The observability and recovery control infrastructure used to detect and execute region failover MUST be outside the blast radius of the primary region. If the primary region is impaired, the failover mechanism must still function.

**Trigger conditions** — all three MUST be confirmed before the human decision-maker activates failover:
1. Customer impact alarm is firing (per-region composite alarm from AIOBS-ALARM-005)
2. The impairment is confirmed as region-scoped — not an AZ-level issue that AZ recovery can handle
3. The secondary region readiness checks are passing

**Safety interlock** — automated region failover MUST be disabled if:
- AZ-level recovery controls have not been attempted or are still executing
- The secondary region readiness checks are failing
- Both regions show simultaneous impairment

**Cross-region health signals**: Canaries (AIOBS-CLIENT-001) run at the edge and provide an outside-in customer experience view of both regions. In addition, a small set of critical internal health signals MUST be made available in the standby region to support the failover decision when primary region observability may be impaired. These signals MUST cover:
- The top-level customer impact composite alarm state from the primary region
- Replication lag per data store (see AIREC-REG-006)
- ARC Readiness Check status for the secondary region

These signals MUST NOT replicate the full observability stack — only the minimum required to make a confident failover decision.

**Verification**:
- Per-region composite alarms exist as the trigger signal
- All three trigger conditions are implemented
- Safety interlock prevents failover when secondary region is not ready or both regions are impaired
- Critical health signals from the primary region are available in the standby region
- Failover decision criteria are documented and the decision is made by humans; execution is automated via ARC Region Switch

---

### Rule AIREC-REG-006: Design Data Replication and RPO Acceptance

**Rule**: Cross-region data replication is asynchronous for most AWS services. The model MUST design data replication for each data store and present the RPO implications to the customer for explicit acceptance.

**For each data store in the architecture**:
- Identify the replication mechanism (e.g. DynamoDB global tables, RDS cross-region read replica, S3 cross-region replication)
- Document the replication lag and resulting RPO
- Design a data reconciliation process for data written to the primary region after the last successful replication

**RPO acceptance**: The customer MUST explicitly accept the RPO for each data store. If the stated RPO cannot be met by the available replication mechanism, the model MUST flag this as a blocking finding.

```markdown
## Question: Data Replication RPO Acceptance

The following data replication configuration has been designed:

| Data Store | Replication Mechanism | Replication Lag | Effective RPO |
|---|---|---|---|
| [store] | [mechanism] | [lag] | [RPO] |

A) Accept — the effective RPO for each data store is acceptable
B) Modify — one or more RPOs are not acceptable (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**Verification**:
- Cross-region replication is configured for every data store
- Replication lag and effective RPO are documented per data store
- Customer has explicitly accepted the RPO for each data store
- A data reconciliation process exists for data written after the last replication

---

## Region Recovery Testing

### Rule AIREC-REG-007: Test Region Switch Plans Regularly

**Rule**: Region Switch plans MUST be tested after initial setup and after any significant architecture change. Testing MUST validate:
1. The plan executes successfully and completes within the stated RTO
2. Traffic is correctly redirected to the secondary region
3. The secondary region serves customer traffic correctly
4. Failback/return to the primary region works correctly
5. Data reconciliation after failback is validated

**Testing approach**: Use ARC Region Switch's ability to execute plans against a non-production environment first. For production validation, schedule regular game days that execute the full failover and failback sequence.

Every Region Switch test MUST answer the three demonstration questions (AIREC-STRAT-009):
1. Do all people, process, and technology steps of the recovery plan work as expected and complete within the stated RTO?
2. Do recovery controls successfully redirect all traffic to the secondary region?
3. Do system metrics and alarms correctly detect the impairment and validate that traffic has moved?

**Verification**:
- Region Switch plans have been tested after initial setup
- Test results are documented with pass/fail against RTO
- Failback/return plan has been tested
- Game days are scheduled for periodic production validation

---

## Region Recovery Architecture

### Rule AIREC-REG-008: Ensure Regional Independence — No Cross-Region Dependencies

**Rule**: Each region in a multi-region architecture MUST be able to operate independently of the other. Cross-region dependencies at the application layer break the fault isolation benefit of multi-region and introduce shared fate.

**The model MUST verify**:
- No microservice in the architecture makes synchronous calls to a service in another region during normal operation
- All microservices that form a business capability fail over together — independent microservice failover risks cross-region calls during partial failover
- Certificates, encryption keys, secrets, AMIs, container images, and configuration parameters are stored locally in each region — not shared across regions
- Certificate expiry dates are staggered across regions to prevent simultaneous expiry events
- Third-party and SaaS dependencies are available in (or from) the secondary region; if not, a graceful degradation strategy is designed

**Verification**:
- No synchronous cross-region service calls exist in the architecture
- All microservices supporting a business capability are deployed in each region and fail over as a unit
- Certificates, keys, secrets, and parameters are region-local
- Third-party dependency availability in the secondary region is confirmed or a degradation strategy is documented

---

### Rule AIREC-REG-009: Ensure Failover Mechanism Has No Dependency on the Primary Region

**Rule**: The failover mechanism MUST NOT take a dependency on the primary region it is recovering from. A failover mechanism that depends on the impaired region may fail at the moment it is needed most.

**Specific risk**: Route 53's control plane is hosted in us-east-1. If the primary region is us-east-1, using Route 53 DNS updates as the failover mechanism creates a single point of failure. ARC Region Switch executes via a data plane in each region and has no dependency on the region being deactivated — this is the primary reason it is the preferred failover mechanism (AIREC-REG-003).

**Global service operations in the recovery path**: Global services have distributed data planes but single-region or partitional control planes. The model MUST ensure the recovery path only uses data plane operations for global services. The following table defines what is safe to use during a recovery event:

| Global Service | Safe in recovery path (data plane) | NOT safe — may fail (control plane) |
|---|---|---|
| IAM | AuthN/AuthZ of signed AWS requests | Create/update/delete roles, policies, users |
| Route 53 | DNS resolution, health check evaluation | Update routing policies, create/modify records |
| ARC | Execute Region Switch plans via data plane API, list/get plans | Create/modify cluster endpoints |
| CloudFront | Continue to cache and serve content, origin failover | Create/modify distributions |
| Global Accelerator | Edge routing continues, existing traffic dials function | Add/modify endpoints, change traffic dials |

**Verification**:
- The failover mechanism has no runtime dependency on the primary region
- ARC Region Switch is used as the failover mechanism, or the alternative mechanism is documented with an explicit analysis of its dependencies on the primary region
- The recovery path uses only data plane operations for global services — no control plane operations are in the critical recovery path

---

### Rule AIREC-REG-010: Ensure Service Quota Parity Across Regions

**Rule**: All AWS service quotas MUST be in parity across all regions in which the workload operates before the secondary region goes live. A failover that succeeds at the traffic routing level but fails because the secondary region has hit a quota is a failed recovery.

**The model MUST**:
- Identify all AWS services used in the architecture
- Compare planned usage in the secondary region against current default quotas
- Request quota increases in the secondary region to match the primary region
- Configure IAM roles and permissions in the secondary region before go-live

**Verification**:
- Service quota parity is documented across all regions
- Quota increase requests have been submitted and approved for the secondary region
- IAM roles and permissions are configured in the secondary region

---

### Rule AIREC-REG-011: Deploy One Region at a Time

**Rule**: The deployment pipeline MUST deploy to one region at a time — primary first, then secondary. Simultaneous multi-region deployment introduces the risk of correlated failures across both regions from a bad deployment.

**Verification**:
- Deployment pipeline deploys to the primary region first, waits for health validation, then deploys to the secondary region
- Simultaneous multi-region deployment is not permitted
- Deployment pipeline supports rollback in each region independently

---

### Rule AIREC-REG-013: Design Queue Recovery for Region Failover

**Rule**: If the architecture uses message queues (e.g. SQS), the region failover plan MUST address queue recovery. When a region fails, messages in that region's queues may be unprocessed. The recovery plan MUST:

1. **Redirect producers** to the secondary region's queue on failover so new messages are not sent to the failed region
2. **Handle in-flight messages** in the failed region — messages that were in-flight at the time of failure may be replayed after recovery; consumers MUST be designed to handle duplicate message delivery safely

**Idempotency is the answer**: Queue consumers MUST be designed to be idempotent — processing the same message more than once must produce the same result as processing it once. This is the fundamental design requirement that makes queue recovery safe. Without idempotency, replayed messages from the failed region after recovery will cause duplicate processing and data inconsistency.

**Verification**:
- Queue producers are included in the Region Switch plan — they redirect to the secondary region queue on failover
- Queue consumers are designed to be idempotent
- The recovery plan documents how in-flight messages from the failed region are handled after recovery
- Replication lag for queue-backed data stores is included in the RPO assessment (AIREC-REG-006)

---

### Rule AIREC-REG-014: Design Region Recovery Chaos Experiments

**Rule**: The model MUST design chaos experiments for region recovery that validate both the recovery controls and the absence of hidden cross-region dependencies.

**Experiment 1 — Cross-region connectivity disruption** (validates AIREC-REG-008):
Use AWS FIS `aws:network:disrupt-connectivity` to block cross-region traffic originating from the primary region VPC. This simulates a region isolation scenario and reveals any hidden dependencies from the primary region to the secondary region or to third-party services.

Hypothesis to validate:
- The primary region application continues to serve requests without cross-region calls
- No unexpected failures occur due to hidden cross-region dependencies
- Replication (DynamoDB global tables, S3 cross-region replication) pauses gracefully without causing application failures

**Experiment 2 — Region Switch plan execution** (validates AIREC-REG-003, AIREC-REG-007):
Execute the Region Switch failover plan in a non-production environment. Validate the full failover and failback sequence completes within the stated RTO.

**Rehearsal** (validates people and process — no fault injected):
Conduct a rehearsal of the regional failover procedure without injecting a fault. The goal is to validate that all people, process, and technology steps are understood and can be executed correctly. Rehearsals should be conducted on a regular cadence (at minimum annually for regulated workloads) and after any significant architecture change.

**Recovery Rehearsal Guidance**: The following rehearsal best practices apply to region recovery. The model MUST surface this at Operations phase completion.

```markdown
## Region Recovery Rehearsal Guidance

Regular rehearsals of the regional failover procedure are best practice.
These cannot be verified automatically — they are organisational commitments:

| Rehearsal Type | Recommended Cadence | What to Validate |
|---|---|---|
| Tabletop exercise | Quarterly | All stakeholders understand the failover decision criteria and their roles |
| Non-production failover | Semi-annually | Region Switch plan executes correctly; RTO is met; failback works |
| Production failover (game day) | Annually | Full failover and failback with production traffic; data reconciliation validated |

Use the same runbook for rehearsals and live events — separate runbooks introduce risk.
```

**Verification**:
- Cross-region connectivity disruption experiment is designed and executed
- Region Switch plan execution experiment is designed and executed in non-production
- Rehearsal cadence is documented and scheduled
- Experiment results answer the three demonstration questions (AIREC-STRAT-009)

---

## Region Recovery Operations Validation

### Rule AIREC-REG-012: Validate Service Availability in Secondary Region

**Applies at**: Operations phase — after all recovery controls are designed and built.

**Rule**: The model MUST scan all AWS services used in the architecture (from IaC and application code) and validate that each service is available in the chosen secondary region. A service that is not available in the secondary region means the failover will fail for that component.

**The model MUST**:
1. List every AWS service used in the architecture
2. Check each against the AWS services by Region availability list for the chosen secondary region
3. Present the results to the customer for confirmation
4. Flag any service not available in the secondary region as a **blocking finding** — the architecture must be redesigned for that component before region recovery can proceed

```markdown
## Question: Service Availability in Secondary Region

The following AWS services are used in this architecture. Confirm that each is
available in the chosen secondary region: [secondary region name]

| Service | Available in Secondary Region? | Notes |
|---|---|---|
| [service] | [Yes / No / Verify] | |

A) Confirmed — all services are available in the secondary region
B) Gaps identified — one or more services are not available; architecture changes
   required before region recovery can proceed (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**Verification**:
- All AWS services in the architecture are listed and checked against secondary region availability
- No service used in the architecture is unavailable in the secondary region
- Customer has explicitly confirmed service availability
- Any gaps are documented as blocking findings with required architecture changes
