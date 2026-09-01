# Operations Phase

This document explains what happens during the Operations phase — the three stages that run after Construction completes. It covers what you'll see, what decisions you'll be asked to make, and what artifacts are produced.

---

## When Does Operations Run?

Operations runs after Build and Test completes successfully. If the execution plan marked Operations as EXECUTE (which it will for any project with active extension domains), the workflow continues into Rules Validation automatically.

---

## Stage 1: Rules Validation

### What Happens

The AI reads all the code and infrastructure that Construction generated, then checks it against every applicable rule from your opted-in domains. It does this independently — it re-evaluates which rules apply rather than trusting what Construction decided.

### What You'll See

1. **Applicability matrix** — a table showing every rule with APPLICABLE or NOT APPLICABLE status. You'll be asked to approve this before validation proceeds.

2. **Per-domain compliance reports** — one for each active domain (observability, recovery, runbooks, deployment). Each report lists every applicable rule with COMPLIANT or GAP status and evidence.

3. **Gap list** — if any rules weren't satisfied, you'll see a consolidated list of gaps across all domains.

### Decisions You'll Make

- **Approve the applicability matrix** — confirm the AI correctly identified which rules apply to your architecture
- **Approve or reject rework items** — for each gap found, you decide whether to fix it (approve) or accept it as a known exception (reject)

### What Triggers Rework

If you approve any gaps for fixing, the rework loop activates (see below).

---

## Rework Loop

### What Happens

Gaps are classified as either design gaps (the architecture needs changing) or implementation gaps (the code needs fixing). A rework plan is generated and presented for your approval. Once approved, the AI re-executes only the necessary Construction stages to address the gaps.

### What You'll See

1. **Gap classification** — each gap labelled as design or implementation
2. **Rework plan** — a checklist of what will be re-executed, with the specific stages and scope
3. **Re-execution** — the AI runs through the relevant Construction stages again, producing updated code and artifacts
4. **Re-validation** — Rules Validation runs again to confirm the gaps are resolved

### Decisions You'll Make

- **Approve the rework plan** — confirm you're happy with the proposed fix approach before re-execution begins

### How Many Times Can It Loop?

The rework loop has a configurable iteration limit. If gaps remain after the limit is reached, they're documented as known exceptions in the final operations summary.

---

## Stage 2: Deployment

### What Happens

The AI deploys the pipeline stack, triggers the pipeline, and monitors it as it deploys all infrastructure and application artifacts to pre-production. The pipeline — not the AI directly — handles the actual deployment.

### What You'll See

1. **Deployment inventory** — a categorised list of all deployable components:
   - Infrastructure (IaC stacks)
   - Application artifacts (Lambda functions, containers, frontend bundles)
   - Assets/data (migrations, seed data, configuration, secrets)

2. **Coverage verification** — confirmation that every component has deployment automation, the pipeline exists as deployable IaC, and the pipeline tool is reachable

3. **Pipeline deployment** — the pipeline stack is deployed (the only stack deployed directly)

4. **Pipeline execution** — the pipeline runs through Source → Deploy Pre-Production → Test stages. You'll see status updates as each stage completes.

5. **Pipeline test gate** — confirmation that the pipeline's automated tests (canary checks, security boundary tests, alarm state) all passed

6. **Human-required tests** — documented instructions for tests that need human execution (performance, chaos, penetration, UAT)

### Prerequisites

- Cloud credentials must be available
- The pipeline tool must be reachable from the current environment

If credentials aren't available, the workflow completes after Rules Validation and reports what's missing. If the pipeline tool isn't reachable (e.g. wrong tool chosen), a rework loop is triggered to fix the design.

### Decisions You'll Make

- **Approve deployment completion** — confirm you're satisfied the pipeline executed correctly before proceeding to Post-Deployment Testing

### When Rework Triggers

Rework can trigger during Deployment if:
- The pipeline tool isn't reachable (wrong tool chosen during Construction)
- The pipeline stack fails to deploy (IaC error)
- The pipeline fails at any stage before the Human Approval gate (code bug, test failure, missing resource)

When this happens, you'll see the same gap-and-approve flow as Rules Validation — the AI classifies the failure, presents it as a requirement, you approve, and Construction re-executes to fix it. The pipeline then re-runs with the fix. This may happen multiple times until the pipeline succeeds through all pre-production stages.

---

## Stage 3: Post-Deployment Testing

### What Happens

The AI reviews the pipeline's test results, assesses whether test coverage was adequate, runs additional verification that requires reasoning (operational readiness, functional correctness), and presents everything to you for a production deployment decision.

### What You'll See

1. **Pipeline state verification** — confirmation the pipeline is at the Human Approval gate, waiting for your decision

2. **Pipeline test adequacy assessment** — the AI reviews what the pipeline tested and reasons about whether coverage was sufficient for your architecture. If gaps in coverage are found, rework is triggered to generate more tests.

3. **Functional correctness results** — tests composed and executed by the AI against the live pre-production environment (error paths, input validation, security boundaries)

4. **Operational readiness results** — verification that alarms, dashboards, canaries, and health endpoints are correctly configured

