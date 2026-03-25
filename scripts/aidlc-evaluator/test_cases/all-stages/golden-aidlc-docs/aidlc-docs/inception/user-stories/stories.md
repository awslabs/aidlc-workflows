# User Stories

## Epic 1: Catalog Management

### US-CAT-001: Add a Book
**As a** Librarian, **I want to** add a new book to the catalog with title, author, ISBN, category, and copy count, **so that** members can discover and borrow it.

**Acceptance Criteria:**
- Given I am authenticated as a Librarian or Admin
- When I POST to /api/v1/books with valid book data
- Then the book is created with a unique ID, available_copies = total_copies, and returned in the response
- And if any required field is missing or invalid, I receive a 422 VALIDATION_ERROR
- And if I am a Member, I receive a 403 FORBIDDEN

### US-CAT-002: Update a Book
**As a** Librarian, **I want to** update book metadata (title, author, ISBN, category, total_copies), **so that** the catalog stays accurate.

**Acceptance Criteria:**
- Given I am authenticated as a Librarian or Admin
- When I PUT to /api/v1/books/{book_id} with updated fields
- Then the book is updated and the updated record is returned
- And if the book does not exist, I receive a 404 NOT_FOUND
- And if total_copies is reduced below currently checked-out copies, I receive a 409 CONFLICT

### US-CAT-003: Get a Book
**As a** Member, **I want to** view details of a specific book, **so that** I can decide whether to borrow it.

**Acceptance Criteria:**
- Given I am authenticated
- When I GET /api/v1/books/{book_id}
- Then I receive the book details including available_copies
- And if the book does not exist, I receive a 404 NOT_FOUND

### US-CAT-004: List All Books
**As a** Member, **I want to** browse the complete catalog, **so that** I can discover books available in the library.

**Acceptance Criteria:**
- Given I am authenticated
- When I GET /api/v1/books
- Then I receive a list of all books with their availability

### US-CAT-005: Delete a Book
**As a** Librarian, **I want to** remove a book from the catalog, **so that** decommissioned books no longer appear.

**Acceptance Criteria:**
- Given I am authenticated as a Librarian or Admin
- When I DELETE /api/v1/books/{book_id}
- Then the book is removed from the catalog
- And if the book has active checkouts, I receive a 409 CONFLICT
- And if the book does not exist, I receive a 404 NOT_FOUND

### US-CAT-006: Search Books
**As a** Member, **I want to** search for books by title or author and filter by category and availability, **so that** I can find specific books quickly.

**Acceptance Criteria:**
- Given I am authenticated
- When I GET /api/v1/books/search?q=python&category=programming&available=true
- Then I receive books matching the search term in title or author, filtered by category and availability
- And if no books match, I receive an empty list (not an error)

---

## Epic 2: Member Management and Authentication

### US-AUTH-001: Register as a Member
**As a** new user, **I want to** register with my name, email, and password, **so that** I can start borrowing books.

**Acceptance Criteria:**
- Given I am not authenticated (public endpoint)
- When I POST to /api/v1/members/register with name, email, password
- Then my account is created with the "member" role and I receive my profile (without password)
- And if the email is already registered, I receive a 409 CONFLICT
- And if the password is too short (< 8 chars), I receive a 422 VALIDATION_ERROR

### US-AUTH-002: Login
**As a** registered user, **I want to** log in with my email and password, **so that** I receive a JWT token for API access.

**Acceptance Criteria:**
- Given I am not authenticated (public endpoint)
- When I POST to /api/v1/members/login with valid credentials
- Then I receive a JWT token with 24-hour expiry containing my member_id, email, and role
- And if credentials are invalid, I receive a 401 UNAUTHORIZED

### US-AUTH-003: View My Profile
**As a** Member, **I want to** view my profile information, **so that** I can verify my account details.

**Acceptance Criteria:**
- Given I am authenticated
- When I GET /api/v1/members/me
- Then I receive my profile (name, email, role, active status)

### US-AUTH-004: Update My Profile
**As a** Member, **I want to** update my name and email, **so that** I can keep my information current.

**Acceptance Criteria:**
- Given I am authenticated
- When I PUT /api/v1/members/me with updated name or email
- Then my profile is updated and the new profile is returned
- And if the new email is already in use, I receive a 409 CONFLICT

### US-AUTH-005: View Any Member Profile (Admin/Librarian)
**As an** Admin or Librarian, **I want to** view any member's profile, **so that** I can manage member accounts.

**Acceptance Criteria:**
- Given I am authenticated as Admin or Librarian
- When I GET /api/v1/members/{member_id}
- Then I receive that member's profile
- And if the member does not exist, I receive a 404 NOT_FOUND
- And if I am a Member, I receive a 403 FORBIDDEN

