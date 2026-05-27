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

# AIDLC Design Reviewer - System Architecture

**Last Updated**: 2026-03-19
**Version**: 1.0
**Status**: Production

---

## Executive Summary

The AIDLC (AI-Driven Development Life Cycle) Design Reviewer is an automated technical design review system that uses Amazon Bedrock with Anthropic Claude models to analyze software architecture documents and provide structured feedback with security, quality, and best practice recommendations.

**Key Characteristics**:

- **Type**: Command-line application
- **Deployment**: Standalone Python application
- **AI Provider**: Amazon Bedrock (Claude models)
- **Primary Use Case**: Technical design document review and validation
- **User Interaction**: CLI-driven, generates HTML/Markdown reports

---

## System Context Diagram

**Mermaid Diagram**: See [01-system-context.mmd](./diagrams/01-system-context.mmd) for formal diagram (render with Mermaid-compatible tools)

**ASCII Diagram** (terminal-friendly fallback):

```text
┌─────────────────────────────────────────────────────────────────┐
│                          AIDLC DESIGN REVIEWER                  │
│                       (Python CLI Application)                   │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │   Validation │────│  AI Review   │────│   Reporting  │    │
│  │     Layer    │    │    Layer     │    │     Layer    │    │
│  └──────────────┘    └──────────────┘    └──────────────┘    │
│         │                    │                    │            │
│         └────────────────────┴────────────────────┘            │
│                              │                                  │
└──────────────────────────────┼──────────────────────────────────┘
                               │
                               │ HTTPS (TLS 1.2+)
                               ▼
                    ┌─────────────────────┐
                    │   Amazon Bedrock    │
                    │  (Claude Models)    │
                    │                     │
                    │  • Claude Opus 4.6  │
                    │  • Claude Sonnet4.6│
                    │  • Claude Haiku 4.5 │
                    └─────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   AWS Services      │
                    │  • IAM              │
                    │  • CloudWatch       │
                    │  • GuardRails       │
                    └─────────────────────┘
```text
**External Dependencies**:

- Amazon Bedrock API (model inference)
- AWS IAM (authentication/authorization)
- CloudWatch (logging and metrics)
- Local file system (design documents, reports)

---

## High-Level Architecture

### Layered Architecture

**Mermaid Diagram**: See [02-layered-architecture.mmd](./diagrams/02-layered-architecture.mmd) for formal diagram (render with Mermaid-compatible tools)

**ASCII Diagram** (terminal-friendly fallback):

The system follows a 5-layer architecture pattern:

```text
┌───────────────────────────────────────────────────────────────┐
│  LAYER 1: CLI Interface                                        │
│  • Command parsing (Click framework)                           │
│  • User interaction and progress display                       │
│  • Exit code handling                                          │
└───────────────────────────────────────────────────────────────┘
                              │
┌───────────────────────────────────────────────────────────────┐
│  LAYER 2: Orchestration                                        │
│  • Workflow coordination                                       │
│  • Error handling and recovery                                 │
│  • Timing and metrics collection                               │
└───────────────────────────────────────────────────────────────┘
                              │
┌───────────────────────────────────────────────────────────────┐
│  LAYER 3: Business Logic                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Validation   │  │  AI Review   │  │  Reporting   │       │
│  │ (Unit 2)     │  │  (Unit 4)    │  │  (Unit 5)    │       │
│  │              │  │              │  │              │       │
│  │ • Scanner    │  │ • Critique   │  │ • Builder    │       │
│  │ • Classifier │  │ • Altern.    │  │ • Formatter  │       │
│  │ • Loader     │  │ • Gap        │  │ • Templates  │       │
│  │ • Validator  │  │              │  │              │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                              │                                 │
│  ┌──────────────┐  ┌──────────────┐                          │
│  │  Parsing     │  │  Foundation  │                          │
│  │  (Unit 3)    │  │  (Unit 1)    │                          │
│  │              │  │              │                          │
│  │ • AppDesign  │  │ • Config     │                          │
│  │ • FuncDesign │  │ • Logging    │                          │
│  │ • TechEnv    │  │ • Patterns   │                          │
│  │              │  │ • Prompts    │                          │
│  └──────────────┘  └──────────────┘                          │
└───────────────────────────────────────────────────────────────┘
                              │
┌───────────────────────────────────────────────────────────────┐
│  LAYER 4: Integration                                          │
│  • Amazon Bedrock client (boto3)                               │
│  • Strands SDK wrapper                                         │
│  • Retry and backoff logic                                     │
└───────────────────────────────────────────────────────────────┘
                              │
┌───────────────────────────────────────────────────────────────┐
│  LAYER 5: External Services                                    │
│  • Amazon Bedrock API                                          │
│  • AWS IAM                                                     │
│  • CloudWatch Logs                                             │
└───────────────────────────────────────────────────────────────┘
```text
---

