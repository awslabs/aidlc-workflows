# Deployment — Deploy and Confirm

> **OVERRIDE**: This file is exempt from the Adaptive Workflow Principle and adaptive depth. Every step MUST be executed exactly as written. The model MUST NOT skip, defer, or partially complete any step. The ONLY acceptable outcome of this stage is: pipeline deployed, pipeline triggered and executed through Test stage (paused at Human Approval gate), all components verified present in pre-production — or a BLOCKED status with command output proving deployment is impossible.

**Purpose**: Deploy the complete workload — infrastructure, application artifacts, and assets/data — to the target environment and confirm every deployable component is present and observable.

**Condition**: This stage always executes. Step 2 checks whether the `extensions/deployment` extension is active — if not, the customer is asked whether to proceed. The stage may mark itself SKIPPED based on the customer's answer.

**Prerequisite**: Rules Validation stage must be complete.

**State Tracking**: Every outcome (BLOCKED, COMPLETE) MUST be recorded in `aidlc-docs/aidlc-state.md` with the stage name, status, and reason.

**Scope**: This stage deploys and confirms presence. It does not test behaviour. Behaviour testing is Post-Deployment Testing, which depends on this stage being COMPLETE.

**What COMPLETE means**: All infrastructure deployed (including pipeline), pipeline triggered and executed successfully through the Test stage (paused at Human Approval gate), all deployable components verified present in the pre-production environment, and human-required tests documented. IaC deployed alone is NOT completion — the pipeline MUST have executed and its Test stage MUST have passed.

**Build Log**: All deployment commands, outputs, and failure classifications MUST be recorded in `aidlc-docs/operations/deployment-deploy.md`. This file is the single source of truth for what was attempted, what succeeded, and what failed during deployment.

**Audit Logging**: Every rework invocation and every BLOCKED decision MUST be logged in `aidlc-docs/audit.md` with: the step number, the failed component(s), the classification, and the action taken (rework invoked / BLOCKED recorded).

---

## Step 1: Verify Upstream Artifacts

1. You MUST read each of the following artifacts:

| Artifact | Location | Produced By |
|----------|----------|-------------|
| Infrastructure design | `aidlc-docs/construction/{unit}/infrastructure-design/infrastructure-design.md` | Infrastructure Design |
| Extension plan rule mapping | `aidlc-docs/construction/plans/{unit}-extension-plan-rule-mapping.md` | Infrastructure Design (Steps 10–18) |
| Build and test summary | `aidlc-docs/construction/build-and-test/build-and-test-summary.md` | Build and Test |
| aidlc-state.md | `aidlc-docs/aidlc-state.md` | Requirements Analysis |

2. You MUST confirm every artifact exists. If any artifact is missing:
   - **GAP IF**: re-executing a Construction stage could produce the missing artifact. **MANDATORY**: You MUST load `common/design-rework.md` and follow its steps exactly to loop back to Construction.

Validation check:
- **MANDATORY**: You MUST NOT proceed to Step 2 until all 4 artifacts exist.
- **MANDATORY**: If the extension plan rule mapping is missing and extensions are active, this is a GAP. You MUST load `common/design-rework.md`.

---

## Step 2: Deployment Opt-In Check

**MANDATORY**: You MUST perform this check before proceeding. You MUST NOT skip this step or assume the answer.

1. **Check `extensions/deployment` extension status**: You MUST read the Extension Configuration from `aidlc-docs/aidlc-state.md`. You MUST check whether the `extensions/deployment` extension has a corresponding `extensions/deployment/` directory with loaded rule files.
2. **IF `operations/deployment` rules are loaded** (extension active, answer other than D/No): Proceed to Step 3. Do NOT present the question below.
3. **IF `operations/deployment` rules are NOT loaded**: Present the following question to the customer. **MANDATORY**: You MUST wait for the customer's answer. You MUST NOT proceed without it.

```markdown
## Question: Test Deployment

Would you like the Operations phase to test deployment of your workload to a live environment?

A) Yes — deploy the workload and run post-deployment testing
B) No — skip deployment and post-deployment testing

[Answer]:
```

