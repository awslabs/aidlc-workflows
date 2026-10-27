# Learnings Protocol Module

Load this module when the directive lists `learnings` in `directive.protocol_modules`. It applies only while `directive.ceremony.learnings === "on"`.

## 13. Learnings Ritual

When this module is listed, every stage that reaches a human approval gate has the learnings step **between the completion message (section 2) and the approval gate (section 1)**. It asks the person something only after they corrected you in the stage (When to run, below); with no correction it asks nothing, and the stage goes from its completion message straight to its gate. The auto-proceeding bootstrap initialization stages and isolated `single: true` runs have no workflow approval gate and bypass this step; unfinished per-unit iterations defer it until the stage's one final gate. Per Fowler's harness model: "when issues recur, feedforward and feedback controls should be improved." This step is the human learning loop: a correction the person made, kept where the next runner will pick it up automatically.

The step is **tool-as-actor**: you read, in the person's own words, whether they corrected you and whether that would apply next time; a deterministic tool (`aidlc-learnings.ts`) prints the exact question and writes what they keep; you render the question and run the admission conflict-check; the person decides whether to keep it, and for the project or the team.

### What changes vs what doesn't

**Stage files are immutable framework artefacts.** The ritual NEVER edits a stage file's `## Steps`, `## Sensors`, or `## Learn` content. Stage files ship with framework releases; user-tier customisation lives in the harness. The one carve-out is the frontmatter `sensors:` import list — a sensor-binding addition appends a new id there (the pull-authoring two-write install). That is the import list, not body content; the stage's immutable shape is unchanged. Stage files are framework-and-loop-edited, not framework-only — but only that one frontmatter list grows.

**The harness IS mutable.** A confirmed learning IS a practice — it writes to one of two surfaces:

- `aidlc/spaces/<space>/memory/project.md` (default) or `aidlc/spaces/<space>/memory/team.md` — appended as a practice line under the fitting topical heading (e.g. `## Corrections`, `## Testing Posture`, `## Forbidden`), one click to widen a candidate from project to team. These are the SAME method files the resolver reads; there is no parallel `*-learnings.md` surface, no fractional override tier, and no org tier (no widen-to-org path). History of what was learned lives in the audit shards + the per-stage diary, not a rolling dated file.
- `{{HARNESS_DIR}}/sensors/aidlc-<id>.md` — for verification checks. A project-tier manifest with a `matches:` capability glob, bound to the originating stage by appending its id to that stage's `sensors:` frontmatter list.

Next time the stage runs, the resolved rules and the bound sensor load automatically at compile — the stage runs better without anyone having edited the stage file's body.

### When to run

The current directive controls applicability even if this module was loaded earlier in the session. When it is no longer listed, keep no diary and skip the step.

When this module is listed, the step comes after Step N-1 (completion message rendered) and before Step N (approval gate), only when the engine emits the stage's actual human gate. It asks the person something in two cases only; this is the one place that says when:

- **They corrected you in this stage, and it would apply next time.** They asked for changes at its gate (Request Changes), or corrected in their own words what you did or assumed while you worked, and the correction is a way of working that would hold next time (a convention, a rule for this project or team). A one-off fix (a typo, a wrong name, one value in one file) is not offered. Reading that is yours, from their own words, as you read any reply; no tool and no word list decides it. Each correction is asked about once.
- **They asked you to keep something for next time** ("next time, use the shared fixtures", "from now on, ..."). Keep it with no question, since they already said so (step 5), for the project unless they named the team. When they said it in their reply at the gate, with their approval, record the approval as their reply says and keep the note under this stage: `surface --slug <this stage>` takes it until another approval is recorded. Say in one line what you kept and where ("Kept for next time in this project's rules, `aidlc/spaces/<space>/memory/project.md`"), so they can move it to the team's rules or take it out.

Otherwise the step asks nothing: no question about your diary notes and no "Anything to add?". Go from the completion message straight to the gate.

A `gate: false` iteration does not run the step. Bootstrap initialization stages keep only the diary (step 1), with no question, admission, or persistence. Isolated `single: true` runs keep no diary and run none of this module. Per-unit `gate: false` iterations keep their diary and defer the step to the stage's final gate. Team-owned unit-major gates are the exception: run the step at each emitted `directive.unit_gate`, with the matching Unit identity, rather than waiting for the solo final stage gate. A human Construction checkpoint that lists `learnings` runs it once for the stages in `directive.construction_checkpoint.stages`, as the construction protocol's checkpoint procedure says; `surface --slug` takes the stage the correction was made in. A gate whose directive carries `approve_together` runs it once, the same way, for every stage in `approve_together.stages`, and logs the question under `directive.stage`. After a Request Changes, the change they asked for is a correction like any other: once the revision is made (and reviewed, when the directive carries a reviewer), ask about it before `report --result revised` re-presents the gate, unless it was a one-off fix or you already asked about it.

### The ritual

