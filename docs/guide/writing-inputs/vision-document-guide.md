# Writing a Vision Document

A vision document says **what to build, for whom, and why**, and where the
first release stops. It is the main input to a new workflow: Intent Capture,
Scope Definition and Requirements Analysis read it, and every question it
already answers is one the workflow does not have to ask you.

You do not need one to start. `/aidlc Build a REST API for inventory
management` is a complete request. A vision document pays off when several
people need to agree on the goal first, when the scope is larger than a few
sentences, or when you are running a workshop and want the first hour spent on
decisions rather than on questions.

The technical counterpart, the stack, the tools and what is not allowed, is the
[technical environment document](technical-environment-guide.md).

---

## Giving it to AI-DLC

Save the document in the project (Markdown or plain text works best) and name
it in your first request:

```text
/aidlc Read ./vision.md and build what it describes
```

Codex CLI uses `$aidlc` instead of `/aidlc`. Relative paths resolve from the
project root. You can also paste the content into the request between
`<document>` and `</document>`, or name a PDF or Word file. See
[Starting from an existing document](../02-your-first-workflow.md#starting-from-an-existing-document)
for how each one is read and what happens when the name matches more than one
file.

The workflow treats the document as data, not as instructions: it plans from
it, and you still approve every stage. Intent Capture asks its questions
anyway; the ones your document already answers are quick to confirm.

---

## The short version

If you write nothing else, write these four things:

```text
1. One paragraph saying what you are building and for whom
2. The features in the first release (what is IN scope)
3. What is NOT in the first release
4. Open questions: things you already know are uncertain or undecided
```

Open questions are optional but valuable. Intent Capture and Requirements
Analysis turn them into questions early, instead of the gaps surfacing as
surprises during design.

### For work on an existing codebase

```text
1. Current state: one paragraph on what the system does today
2. What we are adding or changing
3. Features IN scope for this piece of work
4. Features OUT of scope for this piece of work
5. What must NOT change: components, APIs or data the new work must not touch
6. Open questions
```

"What must not change" matters most. Reverse Engineering reads your existing
code, but only you know which parts are off limits; saying so keeps the plan
away from them.

---

## The full structure

### 1. Executive Summary

Three to five sentences. Anyone who reads only this section should know what
the project is, who it serves, and why it exists.

```markdown
## Executive Summary

[Project Name] is a [type of system or product] that lets [target users]
[core capability]. It addresses [business problem or opportunity] by
[approach or difference]. The expected outcome is [measurable result].
```

Example:

```markdown
## Executive Summary

OrderFlow is a web-based order management platform that lets mid-size
retailers track inventory, process customer orders, and manage suppliers in
one place. It addresses the scattered tooling that causes fulfilment delays
and stock mismatches. The expected outcome is a 30% cut in order processing
time and no more manual stock reconciliation.
```

### 2. Business Context

```markdown
## Business Context

### Problem Statement
[The specific business problem. Be concrete: "orders wait two days for a
stock check" says more than "improve efficiency".]

### Business Drivers
[Why now: market pressure, a regulation, a contract, an internal need.]

### Target Users and Stakeholders
| User Type | Description | Primary Need |
|-----------|-------------|--------------|
| [Role] | [Who they are] | [What they need from the system] |

### Business Constraints
[Budget, regulation, organisational policy, deadlines, anything that is not
negotiable.]

### Success Metrics
| Metric | Today | Target | How it is measured |
|--------|-------|--------|--------------------|
| [Metric] | [Baseline] | [Goal] | [Method] |
```

### 3. Full Scope Vision

Everything the product could become at maturity. This part is deliberately
aspirational: it helps the workflow see where the first release is heading,
without committing to build it.

```markdown
## Full Scope Vision

### Product Vision Statement
[One sentence or a short paragraph: what the world looks like when the
product is fully realised.]

### Feature Areas
#### Feature Area 1: [Name]
- **Description**: [What this area covers]
- **Key capabilities**: [Capability 1], [Capability 2], [Capability 3]
- **User value**: [Why it matters to users]

### Integration Points
- [System or service]: [purpose of the integration]

### User Journeys
#### Journey 1: [Name]
1. [Step]
2. [Step]
**Outcome**: [What the user achieves]

### Growth and Roadmap (optional)
| Phase | Focus | Timeframe (if known) |
|-------|-------|----------------------|
| First release | [Core scope] | [Target] |
| Phase 2 | [Expansion] | [Target] |
```

### 4. First Release (MVP) Scope

The smallest set of features that delivers measurable value. If a feature is
not listed here, it is not in the first release.

```markdown
## MVP Scope

### Objective
[The one thing the first release must prove or deliver, in one or two
sentences.]

### Success Criteria
- [ ] [Testable criterion]
- [ ] [Testable criterion]

### Features In Scope
| Feature | Description | Why it cannot wait |
|---------|-------------|--------------------|
| [Feature] | [Short description] | [Reason] |

### Features Out of Scope
| Feature | Why it can wait | Target phase |
|---------|-----------------|--------------|
| [Feature] | [Reason] | [Phase 2, 3 or later] |

### Journeys the First Release Supports
#### Journey 1: [Name]
1. [Step]
2. [Step]
**Outcome**: [What the user achieves]
**Simplified compared with the full vision**: [What is missing or reduced]

### Assumptions and Accepted Limits
- **Assumption**: [Statement]. **Risk if wrong**: [Consequence]
- **Accepted limit**: [What is limited on purpose, and why]

### Definition of Done
- [ ] Every in-scope feature built and tested
- [ ] [Project-specific criterion]
- [ ] [Sign-off needed]
```

### 5. Risks, Dependencies and Open Questions

```markdown
## Risks and Dependencies

### Key Risks
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| [Risk] | High / Medium / Low | High / Medium / Low | [Plan] |

### External Dependencies
- [Dependency]: [owner], [status]

### Open Questions
- [ ] [Question]
- [ ] [Question]
```

---

## Writing guidelines

Do:

- Be specific and measurable. "Cut order processing time by 30%" beats "make
  it faster".
- Keep the full vision and the first release apart. Mixing them is how scope
  creeps.
- Write the out-of-scope list. It is worth as much as the in-scope list.
- Write for the team, not for a sales deck.
- State assumptions so they can be challenged.
- Give success criteria someone can actually test.

Do not:

- Use words like "world-class", "seamless" or "intuitive" without a number
  behind them.
- List technologies or implementation details. They belong in the
  [technical environment document](technical-environment-guide.md).
- Skip the first-release section. Every project needs a starting boundary.
- Assume the reader knows the business. Write the problem statement even when
  it feels obvious.

---

## Where each section is used

| Section | Stage | How it is used |
|---------|-------|----------------|
| Executive Summary | Intent Capture & Framing | The problem, the users and the expected outcome |
| Business Context | Intent Capture & Framing, Requirements Analysis | The questions asked and how deep the requirements go |
| Full Scope Vision | Scope Definition, User Stories, Domain Design | Where the product is heading; personas and components |
| First Release Scope | Scope Definition, Requirements Analysis | The boundary of this piece of work |
| Features In / Out | Requirements Analysis, Units Generation, Code Generation | What gets built in this piece of work |
| Risks and Dependencies | Feasibility & Constraints, NFR Requirements | Risk and constraint assessment |
| Open Questions | Intent Capture & Framing, Requirements Analysis | Asked early as clarifying questions |

Which of these stages run depends on the plan you approve: an Express or
Bugfix plan runs only a few of them. See
[Phases and Stages](../04-phases-and-stages.md) for every stage and
[Workflow Profiles](../workflow-profiles.md) for the plans.
