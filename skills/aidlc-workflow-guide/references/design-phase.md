# Design Phase Support Guide
## Application Design + Units Generation

---

## Purpose of This Phase

Convert requirements into **an implementable architecture and work units**.
Bridge from "what to build" to "how to build it."

---

## How to Conduct Application Design

### Component Design Principles

- **Single Responsibility**: Each component has only one responsibility
- **High Cohesion / Low Coupling**: Components are tightly related internally, loosely coupled to each other
- **Direction of Dependencies**: Higher layers depend on lower layers (avoid the reverse)

### components.md Template

```markdown
# Component Design

## [Component Name]

**Responsibility**: [One sentence description of what this component does]

**Input**:
- [Input data / events]

**Output**:
- [Output data / events]

**Dependent Components**:
- [Name of dependent component]

**AWS Service Mapping**:
- [Corresponding AWS service]
```

### services.md Template

```markdown
# Service Definition

## [Service Name]

**Type**: [REST API / GraphQL / Event-driven / Batch]
**Endpoint**: [URL / ARN / Topic name]
**Port**: [Port number (for local development)]

**Provided Interfaces**:
| Method | Path | Description |
|---------|------|------|
| GET | /resource | Get resource list |
| POST | /resource | Create resource |

**Components Used**:
- [Component name]
```

### AWS Architecture Selection Guide

Select AWS services during design using the following criteria.
Delegate detailed design to the `aws-specialist` agent:

**Compute Selection Flow**:
```
Event-driven / short-duration processing → Lambda
Containers / long-duration processing    → Fargate / ECS
Always-on / high customization           → EC2
Fully managed containers                 → App Runner
```

**Data Store Selection Flow**:
```
Flexible schema / scalable          → DynamoDB
Relational / transactional          → Aurora Serverless
Globally distributed queries        → Aurora DSQL
Search / aggregation                → OpenSearch
Caching                             → ElastiCache
```

---

## How to Conduct Units Generation

### Characteristics of a Good Unit of Work

1. **Independently implementable and testable**: Can be developed without other Units being complete
2. **Clear scope**: What is and is not included is unambiguous
3. **Appropriate granularity**: Completable in 1–3 days (even smaller for hackathons)
4. **Clear DoD (Definition of Done)**: Completion criteria can be objectively assessed

### unit-of-work.md Template

```markdown
# Unit of Work Definition

## Unit List

| ID | Unit Name | Priority | Estimate | Depends On |
|----|--------|--------|---------|---------|
| U-01 | [Name] | High | 4h | None |
| U-02 | [Name] | High | 6h | U-01 |
| U-03 | [Name] | Medium | 8h | U-01 |

---

## U-01: [Unit Name]

**Scope**:
- Included: [Features, files, API endpoints, etc.]
- Excluded: [Explicitly excluded scope]

**Tech Stack**:
- Language: [TypeScript / Python / etc.]
- Framework: [Hono / Fastify / etc.]
- AWS Services: [Lambda / DynamoDB / etc.]

**Definition of Done**:
- [ ] [Testable completion condition 1]
- [ ] [Testable completion condition 2]
- [ ] Unit test coverage 80% or higher
- [ ] Deployable via CDK

**Interface Definition**:
[API / events provided and consumed by this Unit]
```

### Example Unit Decomposition Strategy

Consider the following example Unit structure:

```
U-01: Auth / Foundation Infrastructure (implement first)
  - AWS Cognito + API Gateway + DynamoDB table definitions
  - CDK stack basic setup

U-02: Core API (core business logic)
  - Core business logic
  - Lambda functions + DynamoDB operations

U-03: Frontend
  - React/Next.js + Amplify
  - Integration with Core API

U-04: AI/ML features (if applicable)
  - Bedrock integration
  - Generative AI feature enhancements
```

### unit-of-work-dependency.md Template

```markdown
# Unit Dependency Matrix

## Dependency Diagram

\`\`\`mermaid
graph TD
    U01[U-01: Auth/Foundation] --> U02[U-02: Core API]
    U01 --> U03[U-03: Frontend]
    U02 --> U03
    U02 --> U04[U-04: AI Features]
\`\`\`

## Recommended Implementation Order

1. U-01 (no dependencies)
2. U-02 (after U-01 is complete)
3. U-03 + U-04 (can be done in parallel, after U-02 is complete)
```

---

## Design Review Checklist

After completing design, verify:

**Architecture**
- [ ] All functional requirements are assigned to components
- [ ] No single point of failure (SPOF)
- [ ] AWS multi-AZ and managed services are being utilized

**Unit Decomposition**
- [ ] Each Unit has a DoD defined
- [ ] Unit dependencies are not circular
- [ ] The first Unit to implement is clear (shortest path to MVP)

**Security (Design-time verification)**
- [ ] Authentication and authorization design is included
- [ ] Secret management policy is defined
- [ ] IAM is designed with least privilege principle
