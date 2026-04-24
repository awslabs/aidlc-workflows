# NFR Compensation — Opt-In

**Extension**: NFR Compensation (Lightweight NFR in Functional Design)

**Recommended when**: The project uses a global/foundation-unit NFR strategy where NFR Requirements, NFR Design, and Infrastructure Design are done once and subsequent units skip those stages. Without this extension, unit-specific performance concerns may be lost.

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: NFR Compensation Extension

Should units that skip NFR stages include a lightweight Performance &
Behavioral Considerations section in their Functional Design?

A) Yes — enable NFR COMPENSATION. When a unit's NFR Requirements / NFR
   Design / Infrastructure Design stages are skipped (e.g., handled
   globally), its Functional Design will include a mandatory section
   covering latency budgets, timeout strategies, resource constraints,
   edge-case behavior, and testable acceptance criteria specific to that
   unit.

B) No — units that skip NFR stages will not include additional
   performance considerations in their Functional Design

X) Other (please describe)

[Answer]:
```
