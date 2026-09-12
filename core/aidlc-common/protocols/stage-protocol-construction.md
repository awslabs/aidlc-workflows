# Construction Protocol Module

The verified Unit checkpoint policy applies to solo workflows with a real Unit
DAG and an included stage that produces workspace source. Design-only scopes
and scopes without Units keep their existing stage approval flow; they do not
need to invent a source manifest or a working skeleton to continue.

Load this module on the first Construction-phase directive of the session and on every `invoke-swarm`; use only the harness subsection that matches the active harness.

**Applicability and compatibility.** New workflows record `Construction
Checkpoints: enabled`, `Construction Iteration: unit-major`, and
`Construction Execution: serial`. Checkpoints
apply to solo work with a real, non-empty Unit DAG. Team-owned `unit_gate`
directives keep their own approval policy; zero-Unit and isolated runs do not
acquire a Unit, skeleton, or swarm ceremony. Existing workflows without the
checkpoint field retain their first-stage approval and late per-stage cascade.
Preserve an explicit iteration choice; never migrate state by editing it in
prose. Follow the metadata on the current directive.

### Construction directive routing

Before ordinary body, questions, reviewer, learnings, or `gate: true` handling,
load this module and apply these branches in order:

1. **`directive.unit_gate`** uses the existing team-owned gate procedure below.
2. **`directive.swarm_checkpoint`** uses the swarm module's **Batch checkpoint**
   procedure before ordinary body or settled-swarm handling. Approve or reject
   the completed batch, then `next`; never approve the whole stage for a batch.
3. **`directive.construction_checkpoint`** uses **Unit and skeleton checkpoints**
   below. The Unit body has already run; do not regenerate it or report the
   whole Code Generation stage complete for this Unit.
4. **`directive.construction_policy.completion_only === true`** is bookkeeping
   after recorded Unit approvals. It must also carry
   `human_completion_required: false`. Skip the body, questions, reviewer, and
   learnings prompt. Report `awaiting-approval`, then `approved`, for the emitted
   `directive.stage`, both without `--user-input`, and re-run `next`. If the
   metadata contradicts itself or a report refuses, explain the error and stop;
   do not manufacture approval or retry generation.
5. **`directive.construction_policy.offer_autonomy === true`** uses **Autonomy
   choice** below before doing the next stage body. Record the real answer and
   re-run `next` to obtain the policy that now applies.
6. **Other Construction work** first resolves `gate: "unresolved"` through the
   harness stance-classification binding, reports it, and obtains a new `next`
   before any body work. Otherwise it follows the emitted Unit, wave, or stage body
   and its required questions, summary confirmation, Plan Approval, reviews,
   verification, and receipts. At completion, the policy's
   `human_completion_required` selects whether the routine completion gate
   needs a human. When false, skip the learnings question and routine approval
   question, report `awaiting-approval` and `approved` without `--user-input`,
   then `next`. This never waives a pre-generation summary or Plan Approval.
   An unfinished per-Unit iteration still completes its Unit receipt and calls
   `next`, without reporting the whole stage. When the policy is absent, use
   the legacy gate rules. All verification and tool failures stop the flow.

`construction_policy` carries `iteration` (`unit-major` or `stage-major`),
`execution` (`serial` or `swarm`), `autonomy` (`unset`, `gated`, or `autonomous`), `offer_autonomy`,
`human_completion_required`, and `completion_only`. These fields take precedence
over the generic interpretation of `gate: true`; they do not change body-level
human decisions. Preserve the existing isolated-run branch for `single: true`.

### Execution is separate from approval

New workflows default to `Construction Execution: serial`. Setting autonomy
never changes execution or iteration order. To select swarm explicitly, the
human chooses stage-major first, then the execution setting:

```bash
{{INVOKE}} engine state set-construction-iteration stage-major
{{INVOKE}} engine state set-construction-execution swarm
```

Swarm may use guided (`gated`) or automatic (`autonomous`) batch completion
approval. Unit-major remains serial and refuses a contradictory swarm setting;
select serial before changing back to unit-major. Legacy workflows without the
execution field retain their existing autonomy-based swarm routing. Team-owned
work retains its claim and Unit-gate policy. Always follow the engine's emitted
work rather than deriving batches or changing order from an autonomy answer.

### Unit and skeleton checkpoints

