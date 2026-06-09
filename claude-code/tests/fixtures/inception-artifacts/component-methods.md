# Component Methods

## TodoList Methods

### handleAddTodo(title: string): void
- Validates title is non-empty
- Calls `useTodos.addTodo(title)`
- Clears input field after add

### handleToggle(id: string): void
- Calls `useTodos.toggleTodo(id)`

### handleDelete(id: string): void
- Calls `useTodos.deleteTodo(id)`

## useTodos Hook Methods

### addTodo(title: string): void
- Creates new Todo with generated ID, title, completed=false
- Appends to todos array

### toggleTodo(id: string): void
- Finds todo by ID, flips `completed` boolean

### deleteTodo(id: string): void
- Filters todo array, removing item with matching ID
