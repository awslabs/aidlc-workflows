<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# Amazon Bedrock Security Guidelines

## Required IAM Permissions

The tool requires the following minimum IAM permissions when AI analysis is enabled:

### Least-Privilege IAM Policy

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "BedrockInvokeModel",
            "Effect": "Allow",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream"
            ],
            "Resource": "arn:aws:bedrock:us-east-1::foundation-model/us.anthropic.claude-sonnet-4-20250514-v1:0"
        }
    ]
}
```

To allow all Claude models (for future model updates):

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "BedrockInvokeModel",
            "Effect": "Allow",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream"
            ],
            "Resource": "arn:aws:bedrock:us-east-1::foundation-model/us.anthropic.*"
        }
    ]
}
```

### Credential Validation

The tool calls `sts:GetCallerIdentity` to validate credentials before making Amazon Bedrock requests. This action does not support resource-level permissions per the [AWS STS documentation](https://docs.aws.amazon.com/IAM/latest/UserGuide/list_awssecuritytokenservice.html), so include it in the same policy with a scoped condition:

```json
{
    "Sid": "ValidateCredentials",
    "Effect": "Allow",
    "Action": "sts:GetCallerIdentity",
    "Resource": "arn:aws:iam::*:user/${aws:username}",
    "Condition": {
        "StringEquals": {
            "aws:RequestedRegion": "us-east-1"
        }
    }
}
```

> **Note**: `sts:GetCallerIdentity` is an identity-verification-only action that returns the caller's account ID, ARN, and user ID. It does not grant access to any resources. The condition above limits the region scope. If your organization's policy requires it, this statement can be omitted — the tool will skip credential pre-validation and let the first Amazon Bedrock call surface any credential errors.

## Credential Management

### Recommended: Temporary Credentials

Use IAM Identity Center (SSO) or IAM roles for temporary credentials:

```bash
# IAM Identity Center
aws sso login --profile my-profile
traceability generate --input /path/to/project --profile my-profile

# EC2 Instance Role (no --profile needed)
traceability generate --input /path/to/project

# Environment variables
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...
traceability generate --input /path/to/project
```

### Not Recommended: Long-Term Access Keys

If temporary credentials are not available, use named profiles with access keys stored in `~/.aws/credentials`. Do not hardcode access keys in code or configuration files.

## Data Sent to Amazon Bedrock

When AI analysis is enabled, the following data is sent to the Amazon Bedrock API:

| Data Type            | Content                                         | Volume                         |
| -------------------- | ----------------------------------------------- | ------------------------------ |
| Artifact summaries   | IDs, titles, descriptions from parsed artifacts | All artifacts                  |
| Source code snippets | File contents for Component→Code linking        | Up to 30 files, 200 lines each |
| System prompts       | Agent instructions (static, no user data)       | 4 prompts per run              |

### Data Residency

- API calls are made to the region specified by `--region` (default: `us-east-1`)
- Data is processed within the specified AWS region
- Amazon Bedrock does not use customer data for model training (per [AWS service terms](https://aws.amazon.com/service-terms/))

## Amazon Bedrock Guardrails

For additional content filtering, you can configure Amazon Bedrock Guardrails in the AWS console. This tool does not currently configure Guardrails programmatically, but the Amazon Bedrock model invocations will respect any Guardrails attached to the model in your account.

## Network Security

- All Amazon Bedrock API calls use HTTPS with TLS 1.2+
- No VPC endpoints are required (calls go over the public internet by default)
- For enhanced security, configure a VPC endpoint for Amazon Bedrock (`com.amazonaws.<region>.bedrock-runtime`)

## Monitoring

- Amazon Bedrock API calls are logged in AWS CloudTrail
- Model invocation logging can be enabled in the Amazon Bedrock console for detailed request/response audit trails
- The tool logs AI analysis timing and relationship counts locally when `--verbose` is enabled

## Disabling AI Analysis

To run the tool without any AWS dependency:

```bash
traceability generate --input /path/to/project --no-ai
```

This uses only rule-based heuristic analysis with no external API calls.