With checkpoints enabled, skeleton-on runs the **first DAG Unit through every
applicable per-unit stage, including Code Generation, before later Units**,
even when the surrounding iteration choice is stage-major. Plan that Unit as
the smallest working integrated slice. A first design-stage review is not a
shipped walking skeleton. Unit-major remains serial and never invokes swarm;
stage-major with explicit `Construction Execution: swarm` can fan out eligible
Code Generation work after the skeleton checkpoint is approved, under either
gated or autonomous approval policy. Follow the emitted Units: an inline Unit
already approved at its checkpoint must not be built again by a later swarm.

A `run-stage` with `construction_checkpoint` carries `kind` (`unit` or
`skeleton`), `unit`, `stages`, `fingerprint`, `ready`, `verified`, `approved`,
`human_required`, `errors`, and `proof_path`. It is a verification/approval
re-entry over existing work. Use the exact Unit and kind the engine emitted:

```bash
{{INVOKE}} engine bolt checkpoint --action status --unit "<unit>" --kind <unit|skeleton>
{{INVOKE}} engine bolt checkpoint --action verify --unit "<unit>" --kind <unit|skeleton> --check-cmd '<real project check>'
```

Choose an actual project command: for a skeleton it must demonstrate the
integrated slice end to end; for an ordinary Unit it must check that Unit's
working result. The verifier stores proof bound to the current artifacts,
source, and attempt. File presence, a claimed demonstration, a placeholder
command, or a previous pass is not verification. A failed check halts. Re-run
`next` after each checkpoint action; the resulting directive is the next source
of truth about readiness and verification.

If `ready` is false or evidence became stale, explain `errors`. Repair the named
missing review or receipt through its owning procedure, or let the human request
changes; do not replay the whole body just because the checkpoint uses
`gate: true`. A human Request Changes is available without pretending that
verification succeeded. After any repair, obtain a new directive and verify the
current result. If no real project check exists, resolve that gap with the human
before claiming a pass.

Only a verified checkpoint can be approved. A skeleton always needs a real
human approval. An ordinary Unit needs one when `human_required` is true
(`unset`/`gated`); under an explicit autonomous grant the conductor may approve
the verified ordinary Unit automatically. At a human checkpoint, retain the §13
learnings ritual for the represented stages, consolidating relevant candidates
into one Unit learning question. Persist only the human's explicit selections
through each owning stage's learning tools, then ask the checkpoint approval
as a separate question and turn. During automatic execution retain candidates
in the diaries for the next human checkpoint or final handoff; do not infer
acceptance, persist unapproved rules, or fabricate a “nothing to add” answer.
Present **Approve** / **Request
Changes** when a human is required, then use only their actual answer:

```bash
# Only after the human chose Approve:
{{INVOKE}} engine bolt checkpoint --action approve --unit "<unit>" --kind <unit|skeleton> --user-input 'Approve'
# Automatic approval: verified ordinary Unit and human_required: false only.
{{INVOKE}} engine bolt checkpoint --action approve --unit "<unit>" --kind unit
# Only after the human chose Request Changes and supplied feedback:
{{INVOKE}} engine bolt checkpoint --action reject --unit "<unit>" --kind <unit|skeleton> --user-input 'Request Changes' --reason '<human feedback>'
```

After the action, re-run `next`. Never use a checkpoint approval as
`report --stage code-generation --result approved` for the whole Unit set.
Once all Unit approvals are recorded, the engine may emit normal stage gates
with `completion_only: true`; settle those through the bookkeeping branch above.
Explicit stage-major gated execution retains its ordinary stage reviews;
autonomous execution skips their routine human completion questions.

### Autonomy choice

For checkpoint workflows, **only `offer_autonomy: true` triggers the automatic
choice**. Skeleton-off offers it at Construction entry. Skeleton-on offers it
after the real skeleton checkpoint, unless an on-demand choice is already
recorded. Render the question using the harness's normal question binding:

```question
prompt: "How should I continue building the remaining work?"
header: Autonomy
multiSelect: false
options:
  - label: Continue automatically
    description: Continue through ordinary completion checkpoints; still ask for plans, summaries, and failures.
  - label: Review each checkpoint
    description: Wait for your approval at each ordinary completion checkpoint.
```

