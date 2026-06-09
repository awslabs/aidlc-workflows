# Operation Phase -- Stage Reference (4.1-4.7)

## Phase Overview

The Operation phase is the fifth of five phases in the AI-DLC lifecycle. It
takes the built, tested software from Construction and moves it through
deployment, monitoring, incident preparedness, performance validation, and
continuous optimization. It covers seven stages (4.1 through 4.7) that span
pipeline configuration, environment provisioning, deployment execution,
observability, incident response, performance validation, and feedback
collection.

All seven Operation stages are **CONDITIONAL** -- they execute based on the
scope and execution plan. For example, mvp, poc, bugfix, and refactor scopes skip Operation
entirely. The infra and security-patch scopes run a subset (deployment and
environment stages).

All stages run **inline** (no subagents in the Operation phase). All stages
follow `stage-protocol.md` for approval gates, question format, completion
messages, and state tracking.

---

## Stage Summary Table

| Stage | Name                     | Execution   | Condition                                                              | Lead Agent          | Support Agents      | Mode                             |
|-------|--------------------------|-------------|------------------------------------------------------------------------|---------------------|---------------------|----------------------------------|
| 4.1   | Deployment Pipeline      | CONDITIONAL | Execute when CD pipeline needs creation or significant modification    | aidlc-pipeline-deploy-agent| (none)             | inline                           |
| 4.2   | Environment Provisioning | CONDITIONAL | Execute when AWS environments need provisioning or validation          | aidlc-aws-platform-agent  | aidlc-devsecops-agent, aidlc-compliance-agent     | inline                           |
| 4.3   | Deployment Execution     | CONDITIONAL | Execute after deployment pipeline and environment are ready            | aidlc-pipeline-deploy-agent| aidlc-developer-agent    | inline                           |
| 4.4   | Observability Setup      | CONDITIONAL | Execute when monitoring, dashboards, alarms, or tracing need config    | aidlc-operations-agent    | (none)              | inline                           |
| 4.5   | Incident Response        | CONDITIONAL | Execute when operational runbooks and incident response procedures needed | aidlc-operations-agent | (none)              | inline                           |
| 4.6   | Performance Validation   | CONDITIONAL | Execute when NFR performance targets need validation under load        | aidlc-quality-agent       | (none)              | inline                           |
| 4.7   | Feedback & Optimization  | CONDITIONAL | Execute when ongoing operational monitoring and optimization needed    | aidlc-operations-agent    | aidlc-aws-platform-agent  | inline                           |

### Multi-Agent Stages

Three Operation stages involve multiple agents:

- **4.2 Environment Provisioning**: aidlc-aws-platform-agent (lead) + aidlc-devsecops-agent (security posture validation) + aidlc-compliance-agent (data residency, regulatory controls)
- **4.3 Deployment Execution**: aidlc-pipeline-deploy-agent (lead) + aidlc-developer-agent (database migrations)
- **4.7 Feedback & Optimization**: aidlc-operations-agent (lead) + aidlc-aws-platform-agent (cost optimization, drift detection)

In all cases, the conductor invokes the lead agent first, then invokes
support agents with the lead's output as context. The conductor performs
every delegation; agents never invoke each other.

---

## Stage 4.1: Deployment Pipeline Configuration

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.1                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL (skip if deployment pipeline already exists and is adequate)                           |
| Lead Agent        | aidlc-pipeline-deploy-agent                                                                             |
| support_agents    | (none)                                                                                            |
| Inputs            | CI pipeline config from Stage 3.7, infrastructure design from Stage 3.4                          |

### Purpose

Configure the CD pipeline, deployment strategy, rollback procedures, and environment promotion gates.

### Outputs

| Artifact                          | Description                                                      |
|-----------------------------------|------------------------------------------------------------------|
| cd-config.md                      | CD pipeline configuration                                        |
| deployment-strategy.md            | Deployment strategy (blue/green, canary, rolling), promotion gates|
| rollback-runbook.md               | Rollback procedures and runbook                                  |
| deployment-pipeline-questions.md  | Clarifying questions with answers                                |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

