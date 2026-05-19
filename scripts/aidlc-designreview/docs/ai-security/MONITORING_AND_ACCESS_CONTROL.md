<!-- markdownlint-disable MD041 MD060 -->

Copyright (c) 2026 AIDLC Design Reviewer Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->

# AI Model Monitoring and Access Control

**Last Updated**: 2026-03-19
**Status**: Operational Security Documentation
**Compliance**: GenAI Security Requirements

---

## Overview

This document describes monitoring, access control, and audit logging for Amazon Bedrock model invocations in the AIDLC Design Reviewer application.

---

## AWS Shared Responsibility Model

**Reference**: [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/)

### Responsibility Summary for Monitoring and Access Control

| Security Area             | AWS Responsibility                                                   | Customer Responsibility (AIDLC Users)                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IAM Service**           | Operate IAM service infrastructure, policy enforcement engine        | ✅ Define and maintain IAM policies<br/>✅ Assign roles and permissions<br/>⚠️ Enable MFA for console access<br/>⚠️ Rotate credentials regularly    |
| **CloudWatch Service**    | Operate CloudWatch infrastructure, log storage, metrics collection   | ⚠️ Configure CloudWatch log groups<br/>⚠️ Define log retention policies<br/>⚠️ Create alarms and dashboards<br/>⚠️ Monitor and respond to alerts    |
| **CloudTrail Service**    | Operate CloudTrail infrastructure, API logging                       | ⚠️ Enable CloudTrail trails<br/>⚠️ Configure S3 bucket for log storage<br/>⚠️ Enable log file validation<br/>⚠️ Review and analyze audit logs       |
| **Amazon Bedrock API**    | API availability, authentication, rate limiting                      | ✅ Call API with valid credentials<br/>✅ Handle rate limit errors gracefully<br/>⚠️ Monitor for unauthorized usage                                 |
| **Application Logging**   | N/A (customer application)                                           | ✅ Implement application-level logging<br/>✅ Scrub credentials from logs<br/>✅ Secure log file permissions                                        |
| **Incident Response**     | Respond to AWS infrastructure incidents                              | ❌ Define incident response procedures<br/>⚠️ Monitor for suspicious activity<br/>⚠️ Investigate and remediate issues                               |

**Legend**:

- ✅ Implemented in AIDLC Design Reviewer application
- ⚠️ Requires customer configuration/action
- ❌ Customer responsibility (not implemented by application)

**Key Principle**: AWS operates the monitoring services (CloudWatch, CloudTrail), but **customers must enable, configure, and actively monitor** these services for their Amazon Bedrock usage.

**See Also**: [AWS_BEDROCK_SECURITY_GUIDELINES.md](../security/AWS_BEDROCK_SECURITY_GUIDELINES.md) for complete shared responsibility model.

---

## Access Control

### IAM Role-Based Access

**Principle**: Least-privilege access to Amazon Bedrock resources

#### Application Role (Runtime)

**Role Name**: `aidlc-design-reviewer-app-role`

**IAM Policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockModelAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-6-v1",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "us-east-1"
        }
      }
    },
    {
      "Sid": "GuardrailAccess",
      "Effect": "Allow",
      "Action": [
        "bedrock:ApplyGuardrail",
        "bedrock:GetGuardrail"
      ],
      "Resource": "arn:aws:bedrock:us-east-1:ACCOUNT-ID:guardrail/*"
    },
    {
      "Sid": "CloudWatchLogging",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:ACCOUNT-ID:log-group:/aws/aidlc/design-reviewer:*"
    }
  ]
}
```text
**Assigned To**:

- EC2 instance profile (if running on EC2)
- ECS task role (if running in containers)
- Lambda execution role (if serverless)
- Developer IAM users (for testing)

#### Administrator Role

**Role Name**: `aidlc-bedrock-admin-role`

**Additional Permissions**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GuardrailManagement",
      "Effect": "Allow",
      "Action": [
        "bedrock:CreateGuardrail",
        "bedrock:UpdateGuardrail",
        "bedrock:DeleteGuardrail"
      ],
      "Resource": "arn:aws:bedrock:*:ACCOUNT_ID:guardrail/*"
    },
    {
      "Sid": "ListGuardrails",
      "Effect": "Allow",
      "Action": [
        "bedrock:ListGuardrails"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": ["us-east-1", "us-west-2"]
        }
      }
    }
  ]
}
```text
**⚠️ IMPORTANT - Replace Placeholders**:

- `ACCOUNT_ID`: Your AWS account ID (e.g., `123456789012`)

**Least Privilege Notes**:

- Guardrail ARN pattern: `arn:aws:bedrock:REGION:ACCOUNT_ID:guardrail/GUARDRAIL_ID`
- Use specific guardrail IDs when possible: `arn:aws:bedrock:*:ACCOUNT_ID:guardrail/abc123`
- **ListGuardrails**: Requires wildcard resource (`"Resource": "*"`) per AWS API requirements, BUT is scoped to specific regions (`us-east-1`, `us-west-2`) using `aws:RequestedRegion` condition
- Region wildcards in Guardrail resource ARNs (`arn:aws:bedrock:*:ACCOUNT_ID:guardrail/*`) are acceptable when combined with regional condition keys

**See Also**: [AWS IAM Best Practices - Grant Least Privilege](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege)

**Assigned To**:

- Security team
- DevOps engineers
- Compliance auditors (read-only subset)

#### Auditor Role (Read-Only)

**Role Name**: `aidlc-bedrock-auditor-role`

**IAM Policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockReadOnly",
      "Effect": "Allow",
      "Action": [
        "bedrock:GetGuardrail"
      ],
      "Resource": "arn:aws:bedrock:*:ACCOUNT_ID:guardrail/*"
    },
    {
      "Sid": "BedrockList",
      "Effect": "Allow",
      "Action": [
        "bedrock:ListGuardrails"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": ["us-east-1", "us-west-2"]
        }
      }
    },
    {
      "Sid": "CloudWatchLogsReadOnly",
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents"
      ],
      "Resource": [
        "arn:aws:logs:*:ACCOUNT_ID:log-group:/aws/bedrock/*",
        "arn:aws:logs:*:ACCOUNT_ID:log-group:aidlc-*"
      ]
    },
    {
      "Sid": "CloudWatchMetricsReadOnly",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData",
        "cloudwatch:GetMetricStatistics"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "cloudwatch:namespace": "AWS/Bedrock"
        }
      }
    }
  ]
}
```text
**⚠️ IMPORTANT - Replace Placeholders**:

- `ACCOUNT_ID`: Your AWS account ID (e.g., `123456789012`)

**Least Privilege Notes**:

- **CloudWatch Logs**: Scoped to Amazon Bedrock and AIDLC log groups using ARN patterns
- **CloudWatch Metrics**: Scoped to Amazon Bedrock namespace via condition key
- **ListGuardrails**: Requires wildcard resource (`"Resource": "*"`) per AWS API requirements, BUT is scoped to specific regions using `aws:RequestedRegion` condition to prevent cross-region listing
- **Read-Only**: All permissions are read-only; no modification capabilities

**See Also**: [AWS IAM Best Practices - Grant Least Privilege](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege)

**Assigned To**:

- Compliance team
- Security auditors
- Management (for dashboards)

---

## Resource-Level Permissions

### Model-Specific Access

**Restriction**: Application can only invoke approved Claude models

**Implementation**:

- IAM policy lists specific model ARNs (no wildcards)
- Cross-region inference models specified explicitly
- Prevents unauthorized model usage

**Benefit**: Cost control and compliance (only approved models)

### Regional Restrictions

**Enforcement**: `aws:RequestedRegion` condition in IAM policy

**Allowed Regions**:

- `us-east-1` (primary)

**Benefit**: Data residency compliance and cost control

---

## Monitoring and Logging

### CloudWatch Metrics

#### Amazon Bedrock Standard Metrics

**Namespace**: `AWS/Bedrock`

**Metrics Tracked**:

| Metric                     | Description                | Alarm Threshold            |
| ---------------------------- | ---------------------------- | ---------------------------- |
| `Invocations`              | Total model invocations    | N/A (informational)        |
| `InvocationLatency`        | Time to process requests   | > 30 seconds               |
| `InvocationClientErrors`   | 4xx errors                 | > 10/minute                |
| `InvocationServerErrors`   | 5xx errors                 | > 1/minute                 |
| `InputTokens`              | Tokens sent to model       | > 1M/hour (cost alert)     |
| `OutputTokens`             | Tokens generated           | > 500K/hour (cost alert)   |

**Dimensions**:

- `ModelId` (per model tracking)
- `Region` (us-east-1)

#### Custom Application Metrics

**Namespace**: `AIDLC/DesignReviewer`

**Custom Metrics**:

| Metric                   | Unit      | Description                      |
| -------------------------- | ----------- | ---------------------------------- |
| `ReviewsCompleted`       | Count     | Successful design reviews        |
| `ReviewsFailed`          | Count     | Failed reviews (errors)          |
| `AverageCostPerReview`   | USD       | Cost per review session          |
| `GuardrailBlocks`        | Count     | Requests blocked by guardrails   |
| `AgentExecutionTime`     | Seconds   | Per-agent execution time         |

**Publishing**:

```python
import boto3