4. **Record the answer**: You MUST record in `aidlc-docs/audit.md`:

```markdown
## Deployment — Opt-In Check
**Timestamp**: [ISO timestamp]
**Context**: `extensions/deployment` extension not active — customer asked whether to test deployment
**Answer**: [A or B with full text]
```

5. **IF answer is B (No)**: Record stage status as SKIPPED in `aidlc-docs/aidlc-state.md`. Present: "Deployment stage SKIPPED — customer declined deployment testing." Do NOT proceed to Step 3.
6. **IF answer is A (Yes)**: Proceed to Step 3.

---

## Step 3: Verify Environment Prerequisites

**MANDATORY**: You MUST execute each check by running a command. **MANDATORY**: You MUST NOT assume a tool is unavailable without proving it by attempting to install and run it. Record the command and output for each check.

1. **IaC tool available**: You MUST run the version command (e.g. `npx cdk --version`, `terraform --version`). If not found, attempt to install. Only mark unavailable if install fails — record command and error.
2. **Cloud CLI available**: You MUST run the version command (e.g. `aws --version`). If not found, attempt to install. Only mark unavailable if install fails — record command and error.
3. **Credentials configured**: You MUST run `aws sts get-caller-identity` (or equivalent). Only mark as blocked if the command returns an authentication error — record command and error.
4. **Target account and region**: You MUST read the target account and region. Account ID is already known from the credential check in item 3 (`aws sts get-caller-identity`). Target regions MUST be read from the infrastructure design artifacts or tech-env.md. If regions are not specified, ask the user.
5. **Failed stack check**: You MUST run for each target region `aws cloudformation list-stacks --stack-status-filter CREATE_FAILED ROLLBACK_COMPLETE UPDATE_ROLLBACK_COMPLETE UPDATE_ROLLBACK_FAILED DELETE_FAILED --region {region}` and check for any stacks whose names match the project. If any exist, record stage status as BLOCKED and present to the user: "The following stacks are in a failed state and must be deleted before deployment can proceed: [list]." The user MUST delete them before proceeding.
6. **IaC bootstrapping**: You MUST run the bootstrap command in each target region (e.g. `cdk bootstrap aws://ACCOUNT/REGION`). Only mark as blocked if bootstrapping fails — record command and error.

If any check fails after attempting, present the command output to the user. Record the failed check and output in `aidlc-docs/operations/deployment-deploy.md`. Record stage status as BLOCKED with the exact error. Do NOT proceed to Step 4.

**Wait for Explicit Approval**: User must confirm prerequisites are satisfied before proceeding.

---

## Step 4: Build Deployment Inventory

Build the inventory by working through each source in sequence — do not skip ahead to categorisation until all sources have been read.

1. **Read infrastructure design**: You MUST read the infrastructure design for each unit (`aidlc-docs/construction/{unit}/infrastructure-design/`). You MUST list every named AWS resource: every Lambda function, every database, every queue, every S3 bucket, every API Gateway, every CloudFront distribution, every VPC.

2. **Read extension plan rule mapping**: You MUST read the extension plan rule mapping for each unit (`aidlc-docs/construction/plans/{unit}-extension-plan-rule-mapping.md`). You MUST add any resources listed there that are not already in the list.

3. **Read build-and-test summary**: You MUST read `aidlc-docs/construction/build-and-test/build-and-test-summary.md`. You MUST list every artifact produced: Lambda packages, container images, frontend bundles, migration scripts, test artifacts.

4. **Scan workspace**: You MUST list every file and directory in the workspace root recursively. You MUST NOT filter — list everything.

5. **Identify deployable artifacts**: For each file/directory in the scan, you MUST determine whether it needs to be deployed to make the application function. A deployable artifact is anything that must exist in the target environment for the application to run correctly — application code, database schemas, configuration, static assets, etc.

