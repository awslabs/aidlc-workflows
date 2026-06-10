# Inception Phase -- Stage Reference (2.1--2.8)

## Phase Overview

The Inception phase is the third of five phases in the AI-DLC methodology. It
transforms the Ideation phase's business intent and scope into concrete
technical artifacts: reverse-engineered codebase understanding (for brownfield
projects), team practices and operational rules, formal requirements, user
stories, refined mockups, application architecture, unit-of-work decomposition,
and a delivery plan that governs the Construction phase.

Inception runs stages 2.1 through 2.8 (8 stages) and concludes with a phase
boundary verification check at Stage 2.8 (Delivery Planning) before handing
off to Construction. The phase contains a mix of inline and subagent
execution modes, including a two-step subagent delegation at Stage 2.1
(aidlc-developer-agent for the code scan, then aidlc-architect-agent for the synthesis)
and a parallel multi-agent dispatch at Stage 2.2 (Practices Discovery).

**Key characteristics of the Inception phase:**

- The phase begins with a technical discovery stage (2.1 Reverse Engineering)
  that uses subagent delegation, followed by a methodology-discovery stage
  (2.2 Practices Discovery) that uses parallel multi-agent dispatch, then six
  inline analysis and design stages.
- Stage 2.1 uses a two-step subagent pattern: aidlc-developer-agent scans the code,
  then aidlc-architect-agent synthesizes the scan into 9 structured artifacts. It
  has an always-rerun policy for brownfield projects.
- Stage 2.2 dispatches four agents in parallel (pipeline-deploy, quality,
  developer, devsecops) for evidence-scan on brownfield, then runs interview
  and affirmation gates. On affirmation, content is promoted from
  `aidlc-docs/inception/practices-discovery/` to `.claude/rules/aidlc-team.md`
  and `.claude/rules/aidlc-project.md` — the cross-row
  promotion that makes this stage structurally distinct from every other stage.
- Stage 2.7 produces `unit-of-work.md`, which defines the units that drive
  the phased construction flow in the Construction phase.
- Stage 2.8 produces the execution plan that determines which Construction
  stages run for each unit and in what order. It reads `.claude/rules/aidlc-team.md`
  for the team's Way of Working (branching), Walking Skeleton stance, and
  Deployment sections.
- The phase boundary verification at Stage 2.8 validates Requirements to
  Stories to Architecture alignment.

**Scope-driven stage inclusion:**

| Scope            | Stages Included                                                |
|------------------|----------------------------------------------------------------|
| enterprise       | All 2.1--2.8                                                   |
| feature          | All 2.1--2.8                                                   |
| mvp              | 2.1 (if brownfield), 2.2, 2.3, 2.4, 2.5 (if UI), 2.6, 2.7, 2.8 |
| poc              | 2.1 (if brownfield), 2.3 (minimal)                             |
| bugfix           | 2.1 (always -- find the bug), 2.3 (minimal -- bug description) |
| refactor         | 2.1 (always -- understand current code), 2.3 (minimal)         |
| infra            | 2.2, 2.3 (infra requirements)                                  |
| security-patch   | 2.1 (find vulnerability context)                                |
| workshop         | 2.1--2.8                                                       |

---

## Stage Summary Table

| Stage | Name                   | Condition   | Lead Agent             | Support Agents                                       | Mode                             |
|-------|------------------------|-------------|------------------------|------------------------------------------------------|----------------------------------|
| 2.1   | Reverse Engineering    | CONDITIONAL | aidlc-developer-agent        | aidlc-architect-agent                                      | subagent (aidlc-developer-agent → aidlc-architect-agent, 2-step) |
| 2.2   | Practices Discovery    | CONDITIONAL | aidlc-pipeline-deploy-agent  | aidlc-quality-agent, aidlc-developer-agent, aidlc-devsecops-agent      | inline (parallel multi-Task on brownfield) |
| 2.3   | Requirements Analysis  | ALWAYS      | aidlc-product-agent          | --                                                   | inline                           |
| 2.4   | User Stories           | CONDITIONAL | aidlc-product-agent          | aidlc-design-agent                                         | inline                           |
| 2.5   | Refined Mockups        | CONDITIONAL | aidlc-design-agent           | aidlc-product-agent                                        | inline                           |
| 2.6   | Application Design     | CONDITIONAL | aidlc-architect-agent        | aidlc-aws-platform-agent, aidlc-design-agent               | inline                           |
| 2.7   | Units Generation       | ALWAYS      | aidlc-architect-agent        | aidlc-delivery-agent                                       | inline                           |
| 2.8   | Delivery Planning      | ALWAYS      | aidlc-delivery-agent         | aidlc-architect-agent                                      | inline                           |

---

## Stage 2.1: Reverse Engineering

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.1                                                                    |
| Condition        | CONDITIONAL -- brownfield detected; always rerun for freshness         |
| Lead Agent       | aidlc-developer-agent                                                        |
| Support Agents   | aidlc-architect-agent                                                        |
| Mode             | subagent (two-step: aidlc-developer-agent then aidlc-architect-agent)              |
| Completion Emoji | (uses stage-protocol.md completion template)                           |

### Purpose

Reverse Engineering performs a comprehensive analysis of the existing codebase
for brownfield projects. It uses a two-step subagent delegation pattern:
first, the aidlc-developer-agent scans the entire codebase; then, the aidlc-architect-agent
synthesizes the scan results into 9 structured artifacts. These artifacts
provide the technical foundation that all subsequent Inception and Construction
stages build upon.

**Always-rerun policy:** Reverse Engineering is always re-executed for
brownfield projects even when prior artifacts exist. This ensures the
artifacts reflect the current state of the codebase, not a stale snapshot.

### Inputs

- `aidlc-docs/aidlc-state.md` (project type confirmation)

### Steps

1. **Check Conditions** -- Read `aidlc-docs/aidlc-state.md` to confirm the
   project type is brownfield. If the project is not brownfield, skip this
   stage and update `aidlc-state.md` with skip reason.

2. **Developer Code Scan** -- Delegate to Task tool with the aidlc-developer-agent
   subagent (`subagent_type="aidlc-developer-agent"`). Include aidlc-developer-agent persona from
   `agents/aidlc-developer-agent.md` and knowledge from
   `.claude/knowledge/aidlc-developer-agent/` in the delegation prompt.
   Include workspace state from `aidlc-state.md` as context.

   The developer scans the entire codebase for:
   - All packages, modules, and their purposes
   - Build systems, configuration, and dependency relationships
   - External and internal APIs (endpoints, contracts, methods)
   - Frameworks, libraries, and their versions
   - Test directories, test frameworks, coverage configuration
   - Code quality indicators (linting, CI/CD, documentation)
   - Technical debt signals

   Developer returns structured scan results following the Developer Code Scan
   Template in `templates/re-artifacts.md`.