### US-AUTH-006: Deactivate Member Account
**As an** Admin, **I want to** deactivate a member account, **so that** they cannot perform new actions while their existing obligations remain tracked.

**Acceptance Criteria:**
- Given I am authenticated as Admin
- When I PUT /api/v1/members/{member_id}/deactivate
- Then the member's account is marked inactive
- And the member's existing checkouts and holds remain active
- And the member cannot create new checkouts, holds, or renewals
- And if I am not Admin, I receive a 403 FORBIDDEN

---

## Epic 3: Lending Operations

### US-LND-001: Checkout a Book
**As a** Member, **I want to** check out a book, **so that** I can borrow it for 14 days.

**Acceptance Criteria:**
- Given I am authenticated as a Member
- When I POST to /api/v1/checkouts with book_id
- Then a checkout record is created with due_date = now + 14 days and status = active
- And available_copies is decremented in the Catalog Service
- And if the book does not exist, I receive a 404 NOT_FOUND
- And if no copies are available, I receive a 409 CONFLICT
- And if I have 5 active checkouts already, I receive a 409 CONFLICT with "checkout limit exceeded"
- And if my outstanding fees exceed $10.00, I receive a 409 CONFLICT with "outstanding fees exceed threshold"

### US-LND-002: Return a Book
**As a** Member or Librarian, **I want to** return a checked-out book, **so that** it becomes available for others.

**Acceptance Criteria:**
- Given I am authenticated
- When I POST to /api/v1/checkouts/{checkout_id}/return
- Then the checkout status is updated to "returned" with return_date
- And available_copies is incremented in the Catalog Service
- And if the book is overdue, a late fee is calculated ($0.25/day, capped at $10.00) and a fee record is created
- And if there are active holds for this book, the first hold in FIFO order is updated to "ready"
- And Members can only return their own checkouts; Librarians/Admins can return any

### US-LND-003: Renew a Checkout
**As a** Member, **I want to** renew my checkout, **so that** I can keep the book for another 14 days.

**Acceptance Criteria:**
- Given I am authenticated as the checkout owner
- When I POST to /api/v1/checkouts/{checkout_id}/renew
- Then the due_date is extended by 14 days and renewal_count is incremented
- And if renewal_count is already 2, I receive a 409 CONFLICT with "renewal limit exceeded"
- And if there are active holds for this book, I receive a 409 CONFLICT with "book has active holds"
- And if the checkout is not active, I receive a 409 CONFLICT

### US-LND-004: View My Active Checkouts
**As a** Member, **I want to** see my active checkouts, **so that** I know what books I have and when they are due.

**Acceptance Criteria:**
- Given I am authenticated
- When I GET /api/v1/checkouts?status=active
- Then I receive my active checkouts with book_id, book_title, checkout_date, due_date, renewal_count
- And Admins/Librarians can specify a member_id query parameter to view any member's checkouts

---

## Epic 4: Hold Management

### US-HLD-001: Place a Hold
**As a** Member, **I want to** place a hold on an unavailable book, **so that** I can get fair access when it is returned.

**Acceptance Criteria:**
- Given I am authenticated as a Member
- When I POST to /api/v1/holds with book_id
- Then a hold record is created with status=waiting and a FIFO queue position
- And if the book has available copies, I receive a 409 CONFLICT with "book is available for checkout"
- And if I already have a hold on this book, I receive a 409 CONFLICT with "duplicate hold"
- And if I have 3 active holds already, I receive a 409 CONFLICT with "hold limit exceeded"

### US-HLD-002: Cancel a Hold
**As a** Member, **I want to** cancel my hold, **so that** others can move up in the queue.

**Acceptance Criteria:**
- Given I am authenticated
- When I DELETE /api/v1/holds/{hold_id}
- Then the hold is cancelled and remaining queue positions are re-ordered
- And Members can only cancel their own holds; Librarians/Admins can cancel any hold

### US-HLD-003: View Hold Queue
**As a** Member, **I want to** see my position in the hold queue for a book, **so that** I know how long I might wait.

**Acceptance Criteria:**
- Given I am authenticated
- When I GET /api/v1/holds?book_id={book_id}
- Then I receive the hold queue with positions and statuses
- And I can identify my own position in the queue

### US-HLD-004: View My Holds
**As a** Member, **I want to** see all my active holds, **so that** I can manage my hold queue.

**Acceptance Criteria:**
- Given I am authenticated
- When I GET /api/v1/holds/me
- Then I receive all my holds with book_id, status (waiting/ready/cancelled), queue_position, hold_date

---

## Epic 5: Fee Management

### US-FEE-001: View My Fees
**As a** Member, **I want to** see my outstanding fees, **so that** I know what I owe.

**Acceptance Criteria:**
- Given I am authenticated
- When I GET /api/v1/fees/me
- Then I receive a list of my fees with fee_id, amount, status, created_date, checkout_id
- And I can see a total outstanding balance

