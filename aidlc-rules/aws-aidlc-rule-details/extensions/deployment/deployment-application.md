# Deployment — Application Deployment Rules

## Overview
These rules define **how** to deploy application code safely, respecting fault isolation boundaries and using operational alarms as gates. They implement DEPLOY-STRAT-002, DEPLOY-STRAT-003, and DEPLOY-STRAT-004 from `extensions/deployment/deployment-baseline.md`.

**Applies when**: Deployment extension is active (Answer A or B).

**Prefix**: `DEPLOY-APP-`

---

## Observability Dependency

| DEPLOY Rule | Depends On | Why |
|---|---|---|
| DEPLOY-APP-002 | AIOBS-ALARM-001, AIOBS-ALARM-005 | Per-boundary composite alarms are the gate signal between deployment phases |
| DEPLOY-APP-003 | AIOBS-ALARM-001 | Operational alarms trigger automatic rollback |

When the observability extension is not active, apply the degradation behaviour defined in the Extension Dependencies section of `deployment-baseline.md`.

---

### Rule DEPLOY-APP-001: Derive the Deployment Mechanism from the Compute Type

**Rule**: The model MUST identify the compute type from the architecture and derive the appropriate phased deployment mechanism. The deployment mechanism is NOT prescribed — it is derived from the compute type and the available tooling.

**Derivation guidance**:

| Compute Type | Phased Deployment Mechanism | Rollback Mechanism |
|---|---|---|
| AWS Lambda | Lambda versions + aliases with weighted routing; or CodeDeploy Lambda deployment group with canary/linear configuration | Shift alias weight back to previous version; or CodeDeploy automatic rollback |
| Amazon ECS | ECS rolling update with minimum healthy percent; or CodeDeploy blue/green with ECS | ECS rollback to previous task definition; or CodeDeploy automatic rollback |
| Amazon EC2 (ASG) | CodeDeploy in-place or blue/green deployment group; or instance refresh with custom rollback | CodeDeploy automatic rollback; or ASG instance refresh rollback |
| Amazon EKS | Kubernetes rolling update (Deployment spec); or Helm chart upgrade with rollback | `kubectl rollout undo`; or `helm rollback` |
| AWS Copilot (ECS) | Copilot deploy with ECS rolling update | Copilot rollback to previous version |
| AWS Step Functions | State machine version + alias with weighted routing; or direct definition update for non-critical workflows | Shift alias weight back to previous version; or redeploy previous state machine definition |

If the compute type is not listed, the model MUST reason from first principles: identify whether the compute platform supports weighted traffic shifting, blue/green, or rolling update patterns, and choose the one that best supports phased rollout with alarm gates.

**Verification**:
- The deployment mechanism is documented with rationale in NFR design artifacts
- The chosen mechanism supports phased rollout aligned to fault isolation boundaries
- The chosen mechanism supports alarm-triggered automatic rollback

**Customer Validation**: The model MUST present the derived deployment mechanism for customer approval before implementing it in IaC and pipeline configuration.

```markdown
## Question: Deployment Mechanism

Based on the architecture, the following deployment mechanism has been derived:

**Compute type**: [type]
**Proposed mechanism**: [mechanism]
**Rationale**: [why this mechanism best supports phased rollout and rollback]
**Rollback mechanism**: [how rollback works]

A) Approve — proceed with this deployment mechanism
B) Modify — I want a different mechanism (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

---

### Rule DEPLOY-APP-002: Phase Deployment Across Fault Isolation Boundaries

**Rule**: Application deployment MUST be phased to respect the fault isolation boundaries identified for the architecture (AIREC-STRAT-003). Each phase MUST be gated by the operational composite alarms for that boundary (AIOBS-ALARM-005) before proceeding.

**Phase sequence** (smallest boundary first):

**Single instance (one-box)**:
- Deploy to one instance within the first AZ
- Monitor the per-boundary composite alarm (AIOBS-ALARM-005) for a defined window (minimum 5 minutes)
- If alarm fires → rollback immediately, do not proceed
- If alarm clears → proceed to next phase

**Full AZ**:
- Deploy to all instances in the first AZ
- Monitor per-AZ composite alarm for a defined window
- If alarm fires → rollback, do not proceed to next AZ
- If alarm clears → proceed to next AZ

**Subsequent AZs**:
- Repeat per-AZ phasing for each remaining AZ

**Cell/shard boundary** (where applicable):
- Deploy to one cell before the fleet
- Monitor per-cell alarms for a defined window
- If alarm fires → rollback, do not proceed to other cells

**Multi-region** (if applicable):
- Complete full phased deployment in primary region
- Validate primary region alarms for a defined window (minimum 5 minutes)
- Only then deploy to secondary region using the same phased approach

**Verification**:
- Deployment pipeline implements phased rollout aligned to the architecture's fault isolation boundaries
- Each phase has a defined monitoring window
- Per-boundary composite alarms (AIOBS-ALARM-005) are configured as deployment stop conditions
- Multi-region deployments deploy primary first, secondary only after primary validation

---

### Rule DEPLOY-APP-003: Configure Automatic Rollback via Operational Alarms

**Rule**: Every deployment phase MUST have automatic rollback configured. Rollback MUST be triggered by the same operational CloudWatch alarms used for monitoring (AIOBS-ALARM-001) — not by separate deployment-specific metrics.

**Why**: Using operational alarms as rollback triggers ensures rollback fires on actual customer impact. It also means the rollback mechanism is continuously validated by normal operations — if the alarm works for incident detection, it works for deployment rollback.

**Implementation**: Wire the customer-facing KPI alarms (AIOBS-ALARM-001 Detect tier) as stop conditions on the deployment. When any Detect-tier alarm fires during a deployment phase, rollback executes automatically.

**Verification**:
- Automatic rollback is configured for every deployment phase
- Rollback is triggered by operational Detect-tier alarms (AIOBS-ALARM-001)
- Rollback configuration is in IaC (not manual console configuration)
- Rollback is tested in lower environments before production

---

### Rule DEPLOY-APP-004: Deployment Must Not Propagate Automatically Across Regions

**Rule**: For multi-region deployments, the deployment pipeline MUST NOT automatically propagate a deployment from the primary region to the secondary region. The secondary region deployment MUST be a separate, explicitly triggered step that only executes after primary region validation is complete.

**Why**: Automatic cross-region propagation means a bad deployment in the primary region immediately affects the secondary region — eliminating the recovery option of failing over to the secondary.

**Verification**:
- Primary and secondary region deployments are separate pipeline stages
- Secondary region deployment requires explicit trigger or approval after primary validation
- A failed primary region deployment does not trigger secondary region deployment
