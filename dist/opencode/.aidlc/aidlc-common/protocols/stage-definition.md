# Stage Definition Format

This file is the authoritative contract for the shape of every stage file
under `.aidlc/aidlc-common/stages/`. The schema (`stage-schema.ts`), the
YAML parser (`parseStageFrontmatter` in `lib.ts`), and the YAML stage
files all implement against this document.

YAML frontmatter at the top of every stage `.md` is authoritative. The
build step `bun aidlc-graph.ts compile` regenerates
`.aidlc/tools/data/stage-graph.json` from the YAML sources; the runtime
reads the compiled JSON via the unchanged `loadStageGraph()` API at
`lib.ts:282-289`. The CI drift check `aidlc-graph compile --check` fails
the build if the JSON diverges from the YAML.

---

## File layout

```yaml
---
# YAML frontmatter — 14 top-level authored fields
---

# [Stage Title]

MANDATORY: Follow stage-protocol.md for approval gates, question format,
and completion messages.

## Steps
# prose body — required, always populated

## Sensors
# reserved — parser tolerates absence; populated when the sensor subsystem ships

## Learn
# reserved — parser tolerates absence; populated when the loop-driver subsystem ships
```

---

## Authored fields

Fourteen top-level authored fields (plus three `consumes[]` subfields).
All required unless marked optional. The schema in `stage-schema.ts`
copies this table verbatim.

