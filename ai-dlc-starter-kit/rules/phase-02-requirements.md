# Phase 2: Requirements Gathering (REQUIREMENTS)

## Objective

Ensure complete mutual understanding of what needs to be built. Never assume — always ask.

## Instructions

### Step 1: Read Existing Requirements

If `.aidlc/docs/requirements.md` exists, read it. Check if previous requirements are related to the current task.

### Step 2: Analyze the Request

Use the structured template at `.aidlc/templates/requirements-template.md` for the output format. Parse the user's request for:
- **Functional requirements**: What should it do?
- **Non-functional requirements**: Performance, security, accessibility
- **Constraints**: Deadlines, dependencies, backwards compatibility
- **Unknowns**: Anything vague or ambiguous — these become clarification questions

### Step 3: Ask Clarification Questions

Ask 2-7 questions depending on complexity. Never guess.

**For features:**
- What exactly should happen? (user flow, step by step)
- What are the edge cases? (empty state, error, loading, boundary)
- Where in the app does this go? (route, component, module)
- What does success look like? (acceptance criteria)

**For brownfield:**
- How does this interact with existing code?
- Does this require data migration?
- Are there backwards compatibility concerns?

### Step 4: Write Requirements Document

Write to `.aidlc/docs/requirements.md` using the XML-structured format for better LLM parsing:

```markdown
<task_metadata>
  <name>...</name>
  <date>YYYY-MM-DD</date>
  <status>draft</status>
</task_metadata>

<business_context>
## Summary
...
</business_context>

<functional_requirements>
## Functional Requirements
...
</functional_requirements>

<non_functional_requirements>
...
</non_functional_requirements>

<acceptance_criteria>
...
</acceptance_criteria>

<edge_cases>
...
</edge_cases>
```

### Step 5: Checkpoint

Present the requirements. Ask: "Do these requirements capture what you want? Proceed to planning?"

Do NOT proceed until user confirms.

## Rollback from Later Phases

If rolling back to REQUIREMENTS from a later phase:
1. Read `.aidlc/history/` for the most recent snapshot
2. Re-read `.aidlc/audit.md` for decisions made
3. Re-evaluate: what was wrong with the previous requirements?
4. Update `.aidlc/docs/requirements.md` with corrections
