# Post-Deployment Testing — Plan and Execute

> **OVERRIDE**: This file is exempt from the Adaptive Workflow Principle and adaptive depth. Every step MUST be executed exactly as written. The model MUST NOT skip, defer, or partially complete any step. The model MUST verify pipeline test results AND assess their adequacy — passing is not sufficient, coverage must be verified. Every DEPLOY-TEST-003 and DEPLOY-TEST-004 check MUST be executed via `run_command` with output recorded as evidence.

**Purpose**: Build a test plan from the testing framework phases, execute automatable tests against the deployed environment, and document customer-staged tests for later execution.

**Prerequisite**: Deployment stage must be COMPLETE. A live deployed environment must exist with outputs recorded in `aidlc-docs/operations/deployment-outputs.md`.

**State Tracking**: Every outcome (BLOCKED, COMPLETE) MUST be recorded in `aidlc-docs/aidlc-state.md` with the stage name, status, and reason.

**What COMPLETE means**: Pipeline state verified, pipeline test adequacy assessed, functional correctness tests (DEPLOY-TEST-003) executed with evidence, operational readiness tests (DEPLOY-TEST-004) executed with evidence, and results presented to the human who has approved or rejected production deployment. No test type has been silently omitted.

**Test Execution Log**: All test commands, outputs, and failure classifications MUST be recorded in `aidlc-docs/operations/post-deployment-test-report.md`. This file is the single source of truth for what was tested, what passed, and what failed.

**Audit Logging**: Every rework invocation and every BLOCKED decision MUST be logged in `aidlc-docs/audit.md` with: the step number, the failed test(s), the classification, and the action taken (rework invoked / BLOCKED recorded).

---

## Testing Framework

Post-Deployment Testing operates in two modes:

1. **Pipeline test review** (Steps 2–3): Verify the pipeline Test stage executed correctly and test coverage is adequate. Rework if tests failed or coverage is insufficient.
2. **Model-driven testing** (Steps 4–5): Execute tests that require model reasoning — functional correctness and operational readiness.

| Test Type | Rule | Executed By | This Stage's Role |
|-----------|------|-------------|-------------------|
| Canary/Synthetic | DEPLOY-TEST-001 | Pipeline Test stage | Review results, assess coverage adequacy |
| Security Boundary | DEPLOY-TEST-002 | Pipeline Test stage | Review results, assess coverage adequacy |
| Functional Correctness | DEPLOY-TEST-003 | This stage (model) | Compose and execute tests, record evidence |
| Operational Readiness | DEPLOY-TEST-004 | This stage (model) | Query AWS APIs, verify configuration correctness |
| Performance/Load | Customer-staged | Human (post-DLC) | Documented in Deployment Step 10 |
| Resilience/Chaos | Customer-staged | Human (post-DLC) | Documented in Deployment Step 10 |

**Classification rule**: If a test was executed by the pipeline Test stage, this stage reviews results and assesses adequacy — it does NOT re-execute. If a test requires model reasoning about correctness, this stage executes it. If a test requires sustained load, fault injection, or human judgement during execution, it is customer-staged and already documented.

---

## Step 1: Deployment Completion Check

Read the Extension Configuration from `aidlc-docs/aidlc-state.md`. Check whether the `extensions/deployment` extension has a corresponding `extensions/deployment/` directory with loaded rule files.

**IF `operations/deployment` rules are loaded** (extension active, answer other than D/No): Check that the Deployment stage status is COMPLETE in `aidlc-state.md`. If COMPLETE, proceed to Step 2. If BLOCKED or SKIPPED, record this stage as SKIPPED in `aidlc-state.md` with reason "Deployment stage did not complete" and stop.

**IF `operations/deployment` rules are NOT loaded**: Read `aidlc-docs/audit.md` and find the "Deployment — Opt-In Check" entry. Check the customer's answer.

- **If answer was A (Yes)** AND Deployment stage status is COMPLETE: Proceed to Step 2.
- **If answer was B (No)** OR Deployment stage is SKIPPED/BLOCKED: Record this stage as SKIPPED in `aidlc-state.md` with reason "Customer declined deployment testing" or "Deployment stage did not complete". Stop.

---

## Step 2: Verify Pipeline State

Query the pipeline status. Confirm:

1. Pipeline exists and is not in a failed or error state
2. Pipeline executed successfully through Source, Deploy-to-Pre-Production, and Test stages
3. Pipeline is waiting at the Human Approval gate (DEPLOY-PIPE-013)

**If pipeline is NOT at the Human Approval gate**: Investigate. If a stage failed silently or the pipeline is stuck in an unexpected state → classify and rework (Construction artifact failure) or BLOCKED (environment failure).

