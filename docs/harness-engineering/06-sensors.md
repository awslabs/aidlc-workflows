# Sensors

A sensor is a deterministic check that fires automatically on matching writes
or at the stage's approval gate. Where a rule is prose the agent reads
([Rules and the Learning Loop](05-rules-and-the-loop.md)), a sensor is code
that runs — the feedback half of the control loop to the rules' feedforward half. A
rule says "user stories follow Given/When/Then"; a sensor verifies, byte for
byte, that the required headings are present in the file the agent just wrote.

This chapter narrates the work a harness engineer actually does with sensors:
understand the six that ship, author a new manifest, and bind it to the stages
that should run it. The full field-by-field contract lives in
[Sensor System](../reference/07-sensor-system.md) in the Developer Reference —
this chapter points down to it at each schema decision rather than restating it.

---

## What a sensor is

A sensor manifest is a Markdown file with YAML frontmatter, dropped under
`core/sensors/`. The frontmatter is a pure **capability descriptor** — it
says what the check is and how to invoke it. It says nothing about which stages
use it. That binding lives on the stage side, which is the central idea of this
chapter and the reason a manifest and a stage stay loosely coupled.

Three properties define the runtime behavior, and all are worth internalizing
before you author anything:

- **`fire_on: write` runs during authoring.** The `PostToolUse` hook runs each
  matching sensor after a Write or Edit. This is the default when `fire_on` is
  omitted.
- **`fire_on: gate` runs once per deliverable.** Immediately before
  `gate-start` opens its state transaction, the state tool fires each gate-bound
  sensor once for every existing declared deliverable path. The dispatch stays
  outside the transaction because the sensor dispatcher takes the audit lock.
- **Severity controls gate enforcement.** `advisory` outcomes are recorded and
  the gate still opens. A `blocking` binding requires a verified pass: findings,
  unavailable tools, script/dispatcher errors, malformed verdicts, and timeouts
  stop gate entry. An override is a separate logged human decision, not a bare
  flag, and is forbidden in autonomous mode; a successful override records ids,
  optional detail paths, and reasons on `STAGE_AWAITING_APPROVAL`. Blocking
  enforcement applies only to `fire_on: gate` in this release. A write-fired
  sensor may declare `blocking`, but its result remains advisory.