6. **Cross-check**: For every resource type in the infrastructure design, you MUST verify the corresponding deployable artifact exists:
   - Database → are there migration/schema scripts in the workspace?
   - Lambda function → is there packaged code or a source directory?
   - Frontend (S3 + CDN) → is there a built bundle or build script?
   - **Authenticated components** (canaries, integration test scripts, synthetic monitors) → do they make calls to protected endpoints? If yes, is there a test identity (Cognito user, API key, service account) that needs to be provisioned, and are the credentials stored in a suitable credential store (e.g. AWS Secrets Manager)? If a test identity is needed but not provisioned, add it as an Assets/Data component.
   - If a resource type has no corresponding artifact, record it as a gap and explain why (e.g. "Aurora — no migration scripts found in workspace/backend/alembic/")

7. **Categorise**: You MUST categorise every component into one of three types:

| Type | Examples |
|------|---------|
| **Infrastructure** | CloudFormation/CDK stacks, Terraform modules, VPCs, databases, queues, API Gateways, Lambda function definitions, S3 buckets, CloudFront distributions |
| **Application Artifacts** | Lambda function code packages, container images, compiled backend binaries, built frontend bundles (e.g. `dist/`, `build/`) |
| **Assets/Data** | Database migration scripts (e.g. `alembic/versions/`), seed data, static assets (images, fonts, config files), secrets/parameters in Parameter Store or Secrets Manager |

8. **Write the inventory**: You MUST write the inventory to `aidlc-docs/operations/deployment-inventory.md`:

```markdown
# Deployment Inventory

## Infrastructure Components
| Component | Stack/Module | Target Region(s) |
|-----------|-------------|-----------------|
| [name] | [stack name] | [region] |

## Application Artifact Components
| Component | Type | Source | Destination |
|-----------|------|--------|-------------|
| [name] | Lambda/Container/Frontend/Binary | [source path] | [target: ARN/bucket/registry] |

## Assets/Data Components
| Component | Type | Source | Destination |
|-----------|------|--------|-------------|
| [name] | Migration/SeedData/Config/Secret | [source] | [target] |
```

Validation check:
- **MANDATORY**: You MUST NOT proceed to Step 5 until `aidlc-docs/operations/deployment-inventory.md` exists and passes both checks:
  1. Every deployable artifact in `aidlc-docs/construction/plans/{unit}-code-generation-plan.md` MUST appear in the inventory. The code generation plan is the definitive list of what Construction built — if it is in the plan, it must be in the inventory. If any artifact is absent, go back and add it.
  2. Every deployable artifact identified in the workspace scan (step 5 above) MUST appear in the inventory. If any artifact is absent, go back and add it.

---

## Step 5: Verify Deployment Automation Coverage

For every component in the deployment inventory, verify there is explicit deployment automation that will deploy it.

1. **Verify infrastructure coverage**: You MUST confirm for each Infrastructure component in the inventory, confirm an IaC deploy command covers this stack/module. Record COVERED or GAP.

2. **Verify application artifact coverage**: You MUST confirm for each Application Artifact component, confirm there is an explicit step/script/command to build and deploy this artifact. Record COVERED or GAP.

3. **Verify assets/data coverage**: You MUST confirm for each Assets/Data component, confirm there is an explicit step/script/command to apply migrations, upload assets, or write config. Record COVERED or GAP.

4. **Verify pipeline exists as deployable IaC**: You MUST confirm a pipeline stack exists in the deployment inventory as a deployable IaC resource (DEPLOY-PIPE-001). Record COVERED or GAP.

5. **Verify pipeline tool reachable**: You MUST run a command that proves access to the pipeline service from the current environment (e.g. `aws codepipeline list-pipelines --region {region}`). Record COVERED or GAP.

