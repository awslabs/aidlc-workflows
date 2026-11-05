# Unit Context Sync — Opt-In

**Extension**: Unit Context Sync

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: Unit Context Sync
When the system is split into multiple units of work, should units be kept aligned during Construction — surfacing where a human-to-human discussion is needed before a unit-boundary change spreads, and propagating human-made decisions across units as they happen?

A) Yes — enforce all UCS rules as blocking constraints (recommended when units are built in parallel by more than one person or session)

B) No — skip all UCS rules (suitable for a single unit, or one person building units one at a time)

X) Other (please describe after [Answer]: tag below)

[Answer]: 
```
