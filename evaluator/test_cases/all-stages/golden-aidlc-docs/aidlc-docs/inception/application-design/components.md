# Application Components

## Service 1: Catalog Service

### Component: BookRepository
- **Purpose**: Data access layer for book persistence
- **Responsibilities**: CRUD operations on book records, search queries, availability updates
- **Interface**: Abstract repository pattern (allows swapping database implementations)

### Component: BookService
- **Purpose**: Business logic for catalog operations
- **Responsibilities**: Book validation, search orchestration, availability management, business rule enforcement
- **Interface**: Called by API route handlers

### Component: CatalogAPI (Routes)
- **Purpose**: REST API endpoint handlers for the Catalog Service
- **Responsibilities**: Request parsing, response formatting, RBAC enforcement via middleware, route definitions
- **Endpoints**:
  - `POST /api/v1/books` — Add book (Librarian, Admin)
  - `GET /api/v1/books` — List books (authenticated)
  - `GET /api/v1/books/{book_id}` — Get book (authenticated)
  - `PUT /api/v1/books/{book_id}` — Update book (Librarian, Admin)
  - `DELETE /api/v1/books/{book_id}` — Delete book (Librarian, Admin)
  - `GET /api/v1/books/search` — Search books (authenticated)
  - `GET /api/v1/catalog/health` — Health check (public)
  - Internal: `GET /api/v1/books/{book_id}/availability` — Availability check (service-to-service)
  - Internal: `POST /api/v1/books/{book_id}/availability` — Update availability (service-to-service)

### Component: AuthMiddleware (Catalog)
- **Purpose**: JWT validation and role extraction for Catalog Service
- **Responsibilities**: Token verification, role-based route protection, request context enrichment

---

## Service 2: Lending Service

### Component: MemberRepository
- **Purpose**: Data access for member records
- **Responsibilities**: CRUD operations on member records, email uniqueness enforcement

### Component: MemberService
- **Purpose**: Business logic for member management
- **Responsibilities**: Registration, profile management, password hashing, account deactivation

### Component: AuthService
- **Purpose**: Authentication and JWT token management
- **Responsibilities**: Login validation, JWT generation, JWT verification, password hashing with bcrypt

### Component: CheckoutRepository
- **Purpose**: Data access for checkout records
- **Responsibilities**: CRUD on checkout records, queries for active/overdue checkouts

### Component: CheckoutService
- **Purpose**: Business logic for checkout, return, and renewal operations
- **Responsibilities**: Checkout validation (limits, fees, availability), return processing (fee calculation, hold fulfillment trigger), renewal validation (limits, hold checks), inter-service calls to Catalog Service

### Component: HoldRepository
- **Purpose**: Data access for hold records
- **Responsibilities**: CRUD on hold records, FIFO queue management, queue position queries

### Component: HoldService
- **Purpose**: Business logic for hold management
- **Responsibilities**: Hold placement validation (limits, availability, duplicates), cancellation with queue reorder, hold fulfillment on return

### Component: FeeRepository
- **Purpose**: Data access for fee and payment records
- **Responsibilities**: CRUD on fee records, payment tracking, outstanding balance queries

### Component: FeeService
- **Purpose**: Business logic for fee management
- **Responsibilities**: Fee creation on late return, payment processing, balance calculations

### Component: ReportService
- **Purpose**: Business logic for reporting
- **Responsibilities**: Overdue checkout aggregation, collection summary computation

### Component: CatalogClient
- **Purpose**: HTTP client for communicating with the Catalog Service
- **Responsibilities**: Book existence verification, availability checks, availability updates (increment/decrement)

### Component: LendingAPI (Routes)
- **Purpose**: REST API endpoint handlers for the Lending Service
- **Responsibilities**: Request parsing, response formatting, RBAC enforcement, route definitions
- **Endpoints**:
  - `POST /api/v1/members/register` — Register (public)
  - `POST /api/v1/members/login` — Login (public)
  - `GET /api/v1/members/me` — My profile (authenticated)
  - `PUT /api/v1/members/me` — Update profile (authenticated)
  - `GET /api/v1/members/{member_id}` — Get member (Admin, Librarian)
  - `PUT /api/v1/members/{member_id}/deactivate` — Deactivate (Admin)
  - `POST /api/v1/checkouts` — Checkout (authenticated)
  - `POST /api/v1/checkouts/{checkout_id}/return` — Return (authenticated)
  - `POST /api/v1/checkouts/{checkout_id}/renew` — Renew (authenticated)
  - `GET /api/v1/checkouts` — List checkouts (authenticated)
  - `POST /api/v1/holds` — Place hold (authenticated)
  - `DELETE /api/v1/holds/{hold_id}` — Cancel hold (authenticated)
  - `GET /api/v1/holds` — List holds (authenticated)
  - `GET /api/v1/holds/me` — My holds (authenticated)
  - `GET /api/v1/fees/me` — My fees (authenticated)
  - `GET /api/v1/fees` — List fees (Admin, Librarian)
  - `POST /api/v1/fees/payments` — Process payment (Admin, Librarian)
  - `GET /api/v1/reports/overdue` — Overdue report (Admin, Librarian)
  - `GET /api/v1/reports/summary` — Collection summary (Admin)
  - `GET /api/v1/lending/health` — Health check (public)

### Component: AuthMiddleware (Lending)
- **Purpose**: JWT validation and role extraction for Lending Service
- **Responsibilities**: Token verification, role-based route protection, request context enrichment

---

## Shared Concerns

### Cross-Cutting: Structured Logging
- **Purpose**: Centralized logging configuration for both services
- **Responsibilities**: Request/response logging with correlation IDs, PII filtering, structured JSON output

### Cross-Cutting: Error Handling
- **Purpose**: Global exception handling middleware
- **Responsibilities**: Catch unhandled exceptions, return standardized error responses, log errors without exposing internals

### Cross-Cutting: Response Envelope
- **Purpose**: Consistent API response formatting
- **Responsibilities**: Wrap all responses in `{"status": "ok/error", "data/error": ...}` format
