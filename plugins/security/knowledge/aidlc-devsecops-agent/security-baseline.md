# Security Baseline (security plugin)

Fifteen rules, SECURITY-01 to SECURITY-15, that set the security floor for the
designs, infrastructure and code AI-DLC produces while the security plugin is
on. Check the outputs of each stage you lead or support against the rules that
apply to them.

## How the baseline applies

- **Cite the rule.** Next to each control you specify, name the rule it meets
  (for example `SECURITY-06`), so the person can trace it.
- **Report what breaks a rule.** When an output breaks a rule, list it under a
  `Security findings` heading in the stage's completion message: the rule id,
  what breaks it, and the fix you recommend.
- **The person decides at the gate.** They can ask for the change, or approve
  with the finding standing. Offer every choice the gate has. Never withhold
  approval to force a fix: the gate records what they decide.
- **N/A is not a finding.** When a rule does not apply (SECURITY-01 for a
  system with no data store), mark it N/A with the reason.
- **Code is also scanned.** At Code Generation the plugin runs an AWS Security
  Agent diff scan, and its gate check blocks open HIGH and CRITICAL findings
  until they are fixed or the person accepts one with a recorded reason. These
  rules are what such findings usually break, so cite the rule when you
  recommend a fix.
- **The team's rules come first.** When the team's own security baseline in
  the space knowledge folder states a rule differently, follow the team's rule
  and name the difference.

The verification items under each rule are compliance checks for review, one
judgment each. They are not the `- [ ]` progress boxes of a stage plan.

## SECURITY-01: Encryption at rest and in transit

**Rule.** Every data persistence store (databases, object storage, file
systems, caches, or any equivalent) MUST have:

- encryption at rest enabled, using a managed key service or customer-managed
  keys;
- encryption in transit enforced: TLS 1.2 or later for all data moving in and
  out of the store.

**Verification.**

- No storage resource is defined without an encryption configuration block.
- No database connection string uses an unencrypted protocol.
- Object storage enforces encryption at rest and rejects non-TLS requests by
  policy.
- Database instances have storage encryption enabled and enforce TLS
  connections.

## SECURITY-02: Access logging on network intermediaries

**Rule.** Every network-facing intermediary that handles external traffic MUST
have access logging enabled:

- load balancers: access logs to a persistent store;
- API gateways: execution logging and access logging to a centralized log
  service;
- CDN distributions: standard logging or real-time logs.

**Verification.**

- No load balancer is defined without access logging enabled.
- No API gateway stage is defined without access logging configured.
- No CDN distribution is defined without a logging configuration.

## SECURITY-03: Application-level logging

**Rule.** Every deployed application component MUST include structured
logging:

- a logging framework is configured;
- log output goes to a centralized log service;
- each entry carries a timestamp, a correlation or request ID, the log level,
  and the message;
- sensitive data (passwords, tokens, PII) never appears in log output.

**Verification.**

- Every service or function entry point has a configured logger.
- Production code does not use ad-hoc print statements as its logging.
- The log configuration routes output to a centralized log service.
- No secrets, tokens, or PII are logged.

## SECURITY-04: HTTP security headers for web applications

**Rule.** All HTML-serving endpoints MUST set these response headers:

