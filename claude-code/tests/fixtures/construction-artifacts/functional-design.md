# Functional Design — todo-core

## Overview
Detailed functional design for the todo-core unit covering component structure, state management, and user interactions.

## Component Specifications

### App Component
- Renders page layout with header and TodoList
- No local state

### TodoList Component
- **State**: Input field value (controlled component)
- **Props**: None (uses useTodos hook directly)
- **Renders**: Add-todo form + list of TodoItem components
- **Event handlers**: onSubmit (add), onToggle (delegate), onDelete (delegate)

### TodoItem Component
- **Props**: `todo: Todo`, `onToggle: (id) => void`, `onDelete: (id) => void`
- **Renders**: Checkbox, title text (strikethrough if completed), delete button

## State Management

### useTodos Hook
```typescript
interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const addTodo = (title: string) => { /* append */ };
  const toggleTodo = (id: string) => { /* flip completed */ };
  const deleteTodo = (id: string) => { /* filter out */ };
  return { todos, addTodo, toggleTodo, deleteTodo };
}
```

## API Contracts
- No external APIs — client-side only
- Component communication via props and callbacks
