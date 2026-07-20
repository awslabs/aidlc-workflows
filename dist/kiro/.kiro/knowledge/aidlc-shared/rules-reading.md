# Reading Active-Space Rule Files

> **Audience**: any agent that needs to read team-affirmed practices from
> `aidlc/spaces/<active-space>/memory/`.
> **Owner of this file**: framework. Cited by
> `aidlc-pipeline-deploy-agent/branching-strategies.md` and by other agents
> that adopt practices-aware behaviour.

The rules namespace resolves through a strict-additive five-layer chain
at workflow start: `org → team → project → phase → stage`. The first three
files are `aidlc/spaces/<active-space>/memory/{org,team,project}.md`;
`phases/<phase>.md` attaches because the stage's frontmatter `phase: <name>`
selects it. Stage rules are reserved for future use. The compile bakes the
resolved chain into each stage node's `rules_in_context`; every applicable
rule appears in the chain — nothing drops at runtime. This file documents how
to read those layers safely.

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

Heading shapes can drift between `team.md`, `org.md`, `project.md`, and the
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

For a decision that needs one operative practice statement, inspect the
active-space descriptive layers from narrowest to broadest and return the
first non-empty, non-conflicting section:

1. **`aidlc/spaces/<active-space>/memory/project.md`** — project-specific
   specialisation.
2. **`aidlc/spaces/<active-space>/memory/team.md`** — team-affirmed practices.
3. **`aidlc/spaces/<active-space>/memory/org.md`** — framework defaults written
   in team voice.
4. **Hardcoded defaults** — used only when all three layers are empty
   (greenfield first run before practices-discovery has run, or when the
   project SKIPs practices-discovery).

This topic selection does not erase broader rules: the runtime still loads all
applicable layers. A narrower statement that contradicts broader policy is an
admission error, not an override.

Hardcoded defaults are:

| Topic | Default |
|---|---|
| Way of Working | trunk-based development; base `main`, target `main`; squash-merge |
| Walking Skeleton | scope-dependent; the active scope file's `skeleton:` field supplies the default ceremony stance |
| Testing Posture | TDD encouraged but not enforced; the test-strategy axis governs volume |
| Deployment | trunk-based with on-merge staging deploy; production gate is human-approved |
| Code Style | defer to project linter/formatter configuration |

When the fallback chain has to descend to layer 4, emit
`PRACTICES_SECTION_EMPTY` (advisory-only) so doctor and downstream
observability can flag projects running on framework defaults vs affirmed
team practices.

---

## 4. Read protocol (pseudocode)

```
def read_practice(topic):
  for layer in [
    aidlc/spaces/<active-space>/memory/project.md,
    aidlc/spaces/<active-space>/memory/team.md,
    aidlc/spaces/<active-space>/memory/org.md,
  ]:
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

1. `project.md` `## Way of Working` → empty (fresh template).
2. `team.md` `## Way of Working` → empty (fresh template).
3. `org.md` `## Way of Working` → "trunk-based; base `main`, target
   `main`; squash-merge".
4. Returns `{base: "main", strategy: "squash"}` to the orchestrator
   alongside the agent's invocation of `aidlc-worktree`.

If `team.md` `## Way of Working` had read "We use GitFlow with
`develop` as the integration branch", the agent would map that to
`--base develop` instead — same fallback chain, populated layer wins.

If all three layers were empty (a project that SKIPped practices-discovery),
the agent would emit `PRACTICES_SECTION_EMPTY` and apply the hardcoded
default — `{base: "main", strategy: "squash"}`. Doctor surfaces this so
the team can run practices-discovery later if they want their own
practices captured.
