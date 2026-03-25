# BookShelf Community Library API — Requirements Document

## Intent Analysis Summary

| Attribute | Value |
|-----------|-------|
| **User Request** | Build a cloud-deployed BookShelf platform with two independently deployable services (Catalog Service and Lending Service) for community library management |
| **Request Type** | New Project (Greenfield) |
| **Scope Estimate** | System-wide — two microservices with shared auth, event-driven communication, and comprehensive business rules |
| **Complexity Estimate** | Complex — multiple services, RBAC, async events, lending policy enforcement, inter-service communication |
| **Requirements Depth** | Comprehensive |

---

## 1. Functional Requirements

### 1.1 Catalog Service

#### FR-CAT-001: Book CRUD Operations
- Add a book with: title, author, ISBN (optional), category, total_copies
- Update book metadata (title, author, ISBN, category, total_copies)
- Retrieve a single book by ID
- List all books
- Delete a book (soft-delete or hard-delete — librarian/admin only)
- All string fields have maximum length constraints

#### FR-CAT-002: Book Search
- Full-text search across title and author fields (substring match)
- Filter by category
- Filter by availability (available copies > 0)
- Combined search + filter supported

#### FR-CAT-003: Book Availability Tracking
- Each book tracks `total_copies` and `available_copies`
- `available_copies` decremented on checkout (via event or API call from Lending Service)
- `available_copies` incremented on return (via event or API call from Lending Service)
- `available_copies` must never go below 0 or above `total_copies`

#### FR-CAT-004: Book Availability API
- Internal API endpoint for Lending Service to verify book existence and available copies
- Returns book ID, title, total_copies, available_copies

#### FR-CAT-005: Health Check
- `GET /api/v1/catalog/health` returns service status and version

### 1.2 Lending Service

#### FR-LND-001: Member Registration
- Register with: name, email, password
- Email must be unique
- Password stored using adaptive hashing (bcrypt)
- Auto-assigned "member" role on registration
- Returns member ID and profile (excluding password)

#### FR-LND-002: Member Authentication
- Login with email and password
- Returns JWT token with 24-hour expiry
- JWT contains: member_id, email, role
- Both services validate JWTs independently

#### FR-LND-003: Member Profile Management
- Members can view and update their own profile (name, email)
- Admins can view any member's profile
- Librarians can view any member's profile

#### FR-LND-004: Role-Based Access Control
- Three roles: Admin, Librarian, Member
- **Admin**: Full access to all endpoints in both services
- **Librarian**: Catalog management (CRUD, search), lending operations (process returns, manage holds), view reports
- **Member**: Self-service (own checkouts, own holds, own fees, own profile, search catalog)
- **Public**: Registration, login, health check — no JWT required

#### FR-LND-005: Checkout
- Member checks out a book by book ID
- Validations before checkout:
  - Book exists (verified via HTTP call to Catalog Service)
  - Available copies > 0
  - Member active checkout count < 5 (configurable max)
  - Member outstanding fees ≤ $10.00 threshold (configurable); block if exceeded
- On successful checkout:
  - Record checkout with: member_id, book_id, checkout_date (UTC), due_date (checkout_date + 14 days), status=active, renewal_count=0
  - Decrement available_copies in Catalog Service
- Due date: 14 days from checkout date

#### FR-LND-006: Return
- Member or Librarian/Admin returns a book by checkout ID
- On return:
  - Calculate late fee if overdue: $0.25/day, capped at $10.00 per checkout
  - If late fee > 0, create fee record for the member
  - Update checkout status to "returned", set return_date
  - Increment available_copies in Catalog Service
  - Check hold queue synchronously: if holds exist for this book, fulfill the next hold (update hold status to "ready")
- All timestamps in UTC

#### FR-LND-007: Renewal
- Member renews an active checkout by checkout ID
- Validations:
  - Checkout is active (not returned)
  - Checkout belongs to requesting member
  - Renewal count < 2 (max 2 renewals per checkout)
  - No active holds exist for the book
