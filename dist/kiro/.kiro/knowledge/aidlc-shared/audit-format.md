# Audit Event Taxonomy

**Event names MUST match this table exactly.** Do not invent new event types. For stage completions, ALWAYS use `STAGE_COMPLETED` — do not substitute stage-specific names like "Requirements Analysis Complete" or "Code Generated".

> See [`docs/reference/12-state-machine.md`](../../../../docs/reference/12-state-machine.md) for the state transitions that emit each event. Events marked `✓` are MANDATORY and asserted by `tests/feature/t48-audit-event-emitters.sh`.

## Naming Convention

All event names follow `SUBJECT_PAST_VERB` — every event answers "what happened?"

## Event Registry (72 events, 19 categories)

### Workflow Lifecycle (4 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| ✓ `WORKFLOW_STARTED` | Scope determined, workflow begins | Timestamp, Scope, Request | `tools/aidlc-utility.ts intent-birth` |
| ✓ `WORKFLOW_COMPLETED` | All in-scope stages done | Timestamp, Scope, Details | `tools/aidlc-state.ts complete-workflow` |
| ✓ `WORKFLOW_PARKED` | Workflow parked mid-flow for a later session (no stage advanced) | Stage, Timestamp | `tools/aidlc-state.ts park` |
| ✓ `WORKFLOW_UNPARKED` | Park marker cleared on explicit `--resume` re-entry | Timestamp | `tools/aidlc-state.ts unpark` |

### Phase Lifecycle (4 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| ✓ `PHASE_STARTED` | Phase begins (first in-scope stage about to run) | Timestamp, Phase, Stage count, Scope | `tools/aidlc-utility.ts intent-birth` (Init phase), `tools/aidlc-state.ts advance` (phase boundary) |
| ✓ `PHASE_COMPLETED` | Crossed a phase boundary | Timestamp, From phase, To phase, Stages completed | `tools/aidlc-state.ts advance`, `tools/aidlc-state.ts complete-workflow` |
| `PHASE_VERIFIED` | Traceability check at boundary | Timestamp, Phase boundary, Pass/fail, Issues | `tools/aidlc-state.ts advance`, `tools/aidlc-state.ts complete-workflow` |
| `PHASE_SKIPPED` | Scope excludes phase | Timestamp, Phase, Scope, Reason | `tools/aidlc-utility.ts intent-birth` (per-phase scope eval) |

### Stage Lifecycle (6 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| ✓ `STAGE_STARTED` | Stage enters `[-]` Active | Timestamp, Stage, Agent | `tools/aidlc-state.ts advance`, `tools/aidlc-utility.ts intent-birth` (init stages) |
| `STAGE_AWAITING_APPROVAL` | Stage enters `[?]` (gate open) | Timestamp, Stage, Artifacts, optional `Recovered=true` (backfilled gate row) | `tools/aidlc-state.ts gate-start` (organic, or `--recovered` backfill), `tools/aidlc-state.ts revise` (gate re-entry), `tools/aidlc-state.ts reject` (backfill when gate-start was skipped), `tools/aidlc-state.ts approve` (backstop re-entry row after a backfilled revision) |
| `STAGE_REVISING` | Stage enters `[R]` (user rejected gate) | Timestamp, Stage, Revision count, Feedback, optional `Recovered=true` (backfilled by the approve-time revision backstop) | `tools/aidlc-state.ts reject`, `tools/aidlc-state.ts approve` (backstop backfill) |
| ✓ `STAGE_COMPLETED` | Stage finishes (`[x]`) | Timestamp, Stage, Details, Artifacts | `tools/aidlc-state.ts approve` (gated stages; also auto-advances to next), `tools/aidlc-state.ts advance` (non-gated stages), `tools/aidlc-utility.ts intent-birth` (init stages) |
| `STAGE_JUMPED` | Forward/backward/redo jump target reached | Timestamp, Direction, Source, Target, Scope | `tools/aidlc-jump.ts execute` |
| `STAGE_SKIPPED` | Stage skipped during jump (`[S]`) | Timestamp, Stage, Reason | `tools/aidlc-jump.ts execute`, `tools/aidlc-state.ts skip` |

