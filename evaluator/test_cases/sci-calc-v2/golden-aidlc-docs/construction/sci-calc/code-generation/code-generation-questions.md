# Code Generation Questions

Skill: aidlc-code-generation
Unit: sci-calc
Status: answered
Date: 2025-01-21T15:53:00Z

---

### Q1: Error handling implementation pattern — should domain errors be raised as custom exceptions in the engine layer and caught in routes, or should the engine return result objects (e.g., a union/discriminated type)?

a) Custom exception classes (e.g., `DomainError`, `OverflowError`, `DivisionByZeroError`) raised in `math_engine.py` and caught by a global exception handler in FastAPI
b) Engine functions return a result wrapper (e.g., `Result[T]` or `tuple[value, error]`) that routes inspect before building the response
c) Engine functions raise standard Python exceptions (`ValueError`, `ZeroDivisionError`) and a middleware maps them to the structured error codes
d) Other

**Trade Offs:** Option (a) provides clean separation — engine code raises meaningful exceptions, routes stay thin, and a single exception handler builds the error envelope. Option (b) avoids exceptions for control flow but adds boilerplate in every route. Option (c) reuses Python's built-in exceptions but risks catching unintended errors.

**Recommendation:** Option (a) — custom exception hierarchy. This is the most Pythonic pattern for FastAPI projects: define a base `CalculatorError` with subclasses for each error code, register a single `@app.exception_handler(CalculatorError)` that formats the envelope. Routes stay clean and the engine remains framework-agnostic.

[Answer]: A

---

### Q2: Response envelope construction — where should the envelope wrapping logic live?

a) Each route function manually constructs the envelope dict/model
b) A shared helper function or response model that all routes call (e.g., `build_success_response(operation, inputs, result)`)
c) A FastAPI middleware/dependency that intercepts raw return values and wraps them
d) Other

**Trade Offs:** Option (a) is explicit but repetitive across 40+ endpoints. Option (b) keeps routes concise with a single helper and is easy to test. Option (c) is elegant but adds complexity and makes response structure implicit.

**Recommendation:** Option (b) — a shared helper function/response factory. Each route calls `success_response(operation=..., inputs=..., result=...)` which returns the Pydantic model. Minimal repetition, explicit, easily testable.

[Answer]: B

---

### Q3: Test strategy for code generation — what level of tests should be generated alongside the code?

a) Unit tests only (test `math_engine.py` functions directly with known-value tables)
b) Integration tests only (test via `httpx.AsyncClient` against the FastAPI app)
c) Both unit tests AND integration tests in the same layer where the code is generated
d) Unit tests in the engine layer, integration tests in the API layer (split across layers)

**Trade Offs:** Option (c) generates all tests immediately but may create large layers. Option (d) aligns with the layered strategy — engine tests when the engine is built, API tests when routes are built — keeping each layer focused and under the 5-8 file limit.

**Recommendation:** Option (d) — split by layer. Unit tests for `math_engine.py` are generated in the business logic layer. Integration tests (via httpx) are generated in the API routes layer. This keeps layers small and each layer independently verifiable.

[Answer]: D

---

### Q4: Logging approach — what logging level and library should be used?

a) Python's built-in `logging` module with a simple StreamHandler; log at WARNING+ for errors and INFO for startup
b) `structlog` for structured JSON logging
c) No logging beyond what FastAPI/uvicorn provides by default; defer logging decisions to a later stage
d) Other

**Trade Offs:** The requirements (FR-53) say "log unexpected exceptions at ERROR level." Option (a) satisfies this with zero additional dependencies. Option (b) is more production-ready but adds a dependency not mentioned in tech-env.md. Option (c) doesn't satisfy FR-53.

**Recommendation:** Option (a) — Python's built-in `logging` module. It satisfies FR-53, requires no additional dependencies, and aligns with the project's "use stdlib" philosophy. Configure at module level with a simple format.

[Answer]: A

---

### Q5: How should the `math_engine.py` module be structured internally — single module with all operations, or split into sub-modules under `engine/`?

a) Single `math_engine.py` file containing all operation functions (arithmetic, trig, log, stats, conversions, etc.)
b) Multiple sub-modules under `engine/` (e.g., `engine/arithmetic.py`, `engine/trigonometry.py`, `engine/logarithmic.py`, `engine/statistics.py`, `engine/conversions.py`, `engine/constants.py`)
c) Other

**Trade Offs:** Option (a) matches the tech-env.md project structure exactly (shows single `math_engine.py`). Option (b) is more maintainable for 50+ functions but deviates from the documented structure.

**Recommendation:** Option (a) — follow the documented project structure in tech-env.md exactly. The file will be moderately large but keeps the implementation aligned with the specification. If it grows unwieldy during generation, we can split as a follow-up.

[Answer]: A

---

### Q6: Layer ordering preference for this specific project — the tech-env.md shows a Layered/MVC-like structure. Confirm the proposed layer breakdown:

a) Layer 1: Models (Pydantic request/response models + error classes) → Layer 2: Engine (math_engine.py + unit tests) → Layer 3: API Routes (all route files + integration tests) → Layer 4: App Wiring (app.py, exception handlers, health endpoint, configuration)
b) Layer 1: Models + Engine → Layer 2: API Routes → Layer 3: App Wiring + Tests
c) Layer 1: Models + Error classes + App scaffold → Layer 2: Engine + Engine tests → Layer 3: Routes (arithmetic, powers, trig) + Route tests → Layer 4: Routes (log, stats, constants, conversions) + Route tests
d) Other

**Trade Offs:** Option (a) has 4 clear layers each under 8 files but defers all tests to their respective layers. Option (c) splits routes across two layers to stay under the file limit (7 route files + 7 test files = 14 would exceed the limit if combined). Option (b) combines too much.

**Recommendation:** Option (c) — this respects the "5-8 files per layer, max 12" rule. With 7 route files and 7 corresponding test files, we must split routes into two layers. The models+scaffold layer stays small and independently buildable.

[Answer]: C

---

### Q7: Should the generated project include a `README.md` and/or `Makefile`/scripts for developer convenience, or keep it strictly to application code and tests?

a) Include a `README.md` with setup instructions, API overview, and run commands
b) Include `README.md` + a `Makefile` with common targets (serve, test, lint, format)
c) No README or Makefile — only application code and tests; documentation is in aidlc-docs/
d) Other

**Trade Offs:** Option (a) and (b) improve developer experience but add files outside the core application. The validation spec focuses on application code traceability; extra docs are neutral. Tech-env.md already documents the dev workflow commands.

**Recommendation:** Option (a) — a concise `README.md` is standard for any project and costs almost nothing. Skip the Makefile since `uv run` commands are already simple enough.

[Answer]: A
