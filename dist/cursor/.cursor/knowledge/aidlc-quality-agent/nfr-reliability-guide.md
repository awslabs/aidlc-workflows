# NFR Reliability and Observability Guide

> This guide supplements the full NFR Requirements Guide held by the Security Engineer (lead agent for the NFR Requirements stage). It provides the QA Engineer with the reliability and observability sections needed for quality-focused contributions during NFR Requirements and Build and Test stages.

## Reliability Target-Setting

### SLA/SLO/SLI Hierarchy

| Term | Definition | Example | Who Defines |
|------|-----------|---------|-------------|
| **SLI** (Indicator) | The metric being measured | Successful requests / total requests | Engineering |
| **SLO** (Objective) | Internal target for the SLI | 99.95% success rate over 30 days | Engineering + Product |
| **SLA** (Agreement) | External contractual commitment | 99.9% uptime with financial penalties | Business + Legal |

**Rule**: SLO must be stricter than SLA. If SLA is 99.9%, set SLO at 99.95% to provide an internal buffer.

### Availability Targets and Their Implications

| Availability | Downtime / Year | Downtime / Month | Requires |
|-------------|-----------------|-------------------|----------|
| 99% (two nines) | 3.65 days | 7.3 hours | Basic monitoring, manual recovery |
| 99.9% (three nines) | 8.76 hours | 43.8 minutes | Auto-restart, health checks, alerting |
| 99.95% | 4.38 hours | 21.9 minutes | Multi-AZ, automated failover, load balancing |
| 99.99% (four nines) | 52.6 minutes | 4.38 minutes | Multi-region active-active, zero-downtime deploys |
| 99.999% (five nines) | 5.26 minutes | 26.3 seconds | Fully automated everything, extensive redundancy |

### Recovery Objectives

| Objective | Definition | How to Set |
|-----------|-----------|------------|
| **RTO** (Recovery Time Objective) | Maximum acceptable time to restore service | Based on business impact per hour of downtime |
| **RPO** (Recovery Point Objective) | Maximum acceptable data loss window | Based on cost of recreating or losing data |
| **MTTR** (Mean Time to Recovery) | Average time to restore from failure | Measured operationally; target should be < RTO |
| **MTBF** (Mean Time Between Failures) | Average time between failures | Measured operationally; drives reliability investment |

## Observability Requirements

### Three Pillars Specification

#### Metrics Requirements
Define for each component:
- **Business metrics**: Conversion rate, revenue processed, active users
- **Application metrics**: Request rate, error rate, latency (RED method)
- **Infrastructure metrics**: CPU, memory, disk, network (USE method)
- **Retention**: How long to keep each metric tier (1 min granularity for 7 days, 5 min for 30 days, 1 hour for 1 year)

#### Logging Requirements
| Log Level | When to Use | Retention | Indexing |
|-----------|------------|-----------|---------|
| ERROR | Unrecoverable failures requiring attention | 90 days | Full-text indexed |
| WARN | Recoverable issues, degraded behavior | 30 days | Full-text indexed |
| INFO | Significant business events, state transitions | 30 days | Structured fields only |
| DEBUG | Diagnostic detail for troubleshooting | 7 days | Not indexed (stored only) |

#### Tracing Requirements
- Distributed traces across all service boundaries
- Trace context propagation via W3C Trace Context headers
- Sampling strategy: 100% for errors, 10% for normal traffic (adjust for volume)
- Trace retention: 7 days at full detail, 30 days for trace metadata

### Alerting Requirements Template
For each alert:
```
Alert: [descriptive name]
SLI: [which service level indicator]
Threshold: [when to fire -- e.g., error rate > 1% for 5 minutes]
Severity: [page (wake someone up) | ticket (next business day) | log (informational)]
Runbook: [link to response procedure]
Notification: [who gets notified via which channel]
Auto-remediation: [if any automated response is triggered]
```

### Observability Anti-Patterns to Avoid
- Alerting on causes instead of symptoms (alert on error rate, not CPU usage)
- Missing correlation IDs across service boundaries
- Logging sensitive data (PII, credentials, tokens)
- Alert fatigue from noisy thresholds (tune before deploying)
- Dashboard sprawl without clear ownership (every dashboard needs an owner)
