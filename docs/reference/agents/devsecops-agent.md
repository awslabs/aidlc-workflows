# aidlc-devsecops-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-devsecops-agent |
| Tier | **judgment** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, Bash, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

This agent has no lead stages. It operates exclusively in a support role across
multiple stages in the Inception, Construction, and Operation phases.

### Support Stages

| Stage | Name | What This Agent Contributes |
|-------|------|-----------------------------|
| practices-discovery | Practices Discovery | Mutually blind spoke that records scanning, secrets-handling, and secure-pipeline findings in its contribution file |
| nfr-requirements | NFR Requirements | Security controls specification and threat model integration |
| infrastructure-design | Infrastructure Design | IAM policy review, security group validation, network security assessment |
| build-and-test | Build and Test | SAST/DAST scan configuration, dependency vulnerability scanning, IaC security linting |
| environment-provisioning | Environment Provisioning | Security posture validation (Security Hub, Inspector, GuardDuty, encryption, CloudTrail, VPC Flow Logs) |

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-compliance-agent | Regulatory requirements from Ideation (constraint register, RAID log) |
| aidlc-architect-agent | System design, component boundaries for threat modelling |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-developer-agent | Secure coding requirements, vulnerability fix specifications |
| aidlc-quality-agent | Security test cases for execution |
| aidlc-pipeline-deploy-agent | Security gates for CI/CD pipeline integration |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-devsecops-agent/`

| File | Content |
|------|---------|
| devsecops-pipeline-patterns.md | Security pipeline integration patterns (SAST, DAST, IaC scanning) |
| nfr-requirements-guide.md | Security-focused NFR requirements methodology |
| security-guide.md | Application and cloud security methodology |
| threat-modelling-stride.md | STRIDE threat modelling methodology and templates |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-devsecops-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
security context such as existing threat models, security policies, approved
encryption standards, or penetration test findings.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-devsecops-agent](../../guide/agents/devsecops-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-devsecops-agent.md`](../../../dist/claude/.claude/agents/aidlc-devsecops-agent.md)
