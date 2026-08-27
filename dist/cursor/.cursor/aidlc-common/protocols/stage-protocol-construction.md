# Construction Protocol Module

Load this module on the first Construction-phase directive of the session and on every `invoke-swarm`; use only the harness subsection that matches the active harness.

**Applicability.** Bolt, walking-skeleton, ladder, autonomy, and per-Unit
ceremonies apply only when the engine resolved a real non-empty Unit DAG.
`directive.unit` or `directive.wave` identifies Unit work;
`directive.swarm_settled` identifies the gate-only end of an autonomous Unit
run. A zero-Unit directive has none of those fields: run it once as an ordinary
stage, with no Bolt, skeleton, ladder, or swarm ceremony. Reviewer work in this
module applies only when `directive.reviewer` is present.

### Construction Bolt gates (walking skeleton + ladder + halt-and-ask)

> **Status — two layers.** Follow the shipped layer; do not run the planned
> Bolt-major layer as conductor procedure.
>
> **Shipped:** walking-skeleton *stance* classification (`gate: "unresolved"`
> in the harness bindings; resolution order `org.md` → `team.md` →
> `project.md`), the first Construction EXECUTE-stage gate
> (`isSkeletonGateStage`), the ladder prompt after that gate, halt-and-ask on
> Code Generation failure (including swarm/worktree `BOLT_FAILED`), and the
> Build-and-Test loop-back sibling below. `BOLT_STARTED` / `BOLT_COMPLETED`
> fire only on the swarm / worktree path. A default gated run does not record
> them.
>
> **Non-executable future-state:** any instruction in this subsection to treat
> a Bolt as one pass through 3.1–3.5, to gate a Bolt's combined design
> artifacts and generated code, to emit `BOLT_COMPLETED` on the default gated
> walk, or to present subsequent Bolt-level / per-Bolt-batch gates. The
> default walk is stage-major; runtime batches come from
> `unit-of-work-dependency.md`. The planned ceremony is kept here as design
> intent until a later walk consumes `bolt-plan.md`.

Construction introduces a walking-skeleton stage gate, a one-time ladder, and halt-and-ask on Code Generation failure. The shipped walk is the **Engine-driven per-unit iteration** block later in this module. Planned Bolt-major variants are marked below.

**Walking-skeleton gate (first in-scope Construction EXECUTE stage)**

When the resolved Unit DAG is non-empty and the applicable skeleton stance
selects the walking-skeleton ceremony, the first in-scope Construction
EXECUTE stage (`isSkeletonGateStage`) always presents a stage-level approval
gate regardless of autonomy mode. That gate covers that stage's artifacts
across the Units that have settled — not a Bolt's combined design artifacts
and generated code. Audit: emit `GATE_APPROVED` as usual. `BOLT_COMPLETED`
is not emitted on this gate. Skeleton-off uses the ordinary first-stage gate;
a zero-Unit stage has no skeleton or Bolt ceremony at all.

> **Planned (non-executable).** A later Bolt-major walk would present a
> Bolt-level gate covering that Bolt's design artifacts and generated code
> together, with the enclosing `BOLT_COMPLETED` tying the gate to the Bolt.

**Ladder prompt (fires once, immediately after walking skeleton gate)**

After an actual walking skeleton's gate approves, present exactly one ladder
prompt. Do not present it for skeleton-off or zero-Unit execution:

```question
prompt: "The walking skeleton shipped. How should the remaining Bolts run?"
header: Autonomy
multiSelect: false
options:
  - label: Continue autonomously
    description: Build the remaining Bolts without stopping to check in. I still stop and ask if something fails.
  - label: Gate every Bolt
    description: Stop for your approval after each Bolt (or each parallel batch).
```

The shipped option labels still say "remaining Bolts" / "Gate every Bolt"; they govern remaining Construction *stage* gates, not Bolt-level gates.

