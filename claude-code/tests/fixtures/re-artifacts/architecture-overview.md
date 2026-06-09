# Architecture Overview

## System Type
Single-page application (SPA)

## Architecture Pattern
Component-based React architecture with custom hooks for state management.

## Key Components
- **App** — Root component, layout wrapper
- **TodoList** — Main list component, handles form input and renders items
- **TodoItem** — Individual todo display with toggle and delete actions
- **useTodos** — Custom hook encapsulating todo CRUD operations

## Data Flow
1. User interacts with TodoList form or TodoItem controls
2. Event handlers call useTodos hook methods (addTodo, toggleTodo, deleteTodo)
3. Hook updates React state via useState
4. React re-renders affected components

## Domain Entity
- **Todo** — `{ id: string, title: string, completed: boolean }`
