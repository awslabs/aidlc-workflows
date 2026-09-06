# Authoring Best Practices

Methodology knowledge for creating and editing mabl tests with reliable, maintainable
assertions.

## Negative Constraints (Give These to the Authoring Agent)

When initiating a mabl authoring session (create or edit), always include these
explicit negative constraints in the `test_case` description:

1. **Do NOT assert time-of-day greetings.** Apps showing "Good morning/afternoon/evening"
   are clock-dependent. Confirm login success on a stable element (the user's name,
   a nav link, or the app shell).

2. **Do NOT use GenAI/visual assertions** for tests that must pass in local CLI runs.
   Local execution disables them by default. Use DOM-based assertions instead.

3. **Do NOT assert exact values** that are randomized per request (prices, timestamps,
   session tokens). Assert **format and counts** instead.

4. **Use only `data-testid`, `aria-label`, role, or stable class selectors.** Never
   use generated ids, pixel coordinates, or nth-child indices.

5. **Do NOT assert full text strings** that include dynamic content. Use
   `AssertContains` on unique substrings rather than `AssertEquals` on full text.

## Selector Strategy (Stability Hierarchy)

Prefer selectors in this order:
1. `data-testid="..."` — explicitly for testing, survives refactors
2. `aria-label="..."` or `role` — semantic, accessibility-correct
3. Stable CSS class (`.transfer-card`, `.nav-link`)
4. Text content (as last resort, partial match only)

**Name test IDs in the design phase.** When working from a spec, put the
`data-testid` values in the design document before authoring. The authoring agent
gets every step right when given literal selectors and invents wrong ones where it
has only intent.

## Conditional Branch Validation

**Read every conditional branch in a generated test by hand.** An untaken branch
is unvalidated code. The authoring agent reports success based only on paths it
executed during authoring. An `IF` whose condition was false was never run — wrong
steps inside it ship silently.

After authoring:
1. Diff intent vs generated steps for each `IF` body
2. Verify conditional actions have literal selectors, not inferred intent
3. Promote and re-run only after the hand review

## Assertion Specificity (A/B Test)

A test that passes is necessary but not sufficient — it must be specific enough to
catch a reversion.

**Post-authoring assertion audit:**
1. Map each acceptance criterion to a test assertion
2. For each criterion with no assertion, add one (`AssertContains` on unique content)
3. **A/B specificity test:**
   - Revert the code change → run the test → it MUST FAIL
   - Restore the code → run → it MUST PASS
   - If it passes both ways, the assertions aren't specific enough

## Count-Based Assertions

Count assertions (e.g. `element_count == 7`) are strong regression sentinels but
couple the test to seed data. Use them when:
- The seed data is stable and well-defined
- The count is a direct output of the feature under test
- Document the coupling so future data changes don't cause false failures

Prefer `> 0` or `>= expected_minimum` over exact counts when data varies.

## Demo Flag Awareness

Applications with feature flags (like `transferConfirmDialog`) add modal flows that
tests authored without the flag cannot handle. Before authoring:
1. Check active demo flags (`GET /api/demo-flags` or equivalent)
2. Decide: author the test WITH the flag (future-proof) or WITHOUT (simpler path)
3. Document which flags were active during authoring in the test description

## Authoring Session Expectations

- **Create sessions:** 30–45 minutes (measured: 9-group create took 44 min)
- **Edit sessions:** 5–15 minutes (measured: one-step edit took 7 min)
- **Validation:** The agent reports "validated 100%" based on paths it executed —
  this does NOT mean all branches work

Always launch authoring detached for sessions longer than a test run.
