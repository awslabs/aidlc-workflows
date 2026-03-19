# Functional Design — Lending Service — Domain Entities

## Entity: Member

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | str (UUID) | Auto-generated | Unique identifier |
| name | str | Required, max 100 chars | Member full name |
| email | str | Required, unique, max 255 chars, valid email format | Login email |
| password_hash | str | System-managed | Bcrypt hash of password |
| role | str (enum) | "admin", "librarian", "member" | RBAC role |
| is_active | bool | Default: true | Account active status |
| created_at | datetime (UTC) | Auto-generated | Registration timestamp |

## Entity: Checkout

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | str (UUID) | Auto-generated | Unique identifier |
| member_id | str | Required, FK to Member | Borrowing member |
| book_id | str | Required | Book from Catalog Service |
| checkout_date | datetime (UTC) | Auto-generated | When checked out |
| due_date | datetime (UTC) | checkout_date + 14 days | When due |
| return_date | datetime (UTC) | Null until returned | When returned |
| status | str (enum) | "active", "returned" | Checkout status |
| renewal_count | int | Default: 0, max 2 | Times renewed |

## Entity: Hold

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | str (UUID) | Auto-generated | Unique identifier |
| member_id | str | Required, FK to Member | Requesting member |
| book_id | str | Required | Book from Catalog Service |
| hold_date | datetime (UTC) | Auto-generated | When hold placed |
| status | str (enum) | "waiting", "ready", "cancelled", "fulfilled" | Hold status |
| queue_position | int | >= 1 | Position in FIFO queue |

## Entity: Fee

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | str (UUID) | Auto-generated | Unique identifier |
| member_id | str | Required, FK to Member | Member with fee |
| checkout_id | str | Required, FK to Checkout | Related checkout |
| amount | Decimal | > 0, max $10.00 | Fee amount |
| status | str (enum) | "outstanding", "paid" | Fee status |
| created_at | datetime (UTC) | Auto-generated | When fee created |

## Entity: Payment

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | str (UUID) | Auto-generated | Unique identifier |
| member_id | str | Required, FK to Member | Paying member |
| amount | Decimal | > 0 | Payment amount |
| payment_date | datetime (UTC) | Auto-generated | When payment processed |

## Entity: TokenPayload (Value Object)

| Field | Type | Description |
|-------|------|-------------|
| member_id | str | Member UUID |
| email | str | Member email |
| role | str | Member role |
| exp | datetime | Token expiration |

## Entity: ReturnResult (Value Object)

| Field | Type | Description |
|-------|------|-------------|
| checkout | Checkout | Updated checkout record |
| fee | Fee | None | Late fee if applicable |
| hold_fulfilled | Hold | None | Hold fulfilled if applicable |
