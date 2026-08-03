# RFC: Reviewer Reliability & Stage-Execution Decomposition

**Status:** Draft for team discussion
**Author:** AWS Labs
**Scope:** `core/` orchestration engine, stage protocol, harness SKILL.md loops
**Related:** the 2.0.0 reviewer mechanism (#383), the 0.7.12 graph-compile fix

---

## 1. Problem

Stages can declare a `reviewer` sub-agent that runs as a quality gate after the
stage body produces its artifacts. In practice **the reviewer does not fire
reliably** — sometimes it is skipped entirely, with no error and no trace.

The data plumbing is sound; the *invocation* is not. The reviewer is one prose
instruction inside a large `run-stage` directive, and nothing in the engine
forces it, records it, or makes the approval gate depend on it. A diligent model
(Opus 4.8) usually runs it; a weaker model, or a long context, silently drops
it. This is the same failure class as "the conductor pre-filled every answer tag
and the stop hook couldn't tell it was still waiting" — **a load-bearing step is
left to model judgment instead of being mechanically enforced.**

This RFC proposes two tracks:

- **Track 1 (tactical, low-risk):** make the reviewer *enforceable and
  observable* without restructuring the directive — an audit-event pair plus a
  gate precondition. Ships reliability immediately; forward-compatible with
  Track 2.
- **Track 2 (structural, the real fix):** decompose the monolithic `run-stage`
  directive into its three intrinsic phases — **ask-questions →
  generate-artifact → review** — each an engine-emitted directive with its own
  turn boundary, audit event, and enforcement. Fixes the reviewer *and* the
  whole class of "model skipped a sub-step" bugs uniformly.

---

## 2. How the reviewer works today (as-built)

The one-line summary: **the reviewer is compile-baked *data* but a prose-driven
*action*.** Everything about *which* reviewer and *how many* iterations is
validated at compile time and travels all the way to the conductor in the
directive. But the *act of invoking it* is a sentence in a prose checklist that
the model is trusted to execute. The data plane is airtight; the control plane
is a suggestion.

Here is the full path, layer by layer.

### 2.1 Layer 1 — Frontmatter (the author's declaration)

A stage opts into review by declaring two fields in its YAML frontmatter:

```yaml
# core/aidlc-common/stages/inception/requirements-analysis.md
slug: requirements-analysis
mode: inline
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
```

11 stages declare a reviewer today: `requirements-analysis`, `user-stories`,
`rough-mockups`, `units-generation`, `application-design`, the four design
stages (`functional-design`, `nfr-design`, `nfr-requirements`,
`infrastructure-design`), and `code-generation`. Two reviewer personas ship:
`aidlc-product-lead-agent` (product/requirements stages) and
`aidlc-architecture-reviewer-agent` (design/technical stages). Both persona
files carry `IMPORTANT: Do NOT use the Task tool` — a reviewer is a leaf; it
must not spawn its own sub-agents.

### 2.2 Layer 2 — Compile (validation + bake onto the node)

`aidlc-graph.ts compile` parses the frontmatter and copies the two fields onto
the `GraphStage` node written to `stage-graph.json`:

```ts
// aidlc-graph.ts — GraphStage
reviewer?: string;                 // the agent to invoke after the body
reviewer_max_iterations?: number;  // review-cycle cap; defaults to 2
```

Compile-time validation is real and strict (stage-schema Rule 9): a `reviewer`
naming an agent with no `agents/*.md` file is **rejected**, and a
`reviewer_max_iterations` that is non-numeric / zero / negative / non-integer /
present-without-a-reviewer **fails the compile** (this was the 2.0.2 fix — those
malformed configs used to pass and silently disable the loop). When a reviewer
is declared with no explicit cap, the compiler defaults it to `2` and guards
against `NaN` ever reaching `stage-graph.json`.

So by the end of compile, the node deterministically carries `reviewer` +
`reviewer_max_iterations`, or neither. No ambiguity.

### 2.3 Layer 3 — Directive (the engine hands it to the conductor)

When the engine routes to a stage, `buildRunStageDirective` reads the node and
copies the reviewer fields straight onto the emitted `run-stage` directive:

```ts
// aidlc-orchestrate.ts — buildRunStageDirective
if (node.reviewer) {
  directive.reviewer = node.reviewer;
  directive.reviewer_max_iterations = node.reviewer_max_iterations ?? 2;
}
```

**This works.** The directive genuinely arrives at the conductor carrying, e.g.:

```json
{
  "kind": "run-stage",
  "stage": "requirements-analysis",
  "mode": "inline",
  "gate": true,
  "reviewer": "aidlc-product-lead-agent",
  "reviewer_max_iterations": 2,
  "stage_file": ".kiro/aidlc-common/stages/inception/requirements-analysis.md",
  ...
}
```

The 0.7.12 fix confirmed this end-to-end: before it, the compiler dropped the
field and the directive never carried a reviewer, so §12a's "invoke a reviewer
only when the directive includes one" always saw nothing and skipped. That bug
is fixed — the field is present. The *remaining* unreliability is entirely in
the next layer.

### 2.4 Layer 4 — Invocation (prose, inside one model turn — the gap)

The `run-stage` directive is a **single blob** that the conductor is told to
walk as an ordered checklist. From the harness `SKILL.md` `gate: true` branch:

> after the stage body produces its artifacts:
> 1. **Reviewer step (§12a):** if `directive.reviewer` is present, invoke the
>    reviewer as a sub-agent (via `Task`), pass the stage-def / Q&A / artifact
>    paths (NOT memory.md or plan.md), read its `## Review` verdict; on NOT-READY
>    with iterations left, send findings back to the builder and re-invoke;
>    on READY or exhausted, proceed.
> 2. run stage-completion verification
> 3. run the §13 learnings ritual
> 4. present the approval gate → `report --result approved`

And `stage-protocol.md` §12a spells out the reviewer contract: invoke as a
**separate sub-agent**, pass stage-def + Q&A + artifact paths (never the
builder's diary), the reviewer appends a `## Review` section with a **READY /
NOT-READY** verdict to the primary artifact, and the conductor loops
artifact↔review up to `reviewer_max_iterations` (default 2) before proceeding to
the gate with any unresolved findings noted.

The entire reviewer lifecycle — dispatch, verdict read, the NOT-READY re-loop —
is **step 1 of 4 in a prose checklist executed inside a single model turn.**
There is no engine round-trip between "artifacts produced" and "gate presented."

### 2.5 Why it is unreliable

Because the invocation lives inside one model turn as prose, four structural
gaps make it skippable and undetectable:

- **No directive boundary.** Contrast the two things the conductor *reliably*
  pauses for: scope-confirmation arrives as its own `ask` directive (which
  structurally forces a turn boundary — the engine hands control back and waits),
  and the approval gate is committed through `report` (a separate tool call the
  engine owns). The reviewer has neither — no `ask`, no dedicated `report`
  outcome, no engine round-trip. It is one bullet among four in a checklist the
  model walks in a single breath.
- **No audit event.** There is **no `REVIEW_*` event type at all** — verified:
  the `VALID_EVENT_TYPES` set in `aidlc-audit.ts` has zero review events. So the
  reviewer firing (or not) is completely invisible: nothing records that it ran,
  nothing detects that it was skipped, `--doctor` cannot flag it, the
  runtime-graph has no reviewer analog to its `sensor_firings` /
  `learnings_captured` tracking. It is the only major stage step with no audit
  footprint.
- **No gate dependency.** `report --result approved` has no precondition that a
  review occurred. The conductor can produce artifacts, skip step 1, run §13, and
  `report approved` — and the engine commits the transition happily. The reviewer
  is load-bearing for *quality* but structurally *optional* for *advancing*.
- **Observed live.** In a Kiro CLI run the reviewer *did* fire — but only because
  Opus 4.8 is diligent, and even then its **first** invocation failed (the
  sub-agent reported it had no file-reading tools and could not read the
  artifacts) and the conductor had to self-recover by re-invoking with the
  artifact text inlined in the prompt. A less careful model, or the same model
  under more context pressure, drops step 1 entirely and no one is the wiser.

### 2.6 The deeper observation

Review is not a gate bolted onto the end — it is **the third phase of the
stage's own execution**: ask-questions → generate-artifact → review. The
reviewer is unreliable for the same reason any sub-step is: the engine emits one
directive for the whole stage and trusts the model to walk all phases in order
without dropping any. This is why Track 2 treats the reviewer not as a special
case but as one of three symmetric phases.

### 2.7 What already exists (latent decomposition)

The three-phase split Track 2 formalizes is **already partly present**, which
de-risks it — we would be promoting an informal pattern to a first-class one,
not inventing from scratch:

1. **Stage files already declare execution modes.** The Construction design
   stages carry, in prose:
   - `QUESTION-ONLY mode` — load personas, read context, generate questions,
     collect answers; return to orchestrator.
   - `ARTIFACT-ONLY mode` — skip questions (already collected); generate
     artifacts.
   - `Full mode` — run all steps (default for single-unit / direct invocation).

   But these are *prose modes the conductor self-selects*, wired only for the
   Bolt question/design phase split.

2. **The Bolt flow already phase-batches.** `stage-protocol.md` "phased mode"
   runs QUESTION-ONLY across all units of a Bolt, gates the answers, then
   ARTIFACT-ONLY across all units. The engine-orchestrated phase split is
   already a proven pattern for Construction — just prose-driven, not directive.

3. **`report` + the per-unit loop already round-trip.** The per-unit
   Construction loop already does "run a slice, `next` again, engine hands you
   the next unit." The "do a slice → report → engine re-emits" machinery exists.

So Track 2 generalizes an existing Construction pattern into the universal
stage-execution model.

---

## 3. Track 1 — Enforce the reviewer in place (tactical)

**Goal:** make the reviewer non-optional and observable **without** touching the
directive structure. Stop the silent skips now; keep the change
forward-compatible with Track 2.

### 3.1 Mechanism

1. **Add two audit events** to the taxonomy (`aidlc-audit.ts` `VALID_EVENT_TYPES`
   + `EVENT_HEADINGS`, `docs/reference/12-state-machine.md`,
   `knowledge/aidlc-shared/audit-format.md`):
   - `REVIEW_REQUESTED` — emitted when the conductor dispatches the reviewer
     (fields: `Stage`, `Reviewer`, `Iteration`).
   - `REVIEW_COMPLETED` — emitted when a verdict is read (fields: `Stage`,
     `Reviewer`, `Verdict` = READY|NOT-READY, `Iteration`).

2. **A tool actor emits them**, not the LLM free-hand. Add
   `aidlc-log.ts review --stage <slug> --reviewer <agent> --verdict <v>
   --iteration <n>` (mirrors the existing `decision`/`answer` actors). The
   conductor calls this immediately after reading the `## Review` verdict. This
   keeps the audit trail trustworthy (a tool writes the row, per the
   tool-as-actor discipline) rather than trusting the model to hand-write it.

3. **Gate precondition.** `report --result approved` (and the gate-start it may
   backfill) **refuses to commit for a reviewer-bearing stage** unless a
   `REVIEW_COMPLETED` row with a terminal verdict exists in the audit tail for
   that stage's current iteration. On a miss it returns an `error` directive:
   *"Stage <slug> declares a reviewer; no REVIEW_COMPLETED found. Invoke the
   reviewer (§12a) before approving."* The engine reads the stage node to know
   whether a reviewer is declared, so it can enforce this deterministically.

4. **`--doctor` surfaces skips.** With the events in place, doctor can flag a
   reviewer-bearing stage that reached `awaiting-approval` without a matching
   `REVIEW_COMPLETED` (defensive; the gate precondition should already prevent
   it).

### 3.2 What stays prose

The *act* of invoking the reviewer sub-agent (`Task` targeting the reviewer,
passing artifact + Q&A paths, the NOT-READY re-loop up to the cap) stays
conductor-side prose. Track 1 does not move the invocation into the engine — it
only makes the **outcome mandatory and recorded**. A skipped review now becomes
a hard stop at the gate instead of a silent omission.

### 3.3 Hard-block vs soft-block (product decision)

- **Hard-block (recommended):** cannot approve a reviewer-bearing stage without a
  recorded terminal review. Makes the reviewer truly load-bearing.
- **Soft-block:** warn at the gate but allow approval. Preserves "human always
  has final say" literally, but keeps the reviewer skippable — which is the bug.

Recommendation: **hard-block on the review *happening*, soft on its verdict.**
i.e. you must run the reviewer (READY or NOT-READY-after-N), but a NOT-READY
verdict still lets the human approve at the gate with findings noted. This
enforces the process without overriding human judgment on the content.

### 3.4 Files touched (Track 1)

- `core/tools/aidlc-audit.ts` — 2 new event types + headings.
- `core/tools/aidlc-log.ts` — new `review` subcommand (tool actor).
- `core/tools/aidlc-orchestrate.ts` — `report` gate precondition for
  reviewer-bearing stages (read node.reviewer, scan audit tail).
- `core/tools/aidlc-utility.ts` — `--doctor` reviewer-skip check.
- `core/aidlc-common/protocols/stage-protocol.md` — §12a: call
  `aidlc-log.ts review` after reading the verdict; note the gate precondition.
- All 4 harness `skills/aidlc/SKILL.md` — gate:true branch step 1: emit the
  review audit row before approving.
- `docs/reference/12-state-machine.md`, `knowledge/aidlc-shared/audit-format.md`
  — register the new events.
- Tests: audit-event roundtrip (t48/t52-class), a gate-precondition test
  (approve refused without REVIEW_COMPLETED, allowed with it), doc-count sync.

### 3.5 Risk

Low. No directive-shape change, no state-machine phase cursor, no per-unit/swarm
interaction. The only behavioral change is that approving a reviewer-bearing
stage now requires a recorded review — which is the intended contract. Fully
reversible.

### 3.6 Limits

Track 1 makes the reviewer **mandatory and auditable**, but the *invocation* is
still inside the model's turn — so the model still has to choose to run it; it
just can't reach the gate without having done so. It does not fix the sibling
problem (questions/answers can still be pre-filled or rushed). That is Track 2.

---

## 4. Track 2 — Decompose the stage into phase directives (structural)

**Goal:** stop emitting one `run-stage` blob and trusting the model to walk all
phases. Instead the engine emits **one directive per phase**, each forcing a
turn boundary, each observable and enforceable. The reviewer stops being a
special case — it is simply the third phase.

### 4.1 The three phases

Every stage decomposes into:

1. **ask-questions** — load personas, read upstream artifacts, generate the
   `<stage>-questions.md` file, collect + resolve answers. (Existing
   `QUESTION-ONLY` mode.)
2. **generate-artifact** — read answered questions, produce the `produces[]`
   artifacts, keep the diary. (Existing `ARTIFACT-ONLY` mode.)
3. **review** — invoke the reviewer sub-agent (only if the stage declares one),
   read the verdict, loop artifact↔review up to the cap. (Today's §12a prose.)

Then the existing **gate** (§13 learnings + approval) closes the stage.

Stages with no questions (some operation stages) or no reviewer simply have the
engine skip-emit that phase — the engine already knows both facts from the node.

### 4.2 Directive flow

```
next
  → run-questions      (conductor asks, collects, resolves; emits QUESTIONS_COLLECTED)
  → report --phase questions-collected
next
  → (optional answers checkpoint — can be an `ask` if the stage gates answers)
  → run-artifact       (conductor generates produces[]; emits ARTIFACT_PRODUCED)
  → report --phase artifact-produced
next
  → run-review         (emitted ONLY if node.reviewer; conductor invokes reviewer,
                        reads verdict; emits REVIEW_REQUESTED / REVIEW_COMPLETED)
  → report --phase review --verdict <ready|not-ready>
     ├─ not-ready & iter < cap → engine re-emits run-artifact (fix) then run-review
     └─ ready | iter exhausted → advance to gate
next
  → run-gate           (§13 learnings + approval, as today's gate)
  → report --result approved
```

Each `next` is a fresh engine call reading state; each phase is a discrete,
recorded transition. A skipped phase is now impossible — the engine will not
emit phase N+1's directive until phase N reports.

### 4.3 New engine state: the phase cursor

The engine currently tracks *which stage* is current (`Current Stage` +
checkbox). Track 2 adds *which phase within the stage*. Options:

- **(a) A `Stage Phase` field** in `aidlc-state.md` (`questions` |
  `artifact` | `review` | `gate`), advanced by `report --phase`.
- **(b) Derive it from the audit tail** — the last phase event for the current
  stage tells you where you are (no new persistent field; consistent with how
  runtime-compile already derives position). Preferred: it avoids a new
  stored-state invariant and re-uses the audit-as-source-of-truth pattern.

The directive kind can stay `run-stage` with a new `phase` field
(`directive.phase = "questions" | "artifact" | "review"`), OR become distinct
kinds (`run-questions`/`run-artifact`/`run-review`). A `phase` field on
`run-stage` is less churn to the harness loop tables and the directive validator;
distinct kinds are more self-documenting. **Recommend: one `run-stage` kind with
a `phase` discriminator** — smaller blast radius on the 4 SKILL.md tables.

### 4.4 The hard part: `for_each: unit-of-work` × phase

Construction design stages loop per unit AND now per phase. The Bolt flow
already interleaves these, and the phased model must express that interleaving:

```
Bolt (units U1..Un):
  for each unit:  run-stage phase=questions   (QUESTION-ONLY, per unit)
  → single answers gate covering the Bolt
  for each unit:  run-stage phase=artifact    (ARTIFACT-ONLY, per unit)
  for each unit:  run-stage phase=review      (per unit, if reviewer)
  → single Bolt-level approval gate
```

So the loop nesting is **phase-major, unit-minor** for questions/artifact
(batch all units through one phase before the next), but review is **per unit**
(today's "reviewer fires once per unit"). The engine's `emitForSlug` per-unit
driver already walks units for a phase; Track 2 extends it to walk (phase, unit)
pairs. This is the genuinely complex piece and the main source of risk.

### 4.5 The other hard part: the swarm

Autonomous Construction fans units to worktrees via `invoke-swarm`. Phase-split
must coexist:

- Does each swarm worker run all three phases in its worktree, or does the
  engine phase-batch before fan-out?
- Where does review happen — per worker (in-worktree) or centrally after merge?

Likely: the swarm keeps owning artifact+convergence per worktree, and **review
runs centrally on the merged result** (matching the reviewer's "independent,
sees it fresh" stance). But this needs its own design pass; the swarm is the
riskiest code in the repo.

### 4.6 Migration surface

- **Directive type** (`aidlc-directive.ts`) — add `phase` + `verdict`; validator
  updates.
- **Engine** (`aidlc-orchestrate.ts`) — phase-cursor resolution, `report
  --phase`, the phase↔unit loop, swarm interaction. The biggest change.
- **32 stage files** — every stage's Steps section conforms to the three-phase
  contract (today only Bolt-aware Construction stages declare the modes;
  ideation/inception stages do not).
- **4 harness SKILL.md** loop tables — new phase branching.
- **Audit taxonomy** — `QUESTIONS_COLLECTED`, `ARTIFACT_PRODUCED`,
  `REVIEW_REQUESTED`, `REVIEW_COMPLETED` (the last two shared with Track 1).
- **~a dozen tests** pinning the current single `run-stage` shape (t65/t66
  directive shape, t114 orchestrate-next, t118 gate-axis, t130/t127 runners,
  the Bolt/swarm e2e suite).
- **Docs** — stage-protocol §12a/§3 rewrite, state-machine chapter, orchestrator
  reference, phases-and-stages guide.

### 4.7 Risk

High. This touches the state machine, the per-unit Construction loop, and the
swarm — the three most safety-critical, most-tested subsystems. It deserves its
own milestone, a dedicated branch, and incremental rollout (e.g. land the
phase model for non-per-unit stages first, then Construction, then swarm).

---

## 5. Track 1 vs Track 2

| Axis | Track 1 (enforce in place) | Track 2 (phase directives) |
|------|----------------------------|----------------------------|
| Fixes reviewer skips | Yes (gate refuses without recorded review) | Yes (engine emits the review phase) |
| Fixes questions/answers rushed or pre-filled | No | Yes (each phase is its own gated turn) |
| Directive structure change | None | New `phase` discriminator + report outcomes |
| New engine state | None (audit-tail derived) | Phase cursor (audit-tail derived) |
| Per-unit / swarm impact | None | Significant (the hard part) |
| Stage-file changes | §12a prose only | All 32 stages conform to 3-phase contract |
| Test/doc surface | Small | Large |
| Risk | Low, reversible | High, milestone-scale |
| Time-to-reliability | Days | Weeks |

**They are not mutually exclusive — Track 1 is a strict subset of Track 2's
audit model.** The `REVIEW_REQUESTED`/`REVIEW_COMPLETED` events and the
tool-actor `aidlc-log.ts review` built in Track 1 survive verbatim into Track 2
(they become the review-phase's audit rows). So Track 1 is not throwaway work;
it is the first brick of Track 2.

## 6. Recommendation

**Two-track it:**

1. **Do Track 1 now.** Small, low-risk, stops the silent skips this week, and is
   forward-compatible. Ship it as a patch release.
2. **Fund Track 2 as its own RFC + milestone** if/when the team wants to close
   the whole "model skipped a sub-step" class (reviewer *and* questions *and*
   artifact). It is the correct long-term architecture — the stage's three
   intrinsic phases become three enforceable, observable engine transitions —
   but it is a state-machine change on the scale of the largest efforts in this
   repo, and should not be slipped in alongside a reviewer patch.

**Anti-pattern to avoid:** a half-split that makes *only* the reviewer a
directive while questions+artifact stay fused. That incurs most of Track 2's
migration cost without its conceptual cleanliness — and it contradicts the
framing that review is one of three co-equal phases. It is all-three (Track 2)
or enforce-in-place (Track 1); not a reviewer-only directive.

## 7. Open questions for the team

1. **Hard-block vs soft-block** (Track 1 §3.3): must a reviewer-bearing stage be
   un-approvable without a recorded review? Recommendation: hard on the review
   *happening*, soft on its *verdict*.
2. **Track 2 rollout order** — non-per-unit stages first, then Construction, then
   swarm? Or all at once behind a flag?
3. **Directive shape for Track 2** — `phase` discriminator on `run-stage`, or
   distinct `run-questions`/`run-artifact`/`run-review` kinds?
4. **Phase cursor** — audit-tail-derived (preferred) or a stored `Stage Phase`
   field?
5. **Swarm review** — per-worker in-worktree, or central on the merged result?
6. **Should questions/artifact also become hard-gated in Track 2**, or only
   observable? (i.e. does the engine *refuse* to emit `artifact` until
   `questions-collected` is reported, or just track it?)
