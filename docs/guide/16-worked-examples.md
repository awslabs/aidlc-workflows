# Worked Examples

Two complete walkthroughs showing AI-DLC in action: a bugfix and a feature. Each demonstrates the command invocation, stage progression, approval gates, and artifact output.

> **Harness note.** These transcripts are recorded on **Claude Code**, so they show
> its surfaces — `/aidlc`, and subagent stages dispatched via `Task` calls. The
> stage flow, gates, and artifacts are identical on every harness; only the
> dispatch mechanic differs (Kiro uses its `subagent` tool, Codex uses `codex exec`
> workers). See [Running on other harnesses](harnesses/README.md).

---

## Bugfix Walkthrough

This example fixes a null pointer exception in a user profile API. The **bugfix** scope runs 9 stages (3 Initialization + 6 domain) at Minimal depth.

### Invocation

```
/aidlc bugfix
```

The conductor asks what you want to fix:

> **What would you like to build?**

You respond:

> The user profile API returns HTTP 500 when the `display_name` field is null. The `GET /api/v1/users/:id/profile` endpoint crashes with a NullPointerException in `ProfileSerializer.serialize()`. This affects about 12% of user profiles created before display_name was made mandatory.

### Stages executed

| # | Stage | Phase | Lead Agent | Mode |
|---|-------|-------|------------|------|
| 0.1 | Workspace Scaffold | Initialization | orchestrator | inline (auto-proceed) |
| 0.2 | Workspace Detection | Initialization | orchestrator | inline (auto-proceed) |
| 0.3 | State Init | Initialization | orchestrator | inline (auto-proceed) |
| 2.1 | Reverse Engineering | Inception | aidlc-developer-agent + aidlc-architect-agent | pipeline |
| 2.3 | Requirements Analysis | Inception | aidlc-product-agent | inline |
| 3.5 | Code Generation | Construction | aidlc-developer-agent | subagent |
| 3.6 | Build and Test | Construction | aidlc-quality-agent | inline |
| 4.1 | Deployment Pipeline | Operation | aidlc-pipeline-deploy-agent | inline |
| 4.3 | Deployment Execution | Operation | aidlc-pipeline-deploy-agent + aidlc-developer-agent | inline |

### Initialization (stages 0.1-0.3) — auto-proceed

The 3 Initialization stages run as a single deterministic tool call (`aidlc-utility intent-create`) in well under a second, without user interaction:

- **0.1 Workspace Scaffold** - Auto-creates the first intent and creates its record dir at `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (written `<record>/` below) - `<YYMMDD>` is a compact UTC date prefix so records sort chronologically, and `<label>` is the conductor's short kebab-case essence of the request; the canonical id is a UUIDv7 carried in the `intents.json` registry row
- **0.2 Workspace Detection** — Rule-based scan identifies Java 17, Spring Boot 3.2, Maven, brownfield project
- **0.3 State Init** — Initializes `aidlc-state.md` with scope `bugfix`, depth `Minimal`, and the domain stages marked for execution

> Progress: 3/9 overall | 3/3 INITIALIZATION stages complete. Next: Reverse Engineering

### Stage 2.1 — Reverse Engineering

A two-link pipeline scans the codebase: first an aidlc-developer-agent code scan, then an aidlc-architect-agent synthesis that writes the artifacts. It produces 9 durable artifacts for the repository in `aidlc/spaces/default/codekb/user-service/`:

| Artifact | Contents |
|----------|----------|
| `business-overview.md` | User service — profiles, preferences, auth tokens |
| `architecture.md` | Spring Boot monolith, 3-layer design |
| `code-structure.md` | 6 packages: controller, service, model, repository, serializer, config |
| `api-documentation.md` | 8 REST endpoints under `/api/v1/users/` |
| `component-inventory.md` | Controllers, services, repositories, and serializers catalogued |
| `technology-stack.md` | Java 17, Spring Boot 3.2, PostgreSQL 15, Jackson 2.15 |
| `dependencies.md` | Maven dependency tree, third-party libraries, version constraints |
| `code-quality-assessment.md` | 62% test coverage, basic CI |
| `reverse-engineering-timestamp.md` | When the scan ran, against which commit |

**Approval gate:**

```
Reverse Engineering complete. How would you like to proceed?
- Approve        -> Continue to Requirements Analysis
- Request Changes -> Provide revision feedback
```

You select **Approve**.

### Stage 2.3 — Requirements Analysis

The aidlc-product-agent persona loads and creates clarifying questions at `<record>/inception/requirements-analysis/requirements-analysis-questions.md`:

```markdown
## Q1: Bug Severity Classification
How severe is this bug for your users?
A. Critical — causes data loss or security exposure
B. High — blocks a core workflow for affected users
C. Medium — degraded experience but workaround exists
D. Low — cosmetic or minor inconvenience
X. Other (please specify)