Map **Continue automatically** to `autonomous` and **Review each checkpoint** to
`gated`. Record the explicit answer with
`{{INVOKE}} engine bolt set-autonomy --mode <autonomous|gated>`, then re-run
`next`. Do not log this choice with `log decision`/`log answer`: `set-autonomy`
owns its receipt, and logging an interview answer first consumes the human turn.
Escalation requires a fresh human turn; revocation to `gated` does not.

Explicit on-demand requests remain valid at any point during Construction.
Never infer a grant from silence or repeat the offer after a choice is known.
An autonomous grant waives ordinary completion questions consistently across
iteration choices, while per-Unit Plan Approval, pre-generation summary
confirmation, skeleton approval, and failures still require the human. Grouped
Plan Approval below changes the presentation only; every Unit still needs its
own valid receipt.

For a legacy workflow without the checkpoint field, retain the first
Construction-stage review and the late human per-stage cascade under unit-major.
Skeleton-on may offer the legacy ladder after that first-stage review if no
choice exists; skeleton-off keeps its on-demand path. Describe that older review
as a first-stage approval, never as proof of a working integrated skeleton.

**Halt-and-ask on failure**

When Code Generation returns failure, **always halt and present the halt-and-ask prompt regardless of autonomy mode**. The Build-and-Test failure loop-back's rung 4 also halts when its bound is exhausted or no identifiable fix exists. Required Plan Approvals and summary confirmations remain separate human stops.

- Solo Unit failure: halt immediately; on the swarm / worktree path emit `BOLT_FAILED` (with `--slug` for halt-and-ask correlation), present retry / skip / abort.
- Parallel batch partial failure: wait for all parallel Tasks to return, preserve successful Units' artifacts, emit `BOLT_FAILED` for the failed Unit with `Succeeded=[names]`, present `"Units [X, Y] succeeded, Unit [Z] failed with: [error]. Options: retry Z, skip Z, abort Construction."`
- Retry: re-run the failed Unit only inside the existing worktree.
- Skip: mark `[S]` in state with reason, proceed to next batch. Worktree at `<path>` is preserved.
- Abort: stop Construction; user can resume later. Worktree at `<path>` is preserved.

The orchestrator runs `{{INVOKE}} engine worktree info --slug <slug>` to obtain the worktree `<path>` and `<branch_name>` deterministically before composing the halt-and-ask question. See `SKILL.md` § "Halt-and-ask failure handling" for the full tool-call sequence and the `worktree-info-schema.md` knowledge file for the JSON contract.

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

**Plan approval on replay.** The jump opens a new stage attempt, so the prior
Plan Approval receipt (bound to the previous attempt) cannot authorize the
replay. Preserve the
Loop-Back Log, but blank `[Answer]:`, regenerate the target-bound fingerprint,
and run Code Generation's Plan Approval decision/human-turn/answer receipt
sequence again before generation. The human's "Retry with fix" choice authorizes
the loop-back jump; it is not approval of plan content the human has not
reviewed under the new attempt.

**Autonomous loop-back procedure** (mode `autonomous`, bound not exhausted,
impact-estimated fix identified):
1. Append the `### Loop-back N — <ISO timestamp>` entry (Diagnosis /
   Root-cause stage / Planned fix / Estimated impact) to test-results.md and a matching
   Deviations entry to this stage's memory.md.
2. Execute the jump through the ENGINE: run
   `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts next --stage code-generation`.
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
review receipts per unit as above. Fresh target-bound Plan Approval remains
a human stop for the repair; autonomy does not waive it.

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

**Engine-driven per-unit iteration.** The orchestration engine now drives the per-Unit loop for the inline per-Unit design stages (functional-design, nfr-requirements, nfr-design, infrastructure-design) the same way it always has for code-generation: on a `next` that lands on an in-flight per-Unit stage (off the swarm path), the engine emits ONE `run-stage` directive per Unit, in Bolt build order, carrying the resolved Unit name in `directive.unit` and its artifact paths. The engine substitutes the next unsettled Unit on each `next`. For a stage-major or legacy stage gate, the stage's per-Unit gate is **suppressed** (`gate: false`) on every not-yet-settled Unit, and the stage's real gate is presented exactly once, on the re-entry after the LAST Unit settles, so a single stage-level approval covers all Units and cannot be reached until every Unit is built (the same "per-Unit gate suppressed, single gate replaces it" rule, now applied across all five per-Unit stages, and enforced deterministically: `report --result approved` on a not-yet-completed per-Unit stage is refused while any Unit is unsettled). A workflow with no units-generation dependency artifact on disk degrades to one single-iteration directive (unchanged behaviour). When the artifact exists, the engine validates the compiled `bolt_dag` against it and recomputes the unit batches on the spot if the cache is missing or stale, so the per-unit loop never silently shrinks to an outdated unit set; an artifact whose units block does not parse is surfaced as an error instead.

