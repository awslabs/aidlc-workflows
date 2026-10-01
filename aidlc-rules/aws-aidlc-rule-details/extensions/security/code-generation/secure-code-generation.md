# Secure Code Generation Rules

## Overview

These rules are MANDATORY cross-cutting constraints that apply during the Code Generation stage of the CONSTRUCTION phase. They ensure that all generated code follows secure coding practices regardless of language, framework, or platform.

**Enforcement**: During Code Generation (Part 2 - Generation), the model MUST verify compliance with these rules for every generated file before marking a plan step as complete.

### Blocking Security Finding Behavior

A **blocking security finding** means:

1. The finding MUST be listed in the stage completion message under a "Secure Code Findings" section with the SECURE-CODE rule ID and description
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the SECURE-CODE rule ID, description, and stage context

If a SECURE-CODE rule is not applicable to the current code being generated (e.g., SECURE-CODE-04 when no authentication exists), mark it as **N/A** in the compliance summary — this is not a blocking finding.

### Default Enforcement

All rules in this document are **blocking** by default. If any rule's verification criteria are not met in generated code, it is a blocking security finding.

### Relationship to Security Baseline

This extension complements the Security Baseline extension. The Security Baseline covers infrastructure and architecture-level security. This extension covers **code-level** secure patterns applied during generation. Both can be enabled independently.

---

## Rule SECURE-CODE-01: Input Validation

**Rule**: Every function, endpoint, or handler that accepts external input MUST validate that input before processing. Generated code MUST implement:

- **Server-side validation**: All validation MUST occur server-side — never rely on client-side validation alone
- **Allow-list approach**: Validate expected data types, ranges, and lengths rather than denying known-bad patterns
- **Centralized validation**: Use a shared validation module or framework-provided validation — never scatter ad-hoc validation
- **All sources validated**: Validate data from ALL untrusted sources including user input, databases, file streams, APIs, and redirects
- **Character set specification**: Specify character sets (UTF-8) for all input sources and perform canonicalization before validation
- **Rejection behavior**: All validation failures MUST result in input rejection with a safe, generic error message
- **Injection prevention**: Sanitize inputs to prevent SQL Injection, XSS, Command Injection, LDAP Injection, and XML Injection
- **Parameterized queries**: Use parameterized queries or prepared statements — NEVER concatenate user input into SQL, NoSQL, or OS command strings
- **File upload validation**: Validate file type, size, extension, and content (magic bytes) for any file upload handling

**Secure Pattern Examples**:

```python
# ✅ GOOD — Parameterized query
cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))

# ❌ BAD — SQL Injection vulnerable
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
```

```python
# ✅ GOOD — Input validation with allow-list
import re
def validate_email(email: str) -> bool:
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email)) and len(email) <= 254
```

**Verification**:

- No generated code concatenates user input into SQL, NoSQL, or command strings
- Every API handler or endpoint uses a validation library, schema, or explicit validation logic
- String inputs have explicit max-length constraints
- File upload handlers validate type, size, and content
- Validation logic is centralized (shared module or framework middleware)

---

## Rule SECURE-CODE-02: Output Encoding

**Rule**: All generated code that renders untrusted data to output MUST apply context-appropriate encoding:

- **Server-side encoding**: Perform all output encoding on the server side
- **Context-aware encoding**: Apply encoding appropriate to the output context (HTML, JavaScript, URL, CSS, XML)
- **Standard libraries**: Use standard, tested encoding libraries — never implement custom encoding routines
- **Query output**: Sanitize all output of untrusted data to queries for SQL, XML, and LDAP
- **OS command output**: Sanitize all output of untrusted data to operating system commands
- **Character encoding**: Set character encoding (UTF-8) for all output responses
- **XSS prevention**: Never insert untrusted data directly into DOM, HTML attributes, JavaScript, or CSS without encoding

**Secure Pattern Examples**:

```javascript
// ✅ GOOD — Output encoding for XSS prevention
const sanitized = DOMPurify.sanitize(userInput);
element.innerHTML = sanitized;

// ❌ BAD — Direct DOM injection
element.innerHTML = userInput;
```

