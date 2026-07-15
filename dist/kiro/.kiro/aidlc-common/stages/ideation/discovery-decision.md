---
slug: discovery-decision
phase: ideation
execution: ALWAYS
condition: Ends the phase over the decision pack — commit, pivot, or park
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-product-lead-agent
  - aidlc-delivery-agent
mode: inline
produces:
  - decision-pack
consumes:
  - artifact: evidence-record
    required: true
  - artifact: assumptions-record
    required: true
  - artifact: intent-statement
    required: true
  - artifact: future-state
    required: true
  - artifact: open-questions-record
    required: true
requires_stage:
  - discovery-experimentation
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - discovery
inputs: The evidence record, assumptions record, intent statement, future-state, and open questions record
outputs: decision-pack.md (under this stage's record dir, engine-resolved)
---

# Discovery Decision

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

The phase ends over the decision pack — the business case assembled here as a
projection of the records, so nothing is written fresh that a record already
holds. Nothing here builds production software: the phase validated or falsified beliefs, and this
stage decides what happens to them.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `.kiro/knowledge/aidlc-product-agent/`.
Load aidlc-product-lead-agent persona from `agents/aidlc-product-lead-agent.md` for the review perspective and aidlc-delivery-agent from `agents/aidlc-delivery-agent.md` for the handoff perspective.

### Step 2: Load Prior Context

- Evidence record and test plans from `<record>/ideation/discovery-experimentation/`
- Assumptions record and future-state from `<record>/ideation/discovery-future-state/`
- Intent statement and open questions record from `<record>/ideation/intent-capture/`
- Load guardrails from `.kiro/steering/`

If a composed run skipped the test loop, the evidence record is absent — the
pack's evidence summary then says plainly that no tests ran. It never fills the
gap with recollection.

### Step 3: Assemble the Decision Pack

Create `<record>/ideation/discovery-decision/decision-pack.md` as a projection
of the records: nothing is written fresh that a record already holds. Three
core parts (the bold names below are the template's exact `##` headings — the
required-sections sensor checks the pack against the template's heading set,
so keep them verbatim):

- **The working artifact** — required per the composition's requirement, with any relaxation of that requirement recorded in the pack.
- **Narrative** — generated into the organization's own proposal format (a steering one-pager, a business case template — ask once, when the pack is first drafted, what shape a proposal takes in this organization), or, where none exists, a plain one-page summary of problem, evidence, recommendation, and cost.
- **Evidence summary** — every assumption tested with its outcome, its source, and its sample-and-setting qualifier; the open risks; what was set aside along the way; and the cost spent, where the team's practices record cost.

Three adopted sections:

- **Where this came from** — who asked, how often, what they said, carried from the intent statement.
- **Appetite** — how much the organization is willing to invest in this direction: a boundary, not an estimate.
- **No-gos** — what the initiative will not do.

Appetite and no-gos are the person's to state, never invented: when the pack
is first drafted, ask for both in the same structured exchange as the
proposal-format question (any mandate recorded at intent seeds the no-gos).
If the person has no answer yet, record "not yet stated" — an honest blank
outranks a guessed boundary.

### Step 4: Issue the Pack Before the Gate

When the remaining open assumptions can no longer change the verdict, the pack
goes out to the stakeholders who will carry the decision — through whatever
channel the team already uses — before any meeting. Where the conversation
must wait (a steering group that meets on Thursdays, a sponsor on leave), park
the workflow explicitly: `bun .kiro/tools/aidlc-orchestrate.ts park`.
A person resumes it with `/aidlc --resume`, and folding an out-of-band answer
into the record is itself a human act in the session, so the audit ledger
always shows who closed the wait. Where the initiative carries a decide-by
date, the date wins: the pack goes out in time for it, the decision happens on
it with the evidence as it stands, and any still-open assumption is exported
as still open, never rushed to a verdict.

One soft recommendation, stated in the pack's cover: include at least one
person who did generative work on the initiative among the deciders, not only
reviewers.

### Step 5: Record the Decision

The decision is a mid-stage structured question per stage-protocol.md §3 —
not the exit gate. Present Commit / Pivot / Park with the pack as the shared
ground. State each option in plain language when asking, so the person knows
what happens to their work before they choose:

- **Commit** means: we build this. The initiative moves into delivery carrying everything this run learned.
- **Pivot** means: we keep everything we learned and try a different framing of the problem. Nothing is lost.
- **Park** means: we stop here without deciding. The record is kept whole, and this decision can be reopened any time.

Write the answer, who gave it, and when into the pack's **Decision** section.
Then relay the outcome through the engine's own verbs. (The verb relays in
this stage — jump, park, scope-change, set-status, state skip — are the
documented exception to the orchestrator skill's never-call-the-state-tools
rule: that rule guards the report-owned stage transitions, while these are
workflow-level commands this stage file instructs by name — jump, park,
scope-change, and skip each emit their own audit event, and set-status is a
plain state-field write.)

