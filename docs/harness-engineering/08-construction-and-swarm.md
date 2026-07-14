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
| The actual autonomy **grant** for this project | the human | the ladder prompt at runtime |
| The swarm **driver** selection | the operator | the `AIDLC_USE_SWARM` environment variable |
| The convergence **verdict**, merge-back, and audit | a tool | `aidlc-swarm.ts` (code → Developer Reference) |

The three rows marked "you" are the body of this chapter. The other three are
covered because you need to understand the runtime your data shapes, but you
author none of them.

---

## The autonomy posture — your real lever, written as a rule

The first thing a team wants to control is how much hand-holding Construction
demands. The shipped default lives in the org rule you author at
`core/memory/org.md` under the `## Walking Skeleton` heading
(`org.md:28-42`). Read it as the framework's stance:

- The **walking-skeleton Bolt runs first** for greenfield scopes — `mvp`,
  `enterprise`, `feature`, `poc`, `workshop`, `infra`. Bolt 1 is solo and gated,
  and the user approves it before the remaining Bolts run.
- The **skeleton ceremony is skipped** for incremental scopes — `bugfix`,
  `refactor`, `security-patch`. There is nothing to bootstrap on an existing
  codebase, so the first Bolt runs like any other.
- After Bolt 1 ships, the **ladder prompt** fires once: "How should the
  remaining Bolts run?" with two options, continue autonomously or gate every
  Bolt. The chosen answer persists as `Construction Autonomy Mode` in
  the intent's `aidlc-state.md` (under its record dir).

You shape this posture the same way you shape any rule, through the
strict-additive layers from [Rules and the Learning Loop](05-rules-and-the-loop.md):
edit `team.md` for a team-wide stance, or `project.md` for a durable
deviation on one project. You leave `org.md` alone — it is framework-shipped
and inherited.

What you set is the **default and the guidance**. The grant stays with the human
at the ladder prompt, who makes the per-project call. Your rule prose is what the
agent reads going into that prompt, so it frames the recommendation; the judgment
of whether *this* project runs hands-off stays with the person at the gate. That
is the determinism-knowledge-judgment line drawn straight through one prompt: you
author the standing guidance (data), the agent presents it (knowledge), the human
decides (judgment).

### Worked example — make your team gate every Bolt by default

Suppose your team is new to autonomous Construction and wants the conservative
posture: every Bolt reviewed, no hands-off runs, until trust is earned. You add a
bullet under `## Walking Skeleton` in `core/memory/team.md`:

```markdown
## Walking Skeleton

Until our team has shipped three clean autonomous batches, the recommended
answer at the ladder prompt is **gate every Bolt**. Reviewers see each Bolt's
diff before the next one starts. Revisit this default once our convergence
checks have proven reliable.
```

This stacks on top of the org default — the skeleton-first / skip-ceremony split
is unchanged, and your team prose joins the agent's context at the ladder prompt.
The human can still pick "continue autonomously" if a given project warrants it;
your rule shapes the recommendation while leaving the choice open. The change
bites at the next workflow's compile boundary, exactly like every other rule edit
— an edit mid-workflow does not retroactively change the run in flight.

A team graduating to hands-off Construction for a trusted scope writes the mirror
bullet: "For `feature` scope on this codebase, the recommended ladder answer is
continue autonomously once the walking skeleton is green." Same file, same
heading, opposite recommendation.

---

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

The parallel surface itself is the five **per-Unit** Construction stages, each
declaring `for_each: unit-of-work` in its frontmatter:

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
runs** — `enterprise`, `feature`, `mvp`, and `workshop`. The incremental scopes
(`bugfix`, `refactor`, `security-patch`) and `poc`/`infra` never run
`units-generation`, so they produce no edge block, carry no `bolt_dag`, and run
Construction single-pass with nothing for the swarm to fan out across. Shape the
swarm where the work is genuinely multi-Unit, and treat hands-off Construction as
a property of the multi-Unit greenfield scopes rather than every scope.

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
`## Testing Posture` rule in `org.md:44-58` already sets per-scope test
floors (for example, `mvp`/`feature` get tests-alongside-code at 80% coverage);
authoring a stricter posture at `team.md` is how you raise the bar the
check enforces.

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
(`core/hooks/aidlc-stop.ts`, the `blockCap()` / `defaultBlockCap()` pair, exposed
as `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`), outside the swarm tool itself. On this
autonomous-Construction path the default ceiling is **8 blocks** (the interactive
default is 2; an explicit `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` overrides both). The
driver seam contract is in
[Skill System § 6](../reference/17-skill-system.md#6-the-swarm-referee-the-driver-seam-and-the-bolt-dag).

One judgment never moves with the driver: a failure **always halts and
re-engages the human**, regardless of autonomy mode, per
`aidlc-common/protocols/stage-protocol.md:125` ("Halt-and-ask on failure"). When
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
  `finalize` subcommands that fork worktrees, run the verdict, re-verify every
  claimed Unit before merge (the lying-conductor guard), serialise the
  merge-back, and emit the six `SWARM_*` audit events.
- **The engine** `aidlc-orchestrate.ts` — the deterministic router with exactly
  three subcommands: `next`, `report`, and `park`; it decides when a
  Construction batch is eligible for the swarm.
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
  directory, a manifest row, a hook adapter, and the byte-parity gate.
- Back to [the Harness Engineer Guide overview](00-overview.md) for the full map
  of data surfaces you shape.
- [Developer Reference § Skill System](../reference/17-skill-system.md) for the
  code-level swarm, engine, and Bolt-DAG contract — the line where shaping
  Construction stops being a data edit and becomes a code change.
