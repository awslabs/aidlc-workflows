# Operations Extensions

This document explains what each operational extension does, what it generates during Construction, and how it's validated during Operations. Each extension is an independent domain that can be opted in or out during Inception.

---

## How Extensions Work

Each extension follows the same lifecycle:

1. **Inception** — you're asked an opt-in question (A/B/C/D). Your answer determines which rule files load.
2. **Construction** — the loaded rules drive what gets generated. Each rule creates specific implementation tasks in Code Generation.
3. **Operations — Rules Validation** — each applicable rule is independently verified against the generated code. Gaps trigger rework.
4. **Operations — Deployment / Post-Deployment Testing** — the generated artifacts are deployed and tested.

Extensions are additive — they layer requirements on top of the base AI-DLC workflow. Disabling an extension (answer D) means no rules from that domain are loaded or enforced.

---

## Deployment Extension

**Opt-in question**: "Should deployment extension rules be enforced for this project?"

**What it enforces during Construction**:

- A CI/CD pipeline defined as deployable IaC infrastructure — not a workflow file on an external platform, but an AWS resource that can be deployed, triggered, and monitored from the target account
- Pipeline stages in a specific order: Source → Deploy Pre-Production → Test → Human Approval → Deploy Production → Alarm Bake
- Security boundary test scripts — executable tests that verify authentication rejection (401) and security headers, generated as code that the pipeline runs
- Canary/synthetic test coverage — every customer journey has a canary that runs continuously after deployment
- IaC covering all deployable resources with cross-stack dependency management
- Runtime dependencies expressed in IaC (not provisioning scripts) wherever technically possible
- Progressive deployment with alarm-triggered automatic rollback

**What happens during Deployment stage**:

- Only the pipeline stack is deployed directly (via IaC deploy command)
- The pipeline is triggered — it deploys all other infrastructure and application artifacts
- Pipeline execution is polled until it reaches a terminal state
- If the pipeline fails, the failure is classified and sent to rework
- Pipeline pauses at a human approval gate before production

**What happens during Post-Deployment Testing**:

- Pipeline test results are reviewed for pass/fail AND coverage adequacy
- Operational readiness checks run (alarm configuration, canary status, dashboard correctness, health endpoint depth)
- Functional correctness tests execute against the live environment
- All results are presented to a human who approves or rejects production deployment

**Key principle**: The pipeline is the deployment mechanism. Everything flows through it. Direct deployment bypasses the safety controls the extension exists to enforce.

---

## Observability Extension

**Opt-in question**: "Should observability extension rules be enforced for this project?"

**What it enforces during Construction**:

- Structured logging with Embedded Metric Format (EMF) and correlation IDs
- Per-resource CloudWatch alarms with correct missing-data treatment
- Composite alarms per fault isolation boundary (AZ-level, region-level, customer-impact)
- CloudWatch dashboards with specific layout requirements (input/processing/output per API)
- Synthetic canaries for every customer journey
- Distributed tracing with AZ-ID annotations
- Gray failure detection mechanisms
- Differential observability (client-side vs server-side comparison)

**What happens during Rules Validation**:

- Every alarm, dashboard, canary, and metric is individually verified against the code
- Coverage is checked per rule × resource combination (not just "alarms exist")
- Missing alarms, incorrect thresholds, or shallow health checks are flagged as gaps

---

## Recovery Extension

**Opt-in question**: "Should recovery extension rules be enforced for this project?"

**What it enforces during Construction**:

- AZ-level fault isolation and evacuation mechanisms
- Region-level failover controls (ARC Region Switch or equivalent)
- Safety interlocks preventing recovery actions during multi-scope failures
- FIS experiment templates for testing AZ failure and gray failure scenarios
- Service quota parity documentation across regions
- DR testing plans with game day schedules

**What happens during Rules Validation**:

- Recovery controls are verified in IaC (routing controls, safety rules, readiness checks)
- FIS experiment templates are verified to exist
- Safety interlocks and pre-flight checks in runbooks are verified

---

## Runbooks Extension

**Opt-in question**: "Should runbook extension rules be enforced for this project?"

**What it enforces during Construction**:

- SSM Automation documents for automated recovery procedures
- Required sections in every runbook (prerequisites, constraints, procedure, verification, rollback, escalation)
- EventBridge rules binding alarms to SSM Automation execution (automated triggering)
- Post-execution verification steps that confirm recovery succeeded
- Manual trigger documentation for each automation

**What happens during Rules Validation**:

- SSM documents are verified to contain all required sections
- Alarm-to-automation bindings are verified in IaC
- Post-execution verification steps are checked

---

## Testing Extension (Property-Based Testing)

**Opt-in question**: "Should property-based testing rules be enforced?"

**What it enforces during Construction**:

- Property identification during design (round-trip, invariant, idempotence, etc.)
- Hypothesis-based tests for Python (stateful and stateless)
- fast-check tests for TypeScript/frontend
- Shrinking and reproduction of failures

This is an upstream extension — not part of the operations extensions. It's included here because it generates test code that appears alongside the operations artifacts.

---

## Security Extension

**Opt-in question**: "Should security baseline rules be enforced?"

**What it enforces during Construction**:

- HTTPS everywhere, security headers (HSTS, CSP, X-Frame-Options)
- IAM least-privilege, deny-by-default network policies
- Input validation, brute-force protection
- Access logging on all entry points
- Dependency vulnerability scanning in CI/CD
- Secrets in Secrets Manager (not hardcoded)

This is an upstream extension. Security rules are always enforced when opted in — they cannot be classified as "nice-to-have" during rework approval.