**Unit lifecycle receipts.** On a per-Unit body directive without `directive.wave`, `construction_checkpoint`, or `construction_policy.completion_only`, bracket the Unit's work with the receipt verbs: `{{INVOKE}} engine state unit start --stage <slug> --unit <name>` before the body, and `... unit complete --stage <slug> --unit <name>` after the Unit's artifacts are written (complete verifies that every required artifact is a regular file on disk and refuses directories or missing paths — the receipt is the completion signal, artifacts are the evidence it checks). Pass the exact `directive.stage` + `directive.unit` pair emitted by the engine: `unit start` re-runs the route as a read-only engine observation (it publishes no directive and writes no state, receipt, or approval evidence, and a durable write from that path fails loudly rather than silently) and refuses a DAG member whose dependencies or earlier same-batch Units are not settled. New Unit names use lowercase kebab-case; safe legacy single-segment names (including digit-leading names, uppercase letters, underscores, and dots) remain accepted by existing DAGs and autonomous swarms, which use a deterministic internal Bolt slug without changing the Unit identity. An autonomy grant does not disable these receipts when a backward jump routes an inline per-Unit stage; only a stage currently owned by the autonomous swarm refuses them. If the Unit must stop before completion (blocking question, failed dependency, session ending mid-Unit), record the checkpoint with single-line text: `... unit pause --stage <slug> --unit <name> --reason "<why>" --next-action "<the exact next step>"`. Every lifecycle row carries an exact stage-attempt `Run floor` (`<boundary-event>:<timestamp>#<ordinal>`); when equal second-precision boundaries in different audit shards are causally unordered, the engine uses a deterministic `AMBIGUOUS:<timestamp>#<digest>` floor that invalidates older receipts instead of trusting shard filename order. Receipt validity is decided by the attempt floor and the content bindings on the row, never by the order in which shards or rows were written. Once any receipt exists for a stage, every later attempt stays in receipt mode and requires a current-attempt `UNIT_COMPLETED` receipt per Unit. Artifact files alone no longer settle a Unit, so a stale, paused, reopened, or partially-written Unit can never be mistaken for done. A paused Unit routes FIRST and hard-stops the loop: the engine emits an `ask` naming the Unit, its recorded reason, and next action (`unit_state: paused`), and no other work may start until an explicit `... unit resume --stage <slug> --unit <name>`. `unit start` refuses while another Unit of the stage is open (one active Unit at a time; resume or complete it first), and workflows that never call the verbs keep today's artifact-driven coverage unchanged.

**Per-unit batch waves (optional, stage-major only).** For functional-design, nfr-requirements, nfr-design, and infrastructure-design on an explicitly selected stage-major walk, the engine may emit `directive.wave` from one healed Bolt-DAG snapshot. Code Generation remains wave-ineligible because it writes the shared workspace and hard-stops for Plan Approval. Each entry carries resolved Unit-local inputs/outputs, `required_produces`, `unit_memory_path`, `build_required`, `completion_required`, and receipt-backed `review_state` / `review_iteration`; kind-vacuous and fully settled Units are omitted, and large batches arrive as deterministic same-batch prefixes. The parent retains `stage_file`, the complete `inline_context_paths`, `context_warnings`, the accumulated steering bundle, effective `review_class`, reviewer settings, sensors, and the stage-level `memory_path`. Never reconstruct siblings from `runtime-graph.json`.

When `directive.wave` is present, branch on it before the ordinary per-Unit or gate path; the parent Unit fields are compatibility projections of the first entry and are not separate work. Show parent warnings once, then give every builder the parent stage file, all inline context, and the complete steering bundle verbatim plus only its entry's paths. Dispatch entries concurrently where the harness supports independent workers; serial entry processing is the universal fallback. A builder with `build_required: true` runs the Unit-scoped question/summary checkpoint and writes its Unit artifacts and diary. The serial `unit start/pause/resume` verbs refuse while the engine routes this stage as a wave, including before the first completion receipt, without changing state or audit. The wave directive is the batch checkpoint, and a blocking question keeps the entry open by withholding a path from `entry.required_produces`, returning the question to the conductor, and stopping for the human.

