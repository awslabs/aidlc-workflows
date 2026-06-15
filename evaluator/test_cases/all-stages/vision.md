# Vision Document: BookShelf Community Library API

## Executive Summary

BookShelf is a cloud-deployed platform consisting of two independently deployable services — a Catalog Service and a Lending Service — that together enable community libraries to manage their book inventory and member lending operations. It replaces the spreadsheet-and-email workflow that small libraries use today with a structured system that tracks who has what, enforces lending policies automatically, and processes hold fulfillment asynchronously when books are returned. The expected outcome is a deployable system that a library with 10,000 books and 2,000 members can run on AWS.

---

## Business Context

### Problem Statement

Small community libraries (neighborhood lending libraries, office book-shares, school libraries without integrated library systems) manage lending with spreadsheets, honor systems, or sticky notes. This causes:

- **Lost books**: No reliable record of who borrowed what. Libraries lose 15-20% of inventory annually.
- **Unfair access**: Popular books sit on one person's shelf for months. There is no hold or waitlist system.
- **No accountability**: Late returns go untracked. Members who abuse the system face no consequences.
- **Manual overhead**: A volunteer librarian spends 5-10 hours/week on email reminders, manual tracking, and reconciliation.

### Business Drivers

- Community libraries are growing (Little Free Library alone has 175,000+ registered locations).
- Existing integrated library systems (Koha, Evergreen) are built for municipal libraries and are far too complex and expensive for a 500-book neighborhood collection.
- The API-first approach allows any frontend (mobile app, Slack bot, web portal) to integrate without coupling to a specific UI.

### Target Users and Stakeholders

| User Type | Description | Primary Need |
|-----------|-------------|--------------|
| Librarian | Volunteer who manages the physical collection. Adds books, processes returns, resolves disputes. | Efficient tools to manage the catalog and see who has overdue books at a glance. |
| Member | Person who borrows and returns books. Browses the catalog, places holds, checks their account. | Easy way to find available books, check out, and know when holds become available. |
| Admin | Person responsible for the library's operations. Manages member accounts, configures lending policies, views reports. | Oversight of the entire system: usage reports, policy configuration, member management. |

### Business Constraints

- Budget: Open-source project. Infrastructure cost must stay under $50/month for a typical deployment.
- Team: Solo developer building the MVP. Must be maintainable by one person.
- Timeline: MVP within 3 months.
- No UI: API only. Frontend is out of scope.

### Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| API uptime | 99.9% | CloudWatch availability monitoring |
| Response time (p95) | < 100ms for all endpoints | CloudWatch latency metrics |
| Concurrent users supported | 100 simultaneous | Load test with k6 |
| Book loss rate (user-reported) | < 5% annually | Overdue tracking reports |
| Late return rate | < 20% of checkouts | Checkout duration analysis |

---

## Full Scope Vision

### Product Vision Statement

BookShelf becomes the standard backend for any small-to-medium lending library, the way WordPress became the standard for small websites: simple to deploy, easy to extend, and free to use.

### Feature Areas

#### Feature Area 1: Catalog Management

- **Description**: An independently deployable Catalog Service responsible for the book inventory. This service owns all book data and exposes search capabilities. The Lending Service queries the Catalog Service to verify book existence and availability before processing checkouts.
- **Key Capabilities**:
  - Add, update, and remove books with title, author, ISBN, category, and copy count
  - Full-text search across title and author
  - Category-based browsing and filtering
  - Multi-copy tracking (a library may own 3 copies of the same title)
  - Book condition tracking and decommissioning
  - Barcode/ISBN scanning integration
  - Availability tracking API consumed by the Lending Service
- **User Value**: Librarians manage inventory from any device. Members find books without walking to the shelf.
- **Scaling Profile**: Read-heavy (search and browse are the most frequent operations). Must support fast search responses under concurrent load.

#### Feature Area 2: Lending and Circulation

