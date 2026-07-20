# Plane Architecture

> Audience: Tier 2/3 (team adopter, framework contributor).

This chapter explains AI-DLC's three-plane architecture — the
separation between control, data, and management concerns — and the
compile boundary that joins them. Cross-link to
[Sensor System](07-sensor-system.md) (control-plane sensor manifests),
[Rule System](08-rule-system.md) (control-plane rule files), and
[State Machine](12-state-machine.md) (data-plane lifecycle). This is
the design substrate; sensor and rule manifests are the source files
the substrate operates on.

---

## 1. The problem

v0.5.0 introduces rules, sensors, and a learning loop that captures
observations during workflow runs and writes them somewhere they fire
automatically next time. The underlying model has real complexity:
per-stage imports of multiple kinds, universal-default rules attached
by filename, sensor manifests, a hook chain. Customers shouldn't have
to learn all of it to use the framework, and the framework shouldn't
pay lookup costs in hot paths.

The right framing is *not* "make the design simpler." It's *"borrow
the discipline that already exists for systems like this."* Modern
networking's three-plane architecture is the closest analog, and the
lessons transfer almost directly.

---

## 2. The networking analog

A modern router (or SDN controller) splits its work into three planes:

- **Management plane** — SNMP, syslog, dashboards, NETCONF, gRPC, CLI.
  Configuration in, observability out. Human cadence (configure once,
  query occasionally).
- **Control plane** — BGP, OSPF, IS-IS, route computation. Given the
  topology, decide which path each packet should take. Topology
  cadence (seconds to minutes).
- **Data plane** — flow tables, ACLs, ASIC forwarding. Forward this
  packet now, in nanoseconds, by table lookup. Line rate.

Five lessons worth stealing:

### Filter evaluation never happens at packet rate

OSPF computes shortest paths once when topology changes. The result is
installed into the data plane's flow tables. Every subsequent packet
is a table lookup — nanoseconds, deterministic, no filter logic. Smart
work happens at *topology-change time*, not at *packet time*.

### Plane interfaces are explicit

OpenFlow, P4, NETCONF, gRPC. The control plane doesn't reach into the
data plane's memory; it sends a structured message that says "install
this flow." The data plane confirms. This makes failure modes
diagnosable — a refused install is a clear signal, not a silent miss.

### Failures isolate cleanly

If the control plane crashes, the data plane keeps forwarding using
the last-installed rules. If the data plane fails, the control plane
notices via heartbeat and re-routes around the failure. Neither plane
bringing the other down is a load-bearing property.

### Telemetry closes the loop

The data plane reports flow stats, drops, latency. The control plane
consumes telemetry and decides: re-route around congestion, scale a
service, mark a peer down. *The control plane gets smarter because the
data plane reports back.*

### Three planes, three cadences

Management plane runs at human cadence. Control plane runs at topology
cadence. Data plane runs at line rate. Each plane is allowed to be
slow if its job permits.

---

## 3. Mapping to AI-DLC

The mapping is closer than it sounds. (`<record>/` below = the active intent's
record dir, `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`; the audit trail is a
dir of per-clone shards under `<record>/audit/`.)

| Networking | AI-DLC analog |
|---|---|
| Control plane (BGP, OSPF, route computation) | Stage definitions, rules, sensors — the schema of what should run |
| Data plane (packet forwarding, flow tables) | Stage executions, Bolts, agent invocations — the actual runs |
| Management plane (SNMP, dashboards, CLI) | `/aidlc --doctor`, designer (future), audit queries, `CLAUDE.md` |
| Routing protocol (BGP / OSPF) | Compile: `aidlc-graph.ts compile` reads stage frontmatter + rules + sensors, resolves each stage's pull imports against the source registries, emits the graph |
| FIB (forwarding information base) loaded into ASIC | `stage-graph.json` with per-stage `rules_in_context` + `sensors_applicable` resolved at compile time |
| OpenFlow / NETCONF (interface) | `stage-graph.json` — the explicit interface between compile and orchestrator |
| Telemetry (NetFlow, sFlow) | Audit log, sensor firings, memory.md entries → the intent's `runtime-graph.json` |
| Reactive flow install (PACKET_IN) | Learning loop: data plane reports an observation → user confirms → file write into rules/sensors plus a frontmatter edit on the originating stage when a new sensor binding is captured |
| Proactive route install (BGP advertisement) | Framework PR: ships new stages/rules/sensors before any workflow runs |
| Topology change → recompute routes | Workflow start → compile reads current source files; subsequent recomputes triggered by next workflow |
| Pre-installed FIB stable across packet flight | Learning-loop writes during a workflow don't affect the in-flight compiled view; they apply at next workflow start (see §5) |
| Line-rate forwarding by table lookup | Orchestrator + dispatcher read pre-resolved fields off graph nodes; no resolution walks at runtime |

