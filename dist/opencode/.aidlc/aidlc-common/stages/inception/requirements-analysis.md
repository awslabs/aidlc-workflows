---
slug: requirements-analysis
phase: inception
execution: ALWAYS
condition: Always executes — depth scales with project complexity
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
produces:
  - requirements
  - requirements-analysis-questions
consumes:
  - artifact: intent-statement
    required: false
  - artifact: scope-document
    required: false
  - artifact: business-overview
    required: false
    conditional_on: brownfield
  - artifact: architecture
    required: false
    conditional_on: brownfield
  - artifact: code-structure
    required: false
    conditional_on: brownfield
  - artifact: team-practices
    required: false
requires_stage:
  - approval-handoff
  - reverse-engineering
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - poc
  - bugfix
  - refactor
  - infra
  - security-patch
  - workshop
inputs: RE artifacts (if brownfield), user's project description (from <record>/audit/<host>-<clone>.md)
outputs: requirements.md, requirements-analysis-questions.md (under this stage's record dir, engine-resolved)
---

# Requirements Analysis

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `.aidlc/knowledge/aidlc-product-agent/`.

### Step 2: Load Prior Context

- If brownfield: Read RE artifacts from `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` prints)
- Read user's project description from `<record>/audit/<host>-<clone>.md`

### Step 3: Analyze User Request

Assess the user's request for:
- **Clarity**: How well-defined is the request?
- **Type**: New feature, enhancement, refactoring, bug fix, migration
- **Scope**: Single component, multi-component, system-wide
- **Complexity**: Simple, standard, complex

### Step 4: Determine Depth

Based on complexity assessment:
- **Minimal**: Clear request, narrow scope, well-understood domain
- **Standard**: Moderate scope, some unknowns, multiple stakeholders
- **Comprehensive**: Large scope, significant unknowns, complex domain

### Step 5: Assess Current Requirements

Extract and organize what is already known from the user's input:
- Explicit functional requirements
- Implied non-functional requirements
- Constraints and assumptions
- Business context and goals

### Step 6: Completeness Analysis

Evaluate coverage across six dimensions:
1. **Functional requirements** — Core behaviors, features, use cases
2. **Non-functional requirements** — Performance, security, scalability, reliability
3. **User scenarios** — User workflows, edge cases, error scenarios
4. **Business context** — Goals, success metrics, stakeholders, constraints
5. **Technical context** — Integration points, platform requirements, technology constraints
6. **Quality attributes** — Maintainability, testability, accessibility, usability

Identify gaps in each dimension.

### Step 7: Generate Clarifying Questions

PROACTIVE: Always generate clarifying questions unless requirements are exceptionally clear and complete across all six dimensions.

Create `<record>/inception/requirements-analysis/requirements-analysis-questions.md` using the [Answer]: tag format from stage-protocol.md. Include context-appropriate questions with A-E options. EVERY question MUST end with `X. Other (please specify)` as the final option. Leave all [Answer]: tags blank.

Then follow the unified question flow from stage-protocol.md section 3: offer the user a choice between guided (interactive) and self-guided (file edit) modes. In either case, ensure all answers are written to the file before proceeding.

### Step 8: Collect and Analyze Answers

After all answers are collected:
1. Read `<record>/inception/requirements-analysis/requirements-analysis-questions.md`
2. Confirm ALL `[Answer]:` tags are filled in. If any are blank, present the unanswered questions as structured questions and write answers back. Do NOT proceed with partial answers.
3. Then proceed with ambiguity detection and contradiction analysis on the full answer set.

- MANDATORY ambiguity detection: scan ALL responses for vague language ("mix of", "not sure", "depends", "probably", "maybe")
- Check for contradictions between answers
- Identify missing details needed for requirements generation

### Step 9: Follow-Up Questions

If ANY ambiguity, vagueness, or contradictions found in Step 8:
- Create follow-up questions targeting the specific ambiguities
- Resolve all ambiguities before proceeding
- When in doubt, ask. Incomplete answers lead to poor designs.

### Step 10: Confirm the Consolidated Summary

MANDATORY PRE-GENERATION STOP: After every original and follow-up answer is
filled, append or update a `## Consolidated Summary Confirmation` entry in
`<record>/inception/requirements-analysis/requirements-analysis-questions.md`.
The entry MUST contain:

- A clear list summarizing every answer
- `Does this all look correct before I generate the requirements artifact?`
- `Looks correct` and `Request changes` options
- A blank `[Answer]:` tag

Present that prompt as a structured question using the
`Looks correct` / `Request changes` options from `stage-protocol.md`, then end
the turn and wait for the user's response. Fill the confirmation `[Answer]:`
tag only after the user responds. If the user requests changes, update the
affected answers, reset the confirmation `[Answer]:` to blank, and repeat this
step. Do NOT create `requirements.md` until the confirmation entry contains the
user's explicit `Looks correct` answer.

### Step 11: Generate Requirements

Create `<record>/inception/requirements-analysis/requirements.md` containing:
- **Intent analysis** — What the user is trying to achieve (goals, not just features)
- **Functional requirements** — Organized by feature area or domain
- **Non-functional requirements** — Performance, security, scalability targets
- **Constraints** — Technical, business, and organizational constraints
- **Assumptions** — Documented assumptions with rationale
- **Out of scope** — Explicitly excluded items
- **Open questions** — Any remaining uncertainties for later stages

### Step 12: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .aidlc/tools/aidlc-orchestrate.ts report --stage requirements-analysis --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 13: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :mag:
- Summary of requirements produced
- Review path: `<record>/inception/requirements-analysis/`
IF User Stories is set to SKIP in the execution state:
```question
prompt: "Requirements Analysis complete. How would you like to proceed?"
header: Approval
multiSelect: false
options:
  - label: Approve
    description: Continue to [next stage]
  - label: Request Changes
    description: Provide revision feedback
  - label: Add User Stories
    description: Include User Stories stage (currently skipped)
```
Render `[next stage]` verbatim from the run-stage directive's `next_stage`
field (per the stage-protocol.md approval-gate binding), or `Complete workflow`
when it is null. Never guess the next stage name.
If "Add User Stories" is selected, run
`bun .aidlc/tools/aidlc-utility.ts recompose --add user-stories`
before re-entering the approval flow.

IF User Stories is NOT set to SKIP: use standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/requirements-analysis/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `intent-statement`, `scope-document`, `team-practices`).

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
- Verification check → new manifest at `.aidlc/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