## Component Architecture

### Unit 1: Foundation (Configuration & Infrastructure)

**Purpose**: Provide core infrastructure services

**Components**:

- `ConfigManager`: Singleton configuration management
- `Logger`: Structured logging with credential scrubbing
- `PatternLibrary`: Design pattern definitions
- `PromptManager`: AI prompt template management

**Key Responsibilities**:

- Load and validate YAML configuration
- Manage AWS credentials (profile-based only)
- Provide immutable configuration access
- Scrub sensitive data from logs

**Security Controls**:

- ✅ Temporary credentials only (no long-term keys)
- ✅ Credential scrubbing in logs
- ✅ Immutable configuration (Pydantic frozen models)

### Unit 2: Validation (Document Discovery & Classification)

**Purpose**: Discover and validate design documents

**Components**:

- `ArtifactScanner`: File system scanner
- `ArtifactClassifier`: AI-powered document classification
- `ArtifactLoader`: Content extraction
- `StructureValidator`: AIDLC structure validation

**Key Responsibilities**:

- Scan aidlc-docs/ directory for artifacts
- Classify artifacts using Claude models
- Load artifact content
- Validate AIDLC folder structure

**Security Controls**:

- ✅ Input validation before AI classification
- ✅ File type restrictions (.md only)
- ✅ Path traversal prevention

### Unit 3: Parsing (Document Parsing)

**Purpose**: Parse structured design documents

**Components**:

- `ApplicationDesignParser`: Parse application-design artifacts
- `FunctionalDesignParser`: Parse functional-design artifacts
- `TechnicalEnvironmentParser`: Parse technical environment

**Key Responsibilities**:

- Extract structured data from Markdown
- Build design data models
- Handle parsing errors gracefully

**Security Controls**:

- ✅ Safe parsing (no eval/exec)
- ✅ Input size limits
- ✅ Error handling (no sensitive data in errors)

### Unit 4: AI Review (LLM-Powered Analysis)

**Purpose**: Perform AI-powered design review

**Components**:

- `BaseAgent`: Abstract base class for AI agents
- `CritiqueAgent`: Design critique and issue identification
- `AlternativesAgent`: Alternative approach suggestions
- `GapAgent`: Gap analysis against patterns
- `ResponseParser`: Parse structured AI responses

**Key Responsibilities**:

- Invoke Amazon Bedrock models
- Parse and validate AI responses
- Retry on transient failures
- Track token usage

**Security Controls**:

- ✅ Input validation (type, size, content)
- ✅ Output filtering (parse only expected structure)
- ✅ Amazon Bedrock Guardrails (optional)
- ✅ No prompt injection vectors
- ✅ Retry limits (max 4 attempts)

### Unit 5: Reporting (Report Generation)

**Purpose**: Generate structured review reports

**Components**:

- `ReportBuilder`: Build report data models
- `MarkdownFormatter`: Generate Markdown reports
- `HTMLFormatter`: Generate HTML reports
- `TemplateEnv`: Jinja2 template management

**Key Responsibilities**:

- Calculate quality scores
- Build executive summaries
- Format findings and recommendations
- Render HTML/Markdown reports

