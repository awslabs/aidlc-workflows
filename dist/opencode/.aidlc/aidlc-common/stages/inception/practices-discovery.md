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
mode: inline
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
inputs: <record>/aidlc-state.md + (brownfield) reverse-engineering's 8 artifacts
outputs: "team-practices.md, discovered-rules.md, evidence.md, practices-discovery-timestamp.md (4 artifacts under this stage's record dir, engine-resolved). On affirmation, content is promoted to the harness rule layer's aidlc-team.md and aidlc-project.md."
---

# Practices Discovery

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

This stage discovers how the team works — way of working, walking-skeleton stance, testing posture, deployment, code style — and at an affirmation gate promotes the affirmed content from per-workflow audit trail into team-authored harness config (`.aidlc/rules/aidlc-team.md` and `.aidlc/rules/aidlc-project.md`). This is the only stage that writes to both rows of the two-axis configuration model. The affirmation gate is what makes the cross-row write legitimate.

## Steps

### Step 1: Check Conditions

Read `<record>/aidlc-state.md` to determine project type:

- **Brownfield**: run Step 2 (multi-agent evidence scan) before the interview.
- **Greenfield**: skip Step 2; the interview asks all five practice areas using `aidlc-org.md` defaults as suggested answers.

Either way, Step 3 (interview) and Steps 4-7 always run.

### Step 2: Discover (Brownfield Only) — Parallel Multi-Agent Dispatch

The orchestrator issues four `Task` invocations in a single assistant message (parallel batch pattern, mirrors Construction parallel Bolt dispatch). Each agent is independent — no data flow between them, so sequential dispatch is unjustified. Each agent reads its own KB, scans evidence, returns a finding.

1. **aidlc-pipeline-deploy-agent** (lead) — Reads `.aidlc/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md`. Scans git history (branch names, merge patterns, lifetime), CI config, deployment cadence. Returns: branching strategy match, deployment frequency, environment topology.

2. **aidlc-quality-agent** — Reads its KB on testing methodology. Scans test framework choice, coverage tooling, CI gates, test/code ratios, recent test commits. Returns: testing posture (TDD vs after-the-fact), coverage floor, CI block-or-warn behaviour.

3. **aidlc-developer-agent** — Reads its KB on code patterns. Scans naming conventions, layer separation (handlers/services/repositories), error handling (Result<T,E> vs exceptions), file organisation. Returns: code-style rules, architectural boundaries.

4. **aidlc-devsecops-agent** — Reads its KB on CI/security. Scans linting config, SAST/DAST tooling, secret scanning, dependency-update automation. Returns: security posture, lint/format rules, supply-chain controls.

**Dispatch shape**: single assistant message with four `Task` calls. Subagent personas and KB load automatically — do NOT inject them manually. Pass `<record>/aidlc-state.md` and the relevant reverse-engineering artifacts as context. Collect all four findings before proceeding to Step 3.

### Step 3: Interview (Always)

Present structured questions to surface five practice areas, one per `aidlc-team.md` section heading: Way of Working, Walking Skeleton, Testing Posture, Deployment, Code Style.

**Brownfield**: ask only the gaps — questions whose answers Step 2's evidence couldn't determine (e.g. walking-skeleton stance is rarely visible in code; risk tolerance is a team judgement). Pre-fill option text from Step 2 findings where evidence was conclusive.

**Greenfield**: ask all five practice areas. Use `aidlc-org.md` section content as the source of suggested-answer text. `aidlc-org.md` and `aidlc-team.md` share the same Title Case heading set (`## Way of Working`, `## Walking Skeleton`, `## Testing Posture`, `## Deployment`, `## Code Style`) — read via `extractMarkdownSection` with the matching heading.

**Re-run pre-fill**: if `aidlc-team.md` already has affirmed content, read each section via `extractMarkdownSection(content, "## Way of Working")` etc. and present the existing text as the default option.

Log each question via `bun .aidlc/tools/aidlc-log.ts decision` BEFORE presenting it. Log each answer via `bun .aidlc/tools/aidlc-log.ts answer` after the user responds.

### Step 4: Consolidate

Write four artifacts to `<record>/inception/practices-discovery/`:

1. **team-practices.md** — descriptive, team voice. Five sections matching `aidlc-team.md` headings (`## Way of Working`, `## Walking Skeleton`, `## Testing Posture`, `## Deployment`, `## Code Style`). Each section is 1-3 sentences of plain prose synthesising Step 2 evidence + Step 3 answers.

2. **discovered-rules.md** — corrective, agent-facing. Two sections: `## Mandated` (rules with `ALWAYS …` format) and `## Forbidden` (rules with `NEVER …` format). One rule per line. Rules are derived from interview answers where the user expressed a hard constraint (e.g. "we never throw exceptions across service boundaries" → `NEVER throw exceptions across service-layer boundaries`).

3. **evidence.md** — per-agent finding summary. Records what was scanned, what was inferred, and what was asked. Provides a freshness-trail for re-runs.

