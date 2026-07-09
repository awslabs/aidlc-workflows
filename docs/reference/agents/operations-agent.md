# aidlc-operations-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-operations-agent |
| Tier | **templated** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, Bash, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

| Stage | Name | What This Agent Does |
|-------|------|----------------------|
| observability-setup | Observability Setup | Configures CloudWatch dashboards, alarms, X-Ray tracing, structured logging, and custom metrics |
| incident-response | Incident Response | Authors SSM runbooks, defines severity levels, establishes on-call structure, designs chaos experiments |
| feedback-optimization | Feedback and Optimization | Analyzes production metrics, channels insights back to Ideation, recommends infrastructure and architecture improvements |

### Support Stages

None. The stage graph records `support_agents: []` for performance-validation
(4.6) — that stage is led by the aidlc-quality-agent. The operational telemetry
and baselines this agent stands up in observability-setup (4.4) feed performance
validation informally, but operations is not a formal support agent on 4.6.

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-aws-platform-agent | Provisioned infrastructure, CloudWatch namespaces, scaling policies |
| aidlc-pipeline-deploy-agent | Deployed services, deployment metadata |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-product-agent | Operational feedback for next Ideation cycle (closes the lifecycle loop) |
| aidlc-architect-agent | Architectural improvement recommendations based on production observations |
| Orchestrator | Feedback report for iteration planning |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-operations-agent/`

| File | Content |
|------|---------|
| incident-response-guide.md | Incident response methodology, severity levels, postmortem templates |
| nfr-performance-guide.md | Performance monitoring and optimization methodology |
| observability-patterns.md | Observability patterns (dashboards, alarms, tracing, logging) |
| slo-sli-patterns.md | SLO/SLI definition patterns, error budget policies |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-operations-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
operational context such as existing runbooks, on-call schedules, SLO targets,
or monitoring dashboards.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-operations-agent](../../guide/agents/operations-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-operations-agent.md`](../../../dist/claude/.claude/agents/aidlc-operations-agent.md)