### Session Events (5 events — hook-owned, independent of workflow lifecycle)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SESSION_STARTED` | Fresh Claude Code session begins (source=startup or clear) | Timestamp, Source | `hooks/aidlc-session-start.ts` |
| `SESSION_RESUMED` | Existing Claude Code session resumed (source=resume) | Timestamp, Source | `hooks/aidlc-session-start.ts` |
| `SESSION_COMPACTED` | Context compaction occurred | Timestamp, Current Stage, State Validity | `hooks/aidlc-validate-state.ts` (PreCompact) |
| `SESSION_ENDED` | Claude Code session terminates | Timestamp, Reason | `hooks/aidlc-session-end.ts` |
| `HUMAN_TURN` | A real human acted this turn: submitted a prompt or answered a question widget (the approval/interview gate requires one since the last gate resolution) | Timestamp | `hooks/aidlc-mint-presence.ts` (UserPromptSubmit + PostToolUse AskUserQuestion) + the per-harness prompt-submit adapters |

### Initialization Events (3 events — fire IN ADDITION TO `STAGE_COMPLETED`)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `WORKSPACE_SCAFFOLDED` | Directory tree created | Timestamp, Details | `tools/aidlc-utility.ts` handleInit |
| `WORKSPACE_SCANNED` | Workspace detection done | Timestamp, Project type, Details | `tools/aidlc-utility.ts` handleInit |
| `WORKSPACE_INITIALISED` | State file created | Timestamp, Details | `tools/aidlc-utility.ts` handleInit |

### Navigation Events (6 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SCOPE_CHANGED` | `--scope` changed existing scope | Timestamp, Old scope, New scope | `tools/aidlc-utility.ts` |
| `PLUGIN_SELECTION_CHANGED` | `select-plugins` changed enabled plugins | Timestamp, Previous Selection, New Selection | `tools/aidlc-utility.ts select-plugins` |
| `DEPTH_CHANGED` | `--depth` changed depth level | Timestamp, Old depth, New depth | `tools/aidlc-utility.ts` |
| `TEST_STRATEGY_CHANGED` | `--test-strategy` changed test strategy | Timestamp, Old strategy, New strategy | `tools/aidlc-utility.ts` |
| `SCOPE_DETECTED` | Auto-detected from freeform text | Timestamp, Detected scope, Input text, Source, Matched keywords (optional; present when `Source=keyword`) | `tools/aidlc-utility.ts detect-scope` |
| `RECOMPOSED` | The adaptive composer re-shaped a running workflow's pending stages (suffix flips via `recompose`) | Timestamp, Scope, Stages skipped, Stages added, Stages in Scope | `tools/aidlc-utility.ts recompose` |

### Interaction Events (4 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `DECISION_RECORDED` | Before presenting a structured question, to record the options shown | Timestamp, Stage, Decision, Options | `tools/aidlc-log.ts decision` |
| `GATE_APPROVED` | Human approved at gate | Timestamp, Stage, User Input | `tools/aidlc-state.ts approve` |
| `GATE_REJECTED` | Human requested changes | Timestamp, Stage, Feedback, optional `Recovered=true` (backfilled by the approve-time revision backstop) | `tools/aidlc-state.ts reject`, `tools/aidlc-state.ts approve` (backstop backfill) |
| `QUESTION_ANSWERED` | Question answered by user | Timestamp, Stage, Details | `tools/aidlc-log.ts answer` |

### Artifact Events (3 events — hook-emitted)

The artifact hook emits for writes in either the active intent's record tree or
the active space's shared `codekb/<repo>/` tree.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `ARTIFACT_CREATED` | New artifact written in the active intent record or space-level codekb tree | Timestamp, Tool, File, Context | `hooks/aidlc-audit-logger.ts` (PostToolUse; Write to net-new path) |
| `ARTIFACT_UPDATED` | Existing artifact modified in either tree | Timestamp, Tool, File, Context | `hooks/aidlc-audit-logger.ts` (PostToolUse; Edit, or Write overwriting existing) |
| `ARTIFACT_REUSED` | Re-use decision on backward jump | Timestamp, Stage, Decision, Artifacts | `tools/aidlc-state.ts reuse-artifact` |

### Subagent Events (1 event — hook-emitted)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SUBAGENT_COMPLETED` | Subagent task finishes | Timestamp, Agent Type, optional Agent ID, optional Message | `hooks/aidlc-log-subagent.ts` (SubagentStop) |

