# User Story Patterns

## Purpose
Write user stories that are small enough to deliver quickly, valuable enough to justify the work, and clear enough to test without ambiguity.

## Standard Format
```
As a [role], I want to [action], so that [benefit].
```

The "so that" clause is the most important part — it forces articulation of value. If you cannot state the benefit, question whether the story is needed.

## INVEST Criteria

Every story should satisfy all six criteria:

- **Independent** — Can be developed and delivered without depending on other stories
- **Negotiable** — Details are open to discussion; the story is not a contract
- **Valuable** — Delivers value to the user or business (not "set up database")
- **Estimable** — Team can reasonably estimate the effort required
- **Small** — Completable within a single sprint (ideally 1-3 days of work)
- **Testable** — Clear acceptance criteria define "done" without ambiguity

## Story Splitting Patterns

When a story is too large, split it using one of these patterns:

### 1. Workflow Steps
Split a multi-step process into individual steps.
- "User completes checkout" becomes: add to cart, enter shipping, enter payment, confirm order, receive confirmation

### 2. Business Rule Variations
Isolate each business rule into its own story.
- "Calculate shipping cost" becomes: flat rate domestic, weight-based domestic, international shipping, free shipping threshold

### 3. Data Variations
Split by the type or complexity of data handled.
- "Import customer data" becomes: import from CSV, import from API, import with deduplication, import with validation errors

### 4. Interface Variations
Split by platform or interaction mode.
- "User views dashboard" becomes: desktop layout, mobile responsive layout, keyboard-accessible version

### 5. Operations / CRUD
Split create, read, update, and delete into separate stories.
- Start with Read (simplest, immediate value), then Create, then Update, then Delete

### 6. Performance / Scale
Separate "make it work" from "make it fast."
- Story 1: "User searches products (basic query, < 1000 results)"
- Story 2: "User searches products with sub-200ms response across 1M+ catalog"

## Acceptance Criteria: Given/When/Then

### Format
```
Given [precondition / initial state]
When [action / trigger]
Then [expected outcome / observable result]
```

### Example
```
Story: As a customer, I want to reset my password, so that I can regain access to my account.

AC 1:
Given I am on the login page
When I click "Forgot password" and enter my registered email
Then I receive a password reset link within 5 minutes

AC 2:
Given I have received a password reset link
When I click the link after 24 hours
Then I see a message that the link has expired with an option to request a new one

AC 3:
Given I am resetting my password
When I enter a password shorter than 8 characters
Then I see a validation error and the password is not changed
```

### Tips
- Write 3-6 acceptance criteria per story — fewer means ambiguity, more means the story is too large
- Always include the sad path (error, edge case, timeout) not just the happy path
- Acceptance criteria are testable assertions — QA should be able to automate them directly

## Anti-Patterns to Avoid

### Too Large (Epic in Disguise)
- **Symptom**: "As a user, I want a complete reporting system"
- **Fix**: Split into individual reports, then split each report by filter/export/schedule

### Too Technical (Implementation Story)
- **Symptom**: "As a developer, I want to migrate the database to PostgreSQL"
- **Fix**: Reframe around user value: "As a user, I want search results in under 200ms" (which requires the migration)

### No Value Statement
- **Symptom**: "As a user, I want to click the submit button" — no "so that"
- **Fix**: Ask "why does the user care?" until you reach a meaningful benefit

### Compound Stories (AND in the Title)
- **Symptom**: "As a user, I want to search AND filter AND sort results"
- **Fix**: Split into three stories — search, filter, sort — each independently deliverable

### Solution-Prescriptive
- **Symptom**: "As a user, I want a dropdown menu with checkboxes"
- **Fix**: Describe the need, not the UI: "As a user, I want to select multiple categories to narrow results"

## Story Mapping

Organize stories into a two-dimensional map:
- **Horizontal axis**: User journey steps (left to right)
- **Vertical axis**: Priority (top = essential, bottom = nice-to-have)

Draw a horizontal line across the map to define your MVP — everything above the line ships first. This reveals gaps in the journey that individual story lists miss.

## Definition of Ready Checklist
- [ ] Story follows standard format with clear value statement
- [ ] INVEST criteria satisfied
- [ ] 3-6 acceptance criteria written in Given/When/Then
- [ ] Dependencies identified and resolved or accepted
- [ ] UX design reviewed (if UI-facing)
- [ ] Team has estimated the story
