# SLO, SLI, and Error Budget Patterns

Defining and managing service level objectives using Google SRE principles adapted for AWS environments.

## Key Terminology

- **SLI (Service Level Indicator)**: A quantitative measure of a specific aspect of service performance. Example: "the proportion of requests served in under 200ms."
- **SLO (Service Level Objective)**: A target value or range for an SLI. Example: "99.9% of requests will be served in under 200ms, measured over a 30-day rolling window."
- **SLA (Service Level Agreement)**: A contractual commitment to a customer, with consequences for breach. SLAs are looser than SLOs to provide a safety margin.
- **Error Budget**: The allowed amount of unreliability. If SLO is 99.9%, the error budget is 0.1% (approximately 43 minutes of downtime per 30 days).

## SLI Definition

Choose SLIs that reflect the user's experience, not internal system metrics.

### Common SLI Types

| SLI Type | Definition | Measurement |
|----------|-----------|-------------|
| **Availability** | Proportion of successful requests | `(successful requests / total requests) * 100` |
| **Latency** | Proportion of requests faster than threshold | `(requests < 200ms / total requests) * 100` |
| **Throughput** | Requests processed per unit time | CloudWatch metric: `RequestCount` per minute |
| **Error Rate** | Proportion of requests returning errors | `(5xx responses / total responses) * 100` |
| **Freshness** | Proportion of data updated within threshold | Time since last successful sync vs target |
| **Correctness** | Proportion of responses with correct output | Validated against ground truth or invariants |

### SLI Specification Best Practices
- Measure at the point closest to the user (API Gateway, ALB) not at the application.
- Exclude health check traffic and synthetic monitoring from SLI calculations.
- Use CloudWatch Metrics Math or CloudWatch Contributor Insights for SLI computation.
- Define SLIs per critical user journey, not per API endpoint.

## SLO Target Setting

### Process
1. Measure current performance for 2-4 weeks to establish a baseline.
2. Set the SLO slightly below the observed baseline (if p99 latency is consistently 150ms, set SLO at 200ms).
3. Validate with stakeholders that the target aligns with user expectations and business requirements.
4. Start conservative; tighten SLOs as reliability improves and tooling matures.

### Guidelines
- Do not set SLOs at 100%. It is impossible to achieve and eliminates the error budget for deployments and improvements.
- Typical SLO targets: 99.9% for customer-facing services, 99.5% for internal services, 99% for batch processing.
- Use a 30-day rolling window, not calendar month, to avoid reset-day gaming.
- Document the measurement methodology alongside the target.

## Error Budgets

The error budget is the inverse of the SLO: `error budget = 1 - SLO target`.

### Error Budget Policy
Define what happens when the error budget is consumed:

| Budget Status | Implication | Action |
|--------------|-------------|--------|
| > 50% remaining | Healthy | Normal feature development velocity |
| 25-50% remaining | Caution | Increase deployment monitoring, review recent incidents |
| < 25% remaining | At risk | Slow deployments, prioritize reliability work |
| Exhausted (0%) | Frozen | Halt feature releases, all engineering effort on reliability |

Error budgets create a shared language between product and engineering: "We can afford to ship this risky feature because we have budget, or we cannot because the budget is low."

## Burn Rate Alerting

Instead of alerting when the SLO is breached (too late), alert based on the rate at which the error budget is being consumed.

- **Burn rate**: How fast the error budget is being consumed relative to the window. A burn rate of 1.0 means the budget will be exactly exhausted at the end of the window.
- **Fast burn (SEV1)**: Burn rate > 14x over 1 hour and > 14x over 5 minutes. The budget will be consumed in ~2 hours. Page immediately.
- **Medium burn (SEV2)**: Burn rate > 6x over 6 hours and > 6x over 30 minutes. The budget will be consumed in ~5 days. Alert during business hours.
- **Slow burn (SEV3)**: Burn rate > 3x over 24 hours and > 3x over 6 hours. The budget will be consumed in ~10 days. Create a ticket.

Use multi-window, multi-burn-rate alerting (Google SRE workbook approach) to balance sensitivity and specificity.

## SLO-Based Decision Making

- **Should we deploy?** Check error budget. If healthy, deploy with normal confidence. If low, add extra validation or delay.
- **Should we invest in reliability?** If the SLO is consistently met with budget to spare, invest in features. If the budget is frequently exhausted, invest in reliability.
- **Should we adopt a new dependency?** Evaluate the dependency's SLO. Your service's SLO cannot exceed its least reliable critical dependency.
- **How much testing is enough?** Test until you are confident the deployment will not consume more than a defined fraction of the error budget.

## Toil Measurement

Toil is repetitive, automatable operational work that scales with service size.

- Track time spent on toil weekly: manual deployments, alert response, config changes, scaling actions.
- Target: toil should consume no more than 50% of an operations engineer's time (Google SRE standard).
- Prioritize automation of the most time-consuming toil tasks.
- Report toil reduction as a team metric alongside SLO compliance.

## SLO Dashboards

Build a dashboard per service showing:
- Current SLO compliance (percentage) vs target, with the measurement window
- Error budget remaining (absolute and percentage)
- Burn rate trend over the last 7 and 30 days
- SLI time series (latency percentiles, error rate, availability)
- Recent incidents that consumed error budget, with links to postmortems

Use CloudWatch dashboards with Metrics Math, or export to Grafana for richer visualisation.