After builds, `review_state: "outstanding"` runs the named iteration; `"retry-required"` repeats the unmatched request with `aidlc-log.ts review --retry-pending`; `"repair-required"` runs the lead-only repair and then the next reviewer iteration; and `"recovery-required"` runs the one stale-receipt recovery at the emitted `review_iteration`. `"escalation-required"` means that recovery was already spent: do not request another review or complete the Unit; halt and present the situation to the human, and only a human Request Changes decision may reset the stage attempt. `READY`, terminal `NOT-READY`, and `not-required` need no review work. Under Change Control `relaxed` a post-review change to a Unit's reviewed artifacts or claimed source does not produce `"recovery-required"`: the receipt stays valid, the engine records the change once (`CHANGE_ACCEPTED`) when the gate opens or the Unit completes, and the human hears one `change_notices` line. Reviewer dispatches remain serialized where the single reviewer-scope record is enforced; only an enforcement-free harness may run them as parallel foreground work. Once an entry is build-complete and review-settled, run `{{INVOKE}} engine state unit complete --wave --stage <slug> --unit <name>`. That command re-verifies the live wave entry, copies new Unit diary entries verbatim into the parent diary with deterministic deduplication, binds the receipt to the final artifact fingerprint, and only then emits `UNIT_COMPLETED`. Therefore a crash before diary fan-in or a later artifact change leaves `completion_required: true` and re-hands the entry; neither a dependent batch nor the stage gate can overtake build, review, memory, or completion evidence. Re-run `next` without report-approve after processing the emitted prefix. Unit-major iteration stays serial and never carries `directive.wave`.

**Unit-major iteration.** New workflows default to `Construction Iteration:
unit-major`; preserve a recorded stage-major choice and do not rewrite existing
workflows. The engine walks every applicable per-unit stage for one Unit before
the next, including Code Generation. Each Unit's Plan Approval remains a human
stop, and unit-major never invokes swarm. Checkpoint-enabled solo work then
verifies and approves the Unit through `construction_checkpoint`; the late stage
gates carrying `completion_only: true` are bookkeeping. Legacy workflows without
the checkpoint field retain their late human per-stage cascade. A directive may
name a later stage than `Current Stage`; always use `directive.stage` and
`directive.unit`. Lifecycle and review evidence remain keyed to the current
workflow/jump/rejection attempt so later stage starts do not repeat approved work.

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
each accepted report. When Unit Ownership is absent or `solo`, follow the checkpoint or legacy
policy above. The team-owned `unit_gate` path keeps its own approval rhythm and
is not converted into solo checkpoints.

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

1. For every Unit in `directive.units`, prepare Code Generation Part 1 in the
   main workspace: the plan, embedded `## Testing Contract`, test instructions,
   questions file, `[Approval Fingerprint]`, and `[Planned Source]`. Leave each
   `[Answer]:` blank until the human answers. A revision resets it before
   re-fingerprinting. Every Unit remains individually bound and approved.
2. Present Plan Approval individually, or group the exact live `invoke-swarm`
   Unit set through **Grouped Plan Approval** below. A real `Approve Plans`
   answer maps to `[Answer]: Approve Plan` for each named Unit and produces
   per-Unit receipts. Individual approval uses `Approve Plan` as before. Stop
   for the answer; do not fork worktrees or dispatch implementation workers
   during planning. Re-run `next` after recording approval and use the current
   emitted Unit set.
3. Call `prepare` only after every unit in the emitted batch has current
   approval evidence. On swarm Code Generation, `prepare` verifies the
   plan, test instructions, embedded contract, answer, target-bound fingerprint,
   current stage attempt, planned source, and human-owned receipt before
   creating any worktree. A stale memory/scope/test-strategy/project-type input
   therefore reopens approval instead of silently changing execution; re-running
   `next` for the same units and attempt does not.
