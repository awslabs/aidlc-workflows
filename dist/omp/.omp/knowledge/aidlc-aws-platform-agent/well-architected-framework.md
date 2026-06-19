# AWS Well-Architected Framework

## Purpose
A structured approach for evaluating architectures against AWS best practices across six pillars. Use this framework during architecture reviews, before production launches, and periodically for existing workloads.

## Six Pillars Overview

| Pillar | Focus | Key Metric |
|--------|-------|------------|
| Operational Excellence | Run and monitor systems effectively | Mean time to recovery (MTTR) |
| Security | Protect data, systems, and assets | Number of security findings |
| Reliability | Recover from failures, meet demand | Availability percentage (e.g., 99.9%) |
| Performance Efficiency | Use resources efficiently | Latency percentiles (p50, p95, p99) |
| Cost Optimization | Avoid unnecessary costs | Cost per transaction/user |
| Sustainability | Minimize environmental impact | Resources per unit of work |

## Pillar 1: Operational Excellence

### Key Questions
- How do you determine what your priorities are?
- How do you design your workload to understand its state?
- How do you reduce defects, ease remediation, and improve flow?
- How do you evolve your operations?

### Best Practices
- **Infrastructure as code**: All resources defined in CDK/CloudFormation, version controlled
- **Observability**: Structured logging, distributed tracing (X-Ray), custom metrics (CloudWatch)
- **Runbooks and playbooks**: Documented procedures for common operational tasks and incident response
- **Deployment automation**: CI/CD pipelines with automated testing, canary deployments, automatic rollback
- **Game days**: Regularly simulate failures to validate operational readiness

### Common Anti-Patterns
- Manual infrastructure changes via the console
- Logging only errors (missing context for debugging)
- No runbooks for common failure modes
- Deploying on Friday afternoons without monitoring

## Pillar 2: Security

### Key Questions
- How do you manage identities and permissions?
- How do you detect and investigate security events?
- How do you protect your network, compute, and data?

### Best Practices
- **Identity**: Use IAM roles (not long-lived keys), enforce MFA, apply least-privilege policies
- **Detection**: Enable CloudTrail, GuardDuty, Security Hub, and Config rules
- **Data protection**: Encrypt at rest (KMS) and in transit (TLS 1.2+), classify data sensitivity
- **Network**: Use VPC with private subnets for databases/compute, security groups as firewalls, VPC endpoints for AWS services
- **Incident response**: Pre-provisioned forensic tools, automated containment playbooks

### Common Anti-Patterns
- Wildcard IAM policies (`Action: "*"`, `Resource: "*"`)
- Secrets in environment variables or code (use Secrets Manager or Parameter Store)
- Public S3 buckets or security groups open to 0.0.0.0/0
- No encryption on databases or message queues

## Pillar 3: Reliability

### Key Questions
- How do you manage service quotas and constraints?
- How does your workload adapt to changes in demand?
- How do you design interactions to prevent failures?
- How do you test reliability?

### Best Practices
- **Multi-AZ**: Deploy across at least 2 Availability Zones for all critical components
- **Auto scaling**: Configure for both scale-out and scale-in with appropriate cooldowns
- **Fault isolation**: Use bulkheads, circuit breakers, and timeouts for all remote calls
- **Backup and recovery**: Automated backups with tested restore procedures, define RPO/RTO
- **Chaos engineering**: Inject failures (instance termination, AZ loss, latency) to verify resilience

### Common Anti-Patterns
- Single-AZ deployments for production workloads
- No health checks on load balancer targets
- Untested backup restores (backups exist but recovery has never been validated)
- Hard dependencies on services without fallback behavior

## Pillar 4: Performance Efficiency

### Key Questions
- How do you select the best performing architecture?
- How do you select and manage your compute, storage, and database solutions?
- How do you monitor to ensure performance?

### Best Practices
- **Right-size resources**: Start small, measure, and adjust — do not guess capacity
- **Caching**: CloudFront for static content, ElastiCache for application data, API Gateway caching
- **Database selection**: Match engine to access pattern (relational for joins, DynamoDB for key-value, OpenSearch for full-text)
- **Async processing**: Offload long-running tasks to SQS/Lambda, keep API response times fast
- **Load testing**: Establish baseline performance and test at 2-3x expected peak load

### Common Anti-Patterns
- Using RDS for simple key-value lookups (DynamoDB is more efficient)
- Over-provisioned instances running at 5% utilization
- Synchronous processing of tasks that users do not need to wait for
- No performance baseline — cannot detect degradation without a reference point

## Pillar 5: Cost Optimization

### Key Questions
- How do you implement cloud financial management?
- How do you govern usage and manage demand/supply?
- How do you evaluate new services for cost impact?

### Best Practices
- **Visibility**: Enable Cost Explorer, set up budgets and alerts, use cost allocation tags
- **Right-sizing**: Use Compute Optimizer recommendations, review utilization monthly
- **Pricing models**: Savings Plans for steady-state compute, Spot for fault-tolerant workloads, On-Demand for variable/unpredictable
- **Storage lifecycle**: S3 lifecycle policies to transition to Infrequent Access / Glacier
- **Eliminate waste**: Stop unused instances, delete unattached EBS volumes, remove unused Elastic IPs

### Common Anti-Patterns
- No cost allocation tagging (cannot attribute costs to teams or products)
- Running development environments 24/7 (schedule stop outside business hours)
- Paying On-Demand prices for predictable workloads (use Savings Plans)
- Unused Elastic IPs, idle load balancers, orphaned snapshots

## Pillar 6: Sustainability

### Key Questions
- How do you select regions to minimize carbon impact?
- How do you minimize resources required for your workload?

### Best Practices
- **Efficient resources**: Use Graviton (ARM) processors — better performance per watt
- **Scale to demand**: Auto-scale down during low traffic, schedule non-production shutdowns
- **Managed services**: Serverless and managed services optimize resource utilization across customers
- **Data management**: Delete unnecessary data, use appropriate storage tiers, compress data

## Well-Architected Review Process

### When to Conduct
- Before production launch (mandatory)
- Quarterly for critical workloads
- After significant architectural changes
- When performance or cost issues arise

### Steps
1. Select the workload scope (one application or service)
2. Walk through each pillar's questions with the team
3. Identify high-risk issues (HRIs) and improvement opportunities
4. Prioritize remediation by risk and effort
5. Create action items with owners and deadlines
6. Re-review after remediation to verify closure