- Record the answer in `aidlc-state.md` as `Construction Autonomy Mode: autonomous` or `Construction Autonomy Mode: gated` via `aidlc-bolt.ts set-autonomy --mode <choice>` (which emits `AUTONOMY_MODE_SET` itself).
- The ladder choice is set-autonomy-owned, like an approval choice is report-owned: do NOT call `aidlc-log.ts decision` or `aidlc-log.ts answer` for it. Switching to `autonomous` requires the human's fresh turn (the ladder answer) — logging the choice as an interview answer first would consume that turn and the mode switch would refuse.
- On the default walk, `autonomous` skips the remaining Construction stage gates except halt-and-ask, the Build-and-Test loop-back's rung 4, and the swarm settle `gate: true` re-entry (the conductor auto-approves that settle under autonomy).
- Session resume: if `Construction Autonomy Mode: unset` but the walking skeleton is already `[x]` complete, re-fire the ladder prompt before executing the next Construction stage.

**Subsequent Bolt gate (per autonomy mode)**

> **Planned (non-executable).** Under a later Bolt-major walk, Bolts after the
> walking skeleton would present a Bolt-level gate only if `Construction
> Autonomy Mode: gated`. In `autonomous` mode that gate would be skipped. For
> parallel Bolt batches the gate would cover every Bolt in the batch. The
> shipped walk does not present subsequent Bolt-level gates.

**Halt-and-ask on failure**

When Code Generation returns failure, **always halt and present the halt-and-ask prompt regardless of autonomy mode**. This is one of two cases where `autonomous` mode stops to consult the user — the other is the Build-and-Test failure loop-back's rung 4 (below: "Build-and-Test failure loop-back (3.6 → 3.5)"), which halts when the loop-back bound is exhausted or no identifiable fix exists.

- Solo Unit failure: halt immediately; on the swarm / worktree path emit `BOLT_FAILED` (with `--slug` for halt-and-ask correlation), present retry / skip / abort.
- Parallel batch partial failure: wait for all parallel Tasks to return, preserve successful Units' artifacts, emit `BOLT_FAILED` for the failed Unit with `Succeeded=[names]`, present `"Units [X, Y] succeeded, Unit [Z] failed with: [error]. Options: retry Z, skip Z, abort Construction."`
- Retry: re-run the failed Unit only inside the existing worktree.
- Skip: mark `[S]` in state with reason, proceed to next batch. Worktree at `<path>` is preserved.
- Abort: stop Construction; user can resume later. Worktree at `<path>` is preserved.

The orchestrator runs `bun .cursor/tools/aidlc-worktree.ts info --slug <slug>` to obtain the worktree `<path>` and `<branch_name>` deterministically before composing the halt-and-ask question. See `SKILL.md` § "Halt-and-ask failure handling" for the full tool-call sequence and the `worktree-info-schema.md` knowledge file for the JSON contract.

```question
prompt: "Bolt [Z] failed during code generation: [short error]. Worktree at [path] on branch [branch_name]. How would you like to proceed?"
header: Bolt Failure
multiSelect: false
options:
  - label: Retry
    description: Re-run Bolt [Z] in the existing worktree.
  - label: Skip
    description: Mark Bolt [Z] skipped; worktree preserved.
  - label: Abort
    description: Stop Construction; worktree preserved.
```

### Build-and-Test failure loop-back (3.6 → 3.5)

When Build and Test (3.6) diagnoses a failure whose ROOT CAUSE lies in the
generated code or an approach chosen at code-generation (not in this stage's
own test/build scaffolding), the workflow may return to code-generation and
repair it rather than writing the approach off or dead-ending at the gate.
The stage's Step 9 failure-escalation ladder decides WHEN this fires; this
subsection defines HOW. It is a sanctioned exception to the NO EMERGENT
BEHAVIOR RULE (like the revision escape hatch) and to Critical-checklist
item 5's "complete the current stage before jumping": a failed build-and-test
run is deliberately left in-flight — its gate is NOT presented and its §13
learnings ritual DEFERS to the eventual passing run (the stage diary
memory.md persists across the loop).