6. **Resolve Coverage Gaps**: If any Coverage Gaps exist:
   - List every gap with the component name and type
   - Classify each gap as one of the following ONLY:
     - **GAP IF**: creating or changing a code artifact produced by Construction could fix the failure . **MANDATORY**: You MUST load `common/design-rework.md` and follow its steps exactly to loop back to Construction. You MUST NOT fix the artifact inline.
     - **GAP IF**: a chosen tool is not reachable or accessible from the current environment . **MANDATORY**: You MUST load `common/design-rework.md` and follow its steps exactly. Choosing a tool that cannot be used is a design failure.
     - **Environment failure IF**: no change to any code artifact by loading `common/design-rework.md` and following its steps exactly to loop back to Construction could fix the failure (e.g. `ExpiredTokenException`, AWS service unavailable in region) . You MUST record as BLOCKED with command output proving the failure is outside the workflow's control.

Validation check:
- **MANDATORY**: You MUST NOT proceed to Step 6 until all Coverage Gaps are resolved. Every component in the inventory MUST have COVERED status. Pipeline stack MUST exist. Pipeline tool MUST be reachable.
- **MANDATORY**: Every BLOCKED classification MUST have command output recorded as evidence proving the failure is outside Construction's control (e.g. `aws sts get-caller-identity` returns `ExpiredTokenException`). A BLOCKED without command output is invalid — reclassify as Construction failure and rework.

---

## Step 6: Deploy Pipeline

**The goal of this step is a deployed pipeline that will deploy all other infrastructure. The pipeline stack is the ONLY stack deployed directly. All other stacks are deployed BY the pipeline as stages within it. MANDATORY: You MUST run the deploy command.**

1. **Identify the pipeline stack**: You MUST identify the stack that defines the deployment pipeline from the deployment inventory. This is the ONLY stack deployed in this step. All other stacks (compute, data, networking, API, frontend, observability, recovery) are pipeline stages — they are deployed BY the pipeline, not alongside it.

   **MANDATORY**: If no pipeline stack exists in the deployment inventory — if the pipeline is defined as a configuration file (e.g. GitHub Actions YAML, GitLab CI YAML) rather than as deployable IaC infrastructure — this is a Construction artifact failure. The pipeline MUST be an IaC-managed resource (DEPLOY-PIPE-001). **MANDATORY**: You MUST load `common/design-rework.md` and follow its steps exactly. You MUST NOT proceed. You MUST NOT fall back to deploying all stacks directly.

2. **Synthesize/Plan**: You MUST run the IaC synthesis or plan command for the pipeline stack only. If this fails, record the error in `aidlc-docs/operations/deployment-deploy.md`, classify as a Construction artifact failure, and **MANDATORY**: You MUST load `common/design-rework.md` and you MUST follow its steps exactly. You MUST NOT fix the code inline.

3. **Deploy the pipeline stack**: You MUST run the IaC deploy command targeting ONLY the pipeline stack. **MANDATORY**: You MUST run this command. **MANDATORY**: You MUST NOT deploy all stacks — only the pipeline stack. The pipeline will deploy everything else when triggered in Step 7.

4. **Wait for terminal state**: You MUST poll stack status until the pipeline stack has reached a terminal state. **MANDATORY**: You MUST NOT proceed until the pipeline stack is in a terminal state.

   **Terminal states** (no further changes will occur):
   - Success: `CREATE_COMPLETE`, `UPDATE_COMPLETE`, `IMPORT_COMPLETE`
   - Failed: `CREATE_FAILED`, `ROLLBACK_COMPLETE`, `ROLLBACK_FAILED`, `UPDATE_ROLLBACK_COMPLETE`, `UPDATE_ROLLBACK_FAILED`, `DELETE_FAILED`, `IMPORT_ROLLBACK_COMPLETE`, `IMPORT_ROLLBACK_FAILED`

   **Non-terminal states** (still in progress — keep polling):
   - `CREATE_IN_PROGRESS`, `ROLLBACK_IN_PROGRESS`, `DELETE_IN_PROGRESS`, `UPDATE_IN_PROGRESS`, `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS`, `UPDATE_ROLLBACK_IN_PROGRESS`, `UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS`, `IMPORT_IN_PROGRESS`, `IMPORT_ROLLBACK_IN_PROGRESS`

   Poll every 30 seconds until the stack is in a terminal state.