[Answer]:
```

The conductor offers interaction modes:

```
How would you like to answer these questions?
- Guide me        -> Walk through each question interactively
- I'll edit the file -> Fill in answers directly
- Chat            -> Discuss freely
```

You select **Guide me** and answer: Q1 = High, Q2 = Username as fallback, Q3 = Handle null gracefully (no migration).

The conductor generates `requirements.md` with 3 functional requirements (null handling, serializer fix, fallback logic) and 1 non-functional requirement (no regression in response time).

**Approval gate:** You select **Approve**.

### Stage 3.5 — Code Generation

The conductor creates a code generation plan, then delegates to a aidlc-developer-agent subagent:

**Plan:**
1. Fix `ProfileSerializer.serialize()` to handle null `display_name`
2. Add unit tests for null/non-null cases
3. Fix `ProfileService.getProfile()` defensive check
4. Add integration tests for the API endpoint

You approve the plan. The subagent implements all 4 steps:

- **Modified**: `ProfileSerializer.java` (null-safe with username fallback)
- **Modified**: `ProfileService.java` (defensive null handling)
- **Created**: `ProfileSerializerTest.java` (2 unit tests)
- **Created**: `ProfileControllerIntegrationTest.java` (2 integration tests)

**Approval gate:** You select **Approve**.

### Stage 3.6 — Build and Test

The aidlc-quality-agent runs the build and tests:

```
mvn clean compile        # BUILD SUCCESS
mvn test                 # 89 tests, 0 failures
mvn verify               # Integration tests pass
```

Results captured in `<record>/construction/build-and-test/test-results.md`: 89 tests passed, 0 failures, coverage increased from 62% to 64%.

**Approval gate:** You select **Approve**.

### Stages 4.1 and 4.3 — Deploy

Deployment Pipeline inspects the existing delivery configuration and records
the deployment strategy, CD configuration, and rollback runbook. Environment
Provisioning remains skipped because this bugfix uses the existing target
environment.

After approval, Deployment Execution deploys the tested artifact through that
pipeline, runs smoke tests and health checks, and records the deployment log.
You approve the final gate and the workflow completes.

### End state

```
aidlc/spaces/default/
  codekb/
    user-service/             # 9 space-level RE artifacts
  intents/260624-null-display-fix/
    aidlc-state.md            # All 9 stages marked [x]
    audit/                    # Full decision trail (per-clone shards)
    inception/
      requirements-analysis/ # requirements.md + questions
    construction/
      bugfix-null-display-name/
        code-generation/     # plan + summary
      build-and-test/        # instructions + test results
    operation/
      deployment-pipeline/   # CD config + strategy + rollback runbook
      deployment-execution/  # deployment log + smoke tests + health checks
```

Application code in workspace root:
- `ProfileSerializer.java` (modified)
- `ProfileService.java` (modified)
- `ProfileSerializerTest.java` (created)
- `ProfileControllerIntegrationTest.java` (created)

### Key observations

1. **Approval gates at every domain stage** — you control each decision
2. **Minimal depth** — brief, targeted artifacts; only the questions needed to define the fix
3. **Subagent delegation** — heavy work (RE, code gen) runs in subprocesses while you approve
4. **Full audit trail** — every decision logged with ISO timestamps
5. **Session resume** — if interrupted at any point, `/aidlc` detects the in-progress state

---

## Feature Walkthrough

This example builds a notification service for a task management application. The **feature** scope runs all 33 stages at Standard depth. This walkthrough highlights key stages across all phases.

### Invocation

```
/aidlc feature
```

> **What would you like to build?**

> A notification service for our task management app. Users should receive in-app notifications and optional email digests when tasks are assigned, due dates approach, or comments are posted. Support notification preferences per user.

### Initialization (stages 0.1-0.3) — auto-proceed

The 3 Initialization stages run automatically inside `aidlc-utility intent-create`. Workspace Detection identifies: TypeScript, Node.js 20, Express, PostgreSQL, brownfield project with existing task and user services.

> Progress: 3/33 overall | Scope: feature, Depth: Standard

### Ideation Phase (stages 1.1-1.7)

**Stage 1.1 — Intent Capture** (aidlc-product-agent)

The aidlc-product-agent first records the permitted source universe in
`intent-capture-questions.md`, then asks about the problem, target users,
stakeholders, decision authority, communication needs, and scope:

```markdown
## Sources

- [desc] Initial description: "A notification service for our task management app..."
- [scope] Workflow-selected scope: `feature`.

## Q1. Which notification channels are in scope?
A. In-app only
B. In-app + email
C. In-app + email + push
D. In-app + email + push + SMS
X. Other