3. **Architect Synthesis** -- Delegate to Task tool with the aidlc-architect-agent
   subagent (`subagent_type="aidlc-architect-agent"`). Include aidlc-architect-agent persona from
   `agents/aidlc-architect-agent.md` and knowledge from
   `.claude/knowledge/aidlc-architect-agent/` in the delegation prompt. Pass
   the complete developer scan results as context. Include workspace state from
   `aidlc-state.md`.

   The architect synthesizes scan results into the 9 output artifacts (see
   Outputs below).

4. **Update State** -- Mark Reverse Engineering as `[x]` completed in
   `aidlc-docs/aidlc-state.md`. Update current stage and next stage.

5. **Present Completion & Request Approval** -- Display completion summary
   of all 9 artifacts produced. Standard approval gate: Approve (continue to
   Requirements Analysis) / Request Changes.

### Outputs

All 9 artifacts written to `aidlc-docs/inception/reverse-engineering/`:

| #  | File                             | Contents                                                    |
|----|----------------------------------|-------------------------------------------------------------|
| 1  | `business-overview.md`           | Business domain, purpose, key functionality                 |
| 2  | `architecture.md`                | System architecture, patterns, component relationships (with Mermaid diagrams). MUST include Interaction Diagrams section depicting how business transactions are implemented across components (sequence or flow diagrams). |
| 3  | `code-structure.md`              | Package/module organization, file classification, code patterns |
| 4  | `api-documentation.md`           | External and internal API surfaces, endpoints, contracts    |
| 5  | `component-inventory.md`         | Complete component list with responsibilities and dependencies |
| 6  | `technology-stack.md`            | Languages, frameworks, libraries with versions              |
| 7  | `dependencies.md`                | External dependencies, internal cross-package dependencies  |
| 8  | `code-quality-assessment.md`     | Test coverage, linting, CI/CD, documentation quality, tech debt |
| 9  | `reverse-engineering-timestamp.md` | When RE was performed (date, commit hash if available, scope of analysis) |

### Approval Gate

Standard 2-option gate: **Approve** (continue to Requirements Analysis) /
**Request Changes**.

### Notes

- **Always-rerun policy:** This stage is always re-executed for brownfield
  projects even when prior artifacts exist. This is a deliberate deviation from
  the upstream reference, documented in SKILL.md's "Deliberate Deviations"
  section.
- **Two-step subagent pattern:** The aidlc-developer-agent performs the raw code
  scan, then the aidlc-architect-agent synthesizes the scan into structured
  artifacts. This separation ensures the scan is thorough (developer
  perspective) and the synthesis is architecturally informed (architect
  perspective).
- For bugfix and refactor scopes, this stage always executes (even for what
  might be borderline greenfield) because understanding existing code is
  essential.
- For security-patch scope, this stage executes to find vulnerability context.
- The 9 artifacts produced here are consumed by Requirements Analysis (2.3),
  User Stories (2.4), Application Design (2.6), and Units Generation (2.7).
- The `architecture.md` artifact must include Interaction Diagrams showing how
  business transactions are implemented across components, using sequence or
  flow diagrams.

---

## Stage 2.2: Practices Discovery

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.2                                                                    |
| Condition        | CONDITIONAL -- always rerun for freshness on EXECUTE scopes            |
| Lead Agent       | aidlc-pipeline-deploy-agent                                                  |
| Support Agents   | aidlc-quality-agent, aidlc-developer-agent, aidlc-devsecops-agent                        |
| Mode             | inline (with parallel multi-Task dispatch on brownfield)               |
| Completion Emoji | (uses stage-protocol.md completion template)                           |

### Purpose

Practices Discovery is the only stage in AI-DLC that writes to both rows of
the two-axis configuration model. It discovers a team's branching strategy,
walking-skeleton stance, testing posture, deployment cadence, and code-style
rules from evidence (brownfield) or via AskUserQuestion using `org.md`
defaults (greenfield), drafts proposals at `aidlc-docs/inception/practices-discovery/`,
and at an affirmation gate **promotes** the affirmed content into team-authored
harness config: `.claude/rules/aidlc-team.md` and
`.claude/rules/aidlc-project.md`. The affirmation gate is
what makes the cross-row write legitimate -- without it the framework would
put words in the team's mouth in its own harness config.

### Inputs

- `aidlc-docs/aidlc-state.md` (project type)
- Brownfield only: reverse-engineering's 9 artifacts (business-overview,
  architecture, code-structure, api-documentation, component-inventory,
  technology-stack, dependencies, code-quality-assessment,
  reverse-engineering-timestamp)
- `.claude/rules/aidlc-org.md` (greenfield default suggestions)
- `.claude/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md` (lead-agent KB)

### Outputs

Four artifacts written to `aidlc-docs/inception/practices-discovery/`:

- `team-practices.md` -- descriptive, team-voice prose. Five sections matching
  `aidlc-team.md` headings: Way of Working, Walking Skeleton, Testing Posture,
  Deployment, Code Style.
- `discovered-rules.md` -- corrective, agent-facing. Two sections: Mandated
  (`ALWAYS …` rules) and Forbidden (`NEVER …` rules).
- `evidence.md` -- per-agent finding summary; freshness trail for re-runs.
- `practices-discovery-timestamp.md` -- run timestamp + commit hash.

On affirmation, content is promoted to:

- `.claude/rules/aidlc-team.md` -- section-replace via `replaceSection` (re-runs
  overwrite section content rather than accumulate).
- `.claude/rules/aidlc-project.md` -- append-under-heading
  via `appendUnderHeading` (rules accumulate; date stamps distinguish them).

### Steps

1. Check conditions: read `aidlc-state.md` to classify greenfield vs brownfield.
   Brownfield runs Step 2; greenfield skips it.
2. **Discover (brownfield only)** -- the conductor issues four parallel `Task`
   invocations in a single assistant message: aidlc-pipeline-deploy-agent
   (branching), aidlc-quality-agent (testing posture), aidlc-developer-agent (code patterns),
   aidlc-devsecops-agent (CI/security). Each agent reads its own KB, scans evidence,
   returns a finding. The conductor collects all four findings before proceeding.
3. **Interview (always)** -- AskUserQuestion for evidence-gaps. Brownfield: ask
   only the gaps. Greenfield: ask all five practice areas with `org.md` defaults
   as suggested-answer text. Re-run pre-fills from prior `team.md` content.
4. Consolidate -- write four artifacts; emit `PRACTICES_DISCOVERED`.
5. Affirmation gate -- AskUserQuestion presents both drafts. Options:
   Approve / Edit-then-Approve / Reject-and-rewrite-from-scratch.
