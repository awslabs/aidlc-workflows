# Rules and the Learning Loop

Rules are persistent, prose instructions that shape how agents work on your project. The learning loop is how those rules get written: you correct an agent during a workflow, confirm the correction at the stage's approval gate, and the framework saves it so the same correction is never needed twice.

This chapter is the user-facing tour. It covers where rules live, how the five layers stack, how the learning loop captures a correction, and how Sensors give you a deterministic second opinion alongside the rules. For the schema-level mechanics, the chapter cross-links to the Developer Reference at each step.

---

## Rules at a glance

Rules live as Markdown files in the space memory layer at `aidlc/spaces/<space>/memory/` — a single hand-editable set at the workspace root, read by every harness via its native include (Claude `@`-import stub, Kiro resources glob, Codex `AIDLC_RULES_DIR`). Each file is named for its scope:

```
aidlc/spaces/<space>/memory/
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

This is a deliberate change from earlier versions. There is no `overrides:` block and no `enforcement:` keyword anymore. All the applicable layers are present at once, and conflicts are caught when a rule is written, before it ever reaches runtime (see [Admission-time conflict checks](#admission-time-conflict-checks) below).

The chain is resolved **once**, at workflow start, when the framework compiles your stage definitions, rules, and sensors into a single graph. Throughout the workflow the agent reads the resolved view; it never re-walks the chain mid-run. That compile boundary is the same one the planes model describes — see [Planes: how it fits together](#planes-how-it-fits-together) at the end of this chapter.

---

## The learning loop

The learning loop is the mechanism that turns a one-time correction into a durable rule. Most stage runs add nothing — and that is healthy. The loop fires only when something surfaced during the stage that you decide is worth keeping.

The loop has four user-visible moments: the agent keeps a diary while the stage runs, the gate surfaces candidates, you confirm what to keep, and the framework writes the kept items for next time.

### The memory.md diary

While a stage runs, the framework keeps a running observation log at `<record>/<phase>/<stage>/memory.md` — under the intent's record dir, `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`. It is created automatically at stage start and maintained for you — never hand-edited. Entries land under four standard headings:

- **Interpretations** — choices the agent made where the stage prose was ambiguous
- **Deviations** — places the agent intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and the reason for the pick
- **Open questions** — anything to confirm before the next run, or context that's still uncertain

Each entry carries a timestamp. The diary is the only job the language model has in this loop: write observations to `memory.md` during the stage. Everything after the stage finishes — counting the entries, surfacing them, routing them to the right file, writing them — is done by deterministic tooling or by your explicit choice at the gate.

### The gate ritual

Before each approval gate, the framework runs the learning gate (the protocol calls it the §13 ritual). It collects candidates from two sources and presents them as one confirm-list:

1. **Your agent's diary, surfaced verbatim.** A deterministic tool reads `memory.md` and emits each non-blank line under the four headings as a candidate, with its source heading attached. No paraphrase, no "interesting" filtering — the lines are shown as written.
2. **A free-text channel that always asks "Anything to add for next time?"** You type the observation and pick which of the four headings it belongs under. That heading pick is the only classification asked of you.

You tick the candidates you want to keep. If `memory.md` was empty for the stage, no one asks you to attest to whether the diary was kept — the framework records that quietly and moves on.

### Where a kept learning goes

You never pick a file path. The heading determines the destination:

- Interpretations, Deviations, and Tradeoffs land as practices in `aidlc/spaces/<space>/memory/project.md` (a confirmed learning *is* a practice) under topical headings.
- Open questions don't promote — they're research items, not rules to install.

The default scope is **project**. A one-click "promote to team" affordance widens a kept learning from `memory/project.md` to `memory/team.md` when the lesson applies beyond this one project. There is no widen-to-org path: org rules are framework-shipped or organization-authored through a separate process, so the learning loop never writes at org scope. Defaulting to the narrowest scope keeps one project's surprise from becoming an organization-wide rule by accident.

A confirmed learning *is* a practice: it lands in the same space memory files (`aidlc/spaces/<space>/memory/project.md`, `memory/team.md`) that practices-discovery affirms — there is no separate rolling `*-learnings.md` surface. The two paths into those files differ by lifecycle: practices-discovery affirms a whole section deterministically, while the learning loop appends one dated, topically-headed entry at a time through the gate.

When a kept learning is a **sensor binding** rather than a rule (you want a new deterministic check to fire on a stage's output), the framework does a two-write install atomically: it scaffolds the sensor manifest and appends the new sensor's id to the originating stage's import list. The diary, the gate confirmation, and the resulting file write each leave an audit row (`RULE_LEARNED` or `SENSOR_PROPOSED`), so no rule is ever installed silently.

### Admission-time conflict checks

Before a kept learning lands on disk, the framework runs a section-level check against `memory/org.md`. If your proposed entry contradicts an org rule under the same heading, the gate stops and quotes the conflicting org sentence inline. You then choose to revise the entry, skip it, or escalate to the org-rule owner. The conflicting rule never lands with the contradiction in it, so the runtime resolver stays simple — it only ever sees rules that already passed the conflict check.

The same section-level check guards the practices-discovery affirmation gate. And when org policy changes *after* a team or project rule is already on disk, `/aidlc --doctor` surfaces the resulting drift on demand: it names the file, the section, and the conflicting org sentence so the team can act on it. The doctor check is advisory and never blocks. The two doctor advisory rows are described in [CLI Commands](12-cli-commands.md) and [Troubleshooting](15-troubleshooting.md).

### Applies next workflow, not mid-run

A learning captured at one gate does **not** change the rules for the rest of the current workflow. You already corrected the agent in conversation for this run; the rule is for next time. The new line is on disk, but the in-flight workflow keeps the compiled view it started with.

The next time you start a workflow, the compile reads the new file and the rule applies from stage one onward. This is the same stability property a router gets from BGP: routes don't recompute mid-packet-flight, and AI-DLC doesn't recompile mid-workflow. The payoff is predictability — gates you approved earlier in the workflow attested to a stable set of rules, and the framework doesn't change the ground under a run in progress.

---

## Worked example: the ANZ banking project

A concrete walk-through shows the loop end to end.

Sam runs `/aidlc feature` on the ANZ banking project. The workflow lands on `requirements-analysis`. Sam writes a stakeholder note saying "the transaction shouldn't duplicate on retry" — meaning a banking transaction, the payment being processed. The product agent reads "transaction" as a database transaction and interprets the note as an ACID-semantics requirement. Sam corrects it. The agent updates the artifact and continues.

Nothing in the framework predicted this. There's no rule about ANZ-specific terminology and no sensor catching generic-versus-domain term clashes. The agent simply hit an ambiguity.

**1. The diary records it.** The framework appends an entry under `## Interpretations` in `<record>/inception/requirements-analysis/memory.md`:

