---
slug: practices-discovery
phase: inception
execution: CONDITIONAL
condition: Always rerun for freshness. Brownfield discovers from evidence + reverse-engineering artifacts. Greenfield prompts user via structured questions using org.md defaults.
lead_agent: aidlc-pipeline-deploy-agent
support_agents:
  - aidlc-quality-agent
  - aidlc-developer-agent
  - aidlc-devsecops-agent
mode: subagent
summary_confirmation: required
produces:
  - team-practices
  - discovered-rules
  - evidence
  - practices-discovery-timestamp
consumes:
  - artifact: code-structure
    required: false
    conditional_on: brownfield
  - artifact: technology-stack
    required: false
    conditional_on: brownfield
  - artifact: dependencies
    required: false
    conditional_on: brownfield
  - artifact: code-quality-assessment
    required: false
    conditional_on: brownfield
  - artifact: architecture
    required: false
    conditional_on: brownfield
  - artifact: business-overview
    required: false
    conditional_on: brownfield
requires_stage:
  - state-init
  - reverse-engineering
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - infra
  - classic
  - workshop
inputs: <record>/aidlc-state.md + (brownfield) reverse-engineering evidence
outputs: "team-practices.md, discovered-rules.md, evidence.md, practices-discovery-timestamp.md, plus one contribution file per support agent. On affirmation, content is promoted to aidlc/spaces/<active-space>/memory/team.md and project.md."
---

# Practices Discovery

This stage discovers how the team works: way of working, walking-skeleton
stance, testing posture, deployment, and code style. It is a hub-and-spoke
ensemble. The pipeline-deploy lead drafts; quality, developer, and devsecops
inspect the draft independently; the human resolves the practice choices; and
the lead integrates the result.

At the affirmation gate, a deterministic tool promotes the affirmed content
into the active space's `memory/team.md` and `memory/project.md`. Human approval
is not committed until that promotion succeeds.

## Steps

### Step 1: Check Conditions

Read `<record>/aidlc-state.md` to determine project type and active space:

- **Brownfield:** use available reverse-engineering artifacts and workspace
  configuration as evidence.
- **Greenfield:** use
  `aidlc/spaces/<active-space>/memory/org.md` as the default-practice source.

If `aidlc/spaces/<active-space>/memory/team.md` already contains affirmed
content, use it as re-run context for either project type. Steps 2-8 run for
both project types.

Do not skip this stage based on project type. Skip it only when the active
scope's compiled plan marks `practices-discovery` as `SKIP`.

### Step 2: Lead Draft (Always)

Delegate the first turn to `aidlc-pipeline-deploy-agent`. The lead loads its own
persona and knowledge; pass paths, not pasted persona prose.

- **Brownfield:** inspect git history, CI/deployment configuration, and the
  available reverse-engineering artifact paths. Infer branching strategy,
  deployment cadence, environment topology, and visible team conventions.
- **Greenfield:** read the five matching sections from
  `aidlc/spaces/<active-space>/memory/org.md` and treat them as suggested
  defaults, not established team facts.
- **Re-run:** read matching non-empty sections in
  `aidlc/spaces/<active-space>/memory/team.md` as the current affirmed baseline.

The lead writes an initial version of all four declared artifacts under
`<record>/inception/practices-discovery/`. The timestamp artifact remains a
draft until final integration. Only the lead edits these declared artifacts.

### Step 3: Blind Support Review (Always)

Dispatch all three support agents as one parallel batch when the harness
supports parallel delegation. Every brief contains only the stage path, the
lead draft paths, and relevant evidence paths. No brief or context may contain
a sibling's contribution: the spokes are mutually blind.

1. **aidlc-quality-agent** - assess testing posture, coverage tooling, CI
   quality gates, test/code patterns, and gaps the interview must resolve.
2. **aidlc-developer-agent** - assess naming, layer boundaries, error handling,
   file organization, and code-style conventions.
3. **aidlc-devsecops-agent** - assess lint/format rules, SAST/DAST, secret and
   dependency scanning, and supply-chain controls.

Each support agent writes:

`<record>/inception/practices-discovery/contributions/<agent-slug>.md`

The first line must be `**Collaborator:** <agent-slug>`, followed by
`## Contribution` and `## Positions` as defined by
`stage-protocol-ensemble.md` §11. Collect all three files before the interview. Their presence and identity
markers are deterministic completion evidence checked by the engine.

### Step 4: Interview (Always)

Create
`<record>/inception/practices-discovery/practices-discovery-questions.md` and
present structured questions for the five `memory/team.md` sections: Way of
Working, Walking Skeleton, Testing Posture, Deployment, and Code Style.

- **Brownfield:** ask only what the lead draft and independent reviews could
  not establish. Evidence can suggest an answer, but team intent remains a
  human judgment.
- **Greenfield:** ask all five areas, using the matching `memory/org.md`
  sections as suggested answers.
- **Re-run:** show the matching `memory/team.md` content as the default.

The `memory/*.md` sections you draw the suggested answers from are written for
this framework's own resolution rules, so they carry vocabulary the person
answering has no reason to know. Two obligations follow, and they apply to the
question text as much as to the options:

- **Ask in their words, not the section's.** A section's phrasing is an input to
  your question, never the question itself. "Walking Skeleton" is the name of a
  practice; "Should we build a thin end-to-end slice first?" is a question
  someone can answer. Drop the framework's process nouns from what you present.
