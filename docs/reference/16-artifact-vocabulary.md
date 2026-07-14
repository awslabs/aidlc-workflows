# Artifact Vocabulary

This chapter is the written rule for AI-DLC artifact names — the canonical
strings that appear in each stage's `produces:` and `consumes[].artifact:`
YAML frontmatter. It covers the naming shape, the collision-resolution policy,
the filesystem-path convention, and how to view the live registry from the
command line.

The registry itself is **derived**, not written. The authoritative source
for "which canonical names exist" is the `produces[]` field on every stage
file, unioned with each stage's `optional_produces[]` (artifacts a stage may
conditionally write per unit, see the field reference in
`15-stage-definition.md`), so a conditionally-produced name stays registered
and resolvable to its producer. A helper in
`dist/claude/.claude/tools/aidlc-graph.ts` reads the compiled stage graph and
returns the union as a set — the same pattern used for scopes
(`validScopes()` at `aidlc-lib.ts:772`) and for agents (`loadAgents()` at
`aidlc-lib.ts:794`). Keeping the registry out of this chapter prevents the
drift that parallel hand-maintained lists invite.

---

## What an artifact is here

An artifact is a **canonical identifier** declared by exactly one
producing stage in its YAML frontmatter. Other stages reference the same
identifier in `consumes[]` to declare a read dependency. The identifier is
a short kebab-case string — no file extension, no folder prefix, no slash.

Concrete example from milestone 4's worked example in
`dist/claude/.claude/aidlc-common/protocols/stage-definition.md`:

```yaml
slug: scope-definition
# ...
produces:
  - scope-document
  - intent-backlog
  - scope-definition-questions
consumes:
  - artifact: intent-statement
    required: true
  - artifact: feasibility-assessment
    required: false
```

Here `scope-document`, `intent-backlog`, `scope-definition-questions` are
artifacts the scope-definition stage produces; `intent-statement` and
`feasibility-assessment` are artifacts it consumes (produced by other
stages — `intent-capture` and `feasibility` respectively).

Things that are **not** artifacts in this registry:

- **File paths.** `<record>/ideation/scope-definition/scope-document.md`
  (where `<record>/` is the intent's record dir, `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`)
  is a filesystem location; the canonical name is `scope-document`. See
  "Filesystem mapping" below.
- **Filenames.** The on-disk `.md` file and the canonical name don't have
  to match (they usually do, except at collisions).
- **State plumbing.** `aidlc-state.md`, `audit.md`, and
  `.aidlc-recovery.md` are managed by tools (`aidlc-state.ts`, hook
  scripts), not by stages via `produces[]`. They never appear in the
  registry.
- **Runtime values.** Strings like "user's prose answer" or
  "workspace classification (greenfield/brownfield)" are dynamic data,
  not durable stage-to-stage artifacts.

---

## The derivation rule

1. **Stage files are authoritative.** Each stage's `produces:` list
   declares every canonical name the stage emits. `consumes:` names the
   canonical strings the stage depends on.
2. **The registry is computed, not written.** Run
   `bun dist/claude/.claude/tools/aidlc-graph.ts artifacts` to
   print the live registry — one name per line, sorted alphabetically.
   The tool unions every stage's `produces[]` from the compiled
   `stage-graph.json`.
3. **No parallel list in this chapter.** If a reader wants the enumeration,
   they run the tool. This chapter never lists canonical names as a
   registry table.
4. **Membership is validated by the doctor.** `/aidlc --doctor` runs a
   "Graph references" check (`aidlc-utility.ts`) — every `consumes[].artifact`
   entry and `requires_stage[]` slug must resolve against the derived registry.
   Orphan consumers are reported as broken references.

All 32 stage files declare `produces:`, so the derivation returns the full
registry. The tool is well-defined on empty data too — a stage with no
`produces:` simply contributes nothing — but in the shipped framework every
stage is populated.

---

## Naming rules

Every canonical name must satisfy `/^[a-z][a-z0-9-]*$/` — the shape
enforced by `SLUG_RE` in
`dist/claude/.claude/tools/aidlc-stage-schema.ts`. That means:

- **Lowercase only.** `scope-document`, not `ScopeDocument` or
  `SCOPE_DOCUMENT`.
- **No file extension.** `scope-document`, not `scope-document.md`.
- **No folder prefix, no slash.** `scope-document`, not
  `ideation/scope-definition/scope-document`.
- **Start with a letter.** `s1` is legal; `1-thing` is not.
- **Inner hyphens, digits, lowercase letters only.** No underscores, no
  spaces, no Unicode letters.

Question artifacts follow a `<stage-slug>-questions` convention by
tradition — stages that collect user input declare a sibling
`<slug>-questions` canonical name alongside their main deliverables.
Tradition, not a parser rule.

The shape is **flat namespace** — no hierarchical prefix like
`<phase>/<stage>/<artifact>`. This matches every other AI-DLC identifier:
agent slugs, scope names, stage slugs, phase names are all flat kebab.

---

## Collision policy

Two stages **must not** declare the same canonical name in their
`produces[]` lists. The registry is a set; names must be globally unique.
When the same underlying concept is emitted by two stages, pick two
distinct names that disambiguate.

Today's one example: both `build-and-test` (Construction) and
`performance-validation` (Operation) write a file called `test-results.md`.
The canonical names are split so the two never collide on the wire:

- `build-test-results` — emitted by `build-and-test`. Pairs with
  sibling names in that stage: `build-instructions`,
  `unit-test-instructions`, `integration-test-instructions`,
  `performance-test-instructions`, `security-test-instructions`,
  `build-and-test-summary`.
- `load-test-results` — emitted by `performance-validation`. Pairs with
  `load-test-plan` already produced by the same stage.

Both names ship in the respective stages' `produces:` lists today.

**On-disk filenames don't have to match.** Both stages can keep writing to
`test-results.md` in their respective folders; the canonical name is the
wire identifier, not the filename.

---

## Filesystem mapping

Artifacts live on disk at paths that are derivable from `(canonical
name) + (producing stage) + (per-unit flag)`. Two shapes today:

- **Non-per-unit stages (24 of 29):**
  `<record>/<phase>/<stage>/<canonical-name>.md`
  Example: `feasibility-assessment` (produced by the Ideation
  `feasibility` stage) lives at
  `<record>/ideation/feasibility/feasibility-assessment.md`.

- **Per-unit Construction stages (5 of 29):** `nfr-requirements`,
  `nfr-design`, `functional-design`, `infrastructure-design`, and
  `code-generation`. These emit one copy of each artifact per Unit of
  Work during Construction:
  `<record>/construction/{unit-name}/<stage>/<canonical-name>.md`
  Example: `business-logic-model` (produced by `functional-design`) lives
  at
  `<record>/construction/{unit-name}/functional-design/business-logic-model.md`.

Per-unit status is declared by the stage's `for_each: unit-of-work`
frontmatter field — the five Construction stages that run once per Unit carry
it; the rest omit it. A future helper could compute the path mechanically from
stage graph + canonical name.

**Codekb is the space-level exception.** Reverse-engineering's 9 artifacts
(`business-overview`, `architecture`, `code-structure`, `api-documentation`,
`component-inventory`, `technology-stack`, `dependencies`,
`code-quality-assessment`, `reverse-engineering-timestamp`) do **not** resolve
under the per-intent record dir. They land in the durable, per-repo code
knowledge base at `aidlc/spaces/<space>/codekb/<repo>/` — a store shared across
every intent in the space, keyed by repo rather than by intent. The path is
resolved outside the record-relative rule via the `isCodekb` branch in
`resolveArtifactPath` (`dist/claude/.claude/tools/aidlc-orchestrate.ts`), and
the same directory is printed by the read-only direct utility invocation
`bun <harness-dir>/tools/aidlc-utility.ts codekb-path`.

**Canonical name ≠ filename for collisions.** Where a collision is split
(see above), the on-disk filename may keep the pre-split form
(`test-results.md`) while the canonical name is the disambiguated
version. Use the stage's `produces:` list and
`bun aidlc-graph.ts artifacts` as the source of truth, not the
filesystem.

---

## How to view the live registry

```bash
bun dist/claude/.claude/tools/aidlc-graph.ts artifacts
```

Prints one canonical name per line, alphabetically sorted.

Pre-PR-8 output is empty — stages haven't migrated to YAML yet and
`produces:` isn't populated. Post-PR-8 the output grows to roughly 118
names across 29 non-initialisation stages.

Pipe through `wc -l` for a count, `grep` for a filter, or `diff` against
an expected baseline for a drift check.

---

## Adding or renaming an artifact

No edit to this chapter required — the registry is derived.

**To add a new artifact:**

1. Edit the producing stage's `.md` file and add the canonical name to
   its `produces:` list.
2. Run `bun aidlc-graph.ts artifacts` to confirm it appears.
3. Run `/aidlc --doctor` to confirm no consumer references a name that no
   longer exists (the "Graph references" check).

**To rename an artifact:**

1. Rename it in the producing stage's `produces:` entry.
2. Rename it in every consuming stage's `consumes[].artifact` entry.
3. `/aidlc --doctor` (post-PR-11) catches any consumer you forgot to
   update — the old name becomes a missing-producer error.

Stage-graph CI drift detection (`aidlc-graph compile --check`) catches
renames that forget to regenerate `stage-graph.json` from the YAML
sources.

---

## Stability

The live registry at v1.0 ship time is the stability baseline for the
framework's artifact surface. The stability policy for artifact names is:

- **Renames** and **removals** are major-version changes — v1.x → v2.0.
- **Additions** ship in minor versions — v1.0 → v1.1, etc.
- **In-flight until v1.0**: the current v0.3.0 Foundation set is the
  starting point; later v0.4.0–v0.11.0 releases may add, rename, or drop
  names as the methodology evolves.

The policy is enforceable against live data: a drift between the registry
at tag time and the registry at HEAD is a one-line `diff`.

---

## Cross-references

- `dist/claude/.claude/aidlc-common/protocols/stage-definition.md` —
  authoritative stage format spec; defines `produces[]` / `consumes[]`
  as structured fields.
- [Stage Definition](15-stage-definition.md) — narrative chapter on the
  spec.
- [State Machine](12-state-machine.md) — parallel derivation pattern
  for audit events: the canonical enum lives in `aidlc-audit.ts`, not in
  the doc.
- [User Guide — Artifacts Reference](../guide/14-artifacts-reference.md)
  — user-facing artifact lifecycle and directory layout.
- `dist/claude/.claude/tools/aidlc-graph.ts` — the derivation tool
  (`artifactsRegistry()` + `artifacts` CLI subcommand).
