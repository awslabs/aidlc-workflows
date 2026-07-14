# Runtime Graph

> Audience: Tier 2/3 (team adopter, framework contributor).

This chapter documents the per-workflow `runtime-graph.json` artefact
introduced in v0.5.0 milestone 8 — the data-plane mirror of `stage-graph.json`,
materialised from the audit log on every approval gate. Cross-link to
[Plane Architecture](02-plane-architecture.md) (the control/data plane
separation that motivates this artefact) and
[State Machine](12-state-machine.md) (the lifecycle whose transitions
trigger compile).

---

## 1. What it is

`stage-graph.json` is structural truth — every stage definition, every
`requires_stage` / `produces` / `consumes` edge. It's stable across
workflow runs.

`runtime-graph.json` is execution truth — for the *current* workflow,
which stages have started, which have approved, what each stage's
memory.md looks like, what sensors fired. One file per workflow, lives
at `<record>/runtime-graph.json` — `<record>/` = the intent's record dir,
`aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`. Same node shape as
`stage-graph.json`, populated with telemetry instead of structure.

It exists so consumers (milestone 11's Bolt fork/merge, milestone 12's gate ritual,
milestone 14's doctor, v0.10.0's cross-workflow observer) read one
materialised view rather than re-walking the audit log on every query.

---

## 2. Schema

The TS interface below is the locked contract. Changing it requires
bumping every consumer in the same PR.

```ts
interface RuntimeGraph {
  workflow_id: string;            // ISO timestamp from LATEST WORKFLOW_STARTED audit row (so a re-birthed intent identifies the live workflow, not a dead one)
  scope: string;                  // from state.md "Scope" field
  started_at: string;             // ISO 8601, same row as workflow_id
  stages: RuntimeStage[];         // chronological order by started_at
  bolt_dag?: BoltDag;             // present only when units-generation's unit-of-work-dependency.md carries a valid (well-formed, acyclic) fenced edge block; absent/malformed/cyclic blocks omit the node
}

interface BoltDag {
  units: { name: string; depends_on: string[]; kind?: string }[]; // verbatim from the authored edge block; kind (service|spec|ui|packaging|library) present only when the edge block tags the unit
  batches: string[][];            // topological levels; each level = units whose deps are all satisfied by prior levels; level entries sorted lexicographically (deterministic)
}

interface RuntimeStage {
  stage_slug: string;
  started_at: string | null;      // ISO from STAGE_STARTED; null when `instances` is present
  completed_at: string | null;    // ISO from STAGE_COMPLETED; null when pending OR when `instances` is present
  agent: string | null;           // lead_agent; null when `instances` is present
  memory_path: string;            // <record>/<phase>/<stage>/memory.md (parent stage path even on instance-bearing rows)
  memory_entries: number | null;  // null = no memory.md file OR `instances` is present; else parseMemoryHeadings.total
  memory_breakdown: {             // null when memory_entries is null
    interpretations: number;
    deviations: number;
    tradeoffs: number;
    open_questions: number;
  } | null;
  sensor_firings: SensorFiring[]; // empty array in milestone 8 (sensors fire in milestone 9 + milestone 10)
  outcome: "approved" | "failed" | "pending";
  learnings_captured: {           // null on pending rows; populated on transition to approved
    from_orchestrator: number;    // zero in milestone 8 (gate ritual is milestone 12)
    from_user_addition: number;
  } | null;
  instances?: BoltInstance[];     // present only when stage runs per-Bolt; milestone 11 populates
}

interface BoltInstance {
  bolt: string;
  worktree: string;
  started_at: string;
  completed_at: string | null;
  memory_path: string;
  memory_entries: number | null;
  memory_breakdown: { interpretations: number; deviations: number; tradeoffs: number; open_questions: number; } | null;
  sensor_firings: SensorFiring[];
  outcome: "approved" | "failed" | "pending";
}

interface SensorFiring {
  id: string;
  fire_id: string;                // 8-hex correlator emitted by the milestone 9 dispatcher on every row
  result: "passed" | "failed" | "budget-override" | "incomplete"; // 4-state (milestone 12 Q10)
  ts: string;                     // FIRED row's timestamp
  detail_path?: string;
}
```