**The loop-back counter** lives in test-results.md under `## Loop-Back Log`:
the count of `### Loop-back N` entries IS the bound (max 3 per intent). This
artifact ledger is chosen over parsing STAGE_JUMPED audit rows because it
survives the backward jump (jumps reset checkboxes, never artifacts), is
colocated with the diagnosis it must carry anyway, and is readable at the
final gate; the STAGE_JUMPED rows the jump tool emits remain the
deterministic audit cross-check. The log is append-only. A human-directed
backward jump does not count against the bound — only entries this protocol
writes do.

**Plan approval on replay.** The jump creates a new directive authority epoch,
so the prior Plan Approval receipt cannot authorize the replay. Preserve the
Loop-Back Log, but blank `[Answer]:`, regenerate the target-bound fingerprint,
and run Code Generation's Plan Approval decision/human-turn/answer receipt
sequence again before generation. The human's "Retry with fix" choice authorizes
the loop-back jump; it is not approval of plan bytes or a directive issued
after that choice.

**Autonomous loop-back procedure** (mode `autonomous`, bound not exhausted,
impact-estimated fix identified):
1. Append the `### Loop-back N — <ISO timestamp>` entry (Diagnosis /
   Root-cause stage / Planned fix / Estimated impact) to test-results.md and a matching
   Deviations entry to this stage's memory.md.
2. Execute the jump through the ENGINE: run
   `bun .cursor/tools/aidlc-orchestrate.ts next --stage code-generation`.
   The engine validates the target and answers with a `print` directive naming
   the exact `aidlc-jump.ts execute --target code-generation --direction
   backward --scope <scope>` command; run that printed command verbatim (it
   resets the target + downstream stages, emits the canonical `STAGE_JUMPED`,
   and pivots Current Stage), then re-run `next` and continue the forwarding
   loop. Never compose the `execute` call by hand — the engine's print is the
   validated form.
3. On the code-generation re-entry, follow "Re-entry settlement and review"
   below. Before any fix generation, run the fresh target-bound Plan Approval
   sequence required above; this is a human hard stop even though Construction
   autonomy remains granted. Then apply the planned fix ONLY to the unit(s) the diagnosis names and
   apply the deterministic Artifact Re-use decisions (see "Autonomous failure
   loop-back" under Artifact Re-use in stage-protocol.md). The standing
   `Construction Autonomy Mode: autonomous` grant is unchanged by the jump;
   after every applicable unit has a fresh current-attempt review, the replayed
   completion gate is auto-approved under it with
   `--user-input "Autonomous loop-back N per construction protocol module"` —
   the human already approved the original run of this stage; the replay is a
   repair of that approved shape, not a new autonomy inference (checklist item
   6).
4. Build and Test then re-runs naturally on the forward replay; choose Modify
   at its own Artifact Re-use prompt (never Redo — it would erase the
   Loop-Back Log) and re-execute Step 9 fresh.

**Re-entry settlement and review.** Backward jumps preserve artifacts, but the
route depends on whether code-generation has ever used the unit lifecycle
ledger:

1. **Artifact-only workflow** — when no code-generation lifecycle row has ever
   been emitted, artifacts remain the settlement signal. The re-entry `next`
   call can therefore emit the all-covered `gate: true` fast path. Apply the
   planned fix and the deterministic Modify/Keep decisions through the
   re-entry override BEFORE presenting or auto-approving that gate.
2. **Receipt-mode workflow** — once any code-generation lifecycle row exists,
   receipt mode is sticky. The jump invalidates the old attempt's settlement
   receipts, so re-entry emits per-unit `run-stage` directives. For each
   applicable unit, re-mint `unit start` / `unit complete`, applying the planned
   fix to targeted units and the deterministic **Modify targeted / Keep rest**
   Artifact Re-use decision inline as that unit re-runs.

On BOTH paths, after every fix and re-use decision and BEFORE presenting or
auto-approving the settle/approval gate, dispatch code-generation's declared
reviewer for every applicable unit and record fresh current-attempt
`REVIEW_COMPLETED` receipts. The backward jump's `STAGE_JUMPED` invalidates
every prior review receipt, and the engine refuses approval while any applicable
unit lacks a fresh one. Under unit-major iteration the autonomous swarm never
fires: the replay follows the ordinary per-unit walk, re-mints lifecycle and
review receipts per unit as above, and the plan-approval carve-out keeps the
autonomous repair free of an extra human turn.

**Swarm interaction.** On a loop-back replay where the engine emits
`invoke-swarm`, the jump establishes a new exact stage-attempt `Run floor`
boundary token (`<event>:<timestamp>#<ordinal>` over workflow start, jump,
rejection, and stage start boundaries). Each `SWARM_UNIT_CONVERGED` row must
match the current token, so prior-attempt rows no longer count and all units
re-dispatch by default. Before `prepare`, check for worktrees or
`bolt-<slug>` branches left by the prior attempt (a crash or a halt-and-ask
mid-swarm leaves them in place): `prepare` hard-errors on collision, and
`finalize` refuses a unit without the current attempt's prepare stamp, so
discard the stale worktrees/branches before a fresh `prepare` — never adopt
them into the new attempt. Do not spend a worker turn per unit: after
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
Artifact Re-use in stage-protocol.md). Artifact-only workflows may take the
all-covered `gate: true` fast path; receipt-mode workflows instead re-emit
per-unit directives. On either path the planned fix and deterministic
Modify/Keep decisions MUST be applied BEFORE the settle/approval gate, and
every applicable unit MUST receive a fresh current-attempt review before that
gate is presented. A human-approved retry does count an entry in the Loop-Back
Log, and the human may override the bound explicitly. Every option's
description must carry its estimated impact where one is known — presenting an
impact-unestimated give-up option is a protocol violation.


