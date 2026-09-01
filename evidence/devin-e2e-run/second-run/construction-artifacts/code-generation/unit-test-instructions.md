# Unit Test Instructions — Todo REST API

**Stage**: code-generation
**Scope**: express | **Test Strategy**: Minimal
**Unit**: zero-Unit (stage-level)

## Test Framework

- **Framework**: Jest (via `npx jest`)
- **HTTP testing**: `supertest` for endpoint-level tests against the Express app
- **No mocking needed**: in-memory store is fast and isolated; tests reset state between cases

## How to Run This Unit's Tests

Exact command (runnable before the first test-after cycle):

```bash
npx jest tests/todos.test.js
```

This is scoped to this unit's single test file only. Build and Test will execute this command.

## Test Configuration

- Test file: `tests/todos.test.js`
- Setup: `beforeEach` clears the in-memory store between tests
- No external dependencies required (no database, no network)

## Expected Coverage

- **Minimal strategy**: one verifiable test per requirement, happy-path floor per component
- Target: ~10-15 tests covering all 6 FR sub-requirements + error shape
- No coverage percentage floor for express scope (Minimal strategy + no scope floor)

## Test Data Management

- Each test creates its own todo(s) via the API or store directly
- `beforeEach` resets the store to empty
- No shared state between tests

## Test Plan

| # | Test Name | Requirement | Layer |
|---|-----------|-------------|-------|
| 1 | POST /todos — creates todo with 201 and Location header | FR1.1 | API |
| 2 | POST /todos — 400 when title missing | FR1.1.1 | API |
| 3 | POST /todos — 400 when title empty string | FR1.1.1 | API |
| 4 | POST /todos — completed defaults to false | FR1.1.2 | API |
| 5 | GET /todos — returns 200 with array | FR1.2 | API |
| 6 | GET /todos — returns empty array when no todos | FR1.2 | API |
| 7 | GET /todos/:id — returns 200 with todo | FR1.3 | API |
| 8 | GET /todos/:id — returns 404 when not found | FR1.3 | API |
| 9 | PUT /todos/:id — updates title, returns 200 | FR1.4 | API |
| 10 | PUT /todos/:id — updates completed, returns 200 | FR1.4 | API |
| 11 | PUT /todos/:id — 404 when not found | FR1.4.3 | API |
| 12 | PUT /todos/:id — 400 when title is empty | FR1.4.1 | API |
| 13 | PUT /todos/:id — ignores unknown fields | FR1.4.2 | API |
| 14 | DELETE /todos/:id — returns 204 | FR1.5 | API |
| 15 | DELETE /todos/:id — 404 when not found | FR1.5 | API |
| 16 | Error responses use consistent JSON shape | FR1.6 | API |
