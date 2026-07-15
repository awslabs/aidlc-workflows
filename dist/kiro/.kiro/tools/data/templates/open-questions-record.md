# Open Questions Record

<!-- Framework default template. The ## headings below are the required
     sections the required-sections sensor checks. A team override at
     aidlc/spaces/<space>/memory/templates/open-questions-record.md wins. -->

## Open

Questions about the world that materials, research, or people can still
answer. Each entry carries an id (OQ-n), the question, the decision its
answer informs, its origin (starter, derived, raised, user), its status, and
the entries it depends on. When an answer changes, every entry that depends
on it reopens.

| Id | Question | Informs | Origin | Status | Depends on |
|----|----------|---------|--------|--------|------------|

## Answered

What the initiative knows. Each answer names its source and a confidence
grade; an answer derived from materials stays unconfirmed until a person
validates it at the relevant gate.

| Id | Question | Informs | Origin | Depends on | Answer | Answer source | Confidence |
|----|----------|---------|--------|------------|--------|---------------|------------|

## Moved to assumptions

Questions no material, research, or person can settle because the answer
depends on future behavior or on something that does not exist yet. Each
keeps a pointer to its successor entry (AS-n) in the assumptions record
where the workflow keeps one. "None" is a valid entry, and stays the normal
entry for workflows that never test assumptions.
