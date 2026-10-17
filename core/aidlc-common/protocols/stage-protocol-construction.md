# Construction Protocol Module

The verified Unit checkpoint policy applies to solo workflows with a real Unit
DAG and an included stage that produces workspace source. Design-only scopes
and scopes without Units keep their existing stage approval flow; they do not
need to invent a source manifest or a working skeleton to continue.

Load this module on the first Construction-phase directive of the session and on every `invoke-swarm`; use only the harness subsection that matches the active harness. A checkpoint, the Build-and-Test loop-back, and a wave each run by their own module (`stage-protocol-checkpoint.md`, `stage-protocol-loopback.md`, `stage-protocol-wave.md`), which the engine names on the steps that take them.

**Applicability and compatibility.** New source-producing solo Unit workflows
record `Construction Checkpoints: enabled`, `Construction Iteration: unit-major`, and
`Construction Execution: serial`. Checkpoints
apply to solo work with a real, non-empty Unit DAG. Team-owned `unit_gate`
directives keep their own approval policy; zero-Unit and isolated runs do not
acquire a Unit, skeleton, or swarm ceremony. Existing workflows without the
checkpoint field retain their first-stage approval; under unit-major their late
stage approvals come as one question (`directive.approve_together`).
Preserve an explicit iteration choice; never migrate state by editing it in
prose. Follow the metadata on the current directive.

### Construction directive routing

Before ordinary body, questions, reviewer, learnings, or `gate: true` handling,
load this module and apply these branches in order:

An open stage gate with `gate_only: true` follows the Stage Protocol's
open-gate re-entry before completion-only bookkeeping below. Its body and
review are settled, not permission to approve the gate automatically. Preserve
the team `unit_gate` and settled-swarm policies when those fields are present.

A `unit_record_step` names the records still owed for the emitted Unit's
already-written work. Follow those exact commands and the steps they return,
then `next`; do not repeat the stage body, its ordinary questions or review,
or its completion gate. Say any `plan_approval.notice` before following the step.
Plan Approval still
applies: the engine sends this step only after routing the Unit's plan through
its approval check. A pending or changed plan gets that plan's step instead.

1. **`directive.unit_gate`** uses the existing team-owned gate procedure below.
2. **`directive.swarm_checkpoint`** uses the swarm module's **Batch checkpoint**
   procedure before ordinary body or settled-swarm handling. Approve or reject
   the completed batch, then `next`; never approve the whole stage for a batch.
3. **`directive.construction_checkpoint`** uses the checkpoint module
   (`stage-protocol-checkpoint.md`). The Unit body has already run; do not regenerate it or report the
   whole Code Generation stage complete for this Unit. A checkpoint carrying
   `rereview` re-checks the Unit's changed code or documents first, as
   described there.