```python
# ✅ GOOD — Template engine with auto-escaping (Jinja2)
# Auto-escaping enabled by default in template config

# ❌ BAD — Manual string interpolation in HTML response
return f"<div>{user_input}</div>"
```

**Verification**:

- No generated code inserts untrusted data directly into HTML, JavaScript, or CSS without encoding
- Template engines are configured with auto-escaping enabled
- API responses set `Content-Type` with explicit charset (UTF-8)
- No raw string interpolation is used to build HTML, XML, or command strings from user data

---

## Rule SECURE-CODE-03: Secrets and Credential Management

**Rule**: Generated code MUST NEVER contain hardcoded secrets and MUST use secure credential retrieval patterns:

- **No hardcoded secrets**: Never include passwords, API keys, tokens, encryption keys, or connection strings with credentials in source code
- **Environment variables or secrets manager**: Retrieve secrets from environment variables, a secrets manager service (AWS Secrets Manager, Parameter Store), or a vault
- **No secrets in logs**: Never log secrets, tokens, passwords, or API keys
- **No secrets in URLs**: Never pass secrets as URL query parameters
- **Git safety**: Generated `.gitignore` files MUST exclude `.env`, credential files, and key files
- **Secure defaults**: Generated configuration files MUST use placeholder values (e.g., `<YOUR_API_KEY>`) with comments directing users to set them securely
- **Memory cleanup**: Clear sensitive data from memory (buffers, variables) as soon as it is no longer needed

**Secure Pattern Examples**:

```python
# ✅ GOOD — Environment variables for secrets
import os
db_password = os.environ.get("DB_PASSWORD")

# ❌ BAD — Hardcoded secrets
db_password = "MyS3cr3tP@ss!"
```

```python
# ✅ GOOD — AWS Secrets Manager
import boto3
client = boto3.client("secretsmanager")
secret = client.get_secret_value(SecretId="my-app/db-credentials")
```

**Verification**:

- No string literals in generated code match patterns for secrets (API keys, passwords, tokens, connection strings with credentials)
- All credential access uses environment variables or a secrets manager SDK
- Generated `.gitignore` includes `.env`, `*.pem`, `*.key`, and credential file patterns
- No secrets appear in log statements or URL constructions
- Configuration templates use placeholder values with setup instructions

---

## Rule SECURE-CODE-04: Authentication and Session Management

**Rule**: Generated authentication and session code MUST follow secure patterns:

- **Server-side enforcement**: All authentication controls MUST be enforced server-side
- **Centralized auth**: Use a centralized authentication mechanism — never scatter auth logic across components
- **Secure password storage**: Use adaptive hashing algorithms (bcrypt, Argon2, scrypt) with appropriate work factors — never use MD5, SHA-1, or unsalted hashes
- **Credential transmission**: Use ONLY HTTP POST for transmitting credentials, over encrypted connections (HTTPS/TLS)
- **Session management**: Use the framework's built-in session management — never implement custom session handling
- **Session cookies**: Set cookies with `Secure`, `HttpOnly`, and `SameSite=Strict` attributes
- **Session regeneration**: Regenerate session ID on login, privilege escalation, and authentication state changes
- **Session termination**: Terminate sessions completely on logout (server-side invalidation)
- **Brute-force protection**: Implement account lockout, progressive delays, or CAPTCHA after repeated authentication failures
- **Generic error messages**: Authentication failure responses MUST NOT reveal which credential was incorrect
- **MFA support**: Support Multi-Factor Authentication for administrative and sensitive operations
- **Re-authentication**: Require re-authentication before critical operations (password change, payment, privilege escalation)

**Secure Pattern Examples**:

```python
# ✅ GOOD — Secure password hashing
import bcrypt
hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12))

# ❌ BAD — Weak hashing
import hashlib
hashed = hashlib.md5(password.encode()).hexdigest()
```

```python
# ✅ GOOD — Generic auth error message
raise AuthenticationError("Invalid credentials")

# ❌ BAD — Reveals which credential failed
raise AuthenticationError("User 'admin' not found")
```

**Verification**:

- Password hashing uses bcrypt, Argon2, or scrypt (never MD5, SHA-1, or plain SHA-256)
- Session cookies set `Secure`, `HttpOnly`, and `SameSite` attributes
- Login endpoints have brute-force protection
- Authentication error messages are generic (do not reveal user existence)
- Session IDs are regenerated on authentication state changes
- No custom session management implementations (uses framework-provided)

---

## Rule SECURE-CODE-05: Access Control

**Rule**: Generated code MUST implement proper authorization on every request:

- **Server-side enforcement**: Access control checks on EVERY request, enforced server-side
- **Centralized authorization**: Use a centralized authorization component — never scatter access checks
- **Deny by default**: Deny all access by default, grant only what is explicitly needed
- **Every resource checked**: Validate authorization for every function, URL, data object, and service call
- **Fail securely**: Access controls MUST fail closed (deny access on any error or exception)
- **No direct object references**: Use indirect references or verify ownership — prevent IDOR vulnerabilities
- **RBAC/ABAC**: Implement Role-Based or Attribute-Based Access Control with clearly defined roles
- **Audit logging**: Log all access control failures for monitoring

**Secure Pattern Examples**:

```python
# ✅ GOOD — Ownership verification (prevents IDOR)
def get_document(user_id, document_id):
    doc = db.get(document_id)
    if doc.owner_id != user_id:
        raise ForbiddenError("Access denied")
    return doc

# ❌ BAD — No ownership check
def get_document(document_id):
    return db.get(document_id)
```

```python
# ✅ GOOD — Decorator-based centralized auth
@require_role("admin")
def delete_user(user_id):
    ...

# ❌ BAD — Scattered inline checks
def delete_user(user_id):
    if not check_admin():  # easy to forget
        ...
```

**Verification**:

- Every endpoint or handler has an authorization check (middleware, decorator, or guard)
- No endpoint returns data without verifying the caller's ownership or permission
- Admin/privileged routes have explicit role checks enforced server-side
- Access control failures are logged
- No direct database IDs exposed without ownership verification

---

## Rule SECURE-CODE-06: Cryptographic Practices

**Rule**: Generated code that handles encryption, hashing, or random number generation MUST use secure patterns:

- **Approved algorithms only**: Use well-established, peer-reviewed algorithms (AES-256, RSA-2048+, SHA-256+, Ed25519)
- **No custom crypto**: NEVER implement custom cryptographic algorithms or protocols
- **Secure random**: Use cryptographically secure random number generators for tokens, keys, and session IDs
- **Authenticated encryption**: Use authenticated encryption modes (AES-GCM) over unauthenticated modes (AES-CBC without HMAC)
- **TLS 1.2+**: All network communication MUST use TLS 1.2 or higher — disable older protocols
- **Key management**: Never hardcode encryption keys — use key management services or secure key derivation
- **Key rotation**: Design for key rotation — never assume keys are permanent

**Secure Pattern Examples**:

```python
# ✅ GOOD — Cryptographically secure random
import secrets
token = secrets.token_urlsafe(32)

# ❌ BAD — Predictable random
import random
token = str(random.randint(100000, 999999))
```

```python
# ✅ GOOD — Authenticated encryption (AES-GCM)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
key = AESGCM.generate_key(bit_length=256)
aesgcm = AESGCM(key)
ct = aesgcm.encrypt(nonce, plaintext, associated_data)

# ❌ BAD — Unauthenticated encryption without integrity check
from Crypto.Cipher import AES
cipher = AES.new(key, AES.MODE_ECB)  # ECB mode is insecure
```

**Verification**:

- No use of MD5, SHA-1, DES, 3DES, RC4, or ECB mode in generated code
- Random values for security purposes use `secrets`, `crypto.randomBytes`, or equivalent CSPRNG
- No hardcoded encryption keys or initialization vectors
- TLS configuration disables protocols below 1.2
- Encryption uses authenticated modes (GCM, CCM) or pairs encryption with HMAC

---

## Rule SECURE-CODE-07: Error Handling and Information Leakage

**Rule**: Generated code MUST handle errors securely without leaking internal details:

