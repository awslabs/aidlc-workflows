# Rules and the Learning Loop

Rules are the standing decisions your team carries into every workflow — the
"always do it this way" that you would otherwise re-explain at the start of each
run. As a harness engineer you author them in two ways: by editing a rule file
directly, or by letting the **learning loop** promote an in-workflow correction
into a durable rule for you. This chapter is the authoring-side companion to the
[Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) chapter
in the User Guide, which covers the loop conceptually and walks the ANZ banking
example end to end. Here the focus is operational: which file you edit for what,
how the strict-additive model behaves when you stack a rule, and how to run the
loop so a one-time fix becomes a standing rule.

Rules are the feedforward half of the control loop — prose the agent reads *before* it
works. [Sensors](06-sensors.md) are the feedback half — deterministic checks that
fire *after* a write. A rule can name a sensor as its companion; the two halves
are designed to pair.

---

## The five layers and which file you edit

Rules live as Markdown files under `core/memory/` (the authored source for the space memory layer), one file per scope.
There is no `scope:` frontmatter field — this implementation derives scope from
the filename, so the file you pick *is* the scope you author at:

| You want a rule that applies to… | Edit | Scope |
|---|---|---|
| every project at your organization | `org.md` | org (framework default) |
| every project your team runs | `team.md` | team |
| this one project | `project.md` | project |
| every stage in one phase | `phases/<phase>.md` | phase |

The four phase files are `phases/ideation.md`, `phases/inception.md`,
`phases/construction.md`, and `phases/operation.md` (initialization is
bootstrap-only and ships no rule file). A fifth layer — per-stage rules
(`aidlc-stage-<slug>.md`) — is reserved for a future release; you cannot author
one yet.

Two judgment calls drive which file you reach for:

- **`org.md` is framework-shipped.** It carries the defaults every project
  inherits — trunk-based development, the walking-skeleton policy, the testing
  posture per scope. Treat it as upstream. Most harness engineers leave it alone
  and author at team or project.
- **Project scope is for durable deviation, not for everything.** Reach for
  `project.md` only when *this* project stably departs from team-wide
  practice — a monorepo that rebases where the team squashes, a legacy project
  that skips the test floor. If the rule would help every project your team runs,
  it belongs in `team.md`.

