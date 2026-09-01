# Unit Test Instructions — Todo REST API

## Test Framework
- **Framework**: Vitest (lightweight, fast, Node-native)
- **Configuration**: `vitest.config.js` with `environment: 'node'`

## How to Run This Unit's Tests

### Exact test command (runnable before first test cycle):
```bash
npx vitest run tests/
```

### Individual test files:
```bash
npx vitest run tests/db.test.js
npx vitest run tests/todoRepository.test.js
npx vitest run tests/todoService.test.js
npx vitest run tests/app.test.js
```

## Test Scope (Minimal Strategy)

Per the express scope's Minimal test strategy:
- **Requirement-driven unit tests**: 1 test per requirement at the narrowest effective level
- **Happy-path floor**: At least 1 happy-path test per component
- **Unit tests are the default**
- **~10-15 tests total** across all components

## Expected Coverage

| Component | Test File | Tests | Coverage |
|-----------|-----------|-------|----------|
| Database (src/db.js) | tests/db.test.js | 2 | DB init, schema creation |
| Repository (src/todoRepository.js) | tests/todoRepository.test.js | 5 | CRUD operations (1 per requirement) |
| Service (src/todoService.js) | tests/todoService.test.js | 3 | Validation, error handling |
| API/Express (src/app.js) | tests/app.test.js | 5 | Endpoint tests (1 per endpoint) |

## Mocking/Stubbing Guidance
- Use in-memory SQLite database for testing (`:memory:` or temp file)
- No external service mocking needed (no auth, no external APIs)
- Use `supertest` or direct Express app injection for API tests

## Test Data Management
- Each test should create its own todo items and clean up after
- Use a fresh in-memory database per test file via `beforeEach`/`beforeAll`
- No shared state between test files