### US-FEE-002: View Any Member's Fees
**As a** Librarian or Admin, **I want to** view any member's fees, **so that** I can assist with fee inquiries.

**Acceptance Criteria:**
- Given I am authenticated as Librarian or Admin
- When I GET /api/v1/fees?member_id={member_id}
- Then I receive that member's fee records

### US-FEE-003: Process Fee Payment
**As a** Librarian or Admin, **I want to** record a fee payment for a member, **so that** their balance is updated.

**Acceptance Criteria:**
- Given I am authenticated as Librarian or Admin
- When I POST to /api/v1/fees/payments with member_id and amount
- Then the payment is recorded and applied to outstanding fees
- And partial payments are allowed (outstanding fees reduced by payment amount)
- And the response includes the new outstanding balance

---

## Epic 6: Reporting

### US-RPT-001: View Overdue Report
**As a** Librarian, **I want to** see all overdue checkouts, **so that** I can follow up with members.

**Acceptance Criteria:**
- Given I am authenticated as Librarian or Admin
- When I GET /api/v1/reports/overdue
- Then I receive a list of overdue checkouts with member_name, member_email, book_title, checkout_date, due_date, days_overdue
- And if I am a Member, I receive a 403 FORBIDDEN

### US-RPT-002: View Collection Summary
**As an** Admin, **I want to** see a summary of library operations, **so that** I have a dashboard view.

**Acceptance Criteria:**
- Given I am authenticated as Admin
- When I GET /api/v1/reports/summary
- Then I receive: total_books, total_members, books_checked_out, books_available, total_outstanding_fees
- And if I am not Admin, I receive a 403 FORBIDDEN

---

## Epic 7: System Operations

### US-SYS-001: Catalog Health Check
**As a** monitoring system, **I want to** check the Catalog Service health, **so that** I can detect outages.

**Acceptance Criteria:**
- When I GET /api/v1/catalog/health (public endpoint)
- Then I receive status and version information

### US-SYS-002: Lending Health Check
**As a** monitoring system, **I want to** check the Lending Service health, **so that** I can detect outages.

**Acceptance Criteria:**
- When I GET /api/v1/lending/health (public endpoint)
- Then I receive status and version information

---

## Story-Persona Mapping

| Story | Admin | Librarian | Member | Public |
|-------|-------|-----------|--------|--------|
| US-CAT-001 Add Book | ✅ | ✅ | ❌ | ❌ |
| US-CAT-002 Update Book | ✅ | ✅ | ❌ | ❌ |
| US-CAT-003 Get Book | ✅ | ✅ | ✅ | ❌ |
| US-CAT-004 List Books | ✅ | ✅ | ✅ | ❌ |
| US-CAT-005 Delete Book | ✅ | ✅ | ❌ | ❌ |
| US-CAT-006 Search Books | ✅ | ✅ | ✅ | ❌ |
| US-AUTH-001 Register | ❌ | ❌ | ❌ | ✅ |
| US-AUTH-002 Login | ❌ | ❌ | ❌ | ✅ |
| US-AUTH-003 View My Profile | ✅ | ✅ | ✅ | ❌ |
| US-AUTH-004 Update Profile | ✅ | ✅ | ✅ | ❌ |
| US-AUTH-005 View Any Profile | ✅ | ✅ | ❌ | ❌ |
| US-AUTH-006 Deactivate | ✅ | ❌ | ❌ | ❌ |
| US-LND-001 Checkout | ✅ | ✅ | ✅ | ❌ |
| US-LND-002 Return | ✅ | ✅ | ✅(own) | ❌ |
| US-LND-003 Renew | ✅ | ✅ | ✅(own) | ❌ |
| US-LND-004 Active Checkouts | ✅(any) | ✅(any) | ✅(own) | ❌ |
| US-HLD-001 Place Hold | ✅ | ✅ | ✅ | ❌ |
| US-HLD-002 Cancel Hold | ✅(any) | ✅(any) | ✅(own) | ❌ |
| US-HLD-003 Hold Queue | ✅ | ✅ | ✅ | ❌ |
| US-HLD-004 My Holds | ✅ | ✅ | ✅ | ❌ |
| US-FEE-001 My Fees | ✅ | ✅ | ✅ | ❌ |
| US-FEE-002 Any Fees | ✅ | ✅ | ❌ | ❌ |
| US-FEE-003 Payment | ✅ | ✅ | ❌ | ❌ |
| US-RPT-001 Overdue | ✅ | ✅ | ❌ | ❌ |
| US-RPT-002 Summary | ✅ | ❌ | ❌ | ❌ |
| US-SYS-001 Catalog Health | ✅ | ✅ | ✅ | ✅ |
| US-SYS-002 Lending Health | ✅ | ✅ | ✅ | ✅ |