When `instances` is present, the stage-row's single-instance fields
(`started_at`, `completed_at`, `memory_entries`, `memory_breakdown`)
are NULL — those values sit on each instance instead. Stage-row
fields and instance-array fields never coexist.

### The Bolt/unit dependency DAG (`bolt_dag`)

The optional `bolt_dag` node is the machine-readable unit dependency
graph the engine reads to compute a parallel build batch — "the DAG is
the permission" for a swarm fan-out. Its source is the **fenced
`yaml` `units:` edge block** that units-generation (2.7) authors on
`unit-of-work-dependency.md`, beside the human-readable prose:

```yaml
units:
  - name: auth
    kind: service
    depends_on: []
  - name: api
    depends_on: [auth]
```

Each unit may carry an optional `kind` (`service | spec | ui | packaging |
library`), what the unit IS. It rides verbatim into `bolt_dag.units[].kind`
and drives the per-unit construction design pruning (see
[Stage definition](15-stage-definition.md) `produces_kinds`): a stage's produces
artifacts are filtered to the ones that apply to each unit's kind. An untagged
unit carries no `kind` key and keeps the full design-artifact matrix. An invalid
kind value makes the whole block `malformed` (see below), so a typo fails loud at
the 2.7 gate rather than pruning wrong.

`compile` parses *that structured block* — a pure-data parse, no model
call — into `units` (verbatim edges) and `batches` (topological
levels). Each batch is the set of units whose dependencies are all
satisfied by earlier batches, so a batch's units have no mutual
dependency and can run in parallel. Level entries are sorted
lexicographically before emission, so the node is deterministic
regardless of authored order.

The node is **omitted entirely** when the artifact is absent, or when
its edge block is absent, malformed (duplicate name, dangling or
self-dependency, unparseable), or cyclic — `compile` writes a stderr
diagnostic naming the reason and leaves `bolt_dag` off the envelope
rather than emit a wrong-but-valid DAG. Those failures are surfaced
upstream at the 2.7 gate by the `required-sections` sensor, which
validates the same block and reports `edge_block: ok | absent |
malformed | cyclic`. Authoring the edges as structured data (knowledge
work, once, behind the 2.7 approval gate) is what keeps the hook-fired
`compile` byte-identical on re-run: no model sits in the compile path. The orchestrate engine self-heals per-unit iteration on the read side, recomputing batches from unit-of-work-dependency.md when the node is absent; the graph file itself is only repaired by the next compile.

---

## 3. Compile lifecycle

The compile is invoked by the PostToolUse Bash hook
(`.claude/hooks/aidlc-runtime-compile.ts`) on every transition-class
audit emit. The hook fires on every `Bash` tool call from the
conductor and filters cheaply:

1. **Command filter** — only `bun .claude/tools/aidlc-(state|jump|bolt|utility).ts`
   invocations get past the early exit. `aidlc-runtime.ts` is excluded
   (recursion guard); `aidlc-log.ts` emits only chatty in-stage events;
   `aidlc-worktree.ts` emits only WORKTREE_* events.
2. **Audit-existence guard** — exit if the intent's `audit/` shard doesn't exist yet.
3. **Heartbeat** — write `<record>/.aidlc-hooks-health/runtime-compile.last`
   for doctor's silent-hook detection.
4. **Last-3-block tail-read** — split `audit.md` on `\n---\n`, take the
   last 3 entries.
5. **Event-class filter** — match
   `**Event**: (GATE_APPROVED|STAGE_STARTED|STAGE_AWAITING_APPROVAL|AUDIT_MERGED|WORKFLOW_COMPLETED)`
   against any of the 3 blocks. Exit on no match.
6. **Dispatch** — `spawnSync("bun", [".claude/tools/aidlc-runtime.ts", "compile", ...])`.

