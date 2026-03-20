# Technical Environment: BookShelf Community Library API

## Project Technical Summary

- **Project Name**: BookShelf
- **Project Type**: Greenfield
- **Primary Runtime Environment**: Cloud (AWS)
- **Cloud Provider**: AWS
- **Package Manager**: uv
- **Team Size**: 1 (solo developer)
- **Team Experience**: Strong Python backend experience. Familiar with FastAPI and pytest. Moderate AWS experience. Limited CDK experience.

---

## Programming Languages

### Required Languages

| Language | Version | Purpose | Rationale |
|----------|---------|---------|-----------|
| Python | 3.13+ | API services, business logic, infrastructure as code | Primary language. Rich ecosystem. Fast development. |

### Permitted Languages

| Language | Conditions for Use |
|----------|-------------------|
| TypeScript | Approved for CDK infrastructure only, if developer prefers CDK in TypeScript over Python CDK |

### Prohibited Languages

| Language | Reason |
|----------|--------|
| Java | Excessive for this project scope |
| Go | No team expertise |
| Ruby | No team expertise |

---

## Frameworks and Libraries

### Required Frameworks

| Framework/Library | Version | Domain | Rationale |
|-------------------|---------|--------|-----------|
| FastAPI | 0.115+ | REST API framework | Automatic validation, OpenAPI generation, async support |
| Pydantic | 2.x | Request/response models | Type-safe data validation, JSON serialization |
| uvicorn | 0.34+ | ASGI server (local dev) | Standard FastAPI server |
| pytest | 8.x | Unit testing | Test runner |
| pytest-asyncio | 0.24+ | Async test support | FastAPI test client requires async |
| httpx | 0.28+ | Test HTTP client | Async test client for FastAPI |
| pytest-cov | 6.x | Coverage reporting | Enforce coverage minimum |
| ruff | 0.9+ | Linting and formatting | Single tool for lint + format |
| AWS CDK | 2.x | Infrastructure as Code | All infrastructure defined in code |

### Prohibited Libraries

| Library | Reason | Use Instead |
|---------|--------|-------------|
| Flask, Django | Project uses FastAPI | FastAPI |
| requests | Blocks async event loop | httpx |
| pandas, numpy | Not needed for this project | Standard Python |
| pip, poetry, pipenv | Project uses uv exclusively | uv |
| black, flake8, isort | Replaced by ruff | ruff |

---

## Cloud Environment

### Cloud Provider

- **Primary Provider**: AWS
- **Region**: us-east-1

### Approved Service Categories

The following categories of AWS services are approved for use. The specific
service choices within each category should be determined during the NFR
Requirements and Infrastructure Design stages based on the system's actual
performance, scalability, and cost requirements.

| Category | Guidance |
|----------|----------|
| Compute | Serverless preferred (Lambda) but containers (ECS Fargate) acceptable if cold-start latency or execution duration is a concern. Decision should be justified during Infrastructure Design. |
| API Layer | API Gateway (HTTP API preferred over REST API for cost and simplicity) |
| Data Storage | Choose based on access patterns determined during Functional Design. Options: DynamoDB (key-value/document), RDS PostgreSQL (relational queries). Each service must own its data. |
| Messaging | Asynchronous inter-service communication required. Evaluate SQS, SNS, or EventBridge during Infrastructure Design based on messaging patterns. |
| Authentication | AWS Cognito or application-level JWT — decide during NFR Requirements |
| Monitoring | CloudWatch for logs, metrics, and alarms |
| Secrets | AWS Secrets Manager for sensitive configuration |
| IaC | AWS CDK (Python preferred) |

### Service Disallow List

| Service | Reason |
|---------|--------|
| Amazon EC2 (direct) | Prefer managed compute (Lambda or Fargate) |
| AWS Elastic Beanstalk | Does not fit IaC workflow |

---

## API Design Standards

- **Style**: REST with JSON
- **Versioning**: URL path prefix (`/api/v1/`)
- **Naming Convention**: snake_case for JSON fields

### Response Envelope

**Success:**
```json
{ "status": "ok", "data": { ... } }
```

**Error:**
```json
{ "status": "error", "error": { "code": "ERROR_CODE", "message": "Human-readable message" } }
```

| Error Code | HTTP Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | Request body fails Pydantic validation |
| `NOT_FOUND` | 404 | Resource does not exist |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Valid token but insufficient role |
| `CONFLICT` | 409 | Business rule violation (e.g., checkout limit exceeded, duplicate hold) |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Security Requirements

### Authentication and Authorization

- **Authorization Model**: Role-based access control (RBAC) with three roles:
  - **Admin**: Full access to all endpoints
  - **Librarian**: Catalog management, lending operations, reports
  - **Member**: Self-service borrowing (own checkouts, holds, fees)
- **Public Endpoints**: Registration, login, health check
- **Authentication mechanism**: To be determined during NFR Requirements stage. Options include Cognito user pools or application-level JWT with PyJWT + passlib/bcrypt.

### Data Protection

- **Encryption at Rest**: Required for all data stores
- **Encryption in Transit**: TLS 1.2+ required for all communications
- **Password Storage**: Must use adaptive hashing (bcrypt or argon2). Never store plaintext.
- **PII**: Member email and name are PII. Must not appear in log output.

### Input Validation

- **All inputs validated by Pydantic models** before reaching business logic
- **String length limits**: enforce reasonable maximums on all string fields
- **Numeric bounds**: enforce non-negative constraints on counts and amounts

### Secrets Management

- **No secrets in source code or environment variables**
- **Use AWS Secrets Manager** for signing keys and sensitive config

---

## Testing Requirements

### Test Strategy Overview

| Test Type | Required | Coverage Target | Tooling |
|-----------|----------|----------------|---------|
| Unit Tests | Yes | 90% line coverage minimum | pytest |
| Integration Tests | Yes | All API endpoints per service | pytest + httpx AsyncClient |
| Contract Tests | Yes | All endpoints in openapi.yaml | contracttest runner |
| Load Tests | Recommended | Validate performance targets | k6 |

### Unit Testing Standards

- **Coverage Minimum**: 90% line coverage
- **Mocking Policy**: Mock external dependencies (databases, other services). Do not mock business logic.
- **Naming Convention**: `test_{module}_{scenario}` (e.g., `test_checkout_exceeds_limit`)
- **Test Location**: `tests/` directory at project root

### Integration Testing Standards

- **Scope**: Test all API endpoints via httpx AsyncClient
- **Data Management**: Fresh isolated data store per test function
- **Auth Testing**: Test both authorized and unauthorized access for each endpoint

---

## Non-Functional Requirements

These are business-level targets. The specific technical patterns and
infrastructure choices to meet these targets should be determined during the
NFR Requirements, NFR Design, and Infrastructure Design stages.

| Requirement | Target | Notes |
|---|---|---|
| Response latency (p95) | < 100ms | Applies to both services under normal load |
| Concurrent users | 100 simultaneous | Both services must handle this without degradation |
| API uptime | 99.9% | Requires redundancy and health monitoring |
| Test coverage | >= 90% line coverage | Per service |
| Catalog search latency | < 200ms for full-text search | May require specific data store indexing strategy |
| Inter-service event processing | < 5 seconds end-to-end | From book return to hold status update |
| Cold start tolerance | Acceptable if < 3 seconds | Influences compute choice (Lambda vs containers) |
| Data isolation | Each service owns its data store | No shared databases between services |
| Python version | 3.13.x | Enforced via `requires-python = ">=3.13"` |

---

## Development Workflow

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format .
```
