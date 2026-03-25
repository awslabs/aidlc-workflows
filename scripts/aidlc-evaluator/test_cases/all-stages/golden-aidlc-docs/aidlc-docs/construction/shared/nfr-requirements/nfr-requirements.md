# NFR Requirements — Both Services

## Performance Requirements

| Requirement | Target | Applies To |
|---|---|---|
| API response time (p95) | < 100ms | Both services |
| Full-text search latency | < 200ms | Catalog Service |
| Concurrent users | 100 simultaneous | Both services |
| Cold start tolerance | < 3 seconds | Both services |

## Availability Requirements

| Requirement | Target |
|---|---|
| API uptime | 99.9% |

## Security Requirements

| Requirement | Detail |
|---|---|
| Authentication | Application-level JWT (PyJWT + bcrypt) |
| Authorization | RBAC with Admin, Librarian, Member roles |
| Password storage | bcrypt adaptive hashing |
| Token expiry | 24 hours, no refresh tokens (MVP) |
| Encryption at rest | Required for all data stores |
| Encryption in transit | TLS 1.2+ |
| PII protection | Member email/name must not appear in logs |
| Input validation | Pydantic models with length constraints on all endpoints |
| CORS | Restricted origins (configurable, no wildcard on authenticated endpoints) |

## Testing Requirements

| Test Type | Target |
|---|---|
| Unit test coverage | >= 90% line coverage per service |
| Integration tests | All API endpoints tested |
| Auth testing | Both authorized and unauthorized access per endpoint |

## Scalability

- Each service scales independently
- Catalog: optimized for read-heavy (search/browse)
- Lending: optimized for write-heavy (checkouts/returns)
- Single-library deployment for MVP
- Target: 10,000 books, 2,000 members

## Database Decision

**Decision: In-memory repositories with abstract base class for MVP development and testing.**

**Rationale:**
- Tech-env deferred database choice (DynamoDB vs PostgreSQL) to NFR stages
- CDK infrastructure is deferred — no cloud database will be provisioned
- For local development and testing, in-memory repositories provide zero-dependency operation
- Abstract repository pattern allows swapping to DynamoDB or PostgreSQL via concrete implementation later
- In-memory approach is consistent with the "application code only" MVP scope
- All business logic and API behavior is fully testable without external dependencies

**Repository Pattern:**
- `BaseRepository` (abstract) defines the interface (create, get, list, update, delete, search)
- `InMemoryRepository` implements using Python dicts — used for development and testing
- Future: `DynamoDBRepository` or `PostgresRepository` can be added as drop-in replacements

## Authentication Decision

**Decision: Application-level JWT with PyJWT + passlib[bcrypt]**

**Rationale:**
- Simpler than Cognito for MVP
- No external dependency (no AWS account needed to run tests)
- Both services validate JWTs independently using a shared secret
- JWT secret stored in configuration (environment variable for local dev, Secrets Manager for prod)

## Structured Logging

- Python `logging` module with JSON formatter
- Fields: timestamp, correlation_id (request ID), level, message, service_name
- PII filtering: strip member email and name from log output
- Log to stdout (CloudWatch compatible when deployed)