---

### Within-Bolt Question Collection (Construction)

> **Non-executable future-state (planned Bolt-major ceremony).** The
> numbered steps below are design intent. Do not collect questions by Bolt,
> do not present a Bolt-level answers gate, and do not replace Code
> Generation's completion gate with a Bolt-level gate on the default walk.
> Follow **Engine-driven per-unit iteration** and the receipts / waves /
> unit-major blocks instead.

> The planned Bolt-major ceremony would run Construction **Bolt by Bolt**.
> Within each Bolt, questions across the Bolt's Units would be collected
> upfront before any artifacts or code were produced:
>
> 1. **Questions**: For each applicable design stage (3.1–3.4), for each Unit in the Bolt (in build order), execute the stage file in QUESTION-ONLY mode. Questions are grouped by stage — all functional design questions for the Bolt's Units together, then all NFR questions, etc.
> 2. **Within each stage group**, questions are labeled by Unit name so cross-Unit concerns in the Bolt are visible together.
> 3. **The standard question protocol** (interaction mode choice, answer collection, ambiguity analysis) applies once per stage group within the Bolt, not per Unit.
> 4. **A single Bolt-level answers gate** confirms the Bolt's answers across all stages before design artifacts begin.
> 5. **Design artifacts**: Stage files execute in ARTIFACT-ONLY mode — reading the approved answers and generating artifacts. No human interaction during generation.
> 6. **Code generation (3.5)**: Per-Unit Task delegation to the aidlc-developer-agent. A single Bolt-level gate (or batch-level gate for parallel batches) would replace the stage file's per-Unit approval gate.
> 7. **Bolt gate**: Walking skeleton — always present. Subsequent Bolts — per `Construction Autonomy Mode`.
>
> Under the shipped swarm, the engine already presents that Code Generation
> stage gate only after the FINAL DAG batch has converged; that fact is
> restated in the engine-driven block.

**Engine-driven per-unit iteration.** The orchestration engine now drives the per-Unit loop for the inline per-Unit design stages (functional-design, nfr-requirements, nfr-design, infrastructure-design) the same way it always has for code-generation: on a `next` that lands on an in-flight per-Unit stage (off the swarm path), the engine emits ONE `run-stage` directive per Unit, in Bolt build order, carrying the resolved Unit name in `directive.unit` and its artifact paths. The engine substitutes the next unsettled Unit on each `next`. The stage's per-Unit gate is **suppressed** (`gate: false`) on every not-yet-settled Unit, and the stage's real gate is presented exactly once, on the re-entry after the LAST Unit settles, so a single stage-level approval covers all Units and cannot be reached until every Unit is built (the same "per-Unit gate suppressed, single gate replaces it" rule, now applied across all five per-Unit stages, and enforced deterministically: `report --result approved` on a not-yet-completed per-Unit stage is refused while any Unit is unsettled). A workflow with no units-generation dependency artifact on disk degrades to one single-iteration directive (unchanged behaviour). When the artifact exists, the engine validates the compiled `bolt_dag` against it and recomputes the unit batches on the spot if the cache is missing or stale, so the per-unit loop never silently shrinks to an outdated unit set; an artifact whose units block does not parse is surfaced as an error instead.

