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
| 3.7 | Build and Test | Construction | aidlc-quality-agent | inline |
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

### Stage 3.7 — Build and Test

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

This example builds a notification service for a task management application. The **feature** scope runs all 33 stock-scope stages at Standard depth; PR Integration joins only when practices affirm it. This walkthrough highlights key stages across all phases.

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

Produces `unit-of-work.md` with dependency map: notification-core first, then preferences and email in parallel.

**Stage 2.8 — Contract Design** (aidlc-architect-agent)

Because the system splits into three integrating units, Contract Design formalises the inter-unit boundaries: the internal event contract notification-core exposes to its callers, and the preference-lookup contract notification-email consumes from notification-preferences. Produces `contract-summary.md` (one row per boundary, each with an inline spec block).

**Stage 2.9 — Delivery Planning** (aidlc-delivery-agent)

Planning only: Bolt 1 would ship notification-core (walking skeleton — proves the event-handler pipeline end-to-end). Bolt 2 would ship notification-preferences and notification-email together. Per-Bolt DoDs land in `bolt-plan.md`; WSJF-style rationale in `risk-and-sequencing-rationale.md`; external SES/SQS dependencies mapped in `external-dependency-map.md`. The Construction engine does not consume this plan for walk order — runtime batches still come from the 2.7 DAG. Phase boundary verification confirms requirements-to-architecture alignment.

> Progress: 19/33 overall | INCEPTION complete. Verification Gate passed.

### Construction Phase (stages 3.1-3.8)

Construction's **default walk is stage-major**. The 2.9 Bolt plan stays on disk as planning; the engine walks Units from `unit-of-work-dependency.md`. The first in-scope Construction EXECUTE stage (here 3.1) is the walking-skeleton gate; the ladder after it decides remaining *stage* gates.

**3.1 Functional Design** — every Unit (walking-skeleton gate)

The conductor runs functional design for notification-core, then notification-preferences, then notification-email (or a wave for the last two once core is settled). You approve one stage-level gate covering all three Units — Code Generation has not run.

- **notification-core** — Domain entities (Notification, NotificationEvent), business rules (deduplication, rate limiting)
- **notification-preferences** — Preference entity, default values, channel toggles
- **notification-email** — delivery-addressing rules that the later email unit will implement

Immediately after that first Construction gate, the **ladder prompt** fires:

```
The walking skeleton shipped. How should the remaining Bolts run?
  ▸ Continue autonomously
    Skip remaining Construction stage gates. Failures still halt and ask.
  ▸ Gate every Bolt
    Present an approval gate after each remaining Construction stage.
```

You've seen the opening design shape, so you pick **Continue autonomously**. The conductor records `Construction Autonomy Mode: autonomous` in `aidlc-state.md` and emits `AUTONOMY_MODE_SET`. Remaining design stages (3.2–3.4 as in scope) run for every Unit without a gate.

**3.5 Code Generation** — every Unit; preferences + email may batch

notification-core generates first (it unblocks the others): event handler, notification repository, in-app delivery endpoint. 3 source files, 4 test files. Then notification-preferences and notification-email share a dependency-satisfied batch, so the conductor dispatches **both code-generation Units concurrently** by issuing two `Task` calls in a single turn.

- **notification-preferences** — CRUD API endpoints, preference repository, validation. 2 source files, 3 test files.
- **notification-email** — Email renderer, SQS consumer, digest cron job. 4 source files, 5 test files. (3.2/3.4 artifacts for this Unit already exist from the earlier stage-major pass.)

Both subagent Tasks return in the next turn. Under the swarm the engine presents **one** Code Generation stage gate after this final batch — not a gate per intermediate batch. Because you chose autonomous, that remaining stage gate is skipped and Construction proceeds to the affirmed PR Integration pass.

**What a failure would look like.** Suppose `notification-email`'s Code Generation had returned with a broken SES mock. The conductor would wait for `notification-preferences` to finish, preserve its artifacts on disk, and present:

```
Unit notification-preferences succeeded. Unit notification-email failed during code generation:
  "SES client mock could not be constructed — check test config."

Options:
  ▸ Retry         Re-run notification-email from code generation.
  ▸ Skip          Mark notification-email skipped and continue. Dependents may also fail.
  ▸ Abort         Stop Construction. Resume via /aidlc --stage code-generation.
```

You'd pick **Retry**, fix the mock setup, and only notification-email re-runs. Preferences is already `[x]` complete.

**Stage 3.6 — PR Integration** (aidlc-pipeline-deploy-agent, per Unit)

Each Unit opens an evidence-rich PR. While notification-core is in review, the
other Units continue. After all three PRs are verified merged, the tool folds
their metadata and completes the Unit receipts.

**Stage 3.7 — Build and Test** (aidlc-quality-agent, runs once after all Units)

Generates build instructions, runs the full test suite across all 3 Units: 47 tests pass, 0 failures, 78% coverage.

**Stage 3.8 — CI Pipeline** (aidlc-pipeline-deploy-agent)

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
| Units of work | 1 | 3 |
| Construction walk | Stage-major; one Unit | Stage-major across 3 Units (2.9 still plans 2 Bolts) |
| Conditional stages | Most skipped | Most executed |
| Approval gates | 4 | First Construction EXECUTE stage + ladder; remaining stage gates per autonomy mode |

---

## Next Steps

- [Scopes, Depth, and Test Strategy](05-scopes-and-depth.md) — How scopes determine which stages run
- [How a Stage Runs](04-phases-and-stages.md) — Stage protocol details
- [Agents](06-agents.md) — Agent personas and responsibilities
- [Artifacts Reference](14-artifacts-reference.md) — Complete artifact directory tree
