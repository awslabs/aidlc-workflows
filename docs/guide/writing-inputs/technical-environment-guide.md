# Writing a Technical Environment Document

A technical environment document says **how the project is built**: the
languages, frameworks, cloud services, security rules and tests it must use,
and what it must not use. It is the technical counterpart to the
[vision document](vision-document-guide.md), and the reference the
Construction stages work from.

Without it, the design and build stages either ask you about each choice or
pick a default you then have to change. Allow lists and disallow lists, each
with a reason, stop the agents guessing.

---

## Where it goes in AI-DLC

The vision document goes into your first request. The technical environment
document belongs where every stage reads it: your space's team knowledge.

1. Save it as
   `aidlc/spaces/<space>/knowledge/aidlc-shared/technical-environment.md`
   (`default` is the space name unless you created others). Every Markdown
   file in `aidlc-shared/` is part of every stage's context. The
   [Knowledge](../08-knowledge.md) chapter calls this folder
   `aidlc/knowledge/aidlc-shared/`.
2. Optionally, move the parts only one agent needs into that agent's folder
   next to it, for example security into `aidlc-devsecops-agent/`, testing
   into `aidlc-quality-agent/`, and cloud services into
   `aidlc-aws-platform-agent/`. See
   [Adding Company Standards](../08-knowledge.md#adding-company-standards)
   for the folder names.
3. Put the few rules that must never be broken (a prohibited library, a
   required version) in `aidlc/spaces/<space>/memory/project.md` as well, or
   in `team.md` when they apply to every project your team runs. The memory
   files are rules every stage applies; see
   [Rules and the Learning Loop](../09-rules-and-the-learning-loop.md).

Do this before the first `/aidlc` of the piece of work. When the plan includes
Practices Discovery, early in Inception, it asks how your team works; on a new
project, the answers already in this document are quick to confirm.

---

## The short version

```text
1. Language and version
2. Package manager
3. Web framework (if any)
4. Cloud provider and deployment model, or "local only"
5. Test framework
6. Prohibited libraries and services, as a table: prohibited | reason | use instead
7. Security basics: how users sign in, how input is validated, where secrets live
8. Example code: one short example each of a typical endpoint, function and test
```

On item 6, the reason and the alternative matter: without them the agents
follow the prohibition but cannot judge a good substitute.

On item 8, even one or two short examples give Code Generation a pattern to
follow instead of inventing one. It is the most useful addition beyond the
basics.

### For work on an existing codebase

```text
1. Existing stack: language, framework, database, infrastructure, with versions
2. What to add: new services, tables, components
3. What must stay unchanged: services, schemas, contracts, configuration not to touch
4. Prohibited patterns: libraries or approaches that conflict with the existing code
5. Security basics: how sign-in and secrets work in the existing system
6. Example code taken from the existing codebase
```

Take the examples from real files, so new code looks like it belongs.
Reverse Engineering also reads the code, but it cannot tell which patterns you
want kept and which you are moving away from.

---

## The full structure

Mark each section for the kind of project: **(New)** for a new project,
**(Existing)** for work on an existing codebase, **(Both)**.

### 1. Project Technical Summary (Both)

```markdown
## Project Technical Summary

- **Project name**: [Name]
- **Project type**: [New / Existing codebase]
- **Runtime environment**: [Cloud / On-premises / Hybrid]
- **Cloud provider**: [AWS / Azure / GCP / Multi-cloud / None]
- **Deployment model**: [Serverless / Containers / VMs / Hybrid]
- **Team size and key skills**: [Number, experience relevant to the choices]
```

### 2. Programming Languages (Both)

```markdown
## Programming Languages

### Required
| Language | Version | Purpose | Reason |
|----------|---------|---------|--------|
| TypeScript | 5.x | Backend services, infrastructure code | Team expertise, type safety |

### Permitted with justification
| Language | When it may be used |
|----------|---------------------|
| Go | High-throughput services where latency is critical |

### Prohibited
| Language | Reason |
|----------|--------|
| PHP | No team expertise, not the platform direction |
```

For an existing codebase, add the languages already in use and the direction
for each (keep, upgrade, migrate).

### 3. Frameworks and Libraries (Both)

```markdown
## Frameworks and Libraries

### Required
| Framework or library | Version | Area | Reason |
|----------------------|---------|------|--------|
| React | 18.x | Frontend UI | Organisational standard |
| Jest | 29.x | Unit tests | One test runner across projects |

### Preferred when the need arises
| Library | Purpose | Use when |
|---------|---------|----------|
| Zod | Runtime validation | Any external input or API payload |
| Pino | Structured logging | Every service that logs |

### Prohibited
| Library | Reason | Use instead |
|---------|--------|-------------|
| Moment.js | Deprecated, large | date-fns or Luxon |
| request | Deprecated | Native fetch |

### Getting a new library approved
[Who approves a library that is not listed, and what they need to see.]
```

### 4. Cloud Environment and Services (Both)

```markdown
## Cloud Environment

- **Provider**: [AWS / Azure / GCP]
- **Account structure**: [Single account / Multi-account]
- **Regions**: [Primary, and disaster recovery if any]

### Allowed services
| Service | Approved use | Constraints |
|---------|--------------|-------------|
| AWS Lambda | Event-driven compute, API handlers | 15 min timeout |
| Amazon DynamoDB | Key-value and document storage | On-demand for dev |
| Amazon S3 | Objects, static assets | Versioning and encryption on |

### Disallowed services
| Service | Reason | Use instead |
|---------|--------|-------------|
| Amazon EC2 (direct) | Prefer managed compute | Lambda or ECS Fargate |

### Getting a new service approved
[Who approves a service that is not listed, and what they need to see.]
```

### 5. Architecture and Patterns (Both)

```markdown
## Architecture and Patterns

| Pattern | When to use | When not to use |
|---------|-------------|-----------------|
| Serverless-first | Default for new services | Long-running or connection-heavy work |
| Modular monolith | Single-team projects, first releases | Independently scaled domains |

### API standards
- **Style**: [REST / GraphQL / gRPC]
- **Versioning**: [URL path / header]
- **Documentation**: [OpenAPI 3.x for every REST API]
- **Naming**: [kebab-case URLs, camelCase JSON fields]
- **Errors**: [The standard error response shape]

### Data
- **Primary store**: [e.g. DynamoDB for service-owned data]
- **Relational data**: [e.g. PostgreSQL when queries need joins]
- **Ownership**: [e.g. each service owns its data; no shared databases]

### Messaging
- **Synchronous**: [e.g. HTTP between services]
- **Asynchronous**: [e.g. a queue for tasks, an event bus for events]

### Frontend (if any)
- **Components, state, routing, build tool**: [Your choices]
```

### 6. Security (Both)

```markdown
## Security

### Sign-in and access
- **Authentication**: [e.g. Amazon Cognito, OIDC, SAML]
- **Authorisation model**: [e.g. role-based]
- **Tokens and sessions**: [Format, expiry, refresh]

### Data protection
- **At rest**: [Encryption required, key management]
- **In transit**: [TLS 1.2 or later]
- **Personal data**: [Fields, masking, retention]

### Secrets
- **Storage**: [e.g. AWS Secrets Manager]
- **Rotation**: [Every N days]
- **Never**: secrets in source code, in config files, or shared between services

### Compliance
- **Standards**: [SOC 2, HIPAA, PCI-DSS, GDPR, or "none specific"]
- **Audit logging**: [What is logged, and for how long]
- **Scanning**: [Dependency and image scanning tools]
- **Licences**: [Allowed: MIT, Apache 2.0, BSD. Prohibited: GPL, AGPL]
```

#### Choose a security framework

Pick one framework and say, for each of its categories, how the project
addresses it. A category that does not apply says why; a control planned for
later names the gap and the phase.

| Kind of project | Common choices |
|-----------------|----------------|
| Web applications and APIs | OWASP Top 10, OWASP API Security Top 10 |
| Cloud infrastructure | The cloud provider's Well-Architected security pillar, CIS Benchmarks |
| Government or regulated | NIST 800-53, FedRAMP, ISO 27001 |
| General software | CIS Controls v8, SANS Top 25 |

For a framework with ten categories or fewer, put the full table in this
document. For a large one, keep it in a file of its own in the same knowledge
folder, for example `aidlc-devsecops-agent/nist-800-53-compliance.md`, and
link it from here.

### 7. Testing (Both)

```markdown
## Testing

| Test type | Required | Target | Tooling |
|-----------|----------|--------|---------|
| Unit | Yes | 80% line coverage | Jest / pytest |
| Integration | Yes | Every service-to-service call | Testcontainers |
| End-to-end | For key journeys | Critical user journeys | Playwright |
| Performance | When there are targets | The stated response times | k6 |
| Security | Yes | Every public endpoint | OWASP ZAP |

- **Mocking**: [Mock external dependencies, never internal business logic]
- **Test location**: [Next to the source, or a separate tests/ tree]
- **Naming**: [e.g. describe / it]

### Pipeline gates
| Pipeline step | Tests that must pass | On failure |
|---------------|----------------------|------------|
| Pull request | Unit and integration | Block the merge |
| Before staging deploy | End-to-end | Block the deploy |
```

How many tests the workflow writes also follows the test strategy you pick for
the piece of work; see
[Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md).

### 8. Example Code (Both)

Example code shows the canonical way to do the common things, so generated
code follows it rather than inventing a new style.

Provide examples for whichever of these the project has: the project layout,
an API endpoint, database access, error handling, applying authorisation, a
unit test and an integration test, logging, configuration loading, and an
infrastructure module.

Keep them in the repository, for example:

```text
project-root/
  examples/
    api-endpoint/
      handler.ts          # working code, not pseudocode
      handler.test.ts     # how to test it
      README.md           # what it shows, when to use it, what to change
    database-access/
      repository.ts
      repository.test.ts
      README.md
```

Each example should run, come with its test, and have a short README: what
pattern it shows, when to use it and when not, which parts to customise and
which to keep as they are.

The examples folder is not read on its own: say in this document which
example applies to what, for example "Every API endpoint follows
`examples/api-endpoint/`", so Code Generation opens it when it plans that
step. Keep the examples current when a standard changes, and rename a
superseded one with a `deprecated-` prefix and a note pointing to its
replacement.

### 9. Existing Codebase Only

```markdown
## Existing Technical Inventory

- **Languages and frameworks, with versions**: [List]
- **Infrastructure and deployment**: [Services, model]
- **Test coverage today**: [Figure or a short assessment]
- **Known technical debt**: [Key items]

### Keep
| Technology | Reason to keep |
|------------|----------------|

### Migrate
| Today | Target | Priority | Approach |
|-------|--------|----------|----------|
| JavaScript | TypeScript | High | File by file |

### Remove
| Item | Reason | When |
|------|--------|------|

### While old and new coexist
- **API versions**: [How v1 and v2 run side by side]
- **Schema changes**: [How migrations run alongside existing data]
- **Feature flags**: [How new behaviour is switched on]
```

---

## Where each section is used

| Section | Stage | How it is used |
|---------|-------|----------------|
| Project Technical Summary | Workspace Detection, Practices Discovery | Project classification and team practices |
| Languages, Frameworks and Libraries | NFR Design, Code Generation | What is used, at which version, and what is never added |
| Cloud Services | Feasibility & Constraints, Infrastructure Design | Which services the design may use |
| Architecture and Patterns | Domain Design, Contract Design, Functional Design | Structure, API and data decisions |
| Security | NFR Requirements, NFR Design, Build and Test | Security controls and their checks |
| Testing | Code Generation, Build and Test, CI Pipeline | Test types, coverage and gates |
| Example Code | Code Generation | The pattern each piece of code follows |
| Existing Technical Inventory | Reverse Engineering, Practices Discovery | What to keep, migrate or remove |

Which stages run depends on the plan you approve; see
[Phases and Stages](../04-phases-and-stages.md).
