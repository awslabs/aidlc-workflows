# Deployment — Pipeline Rules

## Overview
These rules define **how** to implement the CI/CD pipeline that orchestrates deployment and production validation. The pipeline is the outer orchestration layer — it sequences deployment stages, enforces gates, and manages the transition from pre-production to production.

Build, unit testing, IaC synthesis, and static analysis are performed by the AI-DLC Construction phase before code enters the pipeline. The pipeline begins when triggered after the pipeline stack is deployed.

**Applies when**: Deployment extension is active (Answer A or B).

**Prefix**: `DEPLOY-PIPE-`

---

## Observability Dependency

| DEPLOY Rule | Depends On | Why |
|---|---|---|
| DEPLOY-PIPE-003 | AIOBS-ALARM-001, AIOBS-ALARM-005 | Per-boundary composite alarms are the validation gate for production deployment stages |
| DEPLOY-PIPE-012 | AIOBS-CLIENT-001, AIOBS-ALARM-001 | Pipeline Test stage checks canary status and alarm state |

When the observability extension is not active, alarm-based pipeline gates cannot be implemented. Degrade to manual approval gates between stages. The pipeline Test stage (DEPLOY-PIPE-012) degrades to executing security boundary tests (DEPLOY-TEST-002) only — canary and alarm checks are skipped. Log to audit.

---

### Rule DEPLOY-PIPE-001: Pipeline Must Be Defined as Code and Deployable

**Rule**: The CI/CD pipeline MUST be defined as IaC and deployed as infrastructure in the target environment. The pipeline MUST be a resource the Deployment stage can deploy, trigger, and observe from within the current environment.

The model MUST determine the appropriate pipeline tool from the tech stack and organisational context. The pipeline tool is not prescribed — it is derived:
- If tech-env.md specifies a tool, use it
- If not specified, evaluate the architecture and choose the tool that best fits the target environment

**Reachability requirement**: The chosen pipeline tool MUST satisfy ALL of the following:
1. The model can deploy it as infrastructure to the target AWS account (it is an IaC-managed resource)
2. The model can trigger its execution from the current environment
3. The model can observe its execution status and stage outcomes from the current environment

A pipeline tool that cannot be deployed, triggered, and observed from the current environment is NOT a valid choice — regardless of whether it would work in a different context. If the workspace is deploying to AWS, the pipeline MUST be deployable to AWS.

**Verification**:
- Pipeline is defined as IaC (a deployable infrastructure resource, not just a configuration file)
- Pipeline is deployed as a resource in the target AWS account
- Pipeline can be triggered from the current environment
- Pipeline execution status is observable from the current environment
- The pipeline tool choice is documented with rationale

**Customer Validation** (only when pipeline tool is not specified in tech-env.md): The model MUST present the derived pipeline tool choice for customer approval.

