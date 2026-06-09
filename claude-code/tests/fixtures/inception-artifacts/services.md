# Services

## Overview
The Todo app is client-side only with no external service dependencies. All state management is handled via React hooks.

## Internal Services

### State Management (useTodos hook)
- **Type**: In-memory React state
- **Storage**: `useState<Todo[]>`
- **Persistence**: None (state resets on page reload)

## Future Service Boundaries
- **LocalStorage adapter**: Optional persistence layer
- **REST API client**: If backend is added later

## External Dependencies
- None (no API calls, no third-party services)
