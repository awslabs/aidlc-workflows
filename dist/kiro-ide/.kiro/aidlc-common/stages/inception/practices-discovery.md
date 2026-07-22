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
  - workshop
inputs: <record>/aidlc-state.md + (brownfield) reverse-engineering evidence
outputs: "team-practices.md, discovered-rules.md, evidence.md, practices-discovery-timestamp.md, plus one contribution file per support agent. On affirmation, content is promoted to aidlc/spaces/<active-space>/memory/team.md and project.md."
---

# Practices Discovery

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

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
`## Contribution` and `## Positions` as defined by `stage-protocol.md` section
11. Collect all three files before the interview. Their presence and identity
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

Log every interview question with `aidlc-log.ts decision` before presenting it
and every interview answer with `aidlc-log.ts answer` after the response,
following the standard non-gate question flow.

### Step 5: Lead Integration

Delegate a final integration turn to `aidlc-pipeline-deploy-agent`. Pass the
lead draft paths, all three contribution paths, and the completed interview
file. The lead alone updates the four declared artifacts:

1. **team-practices.md** - five sections matching `memory/team.md`
   (`## Way of Working`, `## Walking Skeleton`, `## Testing Posture`,
   `## Deployment`, `## Code Style`), in team voice.
2. **discovered-rules.md** - `## Mandated` rules in `ALWAYS ...` form and
   `## Forbidden` rules in `NEVER ...` form, only for human-stated hard
   constraints.
3. **evidence.md** - what each participant inspected or inferred, the
   interview decisions, and any unresolved uncertainty.
4. **practices-discovery-timestamp.md** - one line:
   `Discovered: <ISO-8601 timestamp> at commit <hash>`.

After integration, emit `PRACTICES_DISCOVERED`:

```bash
bun .kiro/tools/aidlc-state.ts practices-event \
  --type discovered \
  --field "Sources Scanned: <list>" \
  --field "Drafts: team-practices.md, discovered-rules.md"
```

### Step 6: Learnings + Affirmation Gate

Run the section 13 learnings ritual, then:

1. Open the gate before the question:
   `bun .kiro/tools/aidlc-orchestrate.ts report --stage
   practices-discovery --result awaiting-approval`.
2. Do not log the affirmation gate with `aidlc-log.ts decision` or
   `aidlc-log.ts answer`; the lifecycle `report` calls own its audit events.
3. Present `team-practices.md` and `discovered-rules.md` with two options:
   **Approve** (promote, then continue to `directive.next_stage`) and
   **Request Changes**.
4. STOP and wait for the human response.
5. Carry the exact answer only into the matching `report` or promotion path
   below; never call `aidlc-log.ts answer` for this gate.
6. On Request Changes, report `--result rejected --user-input "<feedback>"`,
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
bun .kiro/tools/aidlc-state.ts practices-promote \
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
   `bun .kiro/tools/aidlc-orchestrate.ts report --stage
   practices-discovery --result approved --user-input "Approve"`.

Use the stage-protocol.md completion template:

- summarize all four artifacts, three contribution files, and both promotion
  targets;
- use `<record>/inception/practices-discovery/` as the review path;
- name the next stage from `directive.next_stage`.

## Sensors

This stage's declared outputs are markdown artifacts under
`<record>/inception/practices-discovery/`.

- **`required-sections`** checks the markdown shape of the declared outputs.
- **`upstream-coverage`** checks citation of the brownfield evidence paths that
  are present. Greenfield conditional inputs are absent by design.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** - choices made where the stage prose was ambiguous
- **Deviations** - places you intentionally departed from the stage prose, and why
- **Tradeoffs** - alternatives considered and why you picked what you did
- **Open questions** - anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z - <summary>; <context>`

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write through the
section 13 learning tool to:

- `aidlc/spaces/<active-space>/memory/project.md` by default, or `team.md` when
  the human promotes a team-wide practice;
- a new `.kiro/sensors/aidlc-<id>.md` manifest for a verification
  check, with its id added to the relevant stage's `sensors:` list.

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artifact directory as part of the stage's permanent record.
Stage bodies remain immutable framework artifacts.
