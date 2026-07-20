# Sensor System

> Audience: Tier 2/3 (team adopter, framework contributor).

This chapter is the **schema reference** for AI-DLC sensor manifests —
the deterministic checks that fire on writes to a stage's outputs.
Sensors are the feedback half of the control loop; rules are the
feedforward half (see [Rule System](08-rule-system.md), the next
chapter). The [Plane Architecture](02-plane-architecture.md) chapter
frames both as control-plane inputs that the compile resolves into each
stage node.

This chapter covers the manifest *file format* — what a sensor manifest
contains, how stages import sensors, and how the four shipped manifests
are configured. For the user-facing view of how sensors fire during a
workflow, see [Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md)
in the User Guide.

> **Path convention.** `<record>/` below = the active intent's record dir,
> `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (a compact UTC date prefix
> plus a short kebab-case label, so record dirs sort chronologically; the
> canonical id is the UUIDv7 stored in the `intents.json` registry row). Note the two document-shape
> sensors' `matches` glob in the shipped manifests still carries the legacy
> artifact-tree path (quoted verbatim below where the schema is documented).

For runtime behaviour see [Stage Protocol](04-stage-protocol.md). The
file-format parallel for stage definitions lives at
[Stage Definition](15-stage-definition.md).

---

## Manifest location and filename

Sensor manifests live at:

```
dist/claude/.claude/sensors/aidlc-<id>.md
```

Every framework-shipped manifest carries the `aidlc-` filename prefix
(matching the broader framework-file convention). The frontmatter `id:`
field MUST equal the filename stem with the `aidlc-` prefix removed and
the `.md` suffix stripped:

| Filename | Required `id:` |
|---|---|
| `aidlc-required-sections.md` | `required-sections` |
| `aidlc-linter.md` | `linter` |

The filename↔id rule is enforced by `tests/unit/t86-sensor-manifest-schema.sh`.
The `aidlc-` prefix is **mandatory for all sensors, including custom
user-shipped ones**: the compile resolver discovers manifests with
`SENSOR_FILE_REGEX = /^aidlc-([a-z][a-z0-9-]*)\.md$/` (`loadSensors` in
`aidlc-graph.ts`), so any file without the prefix is silently skipped and never
binds to a stage. Name a custom sensor `aidlc-<id>.md` and set `id: <id>`.

---

## Sensor Manifest Schema

Every manifest is a Markdown file with YAML frontmatter and a body. The
frontmatter is the structured contract — a pure capability descriptor —
and the body is human prose documenting the check. Manifests describe
*what the sensor is*, not which stages use it; the relationship lives
on the stage side via the stage's frontmatter `sensors:` field (see
[How stages import sensors](#how-stages-import-sensors) below).

```yaml
---
id: required-sections                       # required
kind: deterministic                          # required
command: bun .claude/tools/aidlc-sensor-required-sections.ts   # required
default_severity: advisory                   # required
description: Checks that stage output ...    # required
category: document-shape                     # optional
matches: "**/{aidlc-docs,intents}/**"                  # optional capability filter
input_schema:                                # optional
  output_path: string
  stage_slug: string
output_schema:                               # optional
  pass: boolean
  missing_headings: string[]
timeout_seconds: 5                           # optional
---

# required-sections sensor