```markdown
## Question: Pipeline Tool Selection

No CI/CD pipeline tool was specified in tech-env.md. Based on the architecture,
the following pipeline tool has been selected:

**Proposed tool**: [tool]
**Rationale**: [why this tool best fits the architecture and hosting environment]
**Reachability**: [confirmation that the tool can be deployed, triggered, and observed from the current environment]

A) Approve — proceed with this pipeline tool
B) Modify — I want a different tool (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

---

### Rule DEPLOY-PIPE-002: Pipeline Stages Must Cover Deployment and Validation

**Rule**: The pipeline MUST include stages covering deployment and validation as defined in DEPLOY-PIPE-008. The stage ordering and environment targeting defined in DEPLOY-PIPE-008 is mandatory.

Each stage MUST be a blocking gate — a failure in any stage MUST stop the pipeline and prevent progression to subsequent stages.

**Verification**:
- Pipeline includes all stages defined in DEPLOY-PIPE-008
- Each stage is a blocking gate
- Pipeline fails fast — a failing stage stops the pipeline immediately

---

### Rule DEPLOY-PIPE-003: Alarm-Based Bake Gate for Production Deployments

**Rule**: After each production deployment stage, the pipeline MUST include an alarm-based bake gate that monitors the operational alarms for the deployment's fault isolation boundary (AIOBS-ALARM-005) for a defined window before allowing progression.

This gate applies to production deployments only. Pre-production deployments are validated by the pipeline Test stage (DEPLOY-PIPE-012) and human approval gate (DEPLOY-PIPE-013) instead.

**Gate behaviour**:
- Monitor the per-boundary composite alarms (AIOBS-ALARM-005) for a minimum of 5 minutes
- If any Detect-tier alarm (AIOBS-ALARM-001) fires during the window → trigger automatic rollback and fail the pipeline
- If alarms remain clear for the full window → mark the deployment successful and allow pipeline to proceed

**When observability is not active**: Replace the alarm gate with a manual approval step. A human must explicitly approve the deployment before the pipeline proceeds. Log the manual approval to audit.

**Verification**:
- Pipeline includes an alarm-based bake gate after each production deployment stage
- Bake gate monitors per-boundary composite alarms (AIOBS-ALARM-005)
- Alarm firing during bake triggers automatic rollback
- Bake window is at least 5 minutes
- When observability is not active, a manual approval gate is present

---

### Rule DEPLOY-PIPE-004: Start with the Smallest Deployable Unit

**Rule**: Every deployment — whether application code, IaC, database change, configuration change, or DNS change — MUST start with the smallest possible deployable unit before expanding. This is the universal phasing principle.

**For each type of change, identify the smallest deployable unit**:

| Change Type | Smallest Deployable Unit | Expand To |
|---|---|---|
| Application code (EC2/ECS on EC2) | One instance (one-box) | One AZ → remaining AZs |
| Application code (Lambda) | Weighted alias (small %) | Increase weight → full traffic |
| Application code (ECS Fargate) | One task (rolling, min healthy %) | Remaining tasks |
| Application code (EKS) | One pod (maxSurge=1) | Remaining pods |
| IaC / infrastructure change | One environment or one cell | Remaining environments/cells |
| Database schema change | Read replica or test table | Primary / remaining tables |
| Configuration change | One parameter / one instance | Remaining instances |
| IAM policy change | One role / one canary instance | Full fleet |
| DNS / routing change | Small traffic weight (e.g. 1–5%) | Increase weight → full traffic |

**When the smallest unit is not achievable**: Some changes cannot be applied to a subset (e.g. a database migration that must be atomic). In this case, the model MUST document why the smallest unit strategy cannot be applied, present the risk to the customer, and get explicit validation before proceeding. Log to audit.

**Bake time**: After deploying to the smallest unit, the pipeline MUST observe for a minimum bake time (5 minutes) before expanding. During bake time, monitor per-boundary composite alarms (AIOBS-ALARM-005). If any Detect-tier alarm (AIOBS-ALARM-001) fires → rollback immediately.

**Verification**:
- Every change type has an identified smallest deployable unit documented in the deployment design
- Pipeline starts with the smallest unit before expanding
- Bake time (minimum 5 minutes) is enforced after each phase
- When smallest unit is not achievable, customer validation is obtained and logged to audit

---

### Rule DEPLOY-PIPE-005: Never Cross a Fault Isolation Boundary in a Single Deployment Action

**Rule**: A deployment MUST NEVER cross a fault isolation boundary in a single action. Each fault isolation boundary (instance → AZ, AZ → AZ, cell → cell, region → region) MUST be a separate deployment phase with bake time between them.

**Why**: Crossing a boundary in a single action means the blast radius expands immediately without an observation window. A latent issue that hasn't manifested in the first boundary will immediately affect the next boundary's customers.

**If the deployment mechanism cannot support boundary-by-boundary phasing** (e.g. a database migration that must be applied atomically across all instances, a global configuration change with no partial application mechanism):
1. The model MUST alert the customer that a boundary crossing cannot be avoided
2. The model MUST explain the risk: the blast radius will expand immediately with no intermediate observation window
3. The customer MUST explicitly validate before the deployment proceeds
4. The accepted risk MUST be logged to audit with the customer's explicit acceptance

The default is **never cross**. The exception requires customer sign-off and an audit trail.

**Verification**:
- Each fault isolation boundary crossing is a separate pipeline stage
- No single deployment action crosses more than one fault isolation boundary
- When boundary crossing cannot be avoided, customer validation is obtained and logged to audit

---

### Rule DEPLOY-PIPE-006: Pipeline Must Be Tested Before Production

**Rule**: The pipeline itself MUST be tested in a lower environment before being used for production deployments. A pipeline that has never been executed end-to-end cannot be trusted to work correctly under pressure.

**Verification**:
- Pipeline has been executed successfully in at least one non-production environment
- Pipeline rollback has been tested (deliberately trigger a failing deployment and confirm rollback executes)
- Pipeline test results are documented

---

### Rule DEPLOY-PIPE-007: Pipeline Must Target Separate Environments

**Rule**: The pipeline MUST deploy through at least two isolated environments before serving live customer traffic:

1. **Pre-production** — full stack deployment mirroring production topology. Used for integration testing and operational validation post-deploy.
2. **Production** — live customer traffic. One deployment target per region if multi-region.

Each environment MUST be isolated. Separate AWS accounts per environment is recommended. At minimum, separate CloudFormation stacks with no shared state.

The model MUST derive the environment set from the architecture and present it for customer approval. The environment strategy MUST be approved before pipeline code is generated.

The model MUST determine whether the customer requires additional environments to separate pre-production concerns (e.g., dedicated performance testing, security scanning, data migration validation). If the architecture or regulatory context warrants additional environments, the model MUST propose them.

**Customer Validation**: The model MUST present the derived environment strategy for customer approval.

```markdown
## Question: Deployment Environments