1. **Maintain a per-stage memory file as you work.** Append entries to `<record>/<phase>/<stage>/memory.md` (created by the engine from the shipped template when it emits the run-stage directive, only when the learnings ritual is on). Treat this path as an output-only target: the orchestrator never reads, probes, creates, or initializes it, and follows the active harness's diary-write discipline when inserting entries. Use four standard H2 headings:
   - **Interpretations** — choices made where the stage prose was ambiguous
   - **Deviations** — places where you intentionally departed from the stage prose, and why
   - **Tradeoffs** — alternatives considered and why you picked what you did
   - **Open questions** — anything to confirm before next run, or uncertain context worth flagging

   Each entry is a bullet under the appropriate heading with an ISO 8601 timestamp prefix (`{{INVOKE}} engine now` prints it):
   ```markdown
   - 2026-05-20T10:14:32Z — <one-line summary>; <2-3 sentences of context>
   ```

   In a Unit's turn at a per-Unit stage (the directive names `unit`), write `[unit <directive.unit>]` right after the timestamp, so the record says which Unit a note is about.

   The memory file persists across sessions — a stage that halts and resumes keeps its log intact. On stage approval, the memory file stays in the artefact directory as part of the stage's permanent record (committed alongside other artefacts).

   The diary is the stage's record: none of it is offered to the person. The step's questions come only from their corrections (step 2).

2. **Surface the corrections (the tool prints the questions).** Only when the step asks something, or keeps a note they asked you to keep (When to run), run:
   ```bash
   {{INVOKE}} engine learnings surface --slug <stage-slug> --correction '<their change>'
   ```
   with one `--correction` for each correction you will ask about, written so it follows "You asked me to", in their terms ("name test files after the module they test"), in single quotes as **Their words on a command line** (stage-protocol.md) says. A correction holding any of the characters it lists goes in a file instead: write it with your file tool to `<record>/.aidlc-engine/answer-text/correction-1.txt` (one file per correction) and pass `--correction-file .aidlc-engine/answer-text/correction-1.txt` in its place; the engine reads the file and removes it. It prints one question per correction in `questions`; with no `--correction` it prints none, which is the call for a note they asked you to keep. The output also carries `selections_file`, `space` and `intent`: the workspace's active space and intent resolved AT THIS MOMENT, not re-derived later. Carry both verbatim into the selections file in step 5; `persist` uses these, never the live active-intent cursor, so a later intent switch before persisting can't misattribute the write. Multiple intent records with no valid active-intent cursor is a hard failure here, not a silent `intent: null`.

3. **Ask the structured questions `surface` printed.** Its `questions` lists them in order with their exact options: for each correction, "You asked me to <their change>. Keep that for next time?" with **Yes, for this project**, **Yes, for the team** and **No**. Ask each as its own structured question with every option it lists, also when there is only one, and all in the same call where your tool takes several; never fold one into another. A question their reply already answered is not asked: log it and record that answer, as stage-protocol.md section 4 says for a question logged after the reply. Record each like any other structured question: run `{{INVOKE}} engine log decision --stage <stage-slug> --decision '<the question as printed>' --options '|Yes, for this project|Yes, for the team|No' --question-kind learnings-note` before showing it (a question holding a correction you put in a file goes in a file too: `--decision-file .aidlc-engine/answer-text/question-1.txt`), and `{{INVOKE}} engine log answer --stage <stage-slug> --details '<the option they picked>'` after; at a team-owned Unit gate add `--unit <that Unit>` to both. Do not infer or self-select their answer, and END YOUR TURN at the questions: the approval gate is a separate, later turn, never rendered in the same message. Never emit a one-option structured question: Claude Code and Codex reject it. Their pick is the only thing asked of them. You write the practice line from their correction and route it to the fitting practice heading in the method file (KNOWLEDGE): a testing learning -> `## Testing Posture`, a prohibition -> `## Forbidden`, anything general -> `## Corrections` (the default). The person never picks a heading or a diary heading; the tool ensure-exists the heading before it writes.

4. **Admission conflict-check (before any write).** For each kept learning candidate, compare the proposed practice line against `org.md`'s matching `## <section>` (matched by the routed heading — the single-line variant of the §5 admission gate). This comparison is a section-level LLM check (knowledge → orchestrator-LLM). If the practice contradicts an org guardrail, surface the conflicting org sentence inline; the user **revises, skips this candidate, or escalates** (judgement → user; there is no user-override path). Only conflict-clear or user-escalated selections proceed to the write. Sensor manifests have no org-section analogue and skip this check.

