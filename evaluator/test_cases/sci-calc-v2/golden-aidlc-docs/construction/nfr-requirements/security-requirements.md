# Security Requirements

## MVP Security Posture: MINIMAL

Per vision.md, authentication, rate-limiting, and production hardening are explicitly out of scope.

## Applied Security Measures

| Measure | Implementation |
|---------|---------------|
| Input validation | Pydantic v2 strict type checking on all request bodies |
| Request size limit | 1 MB max body (prevents memory exhaustion) |
| No secrets in code | No credentials, API keys, or secrets needed |
| No SQL injection | No database |
| No XSS | No HTML rendering (JSON-only API) |
| No SSRF | No outbound HTTP calls |
| Error information disclosure | Never expose stack traces; generic error messages only |

## Deferred to Post-MVP

- Authentication / Authorization
- Rate limiting / throttling
- CORS configuration
- HTTPS / TLS termination
- Input sanitization beyond type validation
- Security headers (CSP, HSTS, etc.)
