# AI-DLC Workflows 2.0 - Roadmap

Status as of 2026-07-13. Current released version: **2.3.4** (origin/v2 tip 3c768787).
Full GA is declared at **2.4.0**.

## North star reference

The seven functional goals of the AI-DLC Workflows 2.0 North Star, verbatim in intent:

1. **Mimic what we practice in the real world** - a stage executed by a configurable ensemble (Owner, Collaborator, Verifier) with consistent semantics across harnesses.
2. **Customization of behaviour** - encode new behaviours/policies/constraints in no more than two targeted changes, reusable across harnesses without tool-specific rewrites.
3. **Adaptiveness of workflows** - scale in (report triage to compact Fix, Test, PR) and scale out (decide next stages at boundaries); composition not hard-wired.
4. **Verifier as a true adversary** - adversarial quality gate; may use a different LLM than the producer; validates against machine-checkable evidence; budgeted self-heal loop escalating to HITL.
5. **Support for cyclic, directional flows** - forward progression plus governed, directional feedback loops.
6. **Preserve artefact traceability** - downstream stages enrich upstream artefacts rather than spawning disconnected ones.
7. **Organizational, not project-local, artefact repository** - shared org knowledge layer across projects, intents, and repos; six named scenarios.

## Goal scorecard

| # | Goal | Status | Delivered by | Remaining lands in |
|---|------|--------|--------------|--------------------|
| 1 | Real-world ensemble | Partial | 2.0.x roles + 2.1.8 reviewer wiring | 2.5.0 |
| 2 | Customization | Shipped | 2.0.x rules stack + 2.3.0 plugins | plugin deferred surfaces, stage rules layer |
| 3 | Adaptiveness | Shipped | 2.2.0 composer + scale-in | (boundary auto-assessment deliberately human-initiated) |
| 4 | Verifier as adversary | Partial | 2.0.x reviewer loop, 2.3.1 model split | 2.4.0 |
| 5 | Cyclic flows | Partial | within-stage review loop, HITL hardening | 2.6.0 |
| 6 | Traceability | Partial | artefact graph + upstream-coverage sensor | 2.7.0 (+ community PRs below) |
| 7 | Org repository | Shipped | 2.1.0 spaces/intents/org-KB | done |

## Delivered

| Version | Feature | Goal | Key PRs |
|---------|---------|------|---------|
| 2.0.0 - 2.0.2 | GA Preview: reviewer mechanism, multi-harness core, agent roster | 1, 4 | (v2 baseline) |
| 2.1.0 | Per-intent workspace: spaces, intents, multi-repo, org-KB | 7 | #429 |
| 2.1.2 | Per-unit for_each iteration | 3 | #444 |
| 2.1.3 - 2.1.7 | Loop-integrity hardening: artifact gate, stop-hook, human-presence, dangling consumes | 4, 5 | #443, #466, #482 |
| 2.1.8 | Reviewer wired across all harnesses | 1, 4 | #405 |
| 2.2.0 | Adaptive workflows: composer, scale-in triage, in-flight recompose | 3 | #477 |
| 2.2.1 - 2.2.19 | Hardening line: unit kinds, per-unit reviewer scope, Kiro IDE hooks, optional produces, path quoting | - | #491, #509 - #512, #520 - #522, #525, #537, #538, #471, #544 |
| 2.3.0 | Extensions: plugin mechanism (plugins/<name>/, per-harness emission, compose seam) | 2 | #475 |
| 2.3.1 | Tunable agent tiers (judgment / balanced / templated) | 4 | #546 |
| 2.3.2 - 2.3.3 | Doctor surfaces hook drops; scope-change refused under autonomy | - | #541, #542 |
| 2.3.4 | Deterministic PreToolUse enforcement of reviewer read scope | 4 | #545 |

## In flight (ours, open)