**Unit lifecycle receipts.** On each inline per-Unit directive, bracket the Unit's work with the receipt verbs: `bun .cursor/tools/aidlc-state.ts unit start --stage <slug> --unit <name>` before the body, and `... unit complete --stage <slug> --unit <name>` after the Unit's artifacts are written (complete verifies that every required artifact is a regular file on disk and refuses directories or missing paths — the receipt is the completion signal, artifacts are the evidence it checks). Pass the exact `directive.stage` + `directive.unit` pair emitted by the engine: `unit start` re-runs the read-only route and refuses a DAG member whose dependencies or earlier same-batch Units are not settled. New Unit names use lowercase kebab-case; safe legacy single-segment names (including digit-leading names, uppercase letters, underscores, and dots) remain accepted by existing DAGs and autonomous swarms, which use a deterministic internal Bolt slug without changing the Unit identity. An autonomy grant does not disable these receipts when a backward jump routes an inline per-Unit stage; only a stage currently owned by the autonomous swarm refuses them. If the Unit must stop before completion (blocking question, failed dependency, session ending mid-Unit), record the checkpoint with single-line text: `... unit pause --stage <slug> --unit <name> --reason "<why>" --next-action "<the exact next step>"`. Every lifecycle row carries an exact stage-attempt `Run floor` (`<boundary-event>:<timestamp>#<ordinal>`); when equal second-precision boundaries in different audit shards are causally unordered, the engine uses a deterministic `AMBIGUOUS:<timestamp>#<digest>` floor that invalidates older receipts instead of trusting shard filename order. Once any receipt exists for a stage, every later attempt stays in receipt mode and requires a current-attempt `UNIT_COMPLETED` receipt per Unit. Artifact files alone no longer settle a Unit, so a stale, paused, reopened, or partially-written Unit can never be mistaken for done. A paused Unit routes FIRST and hard-stops the loop: the engine emits an `ask` naming the Unit, its recorded reason, and next action (`unit_state: paused`), and no other work may start until an explicit `... unit resume --stage <slug> --unit <name>`. `unit start` refuses while another Unit of the stage is open (one active Unit at a time; resume or complete it first), and workflows that never call the verbs keep today's artifact-driven coverage unchanged.

**Per-unit batch waves (optional, stage-major only).** For functional-design, nfr-requirements, nfr-design, and infrastructure-design on the default stage-major walk, the engine may emit `directive.wave` from one healed Bolt-DAG snapshot. Code Generation remains wave-ineligible because it writes the shared workspace and hard-stops for Plan Approval. Each entry carries resolved Unit-local inputs/outputs, `required_produces`, `unit_memory_path`, `build_required`, `completion_required`, and receipt-backed `review_state` / `review_iteration`; kind-vacuous and fully settled Units are omitted, and large batches arrive as deterministic same-batch prefixes. The parent retains `stage_file`, the complete `inline_context_paths`, `context_warnings`, the accumulated steering bundle, effective `review_class`, reviewer settings, sensors, and the stage-level `memory_path`. Never reconstruct siblings from `runtime-graph.json`.

When `directive.wave` is present, branch on it before the ordinary per-Unit or gate path; the parent Unit fields are compatibility projections of the first entry and are not separate work. Show parent warnings once, then give every builder the parent stage file, all inline context, and the complete steering bundle verbatim plus only its entry's paths. Dispatch entries concurrently where the harness supports independent workers; serial entry processing is the universal fallback. A builder with `build_required: true` runs the Unit-scoped question/summary checkpoint and writes its Unit artifacts and diary. It does not call the serial `unit start/pause/resume` verbs: the wave directive is the batch checkpoint, and a blocking question keeps the entry open by withholding a path from `entry.required_produces`, returning the question to the conductor, and stopping for the human.

