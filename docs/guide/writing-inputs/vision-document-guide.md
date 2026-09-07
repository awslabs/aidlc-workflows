# Vision Document Guide

## Purpose

A Vision Document defines the **business goals**, **target outcomes**, and **scope boundaries** for a project before entering the AI-DLC workflow. It serves as the primary input to the Inception Phase, giving the AI model and the team a shared understanding of what the project aims to achieve and why it matters.

A well-written Vision Document reduces ambiguity during Requirements Analysis, improves User Story quality, and prevents scope creep during Construction.

## When to Write a Vision Document

- Before starting any new project or major initiative
- When proposing a new product, feature set, or platform
- When pivoting an existing product in a new direction
- When multiple stakeholders need alignment on goals before development begins

## Document Structure

### 1. Executive Summary

A brief paragraph (3-5 sentences) that captures the essence of the project. Anyone reading only this section should understand what the project is, who it serves, and why it exists.

**Template:**

```markdown
## Executive Summary

[Project Name] is a [type of system/product] that enables [target users] to [core capability].
It addresses [business problem or opportunity] by [approach or differentiation].
The expected outcome is [measurable business result].
```

**Example:**

```markdown
## Executive Summary

OrderFlow is a web-based order management platform that enables mid-size retailers to
track inventory, process customer orders, and manage supplier relationships in a single
interface. It addresses the fragmented tooling problem that causes fulfillment delays
and inventory mismatches. The expected outcome is a 30% reduction in order processing
time and elimination of manual inventory reconciliation.
```

---

### 2. Business Context

Describe the business environment, the problem being solved, and why solving it matters now.

**Sections to include:**

```markdown
## Business Context

### Problem Statement
[What specific business problem or pain point does this project address?
Be concrete. Avoid vague statements like "improve efficiency."]

### Business Drivers
[Why is this project being pursued now? What market conditions, competitive
pressures, regulatory changes, or internal needs make this timely?]

### Target Users and Stakeholders
[Who will use the system? Who has a stake in its success?
List user types with a brief description of each.]

| User Type | Description | Primary Need |
|-----------|-------------|--------------|
| [Role]    | [Who they are] | [What they need from this system] |

### Business Constraints
[Budget limits, regulatory requirements, organizational policies, timeline
pressures, or other non-negotiable boundaries.]

### Success Metrics
[How will the business measure whether this project succeeded?
Use specific, measurable criteria.]

| Metric | Current State | Target State | Measurement Method |
|--------|--------------|--------------|-------------------|
| [Metric name] | [Baseline] | [Goal] | [How measured] |
```

---

### 3. Full Scope Vision

This section describes the **complete long-term vision** for the product or system. It is deliberately aspirational and covers everything the project could become, not just what will be built first.

**Sections to include:**

```markdown
## Full Scope Vision

### Product Vision Statement
[A single sentence or short paragraph that captures the long-term aspirational
state of the product. What does the world look like when this product is fully
realized?]

### Feature Areas
[Organize the full feature set into logical groups. For each area, describe
what the system will do at full maturity.]

#### Feature Area 1: [Name]
- **Description**: [What this area covers]
- **Key Capabilities**:
  - [Capability 1]
  - [Capability 2]
  - [Capability 3]
- **User Value**: [Why this matters to users]

#### Feature Area 2: [Name]
[Same structure]

### Integration Points
[What external systems, APIs, or data sources will the full system integrate
with at maturity?]

- [System/Service] - [Purpose of integration]

### User Journeys (Full Vision)
[Describe 2-3 end-to-end user journeys that represent the complete product
experience. These should reflect the full scope, not the MVP.]

#### Journey 1: [Name]
1. [Step]
2. [Step]
3. [Step]
**Outcome**: [What the user achieves]

### Scalability and Growth
[How is the product expected to grow? New markets, user types, geographies,
data volumes, or feature categories?]

### Long-Term Roadmap (Optional)
[If known, outline the high-level phases or milestones beyond the MVP.
This is directional, not committal.]

| Phase | Focus | Timeframe (if known) |
|-------|-------|---------------------|
| MVP | [Core scope] | [Target] |
| Phase 2 | [Expansion area] | [Target] |
| Phase 3 | [Further expansion] | [Target] |
```

