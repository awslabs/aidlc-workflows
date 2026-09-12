# Construction and the Swarm

Construction is where AI-DLC builds the thing — where the per-Unit stages run,
and where the **swarm** can fan that work out across many Units at once. It is
also the part of the harness where the cleanest answer to "what can I shape, and
how?" requires you to be honest about which knob belongs to whom. Some of the
levers here are yours as a harness engineer, authored as data the way every
other chapter teaches. Other knobs sit with the human at the gate and the
operator who launches the run. This chapter walks all of them and marks the
line precisely, so you reach for the right surface and stop pushing on the ones
that are not yours to push.

The throughline is the same one the rest of this guide carries: you reshape
Construction by editing **data** under `core/` — a rule, a stage, a sensor's
check command — and never by editing code. The thing that makes Construction
feel different is that two of its most visible behaviours (the autonomy grant,
the swarm driver) are governed by concerns that are deliberately *not* data
files, and recognising that keeps you from authoring a setting that does not
exist.

---

## Three concerns, three owners

The framework's design principle splits every decision by what kind of thing it
is: determinism belongs in a tool, knowledge belongs to an agent, and judgment
belongs to a human. Construction's swarm is that split made concrete, and it is
worth holding the whole picture before you touch any one knob.

| Concern in Construction | Owner | Where it lives |
|---|---|---|
| The team's autonomy **posture** (a standing default) | you, the harness engineer | a rule in `core/memory/{team,project}.md` (data) |
| What Units **can** parallelise | you, the harness engineer | the `units-generation` stage and its dependency DAG (data) |
| The **convergence check** the swarm trusts | you, the harness engineer | your project's own build/test command + a protected spec (data + project config) |
| The actual autonomy **grant** for this project | the human | an explicit offer or on-demand request at runtime |
| The swarm **driver** selection | the operator | the `AIDLC_USE_SWARM` environment variable |
| The convergence **verdict**, merge-back, and audit | a tool | `aidlc-swarm.ts` (code → Developer Reference) |

The three rows marked "you" are the body of this chapter. The other three are
covered because you need to understand the runtime your data shapes, but you
author none of them.

---

## The autonomy posture — your real lever, written as a rule

The standing recommendation lives under `## Walking Skeleton` in
`core/memory/org.md`, refined by `team.md` and `project.md`. New workflows
record three independent settings:

| Setting | New-workflow default | Meaning |
| --- | --- | --- |
| `Construction Checkpoints` | `enabled` | Verify and approve completed solo Units using current evidence |
| `Construction Iteration` | `unit-major` | Finish one Unit's applicable stages before the next |
| `Construction Execution` | `serial` | Build serially; explicit swarm execution requires stage-major |

Checkpoint policy applies only to an actual non-empty Unit DAG with solo
ownership. Under skeleton-on, plan the first DAG Unit as the smallest working
integrated slice. It completes all applicable per-unit design stages and Code
Generation, passes a real end-to-end check, and receives human skeleton approval
before later Units start, even with stage-major selected. A first design-stage
review alone is not a working skeleton. The planned marker in `bolt-plan.md`
does not reorder the actual DAG.

Under skeleton-off, the engine offers **Continue automatically** / **Review each
checkpoint** at Construction entry. Under skeleton-on, it offers the choice
after the real skeleton checkpoint. The conductor follows `offer_autonomy`,
records the human's choice through `bolt set-autonomy`, and asks no repeated
ladder once a choice is known. On-demand grant/revoke requests remain available.
Autonomy changes ordinary completion approvals; it never supplies a human Plan
Approval or summary confirmation, or makes a failed check pass.

To choose swarm execution, explicitly select stage-major and then
`Construction Execution=swarm`. Guided (`gated`) and automatic (`autonomous`)
batch completion are both supported; granting autonomy does not change order or
execution. Unit-major remains serial and refuses a contradictory swarm setting.
Legacy workflows without the new fields retain their existing first-stage/late
cascade and autonomy-based swarm routing. Team-owned work keeps `unit_gate` and
its own per-stage or unit-end approval rhythm.