After builds, `review_state: "outstanding"` runs the named iteration; `"retry-required"` repeats the unmatched request with `aidlc-log.ts review --retry-pending`; `"repair-required"` runs the lead-only repair and then the next reviewer iteration; and `"recovery-required"` runs the one stale-receipt recovery at the emitted `review_iteration`. `"escalation-required"` means that recovery was already spent: do not request another review or complete the Unit; halt and present the situation to the human, and only a human Request Changes decision may reset the stage attempt. `READY`, terminal `NOT-READY`, and `not-required` need no review work. Reviewer dispatches remain serialized where the single reviewer-scope record is enforced; only an enforcement-free harness may run them as parallel foreground work. Once an entry is build-complete and review-settled, run `bun .cursor/tools/aidlc-state.ts unit complete --wave --stage <slug> --unit <name>`. That command re-verifies the live wave entry, copies new Unit diary entries verbatim into the parent diary with deterministic deduplication, binds the receipt to the final artifact fingerprint, and only then emits `UNIT_COMPLETED`. Therefore a crash before diary fan-in or a later artifact change leaves `completion_required: true` and re-hands the entry; neither a dependent batch nor the stage gate can overtake build, review, memory, or completion evidence. Re-run `next` without report-approve after processing the emitted prefix. Unit-major iteration stays serial and never carries `directive.wave`.

**Unit-major iteration (opt-in).** By default the walk above is stage-major: a design stage runs for every Unit, then the next design stage runs for every Unit, and code-generation runs last for every Unit. When the state file records `Construction Iteration: unit-major` under `## Runtime State` (set at delivery-planning via `aidlc-state.ts set-construction-iteration unit-major`, or by a human), the engine instead walks EVERY per-unit Construction stage unit-major: for each Unit in Bolt build order (outer), for each per-unit stage in graph order (inner — the four inline design stages, then code-generation), it emits the first unsettled (stage, Unit) pair with `gate: false`, so one Unit's four design documents are authored consecutively and the Unit is BUILT before the next Unit begins. The first working code therefore lands after ONE Unit's design, not after every Unit's; code-generation's own Step 3 Plan Approval still hard-stops per Unit before generation. The autonomous swarm never fires under unit-major: the walk owns code-generation through the normal non-swarm per-unit settlement path, so an `autonomous` grant changes no routing while the knob is set. The gates are UNCHANGED in count and machinery: the per-stage gates still fire, but late and in a cascade at the end of the block once the whole (stage x Unit) grid — code-generation included — is settled, one human approval per stage per turn. Because a stage's per-Unit work can run while `Current Stage` still points at an earlier stage, a directive's `directive.stage` may name a LATER Construction stage (including code-generation) than `Current Stage`, and a stage's `STAGE_STARTED` audit event may land after that stage's per-Unit artifacts were written; unit-major receipt floors therefore use the current workflow/jump/rejection boundary and survive that later `STAGE_STARTED`. The audit trail stays complete and stage-keyed. Always act on the directive's own `directive.stage` + `directive.unit`, never on `Current Stage`.

**Team-owned Unit Progress and gates (opt-in).** `Unit Ownership: team` is valid
only with unit-major. In that mode every `next` rewrites `## Unit Progress` from
the Unit DAG, artifact coverage, lifecycle/review receipts, and gate events.
The table is engine-owned projection only; a hand edit is overwritten and never
changes routing. Live git-native claims populate the `owner` cell.
`Unit Gate Rhythm: per-stage` is the default: after one `(stage, Unit)` settles,
the engine re-emits it with `gate: true` and `unit_gate: per-stage` before that
Unit advances. `unit-end` leaves every active per-unit work beat gate-false,
then emits one `unit_gate: unit-end` after the final active, unskipped per-unit
Construction stage. These gates replace the five late
end-of-grid gates, and Stage Progress checkboxes become derived from completed
Unit columns.