5. **Persist (the tool writes + emits audit).** Build the selections file — `{ stage_slug, space, intent, selections[] }`, where `stage_slug`/`space`/`intent` are carried verbatim from step 2's surface output — and write it with your file tool to the `selections_file` path that surface output names (a gitignored `.aidlc-engine/learnings/` folder: the record's, or with no intent record the space's intents folder's; one file per stage per piece of work). Then call:
   ```bash
   {{INVOKE}} engine learnings persist --slug <stage-slug> --selections-json <the selections_file surface returned>
   ```
   The selections are one entry for each correction they kept (`scope: "project"` for **Yes, for this project**, `"team"` for **Yes, for the team**; **No** keeps nothing) and one for each note they asked you to keep (`project` unless they named the team), each with `source: "user_addition"`: the words are theirs. A note they asked you to keep has no candidate of its own: give it `candidate_id` `n1`, `n2`, and so on.
   Each entry in `selections[]` identifies its candidate by `candidate_id`. The
   key `id`, which `surface` emits and step 3 correlates on, is accepted as an
   alias; an entry that carries both must give them the same value. A learning
   entry carries `type: "learning"` (the default when `type` is absent),
   `scope` (`project` by default, or `team`), the routed `heading`, and the
   practice `text`. A sensor entry carries `type: "sensor"`, `origin_stage`,
   and `manifest_fields` with `id`, `kind`, `command`, `default_severity`,
   `description` and `matches` as strings, plus optional `timeout_seconds`
   (number) and `category`. Either entry may carry an optional `source` field
   set to `"orchestrator"` (the default) or `"user_addition"`, which lands on
   the audit row. An entry with `keep: false` is a candidate the person did not
   keep and is left out. A malformed entry fails the whole call before the audit
   lock is taken, so nothing is half-written.

   The tool rejects a `--slug` that differs from the selections file's `stage_slug`, then verifies inside one `withAuditLock` transaction that the pinned space and non-null intent record still exist. It deduplicates against both the fresh audit snapshot and hashes emitted earlier in the same batch, using a `<!-- cid:<intent-slug>:<stage-slug>:<content-hash> -->` marker whose content hash is the full SHA-256 digest of the learning text. A crashed run therefore recovers without double-appending, while distinct learning text cannot share a truncated persisted identity:
   - **Learning** → appends a practice line under the orchestrator-routed heading in `<scope>.md` (scope ∈ {project, team}): `- <text> (learned YYYY-MM-DD) <!-- cid:... -->`; a field line the engine reads (`Methodology: tdd` or `Ordering: ...` under `## Testing Posture`, `Mode: strict` under `## Guard Policy` or the retired `## Change Control`) gets `<!-- learned YYYY-MM-DD -->` instead, so the date stays out of the value. Ensure-exists the heading first, so a routed heading the file doesn't yet carry is created rather than throwing. Emits `RULE_LEARNED` (with `Source: orchestrator | user_addition`, `Heading: <routed>`).
   - **Sensor** → scaffolds a project-tier `<project>/{{HARNESS_DIR}}/sensors/aidlc-<id>.md` manifest (with the user-supplied `matches:` glob) AND appends the new id to the originating stage's `sensors:` frontmatter list — both writes inside the same lock. Emits `SENSOR_PROPOSED`. The sensor binds and fires from the next workflow's compile.

   The orchestrator never `Edit`s a rule or sensor file directly — every learning write goes through the tool under the lock, so the `RULE_LEARNED` / `SENSOR_PROPOSED` audit row is the replayable source of truth for what was learned. The selections file is the replay artefact: a crashed persist replays the same selections-json without re-prompting the human.

6. **Proceed to the approval gate.** The step is advisory and additive: it never blocks the gate after the person answers. Run `report --result awaiting-approval` (after a Request Changes, `report --result revised`) and present the gate.

### Routing decision tree

```
Is it a correction they kept, or a note they asked you to keep?
└── Learning → a practice line under the routed heading in <scope>.md
    Heading routed by fit (testing → ## Testing Posture, prohibition →
      ## Forbidden, general → ## Corrections); ensure-exists before write.
    Scope derived from the user's keep + optional promote:
    ├── default                       — project.md
    └── promote scope (project→team)  — team.md   (no org tier)

Is the improvement a verification check?
└── Sensor (two-write install): scaffold a project-tier manifest at
    {{HARNESS_DIR}}/sensors/aidlc-<id>.md with a matches: glob, AND append its id to
    the originating stage's sensors: frontmatter list (one locked transaction).
    The matches: glob is a capability filter — stages: [<id>] is the binding.
```

### What goes where — quick reference

| What they said | Destination |
|---|---|
| Request Changes: "reuse the auth module, don't rewrite it", then **Yes, for this project** | `project.md ## Corrections` (practice line, `(learned YYYY-MM-DD)`) |
| A correction while you worked: "write the acceptance criteria as Given/When/Then", then **Yes, for the team** | `team.md ## Testing Posture` (practice line) |
| At the gate: "approve, and next time use TDD for the generators" (no question) | `project.md ## Testing Posture` (practice line) |
| Request Changes: "the title is Greeter, not Greeting" (a one-off fix) | Not asked about, nothing kept |
| Check: "ADRs should carry Security and Compliance headings" | Sensor manifest `aidlc-<id>.md` (`matches:` glob) bound to the stage via its `sensors:` frontmatter |

### Why stage files stay immutable

Two reasons: (1) framework upgrades to a stage file would conflict with workflow-time edits; (2) the same stage runs in many projects, so stage-file body mutations would mean every workflow drifts the framework's methodology in incompatible directions. The harness layer (rules, learnings, sensors) is designed to compose — many small additions accumulate without conflicts. Stage-file bodies are not. The sensor-binding frontmatter edit is the one sanctioned exception: it grows the `sensors:` import list (immutable in shape, not in contents), never the `## Steps` / `## Sensors` / `## Learn` body.