The plane labels in `stage-graph.json` and the runtime read patterns
mirror the FIB/route-table/CLI separation. Configuration enters at the
management plane; the control plane compiles it, and the data plane
executes by lookup.

---

## 4. The compile boundary

The load-bearing insight: networking doesn't put filter evaluation or
inheritance walks at packet rate because the work is too expensive
there. The control plane computes once, installs into the FIB, the
data plane forwards by lookup. AI-DLC follows the same pattern: compile
once at workflow start, read the resolved view throughout the workflow,
recompile at the next workflow start.

### What compiles, what stays on disk

| State | Lifecycle | Source on disk | Compiled into | Read by |
|---|---|---|---|---|
| Stage DAG, scope routing, artifact production | Framework-versioned (changes via framework PR) | Stage frontmatter (`.claude/aidlc-common/stages/*.md`) | `stage-graph.json` | Orchestrator, doctor, designer |
| **Rules** (prose, prescriptive) | Mutable; framework PR or learning-loop writes | `aidlc/spaces/<active-space>/memory/<scope>.md` (filename-derived; org/team/project attach to every stage) | `stage-graph.json` per-node `rules_in_context` | Orchestrator (resolved view); Claude Code auto-load reads source for in-context prose |
| **Sensors** (manifests, verification checks) | Mutable; framework PR or learning-loop writes (manifest authored once; stages import by id) | `.claude/sensors/aidlc-<id>.md` | `stage-graph.json` per-node `sensors_applicable` | Dispatcher reads resolved list at stage entry; PostToolUse fires from it |
| Workflow execution telemetry | Per-workflow, accumulating | `audit/` shards · `memory.md` · Bolt forks | `<record>/runtime-graph.json` | Doctor, gate ritual, future cross-workflow observer |
| Per-stage observation log | Per-stage-run | `<record>/<phase>/<stage>/memory.md` | (no compile — read directly) | Gate ritual at this stage's gate |

Two compiled artefacts, both per-workflow. `stage-graph.json` carries
the resolved control-plane view: stage DAG, scope routing, artifact
production, plus per-stage rule and sensor lists with inheritance
pre-resolved. `runtime-graph.json` is recompiled — a full event-sourced walk of the audit
log — on every transition-class audit event. Source files on disk are the
authoring surface; compiled graphs are what runtime reads.

### One compile, at workflow start

The compile reads stage frontmatter, walks `aidlc/spaces/<active-space>/memory/` and
`.claude/sensors/`, attaches universal-default rules by filename
(`org.md`, `team.md`, `project.md` apply to every
stage), then looks up each stage's pull imports against the source
registries:

- The stage's `phase: <name>` field attaches the matching
  `phases/<name>.md` rule (one rule per stage). See
  [Rule System](08-rule-system.md).
- The stage's `sensors: [<id>, ...]` list resolves each id against
  `.claude/sensors/`. Unknown ids fail the compile loud — a stage
  can't silently fail to fire something it imports. See
  [Sensor System](07-sensor-system.md).

The compile emits `stage-graph.json` with the answers baked into each
stage node. Throughout the workflow, the orchestrator and dispatcher
read those pre-resolved fields. Learning-loop writes during the
workflow update source files but don't affect the in-flight compiled
view — the user already corrected the orchestrator in-stage; the rule
is for next time. The next workflow's compile picks them up. Same
shape as BGP not recomputing routes mid-packet-flight.