**Branch on `directive.unit_gate` before the ordinary `gate: true` branch.**
The body, summary checkpoint, lifecycle completion, and reviewer are already
settled; do not regenerate or re-review them. Run the approval/learnings
presentation only. In team-owned unit work, every non-gate
`aidlc-log.ts decision` / `answer` call also adds
`--unit "<directive.unit>"` so pending human decisions remain attempt- and
Unit-scoped. Every report call for this gate adds
`--unit "<directive.unit>"`: first `awaiting-approval`, then `approved
--user-input "<exact choice>"`, or `rejected --user-input "<feedback>"` and
later `revised`. Rejection floors only that Unit's lifecycle/review receipts;
for `unit-end` it floors all stages in that Unit's chain. Re-run `next` after
each accepted report. When Unit Ownership is absent or `solo`, ignore this
paragraph: directive bytes, state bytes, audit rows, waves, and the legacy late
gate cascade stay unchanged.

**Team Unit claims and scoped checkouts.** When `next` emits
`ask_type: unit-claim`, present its claimable/claimed/waiting lists and run
`aidlc-unit.ts claim <unit> --team "<label>"` for the selected Unit. The claim
uses the `claim/<intent-id8>/<unit>` ref as an atomic registry and writes a
gitignored checkout-local scope stamp. A stamped checkout executes only that
Unit's active per-unit Construction stages and gates; every lifecycle, review,
gate, and fork operation must name the stamped Unit and current attempt
generation. A terminal `notice` means main is acting as the fan-out dispatcher:
print it verbatim and stop. A participant clone runs `aidlc-unit.ts participate`
once to opt into the guided picker; the unmarked facilitator main remains the
notice surface. Release runs only from unscoped main via
`aidlc-unit.ts release <unit>` and leaves a generation-bumping tombstone ref.
Scoped `next`, lifecycle, decision, review, and gate writes trust the locally
validated claim-time stamp and never require the network. Fork/release are
claim-sensitive boundaries: recheck the registry when reachable, refuse an
online stale attempt, and warn once plus proceed from the stamp when offline.

**Pinned Unit merge-back.** When the scoped Unit is complete, commit its tracked
work and run `aidlc unit publish <unit>`; publication CAS-updates the claim ref
but does not integrate it. On unscoped main, run `aidlc unit pin <unit>` and
bracket the existing pipeline-deploy strategy lookup with
`MERGE_DISPATCH_INVOKED` / `MERGE_DISPATCH_RETURNED` (or `_FALLBACK`), then
present the returned pinned OID + evidence summary as one merge gate. Record the
exact human answer with `aidlc unit gate <unit> --decision <approve|reject>
--user-input "<text>"`. On approval, `aidlc unit land <unit> --target <branch>`
owns the transaction: pinned git content first with main-owned metadata retained,
then one Unit-row fold under the intent lock, then audit/finalization. A moved
claim ref requires re-pin, and an unavailable registry makes gate/land fail
closed. If the exact attempt is released only after the git step landed, inspect
the merge and continue explicitly with `aidlc unit land <unit>
--accept-released-attempt --user-input "<human acknowledgment>"`; a successor
claim is never accepted. Source conflicts abort before state folding. For
crash recovery the same command accepts `--step git|state|audit`; each step is
idempotent and `aidlc unit merge-status <unit>` reports the local journal.
The dispatch bracket must be newer than the pin and followed by a typed human
turn. This transaction deliberately requires strategy `merge` so the reviewed
pinned OID remains a direct parent; a returned squash/rebase decision is refused.
The candidate may transport one claim-bound new audit shard containing that
team's own attempt-keyed lifecycle, team-gate, and reviewer receipts. These are
team assertions rechecked against artifacts/fingerprints and judged at the main
merge gate. `HUMAN_TURN`, `MERGE_DISPATCH_*`, `UNIT_MERGED`, unit-merge gates,
foreign Unit receipts, sibling Unit record paths, and additional shards are
never transportable.
Pass `--pinned-oid <pin output OID> --attempt-generation <pin output generation>
--pin-id <pin output pin_id>` to every `aidlc bolt dispatch-event` call in this
bracket; the gate ignores unbound or older dispatch rows, including a bracket
from an earlier pin of the same candidate. Dispatch and merge-gate rows are
accepted only from the unscoped main checkout's audit shard and must match that
exact OID, generation, and pin transaction; the subsequent main-shard
`HUMAN_TURN` is the chronological human-presence proof and intentionally carries
no transaction fields.

