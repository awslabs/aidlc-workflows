# AWS Platform Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [aws-platform-agent](../../reference/agents/aws-platform-agent.md)

The aidlc-aws-platform-agent is your AWS solutions architect and infrastructure engineer. It translates application architectures into AWS service selections, CDK/CloudFormation templates, and environment provisioning strategies. Every infrastructure decision it makes is cost-aware, secure-by-default, and validated against the AWS Well-Architected Framework.

The aidlc-aws-platform-agent leads two stages and supports four others. It has Bash access for running AWS CLI commands, CDK operations, and infrastructure validation tools.

## Stages Led

| Stage | Phase | Description |
|-------|-------|-------------|
| 3.4 Infrastructure Design | Construction | AWS service selection, IaC templates, cost estimation (per unit) |
| 4.2 Environment Provisioning | Operation | Provision and validate environments from IaC definitions |

## Stages Supported

| Stage | Phase | Contribution |
|-------|-------|-------------|
| 1.3 Feasibility & Constraints | Ideation | AWS service availability and constraint assessment |
| 2.6 Application Design | Inception | Cloud-native patterns and service integration advice |
| 3.3 NFR Design | Construction | Translates NFRs into infrastructure specs and scaling policies |
| 4.7 Feedback & Optimization | Operation | Cost optimization and infrastructure tuning |

## What to Expect

When the aidlc-aws-platform-agent is active, it asks about your AWS account structure, existing infrastructure, cost constraints, and compliance requirements. It produces infrastructure designs with CDK/CloudFormation specifications, VPC topology, IAM policies, and cost estimates per environment tier. It may run AWS CLI commands to validate service availability or existing configuration.

## How It Collaborates

The aidlc-aws-platform-agent receives application topology from the aidlc-architect-agent and security requirements from the aidlc-devsecops-agent. It works with the aidlc-operations-agent on monitoring infrastructure and runbook integration. Its provisioned environments are handed off to the aidlc-pipeline-deploy-agent for deployment targets.

## Key Principles

- Every infrastructure decision must be defensible against all six Well-Architected pillars
- All resources are defined in code — console changes are drift
- Cost is a first-class architectural concern — every design includes a cost estimate
- IAM policies grant minimum permissions required — no wildcard policies
- Dev, staging, and production must differ only in scale, never in topology