`WORKFLOW_COMPLETED` is in the transition set so the final-stage
approve fires the compile. `handleCompleteWorkflow` at
`aidlc-state.ts:575-593` emits 4 audit rows — STAGE_COMPLETED +
PHASE_COMPLETED + PHASE_VERIFIED + WORKFLOW_COMPLETED — and the last 3
of those are `PHASE_COMPLETED + PHASE_VERIFIED + WORKFLOW_COMPLETED`.
(On the approve path the STAGE_COMPLETED is suppressed because approve
already emitted it, and a `GATE_APPROVED` precedes the run — so a
final-stage approve appends 5 rows in one Bash call either way.)
Without `WORKFLOW_COMPLETED` in the regex, the runtime-graph would
never record the final stage as approved.

The compile itself walks the full audit log (so the result is
event-sourced, not transition-incremental), pairs `STAGE_STARTED` with
the next `STAGE_COMPLETED` for the same slug, reads each stage's
memory.md via `parseMemoryHeadings()` from `aidlc-lib.ts`, and writes
the artefact atomically via `writeFileAtomic` inside `withAuditLock`.

---

## 4. Outcome enum and chronological pairing

Three outcome values: `"approved" | "failed" | "pending"`.

- **approved** — `STAGE_STARTED@T1` paired with a later
  `STAGE_COMPLETED@T2`. The row's `completed_at` is `T2`.
- **pending** — `STAGE_STARTED@T1` with no later `STAGE_COMPLETED`
  for that slug. The row's `completed_at` is `null`.
- **failed** — emitted by the parent-stage rollup of `instances[]`
  only (single-instance stages stay `"approved" | "pending"`). When a
  Construction stage's `instances[]` is non-empty, the parent's
  `outcome` is the rollup of its instances: all approved → `approved`;
  any failed → `failed`; otherwise (any pending, no failures) →
  `pending`. Single-instance stages do not emit `failed` because the
  underlying `BOLT_FAILED` event has no Construction-stage scope
  outside the instances-bearing path.

Re-jump handling: `/aidlc --stage <slug>` re-emits `STAGE_STARTED` for
an already-completed slug. The audit log carries
`STAGE_STARTED@T1, STAGE_COMPLETED@T2, STAGE_STARTED@T3`. Pairing rule
matches `STARTED@T1` with `COMPLETED@T2` → would yield approved, but
the LATEST `STAGE_STARTED` for the slug supersedes any earlier row —
one row per slug, latest STARTED wins. So the result is a pending row
with `started_at: T3, completed_at: null`.

Single-stage exclusion: a `--single` stage-runner run commits its
`STAGE_STARTED`/`STAGE_COMPLETED` pair under a synthetic
`**Workflow**: single-stage:<slug>` id (audit-only; see
`aidlc-orchestrate.ts` `handleSingleReport`). The pairing skips any
`STAGE_*` row whose `Workflow` field starts with `single-stage:` —
those rows belong to no main workflow, so they never create or
complete a row in the main `runtime-graph.json` (and therefore never
inflate `summary` counts). Main-workflow `STAGE_*` rows carry no
`Workflow` field; absence means the row is kept. The same exclusion
applies to `aidlc-state.ts`'s `hasStageAuditEvent` dedup check, so a
single run's `STAGE_COMPLETED` cannot suppress the main workflow's own
completion emission for the same slug.

---

## 5. MEMORY_EMPTY semantics

`MEMORY_EMPTY` audit rows are emitted by the compile (the only
emitter — `audit-format.md:171` registers
`tools/aidlc-runtime.ts compile`) when a stage row meets ALL of:

- `outcome === "approved"` (pending rows do not emit — see §6 below)
- `memory_entries === 0` (file exists, zero entries under the four
  canonical §13 headings)

Pending rows with zero entries do NOT emit. A stage still in flight
may legitimately have zero entries because the conductor hasn't
written to memory.md yet — emitting MEMORY_EMPTY mid-flight would
generate noise that doesn't represent a real diary skip. The signal
milestone 14's doctor wants is "stage approved with zero entries" — that
requires the stage to have approved.