5. **Record results**: You MUST record the pipeline stack status in `aidlc-docs/operations/deployment-deploy.md`. Include the full error output if failed.

6. **Record pipeline outputs**: You MUST extract outputs for the successful pipeline stack, extract outputs (pipeline ARN, pipeline name). Record in `aidlc-docs/operations/deployment-outputs.md`.

**On pipeline stack failure**:
1. You MUST classify the failure as one of the following ONLY:
   - **GAP IF**: creating or changing a code artifact produced by Construction could fix the failure . **MANDATORY**: You MUST load `common/design-rework.md` and follow its steps exactly to loop back to Construction. You MUST NOT fix the artifact inline.
   - **Environment failure IF**: no change to any code artifact by loading `common/design-rework.md` and following its steps exactly to loop back to Construction could fix the failure (e.g. AWS account limits, credentials expired, service unavailable in region) . You MUST record as BLOCKED with command output proving the failure is outside the workflow's control.
2. You MUST classify as GAP if uncertain.

Validation check:
- **MANDATORY**: Every failure MUST be classified as one of the following ONLY: GAP OR Environment failure.
- **MANDATORY**: If any file in `workspace/` was modified during this step, reclassify as GAP and load `common/design-rework.md`.
- **MANDATORY**: You MUST NOT proceed to Step 7 until the pipeline stack is in a terminal success state AND `aidlc-docs/operations/deployment-deploy.md` records its status.

---

## Step 7: Trigger Pipeline

**The goal of this step is a pipeline that has reached the Human Approval gate — meaning Source, Build, Deploy-to-Pre-Prod, and Test stages have all completed successfully. MANDATORY: You MUST trigger the pipeline and poll until it reaches a terminal state.**

1. **Trigger the pipeline**: You MUST start the pipeline execution. The pipeline's Source stage pulls from the workspace repository (DEPLOY-PIPE-011).

2. **Poll pipeline status until terminal state**: You MUST poll the pipeline execution status repeatedly until it reaches a terminal state. **MANDATORY**: You MUST NOT proceed while the pipeline is InProgress. You MUST NOT declare this step complete while any stage is still executing.

   Poll every 60 seconds by querying the pipeline execution status. For each poll:
   - Record the current stage and its status
   - If the pipeline is still InProgress → wait 60 seconds and poll again
   - If the pipeline has Succeeded (reached Human Approval gate) → proceed to task 3
   - If the pipeline has Failed → proceed to the failure handling below

   **Terminal states** (stop polling — the model MUST determine the terminal states for the chosen pipeline tool, e.g.):
   - Succeeded / Completed — all stages before approval gate passed
   - Failed — a stage failed
   - Stopped / Cancelled — manually stopped or timed out

   **Non-terminal states** (keep polling — the model MUST determine the in-progress states for the chosen pipeline tool, e.g.):
   - InProgress / Running / Queued

3. **Record stage outcomes**: You MUST record each pipeline stage's start time, end time, and outcome in `aidlc-docs/operations/deployment-deploy.md`:
   - **Source**: Pipeline pulls from the workspace repository
   - **Deploy to Pre-Production**: Pipeline deploys all other infrastructure and application artifacts to the pre-prod environment
   - **Provisioning** (if applicable per DEPLOY-IAC-004): Pipeline executes provisioning scripts
   - **Test**: Pipeline verifies canaries passing (DEPLOY-TEST-001), executes security boundary tests (DEPLOY-TEST-002), verifies alarms clear

4. **Confirm pipeline reached Human Approval gate** (DEPLOY-PIPE-013): You MUST confirm the pipeline execution status is `Succeeded` and the pipeline is paused at the Human Approval action.

