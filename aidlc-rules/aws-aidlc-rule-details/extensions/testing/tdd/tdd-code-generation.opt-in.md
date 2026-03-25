# TDD Code Generation — Opt-In

**Extension**: TDD Code Generation

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: TDD Code Generation Extension
Should Test-Driven Development (TDD) be used for code generation in this project?

A) Yes — use TDD workflow for code generation (recommended for projects with complex business logic, data transformations, or long-term maintenance needs; ~1.5-2x token cost but prevents feature gaps and produces near-zero defect deliverables)
B) No — use standard code generation workflow (suitable for simple prototypes, one-off scripts, or projects with minimal business logic)
X) Other (please describe after [Answer]: tag below)

[Answer]: 
```
