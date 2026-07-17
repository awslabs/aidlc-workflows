# Rule System

> Audience: Tier 2/3 (team adopter, framework contributor).

This chapter is the schema-level reference for the v0.5.0 rule system: where rule files live, how scope is derived, how the inheritance chain resolves, and which frontmatter fields are valid. It is the spec the resolver (`aidlc-graph.ts compile`) and the doctor rule-drift check read against. Rules are the feedforward half of the control loop; [Sensor System](07-sensor-system.md) covers the deterministic-verification half they pair with. For the user-facing walkthrough — the learning-loop ritual, the ANZ worked example, and how a confirmed learning lands in a rule file — see [Rules and the Learning Loop](../guide/09-rules-and-the-learning-loop.md) in the User Guide.

## Layout

Rules live in the active space memory layer at `aidlc/spaces/<active-space>/memory/` (one hand-editable set at the workspace root, read by every harness via its native include — Claude `@`-import stub, Kiro CLI and Kiro IDE resources globs, Codex `AIDLC_RULES_DIR`) with neutral scope-named files:

```
aidlc/spaces/<active-space>/memory/
├── org.md
├── team.md
├── project.md
└── phases/
    ├── ideation.md
    ├── inception.md
    ├── construction.md
    └── operation.md
```

The layout consolidates team-authored harness config (formerly in a separate practices namespace) and self-learning guardrails (formerly two-deep) into a single active space memory directory at `aidlc/spaces/<active-space>/memory/`.

## Filename-derived scope

Rule files do **not** carry a `scope:` frontmatter field. Scope is derived from the filename:

| Filename pattern | Scope |
|---|---|
| `org.md` | `org` |
| `team.md` | `team` |
| `project.md` | `project` |
| `phases/<phase>.md` | `phase` (phase value = filename) |

Org, team, project, and phase rules carry no path-scoping frontmatter — pull authoring puts the relationship on the stage side. Org / team / project apply to every stage as universal defaults (filename-derived); the matching phase rule attaches because the stage's frontmatter `phase: <name>` field is the pull import for `phases/<name>.md`.

## Five-layer inheritance

Rules resolve through a five-layer chain at workflow start:

```
org → team → project → phase → stage
```

Org carries framework defaults; team and project layers extend with team-affirmed and project-specialised content. Phase is orthogonal — it attaches the matching `phases/<name>.md` rule because the stage already declared `phase: <name>` in its frontmatter (the same authoring direction as `requires_stage` and `consumes`). Stage rules are reserved-for-future-use; when authored, each `aidlc-stage-<slug>.md` will attach via the stage's `slug:` declaration. Cross-link to [01-architecture.md § Configuration layers](01-architecture.md) for the broader two-axis configuration model this chain operationalises.

The compile output (`stage-graph.json` per-stage `rules_in_context` field) bakes the resolved chain into each stage node. Runtime never walks the chain — the compile owns resolution.

## Strict-additive runtime model

Every applicable rule appears in `rules_in_context`. Org, team, and project rules concatenate; nothing drops at runtime. The phase rule attaches when the rule's filename matches the stage's `phase:` declaration — no glob filter, no concrete-path synthesis. The agent reads the full chain at session start.

Conflicts (a narrower scope contradicting broader policy) are rejected at the memory gate — the §13 Learnings Ritual's admission check — before a learning reaches the resolver. The check is section-level: when a proposed dated learning entry is about to be written to `memory/project.md` (or `memory/team.md`), the orchestrator compares it against `memory/org.md`'s matching heading via an LLM check; if a conflict is found, the user **revises, skips, or escalates** (there is no override path). Practices-discovery's affirmation gate is the other admission gate, but its promotion is a deterministic section-replace (`aidlc-state.ts practices-promote`) legitimised by the user's affirmation — it does not run the automated org-conflict check. Post-write drift between org and team/project content is surfaced separately by the doctor's rule-drift row (below).

This design replaces the earlier `enforcement: enforced` keyword and `overrides:` block model. Both keywords are removed from the schema. Frontmatter parsing rejects them via the unknown-key tolerance policy below — they pass through silently rather than throwing, but the resolver ignores them.

The doctor rule-drift check surfaces post-write drift on demand: when org rules change after team or project content has already landed on disk, doctor deterministically finds `##` headings that the team/project practice files (`memory/team.md`, `memory/project.md`) share with a *populated* org heading and surfaces each overlap as an advisory candidate — file, section, and the quoted org sentence — rendered `Rule drift: N team/project rule(s) overlap org policy (review for contradiction)`. Doctor itself runs no LLM: detection is byte-reproducible heading/string work. The contradiction verdict — the same section-level LLM check the admission gates run — is the consuming orchestrator's at observation-time, non-blocking. The human then revises, escalates, or accepts the surfaced drift.

