# Cross-Unit Traceability — Todo REST API

## Verdict: PASS

All functional and non-functional requirements from `requirements.md` are covered with status `OK` in the stage-level `traceability.json` and their target files exist.

## Per-ID Coverage

| ID | Description | Status | Owning Stage | Target File | File Exists |
|----|-------------|--------|--------------|-------------|-------------|
| FR1.1 | POST /todos create | OK | code-generation | src/app.js | Yes |
| FR1.2 | GET /todos list | OK | code-generation | src/app.js | Yes |
| FR1.3 | GET /todos/:id | OK | code-generation | src/app.js | Yes |
| FR1.4 | PUT /todos/:id update | OK | code-generation | src/app.js | Yes |
| FR1.5 | DELETE /todos/:id | OK | code-generation | src/app.js | Yes |
| FR2.1 | Title validation | OK | code-generation | src/todoService.js | Yes |
| FR2.2 | Updatable fields check | OK | code-generation | src/todoService.js | Yes |
| FR2.3 | Malformed JSON handling | OK | code-generation | src/app.js | Yes |
| FR3.1 | Error body shape | OK | code-generation | src/app.js | Yes |
| FR3.2 | 404 unmatched route | OK | code-generation | src/app.js | Yes |
| FR3.3 | 500 error handling | OK | code-generation | src/app.js | Yes |
| NFR1 | Response time <200ms | OK | code-generation | src/db.js | Yes |
| NFR2 | Single command run | OK | code-generation | package.json | Yes |
| NFR3 | Unit tests | OK | code-generation | tests/app.test.js | Yes |
| NFR4 | Request logging | OK | code-generation | src/server.js | Yes |

## Uncovered Elements

None — all 15 requirement IDs are covered.
