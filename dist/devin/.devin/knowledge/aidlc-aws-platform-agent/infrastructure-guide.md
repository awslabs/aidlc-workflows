# Infrastructure Guide

## IaC Tool Selection

| Tool | Best For | Considerations |
|------|----------|---------------|
| AWS CDK | AWS-native, TypeScript/Python teams, complex constructs | Vendor lock-in, steep learning curve |
| Terraform | Multi-cloud, team standardization, mature ecosystem | HCL syntax, state management complexity |
| CloudFormation | AWS-only, simple stacks, when CDK is overkill | Verbose YAML/JSON, slow drift detection |
| Pulumi | Polyglot teams wanting general-purpose languages | Smaller community, state backend choice |
| Docker Compose | Local development, simple multi-container apps | Not for production orchestration |

## CI/CD Pipeline Design

### Standard Pipeline Stages
```
[Source] -> [Lint] -> [Build] -> [Unit Test] -> [SAST] -> [Package] ->
[Integration Test] -> [Deploy Staging] -> [E2E Test] -> [Security Scan] ->
[Approval Gate] -> [Deploy Production] -> [Smoke Test] -> [Monitor]
```

### Stage Requirements
- **Lint**: Fail fast on formatting and static analysis violations. Under 30 seconds.
- **Build**: Compile/transpile, resolve dependencies. Cache aggressively. Under 2 minutes.
- **Unit Test**: Full suite. Fail the pipeline on any failure. Under 3 minutes.
- **SAST**: Static security scan. Block on high/critical findings. Under 5 minutes.
- **Package**: Build container image or deployment artifact. Tag with commit SHA.
- **Integration Test**: Run against test database and mock external services. Under 10 minutes.
- **Deploy Staging**: Automated. Mirror production topology at reduced scale.
- **E2E Test**: Critical paths only. Under 15 minutes. Flaky tests quarantined, not skipped.
- **Security Scan**: DAST against staging. Dependency vulnerability check.
- **Approval Gate**: Manual approval for production (optional, based on risk appetite).
- **Deploy Production**: Automated with selected deployment strategy.
- **Smoke Test**: Verify core endpoints respond correctly post-deploy. Under 2 minutes.

## Deployment Strategies

### Blue-Green
- Two identical environments; traffic switches atomically
- **Pro**: Instant rollback, zero downtime
- **Con**: Double infrastructure cost, database schema sync complexity
- **Use when**: Zero-downtime required, database changes are backward-compatible

### Canary
- Route small percentage of traffic (1-5%) to new version, gradually increase
- **Pro**: Limited blast radius, real-user validation
- **Con**: Requires traffic splitting, metric comparison automation
- **Use when**: High-traffic systems, need to validate under real load

### Rolling
- Replace instances incrementally (1 at a time or N at a time)
- **Pro**: No extra infrastructure, gradual rollout
- **Con**: Mixed versions running simultaneously, slower rollback
- **Use when**: Stateless services, backward-compatible changes

### Recreate
- Stop all old instances, start all new instances
- **Pro**: Simple, no version mixing
- **Con**: Downtime during transition
- **Use when**: Acceptable maintenance window, breaking changes

## Monitoring & Observability Stack

### The Four Pillars
1. **Metrics**: Numeric measurements over time (CPU, latency, error count)
   - Tool examples: CloudWatch, Prometheus + Grafana, Datadog
   - Key metrics: RED (Rate, Errors, Duration) for services; USE (Utilization, Saturation, Errors) for resources

2. **Logs**: Structured event records from application and infrastructure
   - Format: JSON with timestamp, level, service, traceId, message, context
   - Tool examples: CloudWatch Logs, ELK stack, Loki
   - Retention: 30 days hot, 90 days warm, 1 year cold

3. **Traces**: Request flow across services
   - Tool examples: X-Ray, Jaeger, Zipkin, OpenTelemetry
   - Instrument: HTTP handlers, database calls, external API calls, queue operations

4. **Alerts**: Automated notifications for anomalies
   - Alert on symptoms (error rate > 1%), not causes (CPU > 80%)
   - Severity levels: P1 (page), P2 (ticket), P3 (dashboard)
   - Include runbook link in every alert

## Container Orchestration Checklist

For containerized deployments, define:
- [ ] Base image selection (minimal, security-patched, pinned version)
- [ ] Multi-stage build for smaller production images
- [ ] Health check endpoint (`/health` or `/readyz`)
- [ ] Graceful shutdown handling (SIGTERM, drain connections)
- [ ] Resource limits (CPU, memory) to prevent noisy-neighbor issues
- [ ] Secrets management (not in image, not in env vars -- use secrets manager)
- [ ] Log output to stdout/stderr (not file-based)
- [ ] Non-root user in container
- [ ] Read-only filesystem where possible

## Environment Strategy

```
Local Dev    -> Developer laptop, docker-compose, hot reload
CI           -> Ephemeral, created per pipeline run, destroyed after
Staging      -> Persistent, mirrors production topology, reduced scale
Production   -> Full scale, multi-AZ, monitoring and alerting active
```

Parity rules:
- Staging MUST use the same IaC templates as production (parameterized for scale)
- Staging MUST use the same database engine and version as production
- Staging SHOULD have representative (anonymized) data volume
