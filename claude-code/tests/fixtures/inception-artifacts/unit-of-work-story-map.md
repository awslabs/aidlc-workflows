# Unit of Work — Story Map

## Unit: todo-core

### Stories

#### S1: Display Todo List
- Render all todos from state
- Show title and completion status
- Empty state message when no todos

#### S2: Add New Todo
- Input field with submit action
- Create todo with unique ID
- Clear input after successful add

#### S3: Toggle Todo Completion
- Checkbox click toggles `completed`
- Visual indication of completed state (strikethrough)

#### S4: Delete Todo
- Delete button removes todo from list
- Immediate UI update after deletion

### Story Dependencies
```
S1 (base) → S2 (add) → S3 (toggle) → S4 (delete)
```

### Acceptance Criteria
- All CRUD operations functional
- TypeScript strict mode, no type errors
- Vitest test coverage for hook logic
