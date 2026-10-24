# Loop-back Protocol Module

Load this module when the engine lists `loopback` in `directive.protocol_modules`: on every Code Generation and Build and Test step, and every `invoke-swarm`.

### Build-and-Test failure loop-back (3.6 → 3.5)

When Build and Test (3.6) diagnoses a failure whose ROOT CAUSE lies in the
generated code or an approach chosen at code-generation (not in this stage's
own test/build scaffolding), the workflow may return to code-generation and
repair it rather than writing the approach off or dead-ending at the gate.
The stage's Step 9 failure-escalation ladder decides WHEN this fires; this
subsection defines HOW. It is a sanctioned exception to Critical-checklist
item 5's "complete the current stage before jumping": a failed build-and-test
run is deliberately left in-flight — its gate is NOT presented and its enabled §13
learnings ritual DEFERS to the eventual passing run (when the `learnings` module is listed, the stage diary
memory.md persists across the loop; otherwise no diary or ritual runs).

**Which units go back.** The loop-back reopens Code Generation for the
unit(s) the diagnosis names. Every other unit keeps its finished work,
reviews, Plan Approval and checkpoint approval, and is not re-run, reviewed or
asked about again. Only a cause that spans every unit, or cannot be pinned to
one, reopens Code Generation for every unit. Either way the stages before Code
Generation keep their work. Below, an "applicable unit" is a reopened one.

**The loop-back counter** lives in test-results.md under `## Loop-Back Log`:
the count of `### Loop-back N` entries IS the bound (max 3 per intent). This
artifact ledger is chosen over parsing the jump's audit rows because it
survives the backward jump (jumps reset checkboxes, never artifacts), is
colocated with the diagnosis it must carry anyway, and is readable at the
final gate; the rows the jump tool emits (a `STAGE_JUMPED` for every unit, a
unit-tagged `GATE_REJECTED` per reopened unit) remain the
deterministic audit cross-check. The log is append-only. A human-directed
backward jump does not count against the bound — only entries this protocol
writes do.

**Plan approval on replay.** The jump opens a new stage attempt for each
unit it reopens, so that unit's prior Plan Approval (bound to the previous
attempt) cannot authorize the replay.
Preserve the Loop-Back Log; after the repaired plan is written, `next` asks the
person for Plan Approval again before generation (Code Generation Step 3). The
human's "Retry with fix" choice authorizes the loop-back jump; it is not approval
of plan content the human has not reviewed under the new attempt.

**Autonomous loop-back procedure** (mode `autonomous`, bound not exhausted,
impact-estimated fix identified):
1. Append the `### Loop-back N — <ISO timestamp>` entry (Diagnosis /
   Root-cause stage / Planned fix / Estimated impact) to test-results.md and a matching
   Deviations entry to this stage's memory.md.
