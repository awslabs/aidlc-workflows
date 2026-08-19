# Correctness and compatibility lens

Concentrate on semantic behavior that deterministic CI can miss:

- Trace changed behavior through runtime call paths and state transitions.
- Challenge PR claims against the implementation rather than repeating them.
- Look for regressions in behavior the PR says it preserves.
- Check edge cases, error paths, resume/retry behavior, ordering, idempotency,
  concurrency, serialization, and public API compatibility.
- In this repository, verify the hand-authored `core/` or `harness/` source,
  committed `dist/` projections, tests, model-consumed protocols, user guides,
  reference docs, examples, diagrams, events, and handoffs agree.
- Check interactions with adjacent recent behavior instead of reviewing each
  changed hunk in isolation.
- Treat tests as claims: verify they exercise the integration and failure path
  their names and assertions promise.

Do not report conventional application-security or prompt-injection findings;
the other lenses own those unless the same root cause creates a direct runtime
correctness failure.
