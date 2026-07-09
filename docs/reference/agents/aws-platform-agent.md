# aidlc-aws-platform-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-aws-platform-agent |
| Tier | **judgment** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, Bash, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

| Stage | Name | What This Agent Does |
|-------|------|----------------------|
| infrastructure-design | Infrastructure Design | Translates application architecture into AWS service selections, CDK/CloudFormation templates, VPC design, IAM policies, and cost estimates |
| environment-provisioning | Environment Provisioning | Provisions dev/staging/production environments from IaC definitions with drift detection and environment parity |

### Support Stages

| Stage | Name | What This Agent Contributes |
|-------|------|-----------------------------|
| feasibility | Feasibility and Constraint Analysis | Assesses AWS service availability, regional constraints, and cloud platform limitations |
| application-design | Application Design | Advises on cloud-native patterns, managed service integration, and serverless options |
| nfr-design | NFR Design | Translates NFRs into infrastructure specifications, auto-scaling policies, and resilience configurations |
| feedback-optimization | Feedback and Optimization | Identifies cost optimization opportunities and infrastructure tuning based on production metrics |

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-architect-agent | Application topology, component inventory, infrastructure requirements |
| aidlc-devsecops-agent | Security requirements, compliance controls, encryption specifications |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-pipeline-deploy-agent | Environment endpoints for deployment targets, infrastructure outputs |
| aidlc-operations-agent | Provisioned infrastructure for observability setup and monitoring |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-aws-platform-agent/`

| File | Content |
|------|---------|
| cdk-best-practices.md | AWS CDK construct patterns, stack organization, and testing |
| cost-optimization-patterns.md | FinOps patterns, right-sizing, reserved instances, savings plans |
| infrastructure-guide.md | Infrastructure design methodology and environment provisioning |
| well-architected-framework.md | AWS Well-Architected Framework six pillars reference |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-aws-platform-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
infrastructure context such as existing VPC designs, AWS account structure,
approved service catalog, or cost baselines.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-aws-platform-agent](../../guide/agents/aws-platform-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-aws-platform-agent.md`](../../../dist/claude/.claude/agents/aidlc-aws-platform-agent.md)
