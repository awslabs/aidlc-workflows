# Non-Functional Requirement (NFR) Validation Methods

Practical approaches to validating performance, scalability, and reliability requirements.

## Load Testing Tools and Methodology

**Tools**:
- **k6** (Grafana): Script-based, developer-friendly, runs locally or in cloud. Preferred for API load testing.
- **Locust** (Python): Distributed, programmable load generation. Good for complex user behaviour simulation.
- **Artillery**: YAML-driven, supports HTTP/WebSocket/Socket.io. Quick to set up.
- **AWS Distributed Load Testing**: CloudFormation-based, uses Fargate to generate load from within AWS.

**Methodology**:
1. Identify critical user journeys and their expected traffic volumes.
2. Create realistic test scripts with think times, parameterized data, and varied payloads.
3. Establish a performance baseline on current production or staging.
4. Run tests against an environment that mirrors production (same instance sizes, data volume, network topology).
5. Collect results, compare against NFR targets, identify bottlenecks.

## Performance Test Design Patterns

### Ramp-Up Test
Gradually increase virtual users from 0 to target over 5-15 minutes. Validates system behaviour under increasing load and identifies the breaking point.

### Steady-State Test
Hold constant load at expected peak for 30-60 minutes. Validates sustained performance, memory leaks, connection pool exhaustion, and resource saturation.

### Spike Test
Suddenly inject 3-5x normal load for a short burst (2-5 minutes). Validates auto-scaling triggers, queue depth handling, circuit breaker behaviour, and graceful degradation.

### Soak Test
Run at moderate load (60-80% of peak) for 4-24 hours. Detects slow memory leaks, file handle exhaustion, log rotation issues, and gradual performance degradation.

## Latency Percentiles

- **p50 (median)**: The typical user experience. Target depends on use case (web API: < 100ms).
- **p95**: Captures most users' worst-case experience. The primary SLO metric for most services.
- **p99**: Tail latency. High p99 with low p50 indicates inconsistent performance (GC pauses, cold starts, noisy neighbours).
- **p99.9**: Relevant for high-volume services where even 0.1% affects thousands of requests.

Always measure percentiles, not averages. An average of 50ms can hide a p99 of 5 seconds.

## Throughput Measurement

- Measure in requests per second (RPS) for APIs, messages per second for queues, transactions per second (TPS) for databases.
- Record throughput alongside latency; throughput without latency context is meaningless.
- Identify the throughput ceiling: the RPS at which latency begins to degrade beyond acceptable thresholds.
- For batch processing, measure records processed per second and total job duration.

## Capacity Planning

1. Determine current peak traffic from production metrics (CloudWatch, X-Ray).
2. Apply a growth multiplier (typically 2-3x current peak for 12-month horizon).
3. Load test at the projected peak to validate infrastructure can handle it.
4. Identify the scaling bottleneck (database connections, Lambda concurrency, NAT gateway bandwidth).
5. Document the cost at projected peak for budget approval.

## Auto-Scaling Validation

- Test that scale-out triggers fire within acceptable time (target: under 2 minutes for EC2, under 30 seconds for Lambda).
- Test that scale-in does not cause request failures (connection draining, graceful shutdown).
- Validate scaling policies use the right metric (CPU alone is often insufficient; include request count, queue depth).
- Test minimum and maximum capacity limits to prevent runaway scaling costs.
- Simulate a scaling event during a spike test and measure the latency impact during scale-out.

## NFR Target-vs-Actual Matrix

Track every NFR with a structured comparison:

| NFR | Target | Actual | Status | Test Date | Notes |
|-----|--------|--------|--------|-----------|-------|
| API latency p95 | < 200ms | 145ms | PASS | 2024-01-15 | Under 500 RPS |
| API latency p99 | < 500ms | 620ms | FAIL | 2024-01-15 | DB connection pool saturation |
| Throughput | > 1000 RPS | 1250 RPS | PASS | 2024-01-15 | |
| Availability | 99.95% | — | PENDING | — | Requires 30-day measurement |

Review the matrix at each milestone. Failing NFRs are risks that must be addressed before release.

## SLA Testing

- Simulate failure scenarios (AZ failure, dependency timeout, database failover) and measure recovery time.
- Validate that SLA commitments (uptime percentage, response time) hold under degraded conditions.
- Test circuit breakers, retries, and fallback responses under dependency failure.
- Document the gap between internal SLOs (tighter) and external SLAs (looser) to provide a safety margin.
