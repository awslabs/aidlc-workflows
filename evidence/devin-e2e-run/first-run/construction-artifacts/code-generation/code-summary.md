# Code Summary — Todo REST API

## Files Created

### Application Source
- `package.json` — Project manifest with Express dependency, npm scripts (start, dev, test)
- `vitest.config.js` — Vitest test runner configuration (Node environment)
- `.gitignore` — Ignores node_modules, data/, and SQLite database files
- `src/db.js` — SQLite database initialization and connection management (uses `node:sqlite`)
- `src/todoRepository.js` — Data access layer: createTodo, getAllTodos, getTodoById, updateTodo, deleteTodo
- `src/todoService.js` — Business logic: input validation for create and update operations
- `src/app.js` — Express application with CRUD routes, JSON parsing, error handling middleware
- `src/server.js` — Server startup with request logging middleware, graceful shutdown

### Test Files
- `tests/db.test.js` — Database initialization and schema tests (2 tests)
- `tests/todoRepository.test.js` — Repository CRUD operation tests (8 tests)
- `tests/todoService.test.js` — Validation logic tests (8 tests)
- `tests/app.test.js` — API endpoint integration tests (12 tests)

## Key Implementation Decisions

1. **`node:sqlite` (DatabaseSync) instead of `better-sqlite3`**: Node 26 ships a built-in SQLite module, avoiding native compilation issues. The API is similar to better-sqlite3 (synchronous, prepared statements).

2. **`createRequire` for SQLite import**: Vitest's Vite-based transform doesn't handle `node:` protocol imports. Using `createRequire("node:sqlite")` bypasses Vite's static analysis while keeping the runtime correct.

3. **Dependency injection of database instance**: `createApp(db)` accepts a database instance, allowing tests to inject in-memory databases (`:memory:`) for isolation.

4. **Centralized error handler**: A single Express error-handling middleware converts validation errors to 400, malformed JSON to 400, and unhandled errors to 500 with a generic message (no stack trace leakage).

5. **Test-after methodology**: Per the express scope's Minimal test strategy and the org-level test-after default, each layer was implemented first, then its tests were written and run.

## Test Coverage Summary

- **Total tests**: 30 (all passing)
- **db.test.js**: 2 tests — schema initialization, row persistence
- **todoRepository.test.js**: 8 tests — CRUD operations, missing-id handling
- **todoService.test.js**: 8 tests — create/update validation, error cases
- **app.test.js**: 12 tests — all 5 endpoints (happy path + error cases), 404 handling

## Deviations from Plan

- **Step 1 (package.json)**: Switched from `better-sqlite3` to `node:sqlite` (Node 26 built-in) because better-sqlite3's native build fails against Node 26's V8 API changes. This is a dependency change, not a scope change — SQLite is still the persistence layer.
- **Step 11 (Frontend behavior)**: Skipped as planned (no frontend in this scope).
