# HCLS Interoperability — Opt-In

**Extension**: HCLS Interoperability (FHIR R4, HL7, SMART on FHIR, US Core)

## Opt-In Prompt

The following question is automatically included in the Requirements Analysis clarifying questions when this extension is loaded:

```markdown
## Question: HCLS Interoperability Extension
Should healthcare interoperability rules (FHIR R4, SMART on FHIR, clinical terminologies) be enforced for this project?

A) Yes — enforce all HCLS interoperability rules as blocking constraints (recommended for any system that exchanges clinical data with EHRs, HIEs, or other healthcare systems)
B) Partial — enforce FHIR R4 resource compliance and terminology binding only (suitable for internal clinical data APIs that do not require SMART on FHIR or Bulk Data Access)
C) No — skip HCLS interoperability rules (suitable for non-clinical systems, back-office healthcare applications, or projects where interoperability is handled by an integration layer)
X) Other (please describe after [Answer]: tag below)

[Answer]: 
```