Each file is plain prose under topical headings — `## Way of Working`,
`## Testing Posture`, `## Deployment`, `## Code Style`, and so on. You add a rule
by adding a bullet under the heading it belongs to. The full filename-to-scope
table and the resolver mechanics are the normative contract:
[Rule System § Filename-derived scope](../reference/08-rule-system.md#filename-derived-scope)
and [§ Layout](../reference/08-rule-system.md#layout).

---

## Strict-additive: layers stack, none silently overrides

The chain resolves through five layers at the start of every workflow:

```
org → team → project → phase → stage
```

The model is **strict-additive**. Every applicable rule appears in the agent's
context at once — nothing is dropped or suppressed at runtime. Org defaults, team
practices, and project specialization concatenate; the matching phase rule
attaches because the stage already declares its `phase:` in frontmatter (the same
pull-authoring direction a stage uses to import everything else). The resolved
chain is baked into each stage node once, at workflow start — the runtime never
re-walks it. See
[Rule System § Strict-additive runtime model](../reference/08-rule-system.md#strict-additive-runtime-model)
and [§ Five-layer inheritance](../reference/08-rule-system.md#five-layer-inheritance).

What this means for you as an author: there is no `overrides:` block and no
`enforcement:` keyword to set. A narrower layer does not quietly win over a
broader one. Instead, every layer you write is present in the agent's view
simultaneously. That changes how you author — you state a rule positively at the
scope where it should apply, and you trust it to stack with the layers above it
rather than reaching for a switch to suppress them.

### Conflicts are rejected when you write, not resolved at runtime

Because nothing overrides at runtime, a rule that *contradicts* a broader-scope
rule would be a problem the resolver could not untangle. The framework forecloses
that by checking at **write time**, not run time. When a team-scope rule is being
added under a given `## Heading`, an admission gate compares the proposed text
against `org.md`'s same heading; if it finds a contradiction, the gate stops
the write and offers three choices — **revise**, **skip**, or **escalate** to the
org-rule owner. Project-tier writes check against org only, since team-versus-
project differences are legitimate project specialization, not a policy violation.

This check runs at the two admission gates the framework owns — the
practices-discovery affirmation gate and the learning gate (below) — so by the
time a rule reaches the resolver, it has already passed conflict-check. Two
read-only `/aidlc --doctor` rows surface state after the fact: a **rule-drift**
row flags headings where team or project content overlaps a populated org heading
(a candidate contradiction for a human to verify), and a **paired-coverage** row
reports how many rules name a sensor that actually resolves. Both are advisory and
never change the exit code. See
[Rule System § Rule-drift detection](../reference/08-rule-system.md#rule-drift-detection).

---

## Operating the learning loop

The other way a rule gets authored is that you never open a file — you correct an
agent during a workflow, confirm the correction at a gate, and the framework
writes it for you. That is the learning loop. Most stage runs add nothing, which
is healthy; the loop fires only when something during the stage is worth keeping.

The mechanics are covered in the
[User Guide chapter](../guide/09-rules-and-the-learning-loop.md). The
harness-engineer view is what the loop produces and where it lands:

1. **The diary records during the stage.** The conductor (the live `/aidlc`
   session running the active stage) keeps an observation
   log at `<record>/<phase>/<stage>/memory.md` (under the intent's record dir, `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`), with entries under four
   headings — Interpretations, Deviations, Tradeoffs, Open questions. It is
   auto-created and maintained for you; never hand-edit it. Writing the diary is
   the *only* job the language model has in this loop — everything after the stage
   (counting, surfacing, routing, writing) is deterministic tooling or your
   explicit pick at the gate.
2. **The gate surfaces candidates.** Before the approval gate the learning gate
   reads `memory.md` and shows each non-blank diary line verbatim as a candidate,
   plus a free-text "anything to add for next time?" channel where you type an
   observation and pick which of the four headings it belongs under.
3. **You confirm what to keep, and it writes.** A confirmed learning lands as a
   dated entry — you never pick a file path; the heading determines the
   destination.

### Where a kept learning lands

A confirmed learning *is* a practice: it lands in the same space memory files
practices-discovery affirms (`aidlc/spaces/<active-space>/memory/team.md` /
`memory/project.md`) — there is no separate `*-learnings.md` surface. The gate
routes it by topical heading:

| Heading at the gate | Lands in | Audit event |
|---|---|---|
| Interpretation / Deviation / Tradeoff | `aidlc/spaces/<active-space>/memory/project.md` (default) | `RULE_LEARNED` |
| same, promoted one click | `aidlc/spaces/<active-space>/memory/team.md` | `RULE_LEARNED` |
| Open question | nothing — research items don't promote | — |

The default scope is **project**, the narrowest. A one-click "promote to team"
affordance widens a learning to `memory/team.md` when the lesson applies
beyond this project. There is no widen-to-org path — org practices are framework-
shipped or organization-authored through a separate process, so the loop never
writes at org scope. Keeping the default narrow stops one project's surprise from
becoming an organization-wide rule by accident. The learning loop and
practices-discovery write into these same files by two different lifecycles: the
loop appends one dated entry at a time, practices-discovery affirms whole sections.
The resolver sorts the files on the clean integer chain org → team → project → phase.

### When the learning is a check, not a rule (`SENSOR_PROPOSED`)

Sometimes the thing worth keeping is a *recurring manual check* — you keep eyeing
a stage's output for the same gap. When you confirm that kind of learning at the
gate, the framework treats it as a sensor binding rather than a rule. It does a
two-write install atomically: it scaffolds a sensor manifest under
`.claude/sensors/` and appends the new sensor's id to the originating stage's
`sensors:` import list, leaving a `SENSOR_PROPOSED` audit row. That is the one
sanctioned edit to a stage file outside a framework release — only the import list
grows; the stage body is never touched. From there you flesh out the manifest by
hand using [Sensors](06-sensors.md) — the loop scaffolds the binding; you author
the check.

### Learnings apply on the next workflow, not the one in flight

A learning captured at a gate does **not** change the rules for the rest of the
current run. You already corrected the agent in conversation for this workflow;
the rule is for next time. The new line is on disk, but the in-flight workflow
keeps the compiled view it started with. The *next* `/aidlc` you run recompiles,
the directory walk picks up the new file, and the rule applies from stage one
onward.

This matters when you author by hand too: editing `team.md` mid-workflow
will not retroactively change the run in progress. Rules take effect at the next
compile boundary. If you need a change to bite immediately, finish or restart the
workflow so the compile re-reads your edit.

---

## Next

[Sensors](06-sensors.md) — author a deterministic check and bind it to the stages
that should run it, including the manifest the loop scaffolds when you confirm a
`SENSOR_PROPOSED` learning.
