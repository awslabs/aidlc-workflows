---
target: code-generation
plugin: ddd
adds:
  consumes:
    - artifact: ddd-domain-model
      required: false
fragments:
  - anchor: end-of-steps
    order: 100
---

## fragment: end-of-steps

### Step (ddd): Generate code that honors the domain model (runtime enforcement)

If `ddd-domain-model` is present, generated code must embed the model's guarantees at runtime — this
is where the domain-level rules become always-on, not just test-time:

- **Naming** — domain types, methods, and public API terms come from the `ubiquitous_language`
  glossary; do not introduce synonyms.
- **Aggregates** — expose each aggregate only through its `root`; keep members non-public.
- **FSM guards** — for an aggregate with a `state_machine`, generate a single guarded transition
  function that permits only declared transitions and rejects all others (e.g. `cancel` from
  `SHIPPED`).
- **Invariant assertions** — for each `kind: invariant`, inject a runtime check on the aggregate root
  that re-asserts the predicate after every mutation.
- **Cross-context** — reference other contexts by ID or through the declared `context_map` seam
  (anti-corruption layer), never a shared in-memory type.

The `ddd-conformance` gate after build-and-test verifies these structurally and by test; generating
them correctly here is what makes it pass.
