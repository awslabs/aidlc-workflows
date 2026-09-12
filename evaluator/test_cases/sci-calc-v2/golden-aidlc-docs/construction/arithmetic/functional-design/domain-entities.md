# Domain Entities — Arithmetic

## Request Models
- BinaryInput(a: float, b: float) — for add, subtract, multiply, divide, modulo
- UnaryInput(a: float) — for abs, negate

## Engine Functions
- All return float
- Division/modulo raise DivisionByZeroError on b==0