- **Generic client errors**: Return generic error messages to clients — never expose stack traces, database errors, file paths, or framework versions
- **Detailed server logs**: Log detailed error information server-side only with correlation IDs
- **Handle all exceptions**: Every external call (database, API, file I/O) MUST have explicit error handling — no unhandled exceptions in production
- **Fail closed**: On error, deny access or halt the operation — never fail open or bypass security checks
- **Resource cleanup**: Error paths MUST release resources (connections, file handles, locks) using try/finally or equivalent
- **Global error handler**: Applications MUST have a global/top-level error handler that catches unhandled exceptions, logs them, and returns a safe response
- **No sensitive data in errors**: Error messages, logs, and responses MUST NOT contain passwords, tokens, PII, or internal system details

**Secure Pattern Examples**:

```python
# ✅ GOOD — Generic error to client, detailed log server-side
try:
    result = db.execute(query)
except DatabaseError as e:
    logger.error(f"DB error: {e}", extra={"correlation_id": req_id})
    raise HTTPException(status_code=500, detail="An internal error occurred")

# ❌ BAD — Leaks internal details to client
except DatabaseError as e:
    return {"error": str(e)}  # Exposes DB schema, query, connection info
```

```javascript
// ✅ GOOD — Global error handler
app.use((err, req, res, next) => {
  logger.error({ err, correlationId: req.id });
  res.status(500).json({ error: "Internal server error" });
});

// ❌ BAD — No global handler, stack traces leak to client
```

**Verification**:

- No generated code returns raw exception messages, stack traces, or database errors to clients
- All external calls (DB, HTTP, file I/O) have explicit error handling
- A global error handler is configured at the application entry point
- Error paths do not bypass authorization or validation checks
- Resources are cleaned up in error paths (connections closed, transactions rolled back)

---

## Rule SECURE-CODE-08: Data Protection

**Rule**: Generated code that handles sensitive data MUST implement proper protection:

- **Data classification**: Treat PII, financial data, health data, and credentials as sensitive by default
- **Minimize collection**: Only collect and store data that is strictly necessary
- **Encrypt sensitive data**: Encrypt sensitive fields at rest using AES-256 or equivalent
- **Mask in logs**: Never log sensitive data — use masking or redaction for PII in logs and non-production environments
- **Memory cleanup**: Remove sensitive data from memory as soon as it is no longer needed
- **Disable caching**: Set `Cache-Control: no-store` for responses containing sensitive data
- **Tokenization**: Use tokenization for highly sensitive fields (credit cards, SSN) where possible
- **Data retention**: Implement data retention policies — do not store data indefinitely without justification

**Verification**:

- No PII, credit card numbers, or health data appears in log statements
- Sensitive fields in database schemas have encryption annotations or are stored encrypted
- Responses containing sensitive data include appropriate cache-control headers
- Generated code does not store more data than required by the feature specification

---

## Rule SECURE-CODE-09: API Security

**Rule**: Generated API code MUST implement security controls:

- **Authentication on all endpoints**: Every API endpoint MUST require authentication unless explicitly documented as public
- **Rate limiting**: Implement rate limiting and throttling on all public-facing API endpoints
- **Input validation**: Validate all request parameters, headers, and body content (see SECURE-CODE-01)
- **HTTPS only**: All API communication MUST use HTTPS — reject HTTP requests or redirect to HTTPS
- **Restrictive CORS**: Configure CORS with explicit allowed origins — never use wildcard (`*`) on authenticated endpoints
- **Request size limits**: Implement request body size limits to prevent denial-of-service
- **Appropriate status codes**: Return correct HTTP status codes — never leak information in error responses
- **API versioning**: Version APIs and plan for deprecation of insecure older versions
- **API gateway**: Use API gateways for centralized security enforcement where applicable

**Secure Pattern Examples**:

```python
# ✅ GOOD — Restrictive CORS
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://myapp.example.com"],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization"],
)

# ❌ BAD — Wildcard CORS on authenticated API
app.add_middleware(CORSMiddleware, allow_origins=["*"])
```

```python
# ✅ GOOD — Rate limiting
from slowapi import Limiter
limiter = Limiter(key_func=get_remote_address)

@app.get("/api/search")
@limiter.limit("10/minute")
def search(request: Request):
    ...
```

**Verification**:

- Every API endpoint has authentication middleware applied (except documented public endpoints)
- Rate limiting is configured on public-facing endpoints
- CORS does not use wildcard origins on authenticated endpoints
- Request body size limits are configured at the framework or gateway level
- API responses use appropriate HTTP status codes without leaking internal details

---

## Rule SECURE-CODE-10: Dependency and Supply Chain Security

**Rule**: Generated code and configuration MUST follow supply chain security practices:

- **Pinned versions**: All dependencies MUST use exact versions or lock files — never use `latest`, `*`, or open ranges in production
- **Trusted sources**: Dependencies MUST come from official registries or verified private registries
- **Minimal dependencies**: Only include dependencies that are actively used — no unused packages
- **Lock files committed**: Lock files (`package-lock.json`, `poetry.lock`, `go.sum`, etc.) MUST be generated and committed
- **Vulnerability scanning**: Include dependency vulnerability scanning configuration in CI/CD setup
- **Docker image pinning**: Dockerfiles MUST use specific image digests or version tags — never `latest` for production
- **Integrity verification**: Use checksums or signatures to verify downloaded artifacts where supported

**Secure Pattern Examples**:

```json
// ✅ GOOD — Pinned versions (package.json)
{
  "dependencies": {
    "express": "4.18.2",
    "helmet": "7.1.0"
  }
}

// ❌ BAD — Unpinned versions
{
  "dependencies": {
    "express": "*",
    "helmet": "latest"
  }
}
```

```dockerfile
# ✅ GOOD — Pinned base image
FROM node:20.11.0-alpine3.19

# ❌ BAD — Unpinned base image
FROM node:latest
```

**Verification**:

- Generated `package.json`, `requirements.txt`, `go.mod`, or equivalent uses exact versions
- A lock file is generated alongside dependency declarations
- Dockerfiles use specific version tags (not `latest`)
- No unused dependencies are included in generated dependency files
- CI/CD configuration includes a dependency scanning step

---

## Rule SECURE-CODE-11: Secure Configuration

**Rule**: Generated configuration and deployment artifacts MUST follow hardening practices:

- **No debug in production**: Debug mode, verbose logging, and development endpoints MUST be disabled in production configurations
- **No default credentials**: Generated configurations MUST NOT include default usernames or passwords
- **Security headers**: Web applications MUST configure security headers: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`
- **Directory listing disabled**: Web server configurations MUST disable directory listing
- **Minimal exposure**: Disable unnecessary features, services, and sample applications
- **Environment separation**: Separate development, staging, and production configurations clearly
- **Git safety**: Include `.gitignore` with patterns for `.env`, credentials, keys, and IDE files
- **Pre-commit hooks**: Recommend or configure pre-commit hooks for secret detection where applicable

**Secure Pattern Examples**:

```python
# ✅ GOOD — Security headers middleware
from secure import Secure
secure_headers = Secure(
    hsts=Secure.HSTS(max_age=31536000, include_subdomains=True),
    csp=Secure.CSP(default_src="'self'"),
    xfo=Secure.XFO("DENY"),
    referrer=Secure.Referrer("strict-origin-when-cross-origin"),
)
```

```yaml
# ✅ GOOD — Environment-specific config
# config/production.yaml
debug: false
log_level: "warn"
```

**Verification**:

- Generated production configurations have `debug: false` or equivalent
- No default credentials in any generated configuration file
- Web applications include security header middleware or configuration
- A `.gitignore` file is generated with appropriate exclusion patterns
- Development and production configurations are clearly separated

---

## Rule SECURE-CODE-12: Secure Code Patterns and Anti-Patterns

**Rule**: Generated code MUST avoid known insecure patterns and use secure alternatives:

- **No eval()**: Never use `eval()`, `exec()`, or equivalent dynamic code execution with untrusted input
- **No unsafe deserialization**: Never deserialize untrusted data without validation — use safe deserialization libraries or allowlists
- **No path traversal**: Validate and sanitize file paths — reject `../` sequences and resolve to canonical paths before access
- **No SSRF**: Validate and restrict URLs before making server-side HTTP requests — use allowlists for permitted domains
- **No race conditions**: Use atomic operations, locks, or transactions for shared state — avoid TOCTOU (time-of-check-time-of-use) bugs
- **No prototype pollution**: In JavaScript, avoid merging untrusted objects into prototypes — use `Object.create(null)` or validated merge utilities
- **Safe regex**: Avoid catastrophic backtracking — use bounded quantifiers and test regex with adversarial input
- **Subresource integrity**: External scripts or resources loaded from CDNs MUST use SRI hashes

**Secure Pattern Examples**:

```python
# ✅ GOOD — Safe file path handling
import os
base_dir = "/app/uploads"
requested = os.path.normpath(os.path.join(base_dir, user_filename))
if not requested.startswith(base_dir):
    raise ValueError("Path traversal detected")