5. **Production approval request** — a summary of all results with a clear recommendation. You decide whether the pipeline proceeds to production.

### Prerequisites

- Deployment must have completed successfully (pipeline at Human Approval gate)

### Decisions You'll Make

- **Approve for production** — the pipeline proceeds past the Human Approval gate and deploys to production with alarm-based bake monitoring
- **Reject** — the pipeline stops. If issues were found, rework is triggered to fix them before trying again

### When Rework Triggers

Rework can trigger during Post-Deployment Testing if:
- Pipeline tests passed but coverage was inadequate (e.g. 8 endpoints but only 3 tested — the AI triggers rework to generate the missing tests)
- Functional correctness tests fail (code bug discovered against the live environment)
- Operational readiness checks fail (missing alarms, broken canaries, shallow health endpoints)

When this happens, you'll see the same gap-and-approve flow — the AI presents what's wrong, you approve the fix, Construction re-executes, and the pipeline re-runs. This repeats until Post-Deployment Testing is satisfied and can present a clean result for your production approval.

---

## Artifacts Produced

Each stage produces its own set of artifacts. The **summary document** for each stage is the one to read first. It gives you the overall result and links to the detail.

### Operations Phase

| Artifact | Location | What It Tells You |
|----------|----------|-------------------|
| **Operations summary** (start here) | `aidlc-docs/operations/operations-summary.md` | Provides a summary of results for all stages including Rules Validation outcome, Deployment status, Post-Deployment Testing result, and overall production readiness verdict |

### Rules Validation

| Artifact | Location | What It Tells You |
|----------|----------|-------------------|
| **Compliance report** (start here) | `aidlc-docs/operations/rules-validation-report.md` | Overall result across all domains showing how many rules passed, how many gaps were found, and what triggered rework |
| Completion summary | `aidlc-docs/operations/rules-validation-completion.md` | Final pass and gap counts per domain after all rework iterations complete |
| Validation plan | `aidlc-docs/operations/validation-plan.md` | Which rule files were loaded and in what order |
| Domain reports | `aidlc-docs/operations/{domain}/` | Per-rule compliance status with evidence citations, one file per domain |
| Gap questions | `aidlc-docs/operations/rules-validation-gaps.md` | The gaps presented for your approval |

### Rework (if triggered)

| Artifact | Location | What It Tells You |
|----------|----------|-------------------|
| **Rework plan** (start here) | `aidlc-docs/operations/run-{N}/rework-plan.md` | What was fixed during each iteration including the gap, the fix, and which Construction stages re-ran |

### Deployment

| Artifact | Location | What It Tells You |
|----------|----------|-------------------|
| **Deployment outputs** (start here) | `aidlc-docs/operations/deployment-outputs.md` | Endpoints, ARNs, and resource identifiers showing what is live and where to find it |
| Deployment inventory | `aidlc-docs/operations/deployment-inventory.md` | Categorised list of all deployable components (infrastructure, application, assets) |
| Deployment log | `aidlc-docs/operations/deployment-deploy.md` | Commands run, outputs, and pipeline stage outcomes providing the full execution trace |
| Deployment verification | `aidlc-docs/operations/deployment-verification.md` | Presence check confirming every component exists in the environment |

### Post-Deployment Testing

| Artifact | Location | What It Tells You |
|----------|----------|-------------------|
| **Test report** (start here) | `aidlc-docs/operations/post-deployment-test-report.md` | Pipeline results, functional correctness, and operational readiness providing the evidence for a production deployment decision |
| Customer-staged tests | `aidlc-docs/operations/customer-staged-tests.md` | Tests requiring human execution with instructions (performance, chaos, penetration, UAT) |

---

## Applying Operations Retrospectively

If you install these operations rules onto a project that already completed AI-DLC without them, the workflow detects this automatically during Workspace Detection. The trigger is: existing code in the workspace, Construction stages all completed, and Operations still showing as PLACEHOLDER.

### What Happens

1. The AI presents the retrofit question — do you want to apply the Operations phase to this existing project?
2. If you say yes, it archives the current state (aidlc-state.md and audit.md) for traceability.
3. It resets the Extension Configuration and Construction stage progress, reclassifies the project as brownfield, and re-enters at Requirements Analysis.
4. Requirements Analysis runs the standard opt-in process for all available extensions — the same questions you'd have been asked on a fresh project.
5. Construction re-runs with extensions loaded. It sees the existing code in the workspace and extends it rather than rewriting from scratch.
6. Operations validates the result as normal.

### What You'll See

- A question asking whether to retrofit
- The standard opt-in questions for each extension domain (A/B/C/D applicability)
- Construction stages re-executing (NFR Requirements through Build and Test)
- Operations stages running against the result

### Why Re-run Inception and Construction?

Extensions need to be present during Inception (opt-in questions, requirements) and Construction (NFR Requirements, NFR Design, Infrastructure Design, Code Generation). Skipping to Operations (validate-only) would find gaps but produce massive rework lists. Re-running from Requirements Analysis with extensions loaded produces coherent output in one pass rather than iterative patching.
