---
target: units-generation
plugin: ddd
adds:
  consumes:
    - artifact: ddd-domain-model
      required: false
  sensors:
    - ddd-conformance
  # requires_stage: [ddd-domain-modeling]
  #   INTENDED ordering edge — makes units-generation run AFTER the domain model so
  #   decomposition is bounded upfront. DEFERRED: doc 18 §6 `adds.requires_stage` is not yet an
  #   implemented merge surface (compose logs it as an advisory drop and ignores it). Uncomment
  #   the line above the day that surface graduates — no other change needed. Until then, upfront
  #   ordering is not enforced; the ddd-conformance gate (after build-and-test) is the backstop.
fragments:
  - anchor: end-of-steps
    order: 100
---

## fragment: end-of-steps

### Step (ddd): Bound decomposition to the domain model

If `ddd-domain-model` is present, treat its `bounded_contexts` as the **default unit boundaries** —
each bounded context maps to one unit of work unless the team explicitly decides otherwise. Confirm
the boundaries against the model rather than eliciting them cold; ask a Business-Domain question only
to resolve a genuine gap or conflict (a story mapping to no context, a unit spanning two contexts, a
term absent from the ubiquitous-language glossary). Do not split an aggregate across units; integrate
contexts via the model's `context_map` seams, not shared state.

This is an ADVISORY pre-check — the advisory `ddd-conformance` sensor reports drift here before code
exists. The hard, blocking enforcement is the `ddd-conformance` gate stage after build-and-test.