4. **`directive.construction_policy.completion_only === true`** closes the stage
   after its Units were approved. In a solo unit-major walk a bare `next`
   records these gates itself once the last Unit is approved and returns the
   next real step, so this directive comes only where it cannot (a change
   notice to say, team-owned Units, a swarm's settle). It must also carry
   `human_completion_required: false`. Skip the body, questions, reviewer, and
   learnings prompt, and say nothing about this step. Report
   `awaiting-approval`, then `approved`, for the emitted `directive.stage`,
   both without `--user-input`, and re-run `next`. If the
   metadata contradicts itself or a report refuses, explain the error and stop;
   do not manufacture approval or retry generation.
5. **`directive.construction_policy.offer_autonomy === true`** uses **Autonomy
   choice** below before doing the next stage body. Record the real answer and
   re-run `next` to obtain the policy that now applies.
6. **Other Construction work** first resolves `gate: "unresolved"` through the
   harness stance-classification binding, reports it, and obtains a new `next`
   before any body work. Otherwise it follows the emitted Unit, wave, or stage body
   and its required questions, any enabled summary confirmation, Plan Approval,
   reviews, verification, and receipts. Summary confirmation applies only when
   `directive.ceremony.summary_confirmation === "on"`. At completion, the policy's
   `human_completion_required` selects whether the routine completion gate
   needs a human. When false, skip the learnings question and routine approval
   question, report `awaiting-approval` and `approved` without `--user-input`,
   then `next`. This never waives an enabled summary stop, an enabled Plan
   Approval, or verification command selection.
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
never changes execution or iteration order. Swarm needs stage-major first,
then the execution setting; when the person asks for parallel Units, run both
setters as **Changing Construction policy** below describes:

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

### Changing Construction policy

Only one protected question may be open per session. Asking any new question
(protected or ordinary) or opening a lifecycle gate withdraws it, so ask
protected questions one at a time and wait for the answer before anything else.
A withdrawn question must be asked again.

When the person asks in their own words to change `Construction Checkpoints`,
`Construction Execution`, or `Construction Iteration` ("turn checkpoints off",
"from here on, build one unit at a time", "run the Units in parallel"), do it
in that turn: run the typed setter, then say its `notice` line to them word for
word. Do not ask them to confirm it. For example:

```bash
{{INVOKE}} engine state set-construction-checkpoints disabled
{{INVOKE}} engine state set-construction-iteration unit-major
{{INVOKE}} engine state set-construction-execution swarm
```

During Construction the setter makes the change only when a message from the
person since the last decision is on record, and it keeps their words with the
change. It is never yours to make on your own: not to clear a refusal, not
because autonomy is on, not from another gate's answer. When a setter names a
setting that has to change first (parallel needs stage-major and checkpoints
on; one Unit at a time needs serial), run that setter first and say both lines.
When one message asks for Construction changes and automatic approval
together, run the Construction setters before `set-autonomy`. Several changes
in one message each get their own setter and their own line. A request at an
open gate with no approval in it leaves the gate open for their answer.

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
    description: Continue through ordinary completion checkpoints; still ask for plans, enabled summaries, verification command selection, and failures.
  - label: Review each checkpoint
    description: Wait for your approval at each ordinary completion checkpoint.
```

Map **Continue automatically** to `autonomous` and **Review each checkpoint** to
`gated`. Record the explicit answer only with
`{{INVOKE}} engine bolt set-autonomy --mode <autonomous|gated>`, never with
`log decision` or `log answer` first, then re-run `next`.
Escalation requires a fresh human turn; revocation to `gated` does not.

Explicit on-demand requests remain valid at any point during Construction.
Never infer a grant from silence or repeat the offer after a choice is known.
An autonomous grant waives ordinary completion questions consistently across
iteration choices, while per-Unit Plan Approval, enabled pre-generation summary
confirmation, verification command selection, skeleton approval, and failures
still require the human. Grouped Plan Approval below changes the presentation
only; every Unit still needs its own valid receipt.

For a legacy workflow without the checkpoint field, retain the first
Construction-stage review; under unit-major its late stage approvals are one
human question (`directive.approve_together`).
Skeleton-on may offer the legacy ladder after that first-stage review if no
choice exists; skeleton-off keeps its on-demand path. Describe that older review
as a first-stage approval, never as proof of a working integrated skeleton.

**Halt-and-ask on failure**

When Code Generation returns failure, **always halt and present the halt-and-ask prompt regardless of autonomy mode**. The Build-and-Test failure loop-back's rung 4 also halts when its bound is exhausted or no identifiable fix exists. Required Plan Approvals, summary confirmations, and verification command selection remain separate human stops.

- Solo Unit failure: halt immediately; on the swarm / worktree path emit `BOLT_FAILED` (with `--slug` for halt-and-ask correlation), present retry / skip / abort.
- Parallel batch partial failure: wait for all parallel Tasks to return, preserve successful Units' artifacts, emit `BOLT_FAILED` for the failed Unit with `Succeeded=[names]`, present `"Units [X, Y] succeeded, Unit [Z] failed with: [error]. Options: retry Z, skip Z, abort Construction."`
- Retry: re-run the failed Unit only inside the existing worktree.
- Skip: mark `[S]` in state with reason, proceed to next batch. Worktree at `<path>` is preserved.
- Abort: stop Construction; user can resume later. Worktree at `<path>` is preserved.

This ordinary Abort pauses Construction without discarding its checkout. When
a stale-review recovery command explicitly includes `--discard`, abort instead
parks the Bolt's tracked and non-ignored untracked files (or its remaining branch
tip when the checkout is gone) plus reviewed source refs, then removes the live
checkout and branch. Obtain the human's selection before executing the unchanged
returned command. When present, the returned `restore_operation` recovers the
parked work in an isolated restored checkout; restoring files does not resume
the aborted Bolt or revive its review authority. If only review evidence
remained, there are no saved working files to restore, so neither
`restore_operation` nor `restore_hint` is returned.

**After a successful discard.** Only after the `--discard` abort succeeds and
confirms the attempt was parked, and before starting the replacement attempt,
use the following SAY line. Fill `[reason]` from the returned `abort_reason` in plain
project terms. Use `On your go-ahead I` only when the human selected the remedy;
use `I` when no human remedy choice was involved (including an automatic
loop-back). Do not announce a saved snapshot if the abort failed or did not
park an attempt.

Select `[saved-files text]` from the returned `parked_mode`:

- `snapshot`: "I saved a snapshot of its tracked files and non-ignored untracked files. Ignored files are not saved, and the snapshot may normalize line endings."
- `branch-tip`: "I kept its committed work; there were no uncommitted files to save."
- `evidence-only`: "Nothing of its working files remained to save; only its review evidence was kept."
- `null`: omit `[saved-files text]`; the fallback descriptor does not establish what was saved.

**SAY:** "[On your go-ahead I|I] set aside the previous attempt at [Unit] because [reason], and I'm starting a new attempt. [saved-files text] If you want the previous attempt back, ask me to restore it."

When `restore_operation` is absent, omit the final offer: "If you want the previous attempt back, ask me to restore it." Do not invent a restore operation for an evidence-only attempt.

If the human later asks for that attempt back, use the saved abort result's
`restore_operation`: invoke its `worktree` route through
`{{INVOKE}} engine worktree <args...>`, passing each listed `args` element exactly
as a separate argv argument. Never join those arguments into a shell command or
rebuild a slug-only selection. `restore_hint` is human display text only, never
an execution input. If safe rendering fails (for example, an invalid harness
directory), the hint is omitted and `restore_hint_error` explains why; the
operation remains available and the restoration offer still applies.
After restoration succeeds, announce the returned restored path plainly:
**SAY:** "I restored the previous attempt at [returned restored path]."
This does not resume the old attempt or make its review current.

The orchestrator runs `{{INVOKE}} engine worktree info --slug <slug>` to obtain the worktree `<path>`, `<branch_name>`, and `intent_id8` deterministically before composing the halt-and-ask question. `info` validates the audited `Branch name` and `Worktree path` against the canonical Bolt identity for the selected intent and returns canonical values (`bolt-<id8>_<slug>` for new Bolts, legacy `bolt-<slug>` for pre-upgrade ones), so `path` and `branch_name` are validated display values, not free text from the audit. Interpolate them exactly as returned; never reconstruct the branch from the slug. On any non-zero exit, render the same Retry/Skip/Abort question below with the "Worktree at [path] on branch [branch_name]." clause replaced by a voice-contract translation — one plain sentence naming what could not be shown and why, then one naming the next step (for example "I couldn't confirm this Bolt's worktree from the audit record, so I'm not showing a path or branch. You can still choose Retry, Skip, or Abort below."); never quote a branch or path from the audit or build one from the slug yourself, and leave the refusal text in the tool result. See [Bolt identity](../../knowledge/aidlc-shared/worktree-info-schema.md#bolt-identity) for the JSON and naming contract.

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

---

### Per-Unit iteration

**Engine-driven per-unit iteration.** The orchestration engine now drives the per-Unit loop for the inline per-Unit design stages (functional-design, nfr-requirements, nfr-design, infrastructure-design) the same way it always has for code-generation: on a `next` that lands on an in-flight per-Unit stage (off the swarm path), the engine emits ONE `run-stage` directive per Unit, in Bolt build order, carrying the resolved Unit name in `directive.unit` and its artifact paths. The engine substitutes the next unsettled Unit on each `next`. For a stage-major or legacy stage gate, the stage's per-Unit gate is **suppressed** (`gate: false`) on every not-yet-settled Unit, and the stage's real gate is presented exactly once, on the re-entry after the LAST Unit settles, so a single stage-level approval covers all Units and cannot be reached until every Unit is built (the same "per-Unit gate suppressed, single gate replaces it" rule, now applied across all five per-Unit stages, and enforced deterministically: `report --result approved` on a not-yet-completed per-Unit stage is refused while any Unit is unsettled). A workflow with no units-generation dependency artifact on disk degrades to one single-iteration directive (unchanged behaviour). When the artifact exists, the engine validates the compiled `bolt_dag` against it and recomputes the unit batches on the spot if the cache is missing or stale, so the per-unit loop never silently shrinks to an outdated unit set; an artifact whose units block does not parse is surfaced as an error instead.

**Unit lifecycle receipts.** On a per-Unit body directive without `directive.wave`, `construction_checkpoint`, or `construction_policy.completion_only`, bracket the Unit's work with the receipt verbs: `{{INVOKE}} engine state unit start --stage <slug> --unit <name>` before the body, and `... unit complete --stage <slug> --unit <name>` after the Unit's artifacts are written (complete verifies that every required artifact is a regular file on disk and refuses directories or missing paths, and refuses while the Unit's review request is open with no verdict, unless the person has spoken since the last question or picked the receipt on a recovery ask — the receipt is the completion signal, artifacts are the evidence it checks). Pass the exact `directive.stage` + `directive.unit` pair emitted by the engine: `unit start` re-runs the route as a read-only engine observation (it publishes no directive and writes no state, receipt, or approval evidence, and a durable write from that path fails loudly rather than silently) and refuses a DAG member whose dependencies or earlier same-batch Units are not settled. New Unit names use lowercase kebab-case; safe legacy single-segment names (including digit-leading names, uppercase letters, underscores, and dots) remain accepted by existing DAGs and autonomous swarms, which use a deterministic internal Bolt slug without changing the Unit identity. An autonomy grant does not disable these receipts when a backward jump routes an inline per-Unit stage; only a stage currently owned by the autonomous swarm refuses them. If the Unit must stop before completion (blocking question, failed dependency, session ending mid-Unit), record the checkpoint with single-line text: `... unit pause --stage <slug> --unit <name> --reason "<why>" --next-action "<the exact next step>"`. Every lifecycle row carries an exact stage-attempt `Run floor` (`<boundary-event>:<timestamp>#<ordinal>`); when equal second-precision boundaries in different audit shards are causally unordered, the engine uses a deterministic `AMBIGUOUS:<timestamp>#<digest>` floor that invalidates older receipts instead of trusting shard filename order. Receipt validity is decided by the attempt floor and the content bindings on the row, never by the order in which shards or rows were written. Once any receipt exists for a stage, every later attempt stays in receipt mode and requires a current-attempt `UNIT_COMPLETED` receipt per Unit. Artifact files alone no longer settle a Unit, so a stale, paused, reopened, or partially-written Unit can never be mistaken for done. A paused Unit routes FIRST and hard-stops the loop: the engine emits an `ask` naming the Unit, its recorded reason, and next action (`unit_state: paused`), and no other work may start until an explicit `... unit resume --stage <slug> --unit <name>`. `unit start` refuses while another Unit of the stage is open (one active Unit at a time; resume or complete it first). The one exception is a Unit the person set aside for another (a pause with `--set-aside-for <unit>`, which a unit-major reopen or pick-up names): follow the engine's route, which takes the Unit it was set aside for first, lets that Unit start even on the paused Unit's stage, and then asks to resume the set-aside Unit. When Construction checkpoints apply (`Construction Checkpoints: enabled` on solo work whose Construction includes a source-producing per-Unit stage), the receipt is required from the first Unit, so artifact files alone never settle one; without them, a workflow that never calls the verbs keeps artifact-driven coverage. When a Unit's files are written and its final review is recorded but its receipt is not, `next` names the receipt commands instead of repeating the stage body: run them, then `next`. Code Generation carries them in `unit_record_step` on the Unit’s published directive so its Plan Approval authority is current; other stages print them. When the review is the record that is missing instead, `next` prints the review step this attempt is waiting for (the first request when none was asked for, the verdict when a request is waiting, or the next pass after the reviewer asked for repairs) on the same condition, rather than handing back the stage body with nothing said. That condition is that the files are this attempt's: it is the Unit's first attempt at the stage, or, for Code Generation, the build started on the plan approved in this attempt, every step is ticked with the files it names present, and the Unit's `source-manifest.json` reads, so a Unit reopened by a rejection and built again in full is asked for its review. With reviews off there is no review to record, so `next` prints the receipt commands on that same condition; otherwise, after a jump or a rejection, the stage body comes back.

**Per-unit batch waves.** A step that carries `directive.wave` runs by the wave module (`stage-protocol-wave.md`), which the engine names on it.

**Unit-major iteration.** New workflows default to `Construction Iteration:
unit-major`; preserve a recorded stage-major choice and do not rewrite existing
workflows. The engine walks every applicable per-unit stage for one Unit before
the next, including Code Generation. Each Unit's Plan Approval remains a human
stop, and unit-major never invokes swarm. Checkpoint-enabled solo work then
verifies and approves the Unit through `construction_checkpoint`; the late stage
gates carrying `completion_only: true` are bookkeeping. With checkpoints off, or
in a legacy workflow without the field, the stage approvals still due after the
last Unit are one human question (`directive.approve_together`, as the Stage
Protocol's approval gate describes). A directive may
name a later stage than `Current Stage`; always use `directive.stage` and
`directive.unit`, including in a conditional skip report
(`--stage "<directive.stage>" --unit "<directive.unit>"`), which covers that
Unit only; the other Units still get the stage. Lifecycle and review evidence
remain keyed to the current
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
The body, any enabled summary checkpoint, lifecycle completion, and reviewer are already
settled; do not regenerate or re-review them. Run the learnings presentation only when `directive.protocol_modules` lists `learnings`, then the approval gate. In team-owned unit work, every non-gate
`aidlc-log.ts decision` / `answer` call also adds
`--unit "<directive.unit>"` so pending human decisions remain attempt- and
Unit-scoped. Every report call for this gate adds
`--unit "<directive.unit>"`: first `awaiting-approval`, then `approved
--user-input "Approve"` (with `--park` when they also asked to stop), or
`rejected --user-input "Request Changes"` and later `revised`. Rejection floors only that Unit's lifecycle/review receipts;
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
--user-input '<text>'`. On approval, `aidlc unit land <unit> --target <branch>`
owns the transaction: pinned git content first with main-owned metadata retained,
then one Unit-row fold under the intent lock, then audit/finalization. A moved
claim ref requires re-pin, and an unavailable registry makes gate/land fail
closed. If the exact attempt is released only after the git step landed, inspect
the merge and continue explicitly with `aidlc unit land <unit>
--accept-released-attempt --user-input '<human acknowledgment>'`; a successor
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

## Harness construction bindings

### Claude Code

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins: emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` emits the resolved Construction directive; apply metadata routing before any body or gate. Follow its stage and Unit, including a skeleton-first Unit route, rather than assuming the previous stage is re-emitted. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow for THIS unit; only when `directive.ceremony.summary_confirmation === "on"`, apply the PRE-GENERATION SUMMARY STOP, passing `--unit "<directive.unit>"` to both checkpoint log commands. When summary confirmation is off, generate directly with no checkpoint or receipt. Then run the body and write its artifacts under `construction/<directive.unit>/<directive.stage>/`; only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. For a remaining per-unit stage gate, use `construction_policy.human_completion_required` to choose routine human completion or automatic reporting; only the legacy path without policy retains the single human stage gate, running the §13 ritual only when `directive.protocol_modules` lists `learnings`. Checkpoint and completion-only directives must already have branched before this body procedure. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Kiro CLI

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins: emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` emits the resolved Construction directive; apply metadata routing before any body or gate. Follow its stage and Unit, including a skeleton-first Unit route, rather than assuming the previous stage is re-emitted. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow for THIS unit; only when `directive.ceremony.summary_confirmation === "on"`, apply the PRE-GENERATION SUMMARY STOP, passing `--unit "<directive.unit>"` to both checkpoint log commands. When summary confirmation is off, generate directly with no checkpoint or receipt. Then run the body and write its artifacts under `construction/<directive.unit>/<directive.stage>/`; only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. For a remaining per-unit stage gate, use `construction_policy.human_completion_required` to choose routine human completion or automatic reporting; only the legacy path without policy retains the single human stage gate, running the §13 ritual only when `directive.protocol_modules` lists `learnings`. Checkpoint and completion-only directives must already have branched before this body procedure. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Kiro IDE

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins: emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` emits the resolved Construction directive; apply metadata routing before any body or gate. Follow its stage and Unit, including a skeleton-first Unit route, rather than assuming the previous stage is re-emitted. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow for THIS unit; only when `directive.ceremony.summary_confirmation === "on"`, apply the PRE-GENERATION SUMMARY STOP, passing `--unit "<directive.unit>"` to both checkpoint log commands. When summary confirmation is off, generate directly with no checkpoint or receipt. Then run the body and write its artifacts under `construction/<directive.unit>/<directive.stage>/`; only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. For a remaining per-unit stage gate, use `construction_policy.human_completion_required` to choose routine human completion or automatic reporting; only the legacy path without policy retains the single human stage gate, running the §13 ritual only when `directive.protocol_modules` lists `learnings`. Checkpoint and completion-only directives must already have branched before this body procedure. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Codex CLI

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins: emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` emits the resolved Construction directive; apply metadata routing before any body or gate. Follow its stage and Unit, including a skeleton-first Unit route, rather than assuming the previous stage is re-emitted. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow for THIS unit; only when `directive.ceremony.summary_confirmation === "on"`, apply the PRE-GENERATION SUMMARY STOP, passing `--unit "<directive.unit>"` to both checkpoint log commands. When summary confirmation is off, generate directly with no checkpoint or receipt. Then run the body and write its artifacts under `construction/<directive.unit>/<directive.stage>/`; only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. For a remaining per-unit stage gate, use `construction_policy.human_completion_required` to choose routine human completion or automatic reporting; only the legacy path without policy retains the single human stage gate, running the §13 ritual only when `directive.protocol_modules` lists `learnings`. Checkpoint and completion-only directives must already have branched before this body procedure. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### Cursor

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins: emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` emits the resolved Construction directive; apply metadata routing before any body or gate. Follow its stage and Unit, including a skeleton-first Unit route, rather than assuming the previous stage is re-emitted. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow for THIS unit; only when `directive.ceremony.summary_confirmation === "on"`, apply the PRE-GENERATION SUMMARY STOP, passing `--unit "<directive.unit>"` to both checkpoint log commands. When summary confirmation is off, generate directly with no checkpoint or receipt. Then run the body and write its artifacts under `construction/<directive.unit>/<directive.stage>/`; only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. For a remaining per-unit stage gate, use `construction_policy.human_completion_required` to choose routine human completion or automatic reporting; only the legacy path without policy retains the single human stage gate, running the §13 ritual only when `directive.protocol_modules` lists `learnings`. Checkpoint and completion-only directives must already have branched before this body procedure. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### opencode

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins: emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` emits the resolved Construction directive; apply metadata routing before any body or gate. Follow its stage and Unit, including a skeleton-first Unit route, rather than assuming the previous stage is re-emitted. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow for THIS unit; only when `directive.ceremony.summary_confirmation === "on"`, apply the PRE-GENERATION SUMMARY STOP, passing `--unit "<directive.unit>"` to both checkpoint log commands. When summary confirmation is off, generate directly with no checkpoint or receipt. Then run the body and write its artifacts under `construction/<directive.unit>/<directive.stage>/`; only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. For a remaining per-unit stage gate, use `construction_policy.human_completion_required` to choose routine human completion or automatic reporting; only the legacy path without policy retains the single human stage gate, running the §13 ritual only when `directive.protocol_modules` lists `learnings`. Checkpoint and completion-only directives must already have branched before this body procedure. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

---

### GitHub Copilot

- **`gate: "unresolved"`** — the initial Construction route depends on the **walking-skeleton stance**, which no parser can derive from a team's free-form `## Walking Skeleton` practices prose. This is your knowledge-work, handed back to the engine. Do NOT run the stage body yet. Instead: read the `## Walking Skeleton` section (resolution order `aidlc/spaces/<space>/memory/org.md` → `team.md` → `project.md`; most-specific non-empty statement wins) and classify the stance — **"always"/"every greenfield feature"** → `on`; **"never"** → `off`; **"scope-dependent"/unspecified/empty** → `scope-dependent` (the engine then uses the active scope file's `skeleton:` field). Honour the `PRACTICES_OVERRIDE` judgement (a bolt-plan marker contradicting practices loses; practices wins: emit the override row first). Then `report --skeleton-stance <on|off|scope-dependent>`; the next `next` emits the resolved Construction directive; apply metadata routing before any body or gate. Follow its stage and Unit, including a skeleton-first Unit route, rather than assuming the previous stage is re-emitted. See the conductor persona for the full classification rules.

**Per-unit iteration (`directive.unit`).** After Construction metadata routing has excluded checkpoint and completion-only directives, when `directive.unit` is present, this `run-stage` is ONE iteration of a per-unit Construction stage (`for_each: unit-of-work`, covering the 3.1-3.4 design stages and code-generation). Run the question flow for THIS unit; only when `directive.ceremony.summary_confirmation === "on"`, apply the PRE-GENERATION SUMMARY STOP, passing `--unit "<directive.unit>"` to both checkpoint log commands. When summary confirmation is off, generate directly with no checkpoint or receipt. Then run the body and write its artifacts under `construction/<directive.unit>/<directive.stage>/`; only when `directive.reviewer` is present, follow stage-protocol-reviewer.md §12a for this unit only. The engine drives the loop: if `directive.gate` is **false** on a per-unit directive, re-run `next` after the receipt-backed artifact work (do NOT report-approve, do NOT present a gate); the engine hands you the next uncovered unit, and once every unit is built it re-emits this stage with `gate: true`. For a remaining per-unit stage gate, use `construction_policy.human_completion_required` to choose routine human completion or automatic reporting; only the legacy path without policy retains the single human stage gate, running the §13 ritual only when `directive.protocol_modules` lists `learnings`. Checkpoint and completion-only directives must already have branched before this body procedure. When present, review accounting and normal budgets are per Unit; an invalidated terminal receipt gets the same single bounded stale-receipt recovery for that Unit. If `directive.unit` is absent because there is no compiled Unit DAG, run one ordinary stage iteration with no Bolt or per-Unit ceremony. When unit-major construction iteration is recorded (`Construction Iteration: unit-major`), the engine may emit a `directive.stage` that names a LATER Construction stage (including code-generation, which the unit-major walk covers) than the state's Current Stage; always act on the directive's own `directive.stage` + `directive.unit`, never on Current Stage.

### Grouped Plan Approval

When several Units' plans are ready at once, the engine asks about them in one
question: `plan_approval.targets` carries each Unit's summary and plan path, and
the choices are **Approve all**, **Request Changes**, and **I'll edit the files**.
Show every Unit's summary lines under the question and end the turn. Read the
person's reply and record the choice they made, as for one plan:
`{{INVOKE}} engine log answer --stage code-generation --checkpoint plan-approval
--details "Approve Plan"` (or `"Request Changes"`, or `"I'll edit the files"`),
with `--units "<unit>,<unit>"` to record a choice for some Units, then the rest;
then run `next`. "Approve all" approves every Unit. For a change that names a
Unit ("change billing: use Stripe"), record Request Changes for that Unit and
Approve Plan for the rest; for a change that names no Unit, ask once which plan
should change. An exact "Approve all" or "I'll edit the files" is recorded for
you; a bare Request Changes still needs to know which plan. Every Unit still
gets its own approval record, bound to its own plan; grouping only changes how
the question is shown, and never approves a later batch.
