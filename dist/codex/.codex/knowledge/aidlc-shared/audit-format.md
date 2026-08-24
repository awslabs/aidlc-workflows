# Audit Event Taxonomy

**Event names MUST match this table exactly.** Do not invent new event types. For stage completions, ALWAYS use `STAGE_COMPLETED` — do not substitute stage-specific names like "Requirements Analysis Complete" or "Code Generated".

Stage lifecycle is report-owned: the conductor requests gate, revision,
completion, and skip outcomes through `tools/aidlc-orchestrate.ts report`.
The state tool entries below are the engine's internal atomic emitters, not
commands a stage or conductor invokes directly.

> See [`docs/reference/12-state-machine.md`](../../../../docs/reference/12-state-machine.md) for the state transitions that emit each event. Events marked `✓` are MANDATORY and asserted by `tests/feature/t48-audit-event-emitters.sh`.

## Naming Convention

All event names follow `SUBJECT_PAST_VERB` — every event answers "what happened?"

## Emitter-Owned Fields

The structured renderer writes exactly one `Timestamp` and one `Event` line per
block; callers must not supply either field. For compatibility, the generic
`audit append --field Timestamp=...` form is still accepted, but its value is
intentionally ignored. Historical shards are not rewritten: readers that parse
whole files must split on `---` and use the first timestamp in each block, or
deduplicate timestamp fields produced by older versions.

## Event Registry (91 events, 22 categories)

### Workflow Lifecycle (4 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| ✓ `WORKFLOW_STARTED` | Scope determined, workflow begins | Timestamp, Scope, Request; optional Source Baseline (`sha256:<listing-hash>` or `unbindable`) | `tools/aidlc-utility.ts intent-create` |
| ✓ `WORKFLOW_COMPLETED` | All in-scope stages done | Timestamp, Scope, Details | `tools/aidlc-state.ts complete-workflow` |
| ✓ `WORKFLOW_PARKED` | Workflow parked mid-flow for a later session (no stage advanced) | Timestamp, Stage | `tools/aidlc-state.ts park` |
| ✓ `WORKFLOW_UNPARKED` | Park marker cleared on explicit `--resume` re-entry | Timestamp | `tools/aidlc-state.ts unpark` |

### Phase Lifecycle (4 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| ✓ `PHASE_STARTED` | Phase begins (first in-scope stage about to run) | Timestamp, Phase, Stage count, Scope | `tools/aidlc-utility.ts intent-create` (Init phase), `tools/aidlc-state.ts advance` (phase boundary) |
| ✓ `PHASE_COMPLETED` | Crossed a phase boundary | Timestamp, From phase, To phase, Stages completed | `tools/aidlc-state.ts advance`, `tools/aidlc-state.ts complete-workflow` |
| `PHASE_VERIFIED` | Traceability check at boundary | Timestamp, Phase boundary, Pass/fail, Issues | `tools/aidlc-state.ts advance`, `tools/aidlc-state.ts complete-workflow` |
| `PHASE_SKIPPED` | Scope excludes phase | Timestamp, Phase, Scope, Reason | `tools/aidlc-utility.ts intent-create` (per-phase scope eval) |

### Stage Lifecycle (6 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| ✓ `STAGE_STARTED` | Stage enters `[-]` Active | Timestamp, Stage, Agent; optional Source Baseline when the entered stage declares `workspace_requires` | `tools/aidlc-state.ts advance`, `tools/aidlc-utility.ts intent-create` (init stages) |
| `STAGE_AWAITING_APPROVAL` | Stage enters `[?]` (gate open) | Timestamp, Stage, Artifacts, optional `Recovered=true` (backfilled gate row) or `Revalidated=true` (an already-open gate consumed a blocking-sensor override); a blocking-sensor override also carries Blocking Sensor Override, Blocking Sensor IDs, optional Blocking Sensor Detail Paths, and Blocking Sensor Reasons. Its authorization is the preceding exact `DECISION_RECORDED` → `HUMAN_TURN` → `QUESTION_ANSWERED` pair. | `tools/aidlc-state.ts gate-start` (organic, `--recovered` backfill, or override revalidation), `tools/aidlc-state.ts revise` (gate re-entry), `tools/aidlc-state.ts approve` (backstop re-entry after its opening guards pass) |
| `STAGE_REVISING` | Stage enters `[R]` (user rejected gate) | Timestamp, Stage, Revision count, Feedback, optional `Recovered=true` (backfilled by the approve-time revision backstop) | `tools/aidlc-state.ts reject`, `tools/aidlc-state.ts approve` (backstop backfill) |
| ✓ `STAGE_COMPLETED` | Stage finishes (`[x]`) | Timestamp, Stage, Details, Artifacts | `tools/aidlc-state.ts approve` (gated stages; also auto-advances to next), `tools/aidlc-state.ts advance` (non-gated stages), `tools/aidlc-utility.ts intent-create` (init stages) |
| `STAGE_JUMPED` | Forward/backward/redo jump target reached | Timestamp, Direction, Source, Target, Scope; optional Source Baseline. Backward jumps also carry JSON arrays for Changed Upstream Artifacts, Invalidated Downstream Artifacts, and Invalidated Downstream Reviews | `tools/aidlc-jump.ts execute` |
| `STAGE_SKIPPED` | Current stage reports a justified skip, or a jump skips it (`[S]`) | Timestamp, Stage, Reason | `tools/aidlc-state.ts skip` (internally routed by `aidlc-orchestrate.ts report --result skipped`), `tools/aidlc-jump.ts execute` |

