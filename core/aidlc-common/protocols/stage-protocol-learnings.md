# Learnings Protocol Module

Load this module when the directive lists `learnings` in `directive.protocol_modules`. It applies only while `directive.ceremony.learnings === "on"`.

## 13. Learnings Ritual

MANDATORY when this module is listed: Every stage that reaches a human approval gate runs the learnings-capture step **between the completion message (§2) and the approval gate (§1)**. The auto-proceeding bootstrap initialization stages and isolated `single: true` runs have no workflow approval gate and bypass this ritual; unfinished per-unit iterations defer it until the stage's one final gate. Per Fowler's harness model: "when issues recur, feedforward and feedback controls should be improved." This ritual is the human learning loop — surface what's worth remembering, write it into the harness where the next runner will pick it up automatically.

The ritual is **tool-as-actor**: a deterministic tool (`aidlc-learnings.ts`) detects, surfaces, routes, and writes; the orchestrator-LLM renders the structured question and runs the admission conflict-check; the user decides keep / heading / scope. Detection, surfacing, routing, and writing are all deterministic; judgement is the user's.

### What changes vs what doesn't

**Stage files are immutable framework artefacts.** The ritual NEVER edits a stage file's `## Steps`, `## Sensors`, or `## Learn` content. Stage files ship with framework releases; user-tier customisation lives in the harness. The one carve-out is the frontmatter `sensors:` import list — a sensor-binding addition appends a new id there (the pull-authoring two-write install). That is the import list, not body content; the stage's immutable shape is unchanged. Stage files are framework-and-loop-edited, not framework-only — but only that one frontmatter list grows.

**The harness IS mutable.** A confirmed learning IS a practice — it writes to one of two surfaces:

- `aidlc/spaces/<space>/memory/project.md` (default) or `aidlc/spaces/<space>/memory/team.md` — appended as a practice line under the fitting topical heading (e.g. `## Corrections`, `## Testing Posture`, `## Forbidden`), one click to widen a candidate from project to team. These are the SAME method files the resolver reads; there is no parallel `*-learnings.md` surface, no fractional override tier, and no org tier (no widen-to-org path). History of what was learned lives in the audit shards + the per-stage diary, not a rolling dated file.
- `{{HARNESS_DIR}}/sensors/aidlc-<id>.md` — for verification checks. A project-tier manifest with a `matches:` capability glob, bound to the originating stage by appending its id to that stage's `sensors:` frontmatter list.

Next time the stage runs, the resolved rules and the bound sensor load automatically at compile — the stage runs better without anyone having edited the stage file's body.

### When to run

The current directive controls applicability even if this module was loaded earlier in the session. When it is no longer listed, keep no diary and skip the ritual.

When this module is listed, trigger after Step N-1 (completion message rendered) and before Step N (approval gate), only when the engine emits the stage's actual human gate. A `gate: false` iteration does not run the ritual. Bootstrap initialization stages keep only the diary (step 1), with no surfacing, question, admission, or persistence. Isolated `single: true` runs keep no diary and run none of this module. Per-unit `gate: false` iterations keep their diary and defer the ritual to the stage's final gate. Team-owned unit-major gates are the exception: run the ritual at each emitted `directive.unit_gate`, with the matching Unit identity, rather than waiting for the solo final stage gate. Gate revisions never rerun the ritual; re-present the approval gate directly.

### The ritual

1. **Maintain a per-stage memory file as you work.** Append entries to `<record>/<phase>/<stage>/memory.md` (created by the engine from the shipped template when it emits the run-stage directive). Treat this path as an output-only target: the orchestrator never reads, probes, creates, or initializes it, and follows the active harness's diary-write discipline when inserting entries. Use four standard H2 headings:
   - **Interpretations** — choices made where the stage prose was ambiguous
   - **Deviations** — places where you intentionally departed from the stage prose, and why
   - **Tradeoffs** — alternatives considered and why you picked what you did
   - **Open questions** — anything to confirm before next run, or uncertain context worth flagging

   Each entry is a bullet under the appropriate heading with an ISO 8601 timestamp prefix:
   ```markdown
   - 2026-05-20T10:14:32Z — <one-line summary>; <2-3 sentences of context>
   ```

   The memory file persists across sessions — a stage that halts and resumes keeps its log intact. On stage approval, the memory file stays in the artefact directory as part of the stage's permanent record (committed alongside other artefacts).

