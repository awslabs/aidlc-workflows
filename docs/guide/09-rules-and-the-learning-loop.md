# Rules and the Learning Loop

Rules are persistent, prose instructions that shape how agents work on your project. The learning loop is how those rules get written: you correct an agent during a workflow, confirm the correction at the stage's approval gate, and the framework saves it so the same correction is never needed twice.

This chapter is the user-facing tour. It covers where rules live, how the five layers stack, how the learning loop captures a correction, and how Sensors give you a deterministic second opinion alongside the rules. For the schema-level mechanics, the chapter cross-links to the Developer Reference at each step.

---

## Rules at a glance

Rules live as Markdown files in the active space memory layer at `aidlc/spaces/<active-space>/memory/`, a single hand-editable set at the workspace root, read by every harness via its native include (Claude `@`-import stub, Kiro CLI resources or IDE steering, the engine's per-step rules delivery on Codex, opencode `instructions` glob, Copilot `AGENTS.md` `@`-imports). Each file is named for its scope:

```
aidlc/spaces/<active-space>/memory/
├── org.md                 # framework + organization-wide defaults
├── team.md                # your team's affirmed practices
├── project.md             # this project's specialization
└── phases/
    ├── ideation.md
    ├── inception.md
    ├── construction.md
    └── operation.md
```

There is no `scope:` field inside the files — scope comes from the filename. `org.md` carries framework defaults (trunk-based development, testing posture, walking-skeleton policy). `team.md` holds what your team has affirmed. `project.md` holds anything specific to this one project. The four `phases/<phase>.md` files carry rules that apply to every stage in a given phase — for example, the inception phase rule requires every architecture decision to document at least two alternatives.

Each file is plain prose under topical headings (`## Way of Working`, `## Testing Posture`, `## Deployment`, `## Code Style`, and so on). You read them, you can edit them by hand, and the framework writes to them through the learning loop.

The schema, the filename-to-scope table, and the resolver mechanics are documented in [Rule System](../reference/08-rule-system.md) in the Developer Reference.

---

## The five-layer chain

Rules resolve through a five-layer chain at the start of every workflow:

```
org → team → project → phase → stage
```

The model is **strict-additive**. Every applicable rule appears in the agent's context — nothing is silently dropped or overridden at runtime. Org defaults, team practices, and project specialization concatenate. The matching phase rule attaches because the stage already declares its phase. (The fifth layer, per-stage rules, is reserved for a future release.)

This is a deliberate change from earlier versions. There is no `overrides:` block and no `enforcement:` keyword anymore. All the applicable layers are present at once, and the orchestrator is asked to check a kept learning for conflict at admission time rather than leaving the runtime resolver to reconcile it (see [Admission-time conflict checks](#admission-time-conflict-checks) below).

The chain **selection** is resolved **once**, when the framework compiles your stage definitions, rules, and sensors into a single graph; a workflow reads that compiled graph. The graph records which rule files apply to each stage; the engine never re-walks the directory chain mid-run. The files' **contents** are not frozen, though: before each stage runs, the engine reads the selected files' current text and delivers it. That compile boundary is the same one the planes model describes — see [Planes: how it fits together](#planes-how-it-fits-together) at the end of this chapter.

---

## The learning loop

The learning loop is the mechanism that turns a one-time correction into a durable rule. Most stage runs add nothing — and that is healthy. The loop fires only when something surfaced during the stage that you decide is worth keeping.

When the learnings ritual is on, the loop has four user-visible moments: the agent keeps a diary while the stage runs, the gate surfaces candidates, you confirm what to keep, and the framework writes the kept items for next time. When it is off, neither the diary nor the gate ritual runs.

### The memory.md diary

When the learnings ritual is on, the framework keeps a running observation log at `<record>/<phase>/<stage>/memory.md` while a stage runs — under the intent's record dir, `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`. The engine creates it from the shipped template when it emits the run-stage directive, and the orchestrator maintains it for you — never hand-edited. Entries land under four standard headings:

- **Interpretations** — choices the agent made where the stage prose was ambiguous
- **Deviations** — places the agent intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and the reason for the pick
- **Open questions** — anything to confirm before the next run, or context that's still uncertain

Each entry carries a timestamp. The language model writes observations to `memory.md` during the stage and, at admission time, the orchestrator performs the section-level conflict comparison described below. Deterministic tooling extracts the candidates and writes the selections you explicitly keep at the gate.

### The gate ritual

Before each approval gate, the framework runs the learning gate (the protocol calls it the §13 ritual). It collects candidates from two sources and presents them as one confirm-list:

1. **Your agent's diary, surfaced verbatim.** A deterministic tool reads `memory.md` and offers each entry under Interpretations, Deviations and Tradeoffs as a candidate, with its source heading attached. No paraphrase, no "interesting" filtering: the entries are shown as written. Each entry is one line in the diary. Open questions are never offered: they stay in the diary as things to look into, not rules to install.
2. **A question that always asks "Anything to add for next time?"** Choose **Add a note**, say the observation in your own words, and pick which of the four headings it belongs under. That heading pick is the only classification asked of you.

You tick the candidates you want to keep, or **Keep none of these**, the first choice, to keep none. If `memory.md` was empty for the stage, no one asks you to attest to whether the diary was kept: the framework records that quietly and moves on, and you are asked only "Anything to add for next time?".

### What it looks like

From a Claude Code run at the Intent Capture gate (shortened, drawing characters shown as plain text). The diary held one Interpretation and one Deviation, so the first question offers both:

```text
 Keep notes
 Which notes from this step should I keep as practices for future work? (select all that apply)
 > 1. [ ] Keep none of these
          Don't save any of these notes
   2. [ ] Treated store customers as the people the first release helps, not as a stakeholder group
          -> project.md ## Corrections (say if it should go to team.md instead)
   3. [ ] Added a ninth question for the vision document's open per-warehouse question
          -> project.md ## Corrections (say if it should go to team.md instead)
```

Then the question that is always asked:

```text
 Anything to add for next time?
 > 1. Nothing to add
      Go on to the approval question
   2. Add a note
      Tell me something to remember for future work
```

After **Add a note** and the note "Call a stock item a SKU in every document, never a product.", the agent asks which heading it belongs under:

```text
 Note type
 Which kind of note is "Call a stock item a SKU in every document, never a product"? I'll file it
 under the right practice heading from your pick.
 > 1. Interpretation
      How to read or name something where it could be ambiguous
   2. Deviation
      A place where we deliberately do things differently
   3. Tradeoff
      A choice between alternatives and why
   4. Open question
      Something to confirm later (kept as a reminder, not a practice)
```

With candidate 2 kept and the note filed as an Interpretation, `aidlc/spaces/default/memory/project.md` ends with two practice lines (the agent words a kept candidate as a practice; your note is kept as you wrote it):

```text
## Corrections
...
- Treat online store customers as the people the first release helps, not as a stakeholder group, unless the user names them as stakeholders (learned 2026-10-13) <!-- cid:... -->
- Call a stock item a SKU in every document, never a product. (learned 2026-10-13) <!-- cid:... -->
```

and the audit shard gets one row for each, here the note's:

```text
## Rule Learned
**Timestamp**: 2026-10-13T10:41:30Z
**Event**: RULE_LEARNED
**Stage**: intent-capture
**Candidate-ID**: u1
**Content-Hash**: 3a3aa8df...
**Destination**: <project-dir>/aidlc/spaces/default/memory/project.md
**Heading**: ## Corrections
**Source**: user_addition
```

Asked at that gate which knowledge it had used, the agent said the two notes were written after the stage's documents were finished and would be in force from the next stage on, as [Applies from the next applicable stage](#applies-from-the-next-applicable-stage) describes.

### Where a kept learning goes

You never pick a file path. The heading determines the destination:

- Interpretations, Deviations, and Tradeoffs land as practices in `aidlc/spaces/<active-space>/memory/project.md` (a confirmed learning *is* a practice) under topical headings.
- Open questions don't promote — they're research items, not rules to install.

The default scope is **project**. A one-click "promote to team" affordance widens a kept learning from `memory/project.md` to `memory/team.md` when the lesson applies beyond this one project. There is no widen-to-org path: org rules are framework-shipped or organization-authored through a separate process, so the learning loop never writes at org scope. Defaulting to the narrowest scope keeps one project's surprise from becoming an organization-wide rule by accident.

A confirmed learning *is* a practice: it lands in the same active-space memory files (`aidlc/spaces/<active-space>/memory/project.md`, `team.md`) that practices-discovery affirms — there is no separate rolling `*-learnings.md` surface. The two paths into those files differ by lifecycle: practices-discovery affirms a whole section deterministically, while the learning loop appends one dated, topically-headed entry at a time through the gate.

When a kept learning is a **sensor binding** rather than a rule (you want a new deterministic check to fire on a stage's output), the framework does a two-write install atomically: it scaffolds the sensor manifest and appends the new sensor's id to the originating stage's import list. The diary, the gate confirmation, and the resulting file write each leave an audit row (`RULE_LEARNED` or `SENSOR_PROPOSED`), so no rule is ever installed silently.

### Admission-time conflict checks

Before a kept learning lands on disk, the gate protocol asks the orchestrator to compare it with the matching section of `memory/org.md`. This is a section-level LLM check. If the proposed entry contradicts an org rule, the orchestrator quotes the conflicting sentence inline and asks you to revise the entry, skip it, or escalate to the org-rule owner. Only conflict-clear or user-escalated selections are then handed to the deterministic writer. `aidlc-learnings.ts persist` has no independent view of `org.md`, does not judge conflicts, and accepts the selections it is handed. The org-contradiction escalation is therefore an audit aid for keeping resolver inputs coherent, not an enforcement boundary.

The practices-discovery affirmation gate does not run this org-conflict check. Its promotion is a deterministic section-replace legitimised by your affirmation. And when org policy changes *after* a team or project rule is already on disk, `/aidlc --doctor` surfaces possible drift on demand: for each team or project file with a filled-in section whose heading `org.md` also fills in, it names the file and the heading and quotes the first sentence of org's section there, so you (or the agent) can judge whether the two disagree. It compares headings, not meaning. The doctor check is advisory and never blocks. The two doctor advisory rows are described in [CLI Commands](12-cli-commands.md) and [Troubleshooting](15-troubleshooting.md).

### Applies from the next applicable stage

A kept learning is appended to an already-selected rule file (`project.md` or `team.md`), and the engine reads the selected files' current text before each stage delivery. So the learning reaches the agent at the next applicable stage of the **current** workflow — the stage where it was captured already got your correction in conversation, and every later delivery carries the written rule. Later workflows receive it too.

What waits for the next compile is the **selection**: a brand-new rule file enters the chain, and a new Sensor binds and fires, only when the stage graph is next compiled. This is the stability property a router gets from BGP: the compiled selection doesn't recompute mid-packet-flight. The rule *text* inside the selected files is read fresh each stage, so a correction you kept does not sit idle for the rest of the run.

---

## Worked example: a banking project

A concrete walk-through shows the loop end to end.

Sam runs `/aidlc feature` on a banking project. The workflow lands on `requirements-analysis`. Sam writes a stakeholder note saying "the transaction shouldn't duplicate on retry" — meaning a banking transaction, the payment being processed. The product agent reads "transaction" as a database transaction and interprets the note as an ACID-semantics requirement. Sam corrects it. The agent updates the artifact and continues.

Nothing in the framework predicted this. There's no rule about the bank's own terminology and no sensor catching generic-versus-domain term clashes. The agent simply hit an ambiguity.

**1. The diary records it.** The agent appends one line under `## Interpretations` in `<record>/inception/requirements-analysis/memory.md`: its time, a short summary ("Stakeholder note used 'transaction'; interpreted as database-transaction") and the context (Sam corrected it to mean the payment being processed, not the database write). Each entry is a single line; a note wrapped onto a second line would be offered as two candidates.

No rule is installed yet: this is just the agent's diary.

**2. The gate surfaces it.** The stage finishes. Before the approval gate, the learning gate reads `memory.md` and shows the interpretation line as a candidate. It also asks "Anything to add for next time?" Sam ticks the transaction-terminology candidate (Interpretation → lands in `memory/project.md`) and adds a free-text note: "the agent kept defaulting to AWS account terminology — should always say 'bank customer' for the banking customer entity." Sam picks the Deviation heading for that addition, which routes it to the same `memory/project.md` file.

**3. The conflict check runs.** The orchestrator compares both entries against the org practices (`memory/org.md`) as a section-level LLM check. Neither the "transaction" nor the "bank customer" terminology is covered by an org rule, so both pass. The deterministic tool then writes both lines into `memory/project.md` with provenance, and the audit log records a `RULE_LEARNED` event for each.

**4. The current workflow carries them forward.** The stage approves and the workflow advances to `user-stories`. `memory/project.md` was already in this workflow's compiled selection, and the engine re-reads its text before each stage delivery — so from `user-stories` onward, the new lines are in the agent's context for the rest of this run.

**5. Later workflows receive them too.** Later that day Sam runs `/aidlc bugfix`. `memory/project.md` is in every stage's selection (the org, team, and project files attach to every stage), so from stage one of the bugfix workflow, the agent knows "transaction" means a payment and the customer entity is the "bank customer."

The cost was paid once — one gate confirmation, one file write — and it pays back on every future workflow for the price of one more file in the directory walk.

---

## Sensors: the deterministic second opinion

Rules are prose the agent reads. Sensors are deterministic checks that run automatically when an agent writes a stage's output. Where a rule says "user stories follow Given/When/Then format," a sensor can verify, byte-for-byte, that the required headings are actually present in the file. Rules feed the agent forward into a stage; sensors feed back what the agent actually produced.

### How sensors fire

When an agent writes or edits an output file during a stage, a PostToolUse hook checks which sensors apply to that stage and runs each matching one. Matching is by file shape: a code-quality sensor declares it analyses `**/*.{ts,js}`, so it only fires on TypeScript and JavaScript writes; a document-shape sensor that fires on any stage output omits the filter. Gate-fired sensors, the first three in the table below, run instead when the stage reaches its approval gate, once for each of the stage's declared output files their filter accepts. When the gate is one the tool approves on its own under Construction autonomy, only blocking sensors run there: advisory findings would have no one to read them. You don't invoke sensors by hand during a workflow; they ride along on the stage's writes and its gate.

The six sensors that ship are **advisory**. A failing one produces an audit row and a detail file pointing at exactly what's missing, but it does not block the stage's approval gate or stop your workflow. When the gate opens, the agent tells you which checks still report findings on the stage's outputs, so you decide with that in view. With Sensors switched off, nothing is said about checks.

A sensor you add can be **blocking** instead (`default_severity: blocking` in its manifest). When a blocking sensor at a gate does not pass, the gate does not open: the agent offers **Fix findings** or **Override blocking sensors**, and an override is recorded as your choice. In autonomous Construction the run stops there instead, and choosing the override first sets Construction back to stopping for your approval at each Bolt. See [Sensor System](../reference/07-sensor-system.md).

### What you see in the audit log

Sensor activity shows up in the intent's `audit/` shards as `Sensor Fired`, `Sensor Passed`, and `Sensor Failed` rows. A failed row links to a detail file (for example `<record>/.aidlc-engine/sensors/intent-capture/claim-sources-0719478d.md`, named for the sensor and the fire id on its rows) that lists the specific gap - the missing headings, the unreferenced upstream artifact, the lint error. A passing check leaves a row like this one, from the run above:

```text
## Sensor Passed
**Timestamp**: 2026-10-13T10:41:35Z
**Event**: SENSOR_PASSED
**Fire id**: 0d3ee5cc
**Sensor ID**: claim-sources
**Stage slug**: intent-capture
**Output path**: aidlc/spaces/default/intents/261013-inventory-api/ideation/intent-capture/intent-statement.md
**Duration ms**: 190
```

The audit log is covered in [State and Audit](10-state-and-audit.md).

### The six framework sensors

Six sensors ship with the framework:

| Sensor | Fires on | Checks |
|--------|----------|--------|
| `claim-sources` | Intent Capture record-dir outputs | Every claim has a visible source tag; registered description, workflow scope, and memory text match authoritative inputs; retained assumptions exactly match explicit confirmation |
| `required-sections` | Any record-dir markdown output, plus reverse-engineering's `codekb/` files | The output contains the required H2 headings (a generic content-shape check). Timestamp run records such as `practices-discovery-timestamp.md` always pass |
| `upstream-coverage` | Any record-dir markdown output, plus reverse-engineering's `codekb/` files | The stage's deliverables (evaluated as a set) reference each upstream artifact the stage declares it requires (`required: true`) or lists under `cites:`, by slug, wikilink, or the producing stage's directory path |
| `traceability` | `traceability.json` stage artifacts | Stable upstream IDs are declared and covered, statuses and targets are valid, and deterministic downstream targets exist |
| `linter` | `.ts` / `.js` code outputs | Wraps your configured linter (ESLint by default) |
| `type-check` | `.ts` / `.tsx` code outputs | Wraps your configured type-checker (`tsc` by default) |

Each stage declares which sensors fire on its outputs. You can add your own sensors — author a manifest under `.claude/sensors/`, then add its id to the stages that should run it. The learning loop can also install a sensor for you when you confirm one at a gate. The manifest format, the per-stage matrix, and the authoring walkthrough live in [Sensor System](../reference/07-sensor-system.md). For adding one to your own project, see [Customization](13-customization.md).

---

## Planes: how it fits together

You can use everything above without thinking about planes. But the underlying design borrows a discipline from networking, and naming it makes the compile boundary — what is fixed at workflow start and what is read live — click into place.

A modern router splits its work into three planes, and AI-DLC mirrors the split:

- **Control plane** — the *schema* of what should run. Stage definitions, rules, sensors. In networking terms, this is route computation: given the configuration, decide what applies where. The control plane is allowed to be slow and clever because it runs once.
- **Data plane** — the *actual runs*. Stage executions, agent invocations, the files in the intent's record dir. In networking terms, this is packet forwarding: fast, repeated, by lookup. The data plane reads the resolved answers; it doesn't re-derive them.
- **Management plane** — the *observe-and-configure* surface. `/aidlc --doctor`, the audit log, `CLAUDE.md`. You configure here and you query here, at human cadence.

The control plane compiles your rules and sensors into a graph **once**; the data plane reads pre-resolved answers off that graph for the rest of the run. The compiled answer is the *selection* — which rule files and sensors attach to which stage. The selected rule files' text is read at delivery time, so a kept learning in an already-selected file reaches the next stage without a recompile; a new file or a new Sensor binding is a topology change and waits for the next graph compile. The result is reproducible runs and clean recovery after a restart.

As a user you mostly touch one horizontal slice at a time — running a workflow, capturing a learning, customizing team practices, auditing what happened. Each slice touches the planes underneath without making you reason about them. The full model, the compile boundary, and the recovery property are in [Plane Architecture](../reference/02-plane-architecture.md), with the telemetry artifact it produces documented in [Runtime Graph](../reference/13-runtime-graph.md).

---

## Next Steps

- [Knowledge](08-knowledge.md) — the two-tier knowledge system that informs (rather than constrains) agent behavior
- [Customization](13-customization.md) — add a rule, add a sensor, extend the loop, add a stage or agent
- [Interaction Modes](07-interaction-modes.md) — how corrections happen during a stage
- [State and Audit](10-state-and-audit.md) — how the learning loop's events are logged
- [CLI Commands](12-cli-commands.md) — the doctor rule-drift and paired-coverage advisory rows
- [Rule System](../reference/08-rule-system.md) · [Sensor System](../reference/07-sensor-system.md) · [Plane Architecture](../reference/02-plane-architecture.md) — the schema- and design-level reference
- [Glossary](glossary.md) — terminology reference