### Reviewer Scope Events (1 event — hook-emitted)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `REVIEWER_SCOPE_BLOCKED` | A per-unit reviewer's tool call was refused for reaching into sibling units' `construction/` paths (the §12a read-scope bound) | Timestamp, Tool, Target, Stage, Unit | `hooks/aidlc-reviewer-scope.ts` (PreToolUse) |

### Utility Events (1 event)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `HEALTH_CHECKED` | `--doctor` completed | Timestamp, Request, Details | `tools/aidlc-utility.ts handleDoctor` |

### Error/Recovery Events (2 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `ERROR_LOGGED` | Tool CLI exited non-zero via `error()` | Timestamp, Tool, Command, Error | `tools/aidlc-lib.ts emitError` (called by every tool's `error()` helper) |
| `RECOVERY_COMPLETED` | User answered the compaction-awareness prompt | Timestamp, Choice, Current Stage | `tools/aidlc-state.ts acknowledge-compaction` |

### Construction Bolt Events (4 events)

Emitted only during Phase 3 (Construction). A Bolt is one execution of stages 3.1–3.5 for a Unit or small group of dependency-linked Units. See `stage-protocol.md` Glossary.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `BOLT_STARTED` | Orchestrator begins a Bolt (or parallel batch of Bolts) | Timestamp, Bolt names, Batch number, Walking skeleton (true/false), optional Bolt slug (when --worktree) | `tools/aidlc-bolt.ts start` |
| `BOLT_COMPLETED` | All Bolts in the batch finished successfully | Timestamp, Bolt names, Batch number, optional Bolt slug (when --merge) | `tools/aidlc-bolt.ts complete` |
| `BOLT_FAILED` | A Bolt failed during code-generation, or was explicitly aborted by the user | Timestamp, Failed Bolt, Error summary, optional Bolt slug (halt-and-ask correlation surface read by `aidlc-worktree info --slug`), optional Reason (`aborted` for explicit abort), optional Succeeded siblings | `tools/aidlc-bolt.ts fail` and `tools/aidlc-bolt.ts abort` |
| `AUTONOMY_MODE_SET` | User answered the ladder prompt after the walking skeleton | Timestamp, Mode (`autonomous` or `gated`) | `tools/aidlc-bolt.ts set-autonomy` |

### Worktree (7 events)

Emitted during Phase 3 (Construction) when Bolts run inside per-Bolt git worktrees. Worktree primitive emits `WORKTREE_*`; state fork/merge subcommands emit `STATE_*`; audit fork/merge subcommands emit `AUDIT_*`.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `WORKTREE_CREATED` | Per-Bolt git worktree created from main on Bolt start | Timestamp, Bolt slug, Worktree path, Branch name, Base branch | `tools/aidlc-worktree.ts` (`create`) |
| `WORKTREE_MERGED` | Bolt's worktree merged back to main on gate approval | Timestamp, Bolt slug, Worktree path, Target branch, Strategy | `tools/aidlc-worktree.ts` (`merge`) |
| `WORKTREE_DISCARDED` | Aborted Bolt's worktree explicitly removed | Timestamp, Bolt slug, Worktree path, Reason | `tools/aidlc-worktree.ts` (`discard`) |
| `STATE_FORKED` | State file forked to worktree on Bolt start | Timestamp, Bolt slug, Worktree path, Source state hash, Target state hash | `tools/aidlc-state.ts` (`fork`) |
| `STATE_MERGED` | Worktree's state merged back to main state on gate approval | Timestamp, Bolt slug, Worktree path, Source state hash, Target state hash, Conflict resolution | `tools/aidlc-state.ts` (`merge`) |
| `AUDIT_FORKED` | Audit log forked to worktree on Bolt start (audit-of-intent — emit precedes the byte-copy) | Timestamp, Bolt slug, Source Audit Hash, Fork Boundary | `tools/aidlc-audit.ts` (`audit-fork`) |
| `AUDIT_MERGED` | Worktree's audit entries appended to main audit on gate approval; per-Bolt entry order preserved, cross-Bolt order reflects merge-completion order | Timestamp, Bolt slug, Entries Merged, Source Audit Hash, Fork Boundary | `tools/aidlc-audit.ts` (`audit-merge`) |

### Practices (4 events)

