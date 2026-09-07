# Deployment Strategies

Patterns for releasing software safely with minimal risk to users and the ability to roll back quickly.

## Blue/Green Deployment

**How it works**: Maintain two identical environments (blue = current, green = new). Deploy the new version to green. Switch traffic from blue to green at the load balancer or DNS level. Keep blue running as an instant rollback target.

**AWS Implementation**:
- ECS: Use CodeDeploy with `ECS` deployment type. Two target groups on an ALB; CodeDeploy shifts traffic.
- Lambda: Use aliases with weighted traffic shifting (`AWS::Lambda::Alias` with `RoutingConfig`).
- Elastic Beanstalk: Swap environment URLs.

**Advantages**: Instant rollback (repoint to blue), full environment validation before switch.
**Drawbacks**: Double infrastructure cost during deployment window. Database schema must be backward-compatible.

## Canary Releases

**How it works**: Route a small percentage of traffic (1-5%) to the new version. Monitor error rates, latency, and business metrics. Gradually increase traffic if healthy; roll back if anomalies are detected.

**AWS Implementation**:
- CodeDeploy with Lambda or ECS: Built-in canary configurations (`Canary10Percent5Minutes`, `Linear10PercentEvery1Minute`).
- API Gateway: Canary release on stage with percentage-based traffic split.
- CloudWatch alarms trigger automatic rollback on metric breaches.

**Advantages**: Limits blast radius. Detects issues with real traffic before full rollout.
**Drawbacks**: Requires robust monitoring. Stateful services need careful handling.

## Rolling Updates

**How it works**: Replace instances/tasks in batches. New version replaces a subset while the rest continue serving. Repeat until all instances run the new version.

**AWS Implementation**:
- ECS: Default deployment strategy. Configure `minimumHealthyPercent` and `maximumPercent`.
- EC2 Auto Scaling: Rolling update policy with `MinInstancesInService`.

**Advantages**: No extra infrastructure cost. Gradual rollout.
**Drawbacks**: Mixed versions during deployment (ensure backward compatibility). Slower rollback (redeploy the previous version).

## A/B Testing

**How it works**: Route specific user segments to different versions based on attributes (user ID, region, account type). Measure business outcomes (conversion, engagement) to decide which version wins.

**Distinction from canary**: A/B testing serves different experiences intentionally for experimentation; canary is a deployment safety mechanism.

**AWS Implementation**: CloudWatch Evidently for feature experiments with statistical analysis. CloudFront + Lambda@Edge for routing based on cookies or headers.

## Feature Flags

**How it works**: Deploy code with features wrapped in conditional flags. Toggle features on/off without redeployment.

**AWS Implementation**:
- **AppConfig**: Feature flags with validation, gradual rollout, and automatic rollback.
- **CloudWatch Evidently**: Feature flags with built-in A/B testing and metric tracking.

**Best Practices**:
- Use feature flags for incomplete features merged to main (trunk-based development enabler).
- Clean up flags after full rollout; stale flags become technical debt.
- Categorize flags: release flags (temporary), ops flags (kill switches), experiment flags (A/B tests).
- Never put secrets or sensitive config in feature flags.

## Rollback Strategies

### Automated Rollback
- Configure CloudWatch alarms on error rate, latency p99, and 5xx count.
- CodeDeploy automatically rolls back when alarms trigger during deployment.
- Lambda: Revert alias to the previous version instantly.
- ECS: CodeDeploy reroutes traffic back to the original target group.

### Manual Rollback
- Keep the previous artifact (Docker image, Lambda ZIP) tagged and deployable.
- Document the rollback procedure as a runbook: which commands, in what order, who approves.
- Practice rollbacks regularly; an untested rollback is not a rollback plan.

## Database Migration During Deployment

The hardest part of zero-downtime deployment is schema changes. Follow the **expand-contract** pattern:

1. **Expand**: Add new columns/tables/indexes. Do not remove or rename existing ones. Deploy application code that writes to both old and new schemas.
2. **Migrate**: Backfill data from old schema to new schema.
3. **Contract**: After all application versions use the new schema, remove old columns/tables in a later release.

Never run destructive schema changes (DROP COLUMN, rename) in the same deployment as the application change.

## Zero-Downtime Deployment Checklist

- [ ] Load balancer health checks configured with appropriate thresholds
- [ ] Connection draining enabled (deregistration delay: 30-120 seconds)
- [ ] Graceful shutdown handling in application (finish in-flight requests, close DB connections)
- [ ] Database schema changes are backward-compatible
- [ ] Rollback plan tested and documented
- [ ] Monitoring and alarms in place before deployment starts
- [ ] Pre-deployment smoke tests pass in staging

## Deployment Windows and Freeze Periods

- Define standard deployment windows (e.g., Tuesday-Thursday 10:00-16:00 local time) when the team is available to monitor.
- Enforce code freeze periods during high-traffic events (Black Friday, product launches) or compliance windows (end of fiscal quarter).
- Emergency hotfixes bypass freeze periods but require incident commander approval and post-deployment review.
- Automate freeze enforcement in the pipeline (reject deployments outside approved windows unless override flag is set).
