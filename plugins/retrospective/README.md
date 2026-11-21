# retrospective — AIDLC retrospective plugin

> A first-party **AIDLC plugin**: an optional, opt-in end-of-delivery
> retrospective layered onto the AI-DLC Operation phase. Design:
> [RFC #1542](https://github.com/awslabs/aidlc-workflows/issues/1542).
> Author guide: [`docs/harness-engineering/10-authoring-a-plugin.md`](../../docs/harness-engineering/10-authoring-a-plugin.md).

## 1. What it does

This plugin adds one optional stage — **Retrospective & Code Documentation** —
near the end of the Operation cycle, immediately before Feedback & Optimization.
It runs once per delivery, after the code has been built and proven, and has
**two lanes, code first**:

- **Lane 1 (primary): document the code and codify lessons about the codebase.**
  Working with the customer, consolidate the per-unit code artifacts into
  durable, customer-owned documentation — an architecture-decision record, a
  codebase-orientation guide, a known-limitations & tech-debt register, and
  lessons specific to *this* code. These are the customer's deliverable, written
  where their code lives.
- **Lane 2 (secondary): promote AI-DLC process learnings.** Aggregate the
  per-stage Learnings Ritual (`stage-protocol-learnings.md` §13) across the
  delivery and promote kept candidates through the existing deterministic
  `engine learnings persist` path into `project.md` / `team.md`, emitting a
  team→org promotion *proposal* artifact. It never writes `org.md` and
  introduces no parallel store.

## 2. Opt-in — nobody else meets a new gate

The stage is gated on the plugin's own `retrospective-ceremony` scope and is
SKIP on every install that has not selected it. A team that wants a retrospective
selects the plugin and runs under this scope; everyone else is byte-identical to
bare core and meets no new approval at the end of Operation. **The scope is the
on/off switch itself — there is no separate ceremony flag to set, and not
selecting the scope is "off".**

## 3. How to use it

Built by the packager as a real host plugin per harness (the hybrid model — see
[`docs/reference/18-plugin-mechanism.md`](../../docs/reference/18-plugin-mechanism.md)).

**Author / build / test** (from the repo root, with the shipped tools bundle):
```bash
bun dist/claude/.claude/tools/aidlc-plugin-validate.ts plugins/retrospective
bun dist/claude/.claude/tools/aidlc-plugin-build.ts plugins/retrospective claude
bun dist/claude/.claude/tools/aidlc-plugin-test.ts plugins/retrospective --install <claude-project> --harness claude
```

**Kiro** (no store — folder-drop + compose):
```bash
cp -r dist/plugins/retrospective/kiro/. <project>/
AIDLC_PLUGIN_ROOT=<…>/kiro AIDLC_PROJECT_DIR=<project> AIDLC_HARNESS_DIR=.kiro \
  bun <…>/kiro/hooks/compose.ts
```

Then select the plugin and run under its scope:
```
/aidlc --doctor                      # expect the retrospective stage in the graph, 0 failures
/aidlc --scope retrospective-ceremony
```

## 4. What it ships

```
plugins/retrospective/
  .aidlc-plugin/plugin.json              # manifest (name, version, deps, contributes)
  stages/operation/retrospective-ceremony.md   # the one NEW stage (plugin-owned, opt-in scope)
  scopes/retrospective-ceremony.md       # the opt-in scope that gates the stage
  tools/retrospective-doctor.ts          # read-only composed-install check
  tests/plugin.test.ts                   # content validation + compose check
  README.md
```

It reuses core agents (`aidlc-architect-agent` lead; `aidlc-developer-agent`,
`aidlc-quality-agent` support) and ships no new persona. Every artifact it
produces is `retrospective-` prefixed, so it cannot collide with core or another
plugin.

## 5. Artifacts it produces

| Artifact | Lane | Written to |
|---|---|---|
| `retrospective-architecture-decision-record` | 1 | customer workspace |
| `retrospective-codebase-orientation` | 1 | customer workspace |
| `retrospective-known-limitations-register` | 1 | customer workspace |
| `retrospective-code-lessons` | 1 | customer workspace |
| `retrospective-promotion-log` | 2 | stage record dir |
| `retrospective-org-promotion-proposal` | 2 | stage record dir |
| `retrospective-questions` | 1 + 2 | stage record dir |

Lane 2 process learnings persist through the deterministic
`engine learnings persist` writer into `project.md` / `team.md`; this stage never
hand-edits a memory file and never writes `org.md`.

## See also
- [RFC #1542](https://github.com/awslabs/aidlc-workflows/issues/1542) — the proposal
- [Authoring a Plugin](../../docs/harness-engineering/10-authoring-a-plugin.md)
- [Plugin Mechanism](../../docs/reference/18-plugin-mechanism.md) — the normative design
