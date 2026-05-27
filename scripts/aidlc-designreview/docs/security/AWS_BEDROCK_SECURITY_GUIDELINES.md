<!-- markdownlint-disable MD041 MD051 MD060 -->

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

# AWS Amazon Bedrock Security Guidelines

**Last Updated**: 2026-03-19
**Version**: 1.0
**Status**: Production Guidelines

---

## Overview

This document provides comprehensive security guidelines for using Amazon Bedrock in the AIDLC Design Reviewer application, covering authentication, authorization, data protection, monitoring, and compliance.

---

## ⚠️ IAM Policy Examples Disclaimer

**CRITICAL**: All IAM policy examples in this document are **templates only** and MUST be customized for your specific AWS environment before use.

- ❌ **DO NOT** copy-paste examples directly into production
- ✅ **DO** replace ALL placeholder values (ACCOUNT-ID, REGION, KEY-ID, GUARDRAIL-ID, etc.)
- ✅ **DO** review and test policies in a non-production environment first
- ✅ **DO** follow AWS official guidance: [Grant least privilege - AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege)

**AWS customers are solely responsible for configuring IAM policies that meet their organization's security requirements.**

---

## Service Overview

**Amazon Bedrock** is a fully managed service that provides access to foundation models from leading AI companies through a single API.

**Models Used**:

- Anthropic Claude Opus 4.6
- Anthropic Claude Sonnet 4.6
- Anthropic Claude Haiku 4.5

**API Endpoint**: `https://bedrock-runtime.{region}.amazonaws.com`
**Service Category**: AI/ML, Generative AI
**Pricing Model**: Pay-per-use (tokens)

---

## AWS Shared Responsibility Model

**Reference**: [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/)

Amazon Bedrock, like all AWS services, operates under the **AWS Shared Responsibility Model**. AWS manages security **OF** the cloud, while customers (AIDLC Design Reviewer users) manage security **IN** the cloud.

### AWS Responsibilities (Security OF the Cloud)

AWS is responsible for protecting the infrastructure that runs Amazon Bedrock:

| AWS Responsibility              | Description                                                               |
| --------------------------------- | --------------------------------------------------------------------------- |
| **Physical Security**           | Data center physical access controls, environmental controls              |
| **Infrastructure Security**     | Host operating system, virtualization layer, network infrastructure       |
| **Service Availability**        | Amazon Bedrock service uptime, regional failover, service scaling         |
| **Model Infrastructure**        | Security of foundation model hosting, model isolation between customers   |
| **API Endpoints**               | TLS/HTTPS enforcement, DDoS protection, API gateway security              |
| **Data Durability**             | Amazon Bedrock Guardrail configurations, service-level encryption         |
| **Compliance Certifications**   | SOC 2, ISO 27001, PCI DSS, HIPAA eligibility (AWS infrastructure)         |
| **Network Security**            | VPC endpoint security, AWS network segmentation                           |

**AWS Commitment**: AWS maintains certifications and attestations for the Bedrock service infrastructure.

### Customer Responsibilities (Security IN the Cloud)

Customers are responsible for security controls within the AIDLC Design Reviewer application:

| Customer Responsibility        | Implementation in AIDLC Design Reviewer                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IAM Access Management**      | ✅ Configure IAM policies with least-privilege<br/>✅ Use temporary credentials (IAM roles, STS)<br/>⚠️ Enable MFA for AWS console access                                                                                     |
| **Data Classification**        | ✅ Classify design documents (Public, Internal, Confidential)<br/>✅ Avoid sending PII or sensitive customer data to Amazon Bedrock<br/>See [DATA_CLASSIFICATION_AND_ENCRYPTION.md](./DATA_CLASSIFICATION_AND_ENCRYPTION.md)  |
| **Data Protection**            | ✅ Encrypt data in transit (TLS 1.2+)<br/>⚠️ Encrypt data at rest (OS-level disk encryption)<br/>✅ Credential scrubbing in logs                                                                                              |
| **Input Validation**           | ✅ Validate design document size and format<br/>✅ Sanitize inputs before sending to Amazon Bedrock                                                                                                                           |
| **Output Handling**            | ✅ Parse AI responses with strict validation<br/>✅ Sanitize AI outputs in HTML reports (XSS prevention)                                                                                                                      |
| **Guardrails Configuration**   | ⚠️ Configure Amazon Bedrock Guardrails (optional but recommended)<br/>⚠️ Define content filters and prompt attack detection                                                                                                   |
| **Logging and Monitoring**     | ✅ Local application logs<br/>⚠️ Enable CloudWatch logging (optional)<br/>⚠️ Enable AWS CloudTrail for API audit trail                                                                                                        |
| **Compliance**                 | ❌ Customer determines applicability of compliance frameworks<br/>❌ Customer responsible for compliance attestation<br/>See [Compliance Disclaimers](#compliance-disclaimers) below                                          |
| **Application Security**       | ✅ Secure application code (Bandit, Semgrep scanning)<br/>✅ Dependency vulnerability management (pip-audit)<br/>✅ Secure configuration management                                                                           |
| **Incident Response**          | ❌ Customer defines incident response procedures<br/>⚠️ Monitor for unusual Amazon Bedrock usage<br/>⚠️ Investigate unauthorized API calls (CloudTrail)                                                                       |
| **Cost Management**            | ⚠️ Set AWS Budgets alerts for unexpected costs<br/>⚠️ Monitor token usage and optimize prompts<br/>✅ Application implements token limits                                                                                     |

**Legend**:

- ✅ Implemented in AIDLC Design Reviewer
- ⚠️ Requires customer configuration or action
- ❌ Customer responsibility (not implemented by application)

### Shared Responsibilities

Some security controls are **shared** between AWS and the customer:

| Shared Area                    | AWS Responsibility                                  | Customer Responsibility                             |
| -------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| **Encryption**                 | Provide encryption capabilities (TLS, KMS)          | Enable and configure encryption for data at rest    |
| **Patch Management**           | Patch Amazon Bedrock service and infrastructure     | Patch application dependencies (Python packages)    |
| **Configuration Management**   | Provide secure defaults for Amazon Bedrock          | Configure Amazon Bedrock Guardrails, IAM policies   |
| **Training and Awareness**     | Provide security documentation and best practices   | Train developers on secure Amazon Bedrock usage     |

### Security Responsibilities Summary

```text
┌─────────────────────────────────────────────────────────────┐
│                    CUSTOMER RESPONSIBILITY                   │
│  • IAM Policies & Credentials                               │
│  • Data Classification & Protection                          │
│  • Application Security & Code                               │
│  • Logging, Monitoring, Incident Response                    │
│  • Compliance Attestation                                    │
├─────────────────────────────────────────────────────────────┤
│                   SHARED RESPONSIBILITY                      │
│  • Encryption (AWS provides, customer configures)           │
│  • Configuration Management (AWS defaults, customer tunes)  │
├─────────────────────────────────────────────────────────────┤
│                      AWS RESPONSIBILITY                      │
│  • Physical & Infrastructure Security                        │
│  • Amazon Bedrock Service Availability                       │
│  • Model Hosting & Isolation                                │
│  • API Endpoint Security (TLS, DDoS)                        │
│  • AWS Infrastructure Compliance Certifications             │
└─────────────────────────────────────────────────────────────┘
```text
### Compliance Disclaimers

**IMPORTANT**: While AWS maintains compliance certifications for the Amazon Bedrock infrastructure, **customers are responsible for their own compliance attestation** when using AIDLC Design Reviewer:

- ❌ **Using Amazon Bedrock does NOT automatically make your application compliant** with HIPAA, PCI DSS, SOC 2, or other frameworks
- ❌ **Customers must perform their own risk assessment** to determine if Amazon Bedrock is appropriate for their use case
- ❌ **Customers must implement additional controls** beyond AWS-provided security features to meet compliance requirements
- ⚠️ **Customers should consult with legal and compliance teams** before processing regulated data

**See Also**: [RISK_ASSESSMENT.md](./RISK_ASSESSMENT.md) for customer-specific risk analysis and treatment plan.

---

## Authentication and Authorization

### 1. Use Temporary Credentials Only

**Requirement**: Application MUST use temporary credentials (IAM roles, AWS STS, AWS SSO)

**Rationale**:

- Long-term access keys are vulnerable to theft
- Temporary credentials auto-expire (reducing exposure window)
- Supports automatic credential rotation

**Implementation**:

```python
# ✅ CORRECT: Use AWS profile with IAM role
session = boto3.Session(profile_name='aidlc-app-role')
bedrock_client = session.client('bedrock-runtime', region_name='us-east-1')

# ❌ INCORRECT: Do not use long-term access keys
# bedrock_client = boto3.client(
#     'bedrock-runtime',
#     aws_access_key_id='AKIA...',
#     aws_secret_access_key='...'
# )
```text
**Verification**:

```bash
# Check credential type
aws sts get-caller-identity --profile aidlc-app-role

# Temporary credentials will show:
# "Arn": "arn:aws:sts::ACCOUNT-ID:assumed-role/ROLE-NAME/session"
```text
---

### 2. Implement Least-Privilege IAM Policies

**Requirement**: Grant ONLY necessary permissions for Amazon Bedrock

**Minimal IAM Policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockModelInference",
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
    }
  ]
}
```text
**With Guardrails**:

```json
{
  "Sid": "BedrockGuardrails",
  "Effect": "Allow",
  "Action": [
    "bedrock:ApplyGuardrail",
    "bedrock:GetGuardrail"
  ],
  "Resource": [
    "arn:aws:bedrock:us-east-1:ACCOUNT-ID:guardrail/*"
  ]
}
```text
**Prohibited Permissions**:

- ❌ `bedrock:*` (overly permissive)
- ❌ Wildcard model resources (`arn:aws:bedrock:*:*:foundation-model/*`)
- ❌ Administrative actions (`CreateGuardrail`, `DeleteGuardrail` for app role)

---

### 3. Enforce Regional Restrictions

**Requirement**: Restrict API calls to approved AWS regions

**Implementation**:

```json
{
  "Condition": {
    "StringEquals": {
      "aws:RequestedRegion": "us-east-1"
    }
  }
}
```text
**Rationale**:

- Data residency compliance
- Cost control (prevent accidental cross-region usage)
- Simplified auditing

**Approved Regions**:

- **Primary**: `us-east-1` (US East, N. Virginia)
- **Backup**: `us-west-2` (US West, Oregon) - if needed

---

### 4. Enable Multi-Factor Authentication (MFA)

**Requirement**: Require MFA for human users accessing AWS console

**IAM Policy with MFA Enforcement**:

```json
{
  "Condition": {
    "BoolIfExists": {
      "aws:MultiFactorAuthPresent": "true"
    }
  }
}
```text
**Does Not Apply To**:

- IAM roles (used by application) - MFA enforced on role assumption
- Service accounts (use least-privilege instead)

---

## Data Protection

### 5. Encrypt Data in Transit

**Requirement**: ALL API calls to Amazon Bedrock MUST use TLS 1.2 or higher

**Implementation**:

- ✅ boto3 enforces HTTPS by default
- ✅ Certificate validation enabled
- ✅ No option to disable TLS

**Verification**:

```python
# boto3 automatically uses HTTPS
# Manual verification:
import ssl
print(ssl.OPENSSL_VERSION)  # Ensure OpenSSL 1.1.1+
```text
**Prohibited**:

- ❌ HTTP endpoints (not supported by Amazon Bedrock)
- ❌ Disabling certificate validation
- ❌ TLS 1.0 or 1.1 (deprecated)

---

### 6. Implement Input Validation

**Requirement**: Validate ALL inputs before sending to Amazon Bedrock

**Validation Checks**:

1. **Type Validation**: Verify input is string
2. **Size Validation**: Limit to prevent excessive costs
3. **Content Validation**: Check for suspicious patterns
4. **Encoding Validation**: Verify UTF-8 encoding

**Implementation**:

```python
def validate_bedrock_input(prompt: str, max_length: int = 750000) -> str:
    # Type check
    if not isinstance(prompt, str):
        raise ValueError(f"Prompt must be string, got {type(prompt)}")

    # Empty check
    if not prompt or not prompt.strip():
        raise ValueError("Prompt cannot be empty")

    # Size limit
    if len(prompt) > max_length:
        logger.warning(f"Prompt exceeds {max_length} chars, truncating")
        prompt = prompt[:max_length]

    return prompt
```text
**Rationale**:

- Prevents injection attacks
- Limits cost exposure
- Ensures API contract compliance

---

### 7. Implement Output Filtering

**Requirement**: Parse and validate ALL responses from Amazon Bedrock

**Implementation**:

```python
def parse_bedrock_response(response: dict) -> str:
    # Only extract expected fields (defense in depth)
    try:
        body = json.loads(response['body'].read())
        text = body['content'][0]['text']
        return text
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        raise ValueError(f"Invalid Bedrock response structure: {e}")
```text
**Rationale**:

- Prevents unexpected data from reaching application
- Validates API contract compliance
- Protects against malformed responses

---

### 8. Use Amazon Bedrock Guardrails

**Requirement**: Enable Guardrails for production workloads

**Guardrail Configuration**:

```yaml
# config.yaml
aws:
  region: us-east-1
  profile_name: aidlc-app-role
  guardrail_id: abc123xyz  # Required for production
  guardrail_version: "1"
```text
**Guardrail Protections**:

- Content filtering (hate, violence, sexual, misconduct)
- Denied topics (PII, financial, medical, legal advice)
- Word filters (profanity, credentials)
- PII redaction (email, phone, SSN)
- Prompt attack detection

**Cost**: $0.75-$1.00 per 1,000 text units (minimal for AIDLC use case)

**See**: `docs/ai-security/BEDROCK_GUARDRAILS.md` for full configuration

---

### 9. Scrub Sensitive Data from Logs

**Requirement**: Remove ALL sensitive data from logs before writing

**Implementation**:

```python
import re

CREDENTIAL_PATTERNS = [
    (r'(aws_access_key_id\s*=\s*)([A-Z0-9]{20})', r'\1***SCRUBBED***'),
    (r'(aws_secret_access_key\s*=\s*)([A-Za-z0-9/+=]{40})', r'\1***SCRUBBED***'),
    (r'(AKIA[A-Z0-9]{16})', r'***SCRUBBED***'),
]

def scrub_sensitive_data(log_message: str) -> str:
    for pattern, replacement in CREDENTIAL_PATTERNS:
        log_message = re.sub(pattern, replacement, log_message)
    return log_message
```text
**Scrubbed Data Types**:

- AWS access keys (AKIA...)
- AWS secret keys (40-character base64)
- API tokens
- Session tokens
- Passwords

---

### 10. Do Not Store LLM Responses Permanently

**Requirement**: Do NOT store raw LLM responses in persistent storage

**Rationale**:

- Potential PII exposure (if Guardrails bypass)
- Reduces data breach impact
- Simplifies compliance (no long-term AI data storage)

**Implementation**:

```python
# ✅ CORRECT: Transient processing
response = bedrock_client.invoke_model(...)
findings = parse_response(response)  # Extract structured data
del response  # Discard raw response

# ❌ INCORRECT: Do not persist raw responses
# with open('bedrock_responses.log', 'a') as f:
#     f.write(str(response))
```text
**Exception**: CloudWatch Logs (optional, with retention policy)

---

## Monitoring and Logging

### 11. Enable CloudWatch Metrics

**Requirement**: Monitor Amazon Bedrock usage via CloudWatch

**Key Metrics**:

- `Invocations`: Total API calls
- `InvocationLatency`: Response time
- `InvocationClientErrors`: 4xx errors
- `InvocationServerErrors`: 5xx errors
- `InputTokens`: Tokens sent
- `OutputTokens`: Tokens generated

**Alarms**:

```bash
# High error rate alarm
aws cloudwatch put-metric-alarm \
  --alarm-name "AIDLC-Bedrock-Errors" \
  --metric-name InvocationClientErrors \
  --namespace AWS/Bedrock \
  --statistic Sum \
  --period 300 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold
```text
---

### 12. Enable CloudWatch Logs

**Requirement**: Log ALL Amazon Bedrock API calls for audit purposes

**Configuration**:

```python
import logging

logger = logging.getLogger('design_reviewer')
logger.setLevel(logging.INFO)

# Log to CloudWatch
handler = watchtower.CloudWatchLogHandler(
    log_group='/aws/aidlc/design-reviewer'
)
logger.addHandler(handler)

# Log every API call
logger.info(
    "Bedrock API call",
    extra={
        'model_id': model_id,
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'latency_ms': latency,
        'cost_usd': cost
    }
)
```text
**Retention**: 90 days minimum (compliance requirement)

---

### 13. Enable AWS CloudTrail

**Requirement**: Log ALL management API calls to Amazon Bedrock

**Logged Actions**:

- `InvokeModel` (data plane)
- `ApplyGuardrail` (data plane)
- `CreateGuardrail` (control plane)
- `UpdateGuardrail` (control plane)

**Implementation**:

#### Step 1: Create and Secure S3 Bucket for CloudTrail

```bash
# Create S3 bucket for CloudTrail logs
aws s3api create-bucket \
  --bucket aidlc-cloudtrail-logs \
  --region us-east-1

# Enable S3 Block Public Access (all 4 settings)
aws s3api put-public-access-block \
  --bucket aidlc-cloudtrail-logs \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Enable S3 bucket versioning
aws s3api put-bucket-versioning \
  --bucket aidlc-cloudtrail-logs \
  --versioning-configuration Status=Enabled

# Enable S3 server-side encryption (SSE-S3)
aws s3api put-bucket-encryption \
  --bucket aidlc-cloudtrail-logs \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      },
      "BucketKeyEnabled": true
    }]
  }'

# Enable S3 access logging (optional but recommended)
aws s3api put-bucket-logging \
  --bucket aidlc-cloudtrail-logs \
  --bucket-logging-status '{
    "LoggingEnabled": {
      "TargetBucket": "aidlc-access-logs",
      "TargetPrefix": "cloudtrail-bucket-logs/"
    }
  }'

# Set bucket policy to enforce TLS/HTTPS only
aws s3api put-bucket-policy \
  --bucket aidlc-cloudtrail-logs \
  --policy '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "DenyInsecureTransport",
        "Effect": "Deny",
        "Principal": "*",
        "Action": [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ],
        "Resource": [
          "arn:aws:s3:::aidlc-cloudtrail-logs",
          "arn:aws:s3:::aidlc-cloudtrail-logs/*"
        ],
        "Condition": {
          "Bool": {
            "aws:SecureTransport": "false"
          }
        }
      },
      {
        "Sid": "AWSCloudTrailAclCheck",
        "Effect": "Allow",
        "Principal": {
          "Service": "cloudtrail.amazonaws.com"
        },
        "Action": "s3:GetBucketAcl",
        "Resource": "arn:aws:s3:::aidlc-cloudtrail-logs"
      },
      {
        "Sid": "AWSCloudTrailWrite",
        "Effect": "Allow",
        "Principal": {
          "Service": "cloudtrail.amazonaws.com"
        },
        "Action": "s3:PutObject",
        "Resource": "arn:aws:s3:::aidlc-cloudtrail-logs/AWSLogs/*",
        "Condition": {
          "StringEquals": {
            "s3:x-amz-acl": "bucket-owner-full-control"
          }
        }
      }
    ]
  }'

# Set lifecycle policy for cost optimization
aws s3api put-bucket-lifecycle-configuration \
  --bucket aidlc-cloudtrail-logs \
  --lifecycle-configuration '{
    "Rules": [{
      "Id": "ArchiveOldLogs",
      "Status": "Enabled",
      "Transitions": [{
        "Days": 90,
        "StorageClass": "GLACIER"
      }],
      "Expiration": {
        "Days": 2555
      }
    }]
  }'
```text
**⚠️ Security Note - S3 Bucket Policy**:

This `Deny` statement blocks insecure HTTP access to the CloudTrail bucket by denying specific data access actions when `aws:SecureTransport` is false. We use explicit action list (`s3:GetObject`, `s3:PutObject`, etc.) rather than `s3:*` wildcard to follow least privilege principles, even for Deny statements.

**Least Privilege**: Only deny the minimum set of actions needed to enforce HTTPS. Administrative actions (bucket configuration, lifecycle, etc.) are not included in the deny list since they're already protected by IAM policies.

**See Also**: [AWS IAM Best Practices - Grant Least Privilege](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege)

**S3 Security Checklist**:

- ✅ Block Public Access enabled (all 4 settings)
- ✅ Bucket encryption enabled (SSE-S3)
- ✅ Versioning enabled
- ✅ TLS/HTTPS enforced via bucket policy
- ✅ Access logging enabled (to separate bucket)
- ✅ Lifecycle policy for retention (90 days active, 7 years archive)
- ⚠️ MFA Delete recommended for production (requires root account)

**MFA Delete Configuration** (Optional - Production Recommended):

```bash
# Enable MFA Delete (requires root account credentials)
aws s3api put-bucket-versioning \
  --bucket aidlc-cloudtrail-logs \
  --versioning-configuration Status=Enabled,MFADelete=Enabled \
  --mfa "arn:aws:iam::ACCOUNT_ID:mfa/root-account-mfa-device XXXXXX"
```text
#### Step 2: Create CloudTrail Trail

```bash
# Create CloudTrail trail
aws cloudtrail create-trail \
  --name aidlc-bedrock-trail \
  --s3-bucket-name aidlc-cloudtrail-logs \
  --is-multi-region-trail \
  --enable-log-file-validation

# Start logging
aws cloudtrail start-logging \
  --name aidlc-bedrock-trail

# Enable logging for Amazon Bedrock
aws cloudtrail put-event-selectors \
  --trail-name aidlc-bedrock-trail \
  --event-selectors '[{
    "ReadWriteType": "All",
    "IncludeManagementEvents": true,
    "DataResources": [{
      "Type": "AWS::Bedrock::Model",
      "Values": ["arn:aws:bedrock:*:*:*"]
    }]
  }]'
```text
**CloudTrail Security Features Enabled**:

- ✅ Multi-region trail (captures all regions)
- ✅ Log file validation (integrity checking)
- ✅ Encryption at rest (via S3 bucket encryption)
- ✅ Secure transport (via S3 bucket policy)

**Use Cases**:

- Security incident investigation
- Compliance audits
- Cost analysis
- Unauthorized access detection

---

## Cost Management

### 14. Implement Cost Controls

**Requirement**: Monitor and limit Amazon Bedrock costs

**Strategies**:

1. **CloudWatch Cost Alarms**:

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "AIDLC-Bedrock-Daily-Cost" \
  --metric-name EstimatedCharges \
  --namespace AWS/Billing \
  --statistic Maximum \
  --period 86400 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold
```text
1. **Input Token Limits**:

```python
MAX_INPUT_TOKENS = 200000  # Model max
MAX_PROMPT_CHARS = 750000  # ~187k tokens at 4 chars/token

if len(prompt) > MAX_PROMPT_CHARS:
    logger.warning("Prompt too large, truncating")
    prompt = prompt[:MAX_PROMPT_CHARS]
```text
1. **Budget Allocation**:

- Set AWS Budgets for Amazon Bedrock spend
- Receive alerts at 80%, 100%, 120% of budget
- Review monthly spending reports

**Cost Estimates**:

| Model               | Input Cost       | Output Cost      | Typical Review Cost   |
| --------------------- | ------------------ | ------------------ | ----------------------- |
| Claude Opus 4.6     | $15/M tokens     | $75/M tokens     | $1.50                 |
| Claude Sonnet 4.6   | $3/M tokens      | $15/M tokens     | $0.30                 |
| Claude Haiku 4.5    | $0.25/M tokens   | $1.25/M tokens   | $0.05                 |

---

### 15. Optimize Token Usage

**Requirement**: Minimize token usage to reduce costs

**Optimization Strategies**:

1. **Use Smaller Models**: Claude Haiku for classification, Sonnet for review
2. **Compress Prompts**: Remove unnecessary whitespace and boilerplate
3. **Batch Processing**: Combine multiple small requests
4. **Caching**: Reuse pattern library across reviews (done)

**Implementation**:

```python
# Use appropriate model for task
classifier = ArtifactClassifier(
    model_id='claude-haiku-4-5'  # Cheapest model for simple task
)

critique_agent = CritiqueAgent(
    model_id='claude-sonnet-4-6'  # Balance cost and quality
)
```text
---

## Compliance and Governance

### 16. Conduct Regular Access Reviews

**Requirement**: Review IAM permissions quarterly

**Process**:

1. Export all IAM roles/users with Amazon Bedrock permissions
2. Verify each principal still requires access
3. Remove inactive accounts (no usage in 90 days)
4. Document changes

**Automation**:

```bash
# List all principals with Bedrock access
aws iam list-policies --query 'Policies[?PolicyName==`BedrockAccess`]'

# Analyze CloudTrail for usage
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=InvokeModel \
  --start-time $(date -d '90 days ago' +%s)
```text
---

### 17. Maintain Audit Trail

**Requirement**: Retain Amazon Bedrock usage logs for 1 year minimum

**Retention Policies**:

- CloudWatch Logs: 365 days
- CloudTrail: 90 days (active), 7 years (archive to S3 Glacier)
- Application Logs: 90 days

**Compliance Standards Guidance**:

**IMPORTANT**: The retention policies above are **technical recommendations only**. **Customers are solely responsible** for determining appropriate retention periods based on their specific compliance requirements.

- **SOC 2**: If pursuing SOC 2 compliance, customers must implement audit trail controls and define retention policies that meet trust service criteria. AWS SOC 2 certification does not automatically extend to customer applications.

- **ISO 27001**: If pursuing ISO 27001 certification, customers must implement log retention controls per their organization's information security management system (ISMS). Typical requirement is 1 year minimum, but **customer must determine** based on their risk assessment.

- **GDPR**: If processing personal data of EU residents, customers must balance retention requirements with the Right to Erasure. **Customer must define** retention periods and implement data deletion procedures that comply with GDPR Article 17.

**Customer Responsibility**: Implementing the retention policies above does NOT automatically make your organization compliant with any standard. Customers must perform their own compliance assessments, implement all required controls (not just logging), and obtain certifications/attestations as needed.

---

### 18. Implement Incident Response Plan

**Requirement**: Define procedures for Amazon Bedrock security incidents

**Incident Types**:

1. Unauthorized access (compromised credentials)
2. Cost spike (runaway usage)
3. Service degradation (high error rate)
4. Guardrail bypass (harmful content detected)

**Response Procedures**:

**Incident: Compromised Credentials**

1. Revoke AWS credentials immediately
2. Analyze CloudTrail for unauthorized API calls
3. Assess damage (data accessed, cost incurred)
4. Rotate all credentials
5. Implement additional MFA/SCPs

**Incident: Cost Spike**

1. Check CloudWatch for usage spike
2. Identify source (user, application, runaway loop)
3. Disable offending credentials/application
4. Analyze CloudTrail for unauthorized access
5. Implement cost controls (budgets, alarms)

**Contact**:

- AWS Support: Open high-priority ticket
- Security Team: <security-team@example.com>
- On-Call Engineer: via PagerDuty

---

## Prohibited Practices

### ❌ Do NOT Do the Following

1. **Use Long-Term Access Keys**: Only temporary credentials permitted
2. **Hardcode Credentials**: No credentials in code, configs, or environment variables
3. **Disable TLS/Certificate Validation**: HTTPS is mandatory
4. **Skip Input Validation**: All inputs must be validated
5. **Store Raw LLM Responses**: Only structured data permitted
6. **Use Wildcard IAM Permissions**: Resource-level permissions required
7. **Disable CloudTrail**: Audit logging is mandatory
8. **Bypass Guardrails**: Production MUST use Guardrails
9. **Share Credentials**: Each user/app gets own IAM role
10. **Ignore Cost Alarms**: Investigate all cost anomalies

---

## Security Checklist

Use this checklist before deploying to production:

### Authentication & Authorization

- [ ] Application uses temporary credentials (IAM role, STS, SSO)
- [ ] IAM policy implements least-privilege (specific models only)
- [ ] Regional restrictions enforced (us-east-1 only)
- [ ] MFA enabled for human users

### Data Protection

- [ ] TLS 1.2+ enforced (boto3 default)
- [ ] Input validation implemented (type, size, content)
- [ ] Output filtering implemented (structured parsing)
- [ ] Amazon Bedrock Guardrails configured
- [ ] Credential scrubbing implemented in logs
- [ ] No permanent storage of raw LLM responses

### Monitoring & Logging

- [ ] CloudWatch metrics enabled
- [ ] CloudWatch Logs configured (90-day retention)
- [ ] AWS CloudTrail enabled
- [ ] Cost alarms configured ($50/day threshold)
- [ ] Error rate alarms configured (>5% threshold)

### Compliance

- [ ] IAM access review process documented
- [ ] Audit trail retention policy defined (1 year)
- [ ] Incident response plan documented
- [ ] Security guidelines reviewed and approved

### Cost Management

- [ ] Token usage limits configured
- [ ] AWS Budgets configured
- [ ] Model selection optimized (Haiku for classification, Sonnet for review)
- [ ] Cost monitoring dashboards created

---

## References

- [Amazon Bedrock Security](https://docs.aws.amazon.com/bedrock/latest/userguide/security.html)
- [Amazon Bedrock Best Practices](https://docs.aws.amazon.com/bedrock/latest/userguide/security-best-practices.html)
- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [AWS Well-Architected Framework - Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)

---

## Change Log

| Date         | Version   | Changes                                          |
| -------------- | ----------- | -------------------------------------------------- |
| 2026-03-19   | 1.0       | Initial AWS Amazon Bedrock security guidelines   |
