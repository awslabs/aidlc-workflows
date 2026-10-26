# Intent Statement

Fixture for t92 FAILED round-trip: `required-sections` sensor.

This file ships ONE H1 and zero H2 headings on purpose. With no template
the sensor requires no heading, so t92 writes the team's template for
intent-statement.md with two `##` sections; the sensor counts distinct
`^## ` headings (H1 `#` and H3 `###` are excluded by the literal `## `
startsWith check) and emits pass=false for each template section the
file lacks.

Findings count: the two template sections are both missing, so the
audit row's `Findings count` field MUST equal 2.

Body intentionally written as flowing paragraphs without `##` headings;
a single H3 below would still leave h2_count at 0 because the script's
`startsWith("## ")` check requires exactly two hashes plus a space.

### Notes

H3 included to prove the script's strict `## ` prefix check rejects
deeper headings: this line does NOT bump h2_count.
