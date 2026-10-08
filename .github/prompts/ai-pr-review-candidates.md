# Specialized candidate output

This specialized lens produces candidates for the later AIDLC review, not a
GitHub verdict. For each candidate use:

```markdown
**P1 candidate: concise title**

Evidence: `path/to/file:line-range` and any related locations.
Problem: concrete condition -> execution or workflow path -> observable failure.
Impact: who meets it on which normal-run path, and why this priority fits.
Suggested fix: the smallest change that keeps the person in charge (judge rules).
```

Order candidates P0 through P3. Merge candidates with one root cause. If the
lens has no confirmed candidates, write `No candidates.` If repository
inspection or the command sandbox fails, state that the review was blocked
instead of claiming there were no candidates. End with the exact marker
requested in the invocation prompt.