- **Description**: A separate Lending Service handling checkout, return, renewal, and hold management with policy enforcement. The Lending Service operates independently from the Catalog Service and communicates via asynchronous events.
- **Key Capabilities**:
  - Checkout with automatic due-date calculation
  - Return processing with condition check
  - Renewal (up to N times, configurable)
  - Hold queue with FIFO ordering and automatic notification when a book is returned
  - Asynchronous hold fulfillment: when a book is returned, the Lending Service publishes a "book returned" event; a hold processor consumes this event and notifies the next member in the queue
  - Lending policy enforcement (max active checkouts, max active holds)
  - Late fee calculation and payment tracking
  - Overdue notifications (email, webhook)
  - Lending history per member
- **User Value**: Members borrow and return without librarian involvement for routine transactions. Policies are enforced automatically.
- **Scaling Profile**: Write-heavy (every checkout/return/renewal is a write). Must handle bursts during library open hours.

#### Feature Area 3: Member and Access Management

- **Description**: Member accounts, roles, and authentication.
- **Key Capabilities**:
  - Member registration and profile management
  - Role-based access control (Admin, Librarian, Member)
  - Authentication via email/password with JWT tokens
  - Account suspension for policy violations
  - Member lending history and current account status
- **User Value**: Each person has their own account with appropriate permissions.

#### Feature Area 4: Reporting and Analytics

- **Description**: Operational reports for library administrators.
- **Key Capabilities**:
  - Most borrowed books report
  - Overdue books report
  - Member activity report
  - Collection utilization (what percentage of books are currently checked out)
  - Fee collection summary
- **User Value**: Admins understand how the library is being used and where problems exist.

#### Feature Area 5: Notifications

- **Description**: Automated notifications for lending events.
- **Key Capabilities**:
  - Due date reminders (3 days before, day of, 1 day after)
  - Hold available notification
  - Account suspension notification
  - Overdue escalation notifications
- **User Value**: Members never forget a due date. Hold availability is communicated instantly.

### Inter-Service Communication

- **Catalog Service → Lending Service**: The Lending Service calls the Catalog Service's internal API to verify book existence and available copies before checkout.
- **Lending Service → Catalog Service**: On checkout, the Lending Service publishes a "copies decremented" event. On return, it publishes a "copies incremented" event. The Catalog Service consumes these to update availability counts.
- **Lending Service → Hold Processor**: On return, the Lending Service publishes a "book returned" event. An asynchronous hold processor checks the hold queue and notifies the next member.
- **Event bus**: Services communicate asynchronously via a message queue for eventual consistency.

### External Integration Points

- **Email service** (SES or SNS) - Notification delivery
- **Authentication provider** - Member authentication and JWT issuance
- **Monitoring** - Operational metrics, structured logging, and alerting per service

### Scalability and Growth

- The two-service architecture allows each service to scale independently: Catalog Service scales for read throughput, Lending Service scales for write throughput.
- Start with single-library deployment. Expand to multi-tenant (one API serving many libraries) in Phase 2.
- Support up to 100,000 books and 20,000 members per tenant in Phase 2.

### Long-Term Roadmap

| Phase | Focus | Timeframe |
|-------|-------|-----------|
| MVP | Catalog CRUD, lending with policy enforcement, member management with roles, basic reports, hold queue, late fees | Months 1-3 |
| Phase 2 | Notifications (email), multi-tenant support, barcode scanning API, advanced analytics | Months 4-8 |
| Phase 3 | Recommendation engine, inter-library loan, mobile push notifications | Months 9-14 |

---

## MVP Scope

### MVP Objective

Deliver two independently deployable services (Catalog Service and Lending Service) that a community library can deploy to manage its catalog and lending operations, replacing manual tracking with automated policy enforcement and asynchronous hold fulfillment.

### MVP Success Criteria

- [ ] All MVP endpoints implemented and tested
- [ ] 90%+ line coverage on unit tests
- [ ] All contract tests pass against the OpenAPI specification
- [ ] Lending policy rules (checkout limits, hold limits, late fees, renewals) enforced correctly
- [ ] Role-based access control working for all three roles
- [ ] API responds within 100ms (p95) under load test
- [ ] Deployable to AWS with infrastructure-as-code

### Features In Scope (MVP)

