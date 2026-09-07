---
slug: user-stories
phase: inception
execution: CONDITIONAL
condition: Execute when user-facing features, multiple personas, complex business logic, or cross-team work is involved. Skip for pure refactoring, isolated bug fixes, infrastructure-only changes, or developer tooling.
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-design-agent
  - aidlc-developer-agent
  - aidlc-quality-agent
mode: mob
summary_confirmation: required
reviewer: aidlc-product-lead-agent
review_artifact: stories
reviewer_max_iterations: 2
review_class: advisory
produces:
  - stories
  - personas
  - user-stories-assessment
  - traceability
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
  - traceability
scopes:
  - enterprise
  - feature
  - mvp
  - classic
  - workshop
inputs: <record>/inception/requirements-analysis/requirements.md, RE artifacts (if brownfield)
outputs: stories.md, personas.md, user-stories-assessment.md, traceability.json (under this stage's record dir, engine-resolved)
---

# User Stories

## Steps

### Step 1: Load the Lead Persona (mob stage)

Read every path in `directive.inline_context_paths` per the stage protocol. For
this mob the roster contains the aidlc-product-agent persona and its shared/role
knowledge only; the product manager owns the inline draft and integration work.

This stage runs `mode: mob` (stage-protocol-ensemble.md §5 "Multi-agent stages"): the support agents (aidlc-design-agent for user experience, aidlc-developer-agent for implementability, aidlc-quality-agent for testability) are NOT voices to adopt — they are dispatched as independent participants during PART 2. Do not load their personas into your own context.

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

If skipping, run
`bun .claude/tools/aidlc-orchestrate.ts report --stage user-stories --result skipped --reason "<reason>"`.
The engine records the skip and advances to the next in-scope stage.

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

## PART 2: Generation (mob elaboration)

### Step 8: Execute Plan — Generate Stories and Personas via the Mob

This is the mob-elaboration ritual: the Product Manager (lead) owns the
draft, Developers and QA (and Design) collaborate as independent
participants, and the Product Leader reviews afterwards (`stage-protocol-reviewer.md` §12a).

**Round 0 — lead drafts.** As the lead, based on the approved plan, draft:

**`<record>/inception/user-stories/personas.md`:**
- User persona definitions (name, role, goals, pain points, context)
- Persona relationships and priority ranking

**`<record>/inception/user-stories/stories.md`:**
- User stories in standard format: "As a [persona], I want [goal], so that [benefit]". Give each story a stable `US{group}.{seq}` ID (for example `US1.1`).
- Acceptance criteria for each story. Give each criterion a three-segment `AC{story-group}.{story-seq}.{criterion-seq}` ID (for example `AC1.1.1`).
- Story priority (Must Have / Should Have / Could Have / Won't Have)
- Story dependencies and relationships
- INVEST compliance notes

**Round 1 — dispatch the mob.** Per stage-protocol-ensemble.md §5 `mode: mob`,
dispatch all three support agents in parallel against the draft (artifacts
by path: the two draft artifacts, the Q&A file, requirements.md; rules as the
accumulated steering bundle), mutually blind. Each WRITES its contribution file at
`<record>/inception/user-stories/contributions/<agent-slug>.md` (§11 format:
identity-marker first line, Contribution, Positions): design on UX and
persona fidelity, developer on implementability and story sizing, quality on
testability of the acceptance criteria.

**Integrate and triage.** As the lead, fold the contributions into the two
artifacts, then triage unresolved objections per stage-protocol-ensemble.md §5: a judgment call (both
positions legitimate) goes to the user NOW as a structured question (add it
to the questions file first, blank `[Answer]:` tag); a knowledge dispute
goes to **round 2** — re-dispatch only the objecting agent(s) with the
revised draft and the other participants' positions (they update their own
contribution files). Maintained dissent is quoted verbatim in the Step 10
completion summary. The three contribution files are this stage's ensemble
evidence — the engine refuses approval while any is missing.

**Write element-level traceability.** Create
`<record>/inception/user-stories/traceability.json`. Enumerate every `FR` and
`NFR` ID from `requirements.md` in `upstream_ids`, with one `coverage` row per
ID. `OK` targets must name one or more existing `USx.y` IDs. Use `Deferred`
only with a named downstream stage and `N/A` only with a justification:

```json
{
  "stage": "user-stories",
  "upstream_ids": ["FR1", "FR2", "NFR1"],
  "coverage": [
    { "id": "FR1", "status": "OK", "target": "US1.1, US1.2" },
    { "id": "NFR1", "status": "Deferred", "target": "nfr-requirements" },
    { "id": "FR2", "status": "GAP" }
  ]
}
```

### Step 9: Open the Approval Gate

After verifying the three lead artifacts and all three contribution files, run:

```bash
bun .claude/tools/aidlc-orchestrate.ts report \
  --stage user-stories --result awaiting-approval
```

If the engine refuses missing or malformed ensemble evidence, restore that
evidence before presenting the human gate.

### Step 10: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :books:
- Summary of personas and stories produced
- Review path: `<record>/inception/user-stories/`
- Structured approval question with options: Approve / Request Changes. On the Approve option's description write `Continue to <next stage name>`, taking that name from the run-stage directive's `next_stage` field (`Complete workflow` when it is null) - the user sees the real stage name, never a field name.

STOP for the human response. Report **Approve** with
`--result approved --user-input "<exact choice>"`; report
**Request Changes** with `--result rejected --user-input "Request Changes"
--reason "<feedback>"`, run the
revision loop, and report `--result revised` before re-presenting. The engine
owns every lifecycle transition and advancement.

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/user-stories/`.

Imports: `required-sections`, `upstream-coverage`, `traceability`.

Upstream targets: `requirements`, `business-overview`, `component-inventory`, `team-practices`.

`traceability` owns `traceability.json`, verifies every requirement is
declared and covered, and checks that each `OK` target exists in `stories.md`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