**Security Controls**:

- ✅ Template autoescaping (XSS prevention)
- ✅ No sensitive data in reports
- ✅ Output validation

---

## Data Flow

### End-to-End Review Process

**Mermaid Diagram**: See [03-data-flow.mmd](./diagrams/03-data-flow.mmd) for formal diagram (render with Mermaid-compatible tools)

**Component Interaction Sequence**: See [04-component-interaction.mmd](./diagrams/04-component-interaction.mmd) for detailed sequence diagram

**ASCII Diagram** (terminal-friendly fallback):

```text
┌──────────┐
│  User    │ design-reviewer --project aidlc-docs/
└────┬─────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. INITIALIZATION                                            │
│  • Load config.yaml                                          │
│  • Initialize ConfigManager                                  │
│  • Setup logging                                             │
│  • Load pattern library                                      │
└────┬────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. VALIDATION                                                │
│  • Scan aidlc-docs/ for .md files                          │
│  • Classify artifacts (AI: Claude Haiku)                    │
│  • Load artifact content                                     │
│  • Validate AIDLC structure                                  │
└────┬────────────────────────────────────────────────────────┘
     │ ArtifactData (classified documents)
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. PARSING                                                   │
│  • Parse application-design artifacts                        │
│  • Parse functional-design artifacts                         │
│  • Parse technical environment                               │
│  • Build DesignData model                                    │
└────┬────────────────────────────────────────────────────────┘
     │ DesignData (structured design)
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. AI REVIEW (Parallel Agents)                              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  Critique    │  │ Alternatives │  │     Gap      │    │
│  │  Agent       │  │    Agent     │  │   Agent      │    │
│  │              │  │              │  │              │    │
│  │ AI: Opus/    │  │ AI: Sonnet   │  │ AI: Sonnet   │    │
│  │    Sonnet    │  │              │  │              │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                  │                  │             │
│         └──────────────────┴──────────────────┘             │
│                            │                                │
│                 ┌──────────▼──────────┐                    │
│                 │   Amazon Bedrock    │                    │
│                 │   (Claude Models)   │                    │
│                 └──────────┬──────────┘                    │
│                            │                                │
│                 ReviewResult (findings)                     │
└────┬───────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. REPORT GENERATION                                         │
│  • Calculate quality score                                   │
│  • Build executive summary                                   │
│  • Format findings                                           │
│  • Render HTML report                                        │
│  • Render Markdown report                                    │
└────┬────────────────────────────────────────────────────────┘
     │
     ▼
┌──────────────────────────────────────────────────────────────┐
│ OUTPUT                                                        │
│  • design-review-report.html                                 │
│  • design-review-report.md                                   │
│  • Exit code: 0 (success) / 1 (errors)                      │
└──────────────────────────────────────────────────────────────┘
```text
---

## Security Architecture

### Authentication and Authorization

```text
┌────────────────────────────────────────────────────────────┐
│  USER                                                       │
│  • Runs CLI command                                        │
│  • Uses AWS profile (profile_name in config.yaml)         │
└───────┬────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────┐
│  AWS PROFILE CREDENTIALS                                    │
│  • IAM Role (preferred)                                    │
│  • AWS SSO                                                 │
│  • STS Temporary Credentials                              │
│  ❌ NO long-term access keys                              │
└───────┬────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────┐
│  BOTO3 SESSION                                             │
│  • boto3.Session(profile_name=profile)                    │
│  • Automatic credential refresh                            │
│  • TLS 1.2+ encrypted                                      │
└───────┬────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────┐
│  AWS IAM AUTHORIZATION                                      │
│  • bedrock:InvokeModel                                     │
│  • bedrock:ApplyGuardrail                                  │
│  • logs:PutLogEvents                                       │
└───────┬────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────┐
│  AMAZON BEDROCK API                                         │
│  • Model inference                                          │
│  • Guardrail enforcement                                    │
│  • Usage metering                                           │
└────────────────────────────────────────────────────────────┘
```text
### Data Protection Layers

