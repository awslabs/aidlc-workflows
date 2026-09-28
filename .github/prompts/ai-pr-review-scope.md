# Review scope

Read `.ai-review-context/review-scope.json` before reviewing.

- `mode: "full"`: review the whole PR diff as described by the shared contract.
- `mode: "incremental"`: AIDA already reviewed this pull request at the head
  named in `since`, and that review's findings live in the ledger. Your scope
  is `files[]`: the lines of the PR diff (head coordinates, `RIGHT` side) that
  changed since that review; `deleted[]` lists the base lines (`LEFT` side,
  cited by `previousPath` for a rename) deleted since that review, and
  `deletedFile: true` marks a file deleted since; a listed file admits
  file-level evidence. Read whatever base and head context you need to judge those lines,
  but report candidates only when their evidence cites a line inside the scope.
  Code in the PR diff that has not changed since `since` was reviewable then;
  do not re-review it and do not report findings about it — the publisher
  defers any such finding and it never affects the decision.

Findings about security boundaries, prompt attacks, authorization, credentials,
or trust are exempt: the security lenses always review the full head and their
candidates are never deferred, and neither is any finding that cites a line one
of those lenses cited. If you notice such a defect outside your scope, name it
in one line as a pointer for the security lens instead of a candidate.