Record pipeline state in `aidlc-docs/operations/post-deployment-test-report.md`.

Validation check:
- **MANDATORY**: You MUST NOT proceed to Step 3 until the pipeline is confirmed waiting at the Human Approval gate.

---

## Step 3: Assess Pipeline Test Adequacy

**MANDATORY**: This step does NOT just check pass/fail. The model MUST reason about whether the tests were SUFFICIENT for this architecture.

1. **Read pipeline Test stage output** — pass/fail status for each test executed. Record in `post-deployment-test-report.md`.

2. **If any test failed** → classify immediately:
   - Construction artifact failure (application code, canary script, security test script, or pipeline config) → **MANDATORY**: load `common/design-rework.md` and follow its steps. After rework, pipeline re-runs. Re-assess from Step 2.
   - Environment failure (transient, timeout) → retry pipeline. If persists → BLOCKED.

3. **Assess canary coverage adequacy** (DEPLOY-TEST-001):
   - Read the architecture — how many externally-facing endpoints exist?
   - Read the canary test results — how many endpoints were tested?
   - Does canary coverage include every critical user journey identified in requirements?
   - If the app has N endpoints but canaries only test fewer than N → coverage gap → **MANDATORY**: load `common/design-rework.md` (Construction must generate missing canaries)

4. **Assess security boundary test coverage** (DEPLOY-TEST-002):
   - Read the architecture — how many protected endpoints exist?
   - Read the security test results — how many 401/403 assertions were made?
   - Does every protected endpoint have a corresponding rejection test?
   - Are all required security headers verified?
   - If coverage is incomplete → gap → **MANDATORY**: load `common/design-rework.md` (Construction must generate missing security tests)

5. **Record assessment**: Write to `post-deployment-test-report.md`:
   - "Pipeline tests: PASS — coverage verified adequate" OR
   - "Pipeline tests: PASS — coverage INADEQUATE for [reason], rework triggered"

Validation check:
- **MANDATORY**: You MUST NOT proceed to Step 4 until pipeline tests are PASS AND coverage is assessed as adequate. If rework was triggered, wait for pipeline re-run and re-assess.

---

## Step 4: Execute Functional Correctness Tests (DEPLOY-TEST-003)

**MANDATORY**: These tests require model reasoning. The model composes and executes them using deployment outputs and rule requirements.

1. **Read deployment outputs** from `aidlc-docs/operations/deployment-outputs.md` — endpoints, ARNs, URLs.

2. **For each API endpoint**, compose and execute functional correctness tests:
   - Error path validation: send malformed payloads, verify appropriate error codes and messages
   - Input validation: oversized inputs, missing required fields, invalid formats
   - Data round-trip: write via API, read back, confirm correctness (where canaries do not already exercise this path)
   - Edge cases specific to the business domain

3. **Execute each test** via `run_command`. Record full command and output in `post-deployment-test-report.md`.

4. **Determine pass/fail** for each test. Do NOT stop on failure — execute all tests, collect all results.

5. **On any failure** → classify:
   - Construction artifact failure (code bug, wrong error message, missing validation, incorrect response format) → **MANDATORY**: load `common/design-rework.md` and follow its steps.
   - Environment failure (transient, timeout, eventual consistency delay) → retry once. If persists → BLOCKED.

Validation check:
- **MANDATORY**: You MUST NOT proceed to Step 5 until all functional correctness tests are executed and results recorded.

---

## Step 5: Execute Operational Readiness Tests (DEPLOY-TEST-004)

**MANDATORY**: These tests verify operational infrastructure is correctly configured. The model queries CloudWatch and AWS APIs.

1. **Alarm coverage**: For every resource in the deployment inventory, verify:
   - Required alarms exist (per observability rules)
   - Alarm thresholds are correct for this workload
   - Alarm actions are configured (SNS notifications)
   - Record which alarms exist and their configuration

2. **Dashboard existence**: For each required dashboard:
   - Verify it exists
   - Verify it contains expected widgets with correct metric references
   - Record dashboard names and widget counts

3. **Canary configuration**: For each deployed canary:
   - Verify it is running on schedule
   - Verify it is reporting to the correct location
   - Verify its last run was successful
   - Record canary names, schedules, and last run status

4. **Health endpoint depth**: For each health endpoint:
   - Call the health endpoint
   - Verify the response includes dependency status (not just HTTP 200)
   - Record the health response body

5. **Recovery readiness** (if recovery extension active):
   - Query ARC readiness checks
   - Verify all checks pass
   - Record readiness status

**Execute each check** via `run_command`. Record full command and output in `post-deployment-test-report.md`.

