---
slug: discovery-experimentation
phase: ideation
execution: ALWAYS
condition: Tests the riskiest assumptions before commitment through composed test plans
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-developer-agent
  - aidlc-quality-agent
  - aidlc-design-agent
mode: inline
produces:
  - test-plans
  - evidence-record
consumes:
  - artifact: assumptions-record
    required: true
  - artifact: future-state
    required: true
  - artifact: current-state
    required: true
  - artifact: design-language-record
    required: false
requires_stage:
  - discovery-future-state
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - discovery
inputs: The assumptions record (riskiest first), the confirmed current-state and future-state artifacts, the design language record where one exists, plus this stage's own artifacts on disk when resuming
outputs: test-plans.md, evidence-record.md (under this stage's record dir, engine-resolved)
---

# Discovery Experimentation

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

This stage is the test loop. One cycle takes the highest-risk open assumption
and runs the composed test plan that serves it, with a recap at the end. Loops
are bounded by usefulness, not counters: the stage ends when the open
assumptions can no longer change the commit, pivot, or park verdict, when the
person redirects, or when the assumptions are done.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `.claude/knowledge/aidlc-product-agent/`.
Load aidlc-developer-agent persona from `agents/aidlc-developer-agent.md` for Build and Run steps, aidlc-quality-agent from `agents/aidlc-quality-agent.md` for evidence discipline, and aidlc-design-agent from `agents/aidlc-design-agent.md` for mock-up work in the captured design language.

### Step 2: Load Prior Context

- Assumptions record and future-state from `<record>/ideation/discovery-future-state/`
- Current-state from `<record>/ideation/discovery-current-state/`
- Design language record from `<record>/ideation/discovery-current-state/` (if exists) — where absent, Build steps render mock-ups plainly and every verdict those mock-ups feed states the missing design language as a limit on what the reactions mean
- Load guardrails from `.claude/rules/`

### Step 3: Enter or Re-enter the Cycle Loop

The loop is a bounded prose loop whose state lives in the artifacts on disk.
On re-entry (a new session, a resumed workflow), this stage re-runs from its
top per the standard stage ritual — but substep 1 reads what earlier cycles
already recorded, so work continues from the record rather than starting over.
At the artifact re-use question, for `test-plans.md` and `evidence-record.md`
recommend Modify (continue the records) and warn that Redo would rewind the
append-only evidence record — a person who insists on Redo is choosing to
discard recorded evidence:

1. Read `<record>/ideation/discovery-experimentation/test-plans.md` and `<record>/ideation/discovery-experimentation/evidence-record.md` (create either, empty, on first entry).
2. Determine the highest-risk open assumption from the assumptions record — importance times evidence weakness, re-ranked as evidence lands.
3. Compose the plan that serves it (Step 4), or continue the plan test-plans.md shows unfinished, at its first incomplete step.
4. Run the plan's next step, appending the step's fixed artifact into test-plans.md as it completes.
5. When a plan closes, record a verdict per assumption — supported, refuted, or still unknown — and close the cycle under the four rules (Step 5). Then return to substep 2.

A plan belongs to a test, not to a single assumption: when several assumptions
share steps, one plan serves them all, and every assumption still ends with its
own verdict. The loop ends when the open assumptions can no longer change the
commit, pivot, or park verdict, when the person redirects (Step 7), or when the
assumptions are done.

### Step 4: Compose the Test Plan from the Five Primitive Moves

Load `.claude/knowledge/aidlc-shared/discovery-test-primitives.md` —
it carries the full sub-mode taxonomy, each move's fixed artifact, the data
ladder, and the nine plan templates. The five moves in one line each:

- **Investigate** — establish what is claimed possible and what is unknown; artifact: the findings note.
- **Walkthrough** — drive a real interface along a stated journey, every step confirmed or failed; artifact: the journey record.
- **Build** — make the thing needed to test, declaring what it must prove, reuse before build before simulate; artifact: the build manifest.
- **Run** — execute something re-runnable that produces a recorded, checkable result; artifact: the run record.
- **Show** — put an artifact in front of the people affected, questions written in advance; artifact: the showing record.

Each plan step names its primitive, its mark (runs alone or needs a person),
and what it needs (web access, network egress, browser control, credentials,
or nothing). Waiting is never a step. A needs-a-person wait rides the
questions-file protocol: blank `[Answer]:` tags in the step's questions file,
and work continues on other plan steps where the plan allows. A wait that
outlasts the session is an explicit whole-workflow park — `bun
.claude/tools/aidlc-orchestrate.ts park` — which a person resumes with
`/aidlc --resume`, after which this stage re-enters per Step 3.

Plans start from one of the nine named templates where one fits (contract
verification, variant test, capacity check, status quo capture, rehearsal,
working slice, head-to-head, data check, shadow trial — skeletons and typical
traps in the knowledge file), or compose freely where none does.

### Step 5: Run the Cycle Under the Four Rules

1. **Pass and fail are stated before the test runs.** Every assumption already carries its disproving condition. A test whose success criteria are written after the results is not a test.
2. **Evidence strength is capped by fidelity and source.** A result from the actual system under representative conditions supports a conclusion outright. A result from a constrained environment supports it with the difference stated. A result from an isolated component supports only the isolated claim. Analysis with no execution caps at inconclusive. For desirability and usability claims the cap extends to the source: team opinion AND any result from simulated users or synthetic personas cap at inconclusive — only evidence from the people affected supports those claims. Every verdict states its sample and setting, and a verdict from a small or single-site sample carries that qualifier wherever the verdict travels.
3. **An invalidation is a success of the process.** An assumption that dies in testing just saved the build. Record it identically to a confirmation.
4. **Every cycle lands its evidence and its recap.** Each cycle appends one entry per tested assumption to evidence-record.md (append-only, every entry source-labeled) and ends with an explicit disposition for its artifacts — keep, promote, or discard. It writes corrections back into the current-state and future-state artifacts, visibly, and reopens any open-questions entries whose answers the evidence contradicted. It closes with a recap: what ran, what was learned, what changed with links, the verdicts, the disposition, an identifier glossary for anything minted — and a cost line where the team's practices ask for one (a team rule in the memory layer; absent unless the team adds it).

### Step 6: Pause on the Reframe Trigger (conditional)

The framing records which answers it rests on. When a test invalidates one of
them, pause at the end of the cycle and present the situation: what was
believed, what the evidence now shows, and three options — adjust the framing,
continue with awareness, or pivot now. Present this at most twice for the same
framing before recommending the decision gate.

### Step 7: Accept the Standing Redirect

At any recap the person can reprioritize the assumptions, retire questions,
change the framing, or park the initiative — without waiting for evidence to
justify the change. Record a redirect like any other human act.

### Step 8: Update State

Update `<record>/aidlc-state.md`:
- Mark discovery-experimentation as `[x]` completed
- Update current stage and next stage

### Step 9: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :test_tube:
- Summary: the assumptions with their verdicts, what remains open and why it cannot change the commit, pivot, or park verdict
- Review path: `<record>/ideation/discovery-experimentation/`
- Standard approval gate (Approve / Request Changes)

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/discovery-experimentation/`.
Sensor results do not print to the terminal on pass or fail — outcomes land
as `SENSOR_PASSED` / `SENSOR_FAILED` events in the audit shard under
`<record>/audit/`, and failure findings land under
`<record>/.aidlc-sensors/discovery-experimentation/`.

The imported sensors check those outputs:

- **`required-sections`** verifies each output against its resolved template's H2 set (the framework default templates ship for `test-plans` and `evidence-record`), falling back to the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `assumptions-record`, `future-state`, `current-state`, `design-language-record`; only those present on disk are checked).

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

- Prescriptive rule → `.claude/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.claude/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.claude/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
