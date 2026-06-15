# Contract Summary

## Overview

This system consists of a single deployable unit (UNIT-001: scientific-calculator-api). There are no inter-unit boundaries and therefore no inter-unit contracts to define.

## Inter-Unit Contracts

None. All component interactions within UNIT-001 are in-process Python function calls — no cross-unit boundaries exist.

## External API Contract

| Contract ID | Provider Unit | Provider Component | Consumer | Mechanism | Spec File | Owner |
|---|---|---|---|---|---|---|
| EXT-001 | UNIT-001 (sci-calc) | API Layer (CMP-008) | External HTTP clients | REST/HTTP (JSON) | contracts/openapi.yaml | sci-calc team |

The external API contract defines the HTTP interface that external consumers code against. It is documented as an OpenAPI 3.1 specification.

- **Envelope format:** Defined in requirements (FR-27, FR-28)
- **Error codes:** INVALID_INPUT (422), DIVISION_BY_ZERO (400), DOMAIN_ERROR (400), OVERFLOW (400), NOT_FOUND (404)
- **Versioning:** URL prefix `/api/v1/`

## Internal Component Contracts

Within the single unit, the API Layer (CMP-008) calls each engine via direct Python function calls. These are module-level interfaces, not formal contracts:

- API Router → Arithmetic Engine
- API Router → Powers Engine
- API Router → Trigonometry Engine
- API Router → Logarithmic Engine
- API Router → Statistics Engine
- API Router → Conversions Engine

**Interaction pattern:**
- Engine functions accept validated inputs and return a result value
- Error signaling: engines raise typed exceptions (DomainError, OverflowError) that the API Layer catches and translates to HTTP error responses
- No serialization boundary: data passes as Python objects, not JSON

These internal interfaces will be formally defined as Python module interfaces in functional-design.

## Contract Ownership Rules

- Provider (UNIT-001) owns the external API spec
- Versioning via URL prefix (`/api/v1/`) — breaking changes require a new version (semver major bump)
- Additive changes (new operations, new conversion units, new optional fields) are non-breaking
- Response envelope shape is immutable within a version
- Removing endpoints, changing response shapes, or altering error codes constitutes a breaking change

## Open Questions

None — the API specification is fully defined in the intent document and will be formalised in `contracts/openapi.yaml`.
