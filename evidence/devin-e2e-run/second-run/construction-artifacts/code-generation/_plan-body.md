

## Requirements Summary

Source: `aidlc/spaces/default/intents/260831-todo-api/inception/requirements-analysis/requirements.md`

- **FR1.1** — `POST /todos` create (201 + Location header; title required non-empty; completed defaults false; id server-generated)
- **FR1.2** — `GET /todos` list (200 + array, empty `[]` when none)
- **FR1.3** — `GET /todos/{id}` read single (200 or 404)
- **FR1.4** — `PUT /todos/{id}` partial update (200 or 404; title non-empty if supplied; unknown fields ignored)
- **FR1.5** — `DELETE /todos/{id}` delete (204 or 404)
- **FR1.6** — Consistent JSON error shape `{ "error": string, "details"?: string }`
- **NFR1** — < 100ms response on local machine
- **NFR2** — Clean start with empty list; no crash on empty store
- **NFR3** — Console logging: method, path, status, response time ms
- **NFR4** — Storage layer separable from route handlers

## Implementation Steps

Applicable layers from the Testing Contract: Data model, Repository/data access, Business logic, API/endpoint. Frontend behavior is not applicable (REST API only). Test-after ordering: implement each layer, then write and run its tests.

- [ ] **Step 1: Project structure and production configuration skeleton**
  - Create `package.json` with Express dependency and test runner (Jest)
  - Create `src/` directory structure: `src/app.js`, `src/routes/todos.js`, `src/store/todoStore.js`, `src/utils/logger.js`
  - Create `tests/` directory: `tests/todos.test.js`
  - Map: FR1 (project scaffold), NFR4 (separable storage layer)

- [ ] **Step 2: Bootstrap the minimal test runner/configuration**
  - Add Jest config to `package.json` or `jest.config.js`
  - Exact unit-scoped test command: `npx jest tests/todos.test.js`
  - Map: Testing Contract runner readiness

- [ ] **Step 3: Data model — implement**
  - Define the `Todo` shape: `{ id: string (UUIDv4), title: string, completed: boolean }`
  - In-memory store backing structure (Map or array)
  - Map: FR1 (todo resource fields)

- [ ] **Step 4: Data model — write and run its tests**
  - Test: todo shape validation (id is UUID, title non-empty, completed boolean)
  - Map: FR1, NFR2

- [ ] **Step 5: Repository / data access — implement**
  - `src/store/todoStore.js`: `create(title, completed)`, `getAll()`, `getById(id)`, `update(id, fields)`, `delete(id)`
  - In-memory Map-based implementation; UUIDv4 id generation
  - Map: FR1.1–FR1.5, NFR4 (separable storage)

- [ ] **Step 6: Repository / data access — write and run its tests**
  - Test: create returns todo with id and defaults; getAll returns array; getById found/not-found; update partial + not-found; delete success + not-found
  - Map: FR1.1–FR1.5

- [ ] **Step 7: Business logic — implement**
  - Validation: title required non-empty on create; title non-empty if supplied on update; unknown fields ignored on update
  - Map: FR1.1.1, FR1.4.1, FR1.4.2

- [ ] **Step 8: Business logic — write and run its tests**
  - Test: missing/empty title returns 400; partial update ignores unknown fields; completed defaults to false
  - Map: FR1.1.1, FR1.1.2, FR1.4.1, FR1.4.2

- [ ] **Step 9: API / endpoint — implement**
  - `src/routes/todos.js`: POST, GET (list), GET (single), PUT, DELETE handlers
  - `src/app.js`: Express app, JSON middleware, route mounting, request logging middleware (method, path, status, response time)
  - Consistent error response shape `{ "error": string, "details"?: string }`
  - `POST` returns 201 + `Location: /todos/{id}` header
  - `DELETE` returns 204
  - Map: FR1.1–FR1.6, NFR1, NFR3

- [ ] **Step 10: API / endpoint — write and run its tests**
  - Test: POST 201 + Location; POST 400 missing title; GET list 200; GET single 200/404; PUT 200/404/400; DELETE 204/404; error shape consistency
  - Map: FR1.1–FR1.6

- [ ] **Step 11: Environment/build configuration**
  - `package.json` scripts: `start` (node src/app.js), `test` (jest)
  - `.gitignore` for `node_modules/`
  - Map: C1 (Node.js + Express)

- [ ] **Step 12: Documentation and traceability**
  - Inline API route documentation
  - `traceability.json` mapping every FR/NFR to implementation files
  - `code-summary.md` documenting files created, decisions, coverage
  - Map: all requirements

## Test-to-Requirement Mapping

| Test | Requirement |
|------|-------------|
| Todo shape validation | FR1, NFR2 |
| Store CRUD operations | FR1.1–FR1.5 |
| Title validation (create) | FR1.1.1 |
| Title validation (update) | FR1.4.1 |
| Unknown fields ignored | FR1.4.2 |
| completed defaults false | FR1.1.2 |
| POST 201 + Location | FR1.1 |
| POST 400 missing title | FR1.1.1 |
| GET list 200 + empty array | FR1.2 |
| GET single 200/404 | FR1.3 |
| PUT 200/404/400 | FR1.4, FR1.4.3 |
| DELETE 204/404 | FR1.5 |
| Error response shape | FR1.6 |
