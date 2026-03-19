# Functional Design — Catalog Service — Business Rules

## BR-CAT-001: Book Creation
- Title, author, category are required
- ISBN is optional
- total_copies must be >= 1
- available_copies is set to total_copies on creation
- String fields must respect max length constraints

## BR-CAT-002: Book Update
- Only provided fields are updated (partial update)
- If total_copies is changed, new value must be >= (total_copies - available_copies)
  - i.e., cannot reduce below currently checked-out count
- If total_copies increases, available_copies increases by the same delta
- If total_copies decreases, available_copies decreases by the same delta (but never below 0)

## BR-CAT-003: Book Deletion
- Cannot delete a book with active checkouts (available_copies < total_copies)
- Returns 409 CONFLICT if deletion is blocked

## BR-CAT-004: Book Search
- Search query matches substring in title OR author (case-insensitive)
- Category filter is exact match (case-insensitive)
- Available filter: if true, only return books with available_copies > 0
- All filters are optional and combinable
- Empty results return empty list (not error)

## BR-CAT-005: Availability Update
- Delta of -1: decrement available_copies (checkout)
  - Fails with CONFLICT if available_copies == 0
- Delta of +1: increment available_copies (return)
  - Fails with CONFLICT if available_copies == total_copies
- Only delta values of -1 and +1 are allowed

## BR-CAT-006: RBAC Rules
- **Public**: Health check only
- **Member**: Read operations (get, list, search)
- **Librarian**: All CRUD operations
- **Admin**: All operations
- **Internal**: Availability endpoints (service-to-service, validated by shared secret or JWT)
