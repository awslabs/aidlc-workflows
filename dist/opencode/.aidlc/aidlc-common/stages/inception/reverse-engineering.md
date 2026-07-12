---
slug: reverse-engineering
phase: inception
execution: CONDITIONAL
condition: Execute when project is brownfield. Always rerun for freshness. Skip for greenfield projects.
lead_agent: aidlc-developer-agent
support_agents:
  - aidlc-architect-agent
mode: subagent
produces:
  - business-overview
  - architecture
  - code-structure
  - api-documentation
  - component-inventory
  - technology-stack
  - dependencies
  - code-quality-assessment
  - reverse-engineering-timestamp
consumes: []
requires_stage:
  - state-init
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - poc
  - bugfix
  - refactor
  - security-patch
  - workshop
inputs: <record>/aidlc-state.md
outputs: "aidlc/spaces/<active-space>/codekb/<repo>/ (9 artifacts: business-overview.md, architecture.md, code-structure.md, api-documentation.md, component-inventory.md, technology-stack.md, dependencies.md, code-quality-assessment.md, reverse-engineering-timestamp.md)"
---

# Reverse Engineering

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Check Conditions

Read `<record>/aidlc-state.md` to confirm:
- Project type is brownfield

If project is not brownfield, skip this stage and update aidlc-state.md with skip reason.

#### Resolve the intent's repo set (multi-repo)

This stage runs **per repo** the intent touches. Resolve the repo set from the
intent's registry row before scanning:

1. Read the active intent's `repos` array from
   `aidlc/spaces/<active-space>/intents/intents.json` (the row whose `uuid`/`slug`
   matches the active intent). This is the set captured at intent birth (an explicit
   `--repos a,b` or sibling auto-discovery).
2. **Single-repo / unrecorded:** if `repos` is absent, empty, or has exactly one
   entry, RE runs once against the lone repo — the same flow as before. (An
   unrecorded set means the workspace root is itself the single repo.)
3. **Multi-repo:** if `repos` has more than one entry, run Steps 2–3 **once per
   repo**, scanning that repo's sibling directory (`<workspace>/<repo>/`) and writing
   its 9 artifacts to the directory `codekb-path --repo <repo>` prints (the
   space-level `aidlc/spaces/<active-space>/codekb/<repo>/`; see Step 3). Each repo's codekb is independent;
   nothing in one repo's scan blocks another's, so the per-repo scans may run as
   parallel subagents.

In the steps below, `<repo>` is the repo currently being scanned; repeat for each
repo in the set.

### Step 2: Developer Code Scan

Delegate to Task tool with aidlc-developer-agent:
- subagent_type="aidlc-developer-agent"
- The agent persona and knowledge are loaded automatically. Do NOT manually inject the persona.
- Include workspace state from aidlc-state.md as context

Developer scans `<repo>`'s codebase (the sibling dir `<workspace>/<repo>/`; for a
single-repo intent this is the whole codebase) for:
- All packages, modules, and their purposes
- Build systems, configuration, and dependency relationships
- External and internal APIs (endpoints, contracts, methods)
- Frameworks, libraries, and their versions
- Test directories, test frameworks, coverage configuration
- Code quality indicators (linting, CI/CD, documentation)
- Technical debt signals

Developer returns structured scan results following the Developer Code Scan Template in `templates/re-artifacts.md`.

### Step 3: Architect Synthesis

Delegate to Task tool with aidlc-architect-agent:
- subagent_type="aidlc-architect-agent"
- The agent persona and knowledge are loaded automatically. Do NOT manually inject the persona.
- Pass the complete developer scan results as context
- Include workspace state from aidlc-state.md

Architect synthesizes scan results into 9 artifacts:
1. **business-overview.md** — Business domain, purpose, key functionality
2. **architecture.md** — System architecture, patterns, component relationships (with Mermaid diagrams). MUST include Interaction Diagrams section depicting how business transactions are implemented across components (sequence or flow diagrams).
3. **code-structure.md** — Package/module organization, file classification, code patterns
4. **api-documentation.md** — External and internal API surfaces, endpoints, contracts
5. **component-inventory.md** — Complete component list with responsibilities and dependencies
6. **technology-stack.md** — Languages, frameworks, libraries with versions
7. **dependencies.md** — External dependencies, internal cross-package dependencies
8. **code-quality-assessment.md** — Test coverage, linting, CI/CD, documentation quality, tech debt
9. **reverse-engineering-timestamp.md** — Records when reverse engineering was performed (date, commit hash if available, scope of analysis). This is the freshness/staleness marker for the per-repo codekb store — a stale timestamp triggers a rerun (see the `condition` frontmatter: "Always rerun for freshness").

**Resolve the write directory with the engine, do NOT compose the path yourself.**
Run the read-only tool

```
bun .aidlc/tools/aidlc-utility.ts codekb-path --repo <repo>
```

(omit `--repo` for a single/unrecorded repo — the engine resolves the repo name).
It prints ONE line: the exact directory, e.g. `aidlc/spaces/<active-space>/codekb/<repo>/`.
Write all 9 artifacts into the directory the tool printed — verbatim, creating it if
absent. This is the durable per-repo code knowledge base, a space-level store shared
across every intent in the space. Never substitute the intent slug, the record dir, or
a hand-composed path for what the tool prints.

### Step 4: Update State

Update `<record>/aidlc-state.md`:
- Mark Reverse Engineering as `[x]` completed
- Update current stage and next stage

### Step 5: Present Completion & Request Approval

Use stage-protocol.md completion template:
- Announcement with completion summary
- Summary of all 9 artifacts produced **per repo** (for a multi-repo intent, list
  each repo's `aidlc/spaces/<active-space>/codekb/<repo>/` set — the directory
  `codekb-path --repo <repo>` printed in Step 3)
- Review path: `aidlc/spaces/<active-space>/codekb/<repo>/` for each repo in the set
- Structured approval question with options: Approve (continue to Requirements Analysis) / Request Changes

## Sensors

This stage's outputs are markdown artefacts under `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` resolves).

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