| Layer                    | Protection Mechanism            | Status              |
| -------------------------- | --------------------------------- | --------------------- |
| **Transport**            | TLS 1.2+ encryption             | ✅ Enforced         |
| **Authentication**       | AWS IAM temporary credentials   | ✅ Enforced         |
| **Authorization**        | Resource-level IAM policies     | ✅ Configured       |
| **Input Validation**     | Type and size checks            | ✅ Implemented      |
| **Output Filtering**     | Structured parsing only         | ✅ Implemented      |
| **Content Filtering**    | Amazon Bedrock Guardrails       | ⚠️ Optional         |
| **Logging**              | Credential scrubbing            | ✅ Implemented      |
| **At-Rest Encryption**   | N/A (transient processing)      | ℹ️ Not applicable   |

---

### AWS Shared Responsibility Model

**Reference**: [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/)

The AIDLC Design Reviewer architecture operates under the AWS Shared Responsibility Model:

#### AWS Responsibilities (Security OF the Cloud)

AWS manages the underlying infrastructure for Amazon Bedrock and related services:

- **Physical Infrastructure**: Data centers, servers, networking hardware
- **Amazon Bedrock Service**: Model hosting, API endpoints, service availability
- **AWS IAM Service**: Authentication engine, policy enforcement
- **CloudWatch/CloudTrail**: Logging infrastructure, metrics collection
- **Network Security**: DDoS protection, VPC security, TLS endpoints

#### Customer Responsibilities (Security IN the Cloud)

Customers deploying AIDLC Design Reviewer are responsible for:

| Responsibility Area          | Implementation Status                  | Customer Action Required                                                                            |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Application Deployment**   | ✅ CLI application provided            | ⚠️ Install and configure on secure workstation                                                      |
| **IAM Configuration**        | ✅ Example policies provided           | ⚠️ Create IAM roles with least-privilege<br/>⚠️ Enable MFA for AWS console access                   |
| **Credential Management**    | ✅ Temporary credentials enforced      | ⚠️ Configure AWS profiles (~/.aws/credentials)<br/>⚠️ Rotate credentials regularly                  |
| **Workstation Security**     | ❌ Not managed by application          | ❌ Enable full disk encryption<br/>❌ Install OS security patches<br/>❌ Use antivirus/EDR software |
| **Network Security**         | ❌ Not managed by application          | ❌ Use secure networks (avoid public WiFi)<br/>⚠️ Consider VPN for remote access                    |
| **Data Classification**      | ✅ Guidelines provided                 | ❌ Classify design documents<br/>❌ Determine appropriate handling                                  |
| **Logging & Monitoring**     | ✅ Local logs, ⚠️ CloudWatch optional  | ⚠️ Enable CloudWatch logging<br/>⚠️ Monitor for unusual activity                                    |
| **Incident Response**        | ❌ Not provided                        | ❌ Define incident response procedures<br/>⚠️ Monitor CloudTrail for unauthorized access            |
| **Compliance**               | ❌ Customer-specific                   | ❌ Perform compliance assessments<br/>❌ Implement additional controls as needed                    |

**Legend**:

- ✅ Implemented in AIDLC Design Reviewer
- ⚠️ Requires customer configuration
- ❌ Customer responsibility (not provided by application)

#### Deployment Security Checklist

Before deploying AIDLC Design Reviewer to production, customers should:

1. ⚠️ **Workstation Hardening**:
   - Enable full disk encryption (BitLocker/FileVault/LUKS)
   - Apply OS security patches
   - Install endpoint protection (antivirus, EDR)

2. ⚠️ **AWS Configuration**:
   - Create IAM role with least-privilege permissions
   - Enable MFA for AWS console access
   - Configure AWS SSO (recommended over IAM users)
   - Enable CloudTrail in all regions

3. ⚠️ **Application Configuration**:
   - Review and customize config.yaml
   - Enable Amazon Bedrock Guardrails
   - Configure CloudWatch logging
   - Set appropriate log retention

