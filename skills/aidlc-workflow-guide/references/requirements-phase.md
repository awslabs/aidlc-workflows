# Requirements Phase Support Guide
## Requirements Analysis + User Stories

---

## Purpose of This Phase

The goal is for **everyone to share the same understanding of what to build**.
AI rapidly performs questioning, organization, and documentation, while developers and the team make business decisions.

---

## How to Conduct Requirements Analysis

### Step 1: Intent Analysis (Executed by AI)

Extract the following from the user's request:
- **What**: What they want to build
- **Why**: Why they are building it (business value)
- **Who**: Who the service is for
- **How**: What technology stack is envisioned (if any)
- **Constraints**: Constraints (deadlines, budget, existing systems, etc.)

### Step 2: Generate Requirements Verification Questions (Mob Elaboration)

Questions must be generated in A/B/C/D format following **`common/question-format-guide.md`**.

**Example of a good question**:
```
Q1. Who is the core target user of this service?

A) General consumers (B2C)
B) Business/enterprise users (B2B)
C) Developers and engineers
D) A combination of the above

[Answer]: A
```

**Question Depth Levels**:
- **Minimal**: 3–5 questions (simple request)
- **Standard**: 6–10 questions (typical feature development)
- **Comprehensive**: 11–15 questions (complex or high-risk)

**Required question categories**:
1. Target users and personas
2. Priority of core features (Must Have)
3. Non-functional requirements (performance, security, availability)
4. Integration with existing systems
5. Scale requirements (number of users, data volume)
6. Deployment environment (confirm AWS assumption)

### Step 3: Generate requirements.md

After receiving answers, generate in the following format:

```markdown
# Requirements Document

## Project Overview
[Service overview, purpose, business value]

## Target Users
[Persona definitions]

## Functional Requirements

### Must Have
- FR-001: [Feature description] - [Reason]
- FR-002: [Feature description] - [Reason]

### Should Have
- FR-010: [Feature description]

### Could Have
- FR-020: [Feature description]

## Non-Functional Requirements

### Performance Requirements
- NFR-001: [e.g.] API response time 95th percentile under 500ms
- NFR-002: [e.g.] Support 1,000+ concurrent users

### Security Requirements
- NFR-010: [e.g.] Use AWS Cognito for authentication
- NFR-011: [e.g.] Encrypt all communications with HTTPS/TLS 1.3

### Availability Requirements
- NFR-020: [e.g.] Monthly uptime 99.9% or higher (SLA)

### Scalability Requirements
- NFR-030: [e.g.] Auto-scaling based on load

## Constraints
- [Technical and business constraints]

## Assumptions
- [AWS account, existing systems, etc.]
```

### Step 4: Approval Process

After generating the requirements document:
1. Ask the user for confirmation
2. Incorporate any revisions
3. Update Requirements Analysis to `[x]` in aidlc-state.md
4. Record the **complete raw text** in audit.md (no summarization)

---

## How to Conduct User Stories

### Persona Definition Template

```markdown
## Persona: [Name]

**Attributes**:
- Age: [e.g.] 25–35
- Occupation: [e.g.] Freelance designer
- Tech literacy: [High/Medium/Low]

**Pain points**:
- [Problem to solve 1]
- [Problem to solve 2]

**Goals**:
- [What they want to achieve with this service]
```

### User Story Format

```
[Story ID]: As a [persona name],
I want to [desired action].
Because [reason/purpose].

Acceptance Criteria:
- [ ] [Testable condition 1]
- [ ] [Testable condition 2]
- [ ] [Testable condition 3]
```

**Conditions for good acceptance criteria**:
- Given-When-Then format is ideal
- Testable (avoid ambiguous expressions)
- One criterion represents one behavior

---

## Common Problems and Solutions

**Problem**: Requirements are vague or too broad
→ Deepen intent analysis and generate additional questions. Always ask "What is the MVP (minimum viable product)?"

**Problem**: Non-functional requirements are missing
→ Use the NFR checklist to verify completeness

**Problem**: Weak alignment between requirements and theme
→ Call the `aws-summit-hackathon-reviewer` skill to check theme compliance
