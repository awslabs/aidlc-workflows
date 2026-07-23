# Threat Modelling with STRIDE

A structured approach to identifying, classifying, and mitigating security threats during the design phase.

## STRIDE Categories

| Category | Threat | Violated Property | Example |
|----------|--------|-------------------|---------|
| **S — Spoofing** | Attacker pretends to be another user or system | Authentication | Stolen JWT used to access another user's data |
| **T — Tampering** | Attacker modifies data in transit or at rest | Integrity | Man-in-the-middle alters API request payload |
| **R — Repudiation** | Attacker denies performing an action | Non-repudiation | User disputes a financial transaction with no audit trail |
| **I — Information Disclosure** | Sensitive data exposed to unauthorized parties | Confidentiality | Error message leaks stack trace and database schema |
| **D — Denial of Service** | System made unavailable to legitimate users | Availability | Unbounded API request floods Lambda concurrency |
| **E — Elevation of Privilege** | Attacker gains higher access than authorized | Authorization | Regular user exploits IDOR to access admin endpoints |

## Threat Modelling Process

### Step 1: Define Scope
Identify what you are threat-modelling: a single microservice, a complete feature, or an entire system. Smaller scopes produce more actionable results.

### Step 2: Create a Data Flow Diagram (DFD)
Draw the system showing:
- **External entities**: Users, third-party systems, partner APIs
- **Processes**: Lambda functions, ECS services, API Gateway
- **Data stores**: DynamoDB tables, S3 buckets, RDS instances
- **Data flows**: Arrows showing data movement, labelled with protocol and data type
- **Trust boundaries**: Lines separating zones of different trust levels (public internet, VPC, private subnet)

### Step 3: Identify Threats
Walk through each element and data flow in the DFD. For each, ask the six STRIDE questions:
- Can an attacker spoof this identity?
- Can an attacker tamper with this data?
- Can an attacker deny this action?
- Can this component leak information?
- Can this component be denied service?
- Can an attacker elevate privilege through this component?

### Step 4: Assess Risk
For each identified threat, score it using likelihood and impact.

### Step 5: Define Mitigations
Map each threat to a specific countermeasure. Track mitigations as actionable tasks in the backlog.

## Risk Scoring: Likelihood x Impact

Use a simple 3x3 or 5x5 matrix:

| | Low Impact | Medium Impact | High Impact |
|---|-----------|---------------|-------------|
| **High Likelihood** | Medium | High | Critical |
| **Medium Likelihood** | Low | Medium | High |
| **Low Likelihood** | Low | Low | Medium |

- **Likelihood factors**: Attack complexity, required access level, availability of exploits, attacker motivation.
- **Impact factors**: Data sensitivity, financial loss, regulatory penalties, reputational damage, blast radius.

## The DREAD Model (Alternative Scoring)

Score each threat 1-10 on five dimensions, then average:
- **Damage**: How severe is the impact?
- **Reproducibility**: How reliably can the attack be repeated?
- **Exploitability**: How much skill/effort is required?
- **Affected Users**: How many users are impacted?
- **Discoverability**: How easy is the vulnerability to find?

DREAD is useful when STRIDE identifies many threats and you need to prioritize.

## Attack Surface Analysis

Enumerate all entry points an attacker could target:
- Public API endpoints (API Gateway, ALB)
- Authentication flows (Cognito hosted UI, custom login)
- File upload endpoints (S3 pre-signed URLs)
- WebSocket connections
- Third-party integrations (webhooks, OAuth callbacks)
- Administrative interfaces (console access, SSH, bastion)
- CI/CD pipelines (build scripts, deployment credentials)

Minimize attack surface: disable unused endpoints, restrict network access, apply least-privilege IAM.

## Mitigation Mapping

For each STRIDE category, common AWS mitigations include:

| Category | Mitigations |
|----------|-------------|
| Spoofing | Cognito + MFA, mutual TLS, API key rotation, IAM roles (no long-lived credentials) |
| Tampering | HTTPS everywhere, S3 Object Lock, DynamoDB encryption, request signing |
| Repudiation | CloudTrail logging, application audit logs, DynamoDB Streams for change history |
| Information Disclosure | Encryption at rest (KMS), VPC endpoints, security groups, suppress verbose errors |
| Denial of Service | WAF rate limiting, API Gateway throttling, Lambda reserved concurrency, Shield Advanced |
| Elevation of Privilege | Least-privilege IAM, ABAC policies, input validation, IDOR checks in application logic |

## When to Threat Model

- During design (Stage 3 of AI-DLC) before implementation begins.
- When adding a new external integration or data flow.
- When changing authentication or authorization mechanisms.
- After a security incident, to update the model with newly discovered threats.
- Review and refresh threat models at least annually.
