# Business Logic Model — Powers

## Operations

| Operation | Input | Logic | Domain Constraint |
|-----------|-------|-------|-------------------|
| power | base, exponent | base ** exponent | Overflow if result is inf |
| sqrt | a | math.sqrt(a) | a < 0 → DomainError |
| cbrt | a | a ** (1/3) with sign preservation | None |
| square | a | a ** 2 | Overflow if result is inf |
| nth_root | a, n | a ** (1/n) | a < 0 and n even → DomainError |

## cbrt Implementation Note
Python's math.cbrt (3.11+) handles negative numbers correctly. Use math.cbrt if available, else use sign-preserving: `sign(a) * abs(a) ** (1/3)`.

## nth_root Implementation
- If n == 0: DomainError (zeroth root undefined)
- If a < 0 and n is even: DomainError
- If a < 0 and n is odd: -(-a) ** (1/n)
- Otherwise: a ** (1/n)
