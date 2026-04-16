# HCLS Lens Descriptor

**Lens**: Healthcare & Life Sciences (HCLS)

**Purpose**: Adds healthcare-specific compliance, data handling, and interoperability rules for projects that store, process, or transmit Protected Health Information (PHI) or interact with clinical systems.

## Detection Signals

When analyzing the user's vision document, requirements, or initial request, look for the presence of these signals to determine whether the HCLS lens is relevant:

**Strong signals** (any one of these suggests HCLS lens is relevant):
- PHI, ePHI, Protected Health Information
- HIPAA, HITRUST, GxP, FDA 21 CFR Part 11
- FHIR, HL7, CDA, CCD-A
- EHR, EMR, Electronic Health Record, Electronic Medical Record
- Patient data, patient records, patient portal
- Clinical data, clinical trials, clinical decision support
- SMART on FHIR
- BAA, Business Associate Agreement
- De-identification, Safe Harbor method
- US Core profiles, International Patient Summary

**Supporting signals** (multiple together suggest HCLS lens):
- Healthcare, health system, hospital, provider, payer
- Life sciences, pharma, pharmaceutical, biotech
- Medical devices, medical imaging, diagnostics
- SNOMED CT, LOINC, ICD-10, RxNorm, CVX, NUCC
- Consent management (in a healthcare context)
- Health Information Exchange, HIE
- ONC, CMS Interoperability
- Bulk Data Access, population health
- Audit trail for data access (in a healthcare context)

## Sub-Extensions

When the HCLS lens is enabled, present opt-in prompts for these sub-extensions:
- `compliance/hcls-compliance.opt-in.md`
- `data-handling/hcls-data-handling.opt-in.md`
- `interoperability/hcls-interoperability.opt-in.md`

## Lens Confirmation Prompt

When detection signals are found, present this confirmation to the user:

```markdown
## Question: Industry Lens
Based on your requirements, this project involves healthcare data and systems. The HCLS (Healthcare & Life Sciences) lens adds rules for regulatory compliance, PHI data handling, and clinical interoperability.

A) Enable HCLS lens (recommended based on project context). You will be asked which specific HCLS sub-extensions to enable next.
B) Skip. No industry-specific lens needed for this project.
X) Other (please describe after [Answer]: tag below)

[Answer]:
```

When NO detection signals are found, do NOT present this question. Skip the lens entirely.
