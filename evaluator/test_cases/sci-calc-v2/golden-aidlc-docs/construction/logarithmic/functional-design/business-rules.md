# Business Rules — Logarithmic

## BR-L1: Non-Positive Input
ln/log10/log2/log with a <= 0 MUST raise DomainError.

## BR-L2: Invalid Base
log with base <= 0 or base == 1 MUST raise DomainError.

## BR-L3: Exp Overflow
exp(a) where result is inf MUST raise OverflowError.
