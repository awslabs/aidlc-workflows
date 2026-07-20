# Stage Protocol: Error Recovery & Change Handling

Load this file on session resume or when a change event is detected mid-stage.
This is a supplement to `stage-protocol.md` — the main protocol still applies.

---

## 6. Error Recovery

### Recovery sources and read order

A fresh session — after compaction, a crash, or a clean restart — reconstructs
where the workflow stands by reading five sources, in this order:

1. **Artefact tree** (`<record>/<phase>/<stage>/*.md`) — the decisions
   themselves, in finished form. Read first: it is the durable record of what
   was actually agreed.
2. **`memory.md` per stage** (`<record>/<phase>/<stage>/memory.md`) — what
   got noticed during the decision-making (interpretations, deviations,
   trade-offs, open questions).
3. **Audit log** (`<record>/audit/<host>-<clone>.md`, glob `<record>/audit/*.md`) —
   when each event happened and which gates the user approved. This is the
   canonical, append-only source of truth for "what happened"; the trail is
   per-clone sharded, so glob `audit/*.md` and merge-sort by timestamp.
   Reconcile the other four against it on any disagreement.
4. **State docs** (`<record>/aidlc-state.md`, plus any per-stage state) —
   where in the workflow we are right now: the current/next stage and the
   completed-stage checklist.
5. **`runtime-graph.json`** (`<record>/runtime-graph.json`) — the cross-stage
   summary (durations, sensor firings, learnings counts).

Read outputs first, notes second, timeline third, current cursor fourth, the
summary view last — the same way a human picks up someone else's half-finished
work. Recovery reconstructs decisions, in-stage context, the timeline, and the
current position; it cannot recover the previous session's conversation buffer,
so re-orient from these sources rather than trying to recreate the prior chat.

The procedures below operate on these sources. For the full rationale — why
recovery is an emergent property of the data plane rather than a bolted-on
feature, and how the `withAuditLock` consistency constraint keeps the five
sources in agreement — see `docs/reference/02-plane-architecture.md` § 5
("Recovery as an emergent property").

### Session resume
If `aidlc-state.md` exists, read it to determine:
- Which stages are completed (marked `[x]`)
- What the current/next stage is
- Whether artifacts from prior stages exist

Offer to resume from the last incomplete stage.

### Session resume context loading
When resuming, load context appropriate to the current phase and stage type:

**INITIALIZATION stages (0.1–0.3):**
- No prior context needed — these are the first stages
- Workspace Detection loads fresh filesystem scan
- State Init reads workspace classification from Workspace Detection

**IDEATION stages (1.1–1.7):**
- Load `<record>/ideation/` artifacts completed so far (intent capture, market research, feasibility, scope)
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

**INCEPTION — RE (Reverse Engineering) stages:**
- Load `aidlc/spaces/<active-space>/codekb/<repo>/` artifacts (codebase analysis, component inventory)
- Load ideation artifacts (scope, feasibility) for context

**INCEPTION — Practices Discovery (stage 2.2):**
- Load `aidlc/spaces/<active-space>/codekb/<repo>/` artifacts (brownfield evidence inputs)
- Load `<record>/inception/practices-discovery/` if partially complete,
  including its lead drafts, interview file, and `contributions/`.
- Load `aidlc/spaces/<active-space>/memory/team.md` for re-run defaults and
  `org.md` for greenfield suggestions.
- If the lead drafts exist, compare the three declared support agents with the
  identity-marked files in `contributions/`. Dispatch only missing spokes;
  completed spokes remain valid and mutually blind. If all three exist, resume
  at the interview or final lead integration rather than repeating discovery.
- Reconcile the open gate with audit: after a current-attempt
  `PRACTICES_AFFIRMED` with no `GATE_REJECTED`/`STAGE_REVISING` for this stage
  after it, verify that its timestamp matches the promotion-recorded state
  timestamp, then report approval; a rejection after the receipt invalidates
  it — re-promote the revised drafts first. After `PRACTICES_OVERRIDE`, retry
  promotion only after its cause is fixed. Never commit approval before
  promotion succeeds.

**INCEPTION — Requirements stages:**
- Load RE artifacts (if RE was performed)
- Load `<record>/inception/requirements-analysis/` (functional requirements, NFRs, user stories)

