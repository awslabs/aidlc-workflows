---
name: classic
depth: Standard
keywords: []
description: "V1-style ceremony through Inception and Construction - the implicit default"
skeleton: off
review_cap: advisory
guard_policy: off
sensors: on
learnings: on
summary_confirmation: off
plan_approval: on
collaborators: off
---

# classic scope

`classic` is the implicit default scope - used when neither the user nor
`AWS_AIDLC_DEFAULT_SCOPE` names one - and restores v1-style ceremony through
Inception and Construction, with one human approval per stage. Ideation is
skipped and Operation remains a placeholder. Stage-declared execution modes
are unchanged; collaborators are off, so each stage runs with its lead agent
only (`/aidlc --collaborators on` brings the support agents in).

`classic` is tuned for small-batch, token-conserving delivery. It commits only
to the first release (R1) via a release-scoped `requirements.md`, drops the
`delivery-planning` capstone (Bolt grouping, team allocation, external
dependency map — overhead for a single-release slice), and skips the separate
NFR Requirements stage so `nfr-design` runs once per Unit in merged mode:
it elicits non-functional requirements inline and designs their solutions in
one dispatch and one advisory review per Unit, instead of two of each. Teams
that want full delivery planning or the finer NFR separation run `feature` or
`enterprise`.

Guard Policy defaults to off: changed inputs are recorded and announced in one line, and plan approval, review freeze, state transition, and reviewer read scope are lowered for undirected work. Human presence stays up.

Reviews are advisory: one pass per stage whose findings reach the human at
the approval gate, with no refute-and-repair loop; explicit autonomy keeps the
single pre-merge review. Walking-skeleton ceremony and summary confirmation
are off. Sensors run and the learnings ritual runs. Under off, Plan Approval,
review freeze, state transition, and reviewer read scope stand aside for
undirected work and record a `GUARD_STOOD_ASIDE` row each time; the approval
question is still asked by the conductor. Human-turn authority and audit remain
in force.

Override ceremonies per intent with `/aidlc --sensors on|off`,
`/aidlc --learnings on|off`, `/aidlc --summary-confirmation on|off`, and
`/aidlc --collaborators on|off`. The global kill switches
`AIDLC_DISABLE_SENSORS=1`, `AIDLC_DISABLE_LEARNINGS=1`,
`AIDLC_DISABLE_SUMMARY_CONFIRMATION=1`, and `AIDLC_DISABLE_COLLABORATORS=1`
force their ceremony off even when the intent says on; they can also be
recorded with `aidlc config flags --bypass <NAME>`.

## Why these stages, why skip those

AI-DLC v1 had no Ideation phase, so `classic` skips all seven Ideation stages.
It keeps most Inception stages and the Construction stages through Build and
Test. CI Pipeline and all seven Operation stages are skipped: customers bring
their own CI and downstream, and Build and Test is the one integrated build
across every unit.

`classic` also skips `delivery-planning` (2.9). For a release-scoped `classic`
run the Bolt grouping, team allocation, risk/sequencing rationale, and
external-dependency map add little — Construction walks the Unit DAG directly
and the default `Construction Iteration: unit-major` serial walk needs no Bolt
plan. Scopes that need the delivery-planning capstone (teams, program-board
analog, cross-Bolt sequencing argument) run `feature` or `enterprise`.

`classic` skips `nfr-requirements` (3.2) and runs `nfr-design` (3.3) in
merged mode: a single stage dispatch per Unit elicits the non-functional
requirements inline and designs their solutions in one pass, under one
advisory review. The design artifacts (`performance-design.md`,
`security-design.md`, `scalability-design.md`, `reliability-design.md`,
`observability-design.md`, `logical-components.md`) remain the formal outputs
downstream Construction stages consume; the requirements content is
additionally written as informational sibling files
(`performance-requirements.md`, `security-requirements.md`, …) under the same
per-Unit record directory for audit legibility. The finer
requirements-vs-design separation and the second review pass are given up on
`classic`; `feature` and `enterprise` keep both stages for scopes where that
separation is wanted.

Only seven stages are unconditional on `classic`: the three Initialization
stages, Requirements Analysis, Units Generation, Code Generation, and Build
and Test. The remaining Inception and Construction work is CONDITIONAL and
self-selects from project context, preserving v1's adaptive behavior.

Its test strategy inherits Standard from its depth, so production testing
expectations remain in force. The separate `workshop` scope retains the
teaching-oriented Minimal test override for existing workshop workflows.

## Membership

Initialization, Inception excluding `delivery-planning`, and the Construction
stages through Build and Test (with `nfr-requirements` skipped and
`nfr-design` running in merged mode) are in the grid: 16 of 33 stages. All
seven Ideation stages, `delivery-planning`, `nfr-requirements`, CI Pipeline,
and all seven Operation stages are SKIP. The scope intentionally has no
keywords; name it explicitly or use the implicit default.