Based on the architecture, the following environments and pipeline stages
are proposed:

| Environment | Purpose | Pipeline Stages | Isolation |
|-------------|---------|-----------------|-----------|
| [env name] | [purpose] | [stages that target this env] | [isolation method] |

A) Approve — proceed with these environments
B) Add environment — I need an additional environment (describe after [Answer]: tag)
C) Modify — change the proposed environments (describe after [Answer]: tag)
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

**Verification**:
- At least pre-production and production environments are defined
- Environment strategy is documented and customer-approved
- Pre-production mirrors production topology (same services, same multi-AZ, same region count if multi-region)
- Each environment is isolated (separate account or separate stacks with no shared state)
- Each environment transition in the pipeline is gated

---

### Rule DEPLOY-PIPE-008: Pipeline Stage Ordering

**Rule**: Pipeline stages MUST follow this ordering. The pipeline is triggered after the pipeline stack is deployed.

| # | Stage | Purpose | On Failure |
|---|-------|---------|------------|
| 1 | **Source** | Pulls workspace repository | Pipeline stops |
| 2 | **Deploy to Pre-Production** | Deploy artifacts to pre-prod environment | Pipeline stops |
| 3 | **Provisioning** | Execute provisioning scripts (DEPLOY-IAC-004 fallback) | Pipeline stops |
| 4 | **Test** | Verify canaries passing (DEPLOY-TEST-001), execute security boundary tests (DEPLOY-TEST-002), verify alarms clear | Pipeline stops |
| 5 | **Human Approval** | Human authorises production deployment (DEPLOY-PIPE-013) | Pipeline stops |
| 6 | **Deploy to Production (primary)** | Progressive deployment (DEPLOY-APP-001/002, DEPLOY-PIPE-004/005) | Automatic rollback |
| 7 | **Alarm Bake (primary)** | Monitor composite alarms for bake period (DEPLOY-PIPE-003) | Automatic rollback |
| 8 | **Human Approval (multi-region)** | Human confirms primary region healthy before secondary | Pipeline stops |
| 9 | **Deploy to Production (secondary)** | Same phased approach (DEPLOY-APP-004) | Automatic rollback |
| 10 | **Alarm Bake (secondary)** | Monitor secondary region alarms | Automatic rollback |

Stages 8–10 apply only to multi-region architectures.

- **Include Provisioning stage (3) IF**: DEPLOY-IAC-004 documents any dependency that requires script-based provisioning (IaC technically cannot express it, justification documented).
- **Omit Provisioning stage (3) IF**: All runtime dependencies are expressed in IaC with no script fallbacks. Stage numbering shifts accordingly.