```
- 2026-05-21T09:14:32Z — Stakeholder note used "transaction"; interpreted as
  database-transaction. Sam corrected to mean banking-transaction (the payment
  being processed, not the DB write). Worth flagging for ANZ project context.
```

No rule is installed yet — this is just the agent's diary.

**2. The gate surfaces it.** The stage finishes. Before the approval gate, the learning gate reads `memory.md` and shows the interpretation line as a candidate. It also asks "Anything to add for next time?" Sam ticks the transaction-terminology candidate (Interpretation → lands in `memory/project.md`) and adds a free-text note: "the agent kept defaulting to AWS account terminology — should always say 'ANZ customer' for the banking customer entity." Sam picks the Deviation heading for that addition, which routes it to the same `memory/project.md` file.

**3. The conflict check runs.** The framework compares both entries against the org practices (`memory/org.md`). Neither "ANZ transaction" nor "ANZ customer" terminology is covered by an org rule, so both pass. A deterministic tool writes both lines into `memory/project.md` with provenance, and the audit log records a `RULE_LEARNED` event for each.

**4. The current workflow continues unchanged.** The stage approves and the workflow advances to `user-stories`. The new lines are on disk but don't enter this workflow's compiled view — Sam already corrected the agent in-stage for this run.

**5. The next workflow picks them up.** Later that day Sam runs `/aidlc bugfix`. The compile at workflow start walks the space memory layer, picks up `memory/project.md`, and includes it in every stage's context. From stage one of the bugfix workflow, the agent knows "transaction" means a payment and the customer entity is the "ANZ customer."

