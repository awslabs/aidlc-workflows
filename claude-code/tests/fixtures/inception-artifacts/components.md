# Component Inventory

## Components

### App
- **Type**: Layout
- **Responsibility**: Root component, renders TodoList
- **Dependencies**: TodoList

### TodoList
- **Type**: Container
- **Responsibility**: Manages todo display and add-todo form
- **Dependencies**: TodoItem, useTodos

### TodoItem
- **Type**: Presentational
- **Responsibility**: Renders single todo with toggle and delete controls
- **Dependencies**: None (receives props)

## Hooks

### useTodos
- **Type**: Custom Hook
- **Responsibility**: Encapsulates todo state and CRUD operations
- **State**: `todos: Todo[]`
- **Methods**: addTodo, toggleTodo, deleteTodo