---

### 4. MVP Scope

This section defines the **minimum viable product**: the smallest set of functionality that delivers measurable value and validates the core business hypothesis. Everything listed here must be built before the product can launch or be evaluated.

**Sections to include:**

```markdown
## MVP Scope

### MVP Objective
[What is the single most important thing the MVP must prove or deliver?
Keep this to 1-2 sentences.]

### MVP Success Criteria
[How will you know the MVP succeeded? These should be testable and specific.]

- [ ] [Criterion 1]
- [ ] [Criterion 2]
- [ ] [Criterion 3]

### Features In Scope (MVP)
[List every feature that is included in the MVP. Be explicit. If it is not
listed here, it is not in the MVP.]

| Feature | Description | Priority | Rationale for Inclusion |
|---------|-------------|----------|------------------------|
| [Feature name] | [Brief description] | Must Have | [Why it cannot be deferred] |

### Features Explicitly Out of Scope (MVP)
[List features from the Full Scope Vision that are deliberately excluded
from the MVP. State why each is deferred. This prevents scope creep.]

| Feature | Reason for Deferral | Target Phase |
|---------|-------------------|--------------|
| [Feature name] | [Why it can wait] | [Phase 2/3/TBD] |

### MVP User Journeys
[Describe the user journeys that the MVP must support. These are subsets
or simplified versions of the Full Vision journeys.]

#### Journey 1: [Name]
1. [Step]
2. [Step]
3. [Step]
**Outcome**: [What the user achieves]
**Limitation vs Full Vision**: [What is simplified or missing compared to full scope]

### MVP Constraints and Assumptions
[What assumptions is the MVP built on? What known limitations are accepted?]

- **Assumption**: [Statement] - **Risk if wrong**: [Consequence]
- **Accepted Limitation**: [What is intentionally limited and why]

### MVP Definition of Done
[What must be true for the MVP to be considered complete and ready for
evaluation or launch?]

- [ ] All "Must Have" features implemented and tested
- [ ] [Additional criteria specific to this project]
- [ ] [Deployment or accessibility requirement]
- [ ] [Stakeholder sign-off requirement]
```

---

### 5. Risks and Dependencies

```markdown
## Risks and Dependencies

### Key Risks
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| [Risk description] | High/Medium/Low | High/Medium/Low | [Mitigation strategy] |

### External Dependencies
[List anything outside the team's control that the project depends on.]

- [Dependency] - [Owner] - [Status]

### Open Questions
[List unresolved questions that need answers before or during development.
These feed directly into the Requirements Analysis clarifying questions.]

- [ ] [Question]
- [ ] [Question]
```

---

## Writing Guidelines

### Do

- Be specific and measurable. "Reduce order processing time by 30%" is better than "make things faster."
- Clearly separate full vision from MVP. Mixing them causes scope creep.
- Include "out of scope" lists. They are as valuable as "in scope" lists.
- Write for the team, not for executives. Avoid marketing language.
- State assumptions explicitly so they can be challenged.
- Include success criteria that can actually be tested.

### Do Not

- Use vague language: "world-class," "seamless," "intuitive," "best-in-class."
- List technologies or implementation details. That belongs in the Technical Environment Document.
- Skip the MVP section. Every project needs a defined starting boundary.
- Combine features and user journeys. Features describe what the system does; journeys describe how users experience it.
- Assume readers know the business context. Write the Problem Statement even if it seems obvious.

---

## How This Document Feeds Into AI-DLC

| Vision Document Section  | AI-DLC Stage                     | How It Is Used                                     |
| ------------------------ | -------------------------------- | -------------------------------------------------- |
| Executive Summary        | Workspace Detection              | Initial context for project classification         |
| Business Context         | Requirements Analysis            | Drives clarifying questions and requirements depth |
| Full Scope Vision        | User Stories, Application Design | Informs persona creation, component identification |
| MVP Scope                | Workflow Planning                | Determines which stages execute, scope boundaries  |
| Features In/Out of Scope | Code Generation                  | Defines what gets built in this iteration          |
| Risks and Dependencies   | All stages                       | Informs risk assessment and error handling         |
| Open Questions           | Requirements Analysis            | Become clarifying questions in the question files  |
