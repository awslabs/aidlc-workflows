<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# Shared Responsibility Model

## Overview

This document defines the security responsibilities of the tool and its users.

## Tool Responsibilities

The AIDLC Traceability Matrix Tool is responsible for:

| Area                     | Responsibility                                                                    |
| ------------------------ | --------------------------------------------------------------------------------- |
| **Input validation**     | Validating CLI arguments, handling malformed artifact files gracefully            |
| **Output sanitization**  | Escaping all dynamic content in HTML reports to prevent XSS                       |
| **AI output validation** | Validating AI-discovered relationships against known artifact IDs                 |
| **Credential handling**  | Using boto3 standard credential chain; does not store, log, or expose credentials |
| **Error isolation**      | Catching parser/AI errors per-file without crashing the pipeline                  |
| **Dependency security**  | Providing security scanning tools and maintaining pinned dependency versions      |
| **Code security**        | No use of eval/exec, no shell injection vectors, no hardcoded secrets             |

## User Responsibilities

Users of the tool are responsible for:

| Area                       | Responsibility                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| **AWS credentials**        | Configuring IAM policies with least-privilege permissions (see `docs/bedrock-security.md`) |
| **Credential security**    | Using temporary credentials (IAM roles, SSO) instead of long-term access keys              |
| **Network security**       | Ensuring secure network configuration for Amazon Bedrock API calls                         |
| **Report storage**         | Storing generated reports securely; encrypting at rest if required by policy               |
| **Report integrity**       | Verifying report accuracy; the tool generates documentation, not compliance determinations |
| **Regulatory compliance**  | Ensuring traceability documentation meets applicable regulatory requirements               |
| **Access control**         | Controlling who can run the tool and access generated reports                              |
| **Project file integrity** | Ensuring artifact files have not been tampered with before generating reports              |
| **Dependency updates**     | Periodically running `uv lock --upgrade` and security scans to address new CVEs            |

## Amazon Bedrock Shared Responsibility

When AI analysis is enabled, the [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/) applies. This model defines which security controls AWS manages and which the customer (user) must configure.

### Responsibility Matrix

| Layer                                                             | Responsible Party | Details                                                                  |
| ----------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| Physical infrastructure, network, hypervisor                      | AWS               | AWS manages all underlying infrastructure                                |
| Amazon Bedrock service availability and API security              | AWS               | TLS 1.2+ enforced, service-level SLA                                     |
| Model inference (no data retention, no training on customer data) | AWS               | Per [AWS Service Terms](https://aws.amazon.com/service-terms/)           |
| IAM policy configuration                                          | **User**          | Must configure least-privilege policies (see `docs/bedrock-security.md`) |
| Data sent to Amazon Bedrock (artifact content)                    | **User**          | User decides which projects to analyze with AI enabled                   |
| Network configuration (VPC endpoints, security groups)            | **User**          | Optional VPC endpoint: `com.amazonaws.<region>.bedrock-runtime`          |
| CloudTrail monitoring and alerting                                | **User**          | Must enable CloudTrail for API call audit trails                         |
| Amazon Bedrock Guardrails configuration                           | **User**          | Optional content filtering via Amazon Bedrock console                    |

### Amazon Bedrock Service-Specific Security Details

| Security Feature                    | Status          | Notes                                                       |
| ----------------------------------- | --------------- | ----------------------------------------------------------- |
| **Encryption in transit**           | Enforced        | TLS 1.2+ via boto3/botocore                                 |
| **Encryption at rest**              | Managed by AWS  | Amazon Bedrock encrypts data at rest using AWS-managed keys |
| **Data retention**                  | None            | Amazon Bedrock does not store prompts or completions        |
| **Model training on customer data** | None            | Customer data is not used for model training                |
| **Cross-region data transfer**      | User-controlled | Data stays in the `--region` specified                      |
| **IAM authentication**              | Required        | Every API call is authenticated via IAM                     |
| **CloudTrail logging**              | Available       | All `bedrock:InvokeModel` calls logged automatically        |
| **VPC endpoints**                   | Available       | Private connectivity without internet traversal             |
| **Guardrails**                      | Available       | Content filtering configurable in Amazon Bedrock console    |

## When AI Is Disabled

When running with `--no-ai`, there is no AWS dependency. The tool operates entirely locally:

- **Tool responsibility**: Correct parsing, heuristic linking, report generation
- **User responsibility**: Project file integrity, report storage, compliance decisions
