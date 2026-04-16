# HCLS Data Handling — Opt-In

**Extension**: HCLS Data Handling (PHI Encryption, De-identification, Data Residency)

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: HCLS Data Handling Extension
Should healthcare data handling rules (PHI encryption, de-identification, data residency) be enforced for this project?

A) Yes — enforce all HCLS data handling rules as blocking constraints (recommended for any system that persists or processes PHI/ePHI)
B) Partial — enforce PHI encryption and log sanitization only (suitable for systems that handle PHI in transit but do not perform analytics or de-identification)
C) No — skip HCLS data handling rules (suitable for projects with no PHI exposure or where data handling is governed by an external platform layer)
X) Other (please describe after [Answer]: tag below)

[Answer]: 
```