---

## Stage 4.2: Environment Provisioning

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.2                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL (skip if environments already provisioned)                                            |
| Lead Agent        | aidlc-aws-platform-agent                                                                                |
| support_agents    | aidlc-devsecops-agent (security posture validation), aidlc-compliance-agent (data residency, regulatory controls) |
| Inputs            | Infrastructure design from Stage 3.4, CD pipeline config from Stage 4.1                          |

### Purpose

Provision and validate target AWS environments using Infrastructure as Code from Construction. The aidlc-devsecops-agent validates security posture and the aidlc-compliance-agent checks data residency and regulatory controls.

### Outputs

| Artifact                              | Description                                                |
|---------------------------------------|------------------------------------------------------------|
| environment-inventory.md              | Provisioned environment inventory                          |
| validation-report.md                  | Infrastructure validation report, health checks            |
| environment-provisioning-questions.md | Clarifying questions with answers                          |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

---

## Stage 4.3: Deployment Execution

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.3                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL (execute after deployment pipeline and environment are ready; skip if already deployed) |
| Lead Agent        | aidlc-pipeline-deploy-agent                                                                             |
| support_agents    | aidlc-developer-agent (database migrations)                                                             |
| Inputs            | CD pipeline config from Stage 4.1, provisioned environments from Stage 4.2                       |

### Purpose

Execute the actual deployment: push artifacts through the pipeline, run smoke tests, validate health checks, and execute database migrations.

### Outputs

| Artifact                          | Description                                                  |
|-----------------------------------|--------------------------------------------------------------|
| deployment-log.md                 | Deployment execution log                                     |
| smoke-test-results.md             | Smoke test results after deployment                          |
| health-check-report.md            | Health check validation report                               |
| deployment-execution-questions.md | Pre-deployment check questions with answers                  |

### Approval Gate

Strictly 2-option: Approve / Request Changes.

---

## Stage 4.4: Observability Setup

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.4                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL (skip if observability already configured)                                            |
| Lead Agent        | aidlc-operations-agent                                                                                  |
| Inputs            | NFR design from Stage 3.3, infrastructure design from Stage 3.4, deployed application             |

### Purpose

Configure monitoring, dashboards, alarms, SLO/SLI tracking, log queries, distributed tracing, and anomaly detection.

### Outputs

| Artifact                          | Description                                                    |
|-----------------------------------|----------------------------------------------------------------|
| dashboards.md                     | CloudWatch dashboard configurations                            |
| alarms.md                         | Alarm definitions with severity, SNS routing, escalation       |
| slo-config.md                     | SLO/SLI tracking configuration                                |
| log-queries.md                    | CloudWatch Logs Insights saved queries                         |
| tracing-config.md                 | X-Ray tracing configuration                                   |
| anomaly-config.md                 | Anomaly detection configuration                                |
| observability-setup-questions.md  | Clarifying questions with answers                              |

### Notes

- Produces the most artifacts of any Operation stage (6 content files + questions).
- AWS-specific (CloudWatch, X-Ray, SNS) but patterns are transferable.

---

## Stage 4.5: Incident Response & Runbook Generation

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.5                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL (skip for POCs or non-production deployments)                                         |
| Lead Agent        | aidlc-operations-agent                                                                                  |
| Inputs            | Observability setup from Stage 4.4, NFR design from Stage 3.3, infrastructure design from Stage 3.4 |

### Purpose

Generate operational runbooks, incident response plans, and escalation procedures.

### Outputs

| Artifact                          | Description                                                    |
|-----------------------------------|----------------------------------------------------------------|
| runbooks.md                       | SSM Automation runbook library                                 |
| incident-plan.md                  | Incident response plan (AWS Incident Manager integration)      |
| escalation-matrix.md              | Escalation paths, on-call rotations, communication procedures  |
| incident-response-questions.md    | Clarifying questions with answers                              |

