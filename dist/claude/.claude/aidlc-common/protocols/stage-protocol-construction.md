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

Construction introduces three gate patterns that differ from the standard per-stage approval gate. See SKILL.md §CONSTRUCTION Flow for the complete orchestrator behaviour.

**Walking-skeleton gate (first Bolt when a real Unit DAG exists)**

When the resolved Unit DAG has a first Bolt and the applicable skeleton stance
selects the walking-skeleton ceremony, that Bolt always presents a Bolt-level
approval gate regardless of any autonomy-mode setting. The gate covers the
Bolt's design artifacts and generated code together. Audit: emit
`GATE_APPROVED` as usual; the enclosing `BOLT_COMPLETED` ties the gate to the
Bolt. Skeleton-off uses the ordinary first-Bolt gate; a zero-Unit stage has no
Bolt ceremony at all.

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

- Record the answer in `aidlc-state.md` as `Construction Autonomy Mode: autonomous` or `Construction Autonomy Mode: gated` via `aidlc-bolt.ts set-autonomy --mode <choice>` (which emits `AUTONOMY_MODE_SET` itself).
- The ladder choice is set-autonomy-owned, like an approval choice is report-owned: do NOT call `aidlc-log.ts decision` or `aidlc-log.ts answer` for it. Switching to `autonomous` requires the human's fresh turn (the ladder answer) — logging the choice as an interview answer first would consume that turn and the mode switch would refuse.
- Session resume: if `Construction Autonomy Mode: unset` but the walking skeleton is already `[x]` complete, re-fire the ladder prompt before executing the next Bolt.

**Subsequent Bolt gate (per autonomy mode)**

For Bolts after the walking skeleton, the Bolt-level gate is presented only if `Construction Autonomy Mode: gated`. In `autonomous` mode the gate is skipped. For parallel batches the gate covers every Bolt in the batch (single gate, not one per Bolt).

**Halt-and-ask on failure**

When a Bolt's code-generation returns failure, **always halt and present the halt-and-ask prompt regardless of autonomy mode**. This is the one case where `autonomous` mode stops to consult the user.

- Solo Bolt failure: halt immediately, emit `BOLT_FAILED` (with `--slug` for halt-and-ask correlation), present retry / skip / abort.
- Parallel batch partial failure: wait for all parallel Tasks to return, preserve successful Bolts' artifacts, emit `BOLT_FAILED` for the failed Bolt with `Succeeded=[names]`, present `"Bolts [X, Y] succeeded, Bolt [Z] failed with: [error]. Options: retry Z, skip Z, abort Construction."`
- Retry: re-run the failed Bolt only inside the existing worktree.
- Skip: mark `[S]` in state with reason, proceed to next batch. Worktree at `<path>` is preserved.
- Abort: stop Construction; user can resume later. Worktree at `<path>` is preserved.

The orchestrator runs `bun .claude/tools/aidlc-worktree.ts info --slug <slug>` to obtain the worktree `<path>` and `<branch_name>` deterministically before composing the halt-and-ask question. See `SKILL.md` § "Halt-and-ask failure handling" for the full tool-call sequence and the `worktree-info-schema.md` knowledge file for the JSON contract.

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

### Within-Bolt Question Collection (Construction)

Construction runs **Bolt by Bolt** (see SKILL.md §CONSTRUCTION Flow for orchestrator behaviour). Within each Bolt, questions across the Bolt's Units are collected upfront before any artifacts or code are produced. This keeps the human's interactive work concentrated at the start of each Bolt.

When the orchestrator runs a Bolt in phased mode:

1. **Questions**: For each applicable design stage (3.1–3.4), for each Unit in the Bolt (in build order), execute the stage file in QUESTION-ONLY mode. Questions are grouped by stage — all functional design questions for the Bolt's Units together, then all NFR questions, etc.
2. **Within each stage group**, questions are labeled by Unit name so cross-Unit concerns in the Bolt are visible together.
3. **The standard question protocol** (interaction mode choice, answer collection, ambiguity analysis) applies once per stage group within the Bolt, not per Unit.
4. **A single Bolt-level answers gate** confirms the Bolt's answers across all stages before design artifacts begin.
5. **Design artifacts**: Stage files execute in ARTIFACT-ONLY mode — reading the approved answers and generating artifacts. No human interaction during generation.
6. **Code generation (3.5)**: Per-Unit Task delegation to the aidlc-developer-agent. The stage file's per-Unit approval gate is **suppressed by the orchestrator** — a single Bolt-level gate (or batch-level gate for parallel batches) replaces it. Under an autonomous Construction swarm the engine drives one batch per `next` and presents that single stage-level gate only after the FINAL batch has converged (the intermediate batches merge without a gate).
7. **Bolt gate**: Walking skeleton — always present. Subsequent Bolts — per `Construction Autonomy Mode`. Failure always halts and asks regardless of mode. See SKILL.md §CONSTRUCTION Flow for the ladder prompt, autonomy mode, and halt-and-ask details.

