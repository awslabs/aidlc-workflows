# Reading Rule Files

> **Audience**: any agent that needs to read team-affirmed practices from
> `.aidlc/rules/`.
> **Owner of this file**: framework. Cited by
> `aidlc-pipeline-deploy-agent/branching-strategies.md` and by other agents
> that adopt practices-aware behaviour.

The rules namespace resolves through a strict-additive five-layer chain
at workflow start: `org → team → project → phase → stage`. `aidlc-org.md`
holds framework defaults; `aidlc-team.md` carries this team's affirmed
practices (populated by practices-discovery); `aidlc-project.md` adds
project-scoped specialisation; `aidlc-phase-<phase>.md` attaches because
the stage's frontmatter `phase: <name>` field is the pull import for the
matching phase-rule filename. Stage rules (`aidlc-stage-<slug>.md`) are
reserved-for-future-use. The compile bakes the resolved chain into each
stage node's `rules_in_context`; every applicable rule appears in the
chain — nothing drops at runtime. This file documents how to read those
layers safely.

---

## 1. Empty-template detection

A rule section is **empty** when every non-blank line in its body begins
with `<!--` or is whitespace. The template ships with HTML-comment
placeholders illustrating affirmed-state examples; until the team has
affirmed practices, every section is empty by this rule.

When you read a section and find it empty, fall back to the next layer
(see § 3). Do not parse the example prose — the comments exist for human
readers, not for agent inference.

Example empty section:

```
## Way of Working

<!-- Populated by practices-discovery affirmation. Example after affirmation:
"We squash-merge to `main`. Trunk-based; feature branches resolve in 1-2 days." -->
```

Example populated section:

```
## Way of Working

We squash-merge to `main`. Trunk-based; feature branches resolve in 1-2 days.
```

The first body line being `<!--` is the empty signal; the second body line
being prose is the populated signal.

---

## 2. Semantic-topic matching

Heading shapes can drift between `aidlc-team.md`, `aidlc-org.md`, and the
per-agent KB that consumes them. Match by **topic**, not by exact-string
heading.

For the **way of working / branching / merge** topic:
- Prefer an exact `## Way of Working` heading.
- Fall back to any `## ` heading containing `branch`, `merge`, or `way`
  (case-insensitive).

For the **walking skeleton** topic:
- Prefer `## Walking Skeleton`.
- Fall back to any heading containing `skeleton` (case-insensitive).

For the **testing** topic:
- Prefer `## Testing Posture`.
- Fall back to any heading containing `test` (case-insensitive).

For the **deployment** topic:
- Prefer `## Deployment`.
- Fall back to any heading containing `deploy` or `release`
  (case-insensitive).

For the **code style** topic:
- Prefer `## Code Style`.
- Fall back to any heading containing `style` or `format`
  (case-insensitive).

When multiple candidate headings match by fallback, prefer the first
occurrence in document order.

---

## 3. Fallback chain

For each topic, walk the layers in order and return the first non-empty
section found:

1. **`.aidlc/rules/aidlc-team.md`** — team-affirmed practices. The
   primary source.
2. **`.aidlc/rules/aidlc-org.md`** — framework defaults written in team
   voice. Always populated.
3. **Hardcoded defaults** — used only when both layers are empty
   (greenfield first run before practices-discovery has run, or when the
   project SKIPs practices-discovery).

Hardcoded defaults are:

| Topic | Default |
|---|---|
| Way of Working | trunk-based development; base `main`, target `main`; squash-merge |
| Walking Skeleton | scope-dependent; the active scope file's `skeleton:` field supplies the default ceremony stance |
| Testing Posture | TDD encouraged but not enforced; the test-strategy axis governs volume |
| Deployment | trunk-based with on-merge staging deploy; production gate is human-approved |
| Code Style | defer to project linter/formatter configuration |

When the fallback chain has to descend to layer 3, emit
`PRACTICES_SECTION_EMPTY` (advisory-only) so doctor and downstream
observability can flag projects running on framework defaults vs affirmed
team practices.

---

## 4. Read protocol (pseudocode)

```
def read_practice(topic):
  for layer in [aidlc-team.md, aidlc-org.md]:
    section = match_section(layer, topic)  # § 2
    if section and not is_empty(section):  # § 1
      return section
  return hardcoded_default(topic)          # § 3
```

The protocol is intentionally synchronous and side-effect-free. Agents
call this when shaping a tool invocation; the orchestrator calls it when
shaping a question prompt. Both surfaces use the same fallback chain so
user-visible behaviour stays consistent across the dispatch.

---

## 5. Worked example — aidlc-pipeline-deploy-agent reading way-of-working

The orchestrator dispatches `aidlc-pipeline-deploy-agent` at Bolt-create time.
The agent's job is to map team intent to `aidlc-worktree create --slug
<slug> --base <branch>`. It reads:

1. `aidlc-team.md` `## Way of Working` → empty (fresh template).
2. `aidlc-org.md` `## Way of Working` → "trunk-based; base `main`, target
   `main`; squash-merge".
3. Returns `{base: "main", strategy: "squash"}` to the orchestrator
   alongside the agent's invocation of `aidlc-worktree`.

If `aidlc-team.md` `## Way of Working` had read "We use GitFlow with
`develop` as the integration branch", the agent would map that to
`--base develop` instead — same fallback chain, populated layer wins.

If both layers were empty (a project that SKIPped practices-discovery),
the agent would emit `PRACTICES_SECTION_EMPTY` and apply the hardcoded
default — `{base: "main", strategy: "squash"}`. Doctor surfaces this so
the team can run practices-discovery later if they want their own
practices captured.