Each stage is a blocking gate — failure stops the pipeline. No stage may be skipped or reordered.

Construction IS the build. Artifacts enter the pipeline already compiled, tested, and packaged. The pipeline does not rebuild from source — it deploys what Construction produced.

**Verification**:
- Pipeline includes Source stage that pulls from the workspace repository
- Pre-production deployment occurs before any production deployment
- Test stage exists between pre-prod deploy and human approval (DEPLOY-PIPE-012)
- Human approval gate exists between test and production (DEPLOY-PIPE-013)
- Production deployment includes alarm bake after each deploy
- Multi-region deployments include human approval between regions
- Each stage is a blocking gate
- No compilation, packaging, or build-from-source in any pipeline stage

---

### Rule DEPLOY-PIPE-009: Operational Readiness Verification

**Rule**: After the pipeline Test stage completes successfully, the model MUST perform operational readiness verification against the pre-production environment. This verification informs the human approval decision (DEPLOY-PIPE-013) and is performed by the model from the IDE, not as a pipeline stage.

Operational readiness covers concerns that require model reasoning about correctness — the pipeline can check pass/fail, but only the model can assess whether the configuration is correct for this specific workload.

The model MUST verify:

1. **Pipeline test results** — read the pipeline Test stage output. Confirm all DEPLOY-TEST-001 and DEPLOY-TEST-002 tests passed. Assess whether test coverage is adequate for the architecture (Post-Deployment Testing Step 3).
2. **Alarm coverage** — every resource in the deployment has the alarms required by the observability rules, with correct thresholds
3. **Canary configuration** — synthetic canaries are deployed, running on schedule, and reporting correctly
4. **Dashboard existence** — required dashboards exist with expected widgets and correct metric references
5. **Health check depth** — health endpoints verify downstream dependency connectivity, not just return 200
6. **Recovery control readiness** — ARC readiness checks pass (if recovery extension is active)

When the observability extension is not active, degrade to verifying that manual monitoring procedures are documented.

Results are presented to the human as part of the production approval decision (DEPLOY-PIPE-013).

**Verification**:
- Pipeline test results reviewed and assessed for adequacy
- Operational readiness checks performed against deployed operational artifacts
- Results presented to the human with clear recommendation
- Failed checks result in rework (Construction artifact failure) or BLOCKED (environment failure)

**Cross-references**:
- DEPLOY-TEST-001 (canary tests — pipeline checked pass/fail; model assesses coverage)
- DEPLOY-TEST-002 (security tests — pipeline checked pass/fail; model assesses coverage)
- DEPLOY-TEST-004 (operational readiness test criteria)
- DEPLOY-PIPE-013 (human approval informed by these results)

---

### Rule DEPLOY-PIPE-011: Source Stage References Workspace Repository

**Rule**: The pipeline's Source stage MUST reference the workspace root directory as its source repository. The workspace root (as detected during Workspace Detection and recorded in `aidlc-state.md`) IS the repository. The pipeline Source stage MUST use this directory directly — the same directory where Construction generated all artifacts.

All generated artifacts MUST reside in the workspace: application code, IaC, built artifacts, tests, pipeline definition, deployment scripts, canary scripts, security boundary test scripts, and configuration. The pipeline Source stage pulls everything it needs from this single location.

Construction IS the build. Artifacts enter the pipeline already compiled, tested, and packaged. The pipeline does not rebuild from source.

**Verification**:
- Pipeline Source stage references the workspace repository (the same directory Construction writes to)
- All generated artifacts are in the workspace repository
- No new repository connections or external source providers are created
- No placeholder, dummy, or non-functional source references exist — a placeholder ARN is FAIL
- No compilation, packaging, or rebuild-from-source occurs in any pipeline stage

**Cross-references**:
- DEPLOY-PIPE-001 (pipeline defined as code — in the same repository it pulls from)
- DEPLOY-PIPE-012 (Test stage consumes deployed artifacts)
- DEPLOY-IAC-001 (IaC is in workspace)
- DEPLOY-TEST-002 (security boundary test scripts are in workspace)

---

### Rule DEPLOY-PIPE-012: Pipeline Test Stage

