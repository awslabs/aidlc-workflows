# Secure Code Generation — Opt-In

**Extension**: Secure Code Generation

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Secure Code Generation Extension
Should secure coding rules be enforced during code generation for this project?

A) Yes — enforce all SECURE-CODE rules as blocking constraints during code generation (recommended for production applications)

B) No — skip secure code generation rules (suitable for PoCs, prototypes, and experimental projects where the security baseline extension already covers infrastructure-level concerns)

X) Other (please describe after [Answer]: tag below)

[Answer]: 
```
