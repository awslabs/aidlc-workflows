---
slug: user-stories
phase: inception
execution: CONDITIONAL
condition: Execute when user-facing features, multiple personas, complex business logic, or cross-team work is involved. Skip for pure refactoring, isolated bug fixes, infrastructure-only changes, or developer tooling.
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-design-agent
mode: inline
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
produces:
  - stories
  - personas
  - user-stories-assessment
consumes:
  - artifact: requirements
    required: true
  - artifact: business-overview
    required: false
    conditional_on: brownfield
  - artifact: component-inventory
    required: false
    conditional_on: brownfield
  - artifact: team-practices
    required: false
requires_stage:
  - requirements-analysis
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - workshop
inputs: <record>/inception/requirements-analysis/requirements.md, RE artifacts (if brownfield)
outputs: stories.md, personas.md, user-stories-assessment.md (under this stage's record dir, engine-resolved)
---

# User Stories

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `.aidlc/knowledge/aidlc-product-agent/`.
Load aidlc-design-agent persona from `agents/aidlc-design-agent.md` and knowledge from `.aidlc/knowledge/aidlc-design-agent/` for supporting perspective on user experience.

### Step 2: Validate User Stories Are Needed

Assess whether user stories add value for this project. Provide reasoning:
- **Execute if**: user-facing features, multiple user personas, complex business logic, cross-team coordination needed
- **Skip if**: pure refactoring, isolated bug fixes, infrastructure-only, developer tooling

Create `<record>/inception/user-stories/user-stories-assessment.md` documenting the assessment:
- Decision: Execute or Skip
- Rationale: Why user stories are or are not needed for this project
- Factors considered: project type, user-facing scope, complexity signals
- If executing: key areas where stories will add the most value
- If skipping: what alternative coverage exists (e.g., requirements alone are sufficient)

If skipping, update aidlc-state.md with skip reason and proceed to next stage.

### Step 3: Load Prior Context

- Read `<record>/inception/requirements-analysis/requirements.md`
- If brownfield: Read relevant RE artifacts from `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` prints)

---

## PART 1: Planning

### Step 4: Create Story Plan with Questions

Create a story plan in `<record>/inception/user-stories/user-stories-questions.md` containing:
- **Persona development approach** — Who are the users? What are their goals?
- **Story format** — Using INVEST criteria (Independent, Negotiable, Valuable, Estimable, Small, Testable)
- **Story prioritization** — Assign MoSCoW priority (Must Have / Should Have / Could Have / Won't Have) to each story based on requirements analysis. The MVP boundary will be formally decided during Delivery Planning; story priorities inform that decision.
- **Breakdown approach options** — By feature, by persona, by workflow, by domain area, by epic
- **Embedded questions** — Using [Answer]: tag format for user input on personas, story granularity

### Step 5: Collect Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file).

### Step 6: Analyze Answers

MANDATORY ambiguity analysis:
- Scan ALL responses for vague language ("mix of", "not sure", "depends", "probably")
- Check for contradictions between answers
- Identify missing details
- Create follow-up questions if ANY ambiguity found

### Step 7: Present plan and generate

Present the story plan summary (persona count, story count, breakdown approach) inline. Then immediately proceed to PART 2: Generation. The user will review and approve the combined output (plan + generated stories) at the completion gate.

If the user interjects with feedback before generation completes, treat it as a revision request — update the plan accordingly before continuing generation.

---

## PART 2: Generation

### Step 8: Execute Plan — Generate Stories and Personas

Based on the approved plan, generate:

**`<record>/inception/user-stories/personas.md`:**
- User persona definitions (name, role, goals, pain points, context)
- Persona relationships and priority ranking

**`<record>/inception/user-stories/stories.md`:**
- User stories in standard format: "As a [persona], I want [goal], so that [benefit]"
- Acceptance criteria for each story
- Story priority (Must Have / Should Have / Could Have / Won't Have)
- Story dependencies and relationships
- INVEST compliance notes

### Step 9: Update State

Update `<record>/aidlc-state.md`:
- Mark User Stories as `[x]` completed
- Update current stage and next stage

### Step 10: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :books:
- Summary of personas and stories produced
- Review path: `<record>/inception/user-stories/`
- Structured approval question with options: Approve (continue to Delivery Planning) / Request Changes

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/user-stories/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `requirements`, `team-practices`).

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

- Prescriptive rule → `.aidlc/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.aidlc/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.aidlc/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
