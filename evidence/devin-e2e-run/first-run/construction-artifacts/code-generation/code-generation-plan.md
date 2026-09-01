# Code Generation Plan — Todo REST API

## Testing Contract

```json
{
  "version": 1,
  "methodology": "test-after",
  "source": "org",
  "ordering": "implement each applicable testable layer, then write and run",
  "scope": "express",
  "test_strategy": "minimal",
  "project_type": "greenfield",
  "applicable_notes": [
    {
      "layer": "org",
      "text": "We treat tests as a first-class deliverable in every Bolt. The specific\nmethodology (TDD, BDD, ATDD, or classic test-after) is affirmed at\npractices-discovery and recorded in `team.md` under this heading with explicit\n`Methodology` and `Ordering` fields; Code Generation resolves those fields\nindependently from coverage, tooling, and scope notes.\n\nWhen no posture has been affirmed, our default per scope is:\n- **Methodology**: test-after\n- **Ordering**: implement each applicable testable layer, then write and run\n  that layer's tests.\n- `mvp`, `enterprise`, `feature`, `infra`, `classic` add an 80% line-coverage\n  floor and CI execution before merge.\n- `bugfix`, `security-patch` add a targeted regression for the specific\n  bug/vulnerability and require the existing suite to remain green.\n- `express` uses the Minimal strategy: requirement-driven unit tests (one per\n  requirement, with a happy-path floor per component); existing tests remain\n  green.\n- `poc`, `refactor`, `workshop` add no extra new-test floor and require the\n  existing suite to remain green.\n\nThe active `Test Strategy` still applies in every scope and determines test\nvolume/types. Scope floors are additive; they never reduce or replace the\nselected strategy.\n\nBuild and Test verifies defined coverage floors and affirmed quality targets;\nthey may not be weakened to make a step pass.\n\nAffirm a stricter posture in `team.md` if the team commits to one."
    }
  ],
  "obligations": {
    "strategy": "minimal",
    "strategy_volume": [
      "One verifiable test per requirement at the narrowest effective level.",
      "At least one happy-path unit test per component.",
      "Unit tests are the default; a bugfix/security scope floor may require an integration or E2E regression when that is the narrowest level that reproduces the defect."
    ],
    "scope_floor": [
      "Keep the existing test suite green.",
      "This scope adds no extra new-test floor beyond the selected test strategy."
    ],
    "combination_rule": "Apply every selected-strategy obligation and every scope-floor obligation; neither replaces the other, and a targeted scope regression may add the narrowest necessary test type beyond the strategy default."
  },
  "plan_profile": {
    "methodology": "test-after",
    "runner_step": "Bootstrap the minimal test runner/configuration and record the exact unit-scoped command.",
    "runner_ready_before_first_test": true,
    "testable_layers": [
      "Data model / database behavior",
      "Repository / data access",
      "Business logic",
      "API / endpoint",
      "Frontend behavior"
    ],
    "steps": [
      "Project structure and production configuration skeleton.",
      "Bootstrap the minimal test runner/configuration and record the exact unit-scoped command.",
      "Data model / database behavior - implement.",
      "Data model / database behavior - write and run its tests after implementation.",
      "Repository / data access - implement.",
      "Repository / data access - write and run its tests after implementation.",
      "Business logic - implement.",
      "Business logic - write and run its tests after implementation.",
      "API / endpoint - implement.",
      "API / endpoint - write and run its tests after implementation.",
      "Frontend behavior - implement.",
      "Frontend behavior - write and run its tests after implementation.",
      "Environment/build configuration.",
      "Documentation and traceability."
    ]
  },
  "input_sha256": "sha256:6cb23162168334768ff8f29699669845616670119c9eb58bf9bb05af6fefd3de",
  "contract_sha256": "sha256:87961b10de39c82b940231619501569dab05fb4d0ab228bedefaade334d20743"
}
```

## Plan Steps

### Step 1: Project structure and production configuration skeleton
- [ ] Create `package.json` with Express, better-sqlite3, and vitest dependencies
- [ ] Create project directory structure: `src/`, `tests/`
- [ ] Create `.gitignore` for node_modules and database files

### Step 2: Bootstrap the minimal test runner/configuration
- [ ] Create `vitest.config.js` with Node environment
- [ ] Verify `npx vitest run` executes (no tests yet, confirms runner)
- [ ] Exact test command: `npx vitest run tests/`