6. Promote (on Approve) -- section-replace the five practice sections in
   `.claude/rules/aidlc-team.md`; append rules under `## Mandated` and
   `## Forbidden` in `.claude/rules/aidlc-project.md` with date stamps.
   Atomicity: write `aidlc-project.md` first, then `aidlc-team.md`. On failure,
   emit `PRACTICES_OVERRIDE` and abort without recording PRACTICES_AFFIRMED.
7. Emit `PRACTICES_AFFIRMED`; update state checkbox; update
   `Practices Affirmed Timestamp` (v7 state template field, milestone 6).

### Notes

- The `replaceSection` helper in `.claude/tools/aidlc-lib.ts` was added in milestone 8
  specifically to support the team.md cross-row promotion (the existing
  `appendUnderHeading` accumulates duplicates across re-runs).
- `aidlc-org.md` and `aidlc-team.md` share one Title Case heading set
  (`## Way of Working`, `## Walking Skeleton`, `## Testing Posture`,
  `## Deployment`, `## Code Style`). The stage reads each section from
  `org.md` via `extractMarkdownSection` with the matching Title Case
  heading and section-replaces the same heading in `team.md`.
- Test-run mode: skip AskUserQuestion calls; use `org.md` defaults verbatim
  for greenfield, evidence-only findings for brownfield.

---

## Stage 2.3: Requirements Analysis

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.3                                                                    |
| Condition        | ALWAYS -- depth adapts to complexity                                   |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | (none)                                                                 |
| Mode             | inline                                                                 |
| Completion Emoji | :mag:                                                                  |

### Purpose

Requirements Analysis transforms the user's intent and any reverse-engineered
codebase understanding into formal, structured requirements. It assesses the
request for clarity, type, scope, and complexity; determines the appropriate
depth; extracts what is already known; runs a completeness analysis across six
dimensions; generates clarifying questions; and produces a formal requirements
document.

This stage always executes but adapts its depth based on project complexity:
minimal for clear/narrow scope, standard for moderate scope, comprehensive for
large scope with significant unknowns.

### Inputs

- Reverse Engineering artifacts from Stage 2.1
  (`aidlc-docs/inception/reverse-engineering/`), if brownfield
- User's project description from `aidlc-docs/audit.md`

### Steps

1. **Load Agent Personas** -- Load aidlc-product-agent persona from
   `agents/aidlc-product-agent.md` and knowledge from
   `.claude/knowledge/aidlc-product-agent/`.

2. **Load Prior Context** -- If brownfield: read RE artifacts from
   `aidlc-docs/inception/reverse-engineering/`. Read user's project
   description from `aidlc-docs/audit.md`.

3. **Analyze User Request** -- Assess the request for:
   - **Clarity**: How well-defined is the request?
   - **Type**: New feature, enhancement, refactoring, bug fix, migration
   - **Scope**: Single component, multi-component, system-wide
   - **Complexity**: Simple, standard, complex

4. **Determine Depth** -- Based on complexity assessment:
   - **Minimal**: Clear request, narrow scope, well-understood domain
   - **Standard**: Moderate scope, some unknowns, multiple stakeholders
   - **Comprehensive**: Large scope, significant unknowns, complex domain

5. **Assess Current Requirements** -- Extract and organize what is already
   known from the user's input: explicit functional requirements, implied
   non-functional requirements, constraints and assumptions, business context
   and goals.

6. **Completeness Analysis** -- Evaluate coverage across six dimensions:
   1. Functional requirements -- core behaviors, features, use cases
   2. Non-functional requirements -- performance, security, scalability,
      reliability
   3. User scenarios -- user workflows, edge cases, error scenarios
   4. Business context -- goals, success metrics, stakeholders, constraints
   5. Technical context -- integration points, platform requirements,
      technology constraints
   6. Quality attributes -- maintainability, testability, accessibility,
      usability

   Identify gaps in each dimension.

7. **Generate Clarifying Questions** -- PROACTIVE: always generate clarifying
   questions unless requirements are exceptionally clear and complete across
   all six dimensions. Create
   `aidlc-docs/inception/requirements-analysis/requirements-analysis-questions.md`
   using the `[Answer]:` tag format. Include context-appropriate questions with
   A-E options. Every question must end with `X. Other (please specify)` as
   the final option. All `[Answer]:` tags left blank.

   Offer the tri-mode question flow: Guide Me / Edit File / Chat.

8. **Collect and Analyze Answers** -- Read the questions file, confirm all
   `[Answer]:` tags are filled. If any are blank, present unanswered questions
   via AskUserQuestion and write answers back. Do NOT proceed with partial
   answers. Run:
   - MANDATORY ambiguity detection: scan all responses for vague language
     ("mix of", "not sure", "depends", "probably", "maybe")
   - Contradiction check between answers
   - Missing detail identification

9. **Follow-Up Questions** -- If ANY ambiguity, vagueness, or contradictions
   found, create follow-up questions targeting the specific issues. Resolve
   all ambiguities before proceeding. "When in doubt, ask."

10. **Generate Requirements** -- Create
    `aidlc-docs/inception/requirements-analysis/requirements.md` containing:
    - Intent analysis -- what the user is trying to achieve (goals, not just
      features)
    - Functional requirements -- organized by feature area or domain
    - Non-functional requirements -- performance, security, scalability targets
    - Constraints -- technical, business, organizational
    - Assumptions -- documented with rationale
    - Out of scope -- explicitly excluded items
    - Open questions -- remaining uncertainties for later stages

11. **Update State** -- Mark Requirements Analysis as `[x]` completed in
    `aidlc-docs/aidlc-state.md`. Update current and next stage.

12. **Present Completion & Request Approval** -- Display completion message
    with :mag: emoji and review path. The approval gate has two variants:

    **If User Stories is set to SKIP in the execution state:** 3-option gate:
    Approve / Request Changes / Add User Stories (include the currently
    skipped User Stories stage). If "Add User Stories" is selected, update
    `aidlc-state.md` to mark User Stories as pending execution.

    **If User Stories is NOT set to SKIP:** Standard 2-option gate: Approve /
    Request Changes.

### Outputs

All artifacts written to `aidlc-docs/inception/requirements-analysis/`:

| File                                 | Contents                                                |
|--------------------------------------|---------------------------------------------------------|
| `requirements.md`                    | Formal requirements: intent analysis, functional/non-functional requirements, constraints, assumptions, out-of-scope, open questions |
| `requirements-analysis-questions.md` | Clarifying questions with `[Answer]:` tags (input artifact) |

### Approval Gate

Conditional gate format:

- **If User Stories is skipped:** 3-option gate -- **Approve** / **Request
  Changes** / **Add User Stories**
