# Workflow Rationale

intent: scientific-calculator-api
skill: workflow-composition
created: 2025-01-21T14:35:00Z

---

## Classification

- **Greenfield** single-component utility (CATALOGUE Example B)
- Single actor (HTTP client), single unit (sci-calc)
- Vision document provides exhaustive specification of all operations, schemas, and error handling
- Tech-env document specifies all technology decisions and NFRs

## Included Skills

### Inception Phase

- **Requirements analysis** — Always-on. Transforms the vision and tech-env into a structured requirements document that code-generation can consume. Even though the vision is detailed, requirements-analysis normalises it into the canonical format expected downstream.

### Construction Phase

- **Code generation** (per-unit: sci-calc) — Always-on. Produces the actual implementation, tests, and configuration files in the workspace. Uses requirements.md plus vision.md and tech-env.md as input.

## Skipped Skills

### Inception Phase

- **Reverse-engineering** — Greenfield project with no existing codebase and no integration targets.
- **User stories** — Single actor (any HTTP client), single interaction pattern (request/response). No personas, no complex journeys. The operations are self-evident from the API spec.
- **Wireframes** — No UI. This is a headless HTTP API.
- **Application design** — Single component (one FastAPI service). Project structure is fully specified in tech-env.md. No inter-component orchestration to design.
- **Units generation** — Exactly one unit (sci-calc) which is trivially obvious. No need for a formal decomposition step.

### Construction Phase

- **Functional design** — The business logic is mathematics — deterministic operations with well-defined semantics. Vision.md already specifies every endpoint, every input schema, every domain constraint, and every error case. A separate domain model adds no value.
- **NFR assessment** — All NFRs (latency, coverage, precision, startup time) and technology choices (Python 3.13, FastAPI, uv, pytest, ruff, hatchling) are explicitly specified in tech-env.md. No decisions remain.
- **NFR design** — No complex NFR patterns needed. The service is stateless with no caching, queuing, or resilience patterns required beyond basic error handling (already specified).
- **Infrastructure design** — No deployment architecture needed for MVP. Single process, no database, no external services, no containerisation specified.
- **Build and test** — Not yet implemented (🚧). Code-generation will produce tests; the human can run them manually.
