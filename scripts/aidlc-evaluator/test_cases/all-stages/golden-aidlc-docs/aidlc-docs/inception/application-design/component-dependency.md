# Component Dependencies

## Dependency Matrix

| Component | Depends On | Communication |
|-----------|-----------|---------------|
| CatalogAPI (Routes) | BookService, AuthMiddleware | Direct function calls |
| BookService | BookRepository | Direct function calls |
| BookRepository | Database (abstract) | Database driver |
| AuthMiddleware (Catalog) | JWT library (PyJWT) | Library call |
| LendingAPI (Routes) | All Lending services, AuthMiddleware | Direct function calls |
| MemberService | MemberRepository, AuthService | Direct function calls |
| AuthService | MemberRepository, JWT/bcrypt libs | Library call |
| CheckoutService | CheckoutRepository, HoldService, FeeService, CatalogClient | Direct calls + HTTP |
| HoldService | HoldRepository | Direct function calls |
| FeeService | FeeRepository | Direct function calls |
| ReportService | CheckoutRepository, MemberRepository, BookService (via CatalogClient) | Direct calls + HTTP |
| CatalogClient | Catalog Service API | HTTP (httpx) |

## Inter-Service Communication

```
+------------------+         HTTP (httpx)          +------------------+
|                  | -----------------------------> |                  |
|  Lending Service |   GET /books/{id}/availability |  Catalog Service |
|                  |   POST /books/{id}/availability|                  |
|  (Port 8001)     | -----------------------------> |  (Port 8000)     |
|                  |                                |                  |
+------------------+                                +------------------+
```

### Communication Patterns

1. **Checkout Flow**: LendingAPI → CheckoutService → CatalogClient → Catalog Service (verify + decrement)
2. **Return Flow**: LendingAPI → CheckoutService → CatalogClient (increment) → HoldService (fulfill) → FeeService (create fee if late)
3. **Hold Placement**: LendingAPI → HoldService → CatalogClient → Catalog Service (verify availability = 0)
4. **Search**: CatalogAPI → BookService → BookRepository (direct, no cross-service)

## Internal Layer Dependencies (per service)

```
+-------------------+
|   API Routes      |  (FastAPI route handlers)
+-------------------+
         |
         v
+-------------------+
|   Services        |  (Business logic)
+-------------------+
         |
         v
+-------------------+
|   Repositories    |  (Data access - abstract)
+-------------------+
         |
         v
+-------------------+
|   Database        |  (Concrete implementation)
+-------------------+
```

## Data Ownership

| Data Entity | Owning Service | Storage |
|-------------|---------------|---------|
| Book | Catalog Service | Catalog DB |
| Member | Lending Service | Lending DB |
| Checkout | Lending Service | Lending DB |
| Hold | Lending Service | Lending DB |
| Fee | Lending Service | Lending DB |
| Payment | Lending Service | Lending DB |
