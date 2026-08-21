---
slug: pdlc-prototype-spec
number: 1.50
name: Prototype Spec
plugin: pdlc
phase: ideation
execution: CONDITIONAL
condition: Execute when the run intends to prototype the selected candidates — a ranking exists and the user wants something clickable before committing. Skip when discovery stops at the handoff pack, and skip when a PROTOTYPE-*.md was handed in from elsewhere (Entry Point 1), because the spec this stage would write already exists; say which at the gate.
lead_agent: aidlc-design-agent
support_agents: []
mode: inline
produces:
  - pdlc-prototype-spec
  - pdlc-design-context
  - pdlc-prototype-spec-questions
consumes:
  - artifact: pdlc-prioritization-ranking
    required: false
  - artifact: pdlc-prioritization-scoring
    required: false
  - artifact: pdlc-use-cases
    required: false
  - artifact: pdlc-prfaq
    required: false
requires_stage:
  - pdlc-prioritization
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - pdlc-discovery
required_sections:
  - "Selected Candidates"
  - "Spec Register"
  - "Prototype Boundaries"
  - "Brand & Tone"
  - "Devices & Viewports"
  - "Screens & Flows"
  - "Look & Feel"
  - "Accessibility Floor"
  - "Assumptions & Open Questions"
inputs: pdlc-prioritization-ranking from pdlc-prioritization where present, plus pdlc-prioritization-scoring, pdlc-use-cases, and pdlc-prfaq where present
outputs: pdlc-prototype-spec.md, pdlc-design-context.md, pdlc-prototype-spec-questions.md, and one portable prototypes/<slug>/PROTOTYPE-<slug>.md per selected candidate (under this stage's record dir, engine-resolved)
---

# Prototype Spec

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

This stage turns a ranked candidate into something a developer can build without
being in the room. Its real deliverable is a **portable spec** — one
`PROTOTYPE-<slug>.md` per selected candidate that stands entirely on its own: a
person who has never seen this discovery run, has no access to the record dir,
and cannot ask a question can read it and build the prototype.

That portability is the point, and it is also the entry point. A
`PROTOTYPE-*.md` handed in from elsewhere skips stages 1–5 of this flow entirely
and goes straight to the build stage. The same file therefore has to work as an
output of discovery AND as an input to a run that had no discovery. Anything the
spec leaves implicit — the brand, the device, the screens, what "done" looks like
— is a question its reader cannot ask.

`aidlc-design-agent` leads because most of what makes a prototype convincing is
not functional: it is which device it is shown on, how many screens the demo
crosses, what it looks and reads like, and whether the empty state is designed.
A functionally complete prototype that looks unfinished gets feedback about its
appearance instead of about the idea.

## Steps

### Step 1: Load Agent Personas

Load aidlc-design-agent persona from `agents/aidlc-design-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-design-agent/`.

Then read `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/pdlc-prototype-spec-format.md`
— the section-by-section reference for the portable `PROTOTYPE-*.md`, including
what each section is for and how each one fails — plus `pdlc-terminology.md` for
the Agentic/Application distinction, which changes what a prototype has to
demonstrate.

### Step 2: Load Prior Context

- Read `pdlc-prioritization-ranking.md` from the `pdlc-prioritization` record dir
  where present. Its `## Top Selection` names the candidates this stage specs,
  and the "what the prototype would have to show" line per candidate is the seed
  of each spec's success criterion
- Read `pdlc-prioritization-scoring.md` from the same dir where present. The
  per-criterion rationales say WHY a candidate ranked where it did, which is what
  a prototype has to test — a candidate that scored high on assumed Data
  Readiness should have data access on the demo path
- Read `pdlc-use-cases.md` where present, for each candidate's personas,
  capabilities, and constraints
- Read `pdlc-prfaq.md` where present. Its press release is the tone the prototype
  should feel like, and its Customer FAQ names the moments worth showing
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

If no ranking exists because prioritization was skipped for a single candidate,
that candidate is the subject and there is one spec. Say so; do not manufacture a
top-three.

### Step 3: Fix the Candidate Set and Mint the Slugs

Take the candidates from `## Top Selection` — the default is three, because three
is what the build stage can carry in parallel. Confirm the set with the user
before speccing: a spec written for a candidate the user has already dropped is
pure waste, and it is cheap to ask.

Mint one slug per candidate. The slug names the directory and the portable file,
so it is load-bearing rather than cosmetic:

> **SLUG SANITIZATION**: Strip all characters except lowercase letters, numbers,
> and hyphens from slugs. Reject any slug containing path separators (`/`, `\`,
> or `..`).

Reject rather than repair a slug that contains a path separator, and show the
user the sanitised slug you intend to use. The build stage will re-apply this same
rule to whatever slug it is given, including one arriving with a handed-in spec.

Then, for each candidate in turn, do Steps 4 through 6. Work one candidate at a
time and finish it before starting the next — a set of three half-specs is not a
third of the value of one complete spec, because a partial spec cannot be built
from at all.

### Step 4: Ask What the Spec Cannot Be Derived From

Create `<record>/ideation/pdlc-prototype-spec/pdlc-prototype-spec-questions.md`
— one questions file for the whole stage, with the candidate named in each
question that is candidate-specific.

Start the file with a `## Sources` register. Every source is a top-level
Markdown list item using exactly one of these forms:

```markdown
- [desc] Initial description: "<JSON-escaped verbatim product description>"
- [scope] Workflow-selected scope: `<scope>`.
- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`: "<JSON-escaped exact single-line rule>"
- [artifact:pdlc-<name>] `<path to the upstream pdlc artifact>`
```

Then create consecutively numbered `## Q<n>.` questions. The upstream artifacts
already carry the problem, the personas, and the value; what they do not carry is
everything below. Cover:

**The demo itself, per candidate**

- Who is watching this prototype, and what decision do they make after seeing it?
- What is the ONE thing it must demonstrate? A prototype that demonstrates three
  things demonstrates none of them convincingly
- What is the single path through it, start to finish, in the order a viewer sees
  it?
- What would make a viewer say "that is not how it works" — the detail whose
  absence breaks the illusion?
- What is deliberately faked, and is the viewer told?

**Shape and surface**

- Is this a web app, a chat interface, a dashboard, a CLI, an embedded panel, or
  a document that gets generated?
- Which device and viewport is it shown on — a laptop in a meeting room, a phone
  held up, a shared screen on a call, a projector at the back of a room?
- How many screens or steps, at most? The honest answer is usually three
- What comes preloaded so the demo can start mid-story instead of at an empty
  state?

**Brand, tone, and look — asked once for the run, not per candidate**

- Is there an existing brand, design system, or component library to match, and
  is it reachable?
- What are the colours, typeface, and logo, if any are fixed? Where none are,
  what feeling should it give — trusted and institutional, fast and utilitarian,
  warm and consumer?
- How does the product SPEAK: formal, plain, terse, encouraging? An agentic
  product's voice is part of its function, not decoration
- Which products should it feel like, and which should it explicitly not?
- Light, dark, or both?
- What is the accessibility floor for the demo — contrast, keyboard reach, text
  size — given who is in the room?

**Data and behaviour**

- What data does the demo show, and is any of it real? Real data in a prototype
  is a decision with consequences; say so
- For an Agentic candidate: what does it do when it is wrong, when it is
  uncertain, and when it needs permission? Those three moments are the product
- What should visibly NOT work — the greyed-out edges that keep the viewer on the
  demo path?

**Boundaries**

- What is explicitly out of scope for the prototype: authentication, persistence,
  multi-user, error handling, real integrations, performance?
- How long should building it take before it is not worth doing?

Every question MUST include an explicit `Not known`, `No existing brand`,
`Not applicable`, or `Prototype should decide` option. "Prototype should decide"
is a real answer for a look-and-feel question and a bad one for a success
criterion — where the user defers on what the prototype must demonstrate, ask
again, because a demo with no stated point cannot be judged. Use the [Answer]:
tag format from stage-protocol.md. Include A-E options with X (Other) as final
option. Leave all [Answer]: tags blank. Follow-up questions continue the same
`Q<n>` numbering so their source ids stay stable.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

### Step 5: Write the Design Context

Create `<record>/ideation/pdlc-prototype-spec/pdlc-design-context.md`. This is
written ONCE for the run, not per candidate — the brand does not change between
candidates, and three specs that each re-derive it will disagree.

Apply this grounding contract to every artifact this stage writes:

1. Permitted sources are `[desc]`, confirmed `[Q<n>]` answers, `[scope]`,
   registered `[memory:M<n>]` entries, and registered
   `[artifact:pdlc-<name>]` entries.
2. Every substantive claim block carries one or more inline source tags — except
   inside a portable `PROTOTYPE-<slug>.md`, which is exempt for the reason given
   in Step 6.
3. Never invent a brand colour, a typeface, a logo, a design system, an existing
   component library, or a real customer's data. Where none was stated, write the
   choice as a proposal and mark it `[assumption]`.
4. The artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   when there are none.

Write:

- `## Brand & Tone` — the brand assets that exist and are reachable; the voice
  the product speaks in, with two or three example strings written in it (a
  button label, an error, an empty state); what it should not sound like
- `## Devices & Viewports` — the primary device and viewport the demo is shown
  on, any secondary one, and light/dark
- `## Screens & Flows` — the screen inventory shared across candidates, and for
  each the purpose, the primary action, and the empty state. An undesigned empty
  state is where most demos visibly fail, because a demo often starts in one
- `## Look & Feel` — colour roles (not just hexes: what each is FOR), typeface
  and two or three sizes, spacing rhythm, corner and shadow treatment, and the
  two or three reference products with what specifically is being borrowed
- `## Accessibility Floor` — the minimum this demo meets: contrast ratio,
  keyboard reach for the demo path, minimum text size, and what is knowingly
  deferred
- `## Assumptions & Open Questions`

### Step 6: Write One Portable Spec Per Candidate

For each candidate, create
`<record>/ideation/pdlc-prototype-spec/prototypes/<slug>/PROTOTYPE-<slug>.md`,
following the section-by-section format in `pdlc-prototype-spec-format.md`.

**The portability test governs everything about this file.** Before finishing
one, read it as someone who has this file and nothing else. Every sentence that
only makes sense with the record dir open is a defect. Concretely:

- **Never cite another pdlc artifact by path.** Inline what the spec needs. This
  is the one artifact in the plugin exempt from the inline-source-tag rule,
  because a tag resolving into a record dir the reader does not have is worse
  than no tag: it looks like provenance and delivers none. Provenance for this
  file lives in the register written in Step 7, which stays in the record
- **State the selection provenance without a record path.** Include
  `pdlc-prioritization-ranking` in a short provenance note when a ranking
  selected the candidate. This keeps the portable file self-contained while
  making its declared upstream dependency observable to `upstream-coverage`
- **Restate the design context**, do not reference it. Each portable spec carries
  the brand, device, and look-and-feel it needs, even though that repeats
  `pdlc-design-context.md` across three files. This is deliberate duplication of
  a *frozen* input for portability's sake — and it is the only duplication this
  plugin permits, because the alternative is a spec that cannot be handed over
- **State what is faked and what is real**, in the spec, so the builder does not
  have to guess and the viewer can be told
- **Name the success criterion as an observable**: what a viewer must be able to
  do, see, or say afterwards. "Demonstrates the concept" is not a criterion
- **Carry the boundaries**: what is out of scope, and the security posture the
  build inherits — local only, mock data unless stated otherwise, no
  credentials in the spec and none in the code it describes

A spec that cannot be built from without asking a question is not finished. When
an answer is genuinely unknown, the spec says `Unknown — builder's choice` and
names the constraint the choice must respect. That is buildable; a silent gap is
not.

### Step 7: Write the Spec Register

Create `<record>/ideation/pdlc-prototype-spec/pdlc-prototype-spec.md`. This is
the record-side artifact: the index that keeps provenance and pointers, while
each full spec stays in its own portable file. It is NOT a copy of the specs —
two copies of a spec drift, and then nobody knows which one was built.

Write:

- A `## Summary` line — N candidates specced, the shape of each (web, chat,
  dashboard, CLI), and how many spec fields were left as builder's choice
- `## Selected Candidates` — the candidates carried from `## Top Selection`, each
  with its rank, its class (Agentic or Application), the minted slug, and why it
  is in the set. Name any candidate from the top selection that was dropped here,
  and who dropped it
- `## Spec Register` — a table: Candidate, Slug, Portable spec path
  (`prototypes/<slug>/PROTOTYPE-<slug>.md`), The one thing it demonstrates,
  Success criterion as an observable, Shape
- `## Prototype Boundaries` — what all of these prototypes deliberately do not
  do: no authentication, no persistence beyond the session, no real integrations
  unless a spec says otherwise, mock data by default, localhost only, and no
  credentials in any generated file. The build stage enforces this; stating it
  here means the user approved it before code existed
- `## Assumptions & Open Questions` — including every field a spec left as
  builder's choice, so the gap is visible in the record and not only inside a
  portable file

### Step 8: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage pdlc-prototype-spec --result awaiting-approval`.

### Step 9: Present Completion & Request Approval

Completion emoji: :art:
Review path: this stage's engine-resolved record dir.
Present the candidate set with its slugs, the one thing each prototype
demonstrates, each success criterion as an observable, and the count of fields
left as builder's choice. Say plainly that each `PROTOTYPE-<slug>.md` is portable
— it can be handed to a developer, or to another AI-DLC run, with no discovery
context — and name the file paths. Then the standard 2-option approval (Approve /
Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. No template
currently resolves for them, so the imported `required-sections` sensor enforces
only a structural floor of at least two `##` headings. The record-artifact
heading lists in Steps 5 and 7 remain authoring requirements, not
sensor-enforced heading checks. `upstream-coverage` checks that the consumed
`pdlc-prioritization-ranking`, `pdlc-prioritization-scoring`, `pdlc-use-cases`,
and `pdlc-prfaq` were actually referenced rather than merely declared.

Each portable `prototypes/<slug>/PROTOTYPE-<slug>.md` is also in the
record-tree sensor match. `required-sections` applies the same two-H2 structural
floor, while `upstream-coverage` can report an unreferenced consume. The
provenance note required in Step 6 makes a ranking-selected candidate observable
without adding a record-dir path or compromising portability. Its required
content shape remains the format reference in `pdlc-prototype-spec-format.md`,
and its real portability test belongs to the human at the approval gate.

The `pdlc-evidence` sensor is deliberately NOT imported. Its target set is
`pdlc-prfaq.md` and `pdlc-prioritization-scoring.md`, neither of which this stage
writes, so importing it would report a pass over a file it never opened.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
