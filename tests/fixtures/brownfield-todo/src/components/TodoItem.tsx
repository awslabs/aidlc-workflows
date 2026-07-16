import type { Todo } from '../types/todo'

interface TodoItemProps {
  todo: Todo
  onToggle: () => void
  onDelete: () => void
}

export function TodoItem({ todo, onToggle, onDelete }: TodoItemProps) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={onToggle}
      />
      <span style={{ textDecoration: todo.completed ? 'line-through' : 'none', flex: 1 }}>
        {todo.title}
      </span>
      <button type="button" onClick={onDelete}>Delete</button>
    </li>
  )
}
