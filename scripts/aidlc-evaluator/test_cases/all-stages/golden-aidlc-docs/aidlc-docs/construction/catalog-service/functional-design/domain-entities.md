# Functional Design — Catalog Service — Domain Entities

## Entity: Book

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | str (UUID) | Auto-generated | Unique identifier |
| title | str | Required, max 255 chars | Book title |
| author | str | Required, max 255 chars | Author name |
| isbn | str | Optional, max 13 chars | ISBN-10 or ISBN-13 |
| category | str | Required, max 100 chars | Book category |
| total_copies | int | Required, >= 1 | Total physical copies owned |
| available_copies | int | Auto-managed, >= 0, <= total_copies | Currently available copies |
| created_at | datetime (UTC) | Auto-generated | Creation timestamp |
| updated_at | datetime (UTC) | Auto-updated | Last update timestamp |

### Invariants
- `available_copies` must always be `>= 0`
- `available_copies` must always be `<= total_copies`
- `total_copies` must always be `>= 1`
- When `total_copies` is updated, it must be `>= (total_copies - available_copies)` (cannot go below checked-out count)

## Entity: AvailabilityInfo (Value Object)

| Field | Type | Description |
|-------|------|-------------|
| book_id | str | Book identifier |
| title | str | Book title |
| total_copies | int | Total copies |
| available_copies | int | Available copies |