### Idempotency — exactly once per (slug, gate-completion)

`runtime-graph.json` itself is byte-equivalent across re-compiles
against the same audit log. MEMORY_EMPTY emits are stronger:
**at most one MEMORY_EMPTY row per `(stage_slug, completed_at)` tuple**.

Inside the locked section the compile re-reads `audit.md`, scans for
existing MEMORY_EMPTY rows for each zero-entry-approved slug, and
suppresses the emit if any prior row's Timestamp is at or after this
slug's `completed_at`. This means:

- The first compile after a stage approves with zero entries emits one
  MEMORY_EMPTY row.
- Every subsequent compile during the same workflow does NOT re-emit
  for that slug.
- `--stage <slug>` re-jump + re-approve produces a new
  `STAGE_COMPLETED` (later `completed_at`) — if the stage is still
  empty on re-approval, a fresh MEMORY_EMPTY row emits because the
  prior row's Timestamp is now < the new completed_at.

Doctor's MEMORY_EMPTY-rate metric reads these rows directly without
de-duplication; one row per gate-completion-with-empty-diary.

If the artefact write fails after MEMORY_EMPTY emits inside the locked
section, the audit log carries N MEMORY_EMPTY rows for stages whose
runtime-graph.json never landed. The next compile sees those rows in
its suppression scan and skips re-emit; the artefact then lands. No
duplicate emits, no phantom artefacts.

---

## 6. v0.4.0 backfill rule

Stages that completed before milestone 13's memory.md lifecycle ships have
no memory.md history. The backfill rule:

- `memory_entries: null` ↔ `memory_breakdown: null` ↔ no MEMORY_EMPTY emit.
- Both fields move together. The discriminator is "did
  `parseMemoryHeadings` execute?" — if memory.md exists (even
  zero-byte), it executed and the keys are numbers; if memory.md is
  absent, both are `null`.

Without this rule, every v0.4.x user upgrading to v0.5.0 would see a
storm of MEMORY_EMPTY rows on the first post-upgrade workflow.

---

## 7. Recovery model — snapshot + suffix replay

`runtime-graph.json` + `audit.md` form an event-sourced pair.
`audit.md` is the append-only event log; `runtime-graph.json` is a
materialised snapshot taken at the last gate transition. A reader with
both reconstructs the current state by reading the snapshot, then
replaying audit rows after the snapshot's last `completed_at`.

Five recovery sources, in human read order:

1. **Artefact tree** (`<record>/<phase>/<stage>/`) — what was produced.
2. **memory.md** (`<record>/<phase>/<stage>/memory.md`) — what the
   conductor chose to capture.
3. **audit/ shards** — the canonical event log; what actually happened.
4. **state.md** — the active-stage cursor.
5. **runtime-graph.json** — the materialised view; faster to query
   than re-walking audit, but always re-derivable from it.

### Freshness caveat for pending rows

Pending rows' `memory_entries` and `memory_breakdown` were snapshotted
at last compile time. If a stage is mid-flight and the conductor
has written more entries since the last compile fired, the snapshot
lags. Recovery consumers must re-parse memory.md at recovery time;
they must NOT trust snapshotted counts for pending rows.

v0.5.0 has no consumer that reads pending counts live. Documented for
v0.6.0 `--resume`, which will need this carve-out.

### Parallel-Bolt mid-flight recovery (closed in v0.5.0)

A workflow with parallel Bolts crashing mid-batch had no per-Bolt
recovery seam in milestone 8 — the schema reserved `instances?` but compile
only wrote single-instance rows on main, and worktrees never received
a runtime-graph fragment. Closed in v0.5.0 by `aidlc-runtime.ts
fragment-fork` (Bolt start) and `fragment-merge` (Bolt complete
--merge), and by the compile populator extension that emits
`BoltInstance[]` when audit shows ≥ 2 distinct slugs in a
Construction-phase stage's window.

