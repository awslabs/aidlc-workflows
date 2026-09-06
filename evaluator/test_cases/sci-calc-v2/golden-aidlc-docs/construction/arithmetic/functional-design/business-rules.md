# Business Rules — Arithmetic

## BR-A1: Division by Zero
divide(a, 0) and modulo(a, 0) MUST raise DivisionByZeroError (never return inf or nan).

## BR-A2: Overflow Detection
If the result of any operation is inf or -inf (from float overflow), MUST raise OverflowError.

## BR-A3: Input Types
Inputs a and b are JSON numbers (float). Integer inputs are accepted and treated as float.
