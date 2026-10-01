---
target: functional-design
plugin: ddd
adds:
  consumes:
    - artifact: ddd-domain-model
      required: false
  sensors:
    - ddd-conformance
fragments:
  - anchor: end-of-steps
    order: 100
---

## fragment: end-of-steps

### Step (ddd): Align functional design to the domain model

If `ddd-domain-model` is present, this unit's functional design must project the shared model, not
re-invent it. Bind the projection to this stage's three source-of-truth artifacts:

- **`entities.md`** — every entity in the YAML block traces to an entity, value object, or aggregate
  member declared for this unit's bounded context in the domain model (cite the stable model ID).
  Names come from the `ubiquitous_language` glossary. Cross-context references appear as ID
  references through a declared `context_map` seam — never a shared in-memory type.
- **`rules.md`** — each aggregate `invariant` that this unit realizes appears as a rule tracing to
  its model rule ID. Do not restate rule-0 structural rules (the conformance generator derives
  those); do not weaken a model invariant here.
- **`functional-spec.md`** — the lifecycle state machines conform to the owning aggregate's
  `state_machine`: no transitions beyond the model's edges. A needed extra transition is a model
  amendment (a business decision back in `ddd-domain-modeling`), not a local addition.

ADVISORY pre-check (the `ddd-conformance` sensor reports drift). The hard gate is `ddd-conformance`
after build-and-test.
