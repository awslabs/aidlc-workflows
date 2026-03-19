# Todo List Application — Product Vision

## Overview

A simple, full-stack todo list application that allows users to create, read, update, and delete tasks. The application provides a clean web interface for managing daily tasks with filtering and completion tracking.

## Core Features

### Task Management
- Create new tasks with a title and optional description
- Mark tasks as complete or incomplete (toggle)
- Edit existing task titles and descriptions
- Delete tasks permanently
- View all tasks in a scrollable list

### Filtering
- Filter tasks by status: All, Active (incomplete), Completed
- Display count of remaining active tasks

### Persistence
- Tasks persist across page refreshes via the REST API
- Server stores tasks in memory (no database required for MVP)

## User Interface

The UI is a single-page application with:
- A header showing the application title
- An input field at the top for adding new tasks
- A list of tasks below, each with:
  - A checkbox to toggle completion
  - The task title (with strikethrough when completed)
  - An edit button
  - A delete button
- A filter bar at the bottom with All / Active / Completed tabs
- A counter showing "X items left"

## Non-Functional Requirements

- The application should load in under 2 seconds
- The UI should be responsive and work on mobile viewports
- All CRUD operations should complete in under 500ms
- The API should return proper HTTP status codes and error messages

## Out of Scope (MVP)

- User authentication / multi-user support
- Task due dates or priorities
- Drag-and-drop reordering
- Database persistence (in-memory store is acceptable)
- Deployment / CI pipeline
