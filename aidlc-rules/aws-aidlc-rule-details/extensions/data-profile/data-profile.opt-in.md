# Data Profile — Opt-In

**Extension**: Data Profile (Brownfield Data-Driven Apps)

**Recommended when**: The project is a brownfield application that filters, queries, selects, or visualises data — e.g., dashboards, reporting tools, analytics platforms, data pipelines with user-facing selectors.

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Data Profile Extension

Should the AI-DLC generate a Data Profile during Reverse Engineering and
enforce data-value accuracy throughout Construction?

A) Yes — enable DATA PROFILE integration. During Reverse Engineering, a
   data-profile.md will be generated documenting exact column names,
   categorical values, numeric ranges, shared dependency patterns, and
   fragilities. All subsequent Functional Design and Code Generation stages
   will cross-reference this profile to prevent hardcoded value errors.

B) No — skip Data Profile generation (standard brownfield behavior)

X) Other (please describe)

[Answer]:
```
