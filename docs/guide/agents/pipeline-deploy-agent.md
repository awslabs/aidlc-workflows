# Pipeline & Deploy Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [pipeline-deploy-agent](../../reference/agents/pipeline-deploy-agent.md)

The aidlc-pipeline-deploy-agent is your CI/CD engineer and release manager. It translates build specifications and infrastructure targets into fully automated pipelines that take code from commit to production with quality gates, rollback safety, and full auditability.

The aidlc-pipeline-deploy-agent leads four stages spanning Inception, Construction, and Operation. It has Bash access for running pipeline tools, deployment scripts, and smoke test commands.

## Stages Led

| Stage | Phase | Description |
|-------|-------|-------------|
| 2.2 Practices Discovery | Inception | Discover team practices and engineering rules, promoted to team and project rules on affirmation |
| 3.7 CI Pipeline | Construction | CI pipeline configuration with quality gates |
| 4.1 Deployment Pipeline | Operation | CD pipeline with deployment strategy and rollback procedures |
| 4.3 Deployment Execution | Operation | Execute deployments, run smoke tests, monitor health |

## Stages Supported

The aidlc-pipeline-deploy-agent does not support any stages in an advisory capacity.

## What to Expect

When the aidlc-pipeline-deploy-agent is active, it asks about your existing CI/CD infrastructure, deployment targets, branching strategy, and rollback requirements. It produces pipeline configurations (CI config files, quality gate definitions), deployment strategies (blue-green, canary, rolling), and rollback runbooks. During Deployment Execution, it orchestrates the actual deployment, runs smoke tests, and monitors health metrics.

## How It Collaborates

The aidlc-pipeline-deploy-agent receives buildable source and test suites from the aidlc-developer-agent, quality gate definitions from the aidlc-quality-agent, and environment endpoints from the aidlc-aws-platform-agent. Its deployed services are handed off to the aidlc-operations-agent for observability setup, and deployment artifacts go to the aidlc-quality-agent for performance validation.

## Key Principles

- Every commit is a release candidate — if it passes all gates, it is ready for production
- Every deployment must have a tested rollback path
- CI pipelines should complete in minutes, not hours — slow pipelines encourage batching
- Quality gates exist to prevent defective artifacts from reaching users
- A deployment is not done until smoke tests confirm the service is healthy