<body — prose documenting default mode, override mode, failure mode>
```

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | ✓ | kebab-case string | Equals filename stem minus `aidlc-` prefix; cross-referenced from rule files' `pairing:` field (see [Rule System](08-rule-system.md)). |
| `kind` | ✓ | enum | Only `deterministic` is accepted today; `llm` reserved for the v0.11.0 LLM-dispatch chapter. See [`kind` enum](#kind-enum) below. |
| `command` | ✓ | string | Canonical invocation prefix — each shipped sensor names its own per-sensor script (e.g. `bun .claude/tools/aidlc-sensor-required-sections.ts`). The dispatcher (`aidlc-sensor.ts`) appends `--stage <slug>` plus the file flag matching the sensor's input shape: `--output-path <path>` for document sensors, `--file-path <path>` for the code sensors (`linter`, `type-check`). |
| `default_severity` | ✓ | enum | Only `advisory` is accepted today; `blocking` reserved for the future ralph-driver work. |
| `description` | ✓ | string | One-line human description. |
| `category` | optional | string | Free-form descriptive label (the four shipped manifests use `document-shape` and `code-quality`; not a closed enum). |
| `matches` | optional | glob string | Capability filter consumed by the PostToolUse hook at fire time. See [`matches` filter](#matches-filter) below. |
| `input_schema` | optional | object | Advisory today; future LLM dispatch will use it as a templating contract. |
| `output_schema` | optional | object | Advisory today; future LLM dispatch will use it as a parsing contract. |
| `timeout_seconds` | optional | int | Per-fire wall-clock cap. |

---

## `kind` enum

The `kind` field declares the dispatch mechanism. The schema accepts
exactly one value today:

- `deterministic` — the manifest's `command:` is a self-contained
  shell invocation that exits 0 (pass) / non-zero (fail) and writes
  structured detail to a known path.

`llm` is **reserved for the LLM-dispatch chapter** (v0.11.0+). Until that
chapter ships, consumers MUST reject `kind: llm` at parse time.
Reservation is enforced at write time: shipping a `kind: llm` manifest
today is a manifest-author error that the parser rejects.

Unknown values for `kind` (anything other than `deterministic`) are
rejected at parse time. Forward-compat applies to *unknown keys*
(see [Forward-compat policy](#forward-compat-policy)) — not to unknown
values for known keys.

---

## How stages import sensors

Pull authoring: each stage's frontmatter declares the sensors it uses.
The compile resolver looks each declared id up in the manifest registry
and bakes a `sensors_applicable` array onto the stage's compiled graph
node. Authoring direction is locality-of-reference — open a stage file
and you see exactly which checks fire when the stage runs.

```yaml
# dist/claude/.claude/aidlc-common/stages/construction/code-generation.md
---
slug: code-generation
phase: construction
# ...
requires_stage: [...]
sensors:
  - linter
  - type-check