cloudwatch = boto3.client('cloudwatch', region_name='us-east-1')

cloudwatch.put_metric_data(
    Namespace='AIDLC/DesignReviewer',
    MetricData=[
        {
            'MetricName': 'ReviewsCompleted',
            'Value': 1,
            'Unit': 'Count',
            'Dimensions': [
                {'Name': 'Environment', 'Value': 'production'}
            ]
        }
    ]
)
```text
### CloudWatch Alarms

#### Critical Alarms

**High Error Rate**:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "AIDLC-Bedrock-High-Error-Rate" \
  --alarm-description "Alert when Amazon Bedrock error rate exceeds 5%" \
  --metric-name InvocationClientErrors \
  --namespace AWS/Bedrock \
  --statistic Sum \
  --period 300 \
  --evaluation-periods 2 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-1:ACCOUNT-ID:aidlc-alerts
```text
**High Cost**:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "AIDLC-Bedrock-High-Cost" \
  --alarm-description "Alert when hourly cost exceeds $10" \
  --metric-name InputTokens \
  --namespace AWS/Bedrock \
  --statistic Sum \
  --period 3600 \
  --threshold 3000000 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-1:ACCOUNT-ID:aidlc-alerts
```text
**Guardrail Blocks Spike**:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "AIDLC-Guardrail-Blocks-Spike" \
  --alarm-description "Alert when guardrails block >20 requests in 5 minutes" \
  --metric-name GuardrailBlocked \
  --namespace AWS/Bedrock \
  --statistic Sum \
  --period 300 \
  --threshold 20 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-1:ACCOUNT-ID:aidlc-alerts
```text
### CloudWatch Logs

#### Application Logs

**Log Group**: `/aws/aidlc/design-reviewer`

**Log Structure**:

```json
{
  "timestamp": "2026-03-19T15:30:45.123Z",
  "level": "INFO",
  "message": "Agent 'critique' completed in 12.34s",
  "model_id": "us.anthropic.claude-sonnet-4-6",
  "input_tokens": 45000,
  "output_tokens": 8000,
  "agent_name": "critique",
  "review_id": "rev-20260319-153045",
  "cost_usd": 0.25
}
```text
**Retention**: 90 days (configurable)

**Log Insights Queries**:

**Query 1 - Average Cost Per Review**:

```sql
fields @timestamp, cost_usd
| stats avg(cost_usd) as avg_cost, sum(cost_usd) as total_cost, count(*) as reviews
| sort @timestamp desc
```text
**Query 2 - Model Usage Distribution**:

```sql
fields model_id
| stats count(*) as invocations by model_id
| sort invocations desc
```text
**Query 3 - Slow Reviews (>30s)**:

```sql
fields @timestamp, agent_name, review_id, execution_time
| filter execution_time > 30
| sort execution_time desc
```text
#### Amazon Bedrock Logs (Guardrail)

**Log Group**: `/aws/bedrock/guardrails/aidlc-design-reviewer`

**Logged Events**:

- Blocked inputs (content policy violations)
- Blocked outputs (harmful content detected)
- PII redactions (anonymization events)
- Denied topics triggered

**Retention**: 365 days (compliance requirement)

---

## Audit Trail

### Request Tracing

**Trace ID Format**: `rev-YYYYMMDD-HHMMSS-{UUID}`

**Logged Information**:

- Request timestamp
- User/role making request
- Model invoked
- Token counts (input/output)
- Execution time
- Cost incurred
- Guardrail interventions (if any)
- Final status (success/failure)

**Use Case**: Investigate cost anomalies, debug issues, compliance audits

### Access Logging

**CloudTrail Integration**: All API calls to Amazon Bedrock logged

**Logged Actions**:

- `InvokeModel` - Every model invocation
- `ApplyGuardrail` - Guardrail checks
- `GetGuardrail` - Guardrail configuration reads

**CloudTrail Query Example**:

```bash
# Find all Bedrock API calls in last hour
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=InvokeModel \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --max-results 50
```text
---

## Dashboards

### CloudWatch Dashboard

**Dashboard Name**: `AIDLC-Design-Reviewer-Operations`

**Widgets**:

1. **Model Invocations** (line chart)
   - Metric: `AWS/Bedrock` → `Invocations`
   - Period: 5 minutes
   - Stat: Sum

2. **Error Rate** (line chart)
   - Metrics: `InvocationClientErrors`, `InvocationServerErrors`
   - Period: 5 minutes
   - Stat: Sum

3. **Token Usage** (stacked area chart)
   - Metrics: `InputTokens`, `OutputTokens`
   - Period: 1 hour
   - Stat: Sum

4. **Cost Estimate** (single value)
   - Custom metric: `AverageCostPerReview`
   - Stat: Average (last hour)

5. **Guardrail Activity** (bar chart)
   - Metric: `GuardrailBlocked`
   - Period: 1 hour
   - Stat: Sum

6. **Latency** (line chart)
   - Metric: `InvocationLatency`
   - Period: 5 minutes
   - Stat: Average, P95, P99

**Dashboard JSON**: See `docs/monitoring/cloudwatch-dashboard.json`

### Grafana Dashboard (Optional)

**Data Source**: CloudWatch

**Panels**:

- Real-time model invocations
- Cost tracking over time
- Agent performance comparison
- Error rate trends
- Guardrail effectiveness

**Import**: See `docs/monitoring/grafana-dashboard.json`

---

## Rate Limiting

### Amazon Bedrock Quotas

**Default Quotas** (per account, per region):

| Model               | Quota Type            | Limit   |
| --------------------- | ----------------------- | --------- |
| Claude Opus 4.6     | Requests per minute   | 20      |
| Claude Sonnet 4.6   | Requests per minute   | 100     |
| Claude Haiku 4.5    | Requests per minute   | 200     |

**Token Limits**:

- Input: 200,000 tokens per request
- Output: 65,536 tokens per request

### Quota Increase Requests

**Process**:

1. Navigate to AWS Service Quotas console
2. Select Amazon Bedrock
3. Request quota increase
4. Provide justification (e.g., "100 design reviews/day")

**Approval Time**: 1-3 business days

### Application-Level Rate Limiting

**Current Implementation**: Backoff retry with exponential delay

