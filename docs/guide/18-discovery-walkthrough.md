# Running a Discovery Initiative

This chapter walks through the opt-in `discovery` scope from the first command
to the final decision, written for someone who has never run it. Discovery is
for the moment *before* you are sure something is worth building: you have a
request, a hunch, or a pile of stakeholder asks, and you want to explore and
validate the idea before committing a team to it.

If you already know what to build and just want to build it, you do not need
discovery — start a normal workflow (see [Your First
Workflow](02-your-first-workflow.md)) and the framework will pick a delivery
scope for you.

One practical choice before you start: run discovery in the workspace where
the build would happen if you decide to build. The final stage offers to
continue straight into delivery in the same workspace — starting in a
scratch folder or a notes repository forfeits that option and leaves you
with the hand-off path only.

## When to reach for discovery

Use it when any of these sound familiar:

- Several people have asked for "something" and you suspect there is a real
  problem underneath, but nobody has checked.
- A stakeholder has a solution in mind and you want evidence before a team is
  committed to it.
- You need to give a sponsor a clear recommendation — build this, don't build
  this, not yet — and you want the reasoning to survive scrutiny.

Discovery never starts by itself. It has no routing keywords, so describing
work in freeform text will never land you in it accidentally. You choose it,
explicitly:

```
/aidlc discovery
```

## The shape of the run

A discovery run is 8 stages: the 3 initialization stages every workflow runs,
the standard Intent Capture stage (1.1), and four discovery stages (1.8–1.11).
(The jump from 1.1 to 1.8 is not an error: 1.2–1.7 are the questionnaire
ideation stages the delivery scopes run, and discovery leaves them untouched.)

```
 0.1–0.3  initialization        (automatic)
 1.1      intent capture        what are we exploring, and what do we
                                already have in hand?
 1.8      current state         how do things actually work today?
                                (ends in a playback you confirm)
 1.9      future state          what could this look like? several genuinely
                                different framings, you choose
 1.10     experimentation       test the riskiest assumptions first,
                                cheaply
 1.11     decision              commit, pivot, or park — over a decision
                                pack you can hand to a sponsor
```

Every stage after initialization ends in the standard approval gate (the
decision stage's pivot and park choices leave through their own doors
instead). You are never more than one stage away from being asked whether
the work is right.

## Stage 1.1: bring what you have

Intent Capture opens with one intake question: beyond your description, is
there anything you can point at (tickets, exports, notes, links), materials to
hand over (process documents, prior analyses, data extracts, a running
product, a design system), anything already decided elsewhere that this work
must honor, or a date a decision is needed by?

Hand over whatever exists. The stage reads it first and only asks you what
your materials did not already answer — you should never have to re-type what
your documents already say. Two things are worth knowing here:

- **Your reading comes first.** If you brought asks or materials, the agent
  asks what *you* think they amount to before it offers any interpretation of
  its own, and records your words verbatim.
- **Answers from materials are held as unconfirmed.** Anything the stage
  learned from a document rather than from you is labeled with its source and
  listed at the approval gate for you to confirm or correct. Nothing a
  document said becomes fact until you have seen it.

The stage produces the intent statement and stakeholder map every workflow
gets, plus a **source inventory** (what you handed over — "None" is a fine
answer) and an **open questions record** (what the initiative still needs to
learn, each question tied to the decision its answer informs).

## Stage 1.8: agree on how things work today

The agent works the open questions from the cheapest sources first: the
materials you supplied, then desk research, then targeted questions to you,
and only then the outside world. It assembles a picture of the current state —
a workflow diagram, a service blueprint, whatever fits — with every claim
carrying its source.

The stage ends in a **playback**: the agent presents the picture and you
confirm or correct it. This is deliberate. Everything after this point builds
on that picture, so an error caught here is the cheapest error you will ever
fix. This is also where the unconfirmed answers from your materials get
confirmed by you or corrected.

## Stage 1.9: choose a framing, see the options

The agent proposes at least three *structurally different* framings of the
problem — not three variations of one idea — and presents the strongest case
against whichever one the evidence favors, so the leading option arrives
already challenged. Anything your organization has already decided (recorded
at intent as a mandate) is presented as already decided, never re-litigated as
if it were open.