4. **practices-discovery-timestamp.md** — single line: `Discovered: <ISO-8601 timestamp> at commit <hash>`. Used by future doctor checks for staleness.

After writing the four artifacts, emit `PRACTICES_DISCOVERED` via `bun .aidlc/tools/aidlc-state.ts practices-event --type discovered --field "Sources Scanned: <list>" --field "Drafts: team-practices.md, discovered-rules.md"` (the tool wraps the audit emission so events stay tool-owned per the audit-first invariant).

### Step 5: Affirmation Gate

Compliance with `stage-protocol.md` checklist:

1. `bun .aidlc/tools/aidlc-state.ts gate-start practices-discovery` BEFORE the affirmation question.
2. `bun .aidlc/tools/aidlc-log.ts decision` for the affirmation question.
3. A structured question presents `team-practices.md` and `discovered-rules.md` for review. Options:
   - **Approve** — promote affirmed content to `.aidlc/rules/aidlc-team.md` and `.aidlc/rules/aidlc-project.md` (Step 6).
   - **Edit-then-approve** — user revises the artifacts in `<record>/inception/practices-discovery/`, then re-enters this gate.
   - **Reject and rewrite** — discard the drafts, re-run Step 2 (if brownfield) or restart Step 3.
4. `bun .aidlc/tools/aidlc-log.ts answer` after the user answers.
5. `bun .aidlc/tools/aidlc-orchestrate.ts report --stage practices-discovery --result approved --user-input "<exact label>"` (or `bun .aidlc/tools/aidlc-state.ts reject practices-discovery --feedback "<text>"`) — auto-emits the gate-approved/gate-rejected audit events through the owning tools.

### Step 6: Promote (On Approve Only)

Cross-row promotion of affirmed content from per-workflow audit trail into team-authored harness config is delegated to a single tool subcommand. The orchestrator does NOT read or write the target files directly — `aidlc-state.ts practices-promote` does the read+splice+write atomically and emits `PRACTICES_AFFIRMED` on success or `PRACTICES_OVERRIDE` on failure. This keeps the cross-row writes deterministic and out of the LLM's judgment path.

Run:

```
bun .aidlc/tools/aidlc-state.ts practices-promote \
  --team-practices <record>/inception/practices-discovery/team-practices.md \
  --discovered-rules <record>/inception/practices-discovery/discovered-rules.md \
  --affirming-user "<user>"
```

The subcommand:

- Reads both drafts and both target files (`.aidlc/rules/aidlc-team.md` and `.aidlc/rules/aidlc-project.md`); fails closed before any write if any input is missing.
- For `aidlc-team.md`: applies `replaceSection` to each of the five sections (`## Way of Working`, `## Walking Skeleton`, `## Testing Posture`, `## Deployment`, `## Code Style`). Sections absent from the draft leave the live file's section untouched (useful for partial re-runs).
- For `aidlc-project.md`: parses rules from the draft's `## Mandated` and `## Forbidden` sections and applies `appendUnderHeading` for each, stamping `(affirmed YYYY-MM-DD)`. Append (not replace) is correct here because rules accumulate over runs.
- Writes `aidlc-project.md` first, `aidlc-team.md` second.
- Emits `PRACTICES_AFFIRMED` on success or `PRACTICES_OVERRIDE` on failure (with the failure reason as a field). On `PRACTICES_OVERRIDE` the subcommand exits non-zero — the orchestrator should treat that as a halt: do NOT proceed to Step 7's state update; the user re-enters the affirmation gate after addressing the failure.

### Step 7: Emit + Update State

After Step 6 succeeds (the subcommand prints `{"emitted":"PRACTICES_AFFIRMED",...}` and exits 0):

1. `PRACTICES_AFFIRMED` was already emitted by the Step 6 subcommand — do NOT re-emit it.
2. Update `Practices Affirmed Timestamp` in `<record>/aidlc-state.md` via `bun .aidlc/tools/aidlc-state.ts set "Practices Affirmed Timestamp=NOW"` (the `NOW` literal expands to the current ISO 8601 timestamp; the field is part of the v7 state template).
3. Mark practices-discovery as `[x]` completed in the INCEPTION phase block.

If Step 6 failed (`PRACTICES_OVERRIDE` was emitted by the subcommand and exit was non-zero), abort Step 7 entirely. Do NOT update the timestamp or mark the stage complete. The user re-enters the gate after addressing the failure.

Use the stage-protocol.md completion template:
- Announcement with completion summary
- Summary of all 4 artifacts produced + the two cross-row promotion targets
- Review path: `<record>/inception/practices-discovery/` AND `.aidlc/rules/aidlc-team.md` AND `.aidlc/rules/aidlc-project.md`
- Structured approval question with options: Approve (continue to Requirements Analysis) / Request Changes

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/practices-discovery/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. This stage declares no upstream artefacts; the sensor still runs but reports zero unreferenced inputs by default.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → `.aidlc/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.aidlc/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.aidlc/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
