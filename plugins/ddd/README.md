# ddd — Domain-Driven Design plugin

Makes the domain model a **first-class, inviolable deliverable** and enforces it with **deterministic,
blocking controls**: the model compiles into executable tests, and a failing test is a hard stop.

## What it adds

- **Stage `ddd-domain-modeling`** (inception) — produces the structured `ddd-domain-model` artifact
  (ubiquitous language, bounded contexts, context map, entities/value objects, aggregates with finite
  state machines, domain events, and rules). Facilitated event storming: architect leads, product
  supplies business language, business stakeholders confirm at the gate.
- **Stage `ddd-conformance`** (construction, after `build-and-test`) — the hard gate. Derives rule-0
  structural rules from the model, compiles invariants → property tests, FSMs → exhaustive
  transition-matrix tests, business rules → functional tests, runs them, and fails on any failure.
  Also the human adjudication gate: a violation is resolved by fixing the code or by a
  human-approved model amendment (which re-enters `ddd-domain-modeling`).
- **Contributions** (additive, no core edits) — `units-generation` and `functional-design` consume
  the model and gain the advisory `ddd-conformance` sensor (design-time pre-check); `code-generation`
  injects runtime FSM guards + invariant assertions and glossary naming; `build-and-test` folds the
  domain tests into the standing suite.
- **Sensor `ddd-conformance`** — advisory today (framework has no blocking severity yet); reads
  `ddd-conformance-report.json`. Flip `default_severity` to `blocking` when the framework ships it.
- **Scope `ddd-modeling`** — a standalone modeling-only engagement (init → requirements-analysis →
  ddd-domain-modeling; the requirements-analysis contribution joins that core stage to the scope).
  The full build path — both ddd stages including the conformance gate — runs under the core
  `enterprise`/`feature`/`mvp`/`workshop` scopes when the plugin is enabled.

## Enforcement model

The failing test is the single enforcement primitive. Structured rules (structural conformance,
invariant predicates, FSM transitions) are elevated to domain-level enforcement — runtime
guards/assertions + exhaustive/property tests; given/when/then is the example-based fallback. See
`knowledge/aidlc-architect-agent/ddd-modeling-method.md` and the design spec
(`ddd-model-and-rule-schema.md`).

## Design principles held

- **Core immutable** — no `core/` edits; everything is additive via new stages + contributions.
- **Hard gate is a dedicated stage** — `ddd-conformance` owns a real `requires_stage: [build-and-test]`
  edge and runs the tests itself, so enforcement never depends on the deferred `adds.requires_stage`.
- **Portable topology** — `mode: inline` with core reviewer agents, so compose stays clean on every
  harness (no plugin-agent dispatch surface required). Promote to `mob` later for live
  business-in-the-room adjudication once per-harness dispatch surfaces exist.

## Status

Authored against the `core/` stage/sensor/plugin schemas (mirrors `plugins/test-pro/`). Validate with
`aidlc-graph compile` + `scripts/package.ts` before publishing. Advisory sensor + test-based hard gate
today; blocking-sensor severity is a framework capability this plugin is authored to adopt when it
ships.
