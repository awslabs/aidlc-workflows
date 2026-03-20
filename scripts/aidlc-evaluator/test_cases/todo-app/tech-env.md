# Technical Environment: Todo List Application

## Language and Package Manager

- **Node.js 22** (LTS)
- **npm** for package management
- `package.json` for project and script configuration

## Backend Framework

- **Express.js** for the REST API server
- In-memory data store (plain JavaScript Map/Array) — no database required for MVP
- **uuid** package for generating todo IDs

## Frontend Framework

- **React 19** with functional components and hooks
- **Vite** as the build tool and dev server
- Plain CSS (no CSS framework required)

## Project Structure

```
todo-app/
├── package.json
├── server/
│   ├── index.js          # Express server entry point
│   ├── routes/
│   │   └── todos.js      # Todo CRUD routes
│   └── store.js          # In-memory todo store
├── client/
│   ├── index.html
│   ├── src/
│   │   ├── main.jsx      # React entry point
│   │   ├── App.jsx       # Root component
│   │   ├── components/
│   │   │   ├── TodoInput.jsx
│   │   │   ├── TodoList.jsx
│   │   │   ├── TodoItem.jsx
│   │   │   └── FilterBar.jsx
│   │   ├── hooks/
│   │   │   └── useTodos.js
│   │   └── styles/
│   │       └── App.css
│   └── vite.config.js
└── tests/
    ├── server/
    │   └── todos.test.js  # API integration tests
    └── client/
        └── App.test.jsx   # Component tests
```

## Testing

- **Vitest** for both server and client tests
- **React Testing Library** for component tests
- **supertest** for API integration tests
- Tests run via `npm test`

## Development Scripts

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "node server/index.js",
    "dev:client": "vite client",
    "build": "vite build client",
    "test": "vitest run",
    "start": "node server/index.js"
  }
}
```

## Conventions

- ES modules (`"type": "module"` in package.json)
- Server listens on port 3001, proxied from Vite dev server on port 5173
- All API routes prefixed with `/api/`
- Health endpoint at `/health` (no `/api/` prefix)
- Standard HTTP status codes: 200, 201, 400, 404, 500