The per-Bolt fragment is dead-on-arrival in v0.5.0 (no v0.5.0 reader
of the worktree's record-dir `runtime-graph.json`). v0.6.0 `--resume`
should treat the fragment as a hint, with main's post-merge
runtime-graph as canonical, and additionally check for orphaned
worktrees per `aidlc-bolt.ts` to surface a recovery prompt for those.

---

## 8. CLI surface

```bash
# Walk audit + memory.md, write runtime-graph.json (invoked by hook).
bun .claude/tools/aidlc-runtime.ts compile

# Print one stage row from runtime-graph.json (debug/test surface).
bun .claude/tools/aidlc-runtime.ts read <stage-slug>

# Print deterministic aggregates over runtime-graph.json: stage/phase
# outcome tallies, memory-entry counts by category, sensor 4-state
# tallies, learnings captured, and workflow duration. Read-only; the
# session skills (session-cost, replay, outcomes-pack) consume the
# --json shape so every number they render comes from here, not from
# LLM-side counting.
bun .claude/tools/aidlc-runtime.ts summary [--json]

# Byte-copy main runtime-graph.json into a Bolt's worktree fragment
# (one-shot; called by `aidlc-bolt start --worktree`). No audit emit —
# the fragment lifecycle rides on STATE_FORKED + AUDIT_FORKED.
bun .claude/tools/aidlc-runtime.ts fragment-fork --slug <kebab-slug>

# Remove the worktree fragment (idempotent; called by
# `aidlc-bolt complete --merge`). No audit emit — the fragment
# lifecycle rides on STATE_MERGED + AUDIT_MERGED. Main's runtime-graph
# is rebuilt event-source by the post-Bash compile hook on AUDIT_MERGED.
bun .claude/tools/aidlc-runtime.ts fragment-merge --slug <kebab-slug>
```

All subcommands accept `--project-dir <path>` to override the standard
cwd-based resolution.

The compile is hook-driven in normal operation; manual invocation
exists for tests and debugging.

---

## 9. Why hook-driven, not LLM-tool-coupled

Earlier plan revisions proposed inserting `spawnSibling(...,
"aidlc-runtime.ts compile", ...)` calls inside `handleApprove` /
`handleAdvance` / `handleComplete --merge`. That approach violates the
load-bearing tenet documented in
[Plane Architecture](02-plane-architecture.md):

> Where you require determinism, use a tool. Where you require
> knowledge, use an LLM/agent. Where you require judgement, use a
> human.

Runtime-graph compile is data-plane substrate that must be observable
from outside any specific session. Coupling it to LLM-invoked tools
means LLM omission breaks the determinism guarantee — if the
conductor forgets to call `aidlc-orchestrate.ts report --stage <slug> --result approved` after a human
clicks Approve, the audit row never appends AND the compile never
fires; runtime-graph silently lags, recovery substrate is corrupt.

The PostToolUse Bash hook fires on the conductor's actual
subprocess invocation regardless of what the LLM does next. The
audit-emit-side seam (`bun aidlc-(state|jump|bolt|utility).ts`) is
the deterministic anchor.

---

## 10. Known gaps closed by future PRs

- **MEMORY_EMPTY-rate metric** — milestone 14 doctor surfaces the rate using
  the `(Stage, ISO-second)` de-dup tuple frozen in §5.
- **`learnings_captured` provenance counts** — milestone 12 gate ritual
  populates `from_orchestrator` and `from_user_addition`.
- **`sensor_firings` array** — milestone 9 + milestone 10 dispatch sensors and
  populate this slot.
- **Bolt fork/merge of runtime-graph.json** — closed in v0.5.0 by
  `fragment-fork` (no new audit event; rides on STATE_FORKED +
  AUDIT_FORKED) and `fragment-merge` (no new audit event; rides on
  STATE_MERGED + AUDIT_MERGED). Compile populates `instances[]` from
  audit's BOLT_*-tagged events when ≥ 2 distinct slugs sit inside a
  Construction stage's window.
- **CLI-mode dispatch for headless workflows** — v0.6.0+ may ship a
  non-Claude-Code execution path; the hook only fires inside a Claude
  Code session.

---

## 11. Fragment lifecycle

The per-Bolt runtime-graph fragment file lives at
`<worktree>/<record>/runtime-graph.json`, gitignored, mirroring
main's location. Its lifecycle is:

1. **Fork on Bolt start.** `aidlc-bolt start --worktree --slug <slug>`
   delegates to `aidlc-runtime fragment-fork --slug <slug>` after
   state-fork + audit-fork. Single-read protocol: `readFileSync` once
   into a buffer, `writeFileSync` from the buffer to the fragment
   path, hash the same buffer for the stdout envelope. Closes the
   byte-copy / hash race against a concurrent compile rewriting main
   mid-fork. If main has no runtime-graph.json yet, the fragment is
   an empty graph anchored to the worktree's state cursor.
2. **Evolve during the Bolt's life.** The post-Bash compile hook fires
   on every transition-class audit emit — including transitions
   inside the worktree. Each fire recompiles the worktree's
   runtime-graph.json (the fragment) from the worktree's audit view.
   The fragment may end up with `instances[]` populated for siblings
   that were active at this Bolt's audit-fork instant; later-starting
   siblings won't appear in the fragment because the worktree's audit
   is a snapshot at fork time.
3. **Merge on Bolt complete.** `aidlc-bolt complete --merge --slug
   <slug>` delegates to `aidlc-runtime fragment-merge --slug <slug>`
   after state-merge + audit-merge. fragment-merge hashes the
   fragment for stdout observability, `unlinkSync`'s it, and emits a
   JSON envelope. After the parent Bash invocation returns, the
   compile hook re-fires on main and rebuilds main's runtime-graph
   with `instances[]` populated for the just-merged slug.
4. **Defense-in-depth removal.** `aidlc-worktree merge` and
   `aidlc-worktree discard` both call `git worktree remove`, which
   transitively removes the fragment. fragment-merge's explicit
   removal pairs with the implicit cleanup as a defense-in-depth
   pattern, mirroring how state-merge and `git worktree remove`
   already pair on the state side.
5. **Failure modes.** `fragment-fork` failures (worktree-missing,
   fragment-already-exists, byte-copy IO error, spawn timeout) cause
   `aidlc-bolt` to emit `BOLT_FAILED` with a `Reason: fragment-fork-*`
   field for doctor attribution (`fragment-fork-failed` for IO / guard
   errors; `fragment-fork-timeout` for spawn SIGTERM); state-fork +
   audit-fork are NOT rolled back (each emitted its own audit row
   already). `fragment-merge` failures after audit-merge has already
   landed produce an unusual partial-success audit signature
   `BOLT_COMPLETED → STATE_MERGED → AUDIT_MERGED → BOLT_FAILED
   (Reason: fragment-merge-*)` (`fragment-merge-failed` for IO /
   guard errors; `fragment-merge-timeout` for spawn SIGTERM); the
   fragment file persists until the implicit `git worktree remove`
   cleanup. Subsequent compile against main produces a coherent
   runtime-graph (the BOLT_FAILED at this position scores the instance
   `"approved"` because the STATE_MERGED-wins precedence in the rollup
   reflects that the Bolt's content has already propagated to main.
   The BOLT_FAILED here is recovery telemetry; it records the seam, and
   the content itself remained intact).

---

## Next Steps

- **Why the data plane is structured this way** — the control/data
  plane separation that makes `runtime-graph.json` a mirror of
  `stage-graph.json` rather than a second source of truth. See [Plane
  Architecture](02-plane-architecture.md).
- **The lifecycle that triggers compile** — the workflow / phase /
  stage transitions whose audit emits drive the compile hook. See
  [State Machine](12-state-machine.md).
- **The audit log this graph is derived from** - the 72-event taxonomy
  and the emitter registry. See [State Machine](12-state-machine.md)
  and the User Guide's [State and Audit
  Trail](../guide/10-state-and-audit.md).
