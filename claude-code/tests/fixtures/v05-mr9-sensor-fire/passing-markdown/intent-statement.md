# Intent Statement

Fixture for t92 PASSED round-trip — `required-sections` sensor (counts
distinct `^## ` headings, pass = count >= 2) AND `upstream-coverage`
sensor (intent-capture has `consumes: []` per the stage frontmatter, so
the script's "no upstream" early-return triggers pass=true).

Both sensors run only against this file's content; the H2 set below is
deliberate — the file ships 3 distinct H2s so the dedupe-by-exact-text
path is exercised and the count clears the >=2 floor by a margin.

## Problem

The current workflow lacks a shared definition of "sensor coverage";
reviewers can't tell whether a sensor's logic was actually exercised
or just stubbed.

## Stakeholders

- Eng team — owners of the sensor dispatcher.
- Product team — consumers of the framework.
- QA team — relies on the audit row shape staying stable.

## Outcomes

Reduce review-cycle time by 30% by emitting evidence that each
per-sensor script was fired against a real input.