| Feature | Description | Priority | Rationale for Inclusion |
|---------|-------------|----------|------------------------|
| Book CRUD | Add, update, get, list, delete books with title, author, ISBN, category, total_copies | Must Have | Core catalog functionality. Cannot lend books without a catalog. |
| Book search | Search books by title or author substring, filter by category and availability | Must Have | Members need to find books. Librarians need to look up specific titles. |
| Book availability | Track available_copies vs total_copies. Decrement on checkout, increment on return. | Must Have | Prevents double-lending of the same physical copy. |
| Member registration | Register with name, email, password. Auto-assigned Member role. | Must Have | Users need accounts to borrow books. |
| Member profile | Get and update own profile. Admins can get any member profile. | Must Have | Basic account management. |
| Role-based access | Three roles: Admin (full access), Librarian (catalog + lending management), Member (self-service borrowing) | Must Have | Different users have different permissions. Core security requirement. |
| JWT authentication | Login returns JWT. All protected endpoints require valid JWT. Token expiry at 24 hours. | Must Have | Stateless auth for API. Required for role enforcement. |
| Checkout | Member checks out a book. System validates: book exists, copies available, member under checkout limit (max 5). Records due date (14 days from checkout). | Must Have | Core lending operation. |
| Return | Member or librarian returns a book. System calculates late fee if overdue ($0.25/day, capped at $10.00). Updates available copies. | Must Have | Core lending operation. |
| Renewal | Member renews an active checkout. Extends due date by 14 days. Max 2 renewals per checkout. Cannot renew if book has active holds. | Must Have | Common member need. Reduces overdue returns. |
| Active checkouts | List active checkouts for a member. Include book details, checkout date, due date, renewal count. | Must Have | Members need to see what they have checked out. |
| Hold placement | Member places a hold on an unavailable book. System validates: book exists, no available copies, member under hold limit (max 3), member does not already hold this book. Hold queue is FIFO. | Must Have | Fair access to popular books. |
| Hold cancellation | Member cancels own hold. Librarian or Admin can cancel any hold. | Must Have | Members change their minds. Librarians manage the queue. |
| Hold queue status | Get position in hold queue for a specific book. | Must Have | Members want to know how long they will wait. |
| Fee tracking | Track outstanding fees per member. Fee generated automatically on late return. | Must Have | Accountability for late returns. |
| Fee payment | Record fee payment (partial or full). Admins and librarians can process payments. | Must Have | Members need a way to clear their balance. |
| Overdue report | List all currently overdue checkouts with member info and days overdue. Librarian and Admin access. | Must Have | Librarians need to follow up on overdue books. |
| Collection summary | Total books, total members, books checked out, books available, total outstanding fees. Admin access. | Must Have | Admins need a dashboard view of library status. |
| Health check | GET /health returns status and version. | Must Have | Operational monitoring. |

### Features Explicitly Out of Scope (MVP)

| Feature | Reason for Deferral | Target Phase |
|---------|-------------------|--------------|
| Email notifications | Adds SES/SNS dependency and async processing complexity. Manual check of overdue report is sufficient for MVP. | Phase 2 |
| Multi-tenant support | Single-library deployment is sufficient to validate the product. Multi-tenancy adds significant data isolation complexity. | Phase 2 |
| Barcode/ISBN scanning | Requires external ISBN lookup API integration. Manual entry is acceptable for MVP. | Phase 2 |
| Advanced analytics | Basic overdue report and collection summary cover MVP needs. | Phase 2 |
| Recommendation engine | Requires usage history analysis. Not needed until library has enough data. | Phase 3 |
| Inter-library loan | Multi-tenant prerequisite. | Phase 3 |
| Account suspension | Manual process via Admin is sufficient for MVP. Automated suspension adds business rule complexity. | Phase 2 |
| Password reset | Out of scope for MVP. Admin can create new accounts. | Phase 2 |
| Pagination | All list endpoints return full results in MVP. Acceptable for libraries under 10,000 books. | Phase 2 |

### MVP User Journeys

#### Journey 1: Librarian Adds Books and Manages the Catalog

