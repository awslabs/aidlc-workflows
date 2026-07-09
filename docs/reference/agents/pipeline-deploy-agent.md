# aidlc-pipeline-deploy-agent -- Technical Reference

## Identity

| Field | Value |
|-------|-------|
| Name | aidlc-pipeline-deploy-agent |
| Tier | **templated** |
| Allowed Claude Code Tools | Read, Edit, Write, Glob, Grep, Bash, AskUserQuestion |
| Disallowed Claude Code Tools | Task |

---

## Stage Ownership

### Lead Stages

| Stage | Name | What This Agent Does |
|-------|------|----------------------|
| practices-discovery | Practices Discovery | Discovers existing engineering practices and candidate rules; on affirmation, content is promoted to team and project rule layers |
| ci-pipeline | CI Pipeline | Designs and configures CI pipelines with quality gates, artifact generation, and security scanning |
| deployment-pipeline | Deployment Pipeline | Designs CD pipelines with promotion gates, deployment strategies, and feature flag integration |
| deployment-execution | Deployment Execution | Executes deployments, runs smoke tests, monitors health metrics, handles rollback |

### Support Stages

This agent serves no support roles; all four stages it touches are lead
stages.

---

## Collaboration Patterns

### Receives From

| Source | Artifacts |
|--------|-----------|
| aidlc-developer-agent | Buildable source code, test suites, build scripts |
| aidlc-quality-agent | Test requirements, quality gate definitions |
| aidlc-aws-platform-agent | Environment endpoints, infrastructure outputs, secrets |

### Hands Off To

| Target | Artifacts |
|--------|-----------|
| aidlc-operations-agent | Deployed services for observability setup and monitoring |
| aidlc-quality-agent | Deployment artifacts for performance validation |

---

## Knowledge Sources

### Methodology (Tier 1)

Path: `.claude/knowledge/aidlc-pipeline-deploy-agent/`

| File | Content |
|------|---------|
| cicd-patterns.md | CI/CD pipeline patterns, quality gates, artifact management |
| deployment-strategies.md | Deployment strategy patterns (blue-green, canary, rolling, recreate) |
| branching-strategies.md | Five branching strategies (trunk-based, GitHub Flow, GitFlow, release branches, monorepo) with AI-DLC worktree mappings; surveyed at Bolt-merge dispatch |

### Team (Tier 2)

Path: `aidlc/knowledge/aidlc-pipeline-deploy-agent/` (the space-level knowledge dir; user-managed)

A space-level directory the team creates when it has content (the engine ships `aidlc/knowledge/` empty). Populated by the team with project-specific
deployment context such as existing pipeline configurations, deployment
runbooks, or release approval workflows.

---

## Cross-References

- [Agent Reference Overview](README.md)
- [Agent Guide: aidlc-pipeline-deploy-agent](../../guide/agents/pipeline-deploy-agent.md)
- [Stage Documentation](../04-stages/)
- Source: [`dist/claude/.claude/agents/aidlc-pipeline-deploy-agent.md`](../../../dist/claude/.claude/agents/aidlc-pipeline-deploy-agent.md)
