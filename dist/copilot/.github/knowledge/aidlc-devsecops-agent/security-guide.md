# Security Guide

## OWASP Top 10 (Application Security Checklist)

For every application, verify defenses against each category:

1. **Broken Access Control**: Enforce authorization on every endpoint. Deny by default. Verify object-level access (IDOR prevention). Disable directory listing. Invalidate sessions on logout.

2. **Cryptographic Failures**: Use TLS 1.2+ for all data in transit. Encrypt sensitive data at rest (AES-256). Never store passwords in plaintext (use bcrypt/argon2 with salt). Do not roll custom crypto. Classify data sensitivity and protect accordingly.

3. **Injection**: Parameterize all database queries (no string concatenation). Use ORM methods for queries. Validate and sanitize all input. Apply Content Security Policy headers. Encode output contextually (HTML, URL, JavaScript, CSS).

4. **Insecure Design**: Threat model during design, not after. Limit resource consumption per user. Use secure design patterns (see below). Separate business logic from security controls.

5. **Security Misconfiguration**: Remove default accounts and passwords. Disable unnecessary features and services. Set security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options). Keep dependencies patched. Review cloud service configurations (S3 bucket policies, security groups).

6. **Vulnerable Components**: Maintain a software bill of materials (SBOM). Scan dependencies weekly. Pin dependency versions. Have a process for emergency patching of critical CVEs. Remove unused dependencies.

7. **Authentication Failures**: Implement rate limiting on login (5 attempts per minute). Enforce password complexity (12+ characters, no common passwords). Support MFA. Use secure session management (HttpOnly, Secure, SameSite cookies). Implement account lockout with notification.

8. **Data Integrity Failures**: Verify integrity of software updates and CI/CD pipelines. Use signed artifacts. Validate data from untrusted sources. Protect deserialization (avoid accepting serialized objects from users).

9. **Logging & Monitoring Failures**: Log authentication events (success and failure). Log access control failures. Log input validation failures. Do NOT log sensitive data (passwords, tokens, PII). Ship logs to centralized, tamper-resistant storage. Set up alerts for suspicious patterns.

10. **SSRF (Server-Side Request Forgery)**: Validate and whitelist URLs for server-side requests. Block requests to internal networks (169.254.x.x, 10.x.x.x, 172.16-31.x.x). Disable HTTP redirects for server-initiated requests. Do not expose raw error messages from server-side requests.

## STRIDE Threat Modeling

For each component and data flow, assess:

| Threat | Question | Example Mitigation |
|--------|----------|-------------------|
| **S**poofing | Can an attacker impersonate a user or service? | Authentication, mutual TLS, API keys |
| **T**ampering | Can data be modified in transit or at rest? | Input validation, checksums, signed tokens |
| **R**epudiation | Can a user deny performing an action? | Audit logging, non-repudiation controls |
| **I**nformation Disclosure | Can sensitive data leak? | Encryption, access controls, data masking |
| **D**enial of Service | Can the system be made unavailable? | Rate limiting, autoscaling, circuit breakers |
| **E**levation of Privilege | Can a user gain unauthorized permissions? | Least privilege, RBAC enforcement, input validation |

## Authentication & Authorization Patterns

### Authentication
- **Session-based**: Server-side sessions with HttpOnly/Secure/SameSite cookies. Best for server-rendered web apps.
- **JWT**: Stateless tokens with short expiry (15 min access, 7 day refresh). Best for SPAs and APIs. Store access token in memory, refresh token in HttpOnly cookie.
- **API Keys**: For service-to-service communication. Rotate regularly. Scope to minimum permissions.
- **OAuth2/OIDC**: For third-party authentication delegation. Use authorization code flow with PKCE. Never use implicit flow.

### Authorization
- **RBAC (Role-Based)**: Assign permissions to roles, roles to users. Good for well-defined hierarchies.
- **ABAC (Attribute-Based)**: Evaluate rules based on user, resource, action, and environment attributes. Good for complex, context-dependent policies.
- **Object-Level**: Always verify the requesting user has access to the specific resource being requested. Never trust client-provided ownership claims.

## Data Protection Requirements

Classify data into tiers and apply controls:

| Tier | Examples | At Rest | In Transit | Access | Retention |
|------|----------|---------|------------|--------|-----------|
| Public | Marketing content | None required | HTTPS preferred | Open | Indefinite |
| Internal | Business docs | Encrypted volume | HTTPS required | Authenticated | Per policy |
| Confidential | PII, financial | AES-256, key rotation | TLS 1.2+ required | Role-restricted | Minimized |
| Restricted | Passwords, keys | HSM/KMS, separate storage | mTLS | Named individuals | Shortest possible |

## Secure Coding Practices Checklist

For code review, verify:
- [ ] All user input validated (type, length, range, format)
- [ ] SQL queries parameterized (no string interpolation)
- [ ] Output encoded for context (HTML, URL, JS)
- [ ] Authentication checked on every protected endpoint
- [ ] Authorization checked for the specific resource being accessed
- [ ] Sensitive data not logged (passwords, tokens, PII)
- [ ] Error messages do not reveal internal details (stack traces, SQL errors)
- [ ] File uploads validated (type, size, scanned for malware)
- [ ] CORS configured to allow only expected origins
- [ ] Rate limiting applied to authentication and expensive operations
- [ ] Secrets loaded from environment/secrets manager, never hardcoded