### Locked and atomic

Two failure modes the compile must address from day one. This
implementation's per-Bolt worktrees isolate state for parallel agents
most of the time, but `data/stage-graph.json` is repo-shared, not
worktree-scoped — and the user can launch `/aidlc` in two terminals
against the same checkout — so the compile needs defence regardless.

- **Concurrent compiles** would race writes to `data/stage-graph.json`.
  The compile runs under `withAuditLock` from v0.4.0 (see `lib.ts`)
  so concurrent invocations serialise — the second waits for the first
  to finish, then runs against fresh source state.
- **Crash mid-write.** A compile interrupted mid-write must not leave
  consumers reading invalid JSON. The compile writes to a temp file,
  validates the output, then renames atomically via POSIX `rename(2)`.
  Readers see either the previous compile's output or the new one —
  never a half-written file.

Both patterns already live in the codebase for state-and-audit work;
the compile inherits them.

### Two graphs, two lifecycles

The two compiled artefacts have different consumers and different
update cadences:

- **`stage-graph.json`** — control plane. Compiled at workflow start.
  Stable across the entire workflow's lifetime. Read by the
  orchestrator (DAG topology, scope routing), the dispatcher (per-stage
  `sensors_applicable`); Claude Code's auto-load consumes the source
  rule files in parallel for prose context.
- **`runtime-graph.json`** — data plane. Per-workflow artefact at
  `<record>/runtime-graph.json`. Recompiled (full event-sourced walk of
  the audit log) on every transition-class audit event. Aggregates execution
  telemetry: which stages ran, which
  Bolts forked, which sensors fired, which memory.md files exist. Read
  by the gate ritual (to surface candidates), doctor (for execution
  health), and future cross-workflow observers. See
  [Runtime Graph](13-runtime-graph.md) for the schema, compile
  lifecycle, and recovery model.

Mixing them violates the cacheability boundary. `stage-graph.json`
wants to be cached for the lifetime of the workflow;
`runtime-graph.json` mutates per-event. The same artefact would mean
re-issuing the entire control plane every time the data plane reports
a sensor fired.

### Why rules and sensors flow through the same compile

The compile is symmetric across all control-plane inputs. Stage
frontmatter, rule files, and sensor files are all read by
`aidlc-graph.ts` at workflow start; all contribute to the resolved
per-stage view. Networking does this — BGP and OSPF feed the same FIB;
ACLs and policies feed the same flow tables. One compiled view,
multiple sources.

Concretely, each stage node gains two fields:

```json
{
  "slug": "requirements-analysis",
  "phase": "inception",
  "sensors": ["required-sections", "upstream-coverage"],
  "rules_in_context": [
    {"path": "aidlc/spaces/default/memory/org.md", "scope": "org"},
    {"path": "aidlc/spaces/default/memory/team.md", "scope": "team"},
    {"path": "aidlc/spaces/default/memory/project.md", "scope": "project"},
    {"path": "aidlc/spaces/default/memory/phases/inception.md", "scope": "phase"}
  ],
  "sensors_applicable": [
    {"id": "required-sections", "path": ".claude/sensors/aidlc-required-sections.md"},
    {"id": "upstream-coverage", "path": ".claude/sensors/aidlc-upstream-coverage.md"}
  ]
}
```

`matches` (when present in the resolved sensor entry) is a sensor-side
capability filter — *"this sensor analyses files matching this glob"*
— that the compile snapshots verbatim from the manifest into the
stage's resolved entry. The PostToolUse hook reads it at fire time
without re-opening the manifest.

Two consequences:

- **The dispatcher does no resolution walks at runtime.** Stage entry
  reads `sensors_applicable` off the node — already looked up, already
  attached. PostToolUse fires from this pre-resolved list.
- **Doctor and designer query one resolved view.** "What rules apply
  to this stage?" "Which sensors fire when I edit this file?" Both
  answer from `stage-graph.json` directly, no filesystem walks.

### The networking lesson, applied

