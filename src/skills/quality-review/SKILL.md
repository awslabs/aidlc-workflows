---
name: quality-review
description: |
  The skill of holistic artifact review. Collate the original input, the output, the questions asked, the contributor contribution comments, and the template — then check for completeness, coherence, and readiness. Used by the delivery-lead to gate stage completion.
---

# Quality Review

## Purpose

Review an artifact holistically by cross-referencing everything that went into producing it. Ensure nothing was dropped, nothing contradicts, and the output is ready for the next stage.

## Principles

- Read the original input (intent.md or upstream artifacts) — does the output address what was asked?
- Read the questions and answers — were all answers reflected in the output?
- Read the contributor contributions — were all findings addressed (or explicitly deferred with rationale)?
- Read the template — does the output follow the expected structure and include all required sections?
- Check traceability — can you trace from input through to output without gaps?
- Check coherence — do all parts of the output agree with each other? No contradictions?
- Check completeness — are there obvious gaps, missing sections, or placeholder content?

## Application

When reviewing any stage artifact:
1. Read the stage's `definition.md` to understand expected inputs and outputs
2. Read the template from `templates/` to understand expected structure
3. Read `questions.md` to see what was clarified
4. Read all `*-contribution.md` files to see what contributors flagged
5. Read the artifact itself
6. Write `delivery-lead-review.md` with: verdict (ready / not ready), gaps found, items not addressed