Each construction stage file (3.1–3.4) documents its execution modes (QUESTION-ONLY, ARTIFACT-ONLY, Full) and the step split points. See the individual stage files for details.

---

## 12b. Autonomous Code Generation Plan Contract

An `invoke-swarm` directive for `code-generation` changes where generation
runs, not whether planning and Plan Approval happen. Before `aidlc-swarm.ts
prepare`:

1. For every unit in `directive.units`, execute Code Generation Part 1 through
   Plan Approval preparation in the main workspace: create
   `code-generation-plan.md`, embed the exact `## Testing Contract` emitted by
   `aidlc-testing-posture.ts render`, create `unit-test-instructions.md`, write
   the current `[Approval Fingerprint]`, and present that unit's Plan Approval
   question. A revision resets `[Answer]:` to blank before the resolver or
   fingerprint is regenerated.
2. STOP for each unanswered Plan Approval. After the human explicitly chooses
   `Approve Plan`, record the answer through the reserved
   `PLAN_APPROVAL_RECORDED` receipt and re-run `next`; the engine may re-emit
   the same batch while other units still need approval. Do not fork worktrees
   or dispatch implementation workers during these planning turns.
3. Call `prepare` only after every unit in the emitted batch has current
   approval evidence. On autonomous Code Generation, `prepare` verifies the
   plan, test instructions, embedded contract, answer, target-bound fingerprint,
   directive epoch, and human-owned receipt before
   creating any worktree. A stale memory/scope/test-strategy/project-type input
   therefore reopens approval instead of silently changing execution.
4. Every worker brief starts with exactly:

   ```text
   AIDLC-UNIT: <unit>
   AIDLC-TESTING-CONTRACT: <contract_sha256 from that unit's approved plan>
   ```

   Then include the full approved `code-generation-plan.md` and
   `unit-test-instructions.md`. The worker must produce the unit's
   `construction/<unit>/code-generation/source-manifest.json` in the worktree,
   listing every application-source path it creates, modifies, or deletes,
   before the in-Bolt review. Because a Bolt is the single selected repository,
   these paths are worktree-relative and omit `repo` even when the parent intent
   records multiple repositories. The approved Testing Contract is authoritative:
   workers do not re-resolve memory, and retries reuse the same approved bytes.
   The plan-approval guard rejects a delegated worker whose marker is missing,
   stale, or different from the approved plan. Headless worker harnesses that
   cannot run the hook still remain protected by `prepare` and this mandatory
   brief contract.

Only after all four obligations are satisfied does the ordinary swarm
prepare/fan-out/check/review/finalize loop run.

---

## Harness construction bindings

### Claude Code

- **`gate: "unresolved"`** — the first Construction Bolt's gate depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins — emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this same stage with the now-determined boolean gate. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** When `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units). When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Kiro CLI

- **`gate: "unresolved"`** — the first Construction Bolt's gate depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** When `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Kiro IDE

- **`gate: "unresolved"`** — the first Construction Bolt's gate depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** When `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Codex CLI

- **`gate: "unresolved"`** — the first Construction Bolt's gate depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins — emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this same stage with the now-determined boolean gate. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** When `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units). When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Cursor

- **`gate: "unresolved"`** — the first Construction Bolt's gate depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent`. Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** When `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### opencode

- **`gate: "unresolved"`** — the first Construction Bolt's gate depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent`. Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** When `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### GitHub Copilot

- **`gate: "unresolved"`** — the first Construction Bolt's gate depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent`. Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** When `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and non-autonomous code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER design stage than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.
