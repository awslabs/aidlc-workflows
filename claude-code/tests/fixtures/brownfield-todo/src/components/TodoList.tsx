import { useState } from 'react'
import { TodoItem } from './TodoItem'
import { useTodos } from '../hooks/useTodos'

export function TodoList() {
  const { todos, addTodo, toggleTodo, deleteTodo } = useTodos()
  const [newTitle, setNewTitle] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (newTitle.trim()) {
      addTodo(newTitle.trim())
      setNewTitle('')
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add a new todo..."
        />
        <button type="submit">Add</button>
      </form>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {todos.map((todo) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggle={() => toggleTodo(todo.id)}
            onDelete={() => deleteTodo(todo.id)}
          />
        ))}
      </ul>
    </div>
  )
}