inputs: ...
outputs: ...
---
```

`sensors:` is a list of bare ids — the ids match each manifest's
frontmatter `id:` field, which (per the filename↔id contract) equals the
filename stem minus the `aidlc-` prefix. The compile resolver:

1. Walks `dist/claude/.claude/sensors/`, parses every
   `aidlc-<id>.md` manifest.
2. Indexes manifests by id for O(1) lookup at resolution time.
3. For each stage, looks each declared import id up; throws on unknown
   (loud failure at compile, not silent at fire time).
4. Copies the manifest's `matches` filter verbatim into the resolved
   `sensors_applicable[]` entry.
5. Emits the per-stage resolved array on the canonical
   `data/stage-graph.json` (FIELD_ORDER pinned: after `rules_in_context`).

The runtime PostToolUse hook (`aidlc-sensor-fire.ts`) reads
`sensors_applicable` off the graph node — never re-opens the manifest.
`matches` is
compile-snapshotted: a manifest edit during the workflow does NOT
change what fires for the in-flight workflow's writes (BGP-stability
property — see [Plane Architecture](02-plane-architecture.md)).

### Per-stage sensor matrix (32 framework stages)

| Stages | `sensors:` |
|---|---|
| 3 initialization (workspace-scaffold, workspace-detection, state-init) | `[]` (deterministic setup, no agent-authored markdown) |
| 7 ideation, 8 inception, 7 operation markdown stages + `code-generation` | `[required-sections, upstream-coverage]` for markdown stages; `[linter, type-check]` for `code-generation` (code only) |
| `build-and-test` | `[required-sections, upstream-coverage, type-check]` (linter intentionally omitted — build runs canonical lint) |
| 5 construction-design (ci-pipeline, functional-design, infrastructure-design, nfr-design, nfr-requirements) | `[required-sections, upstream-coverage, linter, type-check]` (markdown design with code samples) |

Forks customise stages by editing the stage's `sensors:` list directly
— the binding lives next to the thing being customised. A manifest is a
pure capability descriptor; it carries no stage-targeting field (there is
no `applies_to:` — pull authoring removed it). The strict-additive runtime
applies: if a fork wants a sensor on a stage, it imports it; if it does
not, it omits it. There is no override layer to reason about.

---

## `matches` filter

`matches` is an optional top-level capability descriptor on the
manifest. It declares the glob shape of files the sensor can analyse —
*"this sensor analyses files matching this glob"* — and is consumed by
the PostToolUse hook at fire time, not by the resolver at compile time.

| Manifest | `matches` |
|---|---|
| `aidlc-required-sections.md` | `**/{aidlc-docs,intents}/**` |
| `aidlc-upstream-coverage.md` | `**/{aidlc-docs,intents}/**` |
| `aidlc-linter.md` | `**/*.{ts,js}` |
| `aidlc-type-check.md` | `**/*.{ts,tsx}` |

`matches` **is** the fire filter — it is not optional in practice. The hook
compares the path being written against the glob and fires only on a match;
an entry **without** a `matches` glob never fires at all (`aidlc-sensor-fire.ts`:
`if (!entry.matches) continue`). All four shipped manifests therefore declare
one — the two document-shape sensors scope to the artifact tree (the shipped
manifests carry the `matches` value shown above), the two
code-quality sensors to their language globs. The compile resolver copies
`matches` verbatim into the per-stage `sensors_applicable[]` entry; the hook
reads the snapshotted value off the graph node.

Empty string (`matches: ""`) is rejected at parse time. Because an absent glob
means the sensor never fires, a manifest must declare the glob shape it applies
to — there is no "fires on everything" mode.

### Cross-references between rules and sensors

Rule files use `pairing: aidlc-required-sections` (with the `aidlc-`
prefix) to feed-forward into a sensor; the sensor manifest's `id:` is
`required-sections` (no prefix). The doctor coverage check normalises
by stripping the `aidlc-` prefix from the rule's `pairing:` value
before matching against the manifest `id`.

---

## `default_severity`

`advisory` is the only valid value in v0.5.0. An advisory sensor
failure produces an audit row + a detail file but does NOT block the
stage's gate or the user's workflow.

`blocking` is reserved for the future ralph driver. Until
the driver lands, the field is structurally present but semantically
single-valued.

---

## `command:` invocation contract

The manifest's `command:` is the **canonical invocation prefix**, not
the full argv — each shipped sensor names its own per-sensor script. The
dispatcher (`aidlc-sensor.ts`) appends runtime context at fire time: always
`--stage <stage-slug>`, then the file flag matching the sensor's input shape —
`--output-path <file>` for document sensors, `--file-path <file>` for the code
sensors (`linter`, `type-check`):

```
<command> --stage <stage-slug> --output-path <file-being-written>   # document sensor
<command> --stage <stage-slug> --file-path   <file-being-written>   # code sensor
```

So a manifest with:

```yaml
command: bun .claude/tools/aidlc-sensor-required-sections.ts
```

invoked against `requirements-analysis` writing the requirements artifact in the
intent's record dir is dispatched as:

```
bun .claude/tools/aidlc-sensor-required-sections.ts \
  --stage requirements-analysis \
  --output-path aidlc/spaces/default/intents/260624-inventory-api/inception/requirements-analysis/requirements.md
```

The manifest does not encode the per-fire flags. The dispatcher
appends them; the manifest stays a pure capability descriptor.

---

## Gate-ritual handoff (surface stdout / selections-file in)

The §13 learning gate is tool-as-actor. The round-trip between the
deterministic tool (`aidlc-learnings.ts`) and the conductor (the live
`/aidlc` session) has two legs, with a knowledge step and a judgement
step between them:

1. **`surface` (stdout).** `bun .claude/tools/aidlc-learnings.ts surface
   --slug <stage-slug>` reads the stage's `memory.md` and prints structured
   JSON: `candidates[]` (one per non-blank Interpretation / Deviation /
   Tradeoff entry, each carrying `id`, `source_heading`, `ts`, `summary`,
   `context`, `default_scope: "project"`) plus a read-only
   `parked_open_questions[]`. No AskUserQuestion field names — pure domain
   data. Open questions never become candidates (they are research items).
2. **Conductor renders the AskUserQuestion (knowledge).** One option per
   candidate (label = the candidate `summary`, verbatim; description = the
   derived destination, e.g. `→ memory/project.md (Deviation)` plus
   a promote-to-team affordance). After `multiSelect`, the conductor
   correlates each kept label back to its candidate `id` + `source_heading`.
   It then always asks "Anything to add for next time?"; any free-text gets
   a single heading-pick AUQ (Interpretation / Deviation / Tradeoff / Open
   question) — the heading pick is the user's only classification, and the
   destination is derived from it.
3. **Admission conflict-check (knowledge → orchestrator-LLM; gates which
   selections reach persist).** For each kept learning, the conductor
   compares the single proposed dated entry against `org.md`'s
   matching `## <section>` (the single-line variant of the §5 admission
   gate). On a contradiction the conductor surfaces the conflicting org sentence inline
   and the user revises / skips / escalates (judgement → user; no
   user-override path). Only conflict-clear or user-escalated selections
   proceed. Sensor manifests have no org-section analogue and skip the check.
4. **`persist` (selections-file in).** The conductor writes the kept
   selections to `<record>/.aidlc-learnings/<slug>-selections.json` (in the intent's record dir)
   (gitignored) and calls `bun .claude/tools/aidlc-learnings.ts persist
   --slug <slug> --selections-json <path>`. The tool is the deterministic
   writer — it never judges conflicts; it routes each learning as a practice to
   `aidlc/spaces/<active-space>/memory/{project,team}.md` and, for a sensor selection, does the
   two-write install (manifest + originating stage `sensors:` frontmatter)
   inside one `withAuditLock`, then emits `RULE_LEARNED` / `SENSOR_PROPOSED`.

The selections-file is the replay artefact: a crashed persist replays the
same JSON without re-prompting the human (content-presence idempotency via a
`<!-- cid:<slug>:<id> -->` marker per written line).

---

## Defaults for scaffolded manifests

When a sensor proposal is confirmed at the gate, the gate-ritual tool
scaffolds a new **project-tier** manifest at
`<project>/.claude/sensors/aidlc-<id>.md` — never the shipped framework
distribution (a per-project learning loop must not mutate the framework;
framework-distribution paths are rejected). Fields default to:

| Field | Default | Note |
|---|---|---|
| `id` | derived from user free-text (kebab-case it) | |
| `kind` | `deterministic` | sole accepted value today |
| `command` | `bun .claude/tools/aidlc-sensor-<id>.ts` | placeholder per-sensor script; user updates to the script that implements the check |
| `default_severity` | `advisory` | sole accepted value today |
| `description` | from user free-text | |
| `category` | `""` | user fills if desired |
| `matches` | a glob is required to fire | scaffold prompts for the glob shape the sensor applies to (an artifact-tree glob or a code glob like `**/*.ts`); an entry with no `matches` never fires |
| `input_schema` | `{ output_path: string, stage_slug: string }` | matches the dispatcher-appended flags |
| `output_schema` | `{ pass: boolean }` | minimum structure dispatcher relies on |
| `timeout_seconds` | `30` | conservative default; tune for slower dispatchers |

After scaffolding the manifest, the gate-ritual tool — inside the same
`withAuditLock` transaction — appends the new id to the originating
stage's `sensors:` frontmatter list (the pull-authoring two-write
install). The sensor is fully wired when the next workflow compiles. This
is the one sanctioned stage-frontmatter edit: it grows the import list
(immutable in shape, not in contents), never the `## Steps` / `## Sensors`
/ `## Learn` body.