**On pipeline failure before the Human Approval gate**:
1. You MUST record the failed stage and failure output in `aidlc-docs/operations/deployment-deploy.md`
2. You MUST classify the failure as one of the following ONLY:
   - **GAP IF**: creating or changing a code artifact produced by Construction could fix the failure . **MANDATORY**: You MUST load `common/design-rework.md` and follow its steps exactly to loop back to Construction. You MUST NOT fix the artifact inline.
   - **Environment failure IF**: no change to any code artifact by loading `common/design-rework.md` and following its steps exactly to loop back to Construction could fix the failure (e.g. AWS account limits, credentials expired, service unavailable in region) . You MUST record as BLOCKED with command output proving the failure is outside the workflow's control.
3. You MUST classify as GAP if uncertain.
4. After rework completes, you MUST re-trigger the pipeline and re-monitor from task 2 (poll until terminal state).

Validation check:
- **MANDATORY**: Every failure MUST be classified as one of the following ONLY: GAP OR Environment failure.
- **MANDATORY**: If any file in `workspace/` was modified during this step, reclassify as GAP and load `common/design-rework.md`.
- **MANDATORY**: You MUST NOT proceed to Step 8 until the pipeline has reached a terminal state. If the pipeline execution status is InProgress, you MUST continue polling. You MUST NOT proceed, skip, or declare completion while the pipeline is still running.
- **MANDATORY**: The pipeline MUST have reached the Human Approval gate (Succeeded status). If it Failed, you MUST have classified the failure and triggered rework or BLOCKED before proceeding.

---

## Step 8: Verify Pipeline Test Gate

**MANDATORY**: Deployment is NOT complete until this gate passes. The pipeline reached the approval gate — but the model MUST verify the Test stage results are genuine.

1. **Tests exist**: You MUST verify the pipeline Test stage executed (not skipped, not empty). If no tests ran, this is a GAP (Construction failed to generate test artifacts). **MANDATORY**: load `common/design-rework.md` and follow its steps.

2. **Tests passed**: You MUST verify the pipeline Test stage reported all-pass:
   - Canary checks (DEPLOY-TEST-001): all canaries executing and healthy
   - Security boundary tests (DEPLOY-TEST-002): all tests passed (exit code 0)
   - Alarm state: no alarms firing

3. **Record gate outcome**: You MUST write pass/fail + evidence to `aidlc-docs/operations/deployment-deploy.md`.

**On any Test stage failure**:
1. You MUST classify the failure as one of the following ONLY:
   - **GAP IF**: creating or changing a code artifact produced by Construction could fix the failure (e.g. canary script broken, auth config wrong, test script error, application code causing alarms) . **MANDATORY**: You MUST load `common/design-rework.md` and follow its steps exactly to loop back to Construction. You MUST NOT fix the artifact inline.
   - **Environment failure IF**: no change to any code artifact by loading `common/design-rework.md` and following its steps exactly to loop back to Construction could fix the failure . You MUST record as BLOCKED with command output proving the failure is outside the workflow's control.
2. You MUST classify as GAP if uncertain.

Validation check:
- **MANDATORY**: Every failure MUST be classified as one of the following ONLY: GAP OR Environment failure.
- **MANDATORY**: If any file in `workspace/` was modified during this step, reclassify as GAP and load `common/design-rework.md`.
- **MANDATORY**: You MUST NOT proceed to Step 9 until pipeline Test stage results are verified as all-pass. If any test failed, you MUST have loaded `common/design-rework.md` before proceeding.

---

## Step 9: Verify Deployment Presence

IaC-managed resources are confirmed present by stack COMPLETE status in Step 6. This step verifies what the pipeline deployed to pre-production — the artifacts deployed in the pipeline's Deploy-to-Pre-Production stage.

For each Application Artifact and Asset/Data component in the deployment inventory, run a verification command and confirm it is present in the pre-production environment. Record command and output as evidence.

For each component type, use the appropriate query:
- **Stored objects** (S3 files, container images in registry, packages in artifact store) — query the storage to confirm the objects exist at the expected path/key with non-zero size
- **Applied changes** (database migrations, schema versions) — query the database or migration tool to confirm the current version matches the expected version
- **Written configuration** (Parameter Store parameters, Secrets Manager secrets) — confirm the parameter/secret exists with a recent modification date

