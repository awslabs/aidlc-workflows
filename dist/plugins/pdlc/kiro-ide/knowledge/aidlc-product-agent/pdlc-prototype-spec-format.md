# Portable prototype spec format (`PROTOTYPE-<slug>.md`)

Reference for `pdlc-prototype-spec` (which writes these) and
`pdlc-prototype-build` (which is built from one). The stages own the procedure;
this file describes the artifact's shape, what each section is for, and how each
part fails.

A `PROTOTYPE-<slug>.md` is the one artifact in the `pdlc` plugin designed to
LEAVE its record. It is handed to a developer, dropped into a ticket, mailed to a
contractor, or fed to a fresh AI-DLC run as the only input it gets. It is also
the flow's Entry Point 1: someone arriving with one of these skips discovery
entirely and starts at the build stage.

Everything about the format follows from that.

## The portability test

Read the finished file as someone who has this file and nothing else — no record
dir, no chat history, no access to the person who wrote it, no way to ask a
question. Every sentence that only makes sense with the record open is a defect.

Three consequences that surprise people:

**No cross-references to other artifacts.** Not by path, not by name, not by
inline source tag. This is the only `pdlc` artifact exempt from the plugin's
inline-source-tag rule, and the exemption is not a relaxation — a tag pointing
into a record dir the reader does not have looks like provenance and delivers
none, which is worse than no tag at all. Provenance for the spec set lives in
`pdlc-prototype-spec.md`, which stays behind in the record.

**Deliberate duplication of frozen inputs.** Brand, device, look-and-feel, and
voice are restated in each portable spec even though that repeats
`pdlc-design-context.md` across every candidate. Duplication of a *frozen* input
for portability is the correct trade; the alternative is a spec that cannot be
handed over. This is the only duplication the plugin permits, and it does not
extend to conclusions, scores, or decisions.

**Unknowns are written as buildable unknowns.** `Unknown — builder's choice`,
plus the constraint the choice must respect, is a complete instruction. A silent
gap is not: the builder either guesses invisibly or stops to ask a question the
format exists to make unnecessary.

## The sections

| Section | One line | How it fails |
|---|---|---|
| **Title + premise** | The candidate's name, its slug, and one sentence a stranger understands | Names the technology instead of what a viewer will see |
| **What This Demonstrates** | The ONE thing, in one sentence | Lists three things — a prototype that demonstrates three demonstrates none convincingly |
| **Audience & Decision** | Who watches it and what they decide afterwards | "Stakeholders", with no decision named, which makes the demo unjudgeable |
| **The Demo Path** | The numbered path a viewer takes, start to finish, in order | Describes features rather than a path; the builder then builds a product, not a demo |
| **Shape & Surface** | Web, chat, dashboard, CLI, or generated document; device, viewport, light/dark | Omitted, so the builder picks a laptop web app for something that will be shown on a phone |
| **Screens** | Per screen: purpose, primary action, empty state, the copy that matters | Leaves the empty state undesigned — where most demos visibly fail, because a demo often opens on one |
| **Look & Feel** | Colour ROLES (what each colour is for), typeface and sizes, spacing, corners, reference products | A list of hex codes with no roles; the builder cannot tell which one is the danger colour |
| **Voice & Copy** | How the product speaks, with real example strings — a button, an error, an empty state | "Professional but friendly", which specifies nothing |
| **Data** | What is preloaded, what is faked, what (if anything) is real | Silent about faking, so the demo cannot honestly be introduced |
| **Agentic Behaviour** *(agentic candidates only)* | What it does when uncertain, when wrong, and when it needs permission | Omitted — those three moments ARE the product for an agentic candidate |
| **Success Criterion** | An observable: what a viewer must be able to do, see, or say afterwards | "Demonstrates the concept" — unfalsifiable, so validation has nothing to judge |
| **Out of Scope** | What the prototype deliberately does not do | Absent, so the builder adds auth and persistence and the demo arrives late |
| **Security Posture** | Local only; mock data unless stated; no credentials in the spec or in the code it describes | Absent, so a builder reaches for a real key to make it feel real |
| **Builder's Choices** | Every field left open, each with the constraint the choice must respect | An open field with no constraint, which is a guess with extra steps |

## Rules that carry most of the weight

**The success criterion is an observable, and it is written before the build.**
"A regional manager can complete a quote approval without asking what to click,
and can say afterwards which quote was flagged and why" is a criterion.
"Validates the agentic quoting concept" is a wish. The validation stage judges
against whatever is written here, so a vague criterion converts into a validation
that cannot fail — and a validation that cannot fail was not evidence.

**One thing, demonstrated well.** The strongest specs are boring in scope: three
screens, one path, one point. A prototype's value is a clear answer to a clear
question, and every additional feature blurs which question was answered.

**Say what is faked, in the spec.** Then the builder keeps the fakes in one
obvious place and the presenter can tell the room. An unlabelled fake produces
feedback about response quality that is really feedback about canned text — the
most expensive kind of misleading result, because it looks like a product
finding.

**The demo path is a path, not a feature list.** Numbered steps, in the order the
viewer experiences them, including where they start. A demo that opens on an
empty state and requires setup has spent its first minute badly.

**Design the edges.** Name what should visibly NOT work — greyed, disabled,
labelled — so a curious viewer stays on the path rather than discovering the
unfinished parts and reviewing those instead.

## Length and shape

One to two pages. A spec longer than that is either specifying a product rather
than a prototype, or restating discovery the reader does not need. Keep the
sections in the table's order — a builder reads top to bottom and stops when they
have enough, so the ONE thing and the demo path come before the look and feel.

Markdown, `##` per section, no frontmatter. It is a document for humans, not a
record artifact with a machine-checked heading set: no sensor polices it, and its
real test is the portability test above, which no sensor can perform.

## Where it lives

`pdlc-prototype-spec` writes each one under its own record dir at
`prototypes/<slug>/PROTOTYPE-<slug>.md`, and the slug obeys the plugin's
sanitisation rule — lowercase letters, numbers, and hyphens only, and any slug
containing `/`, `\`, or `..` is rejected rather than repaired, because that slug
becomes a directory path in the build stage.

The build stage writes CODE, not specs, and it writes it to `prototypes/<slug>/`
at the **workspace root**. The two directory names rhyme; the two trees do not
mix. The spec is a record artifact that travels; the code is disposable local
scaffolding.
