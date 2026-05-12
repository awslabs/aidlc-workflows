# Resiliency Baseline — Opt-In

**Extension**: Resiliency Baseline

## Opt-In Prompt

The following questions are automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Resiliency Extensions
Should resiliency extension rules be enforced for this project?

A) Yes — enforce all RESILIENCY rules as blocking constraints (recommended for production-grade and business-critical workloads)
B) No — skip all RESILIENCY rules (suitable for PoCs, prototypes, and experimental projects)
X) Other (please describe after [Answer]: tag below)

[Answer]: 
```

## RTO/RPO Goals Prompt

The following question is automatically included when the user opts IN to resiliency rules (Answer = A above). It captures recovery targets that drive DR strategy selection per RESILIENCY-02 and RESILIENCY-11.

```markdown
## Question: RTO/RPO Goals
What are your Recovery Time Objective (RTO) and Recovery Point Objective (RPO) goals? These determine the appropriate Disaster Recovery strategy and infrastructure redundancy level.

A) RPO/RTO: Hours — Backup & Restore strategy. Lowest cost ($). Data backed up, no services deployed. Redeploy from IaC and restore from backups on failure. Suitable for non-critical workloads.
B) RPO/RTO: 10s of minutes — Pilot Light strategy. Cost: $$. Data live, services idle. Infrastructure deployed but not running, scaled up on failover. Suitable for important workloads.
C) RPO/RTO: Minutes — Warm Standby strategy. Cost: $$$. Data live, services run at reduced capacity. Scaled up during failover. Suitable for business-critical applications.
D) RPO/RTO: Near real-time — Multi-site Active/Active strategy. Highest cost ($$$$). Data live, live services in multiple regions simultaneously. Suitable for mission-critical, zero-downtime requirements.
E) N/A — Single-region deployment is acceptable, no cross-region DR needed. Rely on multi-AZ availability within one region.
X) Other (please describe after [Answer]: tag below)

[Answer]: 
```
