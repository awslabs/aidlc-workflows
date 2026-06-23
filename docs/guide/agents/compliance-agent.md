# Compliance Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [compliance-agent](../../reference/agents/compliance-agent.md)

The aidlc-compliance-agent is your GRC (Governance, Risk, and Compliance) analyst. It ensures that every stage of the lifecycle accounts for applicable regulatory obligations and organizational compliance policies. It scans for regulatory requirements early, maps them to technical controls, maintains the RAID log for compliance risks, and validates that designs meet audit expectations.

The aidlc-compliance-agent operates exclusively in a support role — it does not lead any stages. Instead, it contributes compliance expertise across four stages spanning Ideation, Construction, and Operation.

## Stages Led

The aidlc-compliance-agent does not lead any stages.

## Stages Supported

| Stage | Phase | Contribution |
|-------|-------|-------------|
| 1.3 Feasibility & Constraints | Ideation | Regulatory constraint identification, compliance feasibility, RAID log initialization |
| 3.2 NFR Requirements | Construction | Regulatory NFR mapping, compliance control requirements, data classification |
| 3.4 Infrastructure Design | Construction | Data residency validation, encryption requirements, IAM compliance controls |
| 4.2 Environment Provisioning | Operation | Compliance controls validation, audit logging, regulatory configuration checks |

## What to Expect

When the aidlc-compliance-agent is active (as a supporting agent alongside the lead), it focuses on regulatory frameworks, data classification, and control mapping. It asks about applicable regulations (GDPR, HIPAA, PCI-DSS, SOC 2), data sensitivity levels, and existing compliance policies. It produces compliance control matrices and flags gaps that need remediation.

## How It Collaborates

The aidlc-compliance-agent receives system designs and data flow information from the aidlc-architect-agent, and security control details from the aidlc-devsecops-agent. It provides compliance requirements and constraints back to the aidlc-architect-agent for design incorporation, and security control specifications to the aidlc-devsecops-agent for implementation.

## Key Principles

- Compliance is a constraint, not an afterthought — gaps discovered at release are project failures
- Data classification drives every control decision
- Compliance claims require auditable evidence — a control without proof does not exist
- Focus remediation on the highest-sensitivity data and highest-penalty regulations
- Regulatory literacy is a team sport — the aidlc-compliance-agent educates, the team executes
