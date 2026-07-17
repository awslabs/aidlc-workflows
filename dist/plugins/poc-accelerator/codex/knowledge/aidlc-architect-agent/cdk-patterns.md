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

## 2. GenAI / AI agent / agentic AI application

**Use for:** any workload where an LLM-driven agent reasons, uses tools, or
orchestrates steps — a GenAI assistant, a single AI agent, or a multi-agent
(agentic) system.

**Default: Amazon Bedrock AgentCore.** Unless the customer or the target
region rules it out, host the agent on AgentCore rather than hand-rolling the
runtime:

- **AgentCore Runtime** hosts the agent serverlessly; it is framework-agnostic
  (Strands Agents, LangGraph, CrewAI) and model-agnostic.
- **AgentCore Gateway** exposes tools and MCP endpoints to the agent;
  **Memory** and **Identity** replace bespoke session stores and credential
  plumbing; built-in Code Interpreter/Browser tools and **Observability**
  cover the common agent needs without extra infrastructure.
- Define it in TypeScript CDK like everything else: use the Bedrock AgentCore
  CDK construct library (alpha) or the `AWS::BedrockAgentCore::*` L1
  resources. Console-only agent setup is not an accepted path.
- Do not start a new PoC on Bedrock Agents Classic — it is closed to new
  customers as of 2026-07-30; AgentCore is its successor.

**Region gate (decides the pattern):** AgentCore is available in a subset of
regions and is **not yet available in the China partition (BJS/ZHY — planned,
verify current status)**. Confirm availability for the target region at
step 1–2 via the documentation MCP server. Where AgentCore is unavailable,
record the deviation in the design and fall back to the same agent framework
hosted on Lambda or ECS/Fargate against the approved model endpoint, keeping
the tool/MCP boundary explicit so the extension recommendations can name
AgentCore as the production migration path once it reaches the region.

**Cost:** AgentCore components are consumption-priced — include them in the
pricing MCP quotes for the stack plan's cost watchpoints and the step-8 cost
projection.

## 3. AI/ML inference workflow (non-agentic)

**Use for:** a bounded single-shot prompt, classification, prediction, or
retrieval demo with no tool use or multi-step orchestration — otherwise use
pattern 2.

- Keep prompt/model configuration in CDK-managed parameters or approved runtime
  configuration; never commit credentials.
- Use synthetic or GenAIIC-approved masked samples (GenAIIC: Generative AI
  Innovation Center, the approved co-creation path for real customer data).
- Record model, region availability, token/cost watchpoints, and a red-team or
  safety limitation in the PoC design.
- Separate a successful demo from production controls such as guardrails,
  evaluation pipelines, quotas, observability, and data governance.

## 4. Data processing workflow

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
