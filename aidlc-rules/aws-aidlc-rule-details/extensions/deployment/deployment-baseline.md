# Baseline Deployment Rules

## Overview
These rules define the deployment strategy that MUST be applied across all AI-DLC phases. They govern how application code and infrastructure are deployed safely — ensuring deployments cannot cause undetected customer impact and that rollback is always possible.

**Relationship to other domains**:
- Deployment phasing depends on fault isolation boundaries defined by the recovery extension (AIREC-STRAT-003)
- Deployment alarm gates depend on observability alarms defined by the observability extension (AIOBS-ALARM-001, AIOBS-ALARM-005)
- Deployment safety is a prerequisite for recovery — a bad deployment that cannot be detected or rolled back undermines all recovery controls

**Signal-Specific Rules**: The DEPLOY-STRAT rules below define **what** to build and **why**. The **how** is defined in `extensions/deployment/`. The model MUST scan that directory and load `.md` files when deployment rules are active.

**Loading based on user's deployment answer:**
- **Answer A (AWS best-practice)**: Load all `.md` files in `extensions/deployment/` EXCEPT `deployment-custom.md`
- **Answer B (AWS + custom)**: Load all `.md` files INCLUDING `deployment-custom.md`
- **Answer C (custom only)**: Load ONLY `deployment-custom.md`. STRAT rules still apply as context.

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message.

### Blocking Deployment Finding Behavior
A **blocking deployment finding** means:
1. The finding MUST be listed in the stage completion message under a "Deployment Findings" section with the DEPLOY rule ID
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option
4. The finding MUST be logged in `aidlc-docs/audit.md`

### Default Enforcement
All rules in this document and in the loaded `extensions/deployment/` files are **blocking** by default. If any rule's verification criteria are not met, it is a blocking deployment finding — follow the blocking finding behavior above. If a rule is not applicable to the current architecture, mark it as **N/A** with a documented rationale — this is not a blocking finding. Silent omission is not acceptable — if a rule cannot be satisfied, the model MUST investigate whether the chosen tools provide the capability, document the gap, and present it as a blocking finding. All gaps MUST be logged to audit.md with rule ID, rationale, and severity.

### Verification Criteria Format
Verification items in this document are plain bullet points describing compliance checks. Each item should be evaluated as compliant or non-compliant during review.

### Stage Enforcement

The following stages have mandatory enforcement of these rules. This is a minimum set — the model MUST enforce these rules at each stage listed below, and MAY also enforce them at other stages where relevant.

| Stage | Mandatory |
|-------|-----------|
| Requirements Analysis | ✅ MUST enforce (DEPLOY-COMP rules) |
| NFR Design | ✅ MUST enforce |
| Code Generation | ✅ MUST enforce |
| Operations | ✅ MUST enforce |

#### Requirements Analysis

The model MUST evaluate every component in the architecture for runtime operability (DEPLOY-COMP-001). For each component, the model MUST ask: what must exist in the target environment for this component to start, serve requests, and be verified as healthy? The model MUST cover at minimum: connections (credentials, endpoints), configuration (parameters, feature flags), initialisation (migrations, seed data), verification prerequisites (test identities for canaries and integration tests), and external prerequisites (DNS, certificates, IAM).

For each identified dependency the model MUST record: what it is, which component needs it, and how it will be provisioned automatically — preferably via IaC, or alternatively via a generated automation script.

**Verification**: Requirements Analysis MUST NOT complete until every component has been evaluated and every identified dependency has a provisioning method recorded. Unresolved dependencies are blocking findings.

#### NFR Design

The model MUST produce design artifacts satisfying every loaded rule. The following are mandatory NFR Design outputs:

1. **IaC tool selection** (DEPLOY-STRAT-001): Confirm IaC tool from tech-env.md or derive from tech stack. IaC is mandatory — not optional.
2. **Deployment phasing strategy** (DEPLOY-STRAT-003): Design phased rollout aligned to fault isolation boundaries. Smallest boundary first, alarm-gated between phases. Present bake time for customer approval.
3. **Rollback mechanism** (DEPLOY-STRAT-004): Design automatic rollback triggered by operational alarms.
4. **Alarm gate design** (DEPLOY-STRAT-002): Identify which alarms gate each deployment phase. Reference AIOBS-ALARM-001/005.
5. **Observability dependency evaluation**: If the observability extension is not active, evaluate the Observability Dependency section and degrade to manual approval gates.
6. **Deployment dependency inventory** (DEPLOY-COMP-001): Every runtime dependency identified in Requirements Analysis MUST be provisioned automatically — preferably via IaC, or alternatively via a generated automation script. Unprovisioned dependencies are blocking findings.
7. **Pipeline tool selection** (DEPLOY-PIPE-001): Confirm pipeline tool from tech-env.md or derive from architecture. Document choice and rationale.
8. **Pipeline stage design** (DEPLOY-PIPE-008): Design the full pipeline stage sequence. Document which stages apply based on architecture (multi-region adds stages 8–10).
9. **Source connection design** (DEPLOY-PIPE-011): Document how the pipeline Source stage connects to the workspace repository. Identify the repository provider and branch strategy.
10. **Test stage design** (DEPLOY-PIPE-012): Design what the pipeline Test stage verifies — canary status checks (DEPLOY-TEST-001), security boundary test execution (DEPLOY-TEST-002), alarm state verification.
11. **Human approval gate design** (DEPLOY-PIPE-013): Document the approval gate position and what information the model presents to the human.
12. **Canary coverage plan** (DEPLOY-TEST-001): Identify which user journeys require canaries. Map each journey to an endpoint and expected response. Every externally-facing endpoint MUST have canary coverage.
13. **Security boundary test plan** (DEPLOY-TEST-002): Identify every protected endpoint. Document expected rejection behaviour (401/403). Identify security headers required for the architecture.
14. **Functional correctness test identification** (DEPLOY-TEST-003): Identify error paths, validation boundaries, and edge cases that Post-Deployment Testing MUST verify against the live environment.
15. **Operational readiness criteria** (DEPLOY-TEST-004): Identify which alarms, dashboards, canaries, and health checks MUST be verified post-deployment, including expected configuration values.

**Verification**: NFR Design stage MUST NOT complete until all 15 outputs above are present in the NFR design artifacts. Missing outputs are blocking findings.

#### Code Generation

The model MUST cross-check the code generation plan against the DEPLOY-COMP-001 dependency list. Every dependency MUST have a corresponding construction task — an IaC generation step or a script generation step. If any dependency has no construction task, the model MUST add it before Code Generation proceeds. A code generation plan that omits construction tasks for identified dependencies is a blocking finding.

The model MUST generate the following pipeline artifacts:

1. **Pipeline definition as code** (DEPLOY-PIPE-001): Pipeline IaC that defines the full stage sequence from DEPLOY-PIPE-008.
2. **Source stage configuration** (DEPLOY-PIPE-011): Pipeline Source stage referencing the workspace repository, triggering on trunk commits.
3. **Test stage configuration** (DEPLOY-PIPE-012): Pipeline Test stage that checks canary status (DEPLOY-TEST-001), executes security boundary scripts (DEPLOY-TEST-002), and verifies alarm state.
4. **Human approval gate** (DEPLOY-PIPE-013): Manual approval action between Test stage and production Deploy.
5. **Deployment output wiring**: Deploy stage outputs (endpoints, ARNs) wired as inputs to the Test stage.

The model MUST generate the following test artifacts:

6. **Canary scripts** (DEPLOY-TEST-001): Executable canary scripts for each identified user journey. Canary IaC MUST deploy them to the target environment.
7. **Security boundary test scripts** (DEPLOY-TEST-002): Executable test scripts verifying authentication rejection and security headers. Scripts MUST accept deployment outputs as environment variables. Scripts MUST exit 0 on all-pass, non-zero on any failure. Scripts MUST be executable via a single command.
8. **Test entry point** (DEPLOY-TEST-002): A single command that runs all security boundary tests and reports pass/fail via exit code.

