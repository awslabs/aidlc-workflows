# Services

## CalculatorService

**Purpose**: Orchestrates the request→compute→respond flow for all calculator operations. In this simple architecture, the "service" is effectively the Router layer itself — each route handler acts as a thin orchestrator that validates input, calls MathEngine, and wraps the response.

**Components used**: Router, MathEngine, Models

**Operations**:
- Accept HTTP request with operation name and parameters
- Validate request body against Pydantic schema (automatic via FastAPI)
- Extract operation parameters from validated model
- Invoke appropriate MathEngine method
- Catch domain errors (DomainError, DivisionByZero, Overflow)
- Wrap successful result in SuccessResponse envelope
- Wrap errors in ErrorResponse envelope

**Stories addressed**: S-1 through S-30 (all stories flow through this service pattern)

---

## Note on Service Layer

Given the simplicity of this system (stateless, single-step operations, no workflows spanning multiple components), a formal service layer is unnecessary. The route handlers themselves serve the orchestration role:

1. Request arrives → FastAPI validates against Pydantic model
2. Route handler extracts parameters → calls MathEngine function
3. MathEngine returns result or raises exception
4. Route handler wraps in response envelope → returns HTTP response

This is intentionally thin. There is no multi-step orchestration, no transaction management, no saga pattern — each operation is a single function call.
