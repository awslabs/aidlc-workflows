# Discovery test primitives — the five moves, their artifacts, and the nine plan templates

Shared knowledge for the `discovery-experimentation` stage. A test plan is a
composed sequence of these five moves. Each executed step appends its fixed
artifact into `test-plans.md`. Every step carries one of two marks — runs
alone, or needs a person — and the mark, not the move, is where synchronous
and asynchronous behavior attaches.

## Investigate

Establish what is claimed possible and what is unknown.

- **Sub-modes**: document study (vendor docs, standards, pricing, internal
  SOPs — everything found is recorded as a claim by its source, never as
  fact), supplied-material mining (the team's own exports, tickets,
  analytics), and people — an Investigate step marked needs-a-person IS the
  expert consultation or operator interview.
- **Boundary**: a question about the world with no artifact in the room is
  Investigate, never Show.
- **Fixed artifact — the findings note**: the question served (by id), claims
  found with source, date, and confidence, contradictions between sources,
  what remains unknown, and what a real run would take. Findings flow into
  the open-questions record as sourced answers.

## Walkthrough

Drive a real interface along a stated journey.

- **The journey contract is fixed**: numbered steps, an expected outcome for
  each, every step confirmed or failed, deviations recorded.
- **The driver is chosen by capability probe**: shell for terminal journeys,
  an HTTP client for API journeys, an installable browser driver such as
  Playwright for browser journeys. Where no driver exists, the last rung is a
  person executing the agent's written step list and reporting per-step pass
  or fail. Only the driver changes — the contract survives every rung.
- **A usability test is a Walkthrough** executed unaided by a person from the
  affected population, with per-step completion recorded.
- **Fixed artifact — the journey record**: journey statement, driver used,
  per-step results with attached evidence (terminal transcript, request and
  response pairs, screenshots), deviations.

## Build

Make the thing needed to test.

- **Every build declares two things before construction**: what the artifact
  must prove (mock-up variants for look-and-feel reaction, a clickable flow
  for comprehension, a thin adapter for integration feasibility, a working
  slice plus harness for performance, a rehearsal copy for operational
  readiness, an executable cost model for economics), and its source
  strategy — reuse before build before simulate, every simulated element
  disclosed because it caps what the evidence can claim.
- **The data ladder**, when live data cannot be used: masked or sampled
  production extract, then recorded real traces, then synthetic data
  generated to match measured distributions (keep the generator as an
  artifact), then hand-authored fixtures. The gap between test data and real
  data travels as a stated assumption on any verdict.
- A person approves any data scope or masking before a copy is made. Mock-ups
  render in the captured design language where the record exists.
- **Fixed artifact — the build manifest**: what was built, for which
  assumptions, reused versus new versus simulated, data used and its
  provenance, fidelity claimed, disposition candidate.

## Run

Execute something that produces a recorded, checkable result.

- **The boundary rule is exact**: a measurement produced by executing
  something re-runnable is Run, and the re-runnable thing (query, script,
  harness invocation) is kept as the artifact — never a screenshot.
- **Sub-modes**: data analysis over real data, benchmark or measurement,
  contract checks, cost model execution, rehearsal execution, and a field
  experiment run quietly alongside the real process.
- **Fixed artifact — the run record**: the re-runnable thing, environment,
  inputs with provenance, raw output location, and the computed result set
  against the disproving condition.

## Show

Put an artifact in front of people with questions written in advance.

- **Sub-modes**: moderated showing (walk a person through the artifact live),
  an async packet (the artifact plus a questions file with blank `[Answer]:`
  tags that travels out of band), and comparison (several variants, same
  questions).
- **The discipline**: the questions AND the rule for interpreting responses
  are written before anyone sees the artifact. Pick people from those the
  change actually affects, not those easiest to reach, mix experience levels
  and locations where they exist, and state who and how many in the record.
  Where only insiders were available, say so on the verdict. Ask consent
  before recording anyone, and note it.
- **Boundary**: Show is an artifact meeting people. A journey a target user
  drives is a Walkthrough. A question with no artifact is Investigate.
- **Fixed artifact — the showing record**: what was shown and its version,
  who saw it (role, count, how chosen), the pre-stated questions and
  interpretation rule, responses per question, surprises.

## The nine plan templates

Named skeletons the team edits — compositions, not new machinery. Each names
its typical trap.

| Template | Composition | Typical trap |
|---|---|---|
| Contract verification | Investigate the interface docs, Walkthrough the stated journey against the real interface, Build a thin adapter, Run checks through it | Sandbox-versus-production drift |
| Variant test | Build several mock-up variants in the captured design language, Show them with pre-stated questions | Leading questions |
| Capacity check | Investigate pricing and usage sources, Run the cost model | List prices standing in for negotiated ones |
| Status quo capture | Investigate records and analytics, Walkthrough the current journey as it exists today | Documenting the official process instead of the real one |
| Rehearsal | Build a copy to rehearse against, Run the rehearsal, Run the checks | A copy too clean to rehearse the real mess |
| Working slice | Build the thinnest real slice, Run its checks, Walkthrough the journey it serves | The slice quietly growing into the build |
| Head-to-head | Build a measurement harness, Run baseline and candidate, compare recorded results | Unequal tuning effort between the two |
| Data check | Investigate what data exists, Run the analysis against a stated claim | Confirming with the subset that was easy to query |
| Shadow trial | Build the instrumentation, Run the new way quietly alongside the real process, compare recorded results | Observing a period too short to include the bad days |
