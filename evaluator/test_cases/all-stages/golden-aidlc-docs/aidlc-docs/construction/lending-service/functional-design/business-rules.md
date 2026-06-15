# Functional Design — Lending Service — Business Rules

## Authentication Rules

### BR-AUTH-001: Registration
- Name required, max 100 chars
- Email required, valid format, unique across all members
- Password required, minimum 8 characters
- Password stored as bcrypt hash (never plaintext)
- Auto-assigned role: "member"
- Account created as active (is_active = true)

### BR-AUTH-002: Login
- Validate email exists and account is active
- Verify password against bcrypt hash
- Return JWT with: member_id, email, role, exp (24 hours from now)
- Invalid credentials return 401 (do not reveal whether email or password is wrong)

### BR-AUTH-003: JWT Validation
- Verify signature, expiration, required claims (member_id, email, role)
- Reject expired tokens with 401
- Extract member_id, email, role from valid token

## Member Rules

### BR-MEM-001: Profile Update
- Members can update own name and email only
- New email must be unique
- Cannot change role or active status via profile update

### BR-MEM-002: Account Deactivation
- Only Admin can deactivate accounts
- Deactivated member: is_active = false
- Existing checkouts remain active (tracked until returned)
- Existing holds remain active
- Blocked actions: new checkout, new hold, new renewal
- Cannot deactivate self

## Checkout Rules

### BR-CHK-001: Checkout Validation
1. Book must exist (verify via Catalog Service)
2. Book must have available_copies > 0
3. Member must be active (is_active = true)
4. Member active checkout count < MAX_CHECKOUTS (5)
5. Member outstanding fee balance <= FEE_THRESHOLD ($10.00)
6. All validations must pass before creating checkout

### BR-CHK-002: Checkout Creation
- Set checkout_date = now (UTC)
- Set due_date = checkout_date + 14 days
- Set status = "active"
- Set renewal_count = 0
- Decrement available_copies in Catalog Service
- If Catalog Service call fails, abort checkout

### BR-CHK-003: Return Processing
1. Checkout must exist and be active
2. Members can return own checkouts; Librarian/Admin can return any
3. Set return_date = now (UTC), status = "returned"
4. Calculate late fee if overdue:
   - days_overdue = (return_date.date() - due_date.date()).days (only if positive)
   - fee = days_overdue * $0.25
   - fee capped at $10.00 per checkout
   - Create fee record if fee > 0
5. Increment available_copies in Catalog Service
6. Check hold queue: if waiting holds exist for this book, fulfill next

### BR-CHK-004: Renewal
1. Checkout must exist and be active
2. Checkout must belong to requesting member
3. Member must be active
4. renewal_count < MAX_RENEWALS (2)
5. No active holds (status = "waiting") exist for the book
6. Extend due_date by 14 days from current due_date
7. Increment renewal_count

## Hold Rules

### BR-HLD-001: Hold Placement
1. Book must exist (verify via Catalog Service)
2. Book available_copies must be 0 (holds only on unavailable books)
3. Member must be active
4. Member active hold count < MAX_HOLDS (3) — count holds with status "waiting" or "ready"
5. Member must not already have an active hold on this book
6. Create hold with status = "waiting"
7. Queue position = max position for this book + 1 (FIFO)

### BR-HLD-002: Hold Cancellation
1. Hold must exist
2. Members can cancel own holds; Librarian/Admin can cancel any
3. Set status = "cancelled"
4. Reorder queue: decrement position of all holds with higher position for the same book

### BR-HLD-003: Hold Fulfillment (on return)
1. When a book is returned, check for waiting holds on that book
2. Find the hold with the lowest queue_position and status = "waiting"
3. Update that hold's status to "ready"
4. Do NOT decrement available_copies (the "ready" hold reserves the copy conceptually)
   - Actually: the available_copies was already incremented on return. The "ready" hold member
     will check out normally, which decrements again. So available_copies accurately reflects 
     the physical availability.

## Fee Rules

### BR-FEE-001: Late Fee Calculation
- Rate: $0.25 per day overdue
- Cap: $10.00 per checkout
- Only charged on return, not accruing in real-time
- Calculated in UTC dates (whole days only)

### BR-FEE-002: Fee Payment
- Librarian/Admin processes payments
- Partial payments allowed
- Payment applied to oldest outstanding fees first
- Payment amount must be > 0
- Payment cannot exceed total outstanding balance

### BR-FEE-003: Outstanding Balance
- Sum of all fees with status = "outstanding" minus payments applied
- Used for checkout threshold check (BR-CHK-001, rule 5)

## Reporting Rules

### BR-RPT-001: Overdue Report
- All checkouts where status = "active" AND due_date < now
- Include: member name, email, book title, checkout_date, due_date, days_overdue
- Book title fetched via Catalog Service or stored denormalized in checkout
- Accessible by Librarian and Admin only

### BR-RPT-002: Collection Summary
- total_books: count from Catalog Service
- total_members: count of all members
- books_checked_out: count of active checkouts
- books_available: total_books - books_checked_out
- total_outstanding_fees: sum of outstanding fee amounts
- Accessible by Admin only

## Configuration Constants

| Constant | Value | Description |
|----------|-------|-------------|
| MAX_CHECKOUTS | 5 | Max active checkouts per member |
| MAX_RENEWALS | 2 | Max renewals per checkout |
| MAX_HOLDS | 3 | Max active holds per member |
| LOAN_PERIOD_DAYS | 14 | Days per checkout period |
| LATE_FEE_PER_DAY | 0.25 | Daily late fee in dollars |
| LATE_FEE_CAP | 10.00 | Max late fee per checkout |
| FEE_THRESHOLD | 10.00 | Outstanding fee limit for checkout |
| JWT_EXPIRY_HOURS | 24 | JWT token expiry |
