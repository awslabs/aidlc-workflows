# Code Safety — Opt-In

**Extension**: Code Safety (Enhanced Code Generation Guards)

**Recommended when**: The project generates backend services, API handlers, middleware-heavy frameworks, or any application with module mocking in tests. Particularly valuable for Node.js/Express, NestJS, Spring Boot, Django, and similar request-pipeline architectures.

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Code Safety Extension

Should the AI-DLC enforce enhanced code generation safety rules during
Construction?

A) Yes — enable CODE SAFETY guards. Additional verification rules will be
   enforced during Code Generation covering: middleware/request-context
   tracing, environment isolation in tests, test mock lifecycle
   correctness, pagination completeness, and error serialization
   consistency. These rules prevent classes of bugs that are difficult to
   detect in review.

B) No — use standard code generation rules only

X) Other (please describe)

[Answer]:
```