[Answer]: B. In-app + email
```

The resulting artifacts keep each claim tied to that register or a confirmed
answer:

```markdown
## Target Customer

Task-management users receiving assignment, due-date, or comment events. [desc]

## Notification Channels

In-app notifications and optional email digests are in scope. [Q1]

## Assumptions & Open Questions

None.
```

The stakeholder map uses the same tags in a `Source` column. Any unsupported
content is asked as a follow-up or remains under `## Assumptions & Open
Questions`; retained assumptions require your explicit acceptance and stay
labeled as assumptions. The aidlc-product-lead-agent then reviews source
grounding before the ordinary approval gate.

**Stage 1.4 — Scope Definition** (aidlc-product-agent)

Defines scope boundaries: in-scope (3 trigger types, user preferences, email digest), out-of-scope (push notifications, SMS, real-time WebSocket). Produces `scope-document.md` and `intent-backlog.md` with prioritized items.

**Stage 1.7 — Approval & Handoff** (aidlc-delivery-agent)

Compiles the initiative brief aggregating all Ideation outputs. Phase boundary verification confirms intent-to-scope traceability.

> Progress: 10/33 overall | IDEATION complete. Verification Gate passed.

### Inception Phase (stages 2.1-2.9)

**Stage 2.1 — Reverse Engineering** (pipeline)

Two-link scan of the existing codebase. It writes the 9 artifacts to the repository's space-level store at `aidlc/spaces/<active-space>/codekb/<repo>/`, identifying the existing service structure, database schema, and API patterns that the notification service must integrate with.

**Stage 2.2 — Practices Discovery** (aidlc-pipeline-deploy-agent)

This is a subagent hub-and-spoke. The aidlc-pipeline-deploy-agent drafts from the Reverse Engineering evidence; aidlc-quality-agent, aidlc-developer-agent, and aidlc-devsecops-agent then inspect that draft in parallel without seeing one another's contributions. The human interview resolves evidence gaps and policy judgments, after which the lead integrates all three contributions into `team-practices.md`, `discovered-rules.md`, and `evidence.md`. The gate offers **Approve** / **Request Changes**. After Approve, `practices-promote` writes `aidlc/spaces/<active-space>/memory/team.md` and `project.md`, then atomically records the affirmed timestamp and matching `PRACTICES_AFFIRMED` receipt; only then does the conductor report the stage approved. A missing, stale, or failed promotion leaves the gate open and the stage incomplete.

**Stage 2.3 — Requirements Analysis** (aidlc-product-agent)

Produces 12 functional requirements (notification triggers, preference CRUD, email rendering, digest scheduling) and 5 non-functional requirements (delivery latency < 5s, email retry, preference storage). Questions drill into edge cases: what happens when email delivery fails? How frequently should digests run?

**Stage 2.4 — User Stories** (mob)

The aidlc-product-agent first drafts the personas and stories. The aidlc-design-agent, aidlc-developer-agent, and aidlc-quality-agent then inspect that draft as mutually blind collaborators, each writing an identity-marked contribution file. The aidlc-product-agent lead integrates all three contributions into `personas.md` and `stories.md` before presenting the **Approve** / **Request Changes** gate.

**Stage 2.6 — Domain Design** (aidlc-architect-agent)

The aidlc-architect-agent designs the notification service architecture:

- **Components**: NotificationService, PreferenceService, EmailRenderer, DigestScheduler — each with behaviour, dependencies/dependents, and owned entities
- **Entity ownership**: NotificationService owns Notification + NotificationEvent; PreferenceService owns Preference
- **Rationale**: event-driven trigger pattern (vs. polling), SQS for email queue (vs. direct send) recorded in the Rationale section

Produces the consolidated `components.md` (fenced `yaml` catalogue + mermaid diagram, summary, ownership, and rationale tables) plus `decisions.md` (the ADR log).

**Stage 2.7 — Units Generation** (aidlc-architect-agent)

Decomposes into 3 units of work:

1. **notification-core** — Event handler, notification storage, in-app delivery
2. **notification-preferences** — Preference CRUD API, default preferences
3. **notification-email** — Email renderer, SQS integration, digest scheduler

Produces `unit-of-work.md` and `unit-of-work-dependency.md`: notification-core first, then notification-preferences, then notification-email, whose preference lookup depends on the preferences API.

**Stage 2.8 — Contract Design** (aidlc-architect-agent)

Because the system splits into three integrating units, Contract Design formalises the inter-unit boundaries: the internal event contract notification-core exposes to its callers, and the preference-lookup contract notification-email consumes from notification-preferences. Produces `contract-summary.md` (one row per boundary, each with an inline spec block).

**Stage 2.9 — Delivery Planning** (aidlc-delivery-agent)

Delivery Planning identifies notification-core as the first integrated slice: an event must reach stored notification data and in-app delivery. The later delivery grouping contains preferences and email, while the actual order respects their dependency. Per-Bolt DoDs land in `bolt-plan.md`, rationale in `risk-and-sequencing-rationale.md`, and SES/SQS dependencies in `external-dependency-map.md`. The engine follows the 2.7 DAG and recorded iteration choice. Phase boundary verification confirms requirements-to-architecture alignment.

> Progress: 19/33 overall | INCEPTION complete. Verification Gate passed.

### Construction Phase (stages 3.1-3.7)

This new source-producing solo workflow qualifies for the **unit-major, serial
checkpoint default**. The 2.9 Bolt plan remains planning content; the engine
walks the Units from `unit-of-work-dependency.md`.

**First Unit: notification-core — the working integrated slice**

The conductor runs notification-core through its applicable design stages and
Code Generation before starting either later Unit. Functional Design covers
Notification and NotificationEvent entities, deduplication, and rate limiting;
NFR and infrastructure work cover the first slice where applicable. You confirm
the summaries and approve its Code Generation plan before generation. The Unit
then produces its event handler, notification repository, and in-app delivery
endpoint: 3 source files and 4 test files in this example.

After the required reviews and completion receipts, a real project check submits
an event and verifies storage and in-app delivery. You approve that verified
skeleton checkpoint. The earlier Functional Design review by itself would not
have established that the integration worked.

If no autonomy choice has already been recorded, the workflow offers:

```
How should I continue building the remaining work?
  ▸ Continue automatically
  ▸ Review each checkpoint
