# NFR Requirements Guide

## Performance Requirement Benchmarking

### How to Define Performance Requirements
Every performance requirement must specify:
- **Metric**: What is being measured (response time, throughput, resource usage)
- **Target**: The quantitative threshold
- **Percentile**: Which percentile the target applies to (p50, p95, p99)
- **Load condition**: Under what concurrency/traffic the target must hold
- **Measurement method**: How and where the metric is captured

### Common Performance Targets by Application Type

| Application Type | Metric | Target | Percentile | Notes |
|-----------------|--------|--------|------------|-------|
| Web application (interactive) | Page load time | < 2s | p95 | First contentful paint |
| REST API (synchronous) | Response time | < 200ms | p99 | Excludes network transit |
| Search query | Result delivery | < 500ms | p95 | Including ranking |
| Batch processing | Throughput | N records/min | Average | Define minimum acceptable rate |
| Real-time messaging | End-to-end latency | < 100ms | p99 | From send to delivery |
| File upload | Processing time | < 5s per MB | p95 | Post-upload processing |

### Performance Anti-Requirements
Explicitly exclude unreasonable expectations:
- "The system should be fast" (not measurable)
- "All pages load instantly" (no target, no percentile)
- "Handle unlimited users" (no capacity boundary)

Replace with: "The dashboard page loads in < 3 seconds at p95 under 500 concurrent users."

## Scalability Assessment Frameworks

### Capacity Planning Template

| Dimension | Current | 6-Month Target | 12-Month Target | Scaling Mechanism |
|-----------|---------|---------------|-----------------|-------------------|
| Concurrent users | N | N * X | N * Y | Horizontal auto-scaling |
| Data volume | N GB | N * X GB | N * Y GB | Partitioning strategy |
| Requests per second | N | N * X | N * Y | Load balancer + replicas |
| Storage growth rate | N GB/month | N * X GB/month | N * Y GB/month | Tiered storage policy |

### Scalability Requirement Format
```
NFR-SCALE-NNN: [Scalability Requirement]
Current baseline: [measured current capacity]
Target capacity: [required capacity at specific timeline]
Growth model: [linear, exponential, seasonal, step-function]
Scaling approach: [horizontal, vertical, partitioning, caching]
Cost constraint: [infrastructure cost must remain below $X/month at target scale]
Degradation policy: [what degrades first when approaching capacity limits]
```

### Scaling Decision Matrix

| Signal | Scale Up | Scale Out | Optimize First |
|--------|----------|-----------|----------------|
| CPU consistently > 70% | Single-instance workloads | Stateless services | Check for inefficient algorithms |
| Memory pressure | In-memory processing | Distributed cache | Check for memory leaks |
| I/O wait > 30% | Faster storage tier | Read replicas, sharding | Query optimization, indexing |
| Queue depth growing | Faster consumers | More consumer instances | Batch size tuning |
| Connection pool exhausted | Larger pool size | Connection multiplexing | Connection leak investigation |

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

## Security Requirement Templates

### Authentication Requirements
```
NFR-AUTH-NNN: [Authentication Requirement]
Method: [OAuth 2.0, JWT, session-based, API key, mTLS]
Token lifetime: [access token TTL, refresh token TTL]
MFA requirement: [none, optional, required for admin, required for all]
Session management: [max concurrent sessions, idle timeout, absolute timeout]
Password policy: [min length, complexity, rotation, breach detection]
```

### Authorization Requirements
```
NFR-AUTHZ-NNN: [Authorization Requirement]
Model: [RBAC, ABAC, ACL, policy-based]
Roles: [list of roles and their permission boundaries]
Resource granularity: [organization, team, user, resource-level]
Delegation: [can users delegate permissions, under what constraints]
Audit: [which authorization decisions are logged]
```

### Data Protection Requirements
```
NFR-DATA-NNN: [Data Protection Requirement]
Classification: [public, internal, confidential, restricted]
Encryption at rest: [algorithm, key management, rotation schedule]
Encryption in transit: [TLS version, cipher suites, certificate management]
PII handling: [identification, masking, pseudonymization, retention limits]
Data residency: [geographic constraints, cross-border transfer rules]
Backup encryption: [separate key, recovery testing frequency]
```

### Compliance Requirements
```
NFR-COMP-NNN: [Compliance Requirement]
Framework: [GDPR, SOC 2, HIPAA, PCI-DSS, ISO 27001]
Scope: [which components/data are in scope]
Controls: [specific controls required — access logging, encryption, retention]
Audit frequency: [continuous, quarterly, annual]
Evidence requirements: [what documentation/logs must be maintained]
```

### Security Anti-Requirements
Explicitly exclude unreasonable expectations:
- "The system should be secure" (not measurable)
- "No vulnerabilities" (impossible — define acceptable risk)
- "Military-grade encryption" (undefined — specify algorithm and key length)

Replace with: "All API endpoints require JWT authentication with RS256 signing. Access tokens expire after 15 minutes. Refresh tokens expire after 7 days and are single-use."
