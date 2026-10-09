# Specialized candidate output (structured)

This specialized lens produces candidates for the later AIDLC review, not a
GitHub verdict. Return one JSON object matching the provided schema:

```json
{
  "marker": "[LENS-REVIEWED] <lens> <head sha>",
  "status": "complete",
  "candidates": [
    {
      "priority": "P1",
      "title": "concise title",
      "evidence": [{"source": "DIFF", "path": "path/to/file", "line": 42, "side": "RIGHT"}],
      "problem": "concrete condition -> execution or workflow path -> observable failure",
      "impact": "who meets it on which normal-run path, and why this priority fits",
      "requiredCorrection": "the smallest change that keeps the person in charge"
    }
  ]
}
```

Evidence uses the same shapes as the final review: `{"source":"DIFF","path",
"line","side"}` for a changed line recorded in `changed-files.json` (`RIGHT` for
a head line, `LEFT` for a deleted base line, the previous path on `LEFT` for a
rename); `{"source":"DIFF_FILE","path"}` for a changed file without line hunks;
`{"source":"PR_TITLE"|"PR_BODY","quote"}` for an attack located only in PR
metadata. Every candidate needs at least one evidence item; put related
unchanged locations in `problem`. Order candidates P0 through P3 and merge
candidates with one root cause. If the lens has no confirmed candidates, return
an empty `candidates` array. If repository inspection or the command sandbox
fails, set `status` to `blocked` instead of claiming there were no candidates.
Set `marker` to exactly the marker requested in the invocation prompt.

The publisher reads this evidence deterministically: a final finding that cites
a line or file one of the security lenses cited here is never deferred by the
incremental review scope, whatever category the judge assigns it.
