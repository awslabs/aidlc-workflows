# Incident Response Guide

Structured processes for detecting, responding to, and learning from production incidents.

## Incident Severity Levels

| Level | Name | Criteria | Response Time | Examples |
|-------|------|----------|---------------|---------|
| **SEV1** | Critical | Complete service outage or data loss affecting all users | < 15 minutes | Production down, data breach, payment processing failure |
| **SEV2** | Major | Significant degradation affecting many users, no workaround | < 30 minutes | Partial outage, error rate > 10%, major feature broken |
| **SEV3** | Minor | Limited impact, workaround available | < 2 hours | Non-critical feature broken, intermittent errors, slow performance |
| **SEV4** | Low | Cosmetic or minor issue, no user impact | Next business day | UI glitch, non-critical log errors, minor config drift |

## Escalation Matrix

Define who to contact at each severity level:

| Severity | Primary Responder | Escalation (30 min) | Escalation (1 hour) |
|----------|------------------|---------------------|---------------------|
| SEV1 | On-call engineer | Engineering manager + Incident commander | VP Engineering + Stakeholder communication |
| SEV2 | On-call engineer | Team lead | Engineering manager |
| SEV3 | On-call engineer | Team lead (if unresolved in 4 hours) | — |
| SEV4 | Any team member | — | — |

## On-Call Rotation

- Rotate weekly among team members. Ensure at least 2 people are trained for on-call at all times.
- Primary and secondary on-call: secondary takes over if primary is unreachable within 10 minutes.
- On-call handoff includes: review of active alerts, ongoing issues, recent deployments, and known risks.
- Compensate on-call fairly: time off in lieu, on-call stipend, or both.
- Maximum on-call frequency: no more than 1 week in 4. If the team is too small, address staffing.

## Incident Commander Role

For SEV1 and SEV2 incidents, designate an Incident Commander (IC) who:
- **Coordinates** response efforts; does not debug directly.
- **Communicates** status updates to stakeholders at regular intervals (every 15-30 minutes).
- **Delegates** workstreams: investigation, mitigation, communication, documentation.
- **Decides** when to escalate, when to roll back, when to declare resolution.
- **Documents** timeline, actions taken, and decisions made in a shared incident channel.

The IC is not necessarily the most senior engineer; it is the person who can coordinate effectively under pressure.

## Communication During Incidents

### Internal
- Create a dedicated Slack/Teams channel: `#incident-YYYY-MM-DD-short-description`.
- Post structured updates: **Status** (investigating/identified/mitigating/resolved), **Impact** (who is affected), **Next Step** (what we are doing), **ETA** (when the next update will be).
- Keep the channel focused; move side discussions to threads.

### External
- SEV1: Status page update within 20 minutes. Customer communication within 1 hour.
- SEV2: Status page update within 1 hour if customer-visible.
- Use pre-drafted templates for common scenarios: "We are experiencing elevated error rates..."
- Never speculate about root cause in external communications until confirmed.

## Post-Incident Review (Blameless Postmortem)

Conduct within 48 hours of incident resolution for SEV1/SEV2.

### Structure
1. **Timeline**: Minute-by-minute account from detection to resolution.
2. **Impact**: Users affected, duration, financial/data impact.
3. **Root Cause**: Technical cause(s) of the incident.
4. **Contributing Factors**: Process, tooling, or knowledge gaps that allowed the incident.
5. **What Went Well**: Effective parts of the response.
6. **What Could Be Improved**: Gaps in detection, response, or communication.
7. **Action Items**: Specific, assigned, time-boxed improvements.

### Blameless Principles
- Focus on systems and processes, not individuals.
- People made the best decisions they could with the information available.
- Ask "what" and "how", not "who".
- The goal is to improve the system so the same failure cannot recur.

## SSM Automation Runbooks

Create automated runbooks for common operational tasks and incident responses:

- **Restart service**: ECS task restart, Lambda function redeployment.
- **Scale out**: Increase desired count, adjust auto-scaling thresholds.
- **Database failover**: Trigger RDS failover, verify application reconnection.
- **Clear queue backlog**: Increase consumer concurrency, purge DLQ after inspection.
- **Rotate credentials**: Update secrets in Secrets Manager, trigger dependent service reloads.

Store runbooks as SSM Automation documents in version control. Reference them in alarm actions for automated remediation.

## Automated Remediation Patterns

- CloudWatch alarm triggers Lambda function to restart unhealthy ECS tasks.
- Auto Scaling policies respond to custom metrics (queue depth, error rate) not just CPU.
- EventBridge rules detect specific error patterns and invoke Step Functions for multi-step remediation.
- Always include circuit breakers: limit automated remediation attempts (max 3 restarts in 10 minutes) to prevent remediation loops.

## RTO and RPO Targets

- **RTO (Recovery Time Objective)**: Maximum acceptable downtime. How quickly must the system be restored?
- **RPO (Recovery Point Objective)**: Maximum acceptable data loss. How much data can we afford to lose?

| Tier | RTO | RPO | Strategy |
|------|-----|-----|----------|
| Critical (payments, auth) | < 5 minutes | 0 (zero data loss) | Multi-AZ active-active, synchronous replication |
| High (order processing) | < 30 minutes | < 5 minutes | Multi-AZ with automated failover, point-in-time recovery |
| Standard (reporting, analytics) | < 4 hours | < 1 hour | Regular backups, automated restoration |
| Low (internal tools) | < 24 hours | < 24 hours | Daily backups, manual restoration |

Test RTO/RPO targets quarterly through game days and disaster recovery drills.
