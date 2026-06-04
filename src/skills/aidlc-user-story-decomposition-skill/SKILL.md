---
name: aidlc-user-story-decomposition-skill
description: |
  The skill of breaking requirements into well-formed user stories and system stories. Covers story structure (As a/I want/So that), INVEST criteria, acceptance criteria (Given/When/Then), story sizing, and traceability back to requirements.
---

# Story Decomposition

## Purpose

Break structured requirements into implementable stories that are independent, negotiable, valuable, estimable, small, and testable.

## Principles

- Every story must trace to at least one requirement (FR-n or NFR-n)
- Every requirement must be covered by at least one story
- User stories follow: As a [persona], I want [goal], so that [benefit]
- System stories follow: As the [system/service], when [trigger], it must [behaviour]
- Acceptance criteria use Given/When/Then format — specific, testable, no ambiguity
- Stories should be small enough to implement in one pass — if too large, decompose further
- Group stories by feature area or user journey, not by technical layer
- Include edge cases and error scenarios as separate stories, not buried in happy-path stories
- Non-functional requirements become either cross-cutting acceptance criteria or dedicated system stories

## Application

When producing stories:
- Read requirements.md and identify every FR and NFR
- Create personas.md first (who are the actors?)
- Decompose each requirement into one or more stories
- Write acceptance criteria for each story
- Verify coverage: every FR/NFR has at least one story, every story traces back