**Verification**: Code Generation MUST NOT complete until the dependency cross-check is recorded AND all 8 artifacts above exist in workspace. Missing artifacts are blocking findings.

#### Operations

The model MUST validate every loaded rule against the generated artifacts (IaC, pipeline configuration, deployment scripts). For each rule:
- Compliant → mark as passed
- Non-compliant → blocking finding: list the rule ID, what was expected, and what was found
- Not applicable → mark N/A with rationale

The Operations phase MUST NOT complete until all blocking findings are resolved or explicitly accepted by the customer with the decision logged to audit.

---

## Observability Dependency

Deployment alarm gates depend on the observability extension. When the observability extension is not active, affected rules are degraded to manual approval gates. Once the customer accepts the degradation, the degraded rules are treated as **non-blocking** — they are enforced in their manual-approval form and do not prevent stage completion.

The following DEPLOY rules reference AIOBS rules directly:

| DEPLOY Rule | Depends On | Why |
|---|---|---|
| DEPLOY-APP-002 | AIOBS-ALARM-001, AIOBS-ALARM-005 | Per-boundary composite alarms are the gate signal between deployment phases |
| DEPLOY-APP-003 | AIOBS-ALARM-001 | Operational alarms trigger automatic rollback |

**When the observability extension is NOT active**: Alarm-gated deployment phases cannot be implemented. The model MUST degrade to manual approval gates between phases — a human must explicitly approve each phase before the next begins. Log the degradation to audit.

---

## DEPLOYMENT STRATEGY

---

### Rule DEPLOY-STRAT-001: Infrastructure as Code is Mandatory

**Rule**: Every deployable service MUST have its infrastructure defined as code. IaC is a required deliverable alongside application code — not optional, not deferred. A service without IaC cannot be deployed consistently, cannot be rolled back reliably, and cannot be reproduced in other environments.

The model MUST include an IaC generation step in the code generation plan for every deployable service.

**Verification**:
- IaC generation is a named step in the code generation plan
- IaC files exist in the workspace
- IaC covers all AWS resources required by the service

---

### Rule DEPLOY-STRAT-002: Deployments Must Not Cause Undetected Customer Impact

**Rule**: Every deployment MUST be designed so that customer impact from a bad deployment is detected and mitigated before it affects the full customer base. This is the fundamental deployment safety principle.

A deployment that cannot be detected as bad, or that cannot be rolled back quickly, will eventually cause an extended outage.

**Verification**:
- Every deployment has observability that can detect customer impact during the deployment window (AIOBS-ALARM-001)
- Every deployment has an automatic rollback mechanism triggered by operational alarms
- Rollback does not require manual intervention to initiate

---

### Rule DEPLOY-STRAT-003: Phase Deployments to Respect Fault Isolation Boundaries

**Rule**: Deployments MUST be phased to limit the blast radius of a bad deployment. The phasing strategy MUST align with the fault isolation boundaries identified for the architecture (AIREC-STRAT-003).

**Phasing principle**: Deploy to the smallest fault isolation boundary first. Validate using the operational alarms for that boundary (AIOBS-ALARM-005). Only proceed to the next boundary when alarms confirm the deployment is healthy.

**Boundary order** (smallest to largest):
1. Single instance (one-box) within an AZ
2. Full AZ
3. Next AZ (repeat per AZ)
4. Secondary region (if multi-region)

Where the architecture includes application-level fault boundaries (cells, shards), these MUST also be respected — deploy to one cell before the fleet.

**Verification**:
- Deployment pipeline implements phased rollout aligned to the architecture's fault isolation boundaries
- Each phase is alarm-gated before proceeding (AIOBS-ALARM-005)
- A bad deployment in any phase triggers rollback and does not proceed to later phases

