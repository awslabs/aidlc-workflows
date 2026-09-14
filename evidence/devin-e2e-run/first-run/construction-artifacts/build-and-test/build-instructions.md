# Build Instructions — Todo REST API

## Prerequisites

- **Node.js**: v22+ (uses built-in `node:sqlite` module)
- **npm**: v10+

## Dependency Installation

```bash
npm install
```

This installs:
- Runtime: `express`
- Dev: `vitest`, `supertest`

## Environment Setup

No external services required. SQLite is file-based and created automatically on first run.

Optional environment variables:
- `PORT` — Server listen port (default: 3000)
- `TODO_DB_PATH` — SQLite database file path (default: `data/todos.db`)

## Build Commands

This is a pure JavaScript (ESM) project — no compilation, bundling, or transpilation step is required.

```bash
# Verify the server starts
node src/server.js
```

## Build Verification

```bash
# Run the test suite
npx vitest run

# Start the server and verify it responds
PORT=3000 node src/server.js &
curl -s http://localhost:3000/todos
```

## Troubleshooting

- **`Error: Cannot find module 'node:sqlite'`**: Ensure Node.js v22+ is installed. Check with `node --version`.
- **Port already in use**: Set `PORT` to a different value.
- **Database locked**: Ensure no other process is using the SQLite file.
