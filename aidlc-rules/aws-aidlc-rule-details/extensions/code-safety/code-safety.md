# Code Safety Extension

**Extension ID**: `CODE-SAFETY`
**Category**: `code-safety`
**Phase Coverage**: CONSTRUCTION (Code Generation)

---

## Core Principle: Prevent Silent Failures

These rules address classes of bugs that compile successfully, pass superficial review, and fail silently at runtime. Each rule was derived from real production incidents where generated code had structural correctness but behavioral incorrectness.

---

## Rule CODE-SAFETY-001: Middleware and Request-Context Safety

**Applies to**: CONSTRUCTION → Code Generation (per-unit)
**Trigger**: Unit generates route handlers, controllers, or any code that accesses request-scoped properties populated by middleware, interceptors, or filters

When generating route handlers, controllers, or any code that accesses request-scoped properties:

- **Trace every property access**: For each request-scoped property read by handler code (e.g., authenticated user, parsed body, session data, tenant context), verify the middleware/interceptor that populates it is in the handler's execution chain
- **Route-level vs global application**: If a middleware is applied per-route (not globally), verify it is explicitly attached to every route that depends on it
- **No implicit assumptions**: Never assume a property exists on the request object without confirming the populating middleware is active. If the property is optional, guard access with a null/undefined check

---

## Rule CODE-SAFETY-002: Configuration and Environment Isolation

**Applies to**: CONSTRUCTION → Code Generation (per-unit)
**Trigger**: Unit generates configuration modules that load environment variables from files or external sources

When generating configuration modules:

- **Exclude the test environment**: Configuration loaders MUST NOT automatically load environment files (`.env`, `application.properties`, `appsettings.json`, etc.) when the application is running in test mode. Tests must control their own environment to avoid production/development values leaking into test execution
- **Guard pattern**: Use an environment check (e.g., `if not test mode then load env file`) so that test frameworks provide their own values via setup files or test configuration
- **Document the split**: If the test setup file must load specific configuration values for tests, document this in the test setup file with a comment explaining what it overrides and why

---

## Rule CODE-SAFETY-003: Test Mock Lifecycle

**Applies to**: CONSTRUCTION → Code Generation (per-unit)
**Trigger**: Unit generates test files that use module mocking, dependency injection overrides, or test doubles

When generating test files:

- **Module reset invalidates all references**: If a test resets the module registry (e.g., clears cached modules to get fresh instances), ALL mock references captured before the reset are stale. Re-acquire every mock reference after the reset inside the per-test setup hook — never at module scope
- **Distinguish clearing vs resetting**: Clearing mocks resets call history but preserves configured return values. Resetting mocks restores them to their default (unconfigured) state. Use the appropriate operation based on whether the next test needs a clean slate or just clean call counters
- **Auto-mock preserves only surface shape**: When using automatic/implicit mocking of a module, the mock replaces ALL exports with no-op stubs — including class constructors, error subclasses, and factory functions. If test code or source code relies on real behavior of any export (e.g., `instanceof` checks, error class hierarchies, static properties), use a manual mock factory that preserves real implementations for those specific exports via the test framework's `requireActual` equivalent
- **Mock scope matches lifecycle**: Mocks configured in per-test setup should not leak to subsequent tests. If a mock configures a rejection or error return, verify the next test either resets that mock or re-configures it — stale error mocks cause cascading false failures

---

## Rule CODE-SAFETY-004: Pagination and Bounded-Query Safety

**Applies to**: CONSTRUCTION → Code Generation (per-unit)
**Trigger**: Unit generates code that reads collections from data stores, APIs, or file systems

When generating code that reads collections:

- **Never assume a single-page response**: If the data access API supports pagination (cursors, tokens, page numbers, offsets), the implementation MUST consume all pages unless the design explicitly specifies otherwise with documented justification
- **Detect and act on continuation tokens**: If the API returns a continuation indicator (next token, last evaluated key, `hasMore` flag, `Link: rel=next` header), the code must loop until exhausted — not just log a warning
- **Test with multi-page data**: When generating test mocks for paginated APIs, include at least one test case that returns multiple pages to verify the pagination loop works end-to-end

---

## Rule CODE-SAFETY-005: Error Serialization Consistency

**Applies to**: CONSTRUCTION → Code Generation (per-unit)
**Trigger**: Unit generates error handling infrastructure (error classes, error middleware, exception filters, error boundaries)

When generating error handling:

- **Serialize all semantic fields**: If the error class defines machine-readable fields beyond message and status (e.g., error code, error type, validation details, correlation ID), the error handler/serializer MUST include them in the HTTP/API response. A field defined on the error class but absent from the response is a contract gap
- **Test the serialization shape**: Error handler tests must assert the full response body shape (all fields), not just the HTTP status code. A test that verifies `status = 404` but ignores whether `code = "NOT_FOUND"` is in the body misses serialization bugs

---

## Rule CODE-SAFETY-006: Post-Refactor Test Alignment

**Applies to**: CONSTRUCTION → Code Generation (per-unit)
**Trigger**: A source file is modified during code generation (including fixes, refactors, or API changes within the same unit)

When a source file is modified:

- **Grep all test files**: After changing any function signature, method name, return type, dependency call, or module export, search all test files that reference the changed identifier
- **Update stale mocks**: If the change alters which dependency methods are called (e.g., switching from one adapter method to another), update all test mocks that stub the old method to stub the new one instead
- **Run affected tests immediately**: After updating test files to match the refactored source, execute those tests before proceeding to the next code generation step

---

## Extension Compliance Summary Format

When presenting stage completion, include:

```markdown
### Code Safety Extension Compliance
- **CODE-SAFETY-001**: [COMPLIANT — middleware chain verified] or [N/A — no route handlers]
- **CODE-SAFETY-002**: [COMPLIANT — test env isolated] or [N/A — no config loaders]
- **CODE-SAFETY-003**: [COMPLIANT — mock lifecycles correct] or [N/A — no test mocks]
- **CODE-SAFETY-004**: [COMPLIANT — pagination consumed fully] or [N/A — no paginated reads]
- **CODE-SAFETY-005**: [COMPLIANT — all error fields serialized] or [N/A — no error infrastructure]
- **CODE-SAFETY-006**: [COMPLIANT — tests aligned after refactors] or [N/A — no mid-stage refactors]
```