Emitted by the Inception stage `practices-discovery` and by the Construction orchestrator at runtime. The stage emits at the affirmation gate; the orchestrator emits at runtime via `--type empty` (fallback advisory) and `--type override` (discriminator-field for the bolt-plan-marker-conflict path).

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `PRACTICES_DISCOVERED` | Brownfield discovery dispatch + drafting completed; team-practices draft awaiting affirmation | Timestamp, sources scanned, drafts produced | `tools/aidlc-state.ts` `practices-event --type discovered` |
| `PRACTICES_AFFIRMED` | Team approved practices at the practices-discovery affirmation gate; content promoted to `.kiro/steering/aidlc-team.md` and `.kiro/steering/aidlc-project.md` | Timestamp, affirming user, sections written, mandated/forbidden rules appended | `tools/aidlc-state.ts` `practices-promote` |
| `PRACTICES_OVERRIDE` | Cross-row promotion failed during practices-discovery affirmation, OR walking-skeleton stance from `aidlc-team.md` overrode bolt-plan's marker for the current Bolt | Timestamp, Reason (discriminator); per-path field set: write-failure path emits Reason + Failure detail only (no Bolt fields); bolt-plan-marker-conflict path emits Reason + Bolt slug + Practices Stance + Bolt-Plan Marker. The two field sets do not overlap, so doctor filters by `Reason` and routes by either name family — `write-failure-*` for the affirmation promotion path, `bolt-plan-marker-conflict` for the orchestrator runtime path | `tools/aidlc-state.ts` `practices-promote` (write-failure path); `tools/aidlc-state.ts` `practices-event --type override` (bolt-plan-marker-conflict path — discriminator-field disambiguation, no separate event) |
| `PRACTICES_SECTION_EMPTY` | Orchestrator read a practices section that returned empty; falling back to org defaults (advisory-only) | Timestamp, Section name, Fallback source | `tools/aidlc-state.ts` `practices-event --type empty` |

### Merge Dispatch (3 events)

Emitted when Construction's Bolt-merge step calls aidlc-pipeline-deploy-agent via Task to determine the merge strategy from team practices prose. Emitted via the `aidlc-bolt dispatch-event` subcommand. The orchestrator brackets each aidlc-pipeline-deploy-agent dispatch — pre-call INVOKED, post-call RETURNED on successful parse, FALLBACK on timeout/malformed-YAML. Audit-of-intent semantic: INVOKED emits before the LLM Task call (no disk side-effect for the dispatch itself; reconciliation by slug + timestamp window). Doctor reconciles orphan INVOKED rows.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `MERGE_DISPATCH_INVOKED` | Orchestrator dispatched aidlc-pipeline-deploy-agent with current practices section + Bolt context | Timestamp, Bolt slug, Practices section excerpt | `tools/aidlc-bolt.ts` `dispatch-event --event MERGE_DISPATCH_INVOKED` |
| `MERGE_DISPATCH_RETURNED` | Agent returned parsed YAML with strategy, target branch, confidence, notes | Timestamp, Bolt slug, Strategy, Target branch, Confidence, Notes | `tools/aidlc-bolt.ts` `dispatch-event --event MERGE_DISPATCH_RETURNED` |
| `MERGE_DISPATCH_FALLBACK` | Agent timed out or returned malformed YAML; orchestrator fell back to org defaults — critical observability hook | Timestamp, Bolt slug, Fallback reason, Defaults applied | `tools/aidlc-bolt.ts` `dispatch-event --event MERGE_DISPATCH_FALLBACK` |

### Sensor Events (5 events)

