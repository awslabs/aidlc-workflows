# Units of Work

## Unit Inventory

| Unit ID | Unit | Purpose | Packaging Assumption | Components Owned |
|---|---|---|---|---|
| UNIT-001 | scientific-calculator-api | Stateless HTTP API providing scientific math operations | module (single FastAPI application) | CMP-001, CMP-002, CMP-003, CMP-004, CMP-005, CMP-006, CMP-007 |

## Unit Details

### scientific-calculator-api

- **ID:** UNIT-001
- **Purpose:** Single deployable service that exposes all scientific calculator operations via HTTP
- **Responsibilities:**
  - Receive and validate HTTP requests for math operations
  - Route to the appropriate computation engine
  - Perform arithmetic, powers, trigonometry, logarithmic, statistics, and conversion calculations
  - Return structured JSON success/error response envelopes
  - Serve mathematical constants
  - Report health status
- **Boundaries:** No persistent storage, no authentication, no UI, no background processing, no external service calls
- **Packaging assumption:** Single Python package deployed as one FastAPI application with internal module structure mirroring components
- **Build independence:** Fully self-contained — no external unit dependencies; all math uses Python stdlib
- **Change rate:** Uniform across all components — new operations or categories may be added, but all share the same release cycle

## Internal Module Structure

The single unit organises components as internal modules:

```
scientific-calculator-api/
├── app/
│   ├── main.py              (API Gateway — app factory, error handlers, health)
│   ├── routers/
│   │   ├── arithmetic.py    (CMP-001)
│   │   ├── powers.py        (CMP-002)
│   │   ├── trigonometry.py  (CMP-003)
│   │   ├── logarithmic.py   (CMP-004)
│   │   ├── statistics.py    (CMP-005)
│   │   ├── constants.py     (CMP-006)
│   │   └── conversions.py   (CMP-007)
│   ├── services/
│   │   ├── arithmetic.py
│   │   ├── powers.py
│   │   ├── trigonometry.py
│   │   ├── logarithmic.py
│   │   ├── statistics.py
│   │   ├── constants.py
│   │   └── conversions.py
│   ├── models/
│   │   ├── requests.py      (Pydantic input models)
│   │   └── responses.py     (envelope models)
│   └── errors.py            (domain exceptions + handlers)
├── tests/
├── pyproject.toml
└── README.md
```

## Rationale

A single unit is appropriate because:
1. All components share the same deployment lifecycle (one API process)
2. No component has a distinct scaling need (all are stateless, CPU-bound computation)
3. No team boundary splits exist (single developer/team owns everything)
4. The system is explicitly out-of-scope for production infrastructure concerns (auth, rate-limiting, deployment)
5. Internal modularity is maintained through Python module separation — components remain logically bounded even within one unit

Splitting into multiple units would add deployment complexity with zero benefit.