---

## Stage 4.6: Performance Validation & Load Testing

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.6                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL (skip for POCs or non-performance-critical applications)                              |
| Lead Agent        | aidlc-quality-agent                                                                                     |
| Inputs            | NFR requirements from Stage 3.2, NFR design from Stage 3.3, observability data from Stage 4.4    |

### Purpose

Design and execute load tests to validate NFR performance targets against the deployed application.

### Outputs

| Artifact                              | Description                                                |
|---------------------------------------|------------------------------------------------------------|
| load-test-plan.md                     | Load test plan with scenarios, tools, and configuration    |
| test-results.md                       | Performance test results (latency, throughput, error rates) |
| nfr-validation-matrix.md             | NFR target vs. actual validation matrix                    |
| performance-validation-questions.md   | Clarifying questions with answers                          |

---

## Stage 4.7: Continuous Feedback & Optimization

### Metadata

| Property          | Value                                                                                             |
|-------------------|---------------------------------------------------------------------------------------------------|
| Stage             | 4.7                                                                                               |
| Phase             | Operation                                                                                         |
| Execution         | CONDITIONAL (skip for one-off deployments)                                                        |
| Lead Agent        | aidlc-operations-agent                                                                                  |
| support_agents    | aidlc-aws-platform-agent (cost optimization, drift detection)                                           |
| Inputs            | All Operation phase artifacts, production monitoring data                                         |

### Purpose

SLO compliance review, cost optimization analysis, infrastructure drift detection, and operational insights collection. This is the **final stage** of the entire AI-DLC workflow.

### Outputs

| Artifact                              | Description                                                |
|---------------------------------------|------------------------------------------------------------|
| slo-report.md                         | SLO compliance report, error budget burn rate              |
| cost-analysis.md                      | AWS Cost Explorer analysis, optimization recommendations   |
| drift-report.md                       | AWS Config drift detection report, Trusted Advisor review  |
| feedback-loop.md                      | Operational insights, improvement proposals, inputs to next Ideation cycle |
| feedback-optimization-questions.md    | Clarifying questions with answers                          |

### Approval Gate -- Three-Option (Unique)

Stage 4.7 has a **unique three-option approval gate**:

1. **Approve** -- Workflow complete. The full AI-DLC lifecycle is finished.
2. **Request Changes** -- Provide revision feedback.
3. **Start New Ideation Cycle** -- Feed the feedback-loop.md insights back into a new Stage 1.1.

This reflects the cyclical nature of the AI-DLC lifecycle.

---

## Phase Summary

**Deployment stages (4.1-4.3):**
- 4.1 Deployment Pipeline -- CD pipeline config, deployment strategy, rollback runbook
- 4.2 Environment Provisioning -- AWS environment provisioning and validation with security posture review
- 4.3 Deployment Execution -- Artifact deployment, smoke tests, health checks, database migrations

**Operational readiness stages (4.4-4.6):**
- 4.4 Observability Setup -- Dashboards, alarms, SLOs, log queries, tracing, anomaly detection
- 4.5 Incident Response -- Runbooks, incident plan, escalation matrix
- 4.6 Performance Validation -- Load testing, NFR target validation, capacity planning

**Continuous improvement (4.7):**
- 4.7 Feedback & Optimization -- SLO compliance, cost analysis, drift detection, feedback loop

**Scope applicability:**
- enterprise / feature / workshop: All 7 stages
- infra: Stages 4.1-4.4 (deployment-pipeline, environment-provisioning, deployment-execution, observability-setup)
- security-patch: Stages 4.1, 4.3 (deployment-pipeline, deployment-execution)
- mvp / poc / bugfix / refactor: Operation phase skipped entirely

## Cross-References

- [Orchestrator](../03-orchestrator.md) -- routing logic, scope mapping
- [Stage Protocol](../04-stage-protocol.md) -- approval gates, state tracking
- [Construction Stages](construction.md) -- previous phase
