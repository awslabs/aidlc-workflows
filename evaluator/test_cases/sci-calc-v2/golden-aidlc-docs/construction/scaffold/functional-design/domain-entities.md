# Domain Entities — Scaffold

## Custom Exceptions

```
DomainError(message: str)
  - Raised when input is outside the mathematical domain
  - Maps to DOMAIN_ERROR / 400

DivisionByZeroError(message: str)
  - Raised when division or modulo by zero is attempted
  - Maps to DIVISION_BY_ZERO / 400
```

## Pydantic Models

```
SuccessResponse(status="ok", operation: str, inputs: dict, result: Any)
ErrorDetail(code: str, message: str)
ErrorResponse(status="error", operation: str, inputs: dict, error: ErrorDetail)
```

## Request Models (Base)

```
BinaryInput(a: float, b: float)
UnaryInput(a: float)
```