4. ⚠️ **Operational Security**:
   - Define incident response procedures
   - Set up AWS Budgets alerts for cost monitoring
   - Configure CloudWatch alarms for unusual activity
   - Document runbook for security incidents

**See Also**:

- [AWS_BEDROCK_SECURITY_GUIDELINES.md](../security/AWS_BEDROCK_SECURITY_GUIDELINES.md) - Detailed security configuration
- [THREAT_MODEL.md](../security/THREAT_MODEL.md) - Threat analysis and mitigations
- [RISK_ASSESSMENT.md](../security/RISK_ASSESSMENT.md) - Risk analysis and treatment plan

---

## Deployment Architecture

### Standalone CLI Deployment

```text
┌────────────────────────────────────────────┐
│  Developer Workstation / CI/CD Runner      │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  Python 3.12+ Environment            │ │
│  │                                      │ │
│  │  ┌────────────────────────────────┐ │ │
│  │  │  AIDLC Design Reviewer         │ │ │
│  │  │  (Installed via uv/pip)        │ │ │
│  │  └────────────────────────────────┘ │ │
│  │                                      │ │
│  │  ┌────────────────────────────────┐ │ │
│  │  │  config.yaml                   │ │ │
│  │  │  • profile_name                │ │ │
│  │  │  • region                      │ │ │
│  │  │  • models                      │ │ │
│  │  └────────────────────────────────┘ │ │
│  │                                      │ │
│  │  ┌────────────────────────────────┐ │ │
│  │  │  ~/.aws/                       │ │ │
│  │  │  • credentials (profiles)      │ │ │
│  │  │  • config                      │ │ │
│  │  └────────────────────────────────┘ │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  aidlc-docs/ (Input)                 │ │
│  │  • Design documents                  │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  Reports (Output)                    │ │
│  │  • design-review-report.html         │ │
│  │  • design-review-report.md           │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  Logs                                │ │
│  │  • logs/design-reviewer.log          │ │
│  │  • CloudWatch Logs (optional)        │ │
│  └──────────────────────────────────────┘ │
└────────────────────────────────────────────┘
                     │
                     │ HTTPS (boto3)
                     ▼
        ┌─────────────────────────┐
        │   AWS (us-east-1)       │
        │  • Amazon Bedrock       │
        │  • CloudWatch           │
        └─────────────────────────┘
```text
### Alternative Deployment Options

