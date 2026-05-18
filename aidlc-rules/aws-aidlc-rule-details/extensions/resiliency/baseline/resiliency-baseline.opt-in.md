# Resiliency Baseline — Opt-In

**Extension**: Resiliency Baseline

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Resiliency Extensions
Should resiliency extension rules be enforced for this project?

Resilient systems are designed to remain operational during failures and recover quickly when disruptions occur. They are fault-tolerant (continuing to serve traffic when individual components fail), highly available (minimizing downtime through redundancy and multi-zone deployment), and recoverable (with documented disaster recovery strategies, automated backups, and tested failover procedures). Enabling this extension enforces 15 rules covering business goals, change management, observability, high availability, disaster recovery, and continuous improvement to help your workload withstand failures gracefully.

A) Yes — enforce all RESILIENCY rules as blocking constraints (recommended for production-grade and business-critical workloads where downtime, data loss, or degraded service has meaningful business impact)
B) No — skip all RESILIENCY rules (suitable for PoCs, prototypes, and experimental projects where rapid iteration matters more than reliability)
X) Other (please describe after [Answer]: tag below)

[Answer]: 
```