You shape the recommendation through the rule layers from
[Rules and the Learning Loop](05-rules-and-the-loop.md). The human still selects
the actual grant. For example, a team can recommend:

```markdown
## Walking Skeleton

Until our integrated checks have proved reliable, recommend **Review each
checkpoint**. Review the working first slice and each ordinary completed Unit
or swarm batch before proceeding. Plan Approval and summary confirmation remain
human decisions even when we later select **Continue automatically**.
```

For a trusted project, the same heading can recommend **Continue automatically**
after the skeleton is verified. The rule supplies guidance, never a recorded
autonomy grant or a silent switch to swarm execution.

---

## Checkpoint and approval evidence

When `run-stage` carries `construction_checkpoint`, the Unit body and reviews
have already run. Route it before body/reviewer/gate logic, run
`bolt checkpoint --action verify --unit <Unit> --kind <unit|skeleton>
--check-cmd '<real project check>'`, and approve only current verified evidence.
A skeleton always needs the human; ordinary Units follow `human_required`.
`swarm_checkpoint` similarly routes a completed batch before the next batch,
using `bolt swarm-checkpoint --action status|approve|reject --batch <N>
--units <comma-separated Units>`. Guided approval waits for the real answer;
automatic approval omits `--user-input`. Both return to `next`, never approve
the whole Code Generation stage for one Unit or batch.

A final stage directive carrying `construction_policy.completion_only: true`
and `human_completion_required: false` only reconciles recorded approvals: skip
body, questions, reviewer and learnings prompt, report `awaiting-approval` then
`approved` without user input, and call `next`. Evidence errors require the
named review/receipt repair or human Request Changes, never invented verification.