```

You choose **Continue automatically**. The conductor records `autonomous` and
continues serially; this approval choice does not enable swarm execution.

**Remaining Units: notification-preferences, then notification-email**

Each Unit goes through its own applicable design stages, summary confirmation,
Plan Approval, code, checks, and reviews before the next begins:

- **notification-preferences** — Preference entity, defaults, channel toggles, CRUD API, repository, and validation; 2 source files and 3 test files.
- **notification-email** — Delivery rules, renderer, SQS consumer, and digest cron job using the approved preference-lookup contract; 4 source files and 5 test files.

The conductor may automatically approve each verified ordinary Unit checkpoint
under your recorded grant. Plan Approval and summary confirmation still wait
for you. Once all Units are approved, completion-only stage directives reconcile
bookkeeping without another round of stage-body or reviewer work.

**What a failure would look like.** If notification-email's check fails because
its SES mock cannot be constructed, the workflow stops and explains the failure.
The already completed preferences Unit stays complete. Any required repair-plan
approval remains a human decision; an automatic-completion grant never counts
as verification of a failed check.

**Stage 3.6 — Build and Test** (aidlc-quality-agent, runs once after all Units)

Generates build instructions, runs the full test suite across all 3 Units: 47 tests pass, 0 failures, 78% coverage.

**Stage 3.7 — CI Pipeline** (aidlc-pipeline-deploy-agent)

Configures CI pipeline with lint, build, test, and security scan stages. Quality gates: coverage >= 75%, no critical vulnerabilities.

> Progress: 26/33 overall | CONSTRUCTION complete. Verification Gate passed.

### Operation Phase (stages 4.1-4.7)

**Stage 4.1 — Deployment Pipeline** — Blue-green deployment strategy with health check gates

**Stage 4.2 — Environment Provisioning** — SQS queues, SES configuration, DynamoDB table for notification storage

**Stage 4.4 — Observability Setup** — CloudWatch dashboards for notification delivery latency, email send rate, dead-letter queue depth. Alarms for delivery failures.

**Stage 4.7 — Feedback & Optimization** — SLO targets (99.9% in-app delivery, 99% email delivery within 30s), cost analysis, feedback loop document.

> Progress: 33/33 overall | OPERATION complete. Feature workflow complete.

### Key differences from bugfix

| Aspect | Bugfix | Feature |
|--------|--------|---------|
| Stages executed | 9 | 33 |
| Depth | Minimal | Standard |
| Phases | Initialization + Inception + Construction + Operation | All 5 |
| Units of work | No Unit DAG; stage-level work | 3 |
| Construction walk | Existing stage-level flow | New unit-major, serial checkpoint flow (2.9 still plans delivery groupings) |
| Conditional stages | Most skipped | Most executed |
| Approval gates | Ordinary stage approvals | Verified human skeleton checkpoint; later completion follows the recorded choice; Plan Approval and summaries remain human |

---

## Next Steps

- [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) — How scopes determine which stages run
- [How a Stage Runs](04-phases-and-stages.md) — Stage protocol details
- [Agents](06-agents.md) — Agent personas and responsibilities
- [Artifacts Reference](14-artifacts-reference.md) — Complete artifact directory tree
