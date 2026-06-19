# Code Generation Patterns

## Purpose
Standards and patterns for generating clean, maintainable code. These principles apply regardless of language and ensure generated code is production-worthy, not prototype-quality.

## Clean Code Principles

### Naming
- **Variables**: Describe what it holds, not the type. Use `customerEmail` not `str1` or `data`.
- **Functions**: Describe what it does using a verb. Use `calculateShippingCost()` not `process()` or `doWork()`.
- **Booleans**: Use `is`, `has`, `can`, `should` prefixes. Use `isActive` not `active` or `flag`.
- **Constants**: Use SCREAMING_SNAKE_CASE for true constants. Use `MAX_RETRY_COUNT` not `num`.
- **Classes**: Use nouns. Use `OrderProcessor` not `ProcessOrders` or `OrderHelper`.

### Functions
- Do one thing. If the function name includes "and", split it into two functions.
- Keep parameter count low (0-3 ideal; more than 3 suggests a parameter object is needed).
- Avoid boolean parameters that switch behavior — use two clearly named functions instead.
- Return early for guard clauses to reduce nesting depth.

### Files
- One primary concept per file (one class, one module, one component).
- Keep files under 300 lines. If longer, the concept is likely doing too much.
- Group related files by feature, not by type (see "Code Organization" below).

## SOLID Principles Applied

### Single Responsibility (S)
Each module/class has one reason to change.
```
// Bad: UserService handles auth, profile, and notifications
// Good: AuthService, ProfileService, NotificationService
```

### Open/Closed (O)
Extend behavior without modifying existing code. Use interfaces and composition.
```
// Bad: Adding a new payment type requires modifying PaymentProcessor
// Good: PaymentProcessor accepts a PaymentStrategy interface; add new strategies without touching the processor
```

### Liskov Substitution (L)
Subtypes must be substitutable for their base types without breaking behavior. If overriding a method changes the contract, the inheritance hierarchy is wrong.

### Interface Segregation (I)
No client should depend on methods it does not use. Prefer small, focused interfaces over large ones.
```
// Bad: interface Repository { find, save, delete, export, import, backup }
// Good: interface Readable { find }, interface Writable { save, delete }
```

### Dependency Inversion (D)
High-level modules depend on abstractions, not concrete implementations. Pass dependencies in; do not construct them internally.
```
// Bad: class OrderService { db = new PostgresDB() }
// Good: class OrderService { constructor(db: Database) }
```

## Error Handling Patterns

### Result Type (Preferred)
Return success/failure explicitly instead of throwing exceptions for expected failures.
```typescript
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

function parseEmail(input: string): Result<Email, ValidationError> {
  if (!isValidEmail(input)) {
    return { ok: false, error: new ValidationError('Invalid email format') };
  }
  return { ok: true, value: new Email(input) };
}
```

### Try-Catch Hierarchy
When using exceptions, follow this hierarchy:
1. **Catch specific exceptions first** — handle known, recoverable errors
2. **Let unknown exceptions propagate** — do not catch `Exception` or `Error` broadly
3. **Catch at boundaries** — API handlers, event processors, and CLI entry points are appropriate catch-all locations
4. **Never swallow exceptions silently** — `catch (e) {}` hides bugs

### Error Messages
- Include what happened, why it happened, and what the user/developer can do about it
- Include relevant context (IDs, input values, operation being performed)
- Do not expose internal implementation details in user-facing errors

## Logging Standards

### Log Levels
- **ERROR**: Something failed that requires attention. Include enough context to diagnose.
- **WARN**: Something unexpected happened but was handled. May indicate a developing issue.
- **INFO**: Significant business events (order placed, user registered, payment processed). One per operation.
- **DEBUG**: Detailed diagnostic information for development. Never log sensitive data at any level.

### Structured Logging
```json
{
  "level": "INFO",
  "message": "Order placed successfully",
  "orderId": "ord-123",
  "customerId": "cust-456",
  "totalAmount": 99.99,
  "timestamp": "2024-01-15T10:30:00Z",
  "correlationId": "req-789"
}
```

### Rules
- Log at operation boundaries (start, success, failure) — not inside loops
- Include correlation/request IDs for tracing across services
- Never log: passwords, tokens, API keys, PII, credit card numbers
- Use structured format (JSON) not free-text strings for production logs

## Input Validation at Boundaries

### Boundary Definition
Validate input at every trust boundary — where data enters your system from an untrusted source:
- API request handlers (HTTP, gRPC, GraphQL)
- Event/message consumers (SQS, Kafka, EventBridge)
- File upload processors
- CLI argument parsers
- Database query results from external systems

### Validation Strategy
```
External Input → Validate at boundary → Convert to domain type → Domain logic uses typed values
```

### What to Validate
- **Presence**: Required fields exist and are not null/empty
- **Type**: Values are the expected type (string, number, date)
- **Range**: Numbers within acceptable bounds, strings within length limits
- **Format**: Emails, URLs, dates, phone numbers match expected patterns
- **Business rules**: Values are valid in context (status transitions, referential integrity)

### After Validation
Once data passes the boundary and is converted to a domain type, internal code should NOT re-validate. Trust the boundary. This keeps domain logic clean and focused on business rules.

## Code Organization

### By Feature (Recommended)
```
/src
  /orders
    order.ts              # domain model
    order-service.ts      # business logic
    order-repository.ts   # data access
    order-handler.ts      # API handler
    order.test.ts         # tests
  /customers
    customer.ts
    customer-service.ts
    ...
```

### By Layer (Avoid for Medium-Large Projects)
```
/src
  /models        # all domain models from all features
  /services      # all services from all features
  /repositories  # all repositories from all features
  /handlers      # all handlers from all features
```

### Why Feature-Based is Better
- Related code is co-located — changes to "orders" touch files in one directory
- Easy to understand the scope of a feature by looking at one directory
- Supports extraction to microservices later (each feature directory is a candidate)
- Layer-based organization scatters related code across the entire project

## Code Generation Checklist
- [ ] Follows naming conventions (descriptive, consistent, no abbreviations)
- [ ] Functions are small and single-purpose
- [ ] Error handling is explicit (Result type or catch at boundaries)
- [ ] Input validation at all trust boundaries
- [ ] Structured logging at operation boundaries
- [ ] No hardcoded secrets, URLs, or configuration values
- [ ] Dependencies are injected, not constructed internally
- [ ] Tests accompany all generated code
- [ ] Code is organized by feature, not by layer