Each fire leaves a row in the intent's `audit/` shards. The event names — exact casing
matters when you grep the log — are **`SENSOR_FIRED`** when a sensor starts,
**`SENSOR_PASSED`** when it clears, and **`SENSOR_FAILED`** when it finds a gap.
A failed row links to a detail file under
`<record>/.aidlc-sensors/<stage-slug>/` (in the intent's record dir) that names the specific gap: the
missing headings, the unreferenced upstream artifact, the lint error. The
user-facing tour of how this looks during a run is in
[Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) in the
User Guide.

---

## The seven sensors that ship

Seven manifests ship under `.claude/sensors/`, each prefixed `aidlc-`:

| Manifest | Dispatch | Checks |
|----------|----------|--------|
| `aidlc-claim-sources.md` | Gate | Every Intent Capture claim carries a resolvable source tag; registered description, scope, and memory values match authoritative inputs; retained assumptions exactly match explicit human confirmation |
| `aidlc-html-shape.md` | Gate | HTML outputs follow the self-contained artifact authoring contract; stages with no HTML outputs pass |
| `aidlc-required-sections.md` | Gate | Markdown and HTML outputs carry the required H2 headings — a generic content-shape check |
| `aidlc-upstream-coverage.md` | Gate | The stage's Markdown and HTML deliverables (evaluated as a set) reference each upstream artifact the stage declares it consumes, by slug, wikilink, or the producing stage's directory path |
| `aidlc-traceability.md` | Write: `**/traceability.json` | Validates stable upstream IDs, statuses, deterministic targets, and derived business-rule orphans |
| `aidlc-linter.md` | Write: `.ts` / `.js` | Wraps your configured linter (ESLint by default) |
| `aidlc-type-check.md` | Write: `.ts` / `.tsx` | Wraps your configured type-checker (`tsc` by default) |

All seven are gated by a `matches:` glob (more on that below): the provenance
check and three document-shape checks scope to the artifact tree (the shipped manifests carry
`**/{aidlc-docs,intents}/**` — the per-intent record tree, with the legacy
`aidlc-docs/` arm kept for a pre-migration project), traceability scopes to
`**/traceability.json`, and the two code-quality checks to their language globs
(`**/*.{ts,js}`, `**/*.{ts,tsx}`).
Read `aidlc-required-sections.md` end to end before authoring your own — it is
the smallest of the seven and shows the whole shape, frontmatter plus prose body.

---

## How binding works: pull authoring

A manifest carries **no stage-targeting field**. There is no `applies_to:` —
the framework deliberately removed it. A stage decides what fires on its
outputs by naming the sensor in its own frontmatter:

```yaml
# core/aidlc-common/stages/construction/code-generation.md
---
slug: code-generation
phase: construction
sensors:
  - linter
  - type-check
  - traceability
---
```

This is **pull authoring**, and it is the same direction as every other binding
in the harness model: the consumer (the stage) names the capability (the
sensor), never the reverse. The `sensors:` list holds bare ids — `linter`, not
`aidlc-linter` — because the id matches the manifest's frontmatter `id:` field,
which equals the filename stem with the `aidlc-` prefix stripped.

The payoff is locality of reference. Open a stage file and you see exactly which
checks fire when that stage runs — you do not have to scan every manifest
hunting for one that claims to target this stage. The same `sensors:`
compartment is described from the stage's side in
[Anatomy of a Stage](01-anatomy-of-a-stage.md); here we are looking at it from
the sensor's side.

At workflow start the compile resolver walks `.claude/sensors/`, indexes every
manifest by id, and for each stage looks up each declared import — throwing
loudly at compile time if an id has no manifest, rather than failing silently
when the stage runs. The resolved per-stage view is baked onto the stage graph
node, and the hook reads it from there at fire time. One consequence to keep in
mind: editing a manifest mid-workflow does **not** change what fires for the
in-flight run. The compile snapshot holds until the next workflow starts. The
full resolver mechanics are in
[How stages import sensors](../reference/07-sensor-system.md#how-stages-import-sensors).

---

## Authoring a new sensor

Adding a sensor is two writes: the manifest, then the binding.

**1. Drop a manifest at `core/sensors/aidlc-<id>.md`.** The filename stem
(minus the `aidlc-` prefix) must equal the frontmatter `id:`. The frontmatter is
short — five required fields and a handful of optional ones:

| Field | Required | What it is |
|-------|----------|------------|
| `id` | yes | kebab-case; equals the filename stem minus `aidlc-` |
| `kind` | yes | `deterministic` is the only accepted value today |
| `command` | yes | the canonical invocation prefix the dispatcher runs |
| `default_severity` | yes | `advisory` or `blocking`; blocking is enforced only for gate dispatch |
| `description` | yes | one-line human description |
| `category` | no | free-form label (the shipped manifests use `document-shape`, `code-quality`) |
| `fire_on` | no | `write` or `gate`; defaults to `write` |
| `matches` | no | write-path filter; for gate dispatch, an omitted glob accepts every declared deliverable |

The `command:` is a **prefix**, not the full argv. The dispatcher appends the
runtime context at fire time — always `--stage <slug>`, then the file flag that
matches the sensor's input shape: `--output-path <path>` for document sensors,
`--file-path <path>` for the code sensors (`linter`, `type-check`). So the
manifest stays a pure capability descriptor and never encodes per-fire flags.
The exact invocation the dispatcher assembles is documented in the
[`command:` invocation contract](../reference/07-sensor-system.md#command-invocation-contract).
For the complete schema — `input_schema`, `output_schema`, `timeout_seconds`,
and the forward-compat policy for unknown keys — see
[Sensor Manifest Schema](../reference/07-sensor-system.md#sensor-manifest-schema).

**2. Bind it by adding the id to a stage's `sensors:` list.** A manifest sitting
in the directory does nothing until a stage imports it. Open the stage you want
the check to fire on, add the bare id to its frontmatter `sensors:` list, and
the binding takes effect at the next compile. To run a sensor on several stages,
add the id to each one — strict-additive, no override layer to reason about. To
stop a sensor firing on a stage, remove the id from that stage. The manifest
never changes; only the import lists do.

The `aidlc-` filename prefix is mandatory for every sensor, custom ones
included — the compile resolver (`loadSensors` in `aidlc-graph.ts`) discovers
manifests with `SENSOR_FILE_REGEX = /^aidlc-([a-z][a-z0-9-]*)\.md$/` and silently
skips any file without the prefix, so it is never discovered and never binds to a
stage. Name your sensor `core/sensors/aidlc-<id>.md` and set `id: <id>`; the
filename-to-id rule applies to the stem after the prefix.

---

## Judgment calls: `fire_on`, `matches`, and `default_severity`

Most of the manifest is mechanical. Two fields carry the real authoring
judgment.

**`fire_on` — when is the useful checking boundary?** Use `write` for fast,
incremental feedback where repeated checks are useful. Use `gate` for
whole-deliverable or cross-file checks that should run once against the final
stage output. Omission means `write`.

**`matches` — what shape of file should this analyze?** For `fire_on: write`,
this glob is the fire filter and is effectively required: the hook fires only
when the written path matches, and an entry with no `matches` never fires.
For `fire_on: gate`, the state tool applies the same capability check to each
existing declared deliverable and dispatches only matching files; omitting
`matches` accepts every one. The
code-quality sensors set it to code globs (`aidlc-linter.md` uses
`**/*.{ts,js}`; `aidlc-type-check.md` uses `**/*.{ts,tsx}`) so they fire only on
code writes and stay quiet on prose; the document-shape sensors scope to the
artifact tree so they fire on any markdown artifact a stage writes.
Decide the file shape your check is meaningful for, and write the narrowest glob
that covers it. An empty `matches: ""` is rejected at parse time. A write-fired
sensor must name the shape; a gate-fired sensor may omit the field to accept
every declared deliverable. Full behavior is in
[`matches` filter](../reference/07-sensor-system.md#matches-filter).

**`default_severity` — signal or enforcement.** `advisory` records outcomes and
continues. `blocking` stops a gate-fired sensor unless the dispatcher returns a
verified pass; findings, unavailable evaluation, malformed output, and timeout
all refuse. The operator may fix the issue or explicitly select
`Override blocking sensors` from the logged two-choice prompt, then retry with
the flag and exact `--user-input`. Autonomous mode cannot override. Blocking on
write-fired sensors is accepted by the schema but remains advisory in this
release. The policy is in
[`default_severity`](../reference/07-sensor-system.md#default_severity).

---

## When the learning loop installs a sensor for you

You do not always author sensors by hand. The §13 learning gate can install one
when you confirm a sensor proposal during a workflow — you decide a deterministic
check should fire on a stage's output, tick it at the gate, and the framework
does the same two-write install you would do manually: it scaffolds a
**project-tier** manifest at your project's `.claude/sensors/aidlc-<id>.md`
(never the shipped framework distribution) and appends the new id to the
originating stage's `sensors:` import list, atomically. That gate-confirmed path
emits a **`SENSOR_PROPOSED`** audit row, so no binding is ever installed
silently. The loop and its `SENSOR_PROPOSED` row are covered in
[Rules and the Learning Loop](05-rules-and-the-loop.md); the user-facing
walk-through is in
[Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) in the
User Guide.

The hand-authored path in this chapter and the loop-installed path produce the
same artifacts — a manifest plus an import-list entry. The difference is who
initiates: you, editing files directly, or the gate, capturing a correction you
made mid-workflow.

---

## Next

[Team Knowledge](07-team-knowledge.md) — give agents the domain context they
load before they work, the last data surface a harness engineer shapes.