**Engine-driven per-unit iteration.** The orchestration engine now drives the per-Unit loop for the inline per-Unit design stages (functional-design, nfr-requirements, nfr-design, infrastructure-design) the same way it always has for code-generation: on a `next` that lands on an in-flight per-Unit stage (off the swarm path), the engine emits ONE `run-stage` directive per Unit, in Bolt build order, carrying the resolved Unit name in `directive.unit` and its artifact paths. The engine substitutes the next unsettled Unit on each `next`. The stage's per-Unit gate is **suppressed** (`gate: false`) on every not-yet-settled Unit, and the stage's real gate is presented exactly once, on the re-entry after the LAST Unit settles, so a single stage-level approval covers all Units and cannot be reached until every Unit is built (the same "per-Unit gate suppressed, single gate replaces it" rule point 6 already states for code-generation, now applied across all five per-Unit stages, and enforced deterministically: `report --result approved` on a not-yet-completed per-Unit stage is refused while any Unit is unsettled). A workflow with no units-generation dependency artifact on disk degrades to one single-iteration directive (unchanged behaviour). When the artifact exists, the engine validates the compiled `bolt_dag` against it and recomputes the unit batches on the spot if the cache is missing or stale, so the per-unit loop never silently shrinks to an outdated unit set; an artifact whose units block does not parse is surfaced as an error instead.

**Unit lifecycle receipts.** On each inline per-Unit directive, bracket the Unit's work with the receipt verbs: `bun .claude/tools/aidlc-state.ts unit start --stage <slug> --unit <name>` before the body, and `... unit complete --stage <slug> --unit <name>` after the Unit's artifacts are written (complete verifies that every required artifact is a regular file on disk and refuses directories or missing paths — the receipt is the completion signal, artifacts are the evidence it checks). Pass the exact `directive.stage` + `directive.unit` pair emitted by the engine: `unit start` re-runs the read-only route and refuses a DAG member whose dependencies or earlier same-batch Units are not settled. New Unit names use lowercase kebab-case; safe legacy single-segment names (including digit-leading names, uppercase letters, underscores, and dots) remain accepted by existing DAGs and autonomous swarms, which use a deterministic internal Bolt slug without changing the Unit identity. An autonomy grant does not disable these receipts when a backward jump routes an inline per-Unit stage; only a stage currently owned by the autonomous swarm refuses them. If the Unit must stop before completion (blocking question, failed dependency, session ending mid-Unit), record the checkpoint with single-line text: `... unit pause --stage <slug> --unit <name> --reason "<why>" --next-action "<the exact next step>"`. Every lifecycle row carries an exact stage-attempt `Run floor` (`<boundary-event>:<timestamp>#<ordinal>`); when equal second-precision boundaries in different audit shards are causally unordered, the engine uses a deterministic `AMBIGUOUS:<timestamp>#<digest>` floor that invalidates older receipts instead of trusting shard filename order. Once any receipt exists for a stage, every later attempt stays in receipt mode and requires a current-attempt `UNIT_COMPLETED` receipt per Unit. Artifact files alone no longer settle a Unit, so a stale, paused, reopened, or partially-written Unit can never be mistaken for done. A paused Unit routes FIRST and hard-stops the loop: the engine emits an `ask` naming the Unit, its recorded reason, and next action (`unit_state: paused`), and no other work may start until an explicit `... unit resume --stage <slug> --unit <name>`. `unit start` refuses while another Unit of the stage is open (one active Unit at a time; resume or complete it first), and workflows that never call the verbs keep today's artifact-driven coverage unchanged.

**Per-unit batch waves (optional, stage-major only).** For functional-design, nfr-requirements, nfr-design, and infrastructure-design on the default stage-major walk, the engine may emit `directive.wave` from one healed Bolt-DAG snapshot. Code Generation remains wave-ineligible because it writes the shared workspace and hard-stops for Plan Approval. Each entry carries resolved Unit-local inputs/outputs, `required_produces`, `unit_memory_path`, `build_required`, `completion_required`, and receipt-backed `review_state` / `review_iteration`; kind-vacuous and fully settled Units are omitted, and large batches arrive as deterministic same-batch prefixes. The parent retains `stage_file`, the complete `inline_context_paths`, `context_warnings`, the accumulated steering bundle, effective `review_class`, reviewer settings, sensors, and the stage-level `memory_path`. Never reconstruct siblings from `runtime-graph.json`.