2. Execute the jump through the ENGINE: for each unit the diagnosis names,
   run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts next --stage
   code-generation --unit <unit>` and run the command its `print` directive
   names verbatim before the next unit (an `aidlc-jump.ts reopen --target
   code-generation ... --units <unit>` that reopens that unit and moves
   Current Stage back to Code Generation). Only for a cause that spans every
   unit, or names none, run `next --stage code-generation` instead: it runs
   `aidlc-jump.ts execute --target code-generation --direction backward
   --scope <scope>` itself, which resets Code Generation and the stages after
   it for every unit and emits the canonical `STAGE_JUMPED`, and returns Code
   Generation's step. When Construction runs
   stage by stage (`Construction Iteration` in aidlc-state.md is not
   `unit-major`), one unit cannot be reopened alone: run that
   `next --stage code-generation` at once, without asking; "Retry with fix"
   (or the autonomy grant) already chose the repair. After a `reopen`, re-run
   `next`; then continue the forwarding loop from the step that comes back.
   Never compose the `reopen` or `execute` call by hand: the engine's print
   is the validated form.
3. On the code-generation re-entry, follow "Re-entry settlement and review"
   below. Before any fix generation, the engine asks for Plan Approval of the
   repaired plan as required above; this is a human stop even though Construction
   autonomy remains granted. Then apply the planned fix ONLY to the unit(s) the diagnosis names and
   apply the deterministic Artifact Re-use decisions (see "Autonomous failure
   loop-back" under Artifact Re-use in stage-protocol.md). The standing
   `Construction Autonomy Mode: autonomous` grant is unchanged by the jump;
   after every applicable unit has a fresh current-attempt review, the replayed
   completion follows the current checkpoint/policy directive. Automatic
   completion omits `--user-input`; never label a conductor decision as the
   human's answer. Fresh Plan Approval is still mandatory.
4. Build and Test then re-runs naturally on the forward replay; choose Modify
   at its own Artifact Re-use prompt (never Redo — it would erase the
   Loop-Back Log) and re-execute Step 9 fresh.

**Re-entry settlement and review.** Backward jumps preserve artifacts, but the
route depends on whether code-generation has ever used the unit lifecycle
ledger:

1. **Artifact-only workflow** — when no code-generation lifecycle row has ever
   been emitted and Construction checkpoints are off (with them on, receipts
   are required from the first unit), artifacts remain the settlement signal. The re-entry `next`
   call can therefore emit the all-covered `gate: true` fast path. Apply the
   planned fix and the deterministic Modify/Keep decisions through the
   re-entry override BEFORE presenting or auto-approving that gate.
2. **Receipt-mode workflow** — once any code-generation lifecycle row exists,
   receipt mode is sticky (with Construction checkpoints on it applies from the
   first unit). The reopen invalidates each applicable unit's old
   settlement receipts, so re-entry emits per-unit `run-stage` directives for
   those units. For each applicable unit,
   re-mint `unit start` / `unit complete`, applying the planned fix to targeted
   units and the deterministic **Modify targeted / Keep rest** Artifact Re-use
   decision inline as that unit re-runs.

On BOTH paths, after every fix and re-use decision and BEFORE presenting or
auto-approving the settle/approval gate, dispatch code-generation's declared
reviewer for every applicable unit and record fresh current-attempt
`REVIEW_COMPLETED` receipts. The reopen invalidates each applicable unit's
prior review receipts (every unit's, after the stage-wide `STAGE_JUMPED`), and
the engine refuses approval while any applicable unit lacks a fresh one. Under unit-major iteration the autonomous swarm never
fires: the replay follows the ordinary per-unit walk, re-mints lifecycle and
review receipts per unit as above. Fresh target-bound Plan Approval remains
a human stop for the repair; autonomy does not waive it.

**Swarm interaction.** On a loop-back replay where the engine emits
`invoke-swarm`, the jump establishes a new exact stage-attempt `Run floor`
boundary token (`<event>:<timestamp>#<ordinal>` over workflow start, jump,
rejection, and stage start boundaries). Each `SWARM_UNIT_CONVERGED` row must
match the current token, so prior-attempt rows no longer count and all units
re-dispatch by default. Before `prepare`, use `worktree list` and `worktree info`
to identify the selected intent's worktrees and branches left by the prior
attempt (a crash or a halt-and-ask mid-swarm leaves them in place):
`prepare` hard-errors on collision, and
`finalize` refuses a unit without the current attempt's prepare stamp, so
discard the stale worktrees/branches before a fresh `prepare` — never adopt
them into the new attempt. Discard only the selected intent's Bolts: matching
Unit slugs in another intent are not stale siblings, and cleanup refuses a
branch checked out at a foreign worktree path (surface the owner path rather
than deleting it).
Discard parks each attempt; its snapshot remains
recoverable with `{{INVOKE}} engine worktree restore --slug <slug>` in a
separate restored checkout, never as current-attempt evidence. Do not spend a worker turn per unit: after
`prepare`, run
`check <unit> --check-cmd "<the project's convergence check>"` on every unit
FIRST. A unit already green needs no builder turn, but before putting it in
`finalize --claimed`, dispatch code-generation's reviewer in that fresh
worktree and record a terminal current-attempt `REVIEW_COMPLETED`. `finalize`
then verifies the current prepare stamp, the terminal receipt, and its current
artifact fingerprint before accepting the claim. Dispatch workers only for the
unit(s) the Loop-Back Log's planned fix targets or that fail the check, then
run the same reviewer pass after their final changes. The cheap path assumes
the prior attempt's code is in the base the worktrees forked from — true only
once that attempt's git code merge actually completed; if it did not (the
attempt halted before finalizing), every `check` comes back red and the cheap
path degrades gracefully to full re-dispatch rather than silently claiming
unbuilt units.

**Halt-and-ask, impact-estimated variant (gated or unset mode, or bound exhausted, WITH
a candidate fix identified):**