#### Option 1: Containerized (Docker)

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN uv sync
CMD ["uv", "run", "design-reviewer", "--project", "/workspace/aidlc-docs"]
```text
**Use Case**: CI/CD pipelines, reproducible environments

#### Option 2: AWS Lambda (Serverless)

**Use Case**: On-demand review triggered by events (S3 upload, API Gateway)

**Considerations**:

- Timeout: 15 minutes max (reviews typically < 2 minutes)
- Memory: 2048 MB recommended
- Ephemeral storage: /tmp for reports

#### Option 3: EC2 / ECS (Long-Running Service)

**Use Case**: Review service API, batch processing

**Architecture**:

- Load balancer → ECS tasks
- Auto-scaling based on queue depth
- Persistent storage for reports (S3)

---

## Technology Stack

### Runtime

| Component                   | Technology       | Version   |
| ----------------------------- | ------------------ | ----------- |
| **Language**                | Python           | 3.12+     |
| **Package Manager**         | uv               | Latest    |
| **Dependency Management**   | pyproject.toml   | -         |

### Core Dependencies

| Library        | Purpose                      | Version   |
| ---------------- | ------------------------------ | ----------- |
| **boto3**      | AWS SDK                      | Latest    |
| **botocore**   | AWS low-level interface      | Latest    |
| **pydantic**   | Data validation              | 2.x       |
| **click**      | CLI framework                | 8.x       |
| **jinja2**     | Template rendering           | 3.x       |
| **pyyaml**     | YAML parsing                 | 6.x       |
| **strands**    | Amazon Bedrock SDK wrapper   | Latest    |
| **backoff**    | Retry logic                  | 2.x       |

### Development Tools

| Tool          | Purpose             |
| --------------- | --------------------- |
| **pytest**    | Unit testing        |
| **bandit**    | Security scanning   |
| **semgrep**   | SAST scanning       |
| **ruff**      | Linting             |
| **mypy**      | Type checking       |

---

## Scalability and Performance

### Performance Characteristics

| Metric                   | Typical Value     | Limit                 |
| -------------------------- | ------------------- | ----------------------- |
| **Review Time**          | 30-120 seconds    | 5 minutes (timeout)   |
| **Concurrent Reviews**   | 1 (CLI)           | N/A                   |
| **Max Document Size**    | 50KB              | 100KB (truncated)     |
| **Memory Usage**         | 200-500 MB        | 1 GB                  |
| **CPU Usage**            | Low (I/O bound)   | -                     |

### Bottlenecks

1. **Amazon Bedrock API Latency**: 10-30 seconds per agent
2. **Network I/O**: HTTPS requests to AWS
3. **File System I/O**: Reading design documents

### Optimization Strategies

- **Parallel Agent Execution**: Critique, Alternatives, Gap run concurrently
- **Caching**: Pattern library loaded once
- **Efficient Parsing**: Streaming Markdown parser
- **Batch Classification**: Classify multiple artifacts in parallel

---

## Monitoring and Observability

### Metrics

**Application Metrics** (CloudWatch Custom):

- Reviews completed/failed
- Average review time
- Cost per review
- Agent execution times

**AWS Metrics** (Amazon Bedrock):

- Model invocations
- Token usage (input/output)
- Error rates (4xx, 5xx)
- Latency (P50, P95, P99)

### Logging

**Application Logs**: `logs/design-reviewer.log`

- Structured JSON logs
- Log rotation (10 MB, 5 backups)
- Credential scrubbing

**CloudWatch Logs**: `/aws/aidlc/design-reviewer`

- Centralized logging (optional)
- 90-day retention
- Log Insights queries

### Tracing

**Trace ID**: `rev-YYYYMMDD-HHMMSS-{UUID}`

**Logged at Each Stage**:

- Validation
- Parsing
- AI Review (per agent)
- Report Generation

---

## Disaster Recovery

### Backup and Recovery

**Configuration**: Store config.yaml in version control
**Reports**: Archive to S3 (optional)
**Logs**: CloudWatch retention (90 days)

**Recovery**:

1. Re-clone repository
2. Restore config.yaml
3. Re-run review (idempotent)

**RTO**: < 5 minutes
**RPO**: 0 (stateless application)

### Failure Modes

| Failure                         | Impact                        | Mitigation                     |
| --------------------------------- | ------------------------------- | -------------------------------- |
| **Amazon Bedrock API outage**   | Cannot perform review         | Retry logic, fail gracefully   |
| **IAM credential expiration**   | Authentication failure        | Automatic refresh (STS)        |
| **Config file missing**         | Application startup failure   | Clear error message            |
| **Invalid design document**     | Parsing error                 | Validation, user feedback      |
| **Out of tokens**               | Truncated prompts             | Size limits, warnings          |

---

## Future Architecture Enhancements

### Short-Term (Q2 2026)

- [ ] API service (FastAPI) for programmatic access
- [ ] Web UI for report viewing
- [ ] S3 report storage integration
- [ ] Enhanced caching (Redis)

### Long-Term (2027)

- [ ] Multi-tenancy support
- [ ] Review history and trending
- [ ] Custom pattern library per organization
- [ ] Webhook integrations (Slack, GitHub)

---

## References

- [Amazon Bedrock Architecture](https://docs.aws.amazon.com/bedrock/latest/userguide/what-is-bedrock.html)
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
- [Python Application Best Practices](https://docs.python-guide.org/)

---

## Change Log

| Date         | Version   | Changes                                     |
| -------------- | ----------- | --------------------------------------------- |
| 2026-03-19   | 1.0       | Initial system architecture documentation   |