| Header | Required value |
|---|---|
| `Content-Security-Policy` | A restrictive policy, at minimum `default-src 'self'` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY`, or `SAMEORIGIN` when framing is required |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

`X-XSS-Protection` is deprecated in modern browsers. Use
`Content-Security-Policy` instead.

**Verification.**

- Middleware or a response interceptor sets every required header.
- The CSP does not use `unsafe-inline` or `unsafe-eval` without a documented
  justification.
- The HSTS `max-age` is at least 31536000 (one year).

## SECURITY-05: Input validation on all API parameters

**Rule.** Every API endpoint (REST, GraphQL, gRPC, WebSocket) MUST validate all
input parameters before processing them:

- **Type checking:** reject unexpected types.
- **Length and size bounds:** enforce maximum lengths on strings and maximum
  sizes on arrays and payloads.
- **Format validation:** use allowlists (a regex or a schema) for structured
  inputs such as emails, dates, and IDs.
- **Sanitization:** escape or reject HTML and script content in user-supplied
  strings, to prevent XSS.
- **Injection prevention:** use parameterized queries for every database
  operation, never string concatenation.

**Verification.**

- Every API handler uses a validation library or schema.
- No raw user input is concatenated into SQL, NoSQL, or OS commands.
- String inputs have explicit maximum lengths.
- Request body size limits are configured at the framework or the gateway.

## SECURITY-06: Least-privilege access policies

**Rule.** Every identity and access management policy, role, or permission
boundary MUST follow least privilege:

- Use specific resource identifiers. Never use a wildcard resource unless the
  API supports no resource-level permissions, and document that exception.
- Use specific actions. Never use wildcard actions.
- Scope conditions where possible.
- Separate read and write permissions into distinct policy statements.

**Verification.**

- No policy has wildcard actions, or wildcard resources without a documented
  exception.
- No service role has broader permissions than the calls the service makes.
- Managed policies are used in place of inline policies where possible.
- Every role has a trust policy scoped to the specific service or account.

## SECURITY-07: Restrictive network configuration

**Rule.** All network configuration (security groups, network ACLs, route
tables) MUST deny by default:

- Firewall rules open only the ports the application needs.
- No inbound rule has the source `0.0.0.0/0`, except public-facing load
  balancers on ports 80 and 443.
- No outbound rule allows `0.0.0.0/0` on all ports unless explicitly
  justified.
- Private subnets have no direct internet gateway route.
- Private endpoints are used for cloud service access where available.

**Verification.**

- No firewall rule allows inbound `0.0.0.0/0` on a port other than 80 or 443
  of a public load balancer.
- Database and application firewall rules restrict sources to specific CIDR
  blocks or security group references.
- Private subnets route through a NAT gateway, not an internet gateway.
- High-traffic cloud service calls go through private endpoints.

## SECURITY-08: Application-level access control

**Rule.** Every application endpoint that reads or changes a resource MUST
enforce authorization at the application layer:

- **Deny by default:** every route requires authentication unless it is
  explicitly marked public.
- **Object-level authorization:** every request that names a resource by ID
  verifies that the caller owns it or may access it, to prevent IDOR.
- **Function-level authorization:** administrative and privileged operations
  check the caller's role server-side, never by hiding them in the client.
- **CORS policy:** cross-origin requests are restricted to explicitly allowed
  origins. Authenticated endpoints never send
  `Access-Control-Allow-Origin: *`.
- **Token validation:** JWTs and session tokens are validated server-side on
  every request (signature, expiry, audience, issuer).

**Verification.**

- Every controller or handler has an authorization middleware or guard.
- No endpoint returns data for a resource ID without checking the caller's
  ownership or permission.
- Admin and privileged routes have explicit server-side role checks.
- The CORS configuration has no wildcard origin on authenticated endpoints.
- Tokens are validated server-side on every request, not only at login.

## SECURITY-09: Security hardening and misconfiguration prevention

**Rule.** Every deployed component MUST follow a hardening baseline:

- **No default credentials:** default usernames and passwords are changed or
  disabled before deployment.
- **Minimal installation:** unused features, frameworks, sample applications,
  and documentation endpoints are removed or disabled.
- **Error handling:** production error responses never expose stack traces,
  internal paths, framework versions, or database details to end users.
- **Directory listing:** web servers disable it.
- **Cloud storage:** object storage blocks public access unless that access is
  required and documented.
- **Patch management:** runtimes, frameworks, and OS images are current,
  supported versions.

**Verification.**

- No default credentials exist in configuration files, environment variables,
  or IaC templates.
- Production error responses are generic, with no stack traces or internal
  details.
- Object storage blocks public access unless a documented exception exists.
- No sample or demo application or default page is deployed.
- Framework and runtime versions are current and supported.

## SECURITY-10: Software supply chain security

**Rule.** Every project MUST manage its software supply chain:

- **Dependency pinning:** every dependency uses an exact version or a lock
  file.
- **Vulnerability scanning:** a dependency vulnerability scanner is
  configured.
- **No unused dependencies:** packages that are not used are removed.
- **Trusted sources only:** dependencies come from official registries or
  verified private registries, never unvetted third-party sources.
- **SBOM:** production deployments get a Software Bill of Materials.
- **CI/CD integrity:** build pipelines use pinned tool versions and verified
  base images. Production Dockerfiles and CI configurations never use `latest`
  tags.

**Verification.**

- A lock file exists and is committed to version control.
- A dependency vulnerability scan runs in CI/CD or is documented in the build
  instructions.
- No unused or abandoned dependencies are included.
- Dockerfiles and CI configurations for production use no `latest` or
  unpinned image tags.
- Dependencies come from official or verified registries.

## SECURITY-11: Secure design principles

**Rule.** Application design MUST build in security from the start:

- **Separation of concerns:** security-critical logic (authentication,
  authorization, payment processing) lives in dedicated modules, not spread
  across the codebase.
- **Defense in depth:** no single control is the only line of defense. Layer
  controls such as validation, authorization, and encryption.
- **Rate limiting:** public-facing endpoints implement rate limiting or
  throttling to prevent abuse.
- **Business logic abuse:** the design considers misuse cases, not only the
  happy path.

**Verification.**

- Security-critical logic sits in dedicated modules or services.
- Public-facing APIs have rate limiting configured.
- The design documents at least one misuse or abuse scenario.

## SECURITY-12: Authentication and credential management

**Rule.** Every application with user authentication MUST implement:

- **Password policy:** a minimum of 8 characters, checked against breached
  password lists. This is a floor: when core's security guide or the team's
  rules set a longer minimum, the longer one applies.
- **Credential storage:** passwords are hashed with an adaptive algorithm,
  never a weak or non-adaptive hash.
- **Multi-factor authentication:** MFA is supported for administrative
  accounts and should be available to every user.
- **Session management:** sessions expire server-side, are invalidated on
  logout, and use `Secure`, `HttpOnly`, and `SameSite` cookie attributes.
- **Brute-force protection:** login endpoints use account lockout,
  progressive delays, or CAPTCHA after repeated failures.
- **No hardcoded credentials:** no passwords, API keys, or secrets in source
  code or IaC templates. Use a secrets manager.

**Verification.**

- Password hashing uses an adaptive algorithm.
- Session cookies set `Secure`, `HttpOnly`, and `SameSite`.
- Login endpoints have brute-force protection.
- No hardcoded credentials appear in source code or configuration files.
- Admin accounts support MFA.
- Sessions are invalidated on logout and have a defined expiry.

## SECURITY-13: Software and data integrity verification

**Rule.** Systems MUST verify the integrity of software and data:

- **Deserialization safety:** untrusted data is never deserialized without
  validation. Use safe deserialization libraries or an allowlist of types.
- **Artifact integrity:** downloaded dependencies, plugins, and updates are
  verified by checksum or digital signature.
- **CI/CD pipeline security:** only authorized people can change pipeline
  definitions, and code authors and deployment approvers are separate duties.
- **CDN and external resources:** scripts and resources loaded from external
  CDNs carry Subresource Integrity (SRI) hashes.
- **Data integrity:** changes to critical data are auditable: who changed
  what, and when.

**Verification.**

- No untrusted input is deserialized unsafely.
- External scripts loaded from CDNs have SRI `integrity` attributes.
- CI/CD pipeline definitions are access-controlled and their changes are
  auditable.
- Critical data changes are logged with the actor, the time, and the values
  before and after.

## SECURITY-14: Alerting and monitoring

**Rule.** Beyond logging (SECURITY-02, SECURITY-03), systems MUST include:

- **Security event alerting:** alerts for high-value security events, such as
  repeated authentication failures, privilege escalation attempts, access from
  unusual locations, and authorization failures.
- **Log integrity:** logs are stored in append-only or tamper-evident storage.
  Application code cannot delete or change its own audit logs.
- **Log retention:** logs are kept for the period the application's
  compliance requirements set, 90 days at minimum by default.
- **Monitoring dashboards:** a dashboard or alarm configuration covers the key
  operational and security metrics.

**Verification.**

- Alerts are configured for authentication failures and authorization
  violations.
- Application log groups have retention policies of at least 90 days.
- Application roles have no permission to delete their own log groups or
  streams.
- Security-relevant events (login failures, access denied, privilege changes)
  raise alerts.

## SECURITY-15: Exception handling and fail-safe defaults

**Rule.** Every application MUST handle exceptional conditions safely:

- **Catch and handle:** every external call (database, API, file I/O) has
  explicit error handling. Production code has no unhandled promise rejections
  or uncaught exceptions.
- **Fail closed:** on an error the system denies access or halts the
  operation. It never fails open.
- **Resource cleanup:** error paths release resources (connections, file
  handles, locks), with try/finally, `using` statements, or an equivalent.
- **User-facing errors:** error messages shown to users are generic, with no
  internal details or system information.
- **Global error handler:** the application has a top-level handler that
  catches unhandled exceptions, logs them (SECURITY-03), and returns a safe
  response.

**Verification.**

- Every external call (database, HTTP, file I/O) has explicit error handling.
- A global error handler is configured at the application entry point.
- Error paths do not skip authorization or validation checks.
- Resources are cleaned up in error paths: connections closed, transactions
  rolled back.
- Application code raises no unhandled promise rejection or uncaught
  exception warnings.
