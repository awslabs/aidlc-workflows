# V1 Feature Migration Decisions

How the good parts of v1 land in the v2 architecture.

---

## 1. Adaptive Depth

**V1 behaviour:** Stages execute at minimal/standard/comprehensive depth based on complexity signals. Embedded as instructions in each stage's rule file.

**V2 implementation:** Convention document, not a skill.

- Create `conventions/adaptive-depth.md` defining the three levels, the signals that determine which applies, and the rule that the stage owner must assess depth before planning.
- The `work-method` skill references it: "Before planning, assess depth per `conventions/adaptive-depth.md`."
- No per-stage repetition. Every persona inherits the policy through work-method.

**Rationale:** Depth is a decision framework (policy), not a capability (skill). Analogous to `question-format.md` — a structural convention that all personas follow.

---

## 2. Extensions (Security Baseline, Property-Based Testing, etc.)

**V1 behaviour:** Separate `extensions/` directory with `.opt-in.md` files. Loaded at workflow start. User opts in during requirements analysis. Enabled extensions are enforced at every stage with compliance summaries.

**V2 implementation:** Extensions dissolve into the existing model. No separate extension system.

| Extension type | V2 mechanism |
|---|---|
| Cross-cutting quality policy (e.g. security baseline) | Include the relevant persona as contributor at composition time. The `security-engineer` persona + `security-thinking` skill already covers this. |
| Technique (e.g. property-based testing) | A skill associated with the persona who owns code-generation/build-and-test. |
| Tool invocation (e.g. SAST scan, dependency audit) | A `tools` list in the stage definition — directly invoked tools for that stage. |

**Opt-in mechanism:** Lives in workflow-composition. The orchestrator asks during composition: "Do you want security review? Property-based tests?" Based on the answer, it includes/excludes the persona-as-contributor or the skill/tool. No artificial `.opt-in.md` files.

**Stage `tools` field:** Stage definitions can declare a list of tools that get invoked during execution. Example:

```yaml
tools:
  - security-scan
  - dependency-audit
  - content-validator
```

These are direct tool invocations, not personas or skills. They produce machine output, not review artifacts.

**Rationale:** No artificial files that don't belong in a real-world process. The persona/skill/tool model already handles everything extensions were trying to do. Composition is the single point where the workflow is configured.

---

## 3. Per-Unit Loop

**V1 behaviour:** Construction stages (functional-design → nfr-requirements → nfr-design → infrastructure-design → code-generation) execute once per unit before moving to the next unit. Build-and-test runs once after all units complete.

**V2 implementation:** Will be addressed when construction stages are migrated.

Likely shape: The `workflow.json` schema supports a `unit` field on stage entries. The orchestrator loops through units, instantiating the per-unit stages for each. The stage-graph will need a "construction-unit-loop" composition rule.

---

## 4. Content Validation

**V1 behaviour:** `common/content-validation.md` loaded at workflow start. Rules for Mermaid syntax validation, ASCII diagram standards, special character escaping. Checked before every file creation.

**V2 implementation:** Tool + quality-review checklist item.

- A tool: `content-validator` — checks Mermaid syntax, ASCII diagram well-formedness, markdown escaping.
- Stages that produce diagrams list `content-validator` in their `tools` field.
- The `quality-review` skill includes "verify all diagrams render correctly" as one checklist item — delegating the mechanical check to the tool.

**Rationale:** Syntactic validation is mechanical (tool territory). Semantic quality is the reviewer's job. Don't mix them. Don't make every persona load validation rules — let the tool handle it.

---

## 5. Overconfidence Prevention

**V1 behaviour:** Embedded in every stage's question generation step as "CRITICAL: Default to asking questions when there is ANY ambiguity." Repeated 10+ times across stage files.

**V2 implementation:** A principle in `skills/common/work-method/SKILL.md`.

Add to the work-method principles:

> When uncertain, ask. State what you know versus what you inferred. Never present inference as fact. If a question exists that would improve the artifact, ask it — the cost of an extra question is lower than the cost of a wrong assumption.

This propagates to every persona at every stage through the common skill. Persona `behaviour` fields stay focused on domain identity, not process discipline.

**Rationale:** Single point of definition. No repetition. Every persona inherits it because every persona uses work-method.

---

## 6. Session Continuity

**V1 behaviour:** `common/session-continuity.md` with rules for resuming from last completed stage. Checks `aidlc-state.md` for progress.

**V2 implementation:** Resume logic in `skills/stage-execution/SKILL.md`.

Add to stage-execution's Sequencing section:

> On invocation, read `state/state.json`. If any stage has a status other than `pending`, find the first stage that is not `complete` and resume from its current status. Do not re-execute completed stages. Present the human with a brief summary of where we left off.

The checkpoint infrastructure already exists (stage-execution already writes checkpoints). What's missing is the read-on-startup counterpart.

**Rationale:** Session continuity is "resume mid-execution" — that's squarely a stage-execution concern. The state.json schema already supports it. Two lines of principle, not a whole new mechanism.

---

## Implementation Status

| # | Item | Status | Blocked by |
|---|---|---|---|
| 1 | Adaptive depth | Not started | Nothing — can implement anytime |
| 2 | Extensions dissolution | Not started | Needs construction stages + code-gen persona |
| 3 | Per-unit loop | Not started | Construction stage migration |
| 4 | Content validation | Not started | Tool infrastructure design |
| 5 | Overconfidence prevention | Not started | Nothing — surgical edit to work-method |
| 6 | Session continuity | Not started | Nothing — surgical edit to stage-execution |