You choose the framing. The future state is then expressed as options, and
every option's load-bearing beliefs are written down as **assumptions** — each
one typed (is this about whether people want it, can use it, whether we can
build it, whether it pays), ranked riskiest first, with the condition that
would disprove it stated up front.

## Stage 1.10: test the riskiest assumptions

Assumptions are tested riskiest first, each with a test proportionate to
what it must settle:
studying documents or data you already have, walking a user journey, showing
people a mock, building a thin slice, or running a measurable check. Verdicts
are honest about their limits — a four-person hallway test is recorded as a
four-person hallway test, and team opinion about what users want caps at
"inconclusive". Results land in an append-only **evidence record**: later
entries supersede earlier ones, nothing is ever rewritten.

Be clear about who does what here: the agent designs the tests, drafts the
materials, and keeps the records, but your team is the test apparatus for
anything involving people — you run the hallway test, you sit with the users
walking a journey, you show the mock. Expect this stage to cost real
calendar time from a person, not just agent turns. What you observed goes
back to the agent in plain words, and it lands in the evidence record with
its source and its limits attached.

An assumption that fails here is the process working. It just saved you the
build.

## Stage 1.11: decide, with the pack in hand

The run compiles a **decision pack**: where this came from, what was tested
and what the evidence showed, a working artifact (a mock, a readout, a slice),
the narrative in your organization's own proposal format, the appetite (how
much this direction is worth investing — you are asked for it when the pack
is first drafted, and "not yet stated" is an acceptable answer), and the
no-gos (what this will not do). You send the pack to the people who will
carry the decision *before* any meeting, through whatever channel your team
already uses.

Then you decide, and each choice is exactly what it sounds like:

- **Commit** — we build this. The initiative moves into delivery carrying
  everything the run learned.
- **Pivot** — we keep everything we learned and try a different framing of
  the problem. Nothing is lost; the run returns to stage 1.9.
- **Park** — we stop here without deciding. The record is kept whole, a
  sponsor-facing summary is written (what we learned, why not now, what would
  reopen it), and the workflow can be resumed any time with `/aidlc --resume`.

## After a commit: where does the build happen?

One final question. If the build belongs in this workspace, choose **continue
here**: the workflow switches itself to the delivery scope you pick (`feature`
is the usual default) and carries straight on into the Inception phase — same
workflow, same record, no re-entry through the ideation questionnaire, with
the stages discovery already covered marked as skipped with a reason pointing
at the decision pack. Before the switch, the stage folds what was validated
back into the intent statement (a What Discovery Validated section) and
appends the handoff contract to the pack, and the first delivery stages that
need them — requirements analysis and user stories — list the pack among
their declared inputs. Two honest caveats about that wiring: the input is
optional (a delivery run without a pack proceeds normally), and the check
that delivery actually referenced it is an advisory sensor — it records a
miss in the audit trail rather than stopping anything. You can also verify
it yourself in two minutes: open `intent-statement.md` and look for the
"What Discovery Validated" section, then open the requirements document and
look for `decision-pack.md` cited as a source. If the build belongs to another team or repository,
choose **hand off**: this workflow completes, and the decision pack — which
carries a structured summary of everything answered, supported, refuted, and
still open, each entry with its status, confidence, and source — is what the
receiving team starts from. The pack is a document
(`ideation/discovery-decision/decision-pack.md` in your record), and moving
it is up to you: share it the way your organization shares documents. If the
receiving team also runs this framework, they supply it as material at their
own intent-capture stage and it pre-answers their questions from the start.
There is no automatic transport and no delivery receipt — if you need to
know it arrived, ask the receiving team to confirm the exclusions and open
items, which is a conversation worth having anyway.

## What you end up with

Whatever the decision, the record shows how it was reached: which asks started
it, what the materials said, what was tested, what the evidence showed, and
who decided what when. A parked initiative can be picked up months later
without archaeology. A committed one enters delivery with its reasoning
attached. And a pivoted one starts its second lap already knowing everything
the first lap learned.