The cost was paid once — one gate confirmation, one file write — and it pays back on every future workflow for the price of one more file in the directory walk.

---

## Sensors: the deterministic second opinion

Rules are prose the agent reads. Sensors are deterministic checks that run automatically when an agent writes a stage's output. Where a rule says "user stories follow Given/When/Then format," a sensor can verify, byte-for-byte, that the required headings are actually present in the file. Rules feed the agent forward into a stage; sensors feed back what the agent actually produced.

### How sensors fire

When an agent writes or edits an output file during a stage, a PostToolUse hook checks which sensors apply to that stage and runs each matching one. Matching is by file shape — a code-quality sensor declares it analyses `**/*.{ts,js}`, so it only fires on TypeScript and JavaScript writes; a document-shape sensor that fires on any stage output omits the filter. You don't invoke sensors by hand during a workflow; they ride along on every Write and Edit.

A sensor result is **advisory** in this release. A failing sensor produces an audit row and a detail file pointing at exactly what's missing, but it does not block the stage's approval gate or stop your workflow. You see the signal; you decide what to do with it.

### What you see in the audit log

Sensor activity shows up in the intent's `audit/` shards as `Sensor Fired`, `Sensor Passed`, and `Sensor Failed` rows. A failed row links to a detail file (for example `<record>/.aidlc-sensors/<stage-slug>/required-sections-<timestamp>.md`) that lists the specific gap — the missing headings, the unreferenced upstream artifact, the lint error. The audit log is covered in [State and Audit](10-state-and-audit.md).

### The four framework sensors

Four sensors ship with the framework:

| Sensor | Fires on | Checks |
|--------|----------|--------|
| `required-sections` | Any record-dir markdown output | The output contains the required H2 headings (a generic content-shape check) |
| `upstream-coverage` | Any record-dir markdown output | The stage's deliverables (evaluated as a set) reference each upstream artifact the stage declares it consumes, by slug, wikilink, or the producing stage's directory path |
| `linter` | `.ts` / `.js` code outputs | Wraps your configured linter (ESLint by default) |
| `type-check` | `.ts` / `.tsx` code outputs | Wraps your configured type-checker (`tsc` by default) |

Each stage declares which sensors fire on its outputs. You can add your own sensors — author a manifest under `.claude/sensors/`, then add its id to the stages that should run it. The learning loop can also install a sensor for you when you confirm one at a gate. The manifest format, the per-stage matrix, and the authoring walkthrough live in [Sensor System](../reference/07-sensor-system.md). For adding one to your own project, see [Customization](13-customization.md).

---

## Planes: how it fits together

You can use everything above without thinking about planes. But the underlying design borrows a discipline from networking, and naming it makes the "applies next workflow" behavior click into place.

A modern router splits its work into three planes, and AI-DLC mirrors the split:

- **Control plane** — the *schema* of what should run. Stage definitions, rules, sensors. In networking terms, this is route computation: given the configuration, decide what applies where. The control plane is allowed to be slow and clever because it runs once.
- **Data plane** — the *actual runs*. Stage executions, agent invocations, the files in the intent's record dir. In networking terms, this is packet forwarding: fast, repeated, by lookup. The data plane reads the resolved answers; it doesn't re-derive them.
- **Management plane** — the *observe-and-configure* surface. `/aidlc --doctor`, the audit log, `CLAUDE.md`. You configure here and you query here, at human cadence.

The control plane compiles your rules and sensors into a graph **once**, at workflow start. The data plane reads pre-resolved answers off that graph for the rest of the run. That's why a learning captured mid-workflow waits for the next compile: the framework computes the answer at "topology-change time" (workflow start), not at "packet time" (every stage). The result is reproducible runs and clean recovery after a restart.

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
