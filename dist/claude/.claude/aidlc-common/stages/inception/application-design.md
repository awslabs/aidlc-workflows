---
slug: application-design
phase: inception
execution: CONDITIONAL
condition: Execute when new components or services are needed, or service layer design is required. Skip when changes are modifications to existing components only.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-aws-platform-agent
  - aidlc-design-agent
mode: inline
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
produces:
  - components
  - component-methods
  - services
  - component-dependency
  - decisions
consumes:
  - artifact: requirements
    required: true
  - artifact: stories
    required: false
  - artifact: architecture
    required: false
    conditional_on: brownfield
  - artifact: component-inventory
    required: false
    conditional_on: brownfield
  - artifact: team-practices
    required: false
requires_stage:
  - requirements-analysis
  - refined-mockups
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - workshop
inputs: <record>/inception/requirements-analysis/requirements.md, <record>/inception/user-stories/stories.md (if produced), RE artifacts (if brownfield)
outputs: components.md, component-methods.md, services.md, component-dependency.md, decisions.md (under this stage's record dir, engine-resolved)
---

# Application Design

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-architect-agent persona from `agents/aidlc-architect-agent.md` and knowledge from `.claude/knowledge/aidlc-architect-agent/`.
Load aidlc-aws-platform-agent persona from `agents/aidlc-aws-platform-agent.md` and knowledge from `.claude/knowledge/aidlc-aws-platform-agent/` for AWS service mapping.
Load aidlc-design-agent persona from `agents/aidlc-design-agent.md` and knowledge from `.claude/knowledge/aidlc-design-agent/` for UI component specifications and UX-informed design constraints.

### Step 2: Load Prior Context

- Read `<record>/inception/requirements-analysis/requirements.md`
- Read `<record>/inception/user-stories/stories.md` (if produced)
- If brownfield: Read relevant RE artifacts (especially architecture.md, component-inventory.md, dependencies.md)

### Step 3: Create Design Plan with Questions

Create `<record>/inception/application-design/application-design-questions.md` with context-appropriate questions using [Answer]: tag format:
- Component boundary decisions
- Architectural style preferences (if not already decided)
- Service communication patterns (sync vs. async, REST vs. gRPC vs. events)
- Data ownership and storage strategy
- Integration approach with existing components (brownfield)
- UI component structure (if user-facing, informed by UX designer perspective)

### Step 4: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file).
- MANDATORY ambiguity analysis: scan for vague language, contradictions, missing details
- Create follow-up questions if ANY ambiguity found
- Resolve all ambiguities before proceeding

### Step 5: Generate Design Artifacts

Create 5 design artifacts in `<record>/inception/application-design/`:

**components.md:**
- Component names and purposes
- Component responsibilities (what each component owns)
- Component interfaces (public API surface)
- Component boundaries and ownership

**component-methods.md:**
- Method signatures for each component's public interface
- High-level method purposes (detailed business rules belong in Functional Design)
- Input/output types
- Error handling approach per method

**services.md:**
- Service definitions and responsibilities
- Orchestration patterns (choreography vs. orchestration)
- Service communication contracts
- Service lifecycle and scaling characteristics

**component-dependency.md:**
- Dependency matrix (which components depend on which)
- Communication patterns between components (sync, async, event-driven)
- Data flow between components
- Shared resource identification

**decisions.md:**
- Architecture Decision Records (ADRs) for each significant design choice
- Each ADR includes: Context, Decision, Consequences, Alternatives Considered
- Trade-off analysis for key decisions
- Reversibility assessment (easy to change vs. locked in)

#### Architecture options (when >1 viable approach)

When a design choice has more than one viable approach, present the
trade-off before recording the decision:

- Option A — <name>: pros / cons / reversibility
- Option B — <name>: pros / cons / reversibility
- Recommendation: <option> because <trade-off tied to NFRs>

The team chooses at the gate (ownership stays with the team), then append
the chosen option plus an **Alternatives Rejected** section to the ADR in
decisions.md.

When only one option is viable, state why and skip the block.

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage application-design --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 7: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :building_construction:
- Summary of design artifacts produced
- Key architectural decisions highlighted
- Review path: `<record>/inception/application-design/`
- Structured approval question with options:
  - Approve (continue to next stage)
  - Request Changes (provide revision feedback)
  - Add Units Generation (if it was skipped in execution plan)

If "Add Units Generation" is selected, run
`bun .claude/tools/aidlc-utility.ts recompose --add units-generation`
before re-entering the approval flow.

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/application-design/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `requirements`, `stories`, `team-practices`).

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → a practice line under the routed heading in
  `aidlc/spaces/<active-space>/memory/project.md` (default) or `team.md` (promoted)
- Verification check → new manifest at `.claude/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