The control plane (compile) does the slow, clever work once; the data
plane (orchestrator + dispatcher reads) then runs fast on the resolved
view. Compile at workflow start resolves all per-stage imports —
every `sensors:` id looked up, every `phase:` attached, the
universal-default rules picked up by filename. Throughout the workflow,
runtime reads pre-resolved fields off graph nodes. BGP doesn't
recompute routes mid-packet-flight; AI-DLC doesn't recompile
mid-workflow. Learning-loop writes during a workflow update source
files; they enter the compiled view at the next workflow start.

---

## 5. Recovery as an emergent property

The data plane just described — `runtime-graph.json`, audit log,
state docs, `memory.md`, artefact tree — has a property it didn't pay
for. A fresh harness session, started after compaction or a clean
restart, can read these five sources together and reconstruct enough
of the workflow's state to pick up where the previous session left
off. Recovery isn't a feature added to v0.5.0; it's an emergent
property of the design's data discipline.

### Five sources, one picture

| Source | Records what | Read order |
|---|---|---|
| Artefact tree (`<record>/<phase>/<stage>/*.md`) | The decisions themselves, in finished form | First |
| `memory.md` per stage | What got noticed during the decision-making | Second |
| Audit log (`<record>/audit/` shards) | When each decision happened, who approved | Third |
| State docs (`<record>/aidlc-state.md`, per-stage state) | Where in the workflow we are right now | Fourth |
| `runtime-graph.json` | Cross-stage summary (durations, sensor firings, learnings counts) | Fifth |

The artefacts go first because they're the durable record of what was
actually agreed. The other four sources are about the journey — what
was considered, when it happened, what's pending, what the patterns
look like across stages. A human picking up someone else's
half-finished work reads the same way: outputs first, notes second,
timeline third, current cursor fourth, summary view last.

### What recovery reconstructs cleanly

Decisions, outputs, in-stage context, timeline, current position, and
which Bolts forked with what outcomes. A fresh session reading the
five sources knows what the workflow has produced, what corrections
the user has made, what gates have been approved, what's still
pending, and roughly how the previous run was going.

### What recovery can't reconstruct

The previous session's conversational rhythm — the user's mid-stage
Q&A pattern, the LLM's working hypotheses before they got committed
to `memory.md`, partial tool calls interrupted mid-flight. The
conversation buffer is gone with the session. This is a fundamental
property of LLM sessions, not a fixable design property. Recovery's
job is to give the new session enough to re-orient and continue, not
to recreate the previous session's exact mental state.

### The consistency constraint

Five sources, written by different code paths, all have to stay
reasonably consistent for recovery to work. The audit log is canonical
(append-only, source of truth for "what happened"); the other four
are consistent with it because their writes are gated by the same
`withAuditLock` primitive from v0.4.0. A fresh session reading any of
the five against the audit log can detect drift and reconcile.

### What this means for the framework

The framework already practises a small version of this: today's
`aidlc-state.md` carries a `Scope` field that is written at intent
birth and read on session-resume, so the workflow's scope survives
context compaction without the orchestrator having to re-derive it. The
generalisation is that every part of the data plane that records
something durable becomes part of the recovery surface, not just the
state file. The deeper principle is that the *data plane is structured
for recovery*: because every durable record is part of the recovery
surface, a resume path is a small addition on top of substrate that
already exists, rather than a bolt-on.

---

## Next Steps

This chapter is the lens; the rest of the Developer Reference is the
mechanics seen through it.

- **The control plane in action** — how the orchestrator drives the
  compiled stage graph. See [Orchestrator](03-orchestrator.md).
- **Control-plane inputs** — the source files the compile resolves into
  each stage node: [Sensor System](07-sensor-system.md) (manifests) and
  [Rule System](08-rule-system.md) (rule files).
- **The data-plane artefact** — the schema, compile lifecycle, and
  recovery model of `runtime-graph.json`. See [Runtime
  Graph](13-runtime-graph.md).
- **The user-facing view** — control/data/management framed for someone
  running a workflow rather than building the framework. See [Rules and
  the Learning Loop](../guide/09-rules-and-the-learning-loop.md).
