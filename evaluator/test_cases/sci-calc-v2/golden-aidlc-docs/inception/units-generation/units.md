# Units of Work

## Unit Inventory

| Unit ID | Unit | Purpose | Packaging Assumption | Components Owned |
|---|---|---|---|---|
| UNIT-001 | sci-calc | Stateless HTTP API for scientific math operations | module (single Python package, single process) | CMP-001, CMP-002, CMP-003, CMP-004, CMP-005, CMP-006, CMP-007, CMP-008 |

## Unit Details

### sci-calc

- **ID:** UNIT-001
- **Purpose:** Single deployable unit that serves the entire Scientific Calculator API — all math engines, the constants registry, conversions, and the HTTP routing layer.
- **Responsibilities:**
  - Expose all API endpoints (health, arithmetic, powers, trigonometry, logarithmic, statistics, constants, conversions)
  - Validate inputs via Pydantic models
  - Compute results via engine modules
  - Format responses into standard envelopes
  - Handle all error cases (domain, overflow, validation, not-found, internal)
- **Boundaries:** Does not persist data, does not authenticate users, does not communicate with external services.
- **Packaging assumption:** Single Python package (`sci_calc`) with module-per-domain structure. Deployed as a single uvicorn process.
- **Build independence:** Yes — no external dependencies beyond Python stdlib and FastAPI/Pydantic. Fully self-contained.
- **Change rate:** Moderate — new operations or conversion units may be added, but the structure is stable.

## Rationale for Single Unit

This system is:
1. A single process per explicit tech-env.md constraint
2. Stateless with no database, queue, or external service dependencies
3. Operated by a single team/person
4. Small enough to reason about completely in one codebase

Splitting into multiple units would add deployment complexity with zero benefit. Internal module separation (routes/, engine/, models/) provides sufficient code organization within the single unit.