- **Commit** — two record moves before the follow-up question:
  1. Append the **handoff contract** to the decision pack. This is the section delivery consumes, so it instructs rather than documents: it opens with one consumption note — *settled entries are pre-answers for the consuming stage to confirm with the person, never to re-elicit; open items are questions to raise; every gate stays* — and then carries four parts, every entry in the same shape (value, status, confidence, which gate confirmed it, source):
     - **Settled** — every answered question, and every supported assumption expressed as a requirement, each with its evidence attached.
     - **Exclusions** — every refuted assumption and recorded no-go, with the evidence as the reason. These are boundaries for delivery, not suggestions.
     - **Open items** — every still-unknown verdict, exported as a low-confidence assumption to re-raise, carrying discovery's recommendation where the record supports one and *ask the person* where it does not.
     - **Starting points** — every test artifact marked promote, registered with its path.
     Close the contract with a short map from what delivery asks first to where this record answers it: functional requirements in Settled, personas and stakeholders in the stakeholder map, scope boundaries in Exclusions and the intent statement, quality expectations in the evidence record. Point at the record — never duplicate it.
  2. Refresh the **intent statement**: fold the chosen framing and the recorded exclusions into `<record>/ideation/intent-capture/intent-statement.md` as a new `## What Discovery Validated` heading (add it, or update it on a re-entry; every other section stays untouched). The section carries its provenance inline, one source per line, naming the record files in their file-name form exactly as written here: the framing from `future-state.md`, the exclusions from `assumptions-record.md` and `evidence-record.md`, the confirmed answers from `open-questions-record.md`, and it closes by pointing at `decision-pack.md` as the full record behind this update to `intent-statement.md`. (Those file references are not decoration: this stage's upstream-coverage sensor fires on any record write while the stage is active and checks that the section cites this stage's consumed artifacts in a form it accepts — a standalone slug, a backticked file name like the forms above, or the producing stage's directory as a path segment. A section that names them all passes the sensor; paraphrasing them into spaced prose logs advisory noise.) The intent statement is the record delivery reads first when it needs the intent, so after a commit it must say what was validated — not what was guessed on day one.

  Then ask one follow-up structured question (same §3 machinery): **where does the build happen?**
  - **Continue here** — the build happens in this workspace. The same workflow and the same record continue into delivery: proceed to Step 6 and the exit gate, then follow Step 8.
  - **Hand off** — the build happens somewhere else (another repository, another team, a workspace that holds the code). Proceed to Step 6 and the exit gate; approval completes this workflow, and the decision pack's handoff contract is what the receiving team's workflow consumes.
- **Pivot** — everything learned is kept, and the initiative returns to the framing. Do NOT proceed to the exit gate and never mark this stage completed: after the §13 learnings ritual, relay the engine's backward jump — `bun .kiro/tools/aidlc-jump.ts execute --target discovery-future-state --direction backward`. The jump re-opens discovery-future-state and the stages after it so their artifacts can be revised; nothing is deleted, and the evidence record is append-only — it is never rewound.
- **Park** — write the sponsor-facing narrative into the pack (what we learned, why now is not the moment, what would reopen it), then park the whole workflow: `bun .kiro/tools/aidlc-orchestrate.ts park`. The record stays intact and resumable with `/aidlc --resume`, which re-enters this stage for a fresh decision when the time comes. An initiative parked after honest testing is the process working: the money that would have built the wrong thing was not spent.

### Step 6: Update State (Commit path only)

Update `<record>/aidlc-state.md`:
- Mark discovery-decision as `[x]` completed
- Update current stage and next stage

The Pivot and Park paths never reach this step — the jump and park verbs own
their state transitions.

### Step 7: Present Completion & Request Approval (Commit path only)

Use stage-protocol.md completion template with completion emoji: :scales:
- Summary: the recorded decision, the pack's recommendation, the verdicts behind it, what remains open and why it cannot change the verdict, and where the build will happen (continue here, or hand off)
- Review path: `<record>/ideation/discovery-decision/`
- Standard approval gate (Approve / Request Changes) — approval ratifies the recorded commit and ends the phase

### Step 8: Continue Into Delivery (Commit + Continue-here only)

When the person chose **Continue here**, the same workflow and record flow
into delivery after the gate approves — no new workflow, no re-entry through
the ideation questionnaire. Relay this sequence of engine verbs, in order
(the sequence was chosen because every verb already exists — this stage adds
no machinery; scope-change and skip each emit their own audit event, and
set-status is a plain state-field write):

1. Ask which delivery scope fits the committed build, with each option
   carrying its plain meaning (a structured question): `feature` — the
   default, a standard delivery pass through design, build, and operation;
   `mvp` — a leaner pass that trades ceremony for speed, for a first
   version; `enterprise` — the fullest pass, for work that needs every
   design and review stage; or a composed scope via `/aidlc compose` when
   none of those fit. The choice sets how much process the build gets, and
   it can be reshaped later mid-workflow. Then relay
   `bun .kiro/tools/aidlc-utility.ts scope-change --scope <chosen>`.
2. Run `bun .kiro/tools/aidlc-orchestrate.ts next` once: the engine
   names the first delivery stage under the new scope (it applies the
   project-type adjustments itself). Then set the workflow running there:
   `bun .kiro/tools/aidlc-utility.ts set-status --stage <named stage>`.
3. Mark every ideation stage the new scope expects but this run already
   covered as skipped, so the record stays honest about why they will not
   run: `bun .kiro/tools/aidlc-state.ts skip <slug> --reason
   "covered by the discovery run: see the decision pack and handoff
   contract"` for each pending ideation stage.
4. Hand control back to the forwarding loop (`next`). Delivery begins at the
   stage the engine named, and the vision arrives through two wired paths,
   not through goodwill: the intent statement was refreshed at commit with
   the validated framing and exclusions (the first delivery stage that
   needs the intent, `requirements-analysis`, reads it), and the decision
   pack is a declared optional input of `requirements-analysis` and
   `user-stories` — the run-stage directive hands them its path, and the
   upstream-coverage sensor verifies their output referenced it. Further
   down the same path, `refined-mockups` reads the design language record
   and the tested mock-up variants from the evidence record the same way.

Two display notes for the conductor, so the sequence's output is not
misread: the audit shard will show `WORKFLOW_COMPLETED` (from the gate)
followed by `SCOPE_CHANGED` and further stage events — that ordering is
correct, the completion belongs to the gate and the continuation re-opens
the same workflow. And the state file may render the finished discovery
stages as completed check-boxes beside SKIP annotations — read Current
Status as the truth of where the workflow is.

When the person chose **Hand off**, none of this runs: the workflow completes
at the gate, and the decision pack (with its handoff contract) is the record
the receiving workflow starts from.

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/discovery-decision/`.
Sensor results do not print to the terminal on pass or fail — outcomes land
as `SENSOR_PASSED` / `SENSOR_FAILED` events in the audit shard under
`<record>/audit/`, and failure findings land under
`<record>/.aidlc-sensors/discovery-decision/`.

The imported sensors check those outputs:

- **`required-sections`** verifies each output against its resolved template's H2 set (the framework default template ships for `decision-pack`), falling back to the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `evidence-record`, `assumptions-record`, `intent-statement`, `future-state`, `open-questions-record`).

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → `.kiro/steering/aidlc-phase-<phase>.md` (phase-scoped)
  or `.kiro/steering/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.kiro/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