- **If User Stories is not skipped:** Standard 2-option gate -- **Approve** /
  **Request Changes**

### Notes

- This is the most detailed question-and-answer stage in the workflow. It
  enforces mandatory ambiguity detection and will not proceed with partial or
  vague answers.
- Depth scales with complexity: minimal for bugfix/poc, standard for feature,
  comprehensive for enterprise.
- For bugfix scope, this stage captures the bug description at minimal depth.
- For infra scope, this stage captures infrastructure requirements.
- The requirements document produced here is consumed by User Stories (2.4),
  Refined Mockups (2.5), Application Design (2.6), Units Generation (2.7),
  and Delivery Planning (2.8).

---

## Stage 2.4: User Stories

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.4                                                                    |
| Condition        | CONDITIONAL -- execute for user-facing features, multiple personas, complex business logic, or cross-team work |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | aidlc-design-agent                                                           |
| Mode             | inline                                                                 |
| Completion Emoji | :books:                                                                |

### Purpose

User Stories translates formal requirements into user-centered stories that
define the "who, what, and why" of each feature. The stage follows a two-part
structure: PART 1 creates a story plan with clarifying questions, and PART 2
generates the actual stories and personas. The plan and stories are presented
together at the completion gate for combined review.

The aidlc-design-agent provides supporting perspective on user experience. This is a
deliberate addition not in the upstream reference, documented in SKILL.md's
"Deliberate Deviations" section.

### Inputs

- `aidlc-docs/inception/requirements-analysis/requirements.md`
- RE artifacts from Stage 2.1 (`aidlc-docs/inception/reverse-engineering/`),
  if brownfield

### Steps

1. **Load Agent Personas** -- Load aidlc-product-agent persona from
   `agents/aidlc-product-agent.md` and knowledge from
   `.claude/knowledge/aidlc-product-agent/`. Load aidlc-design-agent persona from
   `agents/aidlc-design-agent.md` and knowledge from
   `.claude/knowledge/aidlc-design-agent/` for supporting perspective on user
   experience.

2. **Validate User Stories Are Needed** -- Assess whether user stories add
   value for this project:
   - **Execute if**: user-facing features, multiple user personas, complex
     business logic, cross-team coordination needed
   - **Skip if**: pure refactoring, isolated bug fixes, infrastructure-only,
     developer tooling

   Create `aidlc-docs/inception/user-stories/user-stories-assessment.md`
   documenting: decision (Execute or Skip), rationale, factors considered,
   key value areas (if executing) or alternative coverage (if skipping).

   If skipping, update `aidlc-state.md` with skip reason and proceed to next
   stage.

3. **Load Prior Context** -- Read
   `aidlc-docs/inception/requirements-analysis/requirements.md`. If brownfield,
   read relevant RE artifacts from
   `aidlc-docs/inception/reverse-engineering/`.

**PART 1: Planning**