Emitted by the deterministic-sensor system. The sensor dispatcher emits the four `SENSOR_*` events; the paired-coverage doctor row emits `GUARDRAIL_LOADED` with `Scope: all`, because doctor reads the full resolved guardrail set without an active stage (the per-workflow org → project → phase → stage scoping in the When-clause below describes the steady-state loader, not doctor's unscoped read). Coverage is environmental — every Inception/Construction/Operation stage that writes markdown emits at least one `SENSOR_FIRED` row from the registry-default sensors (`upstream-coverage`, `required-sections`); Construction/Operation TS/JS writes additionally emit `linter` and `type-check` rows. Advisory-only; the future ralph driver introduces blocking semantics for Construction-phase sensors.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SENSOR_FIRED` | Dispatcher invoked a sensor against a stage output (per PostToolUse Write/Edit match on the sensor's `matches` filter) | Timestamp, Fire id, Sensor ID, Stage slug, Output path | `tools/aidlc-sensor.ts` `fire` |
| `SENSOR_PASSED` | Sensor completed and reported no findings (also: tool-unavailable, script-error fall-through — see Note footnote) | Timestamp, Fire id, Sensor ID, Stage slug, Output path, Duration ms | `tools/aidlc-sensor.ts` `fire` |
| `SENSOR_FAILED` | Sensor completed and reported findings; detail file written at `aidlc-docs/.aidlc-sensors/<stage-slug>/<sensor-id>-<fire-id>.md` | Timestamp, Fire id, Sensor ID, Stage slug, Output path, Detail path, Findings count | `tools/aidlc-sensor.ts` `fire` |
| `SENSOR_BUDGET_OVERRIDE` | Sensor exceeded its configured cap (registry / binding / depth-derived per the three-layer cap model) and was terminated or skipped | Timestamp, Fire id, Sensor ID, Stage slug, Output path, Cap layer, Cap value, Observed value | `tools/aidlc-sensor.ts` `fire` |
| `GUARDRAIL_LOADED` | Guardrail loader resolved the scope-hierarchical guardrail set for the active workflow (org → project → phase → stage); doctor's paired-coverage check reads from this event | Timestamp, Scope, Path, Rule count | `tools/aidlc-utility.ts` |

> The `Note` field on `SENSOR_PASSED` is optional. It carries `tool-unavailable` when the per-sensor script's underlying binary isn't on PATH (advisory PASS, not failure), or `script-error: <reason>` for spawn-failure / non-zero exit / malformed JSON / detail-write failure paths. Pair correlation is via `Fire id` (echoed verbatim from `SENSOR_FIRED` to the terminal row); `Output path` alone does not disambiguate when the PostToolUse Write/Edit hook fires the same sensor + stage + path tuple multiple times within a stage.

> **Pair by `Fire id`, not by audit-row index.** The PostToolUse Write/Edit hook can fan out a single tool call to four parallel sensor fires (one per applicable sensor on the matching stage). Terminal rows interleave by spawn duration — a 200ms linter beats a 4s tsc — so `findAllEvents("SENSOR_FIRED")[i]` does NOT pair with `findAllEvents("SENSOR_PASSED")[i]` by index. Audit-walking consumers (the `sensor_firings[]` populator, doctor, designer) MUST match terminal rows to FIRED rows via the 8-hex `Fire id` correlator. The dispatcher emits `Fire id` on every row precisely so this pairing remains O(1) under arbitrary fan-out + interleave.

### Learning Loop (3 events)

Emitted by stage-protocol §13 (Learnings Ritual). The runtime-graph compile emits `MEMORY_EMPTY` when a just-approved stage's memory.md has zero non-blank entries under the four standard headings. The learning-gate tool emits `RULE_LEARNED` when the user keeps a surfaced or free-text learning (a learning IS a practice — it lands as a practice line under the routed heading in `{project,team}.md`) and `SENSOR_PROPOSED` when a learning installs a sensor binding (manifest + originating stage `sensors:` frontmatter). Doctor reads `MEMORY_EMPTY` rows over time to detect systematic diary-skipping across stages.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `MEMORY_EMPTY` | A stage approval triggered a runtime-graph compile and the stage's memory.md had zero non-blank entries under any of the four §13 headings | Timestamp, Stage | `tools/aidlc-runtime.ts compile` |
| `RULE_LEARNED` | The learning gate persisted a kept learning as a practice line under the routed heading in `{project,team}.md` | Timestamp, Stage, Candidate-ID, Destination, Heading, Source | `tools/aidlc-learnings.ts persist` |
| `SENSOR_PROPOSED` | The learning gate scaffolded a project-tier sensor manifest and bound it to the originating stage's `sensors:` frontmatter | Timestamp, Stage, Candidate-ID, Sensor ID, Manifest path, Matches, Destinations, Source | `tools/aidlc-learnings.ts persist` |

### Swarm (6 events)