Plan Approval remains individually bound even when its presentation is grouped.
The `log decision`/`answer --checkpoint plan-approval --batch-file <JSON>
--session <ID>` flow binds exactly the live swarm Unit set and current
plan/questions fingerprints with unchanged source. One actual **Approve Plans**
answer produces individual receipts. Legacy mediation and unsupported harnesses
fall back to the single-Unit flow. See the
[CLI reference](../guide/12-cli-commands.md#grouped-code-generation-plan-approval)
for the manifest and commands.

## Shaping what can run in parallel — the Bolt-DAG

The swarm fans work out across Units, so the question "what can run at once?"
is decided upstream, in inception, by the `units-generation` stage. That stage
produces `unit-of-work-dependency.md`
(`core/aidlc-common/stages/inception/units-generation.md`
declares `produces: unit-of-work-dependency`), and inside that artifact a
required fenced `yaml` edge block lists every Unit with its `depends_on` list.

The compiler reads that block into the `bolt_dag` node of `runtime-graph.json`.
The node is present **only when** the edge block is well-formed and acyclic; an
absent, malformed, or cyclic block omits the node entirely
([Runtime Graph](../reference/13-runtime-graph.md), schema note at line 44). The
`bolt_dag` node also carries `batches` — topological levels where every Unit's
dependencies are satisfied by prior levels, so a batch's Units have no edge
between them and can fan out together.

The five **per-Unit** Construction stages each
declaring `for_each: unit-of-work` in its frontmatter:

For human team ownership, delivery planning can combine
`Construction Iteration: unit-major` with `Unit Ownership: team`. The engine
then derives `## Unit Progress` from the same DAG/artifact/receipt evidence and
uses either per-stage or unit-end Unit gates instead of the legacy late
unit-major cascade. This team-owned path retains its own policy; solo ownership
uses the checkpoint-enabled or legacy path selected by its recorded state.

| Stage | Runs |
|---|---|
| `nfr-requirements` | once per Unit |
| `functional-design` | once per Unit |
| `nfr-design` | once per Unit |
| `infrastructure-design` | once per Unit |
| `code-generation` | once per Unit |

For the four design stages the per-Unit coverage is further **kind-filtered**:
each Unit's `kind` (tagged in the 2.7 edge block) selects, via the stage's
`produces_kinds` map, which of its produces artifacts that Unit actually owes.
The engine prunes both the run-stage directive's produces paths and the
coverage check to that set, so a `spec` Unit is complete for infrastructure-
design without a deployment doc and a `packaging` Unit is complete for
functional-design with zero files. An untagged Unit keeps the full matrix.

(The remaining two Construction stages, `build-and-test` and `ci-pipeline`, run
once at the end across everything, so they are not part of the per-Unit fan-out.)

**This parallel surface exists only for the scopes where `units-generation`
runs** — `enterprise`, `feature`, `mvp`, `classic`, and `workshop`. The incremental scopes
(`bugfix`, `refactor`, `security-patch`) and `poc`/`infra`/`express` never run
`units-generation`, so they produce no edge block, carry no `bolt_dag`, and run
Construction single-pass with nothing for the swarm to fan out across. Shape the
swarm where work has a real Unit DAG. Zero-Unit runs keep ordinary stage
execution; on-demand approval preferences do not create a DAG or a swarm.

The harness lever here is indirect but real: **you shape what parallelises by
shaping the dependency structure `units-generation` captures.** If you author
team guidance that favours coarse Units with few cross-dependencies, more Units
land in the same batch and run concurrently. Tight, deeply-chained dependencies
serialise the work into many small batches. You influence this through the
`units-generation` stage prose and the rules the architect agent reads while
decomposing — the decomposition itself is a knowledge call the agent makes with
the human, and the topology it writes is what the compiler turns into batches.

The compile and parse that turn the edge block into `bolt_dag` is code, not
something you author. Shaping that parser is a code change → see the
[Developer Reference](../reference/13-runtime-graph.md).

---

## Wiring convergence — your project's own check is the trusted signal

A Code Generation swarm does not bypass planning. Before `prepare`, every
emitted Unit must have a current human-approved plan containing the structured
Testing Contract, unit-scoped test instructions, and matching approval
fingerprint. `prepare` verifies that evidence before forking worktrees, and
every worker brief carries the approved Unit marker, contract hash, plan, and
instructions. This keeps the autonomous path on the same methodology and Plan
Approval contract as normal Code Generation.

A swarm worker can claim its Unit converged. The framework never takes that claim
on faith. The authoritative signal is your project's **own check command**, run by
the referee: exit `0` means genuinely converged, any other exit means not yet.
This is the single most important thing a harness engineer ensures for autonomous
Construction — that the project actually *has* a real check command and a
protected spec, so the swarm has something trustworthy to converge against.

Two surfaces carry the signal:

- **The check command.** Whatever proves your Unit is done — `npm test`,
  `pytest`, a build-and-lint script, your CI's local equivalent. The referee runs
  it per Unit during the loop and again at finalize. A green exit is the only
  thing that lets a Unit's work merge.
- **A protected spec file.** The referee can anti-tamper compare a designated
  `--test-file` against its forked-git baseline, so a worker cannot quietly weaken
  the test that defines "done" to make a red check go green. You ensure the spec
  that encodes the acceptance criteria exists and is the file pointed at.

Your harness contribution is making both real and meaningful. A check that always
passes, or a spec that is empty, hands the swarm a rubber stamp. The
`## Testing Posture` rule in `org.md` already combines the selected Test
Strategy with additive per-scope floors (for example, `mvp`/`feature` add 80%
coverage); authoring a stricter structured methodology/order at `team.md` is
how you change execution cadence without discarding those floors.

A sensor complements the check on the prose side. The `required-sections` and
`upstream-coverage` sensors that `units-generation` already imports verify the
artifacts' shape and coverage at the gate; you can author a project-specific
convergence or required-sections sensor with the muscle from
[Sensors](06-sensors.md) and bind it to the Construction stages whose output you
keep eyeing for the same gap. The sensor is advisory telemetry that fires on each
write; the project check command is the hard convergence gate. They work the two
halves — the sensor watches shape as the agent writes, the check decides whether
the Unit may merge.

---

## The driver seam - `AIDLC_USE_SWARM`

How the swarm physically fans out is selected by an environment variable, and it
is worth being plain that this is an **operator knob**. It is not a `.claude/`
data file, and it is not in `settings.json` (it is read conductor-side at fan-out
time). You do not author it; you understand it so you know the runtime your data
shapes.

| `AIDLC_USE_SWARM` | Driver | Behaviour |
|---|---|---|
| unset or not `"1"` | subagent floor | The conductor issues N parallel `Task` calls in one message, one per Unit. |
| `"1"` | inline Dynamic Workflow | The conductor authors a `Workflow` whose JS owns the per-Unit pipeline and the iteration cap. |
| `"1"` but Workflow tool unavailable | loud-degrade to the floor | The conductor falls back to the floor and passes `--degraded-from ultracode` so the referee emits `SWARM_DEGRADED`. |

Both drivers run the same five per-Unit stages and converge against the same
project check. The difference is purely how the parallel work is dispatched. The
runaway backstop lives in the harness's **Stop-hook ceiling**
(`core/hooks/aidlc-continue-workflow.ts`, the `blockCap()` / `defaultBlockCap()` pair, exposed
as `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`), outside the swarm tool itself. On this
autonomous-Construction path the default ceiling is **8 blocks** (the interactive
default is 2; an explicit `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` overrides both). The
driver seam contract is in
[Skill System § 6](../reference/17-skill-system.md#6-the-swarm-referee-the-driver-seam-and-the-bolt-dag).

One judgment never moves with the driver: a failure **always halts and
re-engages the human**, regardless of autonomy mode, per
`aidlc-common/protocols/stage-protocol-construction.md` ("Halt-and-ask on failure"). When
the referee's `finalize` returns its exit-2 envelope, the conductor takes the
baton back to a human. Hands-off mode removes the happy-path gates while keeping
the failure halt loud.

---

## Where it becomes a code change

The line is clean. Everything above — the autonomy posture rule, the Unit
decomposition that produces the edge block, the project check command and
protected spec, the complementary sensor — is data you author under `core/`
or your project config. You shape Construction without touching code.

The swarm's machinery is code, and shaping it is the Developer Reference's
territory:

- **The referee** `aidlc-swarm.ts` — the stateless `prepare` / `check` /
  `finalize` subcommands. On autonomous Code Generation, `prepare` first
  verifies each Unit's approved Testing Contract and fingerprint; it then forks
  worktrees. The remaining commands run the verdict, re-verify every claimed
  Unit before merge (the lying-conductor guard), snapshot and land reviewed
  record artifacts plus the bound source manifest, serialise AIDLC metadata
  merge-back, and emit the six referee-owned `SWARM_*` events. The conductor
  then invokes `aidlc-worktree merge` for each converged Unit; that separate
  immutable source landing emits `SWARM_SOURCE_MERGED`.
- **The engine** `aidlc-orchestrate.ts` — the deterministic router with exactly
  five subcommands: `next`, `continue`, `report`, `park`, and `team-board`;
  `continue` is internal steering transport and `team-board` is the read-only
  Team Construction query. It decides when a Construction batch is
  eligible for the swarm.
- **The Bolt-DAG parser** — the compile step that reads the edge block into
  `runtime-graph.json`.

The normative contract for all three is
[Skill System § 6](../reference/17-skill-system.md#6-the-swarm-referee-the-driver-seam-and-the-bolt-dag),
and the `bolt_dag` node schema is in
[Runtime Graph](../reference/13-runtime-graph.md). The conductor's own chapter is
[Orchestrator](../reference/03-orchestrator.md).

The user-facing side of what your posture rule governs — the walking-skeleton
gate, the ladder prompt, the autonomy mode — is walked in
[Phases and Stages § Construction](../guide/04-phases-and-stages.md) in the User
Guide, and the six `SWARM_*` audit events you will see in the log are catalogued
in [State and Audit](../guide/10-state-and-audit.md).

---

## Next

- **[Porting to a New Harness](09-porting-to-a-new-harness.md)** — the
  culmination of this guide. You have shaped every data surface in `core/`; the
  last step is rendering that core onto a *new* CLI: one `harness/<name>/`
  directory, a manifest row, a hook adapter, and the package determinism gate.
- Back to [the Harness Engineer Guide overview](00-overview.md) for the full map
  of data surfaces you shape.
- [Developer Reference § Skill System](../reference/17-skill-system.md) for the
  code-level swarm, engine, and Bolt-DAG contract — the line where shaping
  Construction stops being a data edit and becomes a code change.