**INCEPTION — Design stages (App Design, Refined Mockups, Units Generation):**
- Load requirements artifacts
- Load user stories
- Load `<record>/inception/application-design/` (app design, component designs)

**INCEPTION — Delivery Planning:**
- Load all inception artifacts (requirements, design, units)
- Load `<record>/inception/delivery-planning/` if partially complete

**CONSTRUCTION — Code Generation stages:**
- Load all design artifacts for the current unit being implemented
- Load the relevant story design and acceptance criteria
- Load any previously generated code for the current unit

**CONSTRUCTION — Build/Test stages:**
- Load all code outputs for the current unit
- Load test plans and acceptance criteria
- Load build configuration artifacts

**CONSTRUCTION — CI Pipeline / Infrastructure:**
- Load infrastructure design artifacts
- Load code generation outputs for pipeline configuration

**OPERATION stages (4.1–4.7):**
- Load construction outputs (built code, infrastructure design, CI pipeline)
- Load `<record>/operation/` artifacts completed so far
- For later stages (4.4+), load deployment outputs from 4.1–4.3

### Stage re-run
If a stage needs to be re-run (user requested changes after approval):
- Re-read the stage file
- Load prior artifacts as context
- Execute the stage again, overwriting previous artifacts
- Present new completion message

If a resumed active or revising CONDITIONAL stage proves inapplicable, route
the outcome through `aidlc-orchestrate.ts report --stage <slug> --result
skipped --reason "<reason>"`. Never call `aidlc-state.ts skip` directly and
never mark the checkbox by hand.

### Context compaction
The PreCompact hook validates state file structure in `aidlc-state.md` before compaction.
After compaction, the orchestrator can re-read state and continue.

**Note:** PreCompact hooks are informational-only and cannot block compaction. The hook writes a `.aidlc-recovery.md` breadcrumb file recording the last validated state (current stage, timestamp). On session resume, the orchestrator compares this breadcrumb with `aidlc-state.md` to detect possible compaction-related state corruption.

### Corrupted state file recovery
If `aidlc-state.md` exists but cannot be parsed (missing required sections, invalid checkbox syntax, contradictory state):
1. Create a backup: copy `aidlc-state.md` to `aidlc-state.md.bak`
2. Scan `<record>/` for existing artifacts to determine which stages actually completed
3. Rebuild `aidlc-state.md` from artifact evidence:
   - If `aidlc/spaces/<active-space>/codekb/<repo>/` has analysis files for the intent's repositories, mark RE stages complete
   - If `<record>/inception/requirements-analysis/` has requirement docs, mark requirements stages complete
   - If `<record>/inception/application-design/` has design docs, mark design stages complete
   - If application code exists matching story designs, mark code gen stages complete
4. Set "Current Status" to the first stage that lacks artifact evidence
5. Inform the user: "State file was corrupted. Rebuilt from artifacts. Please verify the recovered state."