- On renewal: extend due_date by 14 days from current due_date, increment renewal_count

#### FR-LND-008: Active Checkouts
- List active checkouts for the requesting member
- Each record includes: checkout_id, book_id, book_title, checkout_date, due_date, renewal_count
- Admins/Librarians can list active checkouts for any member

#### FR-LND-009: Hold Placement
- Member places a hold on a book by book ID
- Validations:
  - Book exists (verified via Catalog Service)
  - No available copies (available_copies == 0)
  - Member active hold count < 3 (configurable max)
  - Member does not already have an active hold on this book
- On placement: record hold with member_id, book_id, hold_date, status=waiting, queue_position (FIFO)

#### FR-LND-010: Hold Cancellation
- Member cancels their own hold by hold ID
- Librarian/Admin can cancel any hold
- On cancellation: update status to "cancelled", re-order queue positions

#### FR-LND-011: Hold Queue Status
- Get hold queue for a specific book: list of holds with position and status
- Member can see their own position in the queue

#### FR-LND-012: Hold Fulfillment (Synchronous MVP)
- When a book is returned and holds exist in "waiting" status for that book:
  - Fulfill the first hold in FIFO order
  - Update hold status from "waiting" to "ready"
  - No grace period — immediate fulfillment
- True asynchronous processing (SQS/EventBridge) deferred to Phase 2

#### FR-LND-013: Fee Tracking
- Track outstanding fees per member
- Fee record includes: fee_id, member_id, checkout_id, amount, created_date, status (outstanding/paid/partial)
- List all fees for the requesting member
- Admins/Librarians can view fees for any member

#### FR-LND-014: Fee Payment
- Record a payment against a member's outstanding fees
- Partial payments allowed
- Admins and Librarians can process payments
- Payment record includes: payment_id, member_id, amount, payment_date

#### FR-LND-015: Overdue Report
- List all currently overdue checkouts (due_date < now and status=active)
- Include: member name, member email, book title, checkout_date, due_date, days_overdue
- Accessible by Librarian and Admin roles only

#### FR-LND-016: Collection Summary
- Total books, total members, books checked out, books available, total outstanding fees
- Accessible by Admin role only

#### FR-LND-017: Health Check
- `GET /api/v1/lending/health` returns service status and version

### 1.3 Inter-Service Communication

#### FR-ISC-001: Book Verification
- Lending Service calls Catalog Service via HTTP to verify book existence and availability before checkout/hold placement
- Direct HTTP call (not event-driven) for synchronous validation

#### FR-ISC-002: Availability Updates
- Lending Service calls Catalog Service via HTTP to decrement/increment available_copies on checkout/return
- Atomic operation — if update fails, the checkout/return operation must also fail

### 1.4 Account Deactivation Behavior

#### FR-ACC-001: Account Deactivation
- Admin can deactivate a member account
- Deactivated accounts: existing holds and checkouts remain active, but no new checkouts, holds, or renewals allowed
- Account suspension is out of MVP scope (automated suspension deferred to Phase 2)

---

## 2. Non-Functional Requirements

### 2.1 Performance
| Metric | Target |
|--------|--------|
| API response time (p95) | < 100ms |
| Full-text search latency | < 200ms |
| Concurrent users | 100 simultaneous |
| Inter-service call overhead | < 50ms added latency |

### 2.2 Reliability
| Metric | Target |
|--------|--------|
| API uptime | 99.9% |
| Data durability | Multi-AZ replication |

### 2.3 Security
- RBAC with three roles enforced on all endpoints
- JWT authentication with 24-hour expiry
- Password hashing with bcrypt
- Input validation via Pydantic on all endpoints
- No PII in logs
- Encryption at rest and in transit
- Security extension rules (SECURITY-01 through SECURITY-15) enforced

