# HCLS Compliance — Opt-In

**Extension**: HCLS Compliance (HIPAA, HITRUST, GxP, FDA 21 CFR Part 11)

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: HCLS Compliance Extension
Should healthcare compliance rules (HIPAA, HITRUST, GxP) be enforced for this project?

A) Yes — enforce all HCLS compliance rules as blocking constraints (recommended for any system that stores, processes, or transmits Protected Health Information)
B) Partial — enforce PHI data classification and audit trail rules only (suitable for analytics systems working with de-identified data or limited PHI exposure)
C) No — skip HCLS compliance rules (suitable for non-healthcare workloads, internal tools with no PHI, or projects where compliance is handled at a different layer)
X) Other (please describe after [Answer]: tag below)

[Answer]: 
```
