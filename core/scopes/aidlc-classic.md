---
name: classic
depth: Standard
keywords: []
description: "V1-style ceremony through Inception and Construction - the implicit default"
skeleton: off
review_cap: advisory
guard_policy: relaxed
sensors: on
learnings: on
summary_confirmation: off
---

# classic scope

`classic` is the implicit default scope - used when neither the user nor
`AWS_AIDLC_DEFAULT_SCOPE` names one - and restores v1-style ceremony through
Inception and Construction, with one human approval per stage. Ideation is
skipped and Operation remains a placeholder. Stage-declared execution modes
and support agents are unchanged.

Change Control defaults to relaxed: an input that changes after a human approved or confirmed it is recorded and announced in one line, and the run continues.

Reviews are advisory: one pass per stage whose findings reach the human at
the approval gate, with no refute-and-repair loop; explicit autonomy keeps the
single pre-merge review. Walking-skeleton ceremony and summary confirmation
are off. Sensors run and the learnings ritual runs. Approval gates, Plan Approval, human-turn
authority, audit, and team cross-unit write protection remain in force.

Override ceremonies per intent with `/aidlc --sensors on|off`,
`/aidlc --learnings on|off`, and `/aidlc --summary-confirmation on|off`.
The global kill switches `AIDLC_DISABLE_SENSORS=1`,
`AIDLC_DISABLE_LEARNINGS=1`, and `AIDLC_DISABLE_SUMMARY_CONFIRMATION=1`
force their ceremony off even when the intent says on; they can also be
recorded with `aidlc config flags --bypass <NAME>`.

## Why these stages, why skip those

AI-DLC v1 had no Ideation phase, so `classic` skips all seven Ideation stages.
It keeps all Inception stages and the Construction stages through Build and
Test. CI Pipeline and all seven Operation stages are skipped: customers bring
their own CI and downstream, and Build and Test is the one integrated build
across every unit. Only eight stages are unconditional: the three Initialization stages,
Requirements Analysis, Units Generation, Delivery Planning, Code Generation,
and Build and Test. The remaining Inception and Construction work is
CONDITIONAL and self-selects from project context, preserving v1's adaptive behavior.

Its test strategy inherits Standard from its depth, so production testing
expectations remain in force. The separate `workshop` scope retains the
teaching-oriented Minimal test override for existing workshop workflows.

## Membership

Initialization, every Inception stage, and the Construction stages through
Build and Test are in the grid: 18 of 33 stages. All seven Ideation stages,
CI Pipeline, and all seven Operation stages are SKIP. The scope intentionally has no keywords; name it explicitly
or use the implicit default.