### Session Events (5 events — hook-owned, independent of workflow lifecycle)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SESSION_STARTED` | Fresh Claude Code session begins (source=startup or clear) | Timestamp, Source | `hooks/aidlc-session-start.ts` |
| `SESSION_RESUMED` | Existing Claude Code session resumed (source=resume) | Timestamp, Source | `hooks/aidlc-session-start.ts` |
| `SESSION_COMPACTED` | Context compaction occurred | Timestamp, Current Stage, State Validity | `hooks/aidlc-validate-state.ts` (PreCompact) |
| `SESSION_ENDED` | Claude Code session terminates | Timestamp, Reason | `hooks/aidlc-session-end.ts` |
| `HUMAN_TURN` | A supported prompt-submit or answered-widget seam was observed (the approval/interview gate requires one since the last gate resolution); omitted when the driver declares `AIDLC_UNATTENDED=1` | Timestamp | `hooks/aidlc-record-human-turn.ts` (UserPromptSubmit + PostToolUse AskUserQuestion) + the per-harness prompt-submit adapters |

`HUMAN_TURN` is chronological presence evidence, not authenticated decision
content. The `--user-input`, `--feedback`, and `--details` fields recorded by
authority-bearing tools are caller-supplied prose. A narrow defense-in-depth
tripwire rejects recognized explicit conductor/model self-attribution, but
unlabelled, paraphrased, localized, or otherwise unrecognized wording remains
indistinguishable from human-authored text. `AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1`
also disables that tripwire for deterministic recovery/tests. Audit shards are
operational evidence, not a tamper-proof human-authorship boundary.

### Initialization Events (3 events — fire IN ADDITION TO `STAGE_COMPLETED`)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `WORKSPACE_SCAFFOLDED` | Directory tree created | Timestamp, Details | `tools/aidlc-utility.ts` handleInit |
| `WORKSPACE_SCANNED` | Workspace detection done | Timestamp, Project type, Details | `tools/aidlc-utility.ts` handleInit |
| `WORKSPACE_INITIALISED` | State file created | Timestamp, Details | `tools/aidlc-utility.ts` handleInit |

### Navigation Events (7 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SCOPE_CHANGED` | `--scope` changed existing scope | Timestamp, Old scope, New scope | `tools/aidlc-utility.ts` |
| `PLUGIN_SELECTION_CHANGED` | `select-plugins` changed enabled plugins | Timestamp, Previous Selection, New Selection | `tools/aidlc-utility.ts select-plugins` |
| `DEPTH_CHANGED` | `--depth` changed depth level | Timestamp, Old depth, New depth | `tools/aidlc-utility.ts` |
| `TEST_STRATEGY_CHANGED` | `--test-strategy` changed test strategy | Timestamp, Old strategy, New strategy | `tools/aidlc-utility.ts` |
| `REVIEW_CLASS_CHANGED` | `--review` changed the per-run review override | Timestamp, Old Override, New Override | `tools/aidlc-utility.ts` |
| `SCOPE_DETECTED` | Auto-detected from freeform text | Timestamp, Detected scope, Input text, Source, Matched keywords (optional; present when `Source=keyword`) | `tools/aidlc-utility.ts detect-scope` |
| `RECOMPOSED` | The adaptive composer re-shaped a running workflow's pending stages (suffix flips via `recompose`) | Timestamp, Scope, Stages skipped, Stages added, Stages in Scope | `tools/aidlc-utility.ts recompose` |