**Rule**: The pipeline MUST include a Test stage after deploying to pre-production. The Test stage verifies the deployment is healthy and secure before the human approval gate. Test failure MUST stop the pipeline.

The Test stage MUST:
1. Verify all deployed canaries (DEPLOY-TEST-001) are executing and passing
2. Execute security boundary test scripts (DEPLOY-TEST-002) against the pre-prod deployment
3. Verify all alarms are in OK state (no alarm conditions firing)

Any failure MUST stop the pipeline. A pipeline that reaches the human approval gate has proven: the system is deployed, canaries confirm user journeys work, security boundaries reject invalid requests, and no alarms are firing.

The Test stage MUST wire deployment outputs from the preceding Deploy stage to the test execution. The pre-production Deploy stage produces outputs (endpoints, ARNs, URLs). The Test stage consumes them as input (environment variables, parameter references, stage output variables).

**Verification**:
- Pipeline includes a Test stage between pre-prod Deploy and human approval gate (DEPLOY-PIPE-013)
- Test stage checks canary execution status
- Test stage runs security boundary test scripts (DEPLOY-TEST-002)
- Test stage checks alarm state
- Test stage receives deployment outputs from the preceding Deploy stage
- Any failure blocks pipeline progression
- Test results are published to a location the model can read (for Post-Deployment adequacy assessment)

**Cross-references**:
- DEPLOY-TEST-001 (canary tests — what to check)
- DEPLOY-TEST-002 (security boundary tests — what to run)
- DEPLOY-PIPE-008 (stage ordering: Deploy pre-prod → Test → Human Approval)
- DEPLOY-PIPE-013 (human approval gate follows Test stage)

---

### Rule DEPLOY-PIPE-013: Human Approval Gate Before Production

**Rule**: The pipeline MUST include a human approval gate between the Test stage and production deployment. The pipeline MUST NOT deploy to production without explicit human authorisation.

The model's role is to inform the human's decision, not to make it. After the pipeline Test stage passes and Post-Deployment Testing completes its verification (DEPLOY-PIPE-009, DEPLOY-TEST-003, DEPLOY-TEST-004), the model MUST present:
- Pipeline test results (DEPLOY-TEST-001 + 002 pass/fail and adequacy assessment)
- Functional correctness results (DEPLOY-TEST-003)
- Operational readiness results (DEPLOY-TEST-004)
- Any unresolved issues or known risks
- Clear recommendation: approve for production or do not approve (with reasons)

The human approves → pipeline proceeds to production deployment.
The human rejects → pipeline stops. Model triggers rework if appropriate.

**Verification**:
- Pipeline includes a manual approval action between Test stage and production Deploy
- Pipeline does not progress to production without human approval
- No automated or programmatic bypass of the approval gate exists
- Approval information is presented to the human with a clear recommendation

**Cross-references**:
- DEPLOY-PIPE-012 (Test stage provides automated test results)
- DEPLOY-PIPE-009 (operational readiness provides model-driven assessment)
- DEPLOY-PIPE-003 (alarm bake follows production deploy — separate from this gate)
- DEPLOY-APP-004 (multi-region: additional human approval between regions at DEPLOY-PIPE-008 stage 7)

---

### Rule DEPLOY-PIPE-014: Pipeline Must Be Verified Functional

**Rule**: A pipeline is NOT complete until it has executed successfully through at least Source, Deploy-to-Pre-Production, and Test stages. A pipeline that exists as deployed infrastructure but has never executed is unverified — equivalent to code that compiles but was never run.

After the Operations Deployment stage deploys the pipeline infrastructure, it MUST trigger the pipeline. Successful execution through the Test stage is the minimum acceptance criterion.

**Verification**:
- Pipeline has been triggered at least once
- Source stage successfully pulled from workspace repository
- Deploy-to-Pre-Production stage deployed successfully
- Test stage executed and reported results
- If pipeline has never executed, all DEPLOY-PIPE rules are FAIL during Rules Validation

**Cross-references**:
- DEPLOY-PIPE-006 (this rule defines what "tested" means)
- DEPLOY-PIPE-011 (source references workspace repository)
- DEPLOY-PIPE-012 (Test stage must execute)