### 2.4 Scalability
- Each service scales independently
- Catalog Service optimized for read-heavy workload
- Lending Service optimized for write-heavy workload
- Single-library deployment for MVP (multi-tenant in Phase 2)

### 2.5 Testing
| Test Type | Target |
|-----------|--------|
| Unit test coverage | ≥ 90% line coverage |
| Integration tests | All API endpoints tested |
| Contract tests | All endpoints match OpenAPI spec |

### 2.6 Maintainability
- Solo developer maintainable
- Infrastructure cost < $50/month
- Clean separation between services
- Consistent API envelope format

---

## 3. API Design Standards

- **Style**: REST with JSON
- **Versioning**: URL path prefix `/api/v1/`
- **Field naming**: snake_case
- **Success envelope**: `{ "status": "ok", "data": { ... } }`
- **Error envelope**: `{ "status": "error", "error": { "code": "ERROR_CODE", "message": "..." } }`
- **Error codes**: VALIDATION_ERROR (422), NOT_FOUND (404), UNAUTHORIZED (401), FORBIDDEN (403), CONFLICT (409), INTERNAL_ERROR (500)

---

## 4. Technology Stack

- **Language**: Python 3.13+
- **Framework**: FastAPI 0.115+ with Pydantic 2.x
- **Server**: uvicorn 0.34+
- **Testing**: pytest 8.x, pytest-asyncio, httpx, pytest-cov
- **Linting**: ruff 0.9+
- **Package manager**: uv
- **Infrastructure**: AWS CDK 2.x (deferred — application code only for MVP)
- **Cloud**: AWS us-east-1
- **Database**: To be determined during NFR Requirements / Infrastructure Design stages

---

## 5. Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Service architecture | Two independent services (Catalog + Lending) | Vision requirement; independent scaling |
| Authentication | Application-level JWT (PyJWT + bcrypt); both services validate JWTs | Simpler than Cognito for MVP; member data owned by Lending Service |
| Inter-service communication (sync) | Direct HTTP calls via httpx | Simple, testable; Lending → Catalog for book verification |
| Hold fulfillment | Synchronous on return | Simpler for MVP; true async deferred to Phase 2 |
| Fee threshold for checkout | Block checkout if outstanding fees > $10.00 | Configurable threshold; balances enforcement with usability |
| Late fee cap | $10.00 per checkout | Fixed cap as stated in vision |
| CDK infrastructure | Deferred — app code only for MVP | Focus on working application; deployment docs provided |
| Database | Deferred to NFR stages | Tech-env lists DynamoDB and RDS as options; choice depends on access patterns |

---

## 6. MVP Scope Boundaries

### In Scope
- Book CRUD, search, availability tracking
- Member registration, login, JWT auth, profile management
- RBAC (Admin, Librarian, Member)
- Checkout, return, renewal with full policy enforcement
- Hold placement, cancellation, queue status, synchronous fulfillment
- Fee tracking and payment
- Overdue report and collection summary
- Health checks for both services
- Unit and integration tests (≥90% coverage)
- OpenAPI specification

### Out of Scope (Deferred)
- Email notifications (Phase 2)
- Multi-tenant support (Phase 2)
- Barcode/ISBN scanning (Phase 2)
- Advanced analytics (Phase 2)
- Recommendation engine (Phase 3)
- Account suspension automation (Phase 2)
- Password reset (Phase 2)
- Pagination (Phase 2)
- CDK infrastructure code (deployment docs only)

---

## 7. Open Decisions for Later Stages

| Decision | Stage |
|----------|-------|
| Database choice (DynamoDB vs RDS PostgreSQL) | NFR Requirements / Infrastructure Design |
| Compute choice (Lambda vs Fargate) | NFR Requirements / Infrastructure Design |
| API Gateway configuration | Infrastructure Design |
| Messaging infrastructure for Phase 2 | Infrastructure Design |
