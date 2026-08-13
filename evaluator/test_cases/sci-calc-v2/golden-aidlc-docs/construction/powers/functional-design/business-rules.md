# Business Rules — Powers

## BR-P1: Square Root Domain
sqrt(a) where a < 0 MUST raise DomainError.

## BR-P2: Nth Root Domain
nth_root(a, n) where a < 0 and n is even MUST raise DomainError.

## BR-P3: Overflow
power/square results that produce inf MUST raise OverflowError.