4. **Create Story Plan with Questions** -- Create
   `aidlc-docs/inception/user-stories/user-stories-questions.md` containing:
   - Persona development approach (who are the users, what are their goals)
   - Story format using INVEST criteria (Independent, Negotiable, Valuable,
     Estimable, Small, Testable)
   - Story prioritization using MoSCoW priority (Must Have / Should Have /
     Could Have / Won't Have). The MVP boundary is formally decided during
     Delivery Planning; story priorities inform that decision.
   - Breakdown approach options (by feature, persona, workflow, domain area,
     or epic)
   - Embedded questions using `[Answer]:` tag format for user input on
     personas and story granularity

5. **Collect Answers** -- Collect answers following stage-protocol.md section 3
   question flow (offer interaction mode choice, collect answers, write back to
   file).

6. **Analyze Answers** -- MANDATORY ambiguity analysis: scan all responses for
   vague language ("mix of", "not sure", "depends", "probably"). Check for
   contradictions. Identify missing details. Create follow-up questions if ANY
   ambiguity found.

7. **Present Plan and Generate** -- Present the story plan summary (persona
   count, story count, breakdown approach) inline. Then immediately proceed to
   PART 2. The user reviews and approves the combined output (plan + generated
   stories) at the completion gate.

   If the user interjects with feedback before generation completes, treat it
   as a revision request and update the plan before continuing generation.

**PART 2: Generation**

8. **Execute Plan -- Generate Stories and Personas** -- Based on the approved
   plan, generate:

   `aidlc-docs/inception/user-stories/personas.md`:
   - User persona definitions (name, role, goals, pain points, context)
   - Persona relationships and priority ranking

   `aidlc-docs/inception/user-stories/stories.md`:
   - User stories in standard format: "As a [persona], I want [goal], so that
     [benefit]"
   - Acceptance criteria for each story
   - Story priority (Must Have / Should Have / Could Have / Won't Have)
   - Story dependencies and relationships
   - INVEST compliance notes

9. **Update State** -- Mark User Stories as `[x]` completed in
   `aidlc-docs/aidlc-state.md`. Update current and next stage.

10. **Present Completion & Request Approval** -- Display completion message
    with :books: emoji, summary of personas and stories produced, and review
    path. Standard 2-option approval gate: Approve (continue to next stage) /
    Request Changes.

### Outputs

All artifacts written to `aidlc-docs/inception/user-stories/`:

| File                           | Contents                                                     |
|--------------------------------|--------------------------------------------------------------|
| `stories.md`                   | User stories with acceptance criteria, priority, dependencies, INVEST notes |
| `personas.md`                  | User persona definitions, relationships, priority ranking    |
| `user-stories-assessment.md`   | Execute/skip decision with rationale and factors considered   |
| `user-stories-questions.md`    | Story plan with clarifying questions using `[Answer]:` tags (input artifact) |

### Approval Gate

Standard 2-option gate: **Approve** (continue to next stage) / **Request
Changes**.

### Notes

- Skip conditions: pure refactoring, isolated bug fixes, infrastructure-only,
  developer tooling.
- The two-part structure (plan then generate) allows the user to influence the
  story decomposition approach before stories are written.
- User story priorities (MoSCoW) inform but do not determine the MVP boundary.
  The formal MVP boundary is set during Delivery Planning (Stage 2.8).
- The `user-stories-assessment.md` artifact is always produced, even when the
  stage is skipped, to document the rationale.
- Stories produced here are consumed by Refined Mockups (2.5), Application
  Design (2.6), Units Generation (2.7), and Delivery Planning (2.8).
- The aidlc-design-agent support is a deliberate addition for UX-informed
  development, noted in SKILL.md's Deliberate Deviations section.

---

## Stage 2.5: Refined Mockups & UX Design

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.5                                                                    |
| Condition        | CONDITIONAL -- skip for non-UI, API-only, or infrastructure-only initiatives |
| Lead Agent       | aidlc-design-agent                                                           |
| Support Agents   | aidlc-product-agent (validates against stories)                              |
| Mode             | inline                                                                 |
| Completion Emoji | :art:                                                                  |

### Purpose

Refined Mockups evolves the rough concept wireframes from Ideation Stage 1.6
into mid-to-high fidelity mockups informed by formal requirements and user
stories. It produces detailed interaction specifications, design system
mappings, responsive behavior definitions, and accessibility compliance
checklists.

For non-UI initiatives (API-only, backend), the stage refines interaction
diagrams into an API developer experience specification.

This stage is typically skipped if Stage 1.6 (Rough Mockups) was also skipped.

### Inputs

- Rough mockups from Stage 1.6 (`aidlc-docs/ideation/rough-mockups/`), if
  exists
- User stories from Stage 2.4 (`aidlc-docs/inception/user-stories/`)
- Requirements from Stage 2.3
  (`aidlc-docs/inception/requirements-analysis/`)

### Steps

1. **Load Agent Personas** -- Load aidlc-design-agent persona from
   `agents/aidlc-design-agent.md` and knowledge from
   `.claude/knowledge/aidlc-design-agent/`.

2. **Load Prior Context** -- Read rough mockups from
   `aidlc-docs/ideation/rough-mockups/` (if exists). Read user stories from
   `aidlc-docs/inception/user-stories/`. Read requirements from
   `aidlc-docs/inception/requirements-analysis/`.

3. **Generate Clarifying Questions** -- Create
   `aidlc-docs/inception/refined-mockups/refined-mockups-questions.md` with
   questions covering:
   - How each user story should be represented in the UI
   - Interaction patterns needed (modals, inline edits, wizards, progressive
     disclosure)
   - States each screen must handle (loading, empty, error, success, partial)
   - Alignment with existing design system / component library
   - Accessibility requirements (WCAG level)
   - Responsive breakpoints needed
   - For APIs: developer experience requirements

   Follows stage-protocol.md question flow.

4. **Collect and Analyze Answers** -- Validate design decisions against user
   stories and requirements for consistency.

5. **Generate Artifacts** -- Create mid-to-high fidelity mockups (per user
   story/screen), interaction specification document, design system mapping,
   responsive behavior specification, and accessibility compliance checklist.
   For non-UI initiatives, create API developer experience specification.

6. **Update State** -- Mark 2.5 Refined Mockups as `[x]` completed in
   `aidlc-docs/aidlc-state.md`.

7. **Present Completion & Request Approval** -- Display completion message
   with :art: emoji. Standard approval gate (Approve / Request Changes).

### Outputs

All artifacts written to `aidlc-docs/inception/refined-mockups/`:

| File                            | Contents                                                    |
|---------------------------------|-------------------------------------------------------------|
| `mockups.md`                    | Mid-to-high fidelity mockups per user story/screen          |
| `interaction-spec.md`           | Interaction patterns, state management, transitions          |
| `design-system-mapping.md`      | Component mapping to design system / component library       |
| `accessibility-checklist.md`    | WCAG compliance checklist and requirements                   |
| `refined-mockups-questions.md`  | Clarifying questions with `[Answer]:` tags (input artifact)  |

### Approval Gate

Standard 2-option gate: **Approve** / **Request Changes**.

### Notes

- Skip condition: non-UI, API-only, or infrastructure-only initiatives. Also
  typically skipped if Stage 1.6 (Rough Mockups) was skipped.
- For mvp scope, this stage executes only if the project has UI.
- The mockups produced here feed into Application Design (2.6) and ultimately
  into Construction's Code Generation (3.5) for UI components.
- The accessibility checklist provides testable criteria that feed into Build
  and Test (3.6).

---

## Stage 2.6: Application Design

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.6                                                                    |
| Condition        | CONDITIONAL -- execute when new components or services are needed; skip for modifications to existing components only |
| Lead Agent       | aidlc-architect-agent                                                        |
| Support Agents   | aidlc-aws-platform-agent, aidlc-design-agent                                |
| Mode             | inline                                                                 |
| Completion Emoji | :building_construction:                                                |

### Purpose

Application Design defines the system architecture for the project: component
boundaries, interfaces, service definitions, communication patterns, dependency
relationships, and architecture decision records (ADRs). It translates
requirements and user stories into a concrete technical design that guides
Construction.

The aidlc-aws-platform-agent provides supporting perspective on AWS service mapping.
The aidlc-design-agent support is also noted in SKILL.md's Deliberate Deviations
section for UX-informed architecture.

The `decisions.md` artifact (ADRs) is a deliberate addition not present in the
upstream reference, documented in SKILL.md's "Deliberate Deviations" section.

### Inputs

- `aidlc-docs/inception/requirements-analysis/requirements.md`
- `aidlc-docs/inception/user-stories/stories.md` (if produced)
- RE artifacts from Stage 2.1 (especially `architecture.md`,
  `component-inventory.md`, `dependencies.md`), if brownfield

### Steps

1. **Load Agent Personas** -- Load aidlc-architect-agent persona from
   `agents/aidlc-architect-agent.md` and knowledge from
   `.claude/knowledge/aidlc-architect-agent/`. Load aidlc-aws-platform-agent persona
   from `agents/aidlc-aws-platform-agent.md` and knowledge from
   `.claude/knowledge/aidlc-aws-platform-agent/` for AWS service mapping.

2. **Load Prior Context** -- Read requirements, user stories (if produced),
   and RE artifacts (if brownfield, especially architecture.md,
   component-inventory.md, dependencies.md). Scope context comes from
   `aidlc-docs/aidlc-state.md`.

3. **Create Design Plan with Questions** -- Create
   `aidlc-docs/inception/application-design/application-design-questions.md`
   with context-appropriate questions using `[Answer]:` tag format covering:
   - Component boundary decisions
   - Architectural style preferences (if not already decided)
   - Service communication patterns (sync vs. async, REST vs. gRPC vs.
     events)
   - Data ownership and storage strategy
   - Integration approach with existing components (brownfield)
   - UI component structure (if user-facing, informed by UX designer
     perspective)

4. **Collect and Analyze Answers** -- Collect answers following
   stage-protocol.md section 3 question flow. MANDATORY ambiguity analysis:
   scan for vague language, contradictions, missing details. Create follow-up
   questions if ANY ambiguity found. Resolve all ambiguities before proceeding.

5. **Generate Design Artifacts** -- Create 5 design artifacts (see Outputs
   below).

6. **Update State** -- Mark Application Design as `[x]` completed in
   `aidlc-docs/aidlc-state.md`. Update current and next stage.

7. **Present Completion & Request Approval** -- Display completion message
   with :building_construction: emoji, summary of design artifacts, key
   architectural decisions highlighted, and review path. 3-option approval
   gate: Approve / Request Changes / Add Units Generation (if it was skipped
   in execution plan).

### Outputs

All 5 artifacts written to `aidlc-docs/inception/application-design/`:

| File                              | Contents                                                  |
|-----------------------------------|-----------------------------------------------------------|
| `components.md`                   | Component names, purposes, responsibilities, interfaces, boundaries, ownership |
| `component-methods.md`            | Method signatures for each component's public interface, input/output types, error handling approach (detailed business rules belong in Functional Design) |
| `services.md`                     | Service definitions, responsibilities, orchestration patterns (choreography vs. orchestration), communication contracts, lifecycle and scaling characteristics |
| `component-dependency.md`         | Dependency matrix, communication patterns (sync/async/event-driven), data flow between components, shared resource identification |
| `decisions.md`                    | Architecture Decision Records (ADRs) with Context, Decision, Consequences, Alternatives Considered; trade-off analysis; reversibility assessment |

Additionally, a questions file is created as input:

| File                                      | Contents                                        |
|-------------------------------------------|-------------------------------------------------|
| `application-design-questions.md`         | Design questions with `[Answer]:` tags          |

### Approval Gate

Special 3-option gate:

- **Approve** -- Continue to next stage
- **Request Changes** -- Provide revision feedback
- **Add Units Generation** -- Include the currently skipped Units Generation
  stage (if it was skipped in the execution plan)

### Notes

- Skip condition: changes are modifications to existing components only, with
  no new components or services needed.
- The `decisions.md` artifact (ADRs) is a deliberate deviation from the
  upstream reference. Each ADR includes Context, Decision, Consequences, and
  Alternatives Considered, plus trade-off analysis and reversibility assessment.
- The design artifacts produced here are the primary input for Units Generation
  (2.7) and directly inform Construction stages (Functional Design 3.1, Code
  Generation 3.5).
- For brownfield projects, the design must account for integration with
  existing components documented in the RE artifacts.

---

## Stage 2.7: Units Generation

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.7                                                                    |
| Condition        | ALWAYS -- produces the dependency DAG that Stage 2.8 consumes for Bolt sequencing; travels with 2.8 in the compiled scope grid |
| Lead Agent       | aidlc-architect-agent                                                        |
| Support Agents   | aidlc-delivery-agent                                                         |
| Mode             | inline                                                                 |
| Completion Emoji | :wrench:                                                               |

### Purpose

Units Generation decomposes the application design into discrete Units of
Work that drive the phased construction flow in the Construction phase. Each
Unit represents an independently implementable piece of the system (a
service, module, or deployable component). The stage produces the
`unit-of-work.md` file that Construction uses to determine what to build,
the dependency DAG (`unit-of-work-dependency.md`) that Stage 2.8 consumes
for Bolt sequencing, and the story map that ensures every user story is
assigned to a Unit.

**Stage 2.7 produces the dependency DAG (topology). Stage 2.8 chooses the
economic path through it (the Bolt sequence).** 2.7 MUST NOT recommend an
implementation order or identify a critical path — those are 2.8's
economic-sequencing decisions.

This is a critical bridge stage between Inception's design work and
Construction's implementation work. The unit definitions, dependencies, and
story mappings produced here directly control how the Construction phase
executes.

The stage follows a two-part structure: PART 1 creates a decomposition plan
with clarifying questions and gets plan approval, and PART 2 generates the
actual unit artifacts.

### Inputs

- All design artifacts from Stage 2.6
  (`aidlc-docs/inception/application-design/`: components.md,
  component-methods.md, services.md, component-dependency.md, decisions.md)
- `aidlc-docs/inception/requirements-analysis/requirements.md`
- `aidlc-docs/inception/user-stories/stories.md` (if produced)

### Steps

**PART 1: Planning**

1. **Load Agent Personas** -- Load aidlc-architect-agent persona from
   `agents/aidlc-architect-agent.md` and knowledge from
   `.claude/knowledge/aidlc-architect-agent/`. Load aidlc-delivery-agent persona
   from `agents/aidlc-delivery-agent.md` and knowledge from
   `.claude/knowledge/aidlc-delivery-agent/` for feasibility validation and
   prioritization.

2. **Load Prior Context** -- Read all artifacts from
   `aidlc-docs/inception/application-design/` (all 5 files). Read
   requirements. Read user stories (if produced). Scope context comes from
   `aidlc-docs/aidlc-state.md`.

3. **Create Decomposition Plan with Questions** -- Create
   `aidlc-docs/inception/units-generation/units-generation-questions.md` with
   questions using `[Answer]:` tag format covering:
   - Unit boundary strategy (by service, by feature, by domain, by deployment
     target)
   - Unit granularity preference (coarse-grained vs. fine-grained)
   - Dependency ordering preferences (strict topological only, or allow
     parallelism between independent Units)
   - Integration points and contracts between Units (APIs, shared data, events)
   - Deployment model (monolithic deploy, independent deploy, hybrid)

   NOTE: Do NOT ask about implementation order priorities (value-first,
   risk-first, walking-skeleton-first). Those are economic-sequencing
   decisions that belong to Stage 2.8 Delivery Planning.

4. **Collect and Analyze Answers** -- Collect answers following
   stage-protocol.md section 3 question flow. MANDATORY ambiguity analysis:
   scan for vague language, contradictions, missing details. Create follow-up
   questions if ANY ambiguity found. Resolve all ambiguities before proceeding.

5. **Get Plan Approval** -- Present the decomposition plan to the user via
   AskUserQuestion: summarize the approach (unit boundary strategy, estimated
   unit count, dependency structure). Options: Approve Plan / Revise Plan.

**PART 2: Generation**

6. **Execute Plan -- Generate Unit Artifacts** -- Based on the approved plan,
   generate the 3 output artifacts (see Outputs below).

7. **Update State** -- Mark Units Generation as `[x]` completed in
   `aidlc-docs/aidlc-state.md`. Update current and next stage. Record unit
   list for the Construction phase phased construction flow.

8. **Present Completion & Request Approval** -- Display completion message
   with :wrench: emoji, summary of units defined, dependencies mapped, stories
   assigned, and review path. Standard 2-option approval gate: Approve
   (continue to Construction phase) / Request Changes.

### Outputs

All 3 artifacts written to `aidlc-docs/inception/units-generation/`:

| File                            | Contents                                                    |
|---------------------------------|-------------------------------------------------------------|
| `unit-of-work.md`               | Unit definitions (name, description, boundaries), responsibilities, deployment model per Unit (standalone/shared/embedded), relative complexity estimate (S/M/L/XL), implementation notes and constraints |
| `unit-of-work-dependency.md`    | Dependency DAG between Units (directed edges, cycle-free), integration points (APIs/shared data/events), parallel development opportunities (sets of Units with no dependency between them). Topology only — economic path-choice (recommended order, critical path) is 2.8's job |
| `unit-of-work-story-map.md`     | Each user story mapped to implementing Unit(s), cross-cutting stories spanning multiple Units, story implementation order within each Unit, coverage verification (every story assigned, every Unit has stories) |

Additionally, a questions file is created as input:

| File                                  | Contents                                          |
|---------------------------------------|---------------------------------------------------|
| `units-generation-questions.md`       | Decomposition questions with `[Answer]:` tags     |

### Approval Gate

Standard 2-option gate: **Approve** (continue to Construction phase) /
**Request Changes**.

### Notes

- **This stage's output drives Construction.** The `unit-of-work.md` file
  defines the Units that the Construction phase iterates over in its per-Unit
  loop. Each Unit goes through the applicable Construction stages (Functional
  Design, NFR Requirements, NFR Design, Infrastructure Design, Code
  Generation) before the next Unit begins.
- **2.7 is ALWAYS when in scope.** In the compiled scope grid, 2.7 and 2.8 travel
  together (both EXECUTE or both SKIP per scope). There is no single-unit
  skip condition at this stage — single-Unit flows still produce a trivial
  DAG.
- The two-part structure (plan then generate) allows the user to approve the
  decomposition strategy before Units are defined. Step 5 has an intermediate
  approval gate (Approve Plan / Revise Plan) separate from the final
  completion gate.
- The dependency DAG feeds 2.8's economic Bolt sequencing. 2.8 chooses a
  path through the DAG weighted by risk, value, and learning.
- The story map provides traceability: every user story must be assigned to at
  least one Unit, and every Unit must have at least one story.
- The aidlc-delivery-agent provides feasibility validation and prioritization input,
  ensuring the decomposition is practical from a delivery perspective.

---

## Stage 2.8: Delivery Planning

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Inception                                                              |
| Stage #          | 2.8                                                                    |
| Condition        | ALWAYS -- capstone Inception stage                                     |
| Lead Agent       | aidlc-delivery-agent                                                         |
| Support Agents   | aidlc-architect-agent (validates build order against architecture dependencies) |
| Mode             | inline                                                                 |
| Completion Emoji | :calendar:                                                             |

### Purpose

Delivery Planning is the capstone of the Inception phase. It plans the Bolt
sequence — the order in which Units of Work produced by Stage 2.7 are
executed through Construction. Where Stage 2.7 is analytical (the dependency
DAG), Stage 2.8 is economic: it chooses a path through the DAG weighted by
risk, value, team capacity, and learning.

Per the canonical Glossary in `stage-protocol.md`, a **Bolt** is
"a deployable unit of work within Construction — one pass through stages
3.1–3.5." A Bolt is one Construction pass over one or more Units of
Work, distinct from an MMF or a sprint. (Stages 3.6 build-and-test and 3.7
ci-pipeline run once at end across all Bolts, not per-Bolt.)

Economic value cannot be derived from the DAG — AI agents can topologically
sort, but they cannot decide which Bolt validates the market hypothesis
fastest or which surfaces the scariest unknown before commitments compound.
That is a human value judgment captured in this stage.

This stage also runs the phase boundary verification check that validates
the integrity of all Inception artifacts before transitioning to
Construction.

**Important distinction:** This stage plans Bolt sequencing. It does NOT
decide which AI-DLC stages to run or at what depth -- that is handled by the
`/aidlc` skill's scope selection.

### Inputs

All Inception phase artifacts:

- Requirements from Stage 2.3 (`aidlc-docs/inception/requirements-analysis/`)
- User stories from Stage 2.4 (`aidlc-docs/inception/user-stories/`)
- Application design from Stage 2.6
  (`aidlc-docs/inception/application-design/`)
- Units from Stage 2.7 (`aidlc-docs/inception/units-generation/`)
- Team formation from Stage 1.5
  (`aidlc-docs/ideation/team-formation/`), if exists

### Steps

1. **Load Agent Personas** -- Load aidlc-delivery-agent persona from
   `agents/aidlc-delivery-agent.md` and knowledge from
   `.claude/knowledge/aidlc-delivery-agent/`. Load aidlc-architect-agent for build
   order validation.

2. **Load Prior Context** -- Read all Inception phase artifacts: requirements,
   user stories, application design, units, and team formation (if exists).

3. **Generate Clarifying Questions** -- Create
   `aidlc-docs/inception/delivery-planning/delivery-planning-questions.md`
   with questions covering:
   - Sequencing heuristic: risk-first, value-first, walking-skeleton-first,
     or hybrid
   - WSJF (Weighted Shortest Job First) scoring model and weightings if used
   - The first Bolt: walking skeleton (Cockburn) or confidence-building
     slice that proves the approach before scaling
   - Bundling of Units of Work into Bolts
   - Definition of Done for each Bolt
   - Confidence hypothesis per Bolt — what will shipping it prove
   - Mob-to-Bolt assignment (references teams from 1.5 when available;
     AI-only when it did not run)
   - External dependencies (APIs, data, approvals) that gate specific Bolts
   - Key risk items to tackle earliest

   Follows stage-protocol.md question flow.

4. **Collect and Analyze Answers** -- Validate that the chosen Bolt
   sequence respects 2.7's dependency DAG (with aidlc-architect-agent input).
   Flag any deviation from topological order so it can be justified in the
   rationale artifact.

5. **Generate Artifacts** -- Create four artifacts in
   `aidlc-docs/inception/delivery-planning/`:
   - `bolt-plan.md` — the ordered sequence of Bolts; per-Bolt Units of
     Work, walking-skeleton marker, Definition of Done, confidence
     hypothesis, expected demo.
   - `team-allocation.md` — Bolt-to-mob assignments; Program Board analog
     when team count > 1.
   - `risk-and-sequencing-rationale.md` — the why behind the Bolt order:
     WSJF score, risk-first argument, walking-skeleton-first argument, or
     value-first argument.
   - `external-dependency-map.md` — gated items mapped to consuming Bolts
     (lightweight or empty when fully AI-contained).

6. **Phase Boundary Verification** -- Run Inception-to-Construction
   verification check:
   - Requirements to Stories to Architecture alignment
   - All stories trace to requirements
   - Architecture covers all stories
   - Write results to `aidlc-docs/verification/phase-check-inception.md`

7. **Update State** -- Mark 2.8 Delivery Planning as `[x]` completed in
   `aidlc-docs/aidlc-state.md`. Update Lifecycle Phase to CONSTRUCTION.

8. **Present Completion & Request Approval** -- Display completion message
   with :calendar: emoji. Approval gate: Approve (proceed to Construction) /
   Request Changes. The user can override stage inclusion/exclusion at this
   gate.

### Outputs

All artifacts written to `aidlc-docs/inception/delivery-planning/`:

| File                                  | Contents                                                    |
|---------------------------------------|-------------------------------------------------------------|
| `bolt-plan.md`                        | Ordered Bolt sequence; per-Bolt Units of Work, walking-skeleton marker, Definition of Done, confidence hypothesis, expected demo |
| `team-allocation.md`                  | Bolt-to-mob assignment; Program Board analog when team count > 1; AI-only assignment when 1.5 did not run |
| `risk-and-sequencing-rationale.md`    | WSJF / risk-first / walking-skeleton-first / value-first justification for the Bolt ordering |
| `external-dependency-map.md`          | Gated items (external APIs, data availability, approval lead times, external-team hand-offs) mapped to consuming Bolts |
| `delivery-planning-questions.md`      | Clarifying questions with `[Answer]:` tags (input artifact) |

Phase boundary verification output:

| File                                            | Contents                                    |
|-------------------------------------------------|---------------------------------------------|
| `aidlc-docs/verification/phase-check-inception.md` | Inception-to-Construction traceability check results |

### Approval Gate

Standard 2-option gate: **Approve** (proceed to Construction) / **Request
Changes**. The user can override stage inclusion/exclusion at this gate.

### Notes

- **Phase boundary stage.** This is the second of three phase boundary stages
  (after 1.7 and before 3.7). The verification check validates
  Requirements-to-Stories-to-Architecture alignment.
- **Economic vs topological sequencing.** Stage 2.7 produces the dependency
  DAG (topological order falls out as descriptive geometry). Stage 2.8
  chooses a path through that DAG weighted by human value judgment.
  Bolt order may deviate from topological order when risk-first or
  walking-skeleton-first arguments justify it — the deviation is captured
  in `risk-and-sequencing-rationale.md`.
- **Bolt ≠ sprint ≠ MMF.** Per the canonical Glossary, a Bolt is one pass
  through Construction stages 3.1–3.5 (3.6 Build and Test and 3.7 CI Pipeline
  run once after all Bolts). Sequencing heuristics (walking skeleton, WSJF)
  apply within Bolts; they do not redefine what a Bolt is.
- **Deliberate deviation from upstream.** The upstream reference calls this
  stage "Workflow Planning" and treats it as a pure stage selector. This
  implementation (renamed to "Delivery Planning") adds Bolt sequencing,
  team allocation, and risk rationale.
- The bolt plan defines a confidence-building sequence. Each Bolt has
  defined Units of Work, a Definition of Done, and a confidence hypothesis.
- The aidlc-architect-agent validates that the proposed Bolt sequence respects
  dependencies defined in the component-dependency and
  unit-of-work-dependency artifacts.
- Team allocation draws from the Team Formation artifacts (Stage 1.5) if
  they exist; when 1.5 is SKIP (mvp, workshop), all Bolts are executed by
  aidlc-developer-agent (AI).

---

## Phase Summary

### Key Outputs

The Inception phase produces the following key outputs that carry forward into
Construction and Operation:

1. **Reverse Engineering Artifacts** (2.1) -- 9 artifacts documenting the
   existing codebase: business overview, architecture, code structure, API
   documentation, component inventory, technology stack, dependencies, code
   quality assessment, and timestamp. (Brownfield projects only.)
2. **Requirements Document** (2.3) -- Formal requirements: functional,
   non-functional, constraints, assumptions, out-of-scope, open questions.
3. **User Stories and Personas** (2.4) -- User stories with acceptance
   criteria, priorities, and dependencies; user persona definitions. (When
   applicable.)
4. **Refined Mockups** (2.5) -- Mid-to-high fidelity mockups, interaction
   specifications, design system mapping, accessibility checklist. (When
   applicable.)
5. **Application Design** (2.6) -- Component definitions, method signatures,
   service definitions, dependency matrix, architecture decision records.
   (When applicable.)
6. **Units of Work** (2.7) -- Unit definitions with boundaries and complexity
   estimates, unit dependency matrix with build order, story-to-unit mapping.
   (When applicable.) This is the artifact that drives the Construction
   phased construction flow.
7. **Delivery Plan** (2.8) -- Bolt plan, build order, dependency matrix, team
   allocation. This is the execution plan that governs Construction and
   Operation.
8. **Phase Boundary Verification** (2.8) -- Inception-to-Construction
   traceability check written to
   `aidlc-docs/verification/phase-check-inception.md`.

### Handoff to Construction

Upon approval at Stage 2.8, the framework transitions to the Construction
phase. Construction creates stage-level tasks based on the execution plan from
Delivery Planning and executes a phased construction flow:

Construction runs Bolt-by-Bolt per `bolt-plan.md`, with parallel batches
allowed per the bolt plan. Each Bolt covers a coherent slice of one or
more Units (per `unit-of-work.md` and `unit-of-work-dependency.md`):

For each Bolt:
1. **3.1 Functional Design** (conditional per execution plan)
2. **3.2 NFR Requirements** (conditional per execution plan)
3. **3.3 NFR Design** (conditional per execution plan)
4. **3.4 Infrastructure Design** (conditional per execution plan)
5. **3.5 Code Generation** (always, per unit within the Bolt)

After the final Bolt completes:
6. **3.6 Build and Test** (always)
7. **3.7 CI Pipeline** (conditional)

Bolts can run in parallel batches as the dependency graph allows; the
walking-skeleton Bolt always runs first as a single-Bolt batch to verify
the end-to-end shape before parallel batches kick off. See
`docs/guide/03-phases-and-stages.md:263-293` for the full Bolt-by-Bolt
narrative.

### Cross-References

- **Orchestrator**: `dist/claude/.claude/skills/aidlc/SKILL.md` --
  Routing logic, scope-to-stage mapping, stage graph, Construction flow
  definition
- **Stage Protocol**: `dist/claude/.claude/aidlc-common/protocols/stage-protocol.md`
  -- Approval gates, question format, completion messages, and the §13 Learnings
  Ritual. Phase boundary verification lives in
  `stage-protocol-governance.md` §13.
- **Ideation Phase**: `docs/reference/04-stages/ideation.md` -- Previous phase
  documentation
- **Construction Phase**: Construction stages execute per the delivery plan
  produced by Stage 2.8
- **Deliberate Deviations**: SKILL.md documents intentional differences from
  the upstream reference, including the always-rerun RE policy, aidlc-design-agent
  support additions, ADR artifacts, and the Delivery Planning expansion
