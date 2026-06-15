# Code Generation Plan — Catalog Service + Lending Service

## Unit Context
- **Workspace Root**: workspace/
- **Project Type**: Greenfield multi-unit (microservices)
- **Structure**: workspace/catalog-service/ and workspace/lending-service/

---

## Catalog Service Steps

- [ ] Step 1: Create Catalog Service project structure (pyproject.toml, src layout, tests dir)
- [ ] Step 2: Create domain entities (Book, AvailabilityInfo)
- [ ] Step 3: Create Pydantic request/response models
- [ ] Step 4: Create core modules (exceptions, response helpers, logging, config)
- [ ] Step 5: Create abstract repository and in-memory implementation
- [ ] Step 6: Create BookService (business logic)
- [ ] Step 7: Create auth middleware (JWT validation)
- [ ] Step 8: Create API routes and FastAPI app
- [ ] Step 9: Create Catalog Service unit tests
- [ ] Step 10: Create Catalog Service integration tests

## Lending Service Steps

- [ ] Step 11: Create Lending Service project structure (pyproject.toml, src layout, tests dir)
- [ ] Step 12: Create domain entities (Member, Checkout, Hold, Fee, Payment)
- [ ] Step 13: Create Pydantic request/response models
- [ ] Step 14: Create core modules (exceptions, response helpers, logging, config)
- [ ] Step 15: Create abstract repositories and in-memory implementations
- [ ] Step 16: Create AuthService (JWT + bcrypt)
- [ ] Step 17: Create MemberService
- [ ] Step 18: Create CheckoutService
- [ ] Step 19: Create HoldService
- [ ] Step 20: Create FeeService
- [ ] Step 21: Create ReportService
- [ ] Step 22: Create CatalogClient (HTTP client)
- [ ] Step 23: Create auth middleware (JWT validation)
- [ ] Step 24: Create API routes (member, checkout, hold, fee, report)
- [ ] Step 25: Create FastAPI app entry point
- [ ] Step 26: Create Lending Service unit tests
- [ ] Step 27: Create Lending Service integration tests

**Total**: 27 steps covering both services
