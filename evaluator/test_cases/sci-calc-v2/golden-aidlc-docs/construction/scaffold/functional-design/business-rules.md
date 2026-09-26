# Business Rules — Scaffold

## BR-S1: Response Envelope Consistency
Every response MUST conform to either the success or error envelope schema. No bare responses.

## BR-S2: Error Code Mapping
| Exception Type | Error Code | HTTP Status |
|---------------|-----------|-------------|
| Pydantic ValidationError | INVALID_INPUT | 422 |
| DomainError | DOMAIN_ERROR | 400 |
| DivisionByZeroError | DIVISION_BY_ZERO | 400 |
| OverflowError | OVERFLOW | 400 |
| Route not found | NOT_FOUND | 404 |
| Unexpected | INTERNAL_ERROR | 500 |

## BR-S3: Input Echo
All error responses MUST include the `inputs` field echoing the parsed request body (empty dict if parsing failed entirely).

## BR-S4: Never Bare 500
All unexpected exceptions MUST be caught and translated to the INTERNAL_ERROR envelope. Stack traces MUST NOT be exposed to the client.
