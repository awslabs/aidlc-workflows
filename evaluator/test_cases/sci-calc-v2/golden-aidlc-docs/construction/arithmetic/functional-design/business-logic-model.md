# Business Logic Model — Arithmetic

## Operations

| Operation | Input | Logic | Edge Cases |
|-----------|-------|-------|------------|
| add | a, b | a + b | Overflow |
| subtract | a, b | a - b | Overflow |
| multiply | a, b | a * b | Overflow |
| divide | a, b | a / b | b == 0 → DivisionByZeroError |
| modulo | a, b | a % b | b == 0 → DivisionByZeroError |
| abs | a | abs(a) | None |
| negate | a | -a | None |

## Flow
1. Route receives validated request (BinaryInput or UnaryInput)
2. Route calls engine function
3. Engine performs computation, raises DivisionByZeroError if applicable
4. Route builds SuccessResponse with operation name, inputs, and result
5. On exception, route catches and returns ErrorResponse