2. **Surface candidates (the tool reads memory.md).** Run:
   ```bash
   {{INVOKE}} engine learnings surface --slug <stage-slug>
   ```
   The tool parses memory.md and emits structured JSON: one candidate per non-blank entry under **Interpretations / Deviations / Tradeoffs** (surfaced verbatim — no paraphrase, no "interesting" filtering), plus a read-only `parked_open_questions[]` list. Open questions are research items, not learnings to install — they never become candidates. Most runs surface nothing worth keeping; that's the most common outcome. The output also carries `space` and `intent` — the workspace's active space/intent resolved AT THIS MOMENT, not re-derived later. Carry both verbatim into the selections file in step 5; `persist` uses these, never the live active-intent cursor, so a later intent switch before persisting can't misattribute the write. Multiple intent records with no valid active-intent cursor is a hard failure here, not a silent `intent: null`.

3. **Render the structured question + free-text channel.** For each candidate, render one option whose `label` is the candidate `summary` (verbatim) and whose `description` names the routed destination (e.g. `→ project.md ## Corrections`) plus a "promote to team?" affordance. After `multiSelect` returns, correlate each kept label back to its candidate `id` + `source_heading`. Then **always** ask the human "Anything to add for next time?" with at least two explicit choices: **Nothing to add** and **Add a note**. This question is mandatory even when `surface` returned zero candidates: do not infer or self-select **Nothing to add**, and END YOUR TURN at the question — the approval gate is a separate, later turn, never rendered in the same message. This is a structured question, so the §3 logging pair applies to it like any other: `aidlc-log.ts decision` before presenting it, `aidlc-log.ts answer` with the human's exact choice after — the resulting `QUESTION_ANSWERED` row preceding the gate's `STAGE_AWAITING_APPROVAL` is the auditable proof the ritual ran as its own human interaction. `Add a note` opens a free-text follow-up; a harness-provided Other/notes escape remains a direct free-text path. Never emit a one-option structured question — Claude Code and Codex reject it. For any non-empty response, ask the user to pick one of the four diary headings (Interpretation / Deviation / Tradeoff / Open question). **The diary-heading pick is the only classification asked of the user.** From it, the orchestrator routes the learning to the fitting practice heading in the method file (KNOWLEDGE): a testing learning → `## Testing Posture`, a prohibition → `## Forbidden`, anything general → `## Corrections` (the default). The user never picks the destination heading directly — the orchestrator routes by fit, and the tool ensure-exists the heading before it writes.

4. **Admission conflict-check (before any write).** For each kept learning candidate, compare the proposed practice line against `org.md`'s matching `## <section>` (matched by the routed heading — the single-line variant of the §5 admission gate). This comparison is a section-level LLM check (knowledge → orchestrator-LLM). If the practice contradicts an org guardrail, surface the conflicting org sentence inline; the user **revises, skips this candidate, or escalates** (judgement → user; there is no user-override path). Only conflict-clear or user-escalated selections proceed to the write. Sensor manifests have no org-section analogue and skip this check.