Write the results to `aidlc-docs/operations/deployment-verification.md`:

```markdown
# Presence Verification Report

| Component | Type | Verification Command | Result | Status |
|-----------|------|---------------------|--------|--------|
| [name] | S3Object/ContainerImage/Config/Migration | [command] | [output summary] | PRESENT/MISSING |
```

If any component shows MISSING:
1. You MUST record the MISSING component and verification output in `aidlc-docs/operations/deployment-deploy.md`
2. You MUST classify the failure as one of the following ONLY:
   - **GAP IF**: creating or changing a code artifact produced by Construction could fix the failure . **MANDATORY**: You MUST load `common/design-rework.md` and follow its steps exactly to loop back to Construction. You MUST NOT fix the artifact inline.
   - **Environment failure IF**: no change to any code artifact by loading `common/design-rework.md` and following its steps exactly to loop back to Construction could fix the failure . You MUST record as BLOCKED with command output proving the failure is outside the workflow's control.
3. You MUST classify as GAP if uncertain.

Validation check:
- **MANDATORY**: Every failure MUST be classified as one of the following ONLY: GAP OR Environment failure.
- **MANDATORY**: If any file in `workspace/` was modified during this step, reclassify as GAP and load `common/design-rework.md`.
- **MANDATORY**: You MUST NOT proceed to Step 10 until `aidlc-docs/operations/deployment-verification.md` exists and every component has status PRESENT.

---

## Step 10: Document Human-Required Tests

Before stage completion, document tests that require human execution post-deployment. Write to `aidlc-docs/operations/customer-staged-tests.md`.

The following test types require human execution and MUST be documented with full instructions:

1. **Performance/load tests** — You MUST document: sustained load generation, baseline comparison, scalability verification. Include: recommended tool, target throughput, duration, success criteria.
2. **Chaos/resilience tests** — You MUST document: deliberate fault injection (AZ failure, dependency timeout, instance termination). Include: hypothesis to validate, failure scenarios, expected recovery behaviour, blast radius limits, success criteria.
3. **Penetration testing** — You MUST document: external security assessment. Include: scope boundaries, rules of engagement, compliance requirements.
4. **User acceptance testing** — You MUST document: human evaluation of UX, workflows, business logic correctness. Include: test scenarios, acceptance criteria, sign-off process.

Each documented test MUST include:
- What to test and why
- Prerequisites and environment requirements
- Step-by-step execution instructions (with deployment outputs substituted from `deployment-outputs.md` — no placeholders)
- Success criteria
- Recommended schedule (e.g. "within 2 weeks of go-live", "monthly")

If no human-required tests apply to this architecture, record "No customer-staged tests applicable" with rationale and proceed.

Validation check:
- **MANDATORY**: You MUST NOT proceed to Step 11 until `aidlc-docs/operations/customer-staged-tests.md` exists (even if empty with rationale).

---

## Step 11: Stage Completion

Record stage status as COMPLETE in `aidlc-docs/aidlc-state.md`.

**Deployment is COMPLETE when**:
- All infrastructure deployed, including pipeline (Step 6)
- Pipeline triggered, executed through Test stage, paused at Human Approval gate (Steps 7–8)
- Presence verified (Step 9)
- Human-required tests documented (Step 10)

**MANDATORY**: You MUST present standardized 2-option completion message:

```markdown
# 🚀 Deployment Complete

[Summary of deployment inventory — counts by type]
[Pipeline status: waiting at Human Approval gate]
[Pipeline Test stage: all tests passed]
[Presence verification: all components PRESENT]
[Key deployment outputs: endpoints, URLs]
[Customer-staged tests: documented in customer-staged-tests.md]
```

> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** - Ask for modifications to the deployment based on your review
> ✅ **Continue to Next Stage** - Approve deployment and proceed to **Post-Deployment Testing**

---

**Wait for Explicit Approval**: User must confirm deployment is successful before proceeding to Post-Deployment Testing.

**MANDATORY**: You MUST log user's response in audit.md with complete raw input.
