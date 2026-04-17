# Units of Work

## Unit 1: Catalog Service

### Definition
An independently deployable FastAPI service managing the book inventory for the community library.

### Responsibilities
- Book CRUD (create, read, update, delete)
- Book search (full-text by title/author, filter by category/availability)
- Book availability tracking (total_copies, available_copies)
- Internal availability API for Lending Service consumption
- Health check endpoint

### Code Organization
```
workspace/
  catalog-service/
    src/
      catalog_service/
        __init__.py
        main.py              # FastAPI app entry point
        config.py             # Configuration settings
        models/
          __init__.py
          book.py             # Book Pydantic models (request/response)
        domain/
          __init__.py
          entities.py         # Book domain entity
        repositories/
          __init__.py
          base.py             # Abstract repository
          in_memory.py        # In-memory implementation for testing/dev
        services/
          __init__.py
          book_service.py     # Book business logic
        api/
          __init__.py
          routes.py           # Route handlers
          dependencies.py     # FastAPI dependencies (auth, repos)
        auth/
          __init__.py
          middleware.py       # JWT validation middleware
          dependencies.py     # Auth dependencies
        core/
          __init__.py
          exceptions.py       # Custom exceptions
          responses.py        # Response envelope helpers
          logging.py          # Structured logging setup
    tests/
      __init__.py
      conftest.py             # Shared fixtures
      test_book_service.py    # Unit tests for BookService
      test_routes.py          # Integration tests for API routes
      test_models.py          # Model validation tests
    pyproject.toml
```

### Deployment Profile
- Read-heavy workload (search/browse most frequent)
- Own data store (Catalog DB)
- Runs on port 8000

---

## Unit 2: Lending Service

### Definition
An independently deployable FastAPI service managing member authentication, lending operations, holds, fees, and reporting.

### Responsibilities
- Member registration, authentication (JWT), profile management
- Checkout, return, renewal with policy enforcement
- Hold queue management (FIFO, placement, cancellation, fulfillment)
- Fee tracking and payment processing
- Overdue report and collection summary
- Inter-service communication with Catalog Service
- Health check endpoint

### Code Organization
```
workspace/
  lending-service/
    src/
      lending_service/
        __init__.py
        main.py              # FastAPI app entry point
        config.py             # Configuration settings
        models/
          __init__.py
          member.py           # Member Pydantic models
          checkout.py         # Checkout Pydantic models
          hold.py             # Hold Pydantic models
          fee.py              # Fee/Payment Pydantic models
          auth.py             # Auth models (login, token)
          report.py           # Report response models
        domain/
          __init__.py
          entities.py         # Domain entities (Member, Checkout, Hold, Fee, Payment)
        repositories/
          __init__.py
          base.py             # Abstract repositories
          in_memory.py        # In-memory implementations
        services/
          __init__.py
          auth_service.py     # JWT + bcrypt
          member_service.py   # Member business logic
          checkout_service.py # Checkout/return/renewal logic
          hold_service.py     # Hold management
          fee_service.py      # Fee calculation + payment
          report_service.py   # Reports
          catalog_client.py   # HTTP client to Catalog Service
        api/
          __init__.py
          member_routes.py    # Member endpoints
          checkout_routes.py  # Checkout endpoints
          hold_routes.py      # Hold endpoints
          fee_routes.py       # Fee endpoints
          report_routes.py    # Report endpoints
          dependencies.py     # FastAPI dependencies
        auth/
          __init__.py
          middleware.py       # JWT validation middleware
          dependencies.py     # Auth dependencies
        core/
          __init__.py
          exceptions.py       # Custom exceptions
          responses.py        # Response envelope helpers
          logging.py          # Structured logging setup
    tests/
      __init__.py
      conftest.py             # Shared fixtures, mock catalog client
      test_auth_service.py
      test_member_service.py
      test_checkout_service.py
      test_hold_service.py
      test_fee_service.py
      test_report_service.py
      test_member_routes.py
      test_checkout_routes.py
      test_hold_routes.py
      test_fee_routes.py
      test_report_routes.py
    pyproject.toml
```

### Deployment Profile
- Write-heavy workload (checkouts/returns/holds are writes)
- Own data store (Lending DB)
- Depends on Catalog Service (HTTP)
- Runs on port 8001

---

## Build Order
1. **Catalog Service first** — Lending Service depends on it for availability verification
2. **Lending Service second** — consumes Catalog Service APIs