All six swarm events emit from the swarm referee `aidlc-swarm.ts` — the deterministic verdict surface the conductor consults. The referee is stateless (no iteration counter): `prepare` forks the per-unit worktrees and emits `SWARM_STARTED` (and `SWARM_DEGRADED` when the conductor reports a loud downgrade); `finalize` re-verifies the conductor's claimed-converged set, serialised-merges the genuine passes, and emits the per-Unit pair (`SWARM_UNIT_CONVERGED` / `SWARM_UNIT_FAILED` — except a converged unit whose merge-back failed, which gets neither row until a finalize retry merges it), the per-failed-Unit baton row (`SWARM_BATON_RETURNED`), and the batch tally (`SWARM_COMPLETED`). The `check` subcommand emits nothing — it is an advisory verdict that informs the conductor's retry decision. The engine is read-only and the conductor never emits audit events, so the deterministic tool owns the whole swarm taxonomy. Because the loop and its cap live in the driver (the ultracode script's `for`-bound or the subagent floor's harness ceiling), not in the referee, the per-Unit rows carry no `Iterations` / `Cap value` fields — there is no counter to record.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SWARM_STARTED` | Swarm referee `prepare` forked a batch of dependency-linked Units | Timestamp, Batch number, Unit names, Concurrency cap | `tools/aidlc-swarm.ts` |
| `SWARM_UNIT_CONVERGED` | A swarm Unit re-verified green (and untampered) at the `finalize` gate AND its merge-back landed (a converged unit in `merge_failures` gets no row until a finalize retry merges it) | Timestamp, Batch number, Unit name | `tools/aidlc-swarm.ts` |
| `SWARM_UNIT_FAILED` | A swarm Unit failed the `finalize` re-verify (not claimed, claimed-but-red, or tampered) | Timestamp, Batch number, Unit name, Reason | `tools/aidlc-swarm.ts` |
<!-- Reason for a CLAIMED-but-red / tampered unit is always the tool's own verdict (`error`); for a DECLINED (unclaimed) unit it is the conductor's typed attribution via `finalize --reasons` (`unsatisfiable` / `budget-exhausted` / `cap-exhausted`, defaulting to `cap-exhausted`) — the tool records the conductor's knowledge call, it does not judge unsatisfiability itself (D-I). -->
| `SWARM_BATON_RETURNED` | A swarm Unit returned the baton to the conductor for orchestrator-mediated coordination | Timestamp, Batch number, Unit name, Reason | `tools/aidlc-swarm.ts` |
| `SWARM_COMPLETED` | All Units in the batch finished (converged or failed); batch closed | Timestamp, Batch number, Converged count, Failed count | `tools/aidlc-swarm.ts` |
| `SWARM_DEGRADED` | `AIDLC_USE_SWARM=1` was requested but the Workflow tool was unavailable, so the conductor ran the subagent floor (loud-degrade) | Timestamp, Batch number, Requested driver, Fallback driver | `tools/aidlc-swarm.ts` |

## Hook-Generated Format

Hooks that emit events use the same CLI as orchestrator-driven emissions: `bun .kiro/tools/aidlc-audit.ts append EVENT --field Key=Value`. Hook-emitted events are first-class taxonomy members (`ARTIFACT_CREATED`, `ARTIFACT_UPDATED`, `SUBAGENT_COMPLETED`, all `SESSION_*`) — there is no longer a separate "free-form hook entry" format. A hook with no active workflow in `cwd` is a no-op; session events only append to a workflow's audit.md when one exists.

## Format Standards

- All timestamps: ISO 8601 format (YYYY-MM-DDTHH:MM:SSZ)
- Generate fresh timestamp for EACH entry via `date -u +"%Y-%m-%dT%H:%M:%SZ"` (tools do this automatically)
- Append-only — NEVER modify or delete existing entries
- No sensitive data (credentials, PII, secrets)
- Human decisions recorded verbatim — NEVER summarize

## Entry Format

### Standard Format
```
## [Event Heading]
**Timestamp**: [ISO timestamp]
**Event**: [Event type from table above]
**Stage**: [Stage slug — optional, context-dependent]
**Details**: [Event-specific content]

---
```

### Error Format
```
## Error: [Brief Description]
**Timestamp**: [ISO timestamp]
**Severity**: [Critical/High/Medium/Low]
**Type**: [Parse error/Missing artifact/State corruption/Validation failure]
**Description**: [What went wrong]
**Resolution**: [Action taken]

---
```

### Recovery Format
```
## Recovery: [Brief Description]
**Timestamp**: [ISO timestamp]
**Issue**: [What triggered recovery]
**Steps**: [Numbered recovery actions]
**Outcome**: [Successful/Partial/Failed]

---
```
