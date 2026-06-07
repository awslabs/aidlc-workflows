---
name: aidlc-security-engineering-skill
description: |
  The ability to identify threats, classify data sensitivity, recognize trust boundaries, and ensure security considerations are embedded in whatever artifact is being produced or reviewed. Applied by the Security Engineer persona as a contributor at every stage.
---

# Security Thinking

## Purpose

The ability to identify threats, classify data sensitivity, recognize trust boundaries, and ensure security considerations are embedded in whatever artifact is being produced or reviewed.

## Principles

- Identify assets — what data or capabilities are worth protecting? Classify by sensitivity (public, internal, confidential, restricted)
- Identify threats — what could go wrong? Which OWASP Top 10 categories apply?
- Define controls — for each threat, what mitigates it?
- Mark trust boundaries — where does data cross trust levels? What validation happens at each crossing?
- Consider failure modes — does the system fail open (dangerous) or fail closed (safe)?
- Preserve auditability — can security-relevant actions be traced?

## Definitions

- **Trust boundary** — a point where data crosses between zones of different trust levels
- **Data classification** — public (no harm if disclosed), internal (low impact), confidential (material harm), restricted (highest sensitivity — PII, credentials, financial, health)
- **Attack surface** — the sum of all points where an attacker can try to enter or extract data
- **Defence in depth** — multiple layers of controls; no single point of failure

## Application

When applied at requirements-analysis: ensure security-relevant capabilities are captured as requirements, sensitive data types are identified with at least high-level classification, and compliance obligations are stated.

When applied at domain-design: identify trust boundaries between components, flag unprotected data flows, ensure auth enforcement points are defined.

When applied at code-generation: verify parameterized queries, output encoding, CSRF protection, secure headers, secrets management patterns are followed.

When applied at any stage: flag artifacts that introduce unclassified data flows, store credentials in plaintext, or lack audit trail coverage for security events.
