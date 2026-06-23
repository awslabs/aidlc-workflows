# Operations Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [operations-agent](../../reference/agents/operations-agent.md)

The aidlc-operations-agent is your site reliability engineer and incident manager. It ensures that deployed systems are observable, resilient, and continuously improving. It owns the operational layer from CloudWatch dashboards and alarms through X-Ray tracing, SLO tracking, incident response runbooks, and chaos engineering validation. Critically, it closes the feedback loop by channeling production insights back into Ideation for the next iteration.

The aidlc-operations-agent leads three stages in the Operation phase. It has Bash access for running monitoring setup commands, runbook scripts, and diagnostic tools.

## Stages Led

| Stage | Phase | Description |
|-------|-------|-------------|
| 4.4 Observability Setup | Operation | Dashboards, alarms, tracing, structured logging, custom metrics |
| 4.5 Incident Response | Operation | SSM runbooks, incident plan, escalation matrix, on-call structure |
| 4.7 Feedback & Optimization | Operation | SLO reports, cost analysis, drift detection, feedback loop |

The aidlc-quality-agent leads 4.6 Performance Validation; the operational telemetry and baselines this agent sets up in 4.4 feed that work informally, but it is not a formal support agent on 4.6.

## Stages Supported

None. The aidlc-operations-agent is a lead-only agent — it supports no other agent's stages. Its leads all fall in Operation, where it closes the lifecycle loop.

## What to Expect

When the aidlc-operations-agent is active, it asks about your monitoring preferences, SLO targets, incident response processes, and on-call structure. It produces CloudWatch dashboard configurations, alarm definitions with thresholds and notification targets, X-Ray tracing setup, SSM runbooks for common scenarios (service restart, cache flush, failover), and incident severity definitions with escalation paths.

During Feedback & Optimization (the final stage), it analyzes production metrics, identifies optimization opportunities, and produces a feedback loop document that channels operational insights back to the aidlc-product-agent for the next development cycle.

## How It Collaborates

The aidlc-operations-agent receives provisioned infrastructure from the aidlc-aws-platform-agent and deployed services from the aidlc-pipeline-deploy-agent. It works with the aidlc-quality-agent on performance baselines and SLO validation, and with the aidlc-developer-agent on application-level logging improvements. Its feedback report is the bridge from Operation back to Ideation, completing the lifecycle loop.

## Key Principles

- Collect comprehensive telemetry but only alert on user-impacting issues — alert fatigue degrades response
- SLOs define the reliability target; everything else derives from them
- Every incident is a learning opportunity — blameless postmortems convert incidents into improvements
- Untested resilience mechanisms are assumptions — chaos engineering verifies them
- Production insights that do not flow back to Ideation are wasted learning
- Manual operational toil must be eliminated — automate every repeatable runbook step