1. Librarian authenticates with email/password, receives JWT token.
2. Librarian adds 5 new books via POST /api/v1/books with title, author, ISBN, category, and copy count.
3. Librarian searches for a book by title to verify it was added correctly.
4. Librarian updates a book's copy count when a donated copy arrives.
5. Librarian views the collection summary to see total inventory.

**Outcome**: Library catalog is up to date and searchable.

#### Journey 2: Member Borrows, Renews, and Returns a Book

1. Member registers via POST /api/v1/members/register, then logs in.
2. Member searches for "Python" and finds 3 matching books.
3. Member checks out "Fluent Python" via POST /api/v1/checkouts.
4. After 10 days, member renews the checkout for another 14 days.
5. Member returns the book on time. No fee is charged.

**Outcome**: Member borrows and returns a book through the full lifecycle.

#### Journey 3: Member Places a Hold on a Popular Book

1. Member searches for "Designing Data-Intensive Applications" and sees 0 available copies.
2. Member places a hold via POST /api/v1/holds.
3. Member checks hold queue position: 2nd in line.
4. Another member returns the book. The first hold in queue is fulfilled.
5. When the first-in-line member returns, our member's hold advances to position 1.
6. The book becomes available for our member to check out.

**Outcome**: Fair, automated access to popular books.

#### Journey 4: Late Return with Fee

1. Member checks out a book and does not return it by the due date.
2. Librarian views the overdue report and sees the member's checkout is 5 days late.
3. Member returns the book. System calculates a $1.25 late fee (5 days x $0.25).
4. Member views their outstanding fees.
5. Librarian processes a fee payment.

**Outcome**: Late fees are calculated automatically and tracked until paid.

### MVP Constraints and Assumptions

- **Assumption**: Each service owns its own data store. The Catalog Service and Lending Service do not share a database.
- **Assumption**: 24-hour JWT expiry without refresh tokens is acceptable for MVP.
- **Assumption**: Asynchronous hold fulfillment via message queue is required in MVP — a book return must trigger hold notification without blocking the return response.
- **Accepted Limitation**: No email notifications. Hold notification means updating the hold record status, not sending email.
- **Accepted Limitation**: No pagination. List endpoints return all results.
- **Accepted Limitation**: Single-library deployment only.

### MVP Definition of Done

- [ ] All MVP endpoints implemented and passing contract tests
- [ ] Unit tests with 90%+ line coverage
- [ ] Business rules verified: checkout limits, hold limits, late fees, renewal limits
- [ ] Role-based access enforced on all protected endpoints
- [ ] Load test: 100 concurrent users, p95 < 100ms
- [ ] Both services deployable to AWS with infrastructure-as-code
- [ ] Inter-service communication working (event-driven hold fulfillment)
- [ ] OpenAPI 3.x specification matches implementation

---

## Risks and Dependencies

### Key Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Business rules have edge cases not covered in vision (e.g., what happens when a held book is decommissioned?) | Medium | Medium | Define edge cases during Requirements Analysis and Functional Design. Use clarifying questions. |
| DynamoDB access patterns don't fit relational lending queries (e.g., "all overdue checkouts sorted by days overdue") | Medium | High | Design DynamoDB table and GSI structure carefully during Infrastructure Design. Consider single-table design. |
| JWT auth adds complexity for a solo developer | Low | Medium | Use well-tested library (python-jose or PyJWT). Keep auth simple: no refresh tokens, no OAuth flows. |
| Late fee calculation edge cases (timezone, partial days, fee cap) | Medium | Medium | Define precise rules in Functional Design. Use UTC for all timestamps. |

### External Dependencies

- **AWS Account** - Required for deployment. Developer must have account access.
- **Python 3.13** - Required runtime. Available on AWS Lambda.

### Open Questions

- [ ] Should late fees continue accruing after a configurable maximum number of days, or should they cap at the book's replacement value?
- [ ] When a member with outstanding fees tries to check out a book, should the system block the checkout or just warn?
- [ ] Should the hold queue notify the next member immediately when a book is returned, or should there be a grace period for the returner to re-check-out?
- [ ] What happens to a member's active holds and checkouts if an Admin deactivates their account?