| Version claim | Work | PR | State |
|---------------|------|----|-------|
| 2.3.5 | Plugin content buckets + install-time plugin selection | #550 | Open, tiers green, merge gated |
| 2.3.5 - 2.3.6 | Single-command CLI dispatcher (dark launch) | #560 | Draft, stacked on #550; rebase + retarget after #550 merges |
| 2.3.7 | Phase Progress rows advance at phase boundaries | #562 | Open |
| 2.3.8 | upstream-coverage matches real citation forms | #563 | Open |
| 2.3.17 | opencode harness (5th harness) | #571 | Open, rebased onto v2, merge gated |

Version slots are multi-claimed; whoever merges second rebases and re-bumps (t68 catches misses).

## Outstanding (planned minors)

### 2.4.0 - Reviewer-as-verifier (declares Full GA)

Interpretation locked 2026-07-13: **prompt-only change**. Of Goal 4's four
sentences, "different LLM" is delivered (2.3.1 tier split) and the budget is
delivered (`reviewer_max_iterations` + HITL escalation, reading
"iterations / tokens" as or). What remains:

- Adversarial framing: the shared refute-not-confirm + evidence-grounding contract written once into stage-protocol section 12a, plus a short domain-voiced line in each of the two reviewer personas (`aidlc-product-lead-agent`, `aidlc-architecture-reviewer-agent`).
- Evidence grounding folds sentence 3 in: the reviewer runs the machine checks that already exist (listed validation tools, tests, lint, typecheck, acceptance criteria, consumed contracts); opinion-only findings are suggestions, not NOT-READY.
- Explicitly NOT in scope: token budget, bespoke domain validator tools, new stage-schema fields. Record these scope decisions in the changelog entry.
- No new agent: the two existing reviewers cover all 11 reviewer-declared stages; the per-stage `reviewer:` field already supports adding more later.

### 2.5.0 - Three-role ensemble (Goal 1)

- Collaborators become independent subagents rather than inline voices adopted by the conductor.
- Collaboration pattern (pipeline / swarm / review-loop / mob) becomes a per-stage selectable knob.

### 2.6.0 - Governed cyclic flows (Goal 5)

- Cross-stage backward edges: a downstream stage exposing an upstream gap triggers a governed, engine-managed return. Today the graph compile rejects all cycles and `requires_stage` is forward-only.

### 2.7.0 - Progressive enrichment (Goal 6)

- Downstream stages enrich the same upstream artefact in place instead of emitting linked-but-separate files.
- ADRs as a core design artefact.

## Community PRs advancing goals (open, need shepherding)

| PR | Work | Goal |
|----|------|------|
| #401 | Per-stage traceability enforcement, deterministic JSON sensor | 6 |
| #402 / #403 / #404 | Design-vs-code hygiene, unit-test dedupe, observability NFR consistency | 6 |
| #432 | V2 extension mechanism (likely superseded by 2.3.0 plugins; close or rebase onto the seam) | 2 |
| #526 | Product discovery in Ideation | 3 |
| #535 | In-place upgrade subcommand | - |
| #552 / #553 | Cold-start scope routing; Codex structured selections as human turns | - |

## Known gaps not on the minor ladder

- Rules enforcement (#495): `rules_in_context` paths are emitted but nothing forces the conductor to read them; quietly undermines Goal 2 at runtime.
- Stage-level rules layer (`aidlc-stage-<slug>.md`): reserved, unbuilt (Goal 2).
- Plugin deferred surfaces: agents/scopes/memory/knowledge projection, `when:` evaluation, marketplace (Goal 2).
- Sensor blocking severity (#431): sensors are advisory-only; a gate cannot be halted by a machine check (adjacent to Goal 4, deliberately out of 2.4.0).
- Conductor health cluster (#547, #548, #551) and Kiro IDE 1.0 regressions (#543, #555): pre-GA quality, not goal-mapped.
- Cross-unit discovery propagation (Goal 6): still a real v2 gap, but the only open PR (#300) targets the retired v1 tree (`aidlc-rules/`, base main, 2026-05); it needs a fresh v2 implementation, not a rebase.