### Step 3: Data model / database behavior — implement
- [ ] Create `src/db.js` — SQLite database initialization, schema creation (todos table with id, title, description, completed, created_at, updated_at), and connection export
- [ ] Map to: FR1.1 (create), FR1.2 (list), FR1.3 (get by id), FR1.4 (update), FR1.5 (delete)

### Step 4: Data model / database behavior — write and run tests
- [ ] Create `tests/db.test.js` — test database initialization, schema creation, CRUD operations at the data layer
- [ ] Run: `npx vitest run tests/db.test.js`

### Step 5: Repository / data access — implement
- [ ] Create `src/todoRepository.js` — functions: createTodo, getAllTodos, getTodoById, updateTodo, deleteTodo
- [ ] Map to: FR1.1, FR1.2, FR1.3, FR1.4, FR1.5

### Step 6: Repository / data access — write and run tests
- [ ] Create `tests/todoRepository.test.js` — test each repository function (happy path + error cases)
- [ ] Run: `npx vitest run tests/todoRepository.test.js`

### Step 7: Business logic — implement
- [ ] Create `src/todoService.js` — validation logic (title required, updatable fields), delegates to repository
- [ ] Map to: FR2.1 (title validation), FR2.2 (updatable fields check), FR2.3 (malformed JSON)

### Step 8: Business logic — write and run tests
- [ ] Create `tests/todoService.test.js` — test validation, error handling
- [ ] Run: `npx vitest run tests/todoService.test.js`

### Step 9: API / endpoint — implement
- [ ] Create `src/app.js` — Express app with routes: POST /todos, GET /todos, GET /todos/:id, PUT /todos/:id, DELETE /todos/:id
- [ ] Create `src/server.js` — server startup, request logging middleware, error handling middleware
- [ ] Map to: FR1.1-FR1.5 (CRUD endpoints), FR2.1-FR2.3 (validation), FR3.1-FR3.3 (error handling)

### Step 10: API / endpoint — write and run tests
- [ ] Create `tests/app.test.js` — test each endpoint (happy path + error cases: 400, 404, 500)
- [ ] Run: `npx vitest run tests/app.test.js`

### Step 11: Frontend behavior — N/A
- [ ] No frontend in this scope — skipped

### Step 12: Environment/build configuration
- [ ] Add npm scripts: `start`, `test`, `dev` to package.json
- [ ] Create `.env.example` if needed (no env vars required for this scope)

### Step 13: Documentation and traceability
- [ ] Create inline API documentation comments
- [ ] Create `traceability.json` mapping requirements to implementation files
- [ ] Create `code-summary.md` documenting files created and key decisions

## Requirement-to-Step Traceability

| Requirement | Plan Step(s) | Implementation File(s) |
|-------------|-------------|----------------------|
| FR1.1 (POST /todos) | Steps 3, 5, 7, 9 | src/db.js, src/todoRepository.js, src/todoService.js, src/app.js |
| FR1.2 (GET /todos) | Steps 3, 5, 9 | src/db.js, src/todoRepository.js, src/app.js |
| FR1.3 (GET /todos/:id) | Steps 3, 5, 9 | src/db.js, src/todoRepository.js, src/app.js |
| FR1.4 (PUT /todos/:id) | Steps 3, 5, 7, 9 | src/db.js, src/todoRepository.js, src/todoService.js, src/app.js |
| FR1.5 (DELETE /todos/:id) | Steps 3, 5, 9 | src/db.js, src/todoRepository.js, src/app.js |
| FR2.1 (title validation) | Steps 7, 9 | src/todoService.js, src/app.js |
| FR2.2 (updatable fields) | Steps 7, 9 | src/todoService.js, src/app.js |
| FR2.3 (malformed JSON) | Step 9 | src/app.js |
| FR3.1 (error body shape) | Step 9 | src/app.js |
| FR3.2 (404 unmatched route) | Step 9 | src/app.js |
| FR3.3 (500 error handling) | Step 9 | src/app.js |
| NFR1 (response time) | Steps 3, 5, 9 | src/db.js, src/todoRepository.js, src/app.js |
| NFR2 (single command run) | Steps 1, 12 | package.json |
| NFR3 (unit tests) | Steps 4, 6, 8, 10 | tests/*.test.js |
| NFR4 (request logging) | Step 9 | src/server.js |
