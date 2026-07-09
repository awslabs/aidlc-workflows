# aidlc-compliance-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-compliance-agent |
| Tier | **judgment** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, WebSearch, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

This agent has no lead stages. It operates exclusively in a support and
advisory capacity across the lifecycle.

### Support Stages

| Stage | Name | What This Agent Contributes |
|-------|------|-----------------------------|
| feasibility | Feasibility and Constraint Analysis | Regulatory constraint identification, compliance feasibility assessment, RAID log initialization |
| nfr-requirements | NFR Requirements | Compliance-driven non-functional requirements and control specifications |
| infrastructure-design | Infrastructure Design | Data residency validation, encryption requirements, IAM audit |
| environment-provisioning | Environment Provisioning | Compliance posture validation for provisioned environments |

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-architect-agent | System design, data flow diagrams for compliance review |
| aidlc-devsecops-agent | Security controls, encryption specifications for compliance mapping |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-architect-agent | Compliance requirements for design incorporation |
| aidlc-devsecops-agent | Security control specifications derived from regulatory mandates |
| Orchestrator | Compliance risk escalations, RAID log updates |

### Collaborates With (peer)

| Peer | Shared concern |
|------|----------------|
| aidlc-aws-platform-agent | Data residency, encryption at rest, IAM audit |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-compliance-agent/`

| File | Content |
|------|---------|
| regulatory-frameworks.md | Reference for major regulatory frameworks (PCI-DSS, HIPAA, SOC 2, GDPR) |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-compliance-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
compliance context such as existing compliance matrices, audit findings, data
classification schemes, or regulatory interpretations.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-compliance-agent](../../guide/agents/compliance-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-compliance-agent.md`](../../../dist/claude/.claude/agents/aidlc-compliance-agent.md)