When `directive.wave` is present, branch on it before the ordinary per-Unit or gate path; the parent Unit fields are compatibility projections of the first entry and are not separate work. Show parent warnings once, then give every builder the parent stage file, all inline context, and the complete steering bundle verbatim plus only its entry's paths. Dispatch entries concurrently where the harness supports independent workers; serial entry processing is the universal fallback. A builder with `build_required: true` runs the Unit-scoped question/summary checkpoint and writes its Unit artifacts and diary. It does not call the serial `unit start/pause/resume` verbs: the wave directive is the batch checkpoint, and a blocking question keeps the entry open by withholding a path from `entry.required_produces`, returning the question to the conductor, and stopping for the human.

After builds, `review_state: "outstanding"` runs the named iteration; `"retry-required"` repeats the unmatched request with `aidlc-log.ts review --retry-pending`; `"repair-required"` runs the lead-only repair and then the next reviewer iteration; and `"recovery-required"` runs the one stale-receipt recovery at the emitted `review_iteration`. `"escalation-required"` means that recovery was already spent: do not request another review or complete the Unit; halt and present the situation to the human, and only a human Request Changes decision may reset the stage attempt. `READY`, terminal `NOT-READY`, and `not-required` need no review work. Reviewer dispatches remain serialized where the single reviewer-scope record is enforced; only an enforcement-free harness may run them as parallel foreground work. Once an entry is build-complete and review-settled, run `bun .claude/tools/aidlc-state.ts unit complete --wave --stage <slug> --unit <name>`. That command re-verifies the live wave entry, copies new Unit diary entries verbatim into the parent diary with deterministic deduplication, binds the receipt to the final artifact fingerprint, and only then emits `UNIT_COMPLETED`. Therefore a crash before diary fan-in or a later artifact change leaves `completion_required: true` and re-hands the entry; neither a dependent batch nor the stage gate can overtake build, review, memory, or completion evidence. Re-run `next` without report-approve after processing the emitted prefix. Unit-major iteration stays serial and never carries `directive.wave`.

**Unit-major iteration (opt-in).** By default the walk above is stage-major: a design stage runs for every Unit, then the next design stage runs for every Unit, and code-generation runs last for every Unit. When the state file records `Construction Iteration: unit-major` under `## Runtime State` (set at delivery-planning via `aidlc-state.ts set-construction-iteration unit-major`, or by a human), the engine instead walks EVERY per-unit Construction stage unit-major: for each Unit in Bolt build order (outer), for each per-unit stage in graph order (inner — the four inline design stages, then code-generation), it emits the first unsettled (stage, Unit) pair with `gate: false`, so one Unit's four design documents are authored consecutively and the Unit is BUILT before the next Unit begins. The first working code therefore lands after ONE Unit's design, not after every Unit's; code-generation's own Step 3 Plan Approval still hard-stops per Unit before generation. The autonomous swarm never fires under unit-major: the walk owns code-generation through the normal non-swarm per-unit settlement path, so an `autonomous` grant changes no routing while the knob is set. The gates are UNCHANGED in count and machinery: the per-stage gates still fire, but late and in a cascade at the end of the block once the whole (stage x Unit) grid — code-generation included — is settled, one human approval per stage per turn. Because a stage's per-Unit work can run while `Current Stage` still points at an earlier stage, a directive's `directive.stage` may name a LATER Construction stage (including code-generation) than `Current Stage`, and a stage's `STAGE_STARTED` audit event may land after that stage's per-Unit artifacts were written; unit-major receipt floors therefore use the current workflow/jump/rejection boundary and survive that later `STAGE_STARTED`. The audit trail stays complete and stage-keyed. Always act on the directive's own `directive.stage` + `directive.unit`, never on `Current Stage`.

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
   `Approve Plan`, record the answer and re-run `next`; the engine may re-emit
   the same batch while other units still need approval. Do not fork worktrees
   or dispatch implementation workers during these planning turns.
3. Call `prepare` only after every unit in the emitted batch has current
   approval evidence. On autonomous Code Generation, `prepare` verifies the
   plan, test instructions, embedded contract, answer, and fingerprint before
   creating any worktree. A stale memory/scope/test-strategy/project-type input
   therefore reopens approval instead of silently changing execution.
4. Every worker brief starts with exactly:

   ```text
   AIDLC-UNIT: <unit>
   AIDLC-TESTING-CONTRACT: <contract_sha256 from that unit's approved plan>
   ```

   Then include the full approved `code-generation-plan.md` and
   `unit-test-instructions.md`. The approved Testing Contract is authoritative:
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