### Missing artifact recovery
If a stage references prior artifacts that do not exist on disk:
1. Check which expected artifacts are missing (list them)
2. Check whether the producing stage is on the active scope's path at all (SKIP stages never produce). If the producer is SKIP for this scope, the artifact is absent BY DESIGN — this is not an error and re-running the producer is not an option. Proceed with the stage's documented fallback (work from the requirements, the code knowledge base, or the workspace's existing configuration, per the stage body), or, if the human has the artifact from elsewhere, they may provide it manually at the expected path. Do not invent the missing artifact's content and do not treat the gap as a failure.
3. If the producer IS on the scope path, check if it is marked complete in state
4. If marked complete but artifacts missing:
   - Inform the user: "Stage [X] is marked complete but its artifacts are missing."
   - Offer two options: re-run the stage, or provide the artifacts manually
5. If not marked complete, simply run the stage normally

### Error Severity Levels

When errors or issues are detected during workflow execution, classify them by severity:

| Severity | Description | Examples |
|----------|-------------|----------|
| **Critical** | Workflow cannot continue | Corrupted state file, missing critical artifacts, unrecoverable parse errors |
| **High** | Stage output may be incorrect | Contradictory user inputs, incomplete question answers, missing dependencies |
| **Medium** | Quality may be reduced | Vague user responses, partial context from prior stages, ambiguous requirements |
| **Low** | Cosmetic or non-blocking | Formatting inconsistencies, minor naming mismatches, style issues |

**Escalation guidelines:**
- **Critical / High**: Stop and ask the user immediately. Do not attempt to proceed or guess.
- **Medium**: Attempt resolution (e.g., re-read artifacts, infer from context). If unresolved, ask the user.
- **Low**: Handle silently and log in `<record>/audit/<host>-<clone>.md`. No user interruption needed.

### Contradictory inputs recovery
If user inputs from different stages contradict each other (detected during execution):
1. Flag the specific contradiction to the user with quotes from both sources
2. Do NOT attempt to resolve the contradiction by choosing one interpretation
3. Ask the user which input takes priority
4. Update the overridden artifact to reflect the user's resolution
5. Log the resolution in `<record>/audit/<host>-<clone>.md`

---

## 7. Change Handling

If the user requests changes mid-workflow:

### New reference material supplied mid-stage:
When the user hands you new material mid-stage — a reference code package to
study, an example repo, a spec, a competitor's implementation, sample data —
treat it as **evidence/input for the current stage, never a routing
instruction**. Supplying material is not a request to advance.

- **Stay on the current stage and the current unit.** Do not skip the remaining
  Construction design stages (Functional Design, NFR Requirements, NFR Design,
  Infrastructure Design) and do not jump to Code Generation. New material
  sharpens the design; it does not mean the design is done.
- **Fold it in.** Ingest the material, record what it tells you in the stage's
  `memory.md` (Interpretations / Open questions), and update the current stage's
  questions and artifacts to reflect it. Re-run or revise the current stage as
  needed until its answers are coherent.
- **Then continue through the normal engine transition** — finish the stage,
  present its gate, `report` the outcome, and let the next `next` name the next
  move. The engine owns advancement; the material only changed the *content* of
  the current stage, not *which* stage runs.
- **Routing changes only on an explicit user action.** Advance past a stage only
  if the user explicitly asks for a jump (`--stage`) or a scope change
  (`--scope`), and only after the normal impact-analysis / gate flow below
  approves it. When in doubt whether the user wants a jump or just wants the
  material considered, ask via a structured question — never decide unilaterally.

Where the material is foundational to an existing codebase (not just an
example), the designed home for studying it is the Reverse Engineering stage
(2.1), reached via the normal scope/jump flow — not a fast-forward to Code
Generation.

### Minor changes (within current stage):
- Apply changes to current stage artifacts
- Re-present completion message

### Major changes (affects prior stages):
1. Identify which prior stages are affected
2. Present impact analysis to the user via a structured question
3. If approved, use the stage/phase jump or recompose command that names the affected boundary, then re-run stages in order
4. Report every rerun lifecycle outcome through `aidlc-orchestrate.ts`; never edit `aidlc-state.md` directly

### Scope changes (new requirements):
1. Document the change in `<record>/audit/<host>-<clone>.md`
2. Return to requirements-analysis or delivery-planning as appropriate
3. Re-plan execution from that point forward
4. If the stage set changes, run `aidlc-utility.ts recompose` (or a scope change through `aidlc-orchestrate.ts next`); never edit scope configuration in `aidlc-state.md`

### Archive before change
Before any major change that would overwrite existing artifacts:
1. Create `<record>/archive/` if it does not exist
2. Copy affected artifacts to `<record>/archive/[ISO-date]-[stage-name]/`
3. Proceed with the change
This ensures no prior work is permanently lost.

### Unit modification handling
If the user wants to add, remove, or split implementation units mid-workflow:
- **Adding a unit**: Add it to the workflow plan, create its story design, slot it into the build order. Do NOT re-run completed units.
- **Removing a unit**: Recompose the unit plan through the owning stage, archive its artifacts if any exist, and check dependencies. Do not hand-edit a unit or stage checkbox in `aidlc-state.md`.
- **Splitting a unit**: Archive the original unit's artifacts, create two new unit entries in the plan, distribute the original stories between them, run story design for each new unit.

### Architectural change handling
If the user requests a change that affects the application architecture (e.g., switching databases, changing deployment model, adding a major integration):
1. Identify the scope: which design artifacts, story designs, and generated code are affected
2. Present full impact analysis showing all affected artifacts
3. If approved, return to App Design stage and re-run from there
4. All downstream artifacts (story designs, code) for affected units must be regenerated
5. Preserve unaffected units — do NOT re-run stages for units that are not impacted