**On any failure** → classify:
- Construction artifact failure (missing alarm, wrong threshold, missing dashboard widget, canary not deployed, health endpoint shallow) → **MANDATORY**: load `common/design-rework.md` and follow its steps.
- Environment failure (API timeout, permission denied on CloudWatch query) → BLOCKED.

Validation check:
- **MANDATORY**: You MUST NOT proceed to Step 6 until all operational readiness checks are executed and results recorded.

---

## Step 6: Present Results for Human Approval

**MANDATORY**: The model MUST NOT approve the pipeline gate automatically. The human decides.

Present to the human a clear summary:

```markdown
# Post-Deployment Testing Results

## Pipeline Test Results (DEPLOY-TEST-001 + 002)
- Canary tests: [PASS/FAIL] — [N] canaries covering [N] endpoints
- Security boundary tests: [PASS/FAIL] — [N] assertions across [N] endpoints
- Alarm state: [OK / N alarms firing]
- Coverage assessment: [ADEQUATE / INADEQUATE — reason]

## Functional Correctness (DEPLOY-TEST-003)
- Tests executed: [N]
- Passed: [N]
- Failed: [N] — [brief failure summary if any]

## Operational Readiness (DEPLOY-TEST-004)
- Alarm coverage: [PASS/FAIL — N alarms verified]
- Dashboards: [PASS/FAIL — N dashboards verified]
- Canaries: [PASS/FAIL — N canaries running]
- Health endpoints: [PASS/FAIL — depth verified]
- Recovery: [PASS/FAIL/N/A]

## Customer-Staged Tests (Documented)
- [List from aidlc-docs/operations/customer-staged-tests.md with recommended schedule]

## Recommendation
[APPROVE for production / DO NOT APPROVE — with reasons]
```

> **You may:**
>
> ✅ **Approve** — Pipeline proceeds to production deployment
> ❌ **Reject** — Pipeline stops. Describe concerns for rework.

**Human approves** → model approves the pipeline Human Approval gate → pipeline proceeds to production deployment → alarm bake validates production.

**Human rejects** → model rejects the pipeline gate → pipeline stops → model triggers rework if appropriate based on rejection reason.

**MANDATORY**: You MUST log the human's response in `aidlc-docs/audit.md` with complete raw input.

**MANDATORY**: You MUST NOT proceed to Step 7 without the human's explicit approval or rejection decision.

---

## Step 7: Generate Test Report

Finalize `aidlc-docs/operations/post-deployment-test-report.md` — individual test results were recorded during Steps 3–5. Now add the summary section:

```markdown
# Post-Deployment Test Report

## Summary
- **Pipeline test results**: [PASS/FAIL — count of tests]
- **Pipeline test adequacy**: [ADEQUATE/INADEQUATE]
- **Functional correctness tests**: [count executed, count passed, count failed]
- **Operational readiness checks**: [count executed, count passed, count failed]
- **Human approval decision**: [APPROVED/REJECTED/PENDING]

## Pipeline Test Results (DEPLOY-TEST-001 + 002)

| Test Type | Tests | Passed | Failed | Coverage Assessment |
|-----------|-------|--------|--------|---------------------|
| Canary (DEPLOY-TEST-001) | [count] | [count] | [count] | [adequate/gap description] |
| Security Boundary (DEPLOY-TEST-002) | [count] | [count] | [count] | [adequate/gap description] |
| Alarm State | [count] | [count] | [count] | — |

## Functional Correctness Results (DEPLOY-TEST-003)

| Test | Command | Result | Evidence |
|------|---------|--------|----------|
| [test description] | [command] | PASS/FAIL | [output summary] |

## Operational Readiness Results (DEPLOY-TEST-004)

| Check | Command | Result | Evidence |
|-------|---------|--------|----------|
| [check description] | [command] | PASS/FAIL | [output summary] |

## Customer-Staged Tests (Documented in customer-staged-tests.md)
| Test Type | Recommended Schedule |
|-----------|---------------------|
| [type] | [when to run] |

## Rework Invocations
| Step | Failure | Classification | Outcome |
|------|---------|---------------|---------|
| [step] | [failure] | [Construction/Environment] | [rework outcome] |
```

---

## Step 8: Stage Completion

Record stage status as COMPLETE in `aidlc-docs/aidlc-state.md`.

Present the test report to the user showing:
- How many tests were executed with evidence
- How many passed/failed
- What customer-staged tests remain for scheduling

**Wait for Explicit Approval**: User must confirm test results before the Operations phase completes.

**MANDATORY**: You MUST log the user's approval response in `aidlc-docs/audit.md` with complete raw input.
