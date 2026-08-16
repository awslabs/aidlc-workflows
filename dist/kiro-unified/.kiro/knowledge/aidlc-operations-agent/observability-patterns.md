# Observability Patterns

Building visibility into system behaviour through metrics, logs, and traces to enable fast diagnosis and proactive detection.

## The Three Pillars of Observability

### 1. Metrics
Numeric measurements aggregated over time. Low cardinality, low cost, ideal for alerting and dashboards.
- **Types**: Counters (always increase), Gauges (can go up/down), Histograms (distribution of values).
- **AWS**: CloudWatch Metrics, CloudWatch Embedded Metric Format (EMF) for custom metrics from Lambda/ECS.
- Emit custom business metrics: orders placed per minute, payment failures per hour, sign-ups per day.

### 2. Logs
Timestamped records of discrete events. High cardinality, high volume.
- Use structured logging (JSON) with consistent fields: `timestamp`, `level`, `requestId`, `service`, `message`.
- Correlate logs across services using a shared `requestId` or `traceId` propagated through headers.
- **AWS**: CloudWatch Logs, with Log Groups per service and environment.

### 3. Traces
End-to-end path of a request through multiple services. Shows latency breakdown and dependency relationships.
- **AWS**: X-Ray for distributed tracing. Auto-instruments SDK calls to AWS services.
- Instrument custom segments for business logic, database queries, and external HTTP calls.
- Use trace maps to visualize service dependencies and identify latency bottlenecks.

## The Four Golden Signals (Google SRE)

Monitor these four signals for every service:

1. **Latency**: Time to serve a request. Measure as percentiles (p50, p95, p99). Track separately for successful and failed requests.
2. **Traffic**: Demand on the system. Requests per second for APIs, messages per second for queues, active connections for WebSocket.
3. **Errors**: Rate of failed requests. Include both explicit errors (5xx) and implicit errors (wrong responses, timeouts, retries).
4. **Saturation**: How full the system is. CPU utilization, memory usage, disk I/O, connection pool usage, Lambda concurrent executions vs reserved concurrency.

## CloudWatch Dashboards and Alarms

### Dashboard Design
- One dashboard per service with golden signals at the top.
- Include dependency health: downstream service latency, database connections, queue depth.
- Use CloudWatch Metrics Math for derived metrics: error rate = errors / (errors + successes) * 100.
- Standardize dashboard layouts across services for consistency.

### Alarm Configuration
- Alarm on symptoms, not causes. Alert on "error rate > 1%" not "CPU > 80%".
- Use composite alarms to reduce noise: only alert when multiple conditions are true simultaneously.
- Set appropriate evaluation periods: avoid single-datapoint alarms that fire on transient spikes. Use `3 out of 5 datapoints` for stability.
- Define alarm actions: SNS notification, Lambda remediation, OpsCenter item creation.
- Severity tiers: P1 (page on-call), P2 (Slack alert, fix within hours), P3 (ticket, fix within sprint).

## X-Ray Distributed Tracing

- Enable X-Ray tracing on API Gateway, Lambda, ECS, and SQS.
- Use the X-Ray SDK to create custom subsegments for application logic.
- Add annotations (indexed, searchable) for key dimensions: `customerId`, `orderStatus`, `region`.
- Add metadata (not indexed) for debugging detail: request/response bodies, query parameters.
- Use X-Ray groups and filter expressions to find traces matching specific criteria: `service("payment-service") AND responsetime > 3`.

## CloudWatch Logs Insights Queries

Useful query patterns for operational troubleshooting:

```
# Error rate over time
filter @message like /ERROR/
| stats count() as errors by bin(5m)

# Slowest requests
filter @duration > 1000
| sort @duration desc
| limit 20

# Request count by status code
parse @message '"statusCode":*,' as statusCode
| stats count() by statusCode

# Cold start impact (Lambda)
filter @type = "REPORT"
| stats avg(@duration), max(@duration), avg(@initDuration) by bin(10m)
```

## Anomaly Detection

- CloudWatch Anomaly Detection uses ML to establish a baseline and alert on deviations.
- Enable on latency and error rate metrics that have stable patterns.
- Set the detection band width based on acceptable variance (2 standard deviations is a common starting point).
- Combine anomaly detection with static thresholds: anomaly detection catches gradual drift, static thresholds catch acute failures.

## Log Aggregation and Retention

- Route all logs to CloudWatch Logs with consistent naming: `/aws/lambda/{service}`, `/ecs/{cluster}/{service}`.
- Set retention policies per log group: 30 days for development, 90 days for staging, 1-3 years for production (or per compliance requirements).
- Archive to S3 for long-term retention and cost optimization. Use Glacier for logs older than 90 days.
- Consider CloudWatch cross-account log aggregation for multi-account setups.

## Synthetic Monitoring

- CloudWatch Synthetics canaries: run scripted checks on a schedule (every 1-5 minutes).
- Test critical user journeys: login, place order, view dashboard.
- Canaries run from AWS-managed infrastructure; detect issues before real users report them.
- Alert on canary failure with P1 severity; it means the user-facing path is broken.
- Use visual monitoring (screenshot comparison) for UI-heavy applications.