## `pairing:` field

Rules MAY pair with a deterministic sensor from `.claude/sensors/aidlc-*.md`:

```yaml
---
pairing: aidlc-required-sections
---
# or
pairing: feedforward-only
---
```

Valid values:

- `feedforward-only` — explicit declaration that the rule has no sensor companion (the framework cannot verify it deterministically).
- `<sensor-id>` — must match an existing `.claude/sensors/aidlc-<id>.md` `id:` field.

The doctor paired-coverage row counts paired-vs-feedforward-only rules and surfaces unpaired rules as a coverage gap (see [Rule-drift detection](#rule-drift-detection)).

## Rule-drift detection

`/aidlc --doctor` ships two advisory rows that observe rule/sensor state. Both are read-only and always pass — neither changes the health-check exit code. (As of v0.6.10 `--doctor` is cold-safe: the `GUARDRAIL_LOADED` audit row the paired-coverage check emits is written only when the active intent's `audit/` shard already exists. On a fresh shell with no intent yet, doctor prints the rows but emits nothing and creates no files.)

- **Rule drift** — for each team/project practice file (`memory/team.md`, `memory/project.md`), doctor finds `##` headings that also appear under a *populated* heading in `memory/org.md` and surfaces each overlap as a candidate pair: file, section, and the first org sentence quoted verbatim. Headings whose org body is empty (e.g. the framework-default `## Forbidden`, `## Mandated`, `## Corrections`, which hold only HTML comments) do not count — the overlap must carry content on both sides. The count N is the number of *structural* candidate pairs, not LLM-confirmed contradictions: doctor detects deterministically; the contradiction verdict is the orchestrator-LLM's at observation time (see the [strict-additive section](#strict-additive-runtime-model)).
- **Paired sensor coverage** — for each rule carrying `pairing: <sensor-id>`, doctor strips the `aidlc-` prefix and confirms the named sensor exists in at least one stage's resolved sensor set (`sensors_applicable`). The row reads `Paired sensor coverage: P/(M-X) guardrails paired (X feedforward-only)`, where M is the rules carrying a `pairing:` value, X is the feedforward-only rules (which never need a sensor), and P is the rules whose named sensor resolves; unpaired rules (sensor id named but bound by no stage) are listed inline. This is a **file-existence check, not a semantic one** — it confirms the binding resolves, not that the sensor fits the rule. The row emits the `GUARDRAIL_LOADED` audit event once per run on an initialized project (the emit is suppressed on a pristine project with no `audit.md` — see the cold-safe note above).

## Forward-compat policy

Rule frontmatter is forward-compatible by additive extension:

- New fields land as additive — existing rule lines never need rewriting.
- Consumers MUST tolerate unknown frontmatter keys (ignore + pass through). This is how legacy `enforcement:` / `overrides:` keys (if present in user-extension overlays) load without error.
- Rule body conventions (sections like `## Forbidden`, `## Mandated`) follow the existing guardrail conventions.
- The Learnings Ritual (the memory gate) writes each confirmed learning as a practice directly into the space memory files — `memory/project.md` (default) and `memory/team.md` (one-click promote; no org-scope write) — as a dated entry under its diary-heading topic. A confirmed learning *is* a practice: these are the same files practices-discovery affirms, not a separate `*-learnings.md` surface. The resolver sorts them on the clean integer chain `SCOPE_PRIORITY` (org:0, team:1, project:2, phase:3) — there are no fractional 1.5 / 2.5 tiers. The `aidlc-learnings.ts` memory gate is the live implementer of the admission conflict-check described under `## Strict-additive runtime model` above (single proposed dated entry vs `memory/org.md`'s matching section; revise / skip / escalate, no override path).

Pre-v0.5.0 rule files load unchanged after the rename + flatten lands; migration is path-only.

## Next Steps

- **Sensors** — the deterministic half a rule can pair with via
  `pairing:`. See [Sensor System](07-sensor-system.md).
- **The compile boundary** — how `rules_in_context` is resolved once at
  workflow start and read off the graph node throughout the workflow.
  See [Plane Architecture](02-plane-architecture.md).
- **The learning loop in practice** — the `memory.md` diary, the
  approval-gate ritual, and the ANZ worked example. See [Rules and the
  Learning Loop](../guide/09-rules-and-the-learning-loop.md) in the User
  Guide.
- **The two-axis configuration model** — the broader routing principle
  this five-layer chain operationalises. See
  [Architecture § Configuration layers](01-architecture.md).