### Interaction Events (10 events)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `DECISION_RECORDED` | Before presenting a non-gate structured question, to record the options shown. Consolidated-summary prompts also carry checkpoint identity | Timestamp, Stage, Decision, Options; optional Checkpoint, Questions File, Unit, Attempt Generation, Workflow | `tools/aidlc-log.ts decision` |
| `GATE_APPROVED` | Human approved at gate | Timestamp, Stage, User Input; optional Review Finding Dispositions (versioned JSON mapping every current New/Unresolved review finding to Accepted risk, keyed by review artifact, finding ID, and finding-content fingerprint), Unit, Gate Scope, Gate Stages, Attempt Generation (team Unit gates); Unit merge gates also carry Pinned OID, Strategy, Target branch | `tools/aidlc-state.ts approve`, `tools/aidlc-unit.ts gate` |
| `GATE_REJECTED` | Human requested changes | Timestamp, Stage, Feedback; optional Review Finding Dispositions (versioned JSON for findings the human explicitly rejected with an exact reason), `Recovered=true` (backfilled by the approve-time revision backstop), Prior Accepted Source Fingerprint (the prior attempt's validated final swarm aggregate; never a replacement completion baseline), Unit, Gate Scope, Gate Stages, Attempt Generation (team Unit gates); Unit merge gates also carry Pinned OID, Strategy, Target branch | `tools/aidlc-state.ts reject`, `tools/aidlc-state.ts approve` (backstop backfill), `tools/aidlc-unit.ts gate` |
| `QUESTION_ANSWERED` | Non-gate question answered by user | Timestamp, Stage, Details; optional Unit, Attempt Generation | `tools/aidlc-log.ts answer` |
| `SUMMARY_CONFIRMATION_RECORDED` | Consolidated-summary choice recorded after the matching prompt and a fresh human turn; reserved from the public audit CLI | Timestamp, Stage, Details, Checkpoint, Questions File, Questions SHA-256, Hash Scope (required on new receipts; legacy rows may omit it); optional Unit, Workflow | `tools/aidlc-log.ts answer --checkpoint summary-confirmation` |
| `PLAN_APPROVAL_RECORDED` | Provenance that Code Generation consumed a protected Plan Approval challenge/response receipt; this Markdown row is not authorization evidence | Timestamp, Stage, Details, Checkpoint, Plan Target, Intent, Directive Epoch, Run floor, Approval Fingerprint, Questions File, Questions SHA-256, Prompt SHA-256, Session | `tools/aidlc-log.ts answer --checkpoint plan-approval` |
| `REVIEW_REQUESTED` | Conductor dispatches the §12a reviewer sub-agent; reserved from the public audit CLI. Structurally malformed rows are non-authoritative and do not consume an ordinal | Timestamp, Stage, Reviewer, Iteration, Artifact Fingerprint (`sha256:<hex>` from one stable snapshot of the exact bytes dispatched for review), Review Appendix Artifact + Review Appendix Offset + Review Appendix Prior Digest (`none`, or `sha256:<hex>` pinning a pre-request terminal `## Review` section from its canonical heading) + Review Appendix Prior Length (exact pinned section byte count, excluding permitted leading blank separators), Review Challenge (`review:<32 lowercase hex>`) when the prior length is nonzero, optional Unit + Attempt Generation (authoritative-DAG per-unit claims), Source Fingerprint on `workspace_requires` stages, Unit Source Fingerprint (manifest bytes + claimed source listing) on per-unit `workspace_requires` stages, optional Retry (`pending-request`, accepted once after a modern binding exists), optional Upgrade (`legacy-request`, one bounded modernization of a valid field-light chain), optional Recovery (`stale-receipt`) plus Recovery Cause (`artifact`, `source`, or `artifact+source`) | `tools/aidlc-log.ts review` |
| `REVIEW_COMPLETED` | Reviewer verdict read; gates approval and is reserved from the public audit CLI. Malformed rows are ignored without consuming their pending request | Timestamp, Stage, Reviewer, Iteration, Verdict, Request Fingerprint (must match the request), Artifact Fingerprint (full stable snapshot including the validated appendix), Review Appendix Artifact + Review Appendix Offset + Review Appendix Prior Digest + Review Appendix Prior Length + conditional Review Challenge (must match the request; completion refuses an appendix that retains those pre-request bytes unchanged at the append boundary, and a replacement for a nonempty prior appendix must render the exact challenge), optional Unit + Attempt Generation (per-unit claims), Request Source Fingerprint + Source Fingerprint on `workspace_requires` stages (both use the Git-independent bounded filesystem identity and must equal the request-time source), plus Unit Source Fingerprint on per-unit `workspace_requires` receipts. Pre-2.6.69 receipts may carry Unit Source Binding Bypass (`true`) | `tools/aidlc-log.ts review --verdict` |
| `PIPELINE_LINK_COMPLETED` | A declared pipeline link returned in order; current-attempt receipts gate pipeline approval and are reserved from the public audit CLI | Timestamp, Stage, Link, Position (`k/N`), optional Repo (required by the protocol for multi-repo chains), optional Workflow (`single-stage:<slug>` for isolated runs) | `tools/aidlc-log.ts link` |

`Hash Scope: confirmed-content-v1` identifies the semantic questions-file digest
used by newly emitted receipts. It normalizes line endings, preserves the
original order of the preamble and confirmed sections, and trims trailing
whitespace from the resulting canonical content. It includes every visible
Q<n> section and each `Requested Changes Feedback` section, including follow-up
questions added after an assumption decision. Exactly one visible top-level
`Assumption Confirmation` section is valid only after the summary and is
excluded, along with its contents; a same-named pre-summary section remains part
of the confirmed digest. The excluded section's assumptions and answer are not
covered by the digest and remain subject to the stage's existing decision/answer
and sensor checks. Any other visible Markdown or
raw-HTML heading after the summary is invalid. Heading-like text in HTML
comments, code spans, fenced or indented code, and HTML attribute values is not
a section.
A receipt with no `Hash Scope` retains the legacy whole-file digest contract;
an in-flight legacy receipt therefore needs a fresh human confirmation to
create a scoped receipt before an allowed post-confirmation append can recover.
Any other scope is rejected.

Summary-confirmation authority comparisons preserve append order within one
audit shard. Across shards, different timestamps establish order; equal
timestamps are causally unordered. Completion fails closed when such a tie
could change the current attempt, selected receipt, or whether an artifact was
written after confirmation, and requires fresh evidence with a later timestamp.

### Unit Configuration and Lifecycle Events (7 events — unit-major Construction)

The interactive twin of the swarm's `SWARM_UNIT_*` ledger. `UNIT_COMPLETED` is
the completion receipt the engine's coverage walk prefers over bare artifact
existence once any receipt exists for the stage; the emitting verb verifies
the unit's required artifacts as regular files on disk before committing it.
`Run floor` is an exact boundary token (`<event>:<timestamp>#<ordinal>`), so
same-second attempts within one shard cannot reuse receipts. Equal-time
boundaries in different shards are causally unordered and use a deterministic
`AMBIGUOUS:<timestamp>#<digest>` floor; prior receipts cannot match it.
Unit-major stages key the floor to workflow/jump/rejection boundaries because
their work can precede their own `STAGE_STARTED`.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `UNIT_OWNERSHIP_SET` | Unit-major ownership mode is set before unit activity starts | Timestamp, Mode | `tools/aidlc-state.ts set-unit-ownership` |
| `UNIT_GATE_RHYTHM_SET` | Team-owned gate rhythm is set before unit activity starts | Timestamp, Rhythm | `tools/aidlc-state.ts set-unit-gate-rhythm` |
| `UNIT_STARTED` | A unit's work begins on an inline per-unit stage; refused while another unit of the stage is open | Timestamp, Stage, Unit, Run floor; optional Attempt Generation | `tools/aidlc-state.ts unit start` |
| `UNIT_PAUSED` | A unit stops before completion; the checkpoint carries why and what comes next | Timestamp, Stage, Unit, Run floor, Reason, Next Action; optional Attempt Generation | `tools/aidlc-state.ts unit pause` |
| `UNIT_RESUMED` | The paused unit is explicitly resumed (the engine hard-stops until this) | Timestamp, Stage, Unit, Run floor; optional Attempt Generation | `tools/aidlc-state.ts unit resume` |
| `UNIT_COMPLETED` | The unit's work is done AND its required artifacts are regular files on disk (verified at emit) | Timestamp, Stage, Unit, Run floor; optional Attempt Generation | `tools/aidlc-state.ts unit complete` |
| `UNIT_MERGED` | Main landed the pinned candidate content and folded this Unit's row; transported receipts now satisfy main's floors | Timestamp, Unit, Owner, Pinned OID, Merge commit OID, Attempt Generation | `tools/aidlc-state.ts fold-unit-merge` |

### Artifact Events (3 events — hook-emitted)

The artifact hook emits for writes in either the active intent's record tree or
the active space's shared `codekb/<repo>/` tree.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `ARTIFACT_CREATED` | New artifact written in the active intent record or space-level codekb tree | Timestamp, Tool, File, Context | `hooks/aidlc-write-audit-log.ts` (PostToolUse; Write to net-new path) |
| `ARTIFACT_UPDATED` | Existing artifact modified in either tree | Timestamp, Tool, File, Context | `hooks/aidlc-write-audit-log.ts` (PostToolUse; Edit, or Write overwriting existing) |
| `ARTIFACT_REUSED` | Re-use decision on backward jump or per-repo pipeline reuse evidence; only `Decision=keep` grants the pipeline exemption; reserved from the public audit CLI | Timestamp, Stage, Decision, Artifacts, optional Repo, optional Workflow (`single-stage:<slug>` for isolated freshness-bound reuse) | `tools/aidlc-state.ts reuse-artifact` |

### Subagent Events (1 event — hook-emitted)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SUBAGENT_COMPLETED` | Subagent task finishes | Timestamp, Agent Type, optional Agent ID, optional Message | `hooks/aidlc-log-subagent.ts` (SubagentStop) |

### Reviewer Enforcement Events (2 events - hook-emitted)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `REVIEWER_SCOPE_BLOCKED` | A per-unit reviewer's tool call was refused for reaching into sibling units' `construction/` paths (the §12a read-scope bound) | Timestamp, Tool, Target, Stage, Unit | `hooks/aidlc-reviewer-scope.ts` (PreToolUse) |
| `REVIEW_FREEZE_BLOCKED` | A file-tool or shell `produces[]` write was refused because it would invalidate a fresh READY review receipt before the gate (the §12a terminal-receipt ordering) | Timestamp, Tool, Target, Stage, optional Unit | `hooks/aidlc-review-freeze.ts` (PreToolUse) |

### Plan Approval Enforcement Events (1 event — hook-emitted)

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `PLAN_APPROVAL_BLOCKED` | A code-generation developer-agent dispatch or workspace mutation was refused because the active unit or zero-Unit stage target lacked a current, explicitly approved plan contract (stage Steps 2-3 must precede Step 4) | Timestamp, Tool, Target, Stage, Unit | `hooks/aidlc-plan-approval-guard.ts` (PreToolUse) |

### Documents (3 events)

The DocumentKB is a **space-level** store, so all three events land in the space-level audit shard (`spaces/<space>/intents/audit/`) even for an intent-scoped document — the intent UUID is recorded as a field rather than selecting the shard. This keeps one document's history in one place across an `associate`/`dissociate` scope change. These events are provenance, **not a backup**: deleting the whole `documentkb/` tree destroys the per-document records, so document ids, tombstones, and intent links do NOT survive it — the next `sync` re-indexes the surviving originals as brand-new rows. Only a lost `index.json` alone is recoverable (`sync` rebuilds it from the per-document `metadata.json` files).

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `DOCUMENT_INDEXED` | A customer document was indexed into the DocumentKB for the first time (from `onboard`, and from `sync`'s fresh-document branch) | Timestamp, Space, Document, Source, Digest, optional Intent | `tools/aidlc-knowledge.ts` |
| `DOCUMENT_UPDATED` | An indexed document's record changed — a new revision, a re-extraction, a move, a summary, or an intent association change (from `associate`, `dissociate`, `rebind`, `summarize`, `onboard`'s edited-row branch, `sync`'s moved/changed/retried branches, and the idempotent audit-repair pass) | Timestamp, Space, Document, Change, optional Intent | `tools/aidlc-knowledge.ts` |
| `DOCUMENT_REMOVED` | The original is gone; the row became a metadata-only tombstone and extracted content was deleted (from `sync`) | Timestamp, Space, Document, Last Path, Last Digest | `tools/aidlc-knowledge.ts` |

All three are written to the **space-level** shard (`intents/audit/`), not an intent's,
even when the document carries `related_intent_ids`. A document outlives any single
intent and `associate`/`dissociate` can move its scope, so filing its provenance under
the active intent would split one document's history across shards. An
`associate`/`dissociate` that changes nothing emits **no** event: a per-call event
would fill the ledger with non-changes and break reconstruction-from-the-ledger.

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

Emitted only during Phase 3 (Construction). See `stage-protocol.md` Terminology for Bolt as a sprint-like iteration whose intended Unit grouping is recorded during Delivery Planning (2.9), while runtime batching comes from the Unit dependency graph. `BOLT_STARTED` / `BOLT_COMPLETED` (and swarm-path `BOLT_FAILED`) are emitted from `aidlc-bolt.ts` on the swarm / worktree path; a default gated run does not record them. `AUTONOMY_MODE_SET` is emitted by `aidlc-bolt.ts set-autonomy` after the ladder on any walk, including a default gated run.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `BOLT_STARTED` | Swarm / worktree path only: `aidlc-bolt.ts start` for one Unit and its worktree. Not emitted on a default gated stage-major run. | Timestamp, Bolt names, Batch number, Walking skeleton (true/false), optional Bolt slug, Base commit, Base Source Listing (when `--worktree`; the listing is the content-addressed raw-aware source baseline propagated from worktree creation), and Attempt Generation (team Unit claim) | `tools/aidlc-bolt.ts start` |
| `BOLT_COMPLETED` | Swarm / worktree path only: `aidlc-bolt.ts complete` for that same Unit/worktree. Does **not** close the batch — `SWARM_COMPLETED` does. | Timestamp, Bolt names, Batch number, optional Bolt slug (when --merge), optional Attempt Generation (team Unit claim) | `tools/aidlc-bolt.ts complete` |
| `BOLT_FAILED` | A Bolt failed during code-generation, or was explicitly aborted by the user | Timestamp, Failed Bolt, Error summary, optional Bolt slug (halt-and-ask correlation surface read by `aidlc-worktree info --slug`), optional Reason (`aborted` for explicit abort), optional Succeeded siblings, optional Attempt Generation (team Unit claim) | `tools/aidlc-bolt.ts fail` and `tools/aidlc-bolt.ts abort` |
| `AUTONOMY_MODE_SET` | User answered the ladder prompt after the walking skeleton | Timestamp, Mode (`autonomous` or `gated`) | `tools/aidlc-bolt.ts set-autonomy` |

### Worktree (7 events)

Emitted during Phase 3 (Construction) when Bolts run inside per-Bolt git worktrees. Worktree primitive emits `WORKTREE_*`; state fork/merge subcommands emit `STATE_*`; audit fork/merge subcommands emit `AUDIT_*`.

`Worktree path` values are project-relative (`.aidlc/worktrees/bolt-<slug>`) in
new rows. Readers resolve them against the project root and remain compatible
with legacy absolute values.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `WORKTREE_CREATED` | Per-Bolt git worktree created from main on Bolt start | Timestamp, Bolt slug, project-relative Worktree path, Branch name, Base branch, Base commit, Base Source Listing (`sha256:<hash>` over the raw-aware source listing computed from the immutable base before the audit-first create), Repo (recorded selector or `-` for the workspace root), optional Intent record and Swarm Unit/Batch/Stage/Run floor provenance | `tools/aidlc-worktree.ts` (`create`) |
| `WORKTREE_MERGED` | Bolt's worktree merged back to main on gate approval | Timestamp, Bolt slug, Worktree path, Target branch, Strategy | `tools/aidlc-worktree.ts` (`merge`) |
| `WORKTREE_DISCARDED` | Aborted Bolt's worktree explicitly removed | Timestamp, Bolt slug, Worktree path, Reason | `tools/aidlc-worktree.ts` (`discard`) |
| `STATE_FORKED` | State file forked to worktree on Bolt start | Timestamp, Bolt slug, Worktree path, Source state hash, Target state hash, optional Attempt Generation (team Unit claim) | `tools/aidlc-state.ts` (`fork`) |
| `STATE_MERGED` | Worktree's state merged back to main state on gate approval | Timestamp, Bolt slug, Worktree path, Source state hash, Target state hash, Conflict resolution | `tools/aidlc-state.ts` (`merge`) |
| `AUDIT_FORKED` | Audit log forked to worktree on Bolt start (audit-of-intent — emit precedes the byte-copy) | Timestamp, Bolt slug, Source Audit Hash, Fork Boundary, optional Attempt Generation (team Unit claim) | `tools/aidlc-audit.ts` (`audit-fork`) |
| `AUDIT_MERGED` | Worktree's audit entries appended to main audit on gate approval; per-Bolt entry order preserved, cross-Bolt order reflects merge-completion order | Timestamp, Bolt slug, Entries Merged, Source Audit Hash, Fork Boundary, Fork Timestamp | `tools/aidlc-audit.ts` (`audit-merge`) |

### Practices (4 events)

Emitted by the Inception stage `practices-discovery` and by the Construction orchestrator at runtime. The stage emits at the affirmation gate; the orchestrator emits at runtime via `--type empty` (fallback advisory) and `--type override` (discriminator-field for the bolt-plan-marker-conflict path).

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `PRACTICES_DISCOVERED` | Greenfield or brownfield lead draft, three support contributions, human interview, and lead integration completed; drafts await affirmation | Timestamp, sources scanned, drafts produced | `tools/aidlc-state.ts` `practices-event --type discovered` |
| `PRACTICES_AFFIRMED` | Team approved practices at the practices-discovery affirmation gate; content promoted to `aidlc/spaces/<active-space>/memory/team.md` and `project.md` | Timestamp, affirming user, sections written, mandated/forbidden rules appended | `tools/aidlc-state.ts` `practices-promote` |
| `PRACTICES_OVERRIDE` | Cross-row promotion failed during practices-discovery affirmation, OR walking-skeleton stance from active-space `team.md` overrode bolt-plan's marker for the current Bolt | Timestamp, Reason (discriminator); per-path field set: write-failure path emits Reason + Failure detail only (no Bolt fields); bolt-plan-marker-conflict path emits Reason + Bolt slug + Practices Stance + Bolt-Plan Marker. The two field sets do not overlap, so doctor filters by `Reason` and routes by either name family — `write-failure-*` for the affirmation promotion path, `bolt-plan-marker-conflict` for the orchestrator runtime path | `tools/aidlc-state.ts` `practices-promote` (write-failure path); `tools/aidlc-state.ts` `practices-event --type override` (bolt-plan-marker-conflict path — discriminator-field disambiguation, no separate event) |
| `PRACTICES_SECTION_EMPTY` | Orchestrator read a practices section that returned empty; falling back to org defaults (advisory-only) | Timestamp, Section name, Fallback source | `tools/aidlc-state.ts` `practices-event --type empty` |

### Merge Dispatch (3 events)

Emitted when Construction's Bolt-merge step calls aidlc-pipeline-deploy-agent via Task to determine the merge strategy from team practices prose. Emitted via the `aidlc-bolt dispatch-event` subcommand. The orchestrator brackets each aidlc-pipeline-deploy-agent dispatch — pre-call INVOKED, post-call RETURNED on successful parse, FALLBACK on timeout/malformed-YAML. Audit-of-intent semantic: INVOKED emits before the LLM Task call (no disk side-effect for the dispatch itself; reconciliation by slug + timestamp window). Doctor reconciles orphan INVOKED rows.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `MERGE_DISPATCH_INVOKED` | Orchestrator dispatched aidlc-pipeline-deploy-agent with current practices section + Bolt context | Timestamp, Bolt slug, Practices section excerpt; optional Pinned OID + Attempt Generation + Pin Transaction for Unit merge gates | `tools/aidlc-bolt.ts` `dispatch-event --event MERGE_DISPATCH_INVOKED` |
| `MERGE_DISPATCH_RETURNED` | Agent returned parsed YAML with strategy, target branch, confidence, notes | Timestamp, Bolt slug, Strategy, Target branch, Confidence, Notes; optional Pinned OID + Attempt Generation + Pin Transaction | `tools/aidlc-bolt.ts` `dispatch-event --event MERGE_DISPATCH_RETURNED` |
| `MERGE_DISPATCH_FALLBACK` | Agent timed out or returned malformed YAML; orchestrator fell back to org defaults — critical observability hook | Timestamp, Bolt slug, Fallback reason, Defaults applied; optional Pinned OID + Attempt Generation + Pin Transaction | `tools/aidlc-bolt.ts` `dispatch-event --event MERGE_DISPATCH_FALLBACK` |

### Sensor Events (5 events)

Emitted by the deterministic-sensor system. The sensor dispatcher emits the four `SENSOR_*` events; the paired-coverage doctor row emits `GUARDRAIL_LOADED` with `Scope: all`, because doctor reads the full resolved guardrail set without an active stage (the per-workflow org → project → phase → stage scoping in the When-clause below describes the steady-state loader, not doctor's unscoped read). `fire_on: write` sensors run from the PostToolUse hook on matching writes; `fire_on: gate` sensors run once per existing declared deliverable before `gate-start` opens the first gate, `revise` re-enters it, or the approve-time revision backstop attempts recovered re-entry. Blocking severity is enforced only for gate-fired sensors in this release; write-fired failures remain advisory.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SENSOR_FIRED` | Dispatcher invoked a sensor against a stage output, from either a matching PostToolUse Write/Edit or gate-boundary deliverable dispatch | Timestamp, Fire id, Sensor ID, Stage slug, Output path | `tools/aidlc-sensor.ts` `fire` |
| `SENSOR_PASSED` | Sensor completed and reported no findings (also: tool-unavailable, script-error fall-through — see Note footnote) | Timestamp, Fire id, Sensor ID, Stage slug, Output path, Duration ms | `tools/aidlc-sensor.ts` `fire` |
| `SENSOR_FAILED` | Sensor completed and reported findings; detail file written at `<record>/.aidlc-sensors/<stage-slug>/<sensor-id>-<fire-id>.md` | Timestamp, Fire id, Sensor ID, Stage slug, Output path, Detail path, Findings count | `tools/aidlc-sensor.ts` `fire` |
| `SENSOR_BUDGET_OVERRIDE` | Sensor exceeded its configured cap (registry / binding / depth-derived per the three-layer cap model) and was terminated or skipped | Timestamp, Fire id, Sensor ID, Stage slug, Output path, Cap layer, Cap value, Observed value | `tools/aidlc-sensor.ts` `fire` |
| `GUARDRAIL_LOADED` | Guardrail loader resolved the scope-hierarchical guardrail set for the active workflow (org → project → phase → stage); doctor's paired-coverage check reads from this event | Timestamp, Scope, Path, Rule count | `tools/aidlc-utility.ts` |

> The `Note` field on `SENSOR_PASSED` is optional. It carries `tool-unavailable` when the per-sensor script's underlying binary isn't on PATH, or `script-error: <reason>` for spawn-failure / non-zero exit / malformed JSON / detail-write failure paths. Those remain advisory for write-fired sensors, but a blocking gate binding requires a verified pass, so any `Note`, dispatcher failure, malformed verdict, or budget override refuses gate entry. Pair correlation is via `Fire id` (echoed verbatim from `SENSOR_FIRED` to the terminal row); `Output path` alone does not disambiguate repeated write dispatches or a later gate dispatch of the same sensor + stage + path tuple.

> **Pair by `Fire id`, not by audit-row index.** Write dispatch can fan out one tool call across several sensors, while gate dispatch fans each gate-bound sensor across every existing deliverable. Terminal rows may interleave by spawn duration, so `findAllEvents("SENSOR_FIRED")[i]` does NOT pair with `findAllEvents("SENSOR_PASSED")[i]` by index. Audit-walking consumers (the `sensor_firings[]` populator, doctor, designer) MUST match terminal rows to FIRED rows via the 8-hex `Fire id` correlator.

### Learning Loop (3 events)

Emitted by stage-protocol §13 (Learnings Ritual). The runtime-graph compile emits `MEMORY_EMPTY` when a just-approved stage's memory.md has zero non-blank entries under the four standard headings. The learning-gate tool emits `RULE_LEARNED` when the user keeps a surfaced or free-text learning (a learning IS a practice — it lands as a practice line under the routed heading in `{project,team}.md`) and `SENSOR_PROPOSED` when a learning installs a sensor binding (manifest + originating stage `sensors:` frontmatter). Doctor reads `MEMORY_EMPTY` rows over time to detect systematic diary-skipping across stages.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `MEMORY_EMPTY` | A stage approval triggered a runtime-graph compile and the stage's memory.md had zero non-blank entries under any of the four §13 headings | Timestamp, Stage | `tools/aidlc-runtime.ts compile` |
| `RULE_LEARNED` | The learning gate persisted a kept learning as a practice line under the routed heading in `{project,team}.md` | Timestamp, Stage, Candidate-ID, Content-Hash, Destination, Heading, Source | `tools/aidlc-learnings.ts persist` |
| `SENSOR_PROPOSED` | The learning gate scaffolded a project-tier sensor manifest and bound it to the originating stage's `sensors:` frontmatter | Timestamp, Stage, Candidate-ID, Sensor ID, Manifest path, Matches, Destinations, Source | `tools/aidlc-learnings.ts persist` |

### Swarm (7 events)

Six events emit from the swarm referee `aidlc-swarm.ts` — the deterministic verdict surface the conductor consults — and `SWARM_SOURCE_MERGED` emits from `aidlc-worktree.ts` after application source lands in main. The referee is stateless (no iteration counter): `prepare` captures the exact stage-attempt token, stamps the Unit/Batch/Stage/Run floor into `WORKTREE_CREATED` plus worktree metadata, forks the per-unit worktrees, and emits `SWARM_STARTED` with both the prepared batch and the full attempt-bound Unit obligation set (and `SWARM_DEGRADED` when the conductor reports a loud downgrade); `finalize` requires that prepared token to still match the current attempt before merging, then preserves it on each convergence row. Completion compares the live authored DAG with that durable obligation set and refuses shrink or expansion until the DAG is restored or the stage attempt restarts. A worktree prepared by the immediately preceding unstamped release remains finalizable only when its frozen audit prefix proves the matching legacy `SWARM_STARTED`, `BOLT_STARTED`, `STATE_FORKED`, and `AUDIT_FORKED` sequence, the fork hash still matches, all three worktree mirrors exist, and the derived frozen attempt still equals the current attempt; this compatibility path never emits a backdated start or adopts a stale worktree. It re-verifies the conductor's claimed-converged set, snapshots the exact declared record artifacts plus the bound `source-manifest.json`, serialised-merges those records and AIDLC metadata for the genuine passes, and emits the per-Unit pair (`SWARM_UNIT_CONVERGED` / `SWARM_UNIT_FAILED` — except a converged unit whose record/metadata merge-back failed, which gets neither row until a finalize retry merges it), the per-failed-Unit baton row (`SWARM_BATON_RETURNED`), and the batch tally (`SWARM_COMPLETED`). Source merge then requires authority correlated to durable worktree provenance and the current Bolt/batch/stage attempt, links the main checkout from the stage-entry baseline or the prior attempt's validated final aggregate recorded on `GATE_REJECTED`, and emits `SWARM_SOURCE_MERGED`. Rejection never replaces the completion baseline. The opening link is revalidated against that trusted predecessor; later links must form an exact fingerprint chain. A pre-binding worktree whose convergence predates immutable source fields retains the historical branch merge; modern incomplete authority fails closed and does not advance batch routing. If Git mutation lands but `SWARM_SOURCE_MERGED` cannot be appended, the command preserves the worktree and reports a non-retryable `[merge-succeeded:<sha>]` failure: do not rerun the merge, because no authenticated recovery receipt exists; restart the stage attempt or use the explicit source-freshness off-switch only with human approval. If `SWARM_SOURCE_MERGED` did land and only subsequent worktree, branch, or retained-ref cleanup failed, rerunning the same merge performs cleanup-only reconciliation without reapplying source or duplicating authority. The `check` subcommand emits nothing — it is an advisory verdict that informs the conductor's retry decision. Because the loop and its cap live in the driver, the per-Unit rows carry no `Iterations` / `Cap value` fields.

| Event | When | Required Fields | Emitter |
|-------|------|-----------------|---------|
| `SWARM_STARTED` | Swarm referee `prepare` captured the exact attempt and forked a batch of dependency-linked Units | Timestamp, Batch number, Unit names, Unit obligations, Concurrency cap, Stage, Run floor | `tools/aidlc-swarm.ts` |
| `SWARM_UNIT_CONVERGED` | A swarm Unit re-verified green (and untampered), its exact declared record artifacts plus bound source manifest landed, and its AIDLC metadata merge-back landed; unless explicitly bypassed, finalize also verified the current global/unit source bindings and raw-aware base-to-worktree footprint against reviewed source-manifest claims | Timestamp, Batch number, Unit name, Stage, Run floor, optional Source Fingerprint and Source Commit (immutable reviewed source accepted by `aidlc-worktree merge`), or `Source Freshness Bypass: true` when finalize explicitly used `AIDLC_SKIP_SOURCE_FRESHNESS=1` (the freshness/unit/footprint guarantees do not apply and merge must repeat the switch) | `tools/aidlc-swarm.ts` |
| `SWARM_SOURCE_MERGED` | The immutable reviewed source for one current-attempt swarm Unit landed in main and extended the aggregate source chain | Timestamp, Batch number, Unit name, Stage, Run floor, Previous Source Fingerprint, Source Fingerprint, Source Commit, Merge commit, Repo (recorded selector or `-` for the workspace root) | `tools/aidlc-worktree.ts merge` |
| `SWARM_UNIT_FAILED` | A swarm Unit failed the `finalize` re-verify (not claimed, claimed-but-red, or tampered) | Timestamp, Batch number, Unit name, Reason | `tools/aidlc-swarm.ts` |
<!-- Reason for a CLAIMED-but-red / tampered unit is always the tool's own verdict (`error`); for a DECLINED (unclaimed) unit it is the conductor's typed attribution via `finalize --reasons` (`unsatisfiable` / `budget-exhausted` / `cap-exhausted`, defaulting to `cap-exhausted`) — the tool records the conductor's knowledge call, it does not judge unsatisfiability itself (D-I). -->
| `SWARM_BATON_RETURNED` | A swarm Unit returned the baton to the conductor for orchestrator-mediated coordination | Timestamp, Batch number, Unit name, Reason | `tools/aidlc-swarm.ts` |
| `SWARM_COMPLETED` | All Units in the batch finished (converged or failed); batch closed | Timestamp, Batch number, Converged count, Failed count | `tools/aidlc-swarm.ts` |
| `SWARM_DEGRADED` | `AIDLC_USE_SWARM=1` was requested but the Workflow tool was unavailable, so the conductor ran the subagent floor (loud-degrade) | Timestamp, Batch number, Requested driver, Fallback driver | `tools/aidlc-swarm.ts` |

## Hook-Generated Format

Hooks emit events through the same library emitter as orchestrator-driven emissions (`appendAuditEntry` from `tools/aidlc-audit.ts`). Hook-emitted events are first-class taxonomy members (`ARTIFACT_CREATED`, `ARTIFACT_UPDATED`, `SUBAGENT_COMPLETED`, all `SESSION_*`) — there is no longer a separate "free-form hook entry" format. A hook with no active workflow in `cwd` is a no-op; session events only append to a workflow's audit.md when one exists.

The public `aidlc-audit.ts append` CLI is a diagnostic escape hatch, not the canonical emit path: it refuses authority-bearing receipts (`STAGE_COMPLETED`, `HUMAN_TURN`, `GATE_APPROVED`, `GATE_REJECTED`, `QUESTION_ANSWERED`, `REVIEW_REQUESTED`, `REVIEW_COMPLETED`, `PIPELINE_LINK_COMPLETED`, `ARTIFACT_REUSED`, `SWARM_STARTED`, `SWARM_UNIT_CONVERGED`, `SWARM_SOURCE_MERGED`, `AUTONOMY_MODE_SET`, `UNIT_OWNERSHIP_SET`, `UNIT_GATE_RHYTHM_SET`, `UNIT_STARTED`, `UNIT_PAUSED`, `UNIT_RESUMED`, `UNIT_COMPLETED`, `UNIT_MERGED`, `DOCUMENT_INDEXED`, `DOCUMENT_UPDATED`, `DOCUMENT_REMOVED`), which only their owning tool or hook may emit. Field names must be printable single-line labels matching the audit field grammar; values have every line terminator escaped. `append-raw` likewise refuses a body carrying an `**Event**:` line naming a taxonomy event and refuses line-breaking headings.

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

## Validation basis on `STAGE_COMPLETED`

Main-workflow `STAGE_COMPLETED` entries may include a compact schema-3 receipt:

```text
**Validation Basis**: {"schema":3,"graphContract":"sha256:...","projectType":"brownfield","inputs":[{"artifact":"code-summary","producer":"code-generation","required":true,"instanceCount":12,"presentCount":12,"structureHash":"sha256:...","contentHash":"sha256:..."}],"outputs":[...]}
```

The resolver first computes the concrete runtime artifact-instance set using
the Bolt DAG, unit kinds, `produces_kinds`, and canonical filename aliases. The
receipt then stores deterministic stage-level aggregate fingerprints rather
than every Unit/path row. Optional inputs are included only when at least one
instance was present when completion was reported. This is a report-time
snapshot: it does not prove which bytes the stage actually read. "Observed"
dependency means recorded in this receipt, not runtime read instrumentation;
changes before capture become the baseline and changes after capture are
detectable.

If receipt capture is unavailable, the owning completion tool still appends a
receipt-less `STAGE_COMPLETED` with `Validation Warning`. That completion is
untracked and advisory rather than a reason to abort the state transition.

The latest receipt remains useful as dependency evidence after a stage is
reopened, while only a completion in the current attempt counts as current
tracking for the stage itself. Earlier schemas and receipt-less completions fail
open until the stage completes with this schema. Schema 2 is deliberately
untracked because it cannot distinguish its old zero-instance resolution from
the stage-level zero-Unit resolution introduced with schema 3.
