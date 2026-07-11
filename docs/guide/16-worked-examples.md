# Worked Examples

Two complete walkthroughs showing AI-DLC in action: a bugfix and a feature. Each demonstrates the command invocation, stage progression, approval gates, and artifact output.

> **Harness note.** These transcripts are recorded on **Claude Code**, so they show
> its surfaces — `/aidlc`, and subagent stages dispatched via `Task` calls. The
> stage flow, gates, and artifacts are identical on every harness; only the
> dispatch mechanic differs (Kiro uses its `subagent` tool, Codex uses `codex exec`
> workers). See [Running on other harnesses](harnesses/README.md).

---

## Bugfix Walkthrough

This example fixes a null pointer exception in a user profile API. The **bugfix** scope runs 7 stages (3 Initialization + 4 domain) at Minimal depth.

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
| 2.1 | Reverse Engineering | Inception | aidlc-developer-agent + aidlc-architect-agent | subagent |
| 2.3 | Requirements Analysis | Inception | aidlc-product-agent | inline |
| 3.5 | Code Generation | Construction | aidlc-developer-agent | subagent |
| 3.6 | Build and Test | Construction | aidlc-quality-agent | inline |

### Initialization (stages 0.1-0.3) — auto-proceed

The 3 Initialization stages run as a single deterministic tool call (`aidlc-utility intent-birth`) in well under a second, without user interaction:

- **0.1 Workspace Scaffold** — Auto-births the first intent and creates its record dir at `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (written `<record>/` below) — `<YYMMDD>` is a compact UTC date prefix so records sort chronologically, and `<label>` is the conductor's short kebab-case essence of the request; the canonical id is a UUIDv7 carried in the `intents.json` registry row
- **0.2 Workspace Detection** — Rule-based scan identifies Java 17, Spring Boot 3.2, Maven, brownfield project
- **0.3 State Init** — Initializes `aidlc-state.md` with scope `bugfix`, depth `Minimal`, and the domain stages marked for execution

> Progress: 3/7 overall | 3/3 INITIALIZATION stages complete. Next: Reverse Engineering

### Stage 2.1 — Reverse Engineering

A two-step subagent scans the codebase: first a aidlc-developer-agent code scan, then an aidlc-architect-agent synthesis. Produces 9 artifacts in `<record>/inception/reverse-engineering/`:

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

**Approval gate:** You select **Approve**. Workflow complete.

### End state

```
aidlc/spaces/default/intents/260624-null-display-fix/
  aidlc-state.md              # All 7 stages marked [x]
  audit/                      # Full decision trail (per-clone shards)
  inception/
    reverse-engineering/       # 9 RE artifacts
    requirements-analysis/     # requirements.md + questions
  construction/
    bugfix-null-display-name/
      code-generation/         # plan + summary
    build-and-test/            # instructions + test results
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

This example builds a notification service for a task management application. The **feature** scope runs all 32 stages at Standard depth. This walkthrough highlights key stages across all phases.

### Invocation

```
/aidlc feature
```

> **What would you like to build?**

> A notification service for our task management app. Users should receive in-app notifications and optional email digests when tasks are assigned, due dates approach, or comments are posted. Support notification preferences per user.

### Initialization (stages 0.1-0.3) — auto-proceed

The 3 Initialization stages run automatically inside `aidlc-utility intent-birth`. Workspace Detection identifies: TypeScript, Node.js 20, Express, PostgreSQL, brownfield project with existing task and user services.

> Progress: 3/32 overall | Scope: feature, Depth: Standard

### Ideation Phase (stages 1.1-1.7)

**Stage 1.1 — Intent Capture** (aidlc-product-agent)

The aidlc-product-agent captures your intent and produces `intent-statement.md` and `stakeholder-map.md`. Questions focus on target users, notification channels, and priority:

```
Q1: Which notification channels are in scope?
A. In-app only
B. In-app + email
C. In-app + email + push
D. In-app + email + push + SMS
X. Other
```

You answer B (in-app + email). After approval, the stage produces a structured intent statement linking notification types to user triggers.

**Stage 1.4 — Scope Definition** (aidlc-product-agent)