5. **Persist (the tool writes + emits audit).** Build the selections file — `{ stage_slug, space, intent, selections[] }`, where `space`/`intent` are carried verbatim from step 2's surface output — and call:
   ```bash
   {{INVOKE}} engine learnings persist --slug <stage-slug> --selections-json <path>
   ```
   The tool rejects a `--slug` that differs from the selections file's `stage_slug`, then verifies inside one `withAuditLock` transaction that the pinned space and non-null intent record still exist. It deduplicates against both the fresh audit snapshot and hashes emitted earlier in the same batch, using a `<!-- cid:<intent-slug>:<stage-slug>:<content-hash> -->` marker whose content hash is the full SHA-256 digest of the learning text. A crashed run therefore recovers without double-appending, while distinct learning text cannot share a truncated persisted identity:
   - **Learning** → appends a practice line under the orchestrator-routed heading in `<scope>.md` (scope ∈ {project, team}): `- <text> (learned YYYY-MM-DD) <!-- cid:... -->`. Ensure-exists the heading first, so a routed heading the file doesn't yet carry is created rather than throwing. Emits `RULE_LEARNED` (with `Source: orchestrator | user_addition`, `Heading: <routed>`).
   - **Sensor** → scaffolds a project-tier `<project>/{{HARNESS_DIR}}/sensors/aidlc-<id>.md` manifest (with the user-supplied `matches:` glob) AND appends the new id to the originating stage's `sensors:` frontmatter list — both writes inside the same lock. Emits `SENSOR_PROPOSED`. The sensor binds and fires from the next workflow's compile.

   The orchestrator never `Edit`s a rule or sensor file directly — every learning write goes through the tool under the lock, so the `RULE_LEARNED` / `SENSOR_PROPOSED` audit row is the replayable source of truth for what was learned. The selections file is the replay artefact: a crashed persist replays the same selections-json without re-prompting the human.

6. **Proceed to approval gate.** The ritual is advisory and additive — it never blocks the gate after the human responds. If the user skipped all candidates and explicitly chose **Nothing to add**, proceed directly; zero surfaced candidates alone is not permission to skip the mandatory question in step 3.

### Routing decision tree

```
Is the entry an Interpretation / Deviation / Tradeoff?
└── Learning → a practice line under the routed heading in <scope>.md
    Heading routed by fit (testing → ## Testing Posture, prohibition →
      ## Forbidden, general → ## Corrections); ensure-exists before write.
    Scope derived from the user's keep + optional promote:
    ├── default                       — project.md
    └── promote scope (project→team)  — team.md   (no org tier)

Is the entry an Open question?
└── Parked — research item, never installed.

Is the improvement a verification check?
└── Sensor (two-write install): scaffold a project-tier manifest at
    {{HARNESS_DIR}}/sensors/aidlc-<id>.md with a matches: glob, AND append its id to
    the originating stage's sensors: frontmatter list (one locked transaction).
    The matches: glob is a capability filter — stages: [<id>] is the binding.
```

### What goes where — quick reference

| Entry shape | Destination |
|---|---|
| Interpretation: "Reused the auth module rather than rewriting it" | `project.md ## Corrections` (practice line, `(learned YYYY-MM-DD)`) |
| Deviation: "Used Given/When/Then for AC despite freeform prose" | `project.md ## Testing Posture` (practice line); promote to `team.md` if team-wide |
| Tradeoff: "Picked TDD over BDD for the new generators this run" | `project.md ## Testing Posture` (practice line) |
| Open question: "Confirm whether story splitting is by persona or journey" | Parked — never installed |
| Check: "ADRs should carry Security and Compliance headings" | Sensor manifest `aidlc-<id>.md` (`matches:` glob) bound to the stage via its `sensors:` frontmatter |

### Why stage files stay immutable

Two reasons: (1) framework upgrades to a stage file would conflict with workflow-time edits; (2) the same stage runs in many projects, so stage-file body mutations would mean every workflow drifts the framework's methodology in incompatible directions. The harness layer (rules, learnings, sensors) is designed to compose — many small additions accumulate without conflicts. Stage-file bodies are not. The sensor-binding frontmatter edit is the one sanctioned exception: it grows the `sensors:` import list (immutable in shape, not in contents), never the `## Steps` / `## Sensors` / `## Learn` body.

