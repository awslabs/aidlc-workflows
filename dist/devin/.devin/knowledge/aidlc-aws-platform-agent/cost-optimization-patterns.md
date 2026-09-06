# AWS Cost Optimization Patterns

## Purpose
Practical strategies for reducing AWS costs without sacrificing reliability or performance. Cost optimization is an ongoing discipline, not a one-time exercise.

## Compute: Rightsizing

### Process
1. Enable AWS Compute Optimizer (free, account-wide)
2. Review recommendations after 14 days of data collection
3. Identify over-provisioned instances (CPU < 20%, memory < 30% on average)
4. Resize in non-production first, then production during maintenance windows

### Common Findings
- Most teams over-provision by 30-50% at initial deployment
- Graviton (ARM) instances offer 20-40% better price-performance than x86 equivalents
- Consider burstable instances (t3/t4g) for workloads with variable CPU patterns

### Action Items
- Review instance utilization monthly via Cost Explorer or Compute Optimizer
- Set CloudWatch alarms for sustained low utilization (< 10% CPU for 7 days)
- Automate non-production instance scheduling (stop at 7 PM, start at 7 AM)

## Pricing Models

### On-Demand
- No commitment, highest per-hour cost
- Use for: unpredictable workloads, short-term spikes, new applications before usage patterns are established

### Savings Plans
- 1-year or 3-year commitment to a consistent amount of compute usage (measured in $/hour)
- **Compute Savings Plans**: Apply across EC2, Lambda, and Fargate (most flexible)
- **EC2 Instance Savings Plans**: Locked to instance family and region (deeper discount)
- Typical savings: 30-40% (1-year, no upfront) to 60-72% (3-year, all upfront)
- Start with Compute Savings Plans covering your baseline usage; use On-Demand for peaks

### Reserved Instances
- 1-year or 3-year commitment to specific instance type, region, and OS
- Less flexible than Savings Plans; similar discounts
- Consider only for steady-state workloads with very predictable instance types

### Spot Instances
- Up to 90% discount, but can be interrupted with 2-minute notice
- Use for: batch processing, CI/CD workers, data processing, stateless web servers behind auto-scaling groups
- Best practice: Diversify across multiple instance types and AZs to reduce interruption frequency
- Never use for: databases, single-instance workloads, or anything that cannot tolerate interruption

## Storage: S3 Lifecycle Policies

### Recommended Transitions
```
S3 Standard (active data, frequent access)
  → 30 days → S3 Intelligent-Tiering (variable access patterns)
  → 90 days → S3 Infrequent Access (known infrequent access)
  → 180 days → S3 Glacier Instant Retrieval (rare access, millisecond retrieval)
  → 365 days → S3 Glacier Deep Archive (archive, 12-hour retrieval)
```

### Rules
- Analyze access patterns with S3 Storage Lens before setting lifecycle rules
- Use S3 Intelligent-Tiering for unpredictable access patterns (automates transitions)
- Delete incomplete multipart uploads after 7 days (they accumulate silently)
- Enable S3 analytics to validate lifecycle policy effectiveness

### Quick Wins
- Delete old CloudTrail logs in S3 after compliance retention period
- Transition ELB/CloudFront access logs to Glacier after 90 days
- Compress objects before upload (gzip, zstd) — reduces storage and transfer costs

## Database: DynamoDB

### On-Demand vs Provisioned Capacity
| Factor | On-Demand | Provisioned |
|--------|-----------|-------------|
| Traffic pattern | Unpredictable, spiky | Steady, predictable |
| Pricing | Per-request | Per-capacity-unit-hour |
| Scaling | Instant (within limits) | Auto-scaling with lag |
| Best for | New tables, dev/test, event-driven | Production with known patterns |

### Cost Reduction Strategies
- Use provisioned capacity with auto-scaling for steady-state production tables
- Enable reserved capacity for predictable base load (additional discount on provisioned)
- Use TTL to automatically delete expired items (no write cost for TTL deletions)
- Design partition keys to distribute load evenly (hot partitions waste provisioned capacity)

## Lambda Cost Optimization

### Memory and Duration
- Lambda pricing = (memory allocated) x (execution duration) x (number of invocations)
- More memory also means more CPU — increasing memory can reduce duration and total cost
- Use AWS Lambda Power Tuning to find the optimal memory setting per function

### Strategies
- Minimize cold starts: keep deployment packages small, use layers for shared dependencies
- Use ARM/Graviton runtime (`arm64`) for 20% cost reduction and better performance
- Set appropriate timeout (not maximum 15 minutes for a function that runs in 3 seconds)
- Batch process SQS messages (receive up to 10 messages per invocation)
- Avoid provisioned concurrency unless latency requirements demand it (it is expensive)

### Invocation Reduction
- Use SQS batch window to accumulate messages before invoking Lambda
- Use EventBridge rules with content filtering to invoke only for relevant events
- Cache results in DynamoDB or ElastiCache to reduce redundant compute

## Cost Allocation Tagging

### Required Tags
Define and enforce a minimum tag set across all resources:
```
Project:     project-name
Environment: dev | staging | prod
Team:        team-name
CostCenter:  cost-center-code
Service:     service-name
```

### Enforcement
- Use AWS Organizations SCPs to deny resource creation without required tags
- Use CDK Aspects to add tags automatically and validate tag presence
- Enable cost allocation tags in Billing console (tags must be activated to appear in Cost Explorer)

## Cost Explorer Queries

### Monthly Cost Reviews
1. **Cost by service**: Identify top 5 cost drivers
2. **Cost by tag (team)**: Attribute costs to responsible teams
3. **Daily cost trend**: Detect unexpected cost spikes
4. **Cost by usage type**: Identify specific resources (data transfer, API calls, storage)

### Anomaly Detection
- Enable AWS Cost Anomaly Detection for automatic notification of unexpected cost increases
- Set budget alerts at 50%, 80%, and 100% of expected monthly spend
- Create separate budgets per environment (production vs non-production)

### Monthly Cost Optimization Checklist
- [ ] Review Compute Optimizer recommendations for rightsizing
- [ ] Check for idle resources (unused EIPs, unattached EBS volumes, idle load balancers)
- [ ] Review Savings Plans utilization and coverage
- [ ] Check S3 storage distribution across tiers
- [ ] Review data transfer costs (cross-region, internet egress)
- [ ] Verify non-production environments are scheduled for off-hours shutdown
- [ ] Review Lambda function memory settings with Power Tuning results
