# Component Methods

## Catalog Service

### BookService Methods

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| `create_book` | `BookCreateRequest(title, author, isbn, category, total_copies)` | `Book` | Create book, set available_copies = total_copies |
| `get_book` | `book_id: str` | `Book` | Get book by ID or raise NOT_FOUND |
| `list_books` | None | `List[Book]` | Return all books |
| `update_book` | `book_id: str, BookUpdateRequest` | `Book` | Update fields, validate total_copies >= checked_out |
| `delete_book` | `book_id: str` | `None` | Delete if no active checkouts |
| `search_books` | `query: str, category: str, available: bool` | `List[Book]` | Substring match on title/author, optional filters |
| `check_availability` | `book_id: str` | `AvailabilityInfo(book_id, title, total_copies, available_copies)` | Internal API for Lending Service |
| `update_availability` | `book_id: str, delta: int` | `Book` | Adjust available_copies by delta (+1 or -1) |

### BookRepository Methods

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| `create` | `Book` | `Book` | Persist new book |
| `get_by_id` | `book_id: str` | `Book | None` | Retrieve by primary key |
| `list_all` | None | `List[Book]` | List all records |
| `update` | `Book` | `Book` | Update existing record |
| `delete` | `book_id: str` | `None` | Remove record |
| `search` | `query: str, category: str, available: bool` | `List[Book]` | Search with filters |

---

## Lending Service

### AuthService Methods

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| `hash_password` | `password: str` | `str` | Bcrypt hash |
| `verify_password` | `plain: str, hashed: str` | `bool` | Verify password |
| `create_token` | `member_id: str, email: str, role: str` | `str` | JWT with 24h expiry |
| `decode_token` | `token: str` | `TokenPayload(member_id, email, role)` | Validate and decode |

### MemberService / MemberRepository Methods

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| `register` | `MemberRegisterRequest(name, email, password)` | `Member` | Create with bcrypt hash |
| `login` | `email: str, password: str` | `str (JWT)` | Authenticate and return token |
| `get_profile` | `member_id: str` | `Member` | Self-service profile |
| `update_profile` | `member_id: str, data` | `Member` | Update name/email |
| `deactivate` | `member_id: str` | `Member` | Set is_active = False |

### CheckoutService Methods

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| `checkout` | `member_id: str, book_id: str` | `Checkout` | Full validation + create |
| `return_book` | `checkout_id: str, member_id: str, role: str` | `ReturnResult` | Return + fees + holds |
| `renew` | `checkout_id: str, member_id: str` | `Checkout` | Extend due date |
| `list_checkouts` | `member_id: str, status: str` | `List[Checkout]` | Filter by status |

### HoldService Methods

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| `place_hold` | `member_id: str, book_id: str` | `Hold` | Validate + create FIFO |
| `cancel_hold` | `hold_id: str, member_id: str, role: str` | `None` | Cancel + reorder |
| `get_holds_for_book` | `book_id: str` | `List[Hold]` | Queue for a book |
| `get_member_holds` | `member_id: str` | `List[Hold]` | Member's holds |
| `fulfill_next_hold` | `book_id: str` | `Hold | None` | First waiting → ready |

### FeeService Methods

| Method | Input | Output | Purpose |
|--------|-------|--------|---------|
| `calculate_late_fee` | `due_date, return_date` | `Decimal` | $0.25/day, cap $10 |
| `create_fee` | `member_id, checkout_id, amount` | `Fee` | Record fee |
| `get_member_fees` | `member_id: str` | `List[Fee]` | Fee list |
| `get_outstanding_balance` | `member_id: str` | `Decimal` | Total outstanding |
| `process_payment` | `member_id, amount` | `Payment` | Apply payment |
