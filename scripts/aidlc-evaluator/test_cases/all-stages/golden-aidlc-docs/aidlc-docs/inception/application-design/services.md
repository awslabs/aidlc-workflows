# Services Design

## Catalog Service — Service Layer

### BookService
- **Responsibility**: Orchestrates book CRUD operations, search, and availability management
- **Methods**:
  - `create_book(data) -> Book` — validate and create a book
  - `get_book(book_id) -> Book` — retrieve by ID
  - `list_books() -> List[Book]` — list all books
  - `update_book(book_id, data) -> Book` — update book metadata
  - `delete_book(book_id) -> None` — delete (fails if active checkouts)
  - `search_books(query, category, available) -> List[Book]` — full-text search with filters
  - `check_availability(book_id) -> AvailabilityInfo` — return availability for inter-service call
  - `update_availability(book_id, delta) -> Book` — increment/decrement available_copies

---

## Lending Service — Service Layer

### AuthService
- **Responsibility**: Authentication and token management
- **Methods**:
  - `hash_password(password) -> str` — bcrypt hash
  - `verify_password(plain, hashed) -> bool` — verify bcrypt
  - `create_token(member) -> str` — generate JWT with member_id, email, role, 24h expiry
  - `decode_token(token) -> TokenPayload` — validate and decode JWT

### MemberService
- **Responsibility**: Member lifecycle management
- **Methods**:
  - `register(data) -> Member` — create member with hashed password, auto-assign member role
  - `login(email, password) -> str` — verify credentials, return JWT
  - `get_profile(member_id) -> Member` — retrieve member profile
  - `update_profile(member_id, data) -> Member` — update name/email
  - `get_member(member_id) -> Member` — admin/librarian view
  - `deactivate(member_id) -> Member` — set active=False

### CheckoutService
- **Responsibility**: Checkout, return, and renewal orchestration
- **Methods**:
  - `checkout(member_id, book_id) -> Checkout` — validate limits/fees/availability, create checkout, decrement availability
  - `return_book(checkout_id, member_id, role) -> ReturnResult` — process return, calculate fees, increment availability, fulfill holds
  - `renew(checkout_id, member_id) -> Checkout` — validate renewal limits/holds, extend due date
  - `list_checkouts(member_id, status) -> List[Checkout]` — list checkouts with optional status filter

### HoldService
- **Responsibility**: Hold queue management
- **Methods**:
  - `place_hold(member_id, book_id) -> Hold` — validate limits/availability/duplicates, create hold with FIFO position
  - `cancel_hold(hold_id, member_id, role) -> None` — cancel and reorder queue
  - `get_holds_for_book(book_id) -> List[Hold]` — hold queue for a book
  - `get_member_holds(member_id) -> List[Hold]` — all holds for a member
  - `fulfill_next_hold(book_id) -> Hold | None` — called on return, update first waiting hold to ready

### FeeService
- **Responsibility**: Fee calculation and payment processing
- **Methods**:
  - `calculate_late_fee(due_date, return_date) -> Decimal` — $0.25/day, capped at $10.00
  - `create_fee(member_id, checkout_id, amount) -> Fee` — create fee record
  - `get_member_fees(member_id) -> List[Fee]` — list fees for a member
  - `get_outstanding_balance(member_id) -> Decimal` — total outstanding
  - `process_payment(member_id, amount) -> Payment` — record payment, reduce outstanding

### ReportService
- **Responsibility**: Operational reporting
- **Methods**:
  - `get_overdue_checkouts() -> List[OverdueItem]` — all overdue with member info and days overdue
  - `get_collection_summary() -> CollectionSummary` — aggregate stats

### CatalogClient
- **Responsibility**: HTTP client to Catalog Service
- **Methods**:
  - `check_availability(book_id) -> AvailabilityInfo` — GET /api/v1/books/{book_id}/availability
  - `decrement_availability(book_id) -> None` — POST /api/v1/books/{book_id}/availability with delta=-1
  - `increment_availability(book_id) -> None` — POST /api/v1/books/{book_id}/availability with delta=+1
