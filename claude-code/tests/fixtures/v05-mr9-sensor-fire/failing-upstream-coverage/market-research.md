# Market Research

Fixture for t92 FAILED round-trip — `upstream-coverage` sensor.

The `market-research` stage's frontmatter declares it consumes exactly
one upstream artifact (the intent slug from the previous stage). The
sensor's check runs a case-insensitive word-boundary regex on that
slug plus a wikilink form against this file's body and asserts each
consumed artifact appears at least once.

This file deliberately omits all forms of that slug — no bare token,
no hyphenated mention, no wikilink — so the regex returns no match
and the unreferenced array collects exactly one entry. The
dispatcher's findings-count derivation for upstream-coverage returns
the unreferenced length, so the audit row's Findings count field
MUST equal 1.

Headings below are present so the file passes any incidental shape
check (H2 count is 2), keeping the failure attributable to the
upstream-coverage sensor specifically.

## Competitive Landscape

A summary of competitor offerings — segments, pricing, positioning.

## Build vs Buy

Recommendation: build, with off-the-shelf evaluation framework.
