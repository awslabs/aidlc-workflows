# Codebase Analysis

## Directory Structure
```
src/
  main.tsx          — Application entry point, renders App into DOM
  App.tsx           — Root component, renders TodoList
  types/
    todo.ts         — Todo interface definition
  components/
    TodoList.tsx    — List component with add form, maps over todos
    TodoItem.tsx    — Single todo row: checkbox, title, delete button
  hooks/
    useTodos.ts     — Custom hook: addTodo, toggleTodo, deleteTodo
```

## Code Patterns
- Functional components throughout (no class components)
- Custom hooks for business logic separation
- TypeScript interfaces for domain types
- Inline styles (no CSS framework)

## Component Inventory
| Component | Lines | Responsibility |
|-----------|-------|---------------|
| App | ~12 | Layout wrapper |
| TodoList | ~38 | Form + list rendering |
| TodoItem | ~22 | Single todo display + actions |
| useTodos | ~30 | Todo CRUD state management |

## Total LOC
~200 lines (excluding config files)