4. Every worker brief starts with the output of
   `bun {{HARNESS_DIR}}/tools/aidlc-testing-posture.ts brief --unit <unit>`,
   verbatim and unedited. That output begins with exactly:

   ```text
   AIDLC-UNIT: <unit>
   AIDLC-TESTING-CONTRACT: <contract_sha256 from that unit's approved plan>
   ```

   and carries the approved plan exactly as the approval fingerprint bound it
   (every line before a terminal `## Review` appendix and none of that appendix,
   task markers reset to `[ ]`, spacing normalized; a replayed plan may still
   carry an appendix from a review recorded under the earlier protocol) and the
   approved `unit-test-instructions.md` byte for byte. Do not write either
   marker line yourself and never read the plan file into a brief: the
   fingerprint excludes the appendix, so its bytes were never approved as work,
   and the plan-approval guard refuses a handoff that quotes them. The command
   refuses until the unit's approval is current. Any further context for the
   worker follows the command's output; the worker reads and ticks its own
   progress in the plan file inside its worktree. The worker must produce the unit's
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

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins — emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` emits the resolved Construction directive; apply metadata routing before any body or gate. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. For a remaining per-unit stage gate, use `construction_policy.human_completion_required` to choose routine human completion or automatic reporting; only the legacy path without policy retains the §13 ritual and single human stage gate. Checkpoint and completion-only directives must already have branched before this body procedure. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Kiro CLI

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Kiro IDE

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Codex CLI

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins — emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` emits the resolved Construction directive; apply metadata routing before any body or gate. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. For a remaining per-unit stage gate, use `construction_policy.human_completion_required` to choose routine human completion or automatic reporting; only the legacy path without policy retains the §13 ritual and single human stage gate. Checkpoint and completion-only directives must already have branched before this body procedure. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Cursor

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent`. Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### opencode

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent`. Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### GitHub Copilot

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**. Do NOT run the stage body yet. Read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent`. Honour the `PRACTICES_OVERRIDE` judgement. Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` re-emits this stage with the now-determined boolean gate.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and non-autonomous code-generation). Run the question flow and PRE-GENERATION SUMMARY STOP for THIS unit, passing `--unit "<directive.unit>"` to both checkpoint log commands, before writing its artifacts under `construction/<directive.unit>/<directive.stage>/`; then run the body and, only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. When `directive.gate` is **true** on a per-unit stage, every unit is already built, so run the §13 ritual and present the single approval gate that covers the whole stage (all units), stopping for the human as above. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER design stage than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

### Grouped Plan Approval

Use grouping only for the exact named Units of the live Code Generation
`invoke-swarm` directive, with all plans ready and unchanged planned source.
Create a JSON manifest in the active record using the actual project-relative
questions paths; never reconstruct the Unit set from the DAG:

```json
{"batch":"<review name>","units":[{"unit":"<emitted Unit>","questionsFile":"<project-relative questions path>"}]}
```

Before showing the plans, use the invoking SessionStart session ID:

```bash
{{INVOKE}} engine log decision --stage code-generation --checkpoint plan-approval --batch-file "<manifest.json>" --session "<session ID>" --decision "Approve these named plans?" --options "Approve Plans,Request Changes"
```

Show every named Unit and its plan, then present **Approve Plans** / **Request
Changes** and stop for the actual human response. On **Approve Plans**, write
`[Answer]: Approve Plan` into each named questions file, preserving its bound
fingerprint and planned-source tags, then record:

```bash
{{INVOKE}} engine log answer --stage code-generation --checkpoint plan-approval --batch-file "<manifest.json>" --session "<session ID>" --details "Approve Plans"
```

On **Request Changes**, write that exact choice into each named questions file
and call the same answer command with `--details "Request Changes"`; gather the
human's feedback, revise the affected plans, and re-present current evidence.
Never write either choice before the human answers. Grouped approval binds the
manifest's exact live Unit set and each plan/questions fingerprint, produces
individual approval receipts, and refuses source drift even under relaxed Change
Control. It does not approve future batches or remove any Unit's Plan Approval.

Do not combine `--batch-file` with `--unit`, `--stage-level`, `--questions-file`,
`--single`, or `--override`. Legacy protected-choice mediation and harnesses
without grouped support use the existing single-Unit approval flow. If grouping
refuses because the live set, plans, questions, or source changed, explain the
error and obtain fresh individual or grouped approval; never invent receipts,
relax verification, or turn the refusal into an automatic grant.
