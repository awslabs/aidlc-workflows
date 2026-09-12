# Requirements — Todo REST API

## Intent Analysis

The user wants to build a REST API for a todo application with full CRUD (Create, Read, Update, Delete) endpoints. This is a greenfield project using the express scope (minimal depth). The goal is a working, testable API that manages todo items through standard HTTP verbs.

## Functional Requirements

### FR1: Todo Item Management

**FR1.1** — The system shall expose a `POST /todos` endpoint that creates a new todo item from a JSON request body containing `title` (required) and `description` (optional), assigns a unique id, sets `completed` to false, stamps `created_at` and `updated_at`, persists the item, and returns the created item with HTTP 201.

**FR1.2** — The system shall expose a `GET /todos` endpoint that returns the complete list of persisted todo items as a JSON array with HTTP 200.

**FR1.3** — The system shall expose a `GET /todos/:id` endpoint that returns the todo item matching the path parameter id with HTTP 200, or HTTP 404 with a JSON error body when no item exists for that id.

**FR1.4** — The system shall expose a `PUT /todos/:id` endpoint that updates the todo item matching the path parameter id from a JSON request body containing any subset of `title`, `description`, and `completed`, updates the `updated_at` timestamp, persists the change, and returns the updated item with HTTP 200, or HTTP 404 when the item does not exist.

**FR1.5** — The system shall expose a `DELETE /todos/:id` endpoint that removes the todo item matching the path parameter id and returns HTTP 204 with no body, or HTTP 404 when the item does not exist.

### FR2: Input Validation

**FR2.1** — The system shall reject a `POST /todos` request whose body lacks a `title` field or whose `title` is an empty string, returning HTTP 400 with a JSON error body naming the missing field.

**FR2.2** — The system shall reject a `PUT /todos/:id` request whose body contains no updatable field (`title`, `description`, `completed`), returning HTTP 400 with a JSON error body.

**FR2.3** — The system shall reject any request with a malformed JSON body, returning HTTP 400 with a JSON error body.

### FR3: Error Handling

**FR3.1** — The system shall return a consistent JSON error body shape `{ "error": "<message>" }` for all 4xx and 5xx responses.

**FR3.2** — The system shall return HTTP 404 with a JSON error body for any unmatched route.

**FR3.3** — The system shall return HTTP 500 with a generic JSON error body for unhandled server errors, without leaking stack traces.

## Non-Functional Requirements

**NFR1** — The API shall respond to all endpoints within 200ms for the 99th percentile of requests under a single-user load.

**NFR2** — The API shall be runnable locally with a single command and no external service dependencies (SQLite is file-based).

**NFR3** — The API shall include unit tests covering each endpoint's happy path and primary error case (Minimal test strategy).

**NFR4** — The API shall log each request method and path to the console for observability during development.

## Constraints

- **Technology**: Node.js with Express framework
- **Persistence**: SQLite via a Node.js driver (file-based, no external database server)
- **Authentication**: None (open API for this scope)
- **Data format**: JSON request and response bodies
- **Scope**: Express (minimal) — no deployment pipeline, no observability infrastructure, no CI pipeline

## Assumptions

- The API runs on a single server instance; concurrent-write contention is acceptable for this scope.
- The todo dataset remains small enough that returning the full list on `GET /todos` is acceptable (no pagination needed).
- No authentication or authorization is required for this scope.
- The SQLite database file is created automatically on first run if it does not exist.

## Out of Scope

- User authentication and authorization
- Pagination, filtering, or sorting of the todo list
- Soft delete or audit history of changes
- Deployment pipelines, CI/CD, or production hosting
- Observability infrastructure (metrics, tracing, dashboards)
- Multi-user support or ownership of todo items
- Real-time updates or websockets

## Open Questions

None — all clarifying questions were resolved during requirements analysis.