```question
prompt: "Build and Test failed: [short error]. Root cause: [diagnosis]. Candidate fix: [fix] — estimated impact — effort: [effort]; financial cost: [cost]; risk: [risk]. Loop-backs used: [N]/3. How would you like to proceed?"
header: Build Failure
multiSelect: false
options:
  - label: Retry with fix
    description: Jump back to code-generation, apply [fix] (estimated impact — effort: [effort]; financial cost: [cost]; risk: [risk]), re-run.
  - label: Accept failure
    description: Log the failure in test-results.md and proceed to this stage's approval gate.
  - label: Abort
    description: Stop here; the workflow can resume later.
```

**Halt-and-ask, no-fix variant (no identifiable fix exists in any swappable
dimension):** omit "Retry with fix" entirely — presenting it without a
candidate fix would itself be the impact-unestimated give-up option this protocol
forbids in the other direction (a fabricated fix to retry with). Use:

```question
prompt: "Build and Test failed: [short error]. Root cause: [diagnosis]. No identifiable fix exists in any swappable dimension (library/version, container image, instance type, algorithm, flag). Loop-backs used: [N]/3. How would you like to proceed?"
header: Build Failure
multiSelect: false
options:
  - label: Accept failure
    description: Log the failure in test-results.md and proceed to this stage's approval gate.
  - label: Abort
    description: Stop here; the workflow can resume later.
```

Choose the variant by whether rung 2's classify-and-estimate step actually
produced an impact-estimated candidate fix — never render the impact-estimated template's
`Candidate fix` / `Retry with fix` slots with placeholder or invented
content just to keep the template shape.

"Retry with fix" runs the same settlement-aware procedure as the autonomous
loop-back, including its re-entry override (see "Gated failure loop-back" under
its Artifact Re-use below). Artifact-only workflows may take the
all-covered `gate: true` fast path; receipt-mode workflows instead re-emit
per-unit directives. On either path the planned fix and deterministic
Modify/Keep decisions MUST be applied BEFORE the settle/approval gate, and
every applicable unit MUST receive a fresh current-attempt review before that
gate is presented. A human-approved retry does count an entry in the Loop-Back
Log, and the human may override the bound explicitly. Every option's
description must carry its estimated impact where one is known — presenting an
impact-unestimated give-up option is a protocol violation.

### Artifact Re-use on a failure loop-back replay

On a replay the failure loop-back started, stage-protocol.md's Artifact Re-use question (Keep, Modify, Redo) is decided as follows.

**Autonomous failure loop-back**: when the replay was initiated by the
Build-and-Test failure loop-back in the loop-back protocol module
(`aidlc-common/protocols/stage-protocol-loopback.md`) under `Construction
Autonomy Mode: autonomous`, the 3-option question is NOT presented (the loop is
meant to run without the human). The conductor decides deterministically from
the Loop-Back Log's planned fix: **Modify** for the unit(s) the fix targets,
**Keep** for all other units, **Modify** for build-and-test itself on re-entry
(Redo is forbidden there — it would erase the Loop-Back Log). Every
auto-decision is still audited via `aidlc-state.ts reuse-artifact <slug>
--decision <keep|modify> --artifacts "<comma-separated list of existing
artifacts found>"`. In receipt mode apply those decisions inside each emitted
per-unit replay between `unit start` and the fresh reviewer / `unit complete`;
in artifact-only mode apply them through the pre-gate override. Either way,
fresh current-attempt reviews for every applicable unit are mandatory before
the replayed gate is auto-approved.

**Gated failure loop-back**: the same override applies when the human chose
"Retry with fix" at the Build-and-Test halt-and-ask in the loop-back
protocol module (`aidlc-common/protocols/stage-protocol-loopback.md`) under
`Construction Autonomy Mode: gated` (or unset). Artifact-only workflows may
arrive directly at the all-covered `gate: true` directive, where the ordinary
Artifact Re-use question never fires; receipt-mode workflows instead receive
per-unit replay directives. In the fast path, BEFORE presenting the gate,
apply the planned fix through the override. In receipt mode, apply it inline
while the units re-run. Both use **Modify** for the unit(s) the fix targets,
**Keep** for all other units, and **Modify** for build-and-test itself on
re-entry (Redo is forbidden there — it would erase the Loop-Back Log), audited
via the same `aidlc-state.ts reuse-artifact <slug> --decision <keep|modify>
--artifacts "<comma-separated list of existing artifacts found>"` call. After
those decisions, dispatch the declared reviewer for every applicable unit and
record fresh current-attempt reviews BEFORE presenting the settle/approval
gate. The human already gave the confirming decision by choosing "Retry with
fix"; this is not a second, silent autonomy inference.
