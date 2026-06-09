# Intent Statement

Fixture for t92 FAILED round-trip — `required-sections` sensor.

This file ships ONE H1 and zero H2 headings on purpose. The sensor
counts distinct `^## ` headings (H1 `#` and H3 `###` are excluded by
the literal `## ` startsWith check) and emits pass=false when the
count is < 2.

Findings count derivation: max(0, 2 - h2_count) = max(0, 2 - 0) = 2.
The dispatcher's computeFindingsCount() for `required-sections` mirrors
that formula, so the audit row's `Findings count` field MUST equal 2.

Body intentionally written as flowing paragraphs without subheadings
to stay below the H2 floor; a single H3 below would still leave
h2_count at 0 because the script's `startsWith("## ")` check requires
exactly two hashes plus a space.

### Notes

H3 included to prove the script's strict `## ` prefix check rejects
deeper headings — this line does NOT bump h2_count.
