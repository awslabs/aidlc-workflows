# Personas

## API Consumer

- **Role:** Developer integrating scientific calculations into their application via HTTP
- **Goals:** Perform scientific math operations via HTTP without installing math libraries locally; get precise, predictable, correctly-typed results; handle errors programmatically with clear error messages when inputs are invalid
- **Context:** Building web/mobile/backend applications that need math operations (data analysis tools, educational apps, engineering calculators, dashboards, data pipelines). Consumes JSON APIs from any language or platform. Expects consistent response shapes, clear error codes, and a stable JSON envelope.
- **Pain points:** Installing and maintaining math dependencies across polyglot stacks; inconsistent error handling and unclear error messages across math libraries; precision mismatches between languages; undocumented edge cases (NaN, overflow, domain violations)
- **Stories:** S-1, S-2, S-3, S-4, S-5, S-6, S-7, S-8, S-9, S-10, S-11, S-12, S-13, S-14

## Operations Engineer

- **Role:** Engineer responsible for deploying, monitoring, and maintaining the running service
- **Goals:** Verify service health and confirm uptime; observe predictable error behavior; understand failures from structured logs; no unexpected 500s
- **Context:** Uses health-check endpoints for load balancer probes, monitoring dashboards, and deployment scripts; reads structured logs for incident response
- **Pain points:** Services that return opaque 500 errors with no structured info; no health endpoint for liveness checks; lack of version introspection
- **Stories:** S-15, S-16, S-17