**Configuration** (in `retry.py`):

```python
@backoff.on_exception(
    backoff.expo,
    Exception,
    max_tries=4,
    base=2,  # 2s, 4s, 8s delays
    giveup=lambda e: not is_retryable(e)
)
```text
**Future Enhancement**: Implement token bucket algorithm for proactive rate limiting

---

## Security Monitoring

### Anomaly Detection

**CloudWatch Anomaly Detection**: Enabled for key metrics

**Detected Anomalies**:

- Unusual spike in invocations (potential abuse)
- Cost anomalies (runaway usage)
- Error rate spikes (service degradation)
- Guardrail blocks surge (attack attempt)

**Alert Threshold**: 2 standard deviations from baseline

### Security Alerts

**Alert Channels**:

- Email: <security-team@example.com>
- Slack: #aidlc-security-alerts
- PagerDuty: On-call engineer (critical only)

**Escalation**:

1. Warning: CloudWatch alarm → Slack notification
2. Critical: Multiple alarms → PagerDuty + email
3. Incident: Manual escalation to security team

---

## Compliance Reporting

### Monthly Reports

**Generated Automatically**:

- Total model invocations
- Cost breakdown by model
- Error rates and availability
- Guardrail intervention statistics
- Access audit summary

**Distribution**: Security team, management, finance

**Format**: PDF report + CSV data export

### Quarterly Audits

**Audit Checklist**:

- [ ] Review IAM policies for least privilege
- [ ] Verify guardrail configuration matches documentation
- [ ] Check CloudWatch logs retention compliance
- [ ] Analyze cost trends and optimize
- [ ] Review access patterns for anomalies
- [ ] Update monitoring dashboards

**Performed By**: Security team + external auditor

---

## Incident Response

### Runbook: High Error Rate

**Trigger**: InvocationServerErrors > 10/minute

**Steps**:

1. Check Amazon Bedrock service health dashboard
2. Review recent guardrail configuration changes
3. Analyze CloudWatch logs for error patterns
4. Verify IAM permissions unchanged
5. Test with known-good design document
6. Escalate to AWS Support if service issue

### Runbook: Cost Spike

**Trigger**: Hourly cost exceeds $10

**Steps**:

1. Identify high-token reviews in CloudWatch logs
2. Check for runaway loops or retries
3. Verify no unauthorized access (CloudTrail)
4. Implement temporary rate limit if needed
5. Review and optimize prompts
6. Adjust cost alarms if legitimate usage

### Runbook: Guardrail Block Surge

**Trigger**: >20 blocked requests in 5 minutes

**Steps**:

1. Review blocked content in guardrail logs
2. Determine if attack attempt or legitimate content
3. Adjust guardrail sensitivity if false positives
4. Block IP/user if malicious activity
5. Document incident for security review
6. Update guardrail configuration if needed

---

## Access Review Process

### Quarterly Access Review

**Process**:

1. Export IAM users/roles with Amazon Bedrock permissions
2. Verify each user/role still requires access
3. Check for inactive accounts (no usage in 90 days)
4. Remove unnecessary permissions
5. Document changes

**Checklist**:

- [ ] Application roles: Verify least privilege
- [ ] Developer access: Remove departed employees
- [ ] Auditor access: Confirm read-only only
- [ ] Admin access: Verify MFA enabled

### Just-In-Time Access

**For Sensitive Operations**:

- Guardrail modification requires approval
- Temporary elevated access (max 4 hours)
- All actions logged in CloudTrail
- Approval via ticketing system

---

## References

- [Amazon Bedrock Monitoring](https://docs.aws.amazon.com/bedrock/latest/userguide/monitoring.html)
- [CloudWatch Metrics for Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/cloudwatch-metrics.html)
- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)

---

## Change Log

| Date         | Version   | Changes                                               |
| -------------- | ----------- | ------------------------------------------------------- |
| 2026-03-19   | 1.0       | Initial monitoring and access control documentation   |