- **Gloss a term of art the first time it appears, in the question itself.** A
  practice with a name the user may not share gets a single clause defining it,
  in the question line rather than tucked inside one option, so the definition is
  read before the choice is made. For the Walking Skeleton area, ask it as
  **"Build a thin end-to-end slice first? A walking skeleton is a minimal
  version that runs the whole way through, built first to prove the pieces
  connect before the real features go in."** and offer the yes/no choice
  beneath it. Later mentions need no gloss.

Log every interview question with `aidlc-log.ts decision` before presenting it
and every interview answer with `aidlc-log.ts answer` after the response,
following the standard non-gate question flow.

### Step 5: Lead Integration

Delegate a final integration turn to `aidlc-pipeline-deploy-agent`. Pass the
lead draft paths, all three contribution paths, and the completed interview
file. The lead alone updates the four declared artifacts:

1. **team-practices.md** - five sections matching `memory/team.md`
   (`## Way of Working`, `## Walking Skeleton`, `## Testing Posture`,
   `## Deployment`, `## Code Style`), in team voice. `## Testing Posture`
   MUST include:
   - `- **Methodology**: tdd | bdd | atdd | test-after | custom`
   - `- **Ordering**: <the affirmed ordering in one explicit sentence>`

   Use `custom` whenever the answer mixes cadences (for example, BDD scenarios
   before implementation with lower-level unit tests after implementation).
   Keep coverage, tooling, test-type, and scope notes as additional bullets;
   they do not replace the two structured fields.
2. **discovered-rules.md** - `## Mandated` rules in `ALWAYS ...` form and
   `## Forbidden` rules in `NEVER ...` form, only for human-stated hard
   constraints.
3. **evidence.md** - what each participant inspected or inferred, the
   interview decisions, and any unresolved uncertainty.
4. **practices-discovery-timestamp.md** - one line:
   `Discovered: <ISO-8601 timestamp> at commit <hash>`.

After integration, emit `PRACTICES_DISCOVERED`:

```bash
bun .claude/tools/aidlc-state.ts practices-event \
  --type discovered \
  --field "Sources Scanned: <list>" \
  --field "Drafts: team-practices.md, discovered-rules.md"
```

### Step 6: Learnings + Affirmation Gate

Run the section 13 learnings ritual, then:

1. Open the gate before the question:
   `bun .claude/tools/aidlc-orchestrate.ts report --stage
   practices-discovery --result awaiting-approval`.
2. Do not log the affirmation gate with `aidlc-log.ts decision` or
   `aidlc-log.ts answer`; the lifecycle `report` calls own its audit events.
3. Present `team-practices.md` and `discovered-rules.md` with two options:
   **Approve** (promote, then continue to the next stage) and
   **Request Changes**. Write the actual next stage name into the Approve
   option's description, read from the run-stage directive's `next_stage` field
   (`Complete workflow` when it is null); never show the field name to the user.
4. STOP and wait for the human response.
5. Carry the exact answer only into the matching `report` or promotion path
   below; never call `aidlc-log.ts answer` for this gate.
6. On Request Changes, report `--result rejected --user-input "Request Changes"
   --reason "<feedback>"`,
   revise through the lead (and re-run a support only when its evidence must be
   refreshed), then report `--result revised` before re-presenting the gate.
   A rejection invalidates any earlier promotion receipt: the engine refuses
   `approved` until Step 7's promotion re-runs after the rejection, so a later
   Approve must always re-promote the revised drafts.
7. On Approve, do not report `approved` yet. Continue to Step 7 in the same
   response turn.

### Step 7: Promote (On Approve Only)

The orchestrator does not edit active-space memory directly. Run:

```bash
bun .claude/tools/aidlc-state.ts practices-promote \
  --team-practices <record>/inception/practices-discovery/team-practices.md \
  --discovered-rules <record>/inception/practices-discovery/discovered-rules.md \
  --affirming-user "<user>"
```

The subcommand resolves the active space and:

- revalidates every declared support contribution and its identity marker
  before any memory write;
- reads both drafts and
  `aidlc/spaces/<active-space>/memory/{team,project}.md`;
- replaces the five matching sections in `team.md`;
- appends stamped hard constraints under `project.md`'s `## Mandated` and
  `## Forbidden`;
- writes `project.md` first and `team.md` second;
- emits `PRACTICES_AFFIRMED` and records `Practices Affirmed Timestamp` in
  state on success, or emits `PRACTICES_OVERRIDE` on failure.

If the command exits non-zero, halt. Do not report approval or advance. The
stage remains at its open gate until promotion succeeds.

### Step 8: Commit Approval

After Step 7 prints `{"emitted":"PRACTICES_AFFIRMED",...}` and exits 0:

1. Do not emit `PRACTICES_AFFIRMED` again.
2. Commit the held approval:
   `bun .claude/tools/aidlc-orchestrate.ts report --stage
   practices-discovery --result approved --user-input "Approve"`.

Use the stage-protocol.md completion template:

- summarize all four artifacts, three contribution files, and both promotion
  targets;
- use `<record>/inception/practices-discovery/` as the review path;
- name the next stage from `directive.next_stage`.

## Sensors

This stage's declared outputs are markdown artifacts under
`<record>/inception/practices-discovery/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `code-structure`, `technology-stack`, `dependencies`, `code-quality-assessment`, `architecture`, `business-overview`.

Brownfield upstream targets are conditional; inputs absent in a greenfield
workspace do not count as missing coverage.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