| Field | Type | Required | Enum / Constraint |
|-------|------|----------|--------------------|
| `slug` | string | yes | kebab-case; must match filename stem |
| `phase` | string | yes | `initialization` \| `ideation` \| `inception` \| `construction` \| `operation` (lowercase) |
| `execution` | string | yes | `ALWAYS` \| `CONDITIONAL` |
| `condition` | string | yes | free-form; describe always-on rationale for `ALWAYS`, branching condition for `CONDITIONAL` |
| `lead_agent` | string | yes | agent slug; validated dynamically against `.aidlc/agents/*.md` via `loadAgents()` — no hardcoded enum |
| `support_agents` | string[] | yes | empty list allowed; each entry a valid agent slug. Renamed from prose `Supporting Agents:` (format-only rename) |
| `mode` | string | yes | `inline` \| `subagent` \| `pipeline` \| `mob` \| `agent-team`. The stage's **communication topology** — who talks to whom while the body runs. `inline` (conductor adopts every voice, zero dispatches), `subagent` (hub-and-spoke: the conductor dispatches the lead for the draft, then each `support_agents[]` entry as a real, mutually-blind spoke, then the lead to integrate), `pipeline` (chain: the links collectively author the artifacts, each link seeing all upstream work and advancing the work product directly; the final link leaves the artifacts complete), and `mob` (mesh: one room, cross-talk, dissent recorded; judgment-call objections surface to the human mid-stage) are active; `pipeline`/`mob` require non-empty `support_agents`. Writing model: each dispatched support agent writes its own contribution file (`contributions/<agent-slug>.md`, stage-protocol §11); the lead alone edits the stage's `produces[]` artifacts; on `mob`/`subagent`-with-supports stages the engine refuses approval while a declared collaborator's contribution file is missing (the ensemble completion evidence). **`agent-team` is reserved** — the future native-bus transport for mesh collaboration (`mob` is the portable mode); no stage declares it until a consumer ships. Orchestrator code reading `mode` MUST handle `agent-team` explicitly (at minimum throw "not yet implemented") — do not fall through to a default path. The review loop is NOT a mode: `reviewer` + `reviewer_max_iterations` deliver the two-party critique topology on every mode (stage-protocol.md §12a) |
| `for_each` | string | optional | artifact slug; stage runs once per instance of that artifact. Omit for once-per-workflow stages. Doctor validates the artifact is produced by an upstream stage |
| `workspace_requires` | boolean | optional | Default `false`. `true` marks a stage that must write source code to the workspace root, not just planning docs under the per-intent record dir. The stage-completion artifact guard (`aidlc-state.ts` approve/advance/finalize/complete-workflow) then requires a file outside the `aidlc/` workspace tree and the harness dir before the stage can complete: a stage that wrote only its `produces[]` markdown but no code is refused. Today only `code-generation` declares it |
| `produces` | string[] | yes | empty allowed; lowercase-kebab artifact names — see [Artifact Vocabulary](../../../../docs/reference/16-artifact-vocabulary.md) for rules and the live registry tool |
| `consumes` | object[] | yes | empty allowed; each entry `{artifact, required, conditional_on?}` |
| `consumes[].artifact` | string | yes per entry | lowercase-kebab |
| `consumes[].required` | boolean | yes per entry | Scoped to the active plan. `true` means "if the producing stage runs, this consume must be satisfied" — not a global assertion that the artifact always exists. Scopes that skip the producer (e.g., `bugfix` skipping `units-generation`) make the consume moot; the stage body handles graceful degradation. The reserved `when:` primitive will eventually let authors express richer predicates |
| `consumes[].conditional_on` | string | optional | `brownfield` \| `greenfield`. Omit for unconditional consumes — no `always` value |
| `requires_stage` | string[] | yes | empty allowed; each entry a known stage slug. Two roles: (1) semantic data dependency; (2) presentation-order edge for stages with no semantic link but a fixed display order. Primary input to computed `display_order` |
| `scopes` | string[] | optional | each entry a scope name with a matching `.aidlc/scopes/aidlc-<name>.md` file. Naming a scope marks this stage EXECUTE under that scope; absence marks it SKIP. The per-stage transpose of the scope membership matrix — `aidlc-graph compile` reads every stage's `scopes:` and emits the compiled EXECUTE/SKIP grid (`tools/data/scope-grid.json`). The 3 initialization stages name all scopes (always EXECUTE). Absent and `[]` are treated identically |
| `inputs` | string | yes | human prose (preserves today's `**Inputs**:` line) |
| `outputs` | string | yes | human prose (preserves today's `**Outputs**:` line). **Non-load-bearing at runtime** — the engine NEVER reads `outputs:` for path resolution; it resolves the node's `produces[]` artifact NAMES against the **active intent's record dir** at emit time (see "Artifact paths are engine-resolved" below). Author `outputs:` as relative artifact NAMES (or `<phase>/<stage>/<name>.md` shapes); do NOT hardcode a workspace root (`aidlc-docs/…` or `aidlc/spaces/…`) — it would read FALSE the moment the record re-roots per intent |

---

## Computed fields (NOT authored)

Two fields appear in `stage-graph.json` but are derived by the compile step,
not authored in YAML.

| Field | Derivation |
|-------|------------|
| `display_order` | `<phase-prefix>.<sequence>`. Phase prefix: `initialization=0`, `ideation=1`, `inception=2`, `construction=3`, `operation=4`. Sequence: topological sort of `requires_stage` edges filtered to this phase, slug-alphabetical tiebreak for parallel stages |
| `name` | Title-case of the slug (hyphens → spaces), or the H1 heading of the stage file |

---

## Worked example

The `scope-definition` stage's YAML frontmatter. Use this as a
copy-paste template when authoring a new stage; the schema in
`stage-schema.ts` validates against the same shape.

```yaml
---
slug: scope-definition
phase: ideation
execution: ALWAYS
condition: Always executes — defines the scope boundary and prioritized backlog
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-delivery-agent
mode: inline
produces:
  - scope-document
  - intent-backlog
  - scope-definition-questions
consumes:
  - artifact: intent-statement
    required: true
  - artifact: feasibility-assessment
    required: false
  - artifact: constraint-register
    required: false
requires_stage:
  - intent-capture
scopes:
  - enterprise
  - feature
  - mvp
inputs: Intent statement, feasibility assessment, constraint register
outputs: scope-document.md, intent-backlog.md, scope-definition-questions.md (under this stage's record dir, engine-resolved)
---
```

Note: no `display_order` (computed), no `for_each` (stage runs once per
workflow — field omitted). The `outputs:` line names the artifacts as relative
NAMES, not rooted paths — the engine resolves the root (see below).

---

## Artifact paths are engine-resolved (no stage `.md` hardcodes a root)

A stage emits relative artifact **names** (its `produces[]`); the engine
resolves them to canonical write paths at directive-emit time, **against the
active intent's record dir** — `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/<phase>/<stage>/<name>.md`
(a pre-workspace project is migrated to this layout on first touch — there is no
flat-root resolution path post-migration). The resolver is `resolveArtifactPath` / `memoryPathFor` in
`aidlc-orchestrate.ts`, threaded with the active intent's relative record dir
(`relativeRecordDir` in `aidlc-lib.ts`). **No stage `.md` hardcodes a workspace
root** — the `outputs:` frontmatter and any "Create `…/…`" prose are
human-facing documentation only; the engine hands the conductor the resolved
`produces[]` path. Treat a rooted path literal in a stage file as a doc bug, not
a behavior contract.

The same emit-time resolution splits the consumed inputs by presence: the
directive's `consumes` lists only resolved paths that exist on disk, and any
REQUIRED declared input whose file is absent moves to `consumes_absent`,
annotated `expected: true` when the producing stage is off the active scope's
path (the scope deliberately skipped it — see `consumes[].required` above) or
`expected: false` when a producer is on the path but the file is still
missing. A `required: false` consume that is absent is simply dropped — an
optional input that does not exist is not an input, never a gap. The
conductor is never pointed at a path that cannot be read; absence-by-design
arrives as data, not as a failed read.

---

## Body compartments

Three compartments, declared in this order. Only `## Steps` is populated
today; `## Sensors` and `## Learn` are reserved heading slots that
future releases will populate.

| Compartment | Today | Future | Parser rule |
|-------------|-------|--------|-------------|
| `## Steps` | Required, populated | Unchanged | Always present |
| `## Sensors` | Reserved, absent | Populated (deterministic sensors) | Parser tolerates absence |
| `## Learn` | Reserved, absent | Populated (loop drivers, observer rules) | Parser tolerates absence |

**Body structure rule:** all existing body content lives under
`## Steps` and nothing else. The parser tolerates absence of the
`## Sensors` and `## Learn` headings.

---

## Compile + drift invariant

`aidlc-graph compile` reads all stage YAML sources and regenerates
`.aidlc/tools/data/stage-graph.json`. Consumers continue to read the compiled
JSON via `loadStageGraph()`.

`aidlc-graph compile --check` re-runs the compile in memory, diffs against
the checked-in JSON, and exits non-zero if different. CI runs this on every
change. Drift is impossible if the check passes.

`aidlc-graph` implements this contract. See
`aidlc-graph.ts` in the harness tools directory for the library and CLI
(8 exports: loadGraph, producersOf, consumersOf, topoSort, findCycles,
subgraphForScope, validateScope, artifactsRegistry; plus compile, compile
--check, and seven query subcommands).

---

## Future extensions — reserved namespace

Fields not active today but reserved by intent. No stage declares
them; the schema rejects unknown keys. Naming them here prevents
future contributor additions from colliding with planned primitives.

| Key | Purpose |
|-----|---------|
| `when` | Structured replacement for prose `condition`. Supersedes `consumes[].conditional_on` and generalises the scope-aware semantics of `consumes[].required` with richer predicates (e.g. `producer-in-plan`, `mode == brownfield`) |
| `on_failure` | Declarative error recovery (jump-back, retry-with-adjusted-inputs). Moves revision semantics out of `stage-protocol-recovery.md` prose |
| `blocks_on` | Completion dependency without data read. Splits today's overloaded `requires_stage` (which conflates "I consume your output" with "I run after you") |
| `timeout`, `retry` | Execution budgets. Homed in sensor bindings and loop config, not stage frontmatter (mirrors Claude Code's task-API design — no primitive-level retry/timeout) |

Precedent for the reserved-namespace pattern:
`docs/reference/06-hooks-and-tools.md` declares audit event names
`ERROR_LOGGED` and `RECOVERY_COMPLETED` the same way.

**Consumer contract for `mode`:** orchestrator code reading the `mode` field
must handle `agent-team` explicitly. At minimum, throw "mode agent-team not
yet implemented". Do not fall through to a default execution path — silent
fallthrough on enum extension is a known foot-gun flagged by review.

**Swarm-trigger coupling:** the autonomous Construction swarm fires on a
field match (`for_each: unit-of-work` + `mode: subagent`). Re-moding the
per-unit build stage to any other topology silently takes it off the swarm
path (units build serially). `aidlc-graph compile` emits an advisory on
stderr when it sees that shape.

---

## Cross-references

- `stage-protocol.md` — runtime execution behaviour (approval gates, question
  flow, state tracking). This spec covers file format; stage-protocol covers
  behaviour.
- `SKILL.md` — orchestrator routing and dispatch.
- `docs/reference/15-stage-definition.md` — narrative counterpart for
  contributors.
