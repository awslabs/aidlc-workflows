# Correctness and compatibility lens

Concentrate on semantic behavior that deterministic CI can miss:

- Trace changed behavior through runtime call paths and state transitions.
- Challenge PR claims against the implementation rather than repeating them.
- Look for regressions in behavior the PR says it preserves.
- Check edge cases, error paths, partial writes, interruption, restart,
  resume/retry behavior, ordering, idempotency, concurrency, serialization,
  rollback, mixed-version operation, and public API compatibility.
- Exercise ambiguous selectors, stale state, symlinks, relative and absolute
  paths, and multi-repository boundaries when the changed code can reach them.
- Find fail-open behavior, silent fallback, and validation performed only after
  mutation.
- In this repository, verify the hand-authored `core/` or `harness/` source,
  generated `dist*` projections, tests, model-consumed protocols, user guides,
  reference docs, examples, diagrams, events, and handoffs agree.
- Check interactions with adjacent recent behavior instead of reviewing each
  changed hunk in isolation.
- Treat tests as claims. Verify regression tests fail on the original defect,
  preserve existing assertions, and cover positive, negative, compatibility,
  stale-state, and partial-failure paths that the change promises.

Do not report conventional application-security or prompt-injection findings;
the other lenses own those unless the same root cause creates a direct runtime
correctness failure.
