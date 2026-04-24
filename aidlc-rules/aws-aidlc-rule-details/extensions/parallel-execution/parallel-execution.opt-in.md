# Parallel Execution — Opt-In

**Extension**: Parallel Execution (Adaptive)

**Recommended when**: The project is expected to have 2 or more units of work, particularly for platform migrations, new projects, or complex feature sets.

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Parallel Execution Extension

Should the AI-DLC Construction phase use adaptive parallel execution for
independent work?

A) Yes — enable ADAPTIVE PARALLEL EXECUTION. The workflow will assess each
   decision point and only parallelize when a formal safety check confirms
   no risk to accuracy. Accuracy always takes priority over speed. When in
   doubt, execution remains sequential.

B) No — execute all stages and units sequentially (default AI-DLC behavior)

X) Other (please describe)

[Answer]:
```