Defines scope boundaries: in-scope (3 trigger types, user preferences, email digest), out-of-scope (push notifications, SMS, real-time WebSocket). Produces `scope-document.md` and `intent-backlog.md` with prioritized items.

**Stage 1.7 — Approval & Handoff** (aidlc-delivery-agent)

Compiles the initiative brief aggregating all Ideation outputs. Phase boundary verification confirms intent-to-scope traceability.

> Progress: 10/32 overall | IDEATION complete. Verification Gate passed.

### Inception Phase (stages 2.1-2.8)

**Stage 2.1 — Reverse Engineering** (subagent)

Two-step scan of the existing codebase. Identifies the existing service structure, database schema, and API patterns that the notification service must integrate with.

**Stage 2.2 — Practices Discovery** (aidlc-pipeline-deploy-agent)

The aidlc-pipeline-deploy-agent leads this stage, with aidlc-quality-agent, aidlc-developer-agent, and aidlc-devsecops-agent supporting. Because this is a brownfield project, it consumes the Reverse Engineering artifacts to infer the team's existing practices — test framework and coverage conventions, CI/lint setup, branching and review norms. Produces `team-practices.md`, `discovered-rules.md`, and `evidence.md`. On affirmation, the discovered practices are promoted into `aidlc/spaces/<space>/memory/team.md` and `aidlc/spaces/<space>/memory/project.md` so downstream stages honour them.

**Stage 2.3 — Requirements Analysis** (aidlc-product-agent)

Produces 12 functional requirements (notification triggers, preference CRUD, email rendering, digest scheduling) and 5 non-functional requirements (delivery latency < 5s, email retry, preference storage). Questions drill into edge cases: what happens when email delivery fails? How frequently should digests run?

**Stage 2.6 — Application Design** (aidlc-architect-agent)

The aidlc-architect-agent designs the notification service architecture:

- **Components**: NotificationService, PreferenceService, EmailRenderer, DigestScheduler
- **API contracts**: REST endpoints for preference management, internal event handlers for triggers
- **ADRs**: Event-driven trigger pattern (vs. polling), SQS for email queue (vs. direct send)

Produces `components.md`, `services.md`, `decisions.md`.

**Stage 2.7 — Units Generation** (aidlc-architect-agent)

Decomposes into 3 units of work:

1. **notification-core** — Event handler, notification storage, in-app delivery
2. **notification-preferences** — Preference CRUD API, default preferences
3. **notification-email** — Email renderer, SQS integration, digest scheduler

Produces `unit-of-work.md` with dependency map: notification-core first, then preferences and email in parallel.

**Stage 2.8 — Delivery Planning** (aidlc-delivery-agent)

Bolt sequence: Bolt 1 ships notification-core (walking skeleton — proves the event-handler pipeline end-to-end). Bolt 2 ships notification-preferences and notification-email in parallel. Per-Bolt DoDs captured in `bolt-plan.md`; WSJF-style rationale in `risk-and-sequencing-rationale.md`; external SES/SQS dependencies mapped in `external-dependency-map.md`. Phase boundary verification confirms requirements-to-architecture alignment.

> Progress: 18/32 overall | INCEPTION complete. Verification Gate passed.

### Construction Phase (stages 3.1-3.7)

Construction runs **Bolt by Bolt** per the 2.8 plan. The first Bolt is the walking skeleton; the ladder prompt after it decides autonomy for the rest. Bolts with shared dependencies run in parallel.

**Bolt 1: notification-core** — walking skeleton (always gated)

This Bolt is the end-to-end slice that proves the event-handler pipeline works: a notification event arrives on the internal handler, lands in storage, and surfaces on the in-app delivery endpoint. The conductor opens it with a single round of questions across 3.1–3.4 for notification-core, then generates all design artifacts, then delegates code generation to a aidlc-developer-agent subagent.

- **3.1 Functional Design** — Domain entities (Notification, NotificationEvent), business rules (deduplication, rate limiting)
- **3.5 Code Generation** — Event handler, notification repository, in-app delivery endpoint. 3 source files, 4 test files.

Walking-skeleton gate — you review the code summary for Bolt 1 and approve.

Immediately after approval, the **ladder prompt** fires:

```
The walking skeleton shipped. How should the remaining Bolts run?
  ▸ Continue autonomously
    Run remaining Bolts without gates. Failures still halt and ask.
  ▸ Gate every Bolt
    Present an approval gate after each Bolt (or parallel batch).
```

You've seen the shape work, so you pick **Continue autonomously**. The conductor records `Construction Autonomy Mode: autonomous` in `aidlc-state.md` and emits `AUTONOMY_MODE_SET`.

**Bolt 2: notification-preferences + notification-email** — parallel batch

Both depend only on notification-core and don't depend on each other, so 2.8's plan schedules them in a single batch. The conductor collects questions and generates design artifacts per Bolt, then dispatches **both code-generation stages concurrently** by issuing two `Task` calls in a single turn.

- **notification-preferences — 3.1 Functional Design** — Preference entity, default values, channel toggles
- **notification-preferences — 3.5 Code Generation** — CRUD API endpoints, preference repository, validation. 2 source files, 3 test files.
- **notification-email — 3.2 NFR Requirements** — Email delivery reliability (retry with exponential backoff), digest scheduling accuracy
- **notification-email — 3.4 Infrastructure Design** — SQS queue, SES integration, CloudWatch alarm for dead-letter queue
- **notification-email — 3.5 Code Generation** — Email renderer, SQS consumer, digest cron job. 4 source files, 5 test files.

Both subagent Tasks return in the next turn. Because you chose autonomous, no batch gate — Construction proceeds straight to 3.6.

**What a failure would look like.** Suppose `notification-email`'s Code Generation had returned with a broken SES mock. The conductor would wait for `notification-preferences` to finish, preserve its artifacts on disk, and present:

```
Bolt notification-preferences succeeded. Bolt notification-email failed during code generation:
  "SES client mock could not be constructed — check test config."

Options:
  ▸ Retry         Re-run notification-email from code generation.
  ▸ Skip          Mark notification-email skipped and continue. Dependent Bolts may also fail.
  ▸ Abort         Stop Construction. Resume via /aidlc --stage code-generation.
```

You'd pick **Retry**, fix the mock setup, and only notification-email re-runs. Preferences is already `[x]` complete.

**Stage 3.6 — Build and Test** (aidlc-quality-agent, runs once after all Bolts)

Generates build instructions, runs the full test suite across all 3 Units: 47 tests pass, 0 failures, 78% coverage.

**Stage 3.7 — CI Pipeline** (aidlc-pipeline-deploy-agent)

Configures CI pipeline with lint, build, test, and security scan stages. Quality gates: coverage >= 75%, no critical vulnerabilities.

> Progress: 25/32 overall | CONSTRUCTION complete. Verification Gate passed.

### Operation Phase (stages 4.1-4.7)

**Stage 4.1 — Deployment Pipeline** — Blue-green deployment strategy with health check gates

**Stage 4.2 — Environment Provisioning** — SQS queues, SES configuration, DynamoDB table for notification storage

**Stage 4.4 — Observability Setup** — CloudWatch dashboards for notification delivery latency, email send rate, dead-letter queue depth. Alarms for delivery failures.

**Stage 4.7 — Feedback & Optimization** — SLO targets (99.9% in-app delivery, 99% email delivery within 30s), cost analysis, feedback loop document.

> Progress: 32/32 overall | OPERATION complete. Feature workflow complete.

### Key differences from bugfix

| Aspect | Bugfix | Feature |
|--------|--------|---------|
| Stages executed | 7 | 32 |
| Depth | Minimal | Standard |
| Phases | Initialization + Inception + Construction | All 5 |
| Units of work | 1 | 3 |
| Bolt-by-Bolt Construction | No (bugfix runs a single Bolt) | Yes — 2 Bolts (walking skeleton + 1 parallel batch) |
| Conditional stages | Most skipped | Most executed |
| Approval gates | 4 | Walking skeleton + ladder prompt; remaining Bolts per autonomy mode |

---

## Next Steps

- [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) — How scopes determine which stages run
- [How a Stage Runs](04-phases-and-stages.md) — Stage protocol details
- [Agents](06-agents.md) — Agent personas and responsibilities
- [Artifacts Reference](14-artifacts-reference.md) — Complete artifact directory tree
