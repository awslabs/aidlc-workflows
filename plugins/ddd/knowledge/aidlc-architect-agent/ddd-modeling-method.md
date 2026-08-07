# DDD Modeling Method (ddd plugin)

Methodology knowledge for the architect (and product) when running `ddd-domain-modeling` and
`ddd-conformance`. The domain model is a **first-class, inviolable deliverable** — a structured
contract that bounds decomposition, design, and code, enforced by tests.

## The enforcement thesis

The failing test is the single enforcement primitive. The `ddd-conformance` gate compiles the domain
model into executable tests and runs them; a failure is a hard stop. Maximize what can be expressed
**structurally**, because structure is elevated to domain-level (rule-0) deterministic enforcement —
runtime guards/assertions plus exhaustive/property tests — while given/when/then is only an
example-based fallback.

| Enforcement class | Rule kinds | Source | Compiles to |
|-------------------|-----------|--------|-------------|
| Domain-level (rule 0), hard | structural conformance; data/cardinality invariants; state transitions (FSM) | conformance derived from model shape; invariants + FSM authored as structured declarations | runtime enforcement + exhaustive/property tests |
| Business tier (1..N) | anything not structurable (temporal, cross-aggregate, process) | authored given/when/then | example functional tests |

## Building the model (ddd-domain-modeling)

1. **Ubiquitous language** — one business term per concept; flag implementation coinages as internal.
2. **Bounded contexts + context map** — name contexts and their integration seams (ACL, etc.).
3. **Entities vs value objects** — identity test: interchangeable when values match → value object;
   tracked over time → entity.
4. **Aggregates** — one root, a single-transaction invariant, kept small.
5. **Structured rules — reach for the tightest form:**
   - `state_machine` on an aggregate for lifecycles (disallowed transitions become derived rule-0);
   - `kind: invariant` with `expr` for data/cardinality (→ runtime assertion + property test);
   - `kind: functional` (given/when/then) only when neither fits.
6. Write `ddd-domain-model.md`: machine-checkable YAML frontmatter + prose body; stable IDs
   `{project}.{context}.{type}.{name}`.

Brownfield: seed from `business-overview.md` (Business Dictionary → glossary; Component descriptions →
candidate contexts; Business Transactions → candidate events). Extraction never infers identity or
aggregate boundaries — decide those with the team.

## Enforcing the model (ddd-conformance)

Derive rule-0 structural rules from the model; compile invariants → property tests, FSM → exhaustive
(state × event) transition-matrix test, functional rules → example tests; verify the runtime guards
and assertions injected at code-generation are present; run everything; fail on any failure.

Structural-test tooling is per-project (JVM → ArchUnit; TS/JS → dependency-cruiser / ts-arch; Python
→ import-linter / pytest-arch). The rules are language-neutral; the generator targets the declared
stack.

## Adjudication and amendment

A conformance failure forks: fix the code (technical) or amend the model (business — relaxing an
invariant, changing an FSM edge, or renaming a term changes business meaning, so it needs PM /
stakeholder sign-off and re-enters `ddd-domain-modeling`, bumping `version`). Downstream stages
consume the model and never mutate it — that is what keeps the domain inviolable while allowing
legitimate refinement.
