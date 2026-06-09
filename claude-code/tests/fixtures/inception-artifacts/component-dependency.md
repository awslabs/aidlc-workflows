# Component Dependency Graph

## Dependency Tree

```
App
 └── TodoList
      ├── TodoItem (per todo)
      └── useTodos (hook)
```

## Import Map

| Component | Imports |
|-----------|---------|
| App | TodoList |
| TodoList | TodoItem, useTodos |
| TodoItem | (props only) |
| useTodos | Todo (type) |

## Data Flow Direction
- **Top-down**: App → TodoList → TodoItem (props)
- **Bottom-up**: TodoItem → TodoList → useTodos (event callbacks)

## Coupling Assessment
- Low coupling: components communicate via props and callbacks
- Single shared type: `Todo` interface