# ❌ BAD — Path traversal vulnerable
file_path = f"/app/uploads/{user_filename}"
open(file_path)
```

```javascript
// ✅ GOOD — Safe JSON parsing (no eval)
const data = JSON.parse(userInput);

// ❌ BAD — Code execution via eval
const data = eval('(' + userInput + ')');
```

**Verification**:

- No `eval()`, `exec()`, `Function()`, or equivalent with untrusted input in generated code
- File path operations validate against traversal attacks
- Server-side HTTP requests validate target URLs against an allowlist
- No unsafe deserialization of untrusted data (e.g., Python `pickle.loads` on user input)
- JavaScript code does not merge untrusted objects into prototypes without validation

---

## Rule SECURE-CODE-13: Security Testing in Generated Tests

**Rule**: Generated test suites MUST include security-focused test cases:

- **Auth tests**: Unit tests for all authentication and authorization logic
- **Negative tests**: Test cases for invalid inputs, boundary values, and malicious payloads
- **Injection tests**: Test that SQL injection, XSS, and command injection payloads are rejected
- **Access control tests**: Verify unauthorized users cannot access protected resources
- **Error handling tests**: Verify error paths do not leak information
- **Boundary tests**: Test maximum lengths, empty inputs, null values, and special characters

**Secure Pattern Examples**:

```python
# ✅ GOOD — Security-focused test cases
def test_sql_injection_prevented():
    response = client.get("/users?id=1' OR '1'='1")
    assert response.status_code == 400  # Rejected, not executed

def test_unauthorized_access_denied():
    response = client.get("/admin/users", headers={"Authorization": "Bearer user_token"})
    assert response.status_code == 403

def test_error_does_not_leak_details():
    response = client.get("/users/nonexistent")
    assert "stack" not in response.json().get("error", "").lower()
    assert "traceback" not in response.json().get("error", "").lower()
```

**Verification**:

- Generated test suites include at least one negative/security test per endpoint
- Authentication and authorization logic has dedicated test coverage
- Tests verify that invalid inputs are rejected (not just that valid inputs succeed)
- Tests verify error responses do not contain internal details

---

## Enforcement Integration

These rules apply specifically during the Code Generation stage (Part 2 - Generation). At each plan step execution:

1. Generate code following the plan step
2. Evaluate all applicable SECURE-CODE rules against the generated code
3. If any rule is violated, fix the code before marking the step complete
4. Include a "Secure Code Compliance" section in the Code Generation completion summary listing each rule as compliant, non-compliant, or N/A

### Code Review Checklist (Applied at Step 14 - Completion)

Before presenting the Code Generation completion message, verify:

- No hardcoded secrets, API keys, or passwords
- All user inputs are validated and sanitized
- SQL queries use parameterized statements
- Authentication is enforced on all non-public endpoints
- Authorization checks prevent unauthorized access
- Sensitive data is encrypted at rest and in transit
- Error messages do not leak internal details
- Logging does not contain sensitive data
- Dependencies are pinned and free of known CVEs
- Security headers are configured properly
- CORS is configured restrictively (no wildcards for sensitive APIs)
- Rate limiting is implemented on public-facing endpoints

---

## References

- [OWASP Secure Coding Practices](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP Application Security Verification Standard (ASVS)](https://owasp.org/www-project-application-security-verification-standard/)
- [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
- [CWE/SANS Top 25](https://cwe.mitre.org/top25/archive/2023/2023_top25_list.html)