**Customer Validation**: Bake time duration is a business decision — longer bake time reduces risk but increases deployment time. The model MUST present the proposed bake time for customer approval.

```markdown
## Question: Deployment Bake Time

Each deployment phase will observe for a bake time before proceeding to the next
phase. During bake time, operational alarms are monitored. If any alarm fires,
the deployment rolls back automatically.

Proposed bake time per phase: 5 minutes (minimum recommended)

A) Approve — 5 minutes is acceptable
B) Increase — I want a longer bake time (specify after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

---

### Rule DEPLOY-STRAT-004: Rollback First, Ask Questions Later

**Rule**: When a deployment alarm fires, the system MUST roll back automatically without waiting for human decision. Root cause analysis happens after rollback. The cost of an unnecessary rollback is always lower than the cost of an extended outage.

Rollback MUST:
- Be triggered automatically by the same operational alarms used for monitoring (AIOBS-ALARM-001)
- Complete within the deployment phase window
- Return the system to the last known good state
- Not require destructive changes to data

**Verification**:
- Automatic rollback is configured and triggered by operational CloudWatch alarms
- Rollback completes within the deployment phase window
- Rollback is tested as part of the deployment pipeline

---

### Rule DEPLOY-STRAT-005: Deployment Pipeline and Runbook Parity

**Rule**: The deployment pipeline and process used for testing MUST be identical to the one used for production. Separate runbooks for test and production introduce risk.

**Verification**:
- A single deployment pipeline and runbook is used for all environments
- The pipeline is tested in lower environments before production

---

## DEPLOYMENT COMPLETENESS

These rules define the target state for deployment completeness: every component DLC builds operates correctly at runtime because every dependency was identified, built, and deployed.

---

### Rule DEPLOY-COMP-001: Every Runtime Dependency Is Identified and Provisioned

**Rule**: Every component in the architecture MUST have all runtime dependencies explicitly identified and provisioned. A runtime dependency is anything that must exist in the target environment for a component to start, serve requests, or be verified as healthy — and that is not automatically created by deploying the component's own application code.

Runtime dependencies include but are not limited to: credentials and secrets, runtime configuration and parameters, initialisation scripts (migrations, seed data), verification prerequisites (test identities for canaries and integration tests), and external prerequisites (DNS records, certificates, IAM permissions).

**No dependency may be assumed to exist.** Every dependency MUST be provisioned automatically — preferably via IaC (e.g. writing a secret value into Secrets Manager, setting an SSM parameter, creating a Cognito test user via CDK custom resource), or alternatively via a generated automation script (e.g. a migration script that applies the schema, a seed script that loads reference data, a provisioning script that creates a test identity and stores its credentials).

**Verification**:
- Every component has been evaluated for runtime dependencies
- Every identified dependency has a provisioning mechanism assigned (IaC or script)
- No component carries an unresolved implicit assumption about its environment

---

### Rule DEPLOY-COMP-002: Everything DLC Builds Gets Deployed

**Rule**: Every artifact produced by Construction MUST be deployed. Every dependency identified under DEPLOY-COMP-001 MUST have a corresponding construction task in the code generation plan. There are no manual dependencies and no deferred provisioning.

Every dependency MUST be provisioned automatically — preferably via IaC (e.g. writing a secret value into Secrets Manager, setting an SSM parameter, creating a Cognito test user via CDK custom resource), or alternatively via a generated automation script (e.g. a migration script that applies the schema, a seed script that loads reference data, a provisioning script that creates a test identity and stores its credentials). If a dependency cannot be provisioned automatically, it is a design gap — a blocking finding that MUST be resolved before Code Generation proceeds.

**Verification**:
- Every dependency in the DEPLOY-COMP-001 list has a corresponding step in the code generation plan
- The code generation plan has been cross-checked against the dependency list and the cross-check is recorded in the construction artifacts
- No dependency is deferred, assumed, or left unprovisioned