The four shipped manifests illustrate the variation these defaults
later evolve into: `aidlc-required-sections.md` and
`aidlc-upstream-coverage.md` use `timeout_seconds: 5` with their
artifact-tree `matches` glob (the value shown in the `matches` table above);
`aidlc-linter.md` uses `30` with `matches: "**/*.{ts,js}"`;
`aidlc-type-check.md` uses `60` with `matches: "**/*.{ts,tsx}"`.

---

## Forward-compat policy

Consumers of sensor manifests (compile, dispatcher, gate-ritual
scaffolding, doctor) MUST tolerate **unknown manifest keys**. If a
future release adds an optional `cool_new_field:`, older consumers
parse the manifest, ignore the field, and continue. This allows
additive evolution of the schema without breaking forks or pre-upgrade
workspaces.

Forward-compat does NOT apply to unknown values for known keys. As
documented in [`kind` enum](#kind-enum) above, an unknown value for
`kind` is rejected at parse time. The same principle applies to the
other enum-shaped fields (`default_severity`).

---

## Reserved for future releases

A few sensor capabilities are reserved in the schema but not yet
active, so the field shape is stable when they land:

- **`kind: llm` dispatch** — LLM-evaluated sensors (v0.11.0). The
  schema accepts `kind` today but rejects any value other than
  `deterministic` at parse time.
- **`blocking` severity** — a sensor failure that halts the gate
  rather than logging advisory telemetry (v0.10.0 ralph driver). Today
  `advisory` is the sole accepted value.

Both are enforced at write time: shipping a manifest that uses them now
is an author error that the parser rejects.

## Next Steps

- **Rules** — the feedforward half of the control loop pairs with these
  sensors via the `pairing:` field. See [Rule System](08-rule-system.md).
- **The user-facing learning loop** — how sensor proposals are surfaced
  and confirmed at the gate, and how a confirmed proposal scaffolds a
  new manifest. See [Rules and the Learning
  Loop](../guide/09-rules-and-the-learning-loop.md) in the User Guide.
- **The compile boundary** — how `sensors_applicable` is resolved once
  at workflow start and read off the graph node at fire time. See
  [Plane Architecture](02-plane-architecture.md).

The schema above plus the four shipped manifests in
`dist/claude/.claude/sensors/` are the working examples.
