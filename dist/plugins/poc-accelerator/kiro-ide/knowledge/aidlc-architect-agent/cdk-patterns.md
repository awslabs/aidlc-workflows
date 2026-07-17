# PoC CDK Patterns

All PoC infrastructure is TypeScript CDK. Start with the smallest removable
pattern that demonstrates the agreed customer flow, then graduate through a
production design review instead of quietly adding production complexity.

## 1. General web application

**Use for:** a simple user-facing workflow or API-backed prototype.

- API Gateway or CloudFront provides the entry point.
- Lambda, ECS/Fargate, or an existing approved service hosts the business logic.
- S3 or DynamoDB stores only approved non-production sample data.
- CloudWatch logs and a small set of outputs make the demo observable.

The template's API Gateway + Lambda example is deliberately minimal. Add an
authorizer, WAF, durable data store, alarms, and lifecycle controls only when
the accepted use case requires them and the customer approves the extension.

## 2. AI/ML inference workflow

**Use for:** a bounded prompt, classification, prediction, or retrieval demo.

- Keep prompt/model configuration in CDK-managed parameters or approved runtime
  configuration; never commit credentials.
- Use synthetic or GenAIIC-approved masked samples (GenAIIC: Generative AI
  Innovation Center, the approved co-creation path for real customer data).
- Record model, region availability, token/cost watchpoints, and a red-team or
  safety limitation in the PoC design.
- Separate a successful demo from production controls such as guardrails,
  evaluation pipelines, quotas, observability, and data governance.

## 3. Data processing workflow

**Use for:** a small batch or event-driven transformation.

- Use a clearly bounded input prefix/bucket, event source, processor, and
  output location.
- Include a redaction or masking boundary before persistent storage.
- Deploy IAM least privilege, retention, encryption, and cleanup settings in
  CDK; leave customer data onboarding to its approved owner.

## CDK quality bar

Every pattern must synthesize, name its stack outputs, describe its cleanup
command, and identify the AWS account/region. Console-only changes are not an
accepted substitute for CDK. Capture the deployed logical resources for value
tracking, but do not infer revenue from them.
