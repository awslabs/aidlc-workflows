# Business Logic Model — Logarithmic

## Operations

| Operation | Input | Logic | Domain |
|-----------|-------|-------|--------|
| ln | a | math.log(a) | a <= 0 → DomainError |
| log10 | a | math.log10(a) | a <= 0 → DomainError |
| log2 | a | math.log2(a) | a <= 0 → DomainError |
| log | a, base | math.log(a, base) | a <= 0 or base <= 0 or base == 1 → DomainError |
| exp | a | math.exp(a) | Overflow if result is inf |
