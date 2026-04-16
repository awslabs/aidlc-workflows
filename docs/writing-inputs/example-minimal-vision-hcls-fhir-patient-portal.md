# Vision: HealthBridge FHIR Patient Portal API

## Executive Summary

HealthBridge is a FHIR R4-compliant API layer that gives patients secure access to their health records from multiple provider systems. Instead of every hospital building their own patient portal backend, they integrate with HealthBridge. We deploy it as a managed service on AWS, fully HIPAA-compliant, and sell it to healthcare provider organizations as a SaaS subscription.

## Features In Scope (MVP)

- **Patient record aggregation**: Ingest and normalize patient data from multiple EHR systems via FHIR R4 interfaces (Epic, Cerner, Athenahealth)
- **FHIR R4 API**: Expose Patient, Condition, Observation (vitals + lab results), MedicationRequest, AllergyIntolerance, Immunization, Encounter, and DocumentReference resources
- **SMART on FHIR authorization**: Support EHR Launch and Standalone Launch for third-party patient apps
- **Patient consent management**: Capture and enforce patient consent preferences for data sharing — treatment, payment, healthcare operations (TPO) and granular research opt-in/out
- **Clinical document access**: Serve CCD-A and discharge summary documents via DocumentReference with binary download
- **Provider directory**: Expose Practitioner and Organization resources for the care team view
- **Audit trail**: Immutable audit log for every PHI access event (who, what, when, why, how) — queryable by compliance team
- **US Core compliance**: All resources validate against US Core Implementation Guide profiles
- **Terminology support**: ICD-10, SNOMED CT, LOINC, RxNorm, CVX — proper CodeSystem/ValueSet bindings on all CodeableConcept fields
- **Bulk Data Export**: FHIR Bulk Data Access (Flat FHIR) for population health analytics and quality reporting — NDJSON export with `_since` and `_type` filtering
- **PHI de-identification pipeline**: Safe Harbor method de-identification for research/analytics data exports — strips all 18 HIPAA identifiers
- **Multi-tenant**: Each provider organization is an isolated tenant with its own encryption keys, data partition, and access policies

## Features Explicitly Out of Scope (MVP)

- Real-time clinical decision support / CDS Hooks (Phase 2)
- Patient messaging / secure chat (Phase 2)
- Appointment scheduling via FHIR Scheduling resources (Phase 2)
- Claims and billing integration — ExplanationOfBenefit, Coverage resources (Phase 2)
- Patient-reported outcomes (Questionnaire/QuestionnaireResponse) (Phase 2)
- International Patient Summary (IPS) profile support (Phase 3 — US market first)
- On-premises / hybrid deployment (Phase 3)
- FHIR Subscriptions for real-time event notifications (Phase 3)

## Target Users

- **Healthcare provider organizations** (hospitals, health systems, clinics) that need a patient-facing API without building one from scratch
- **Digital health startups** building patient engagement apps that need a FHIR-compliant backend
- **Health Information Exchanges (HIEs)** that need a standards-compliant aggregation layer
- **Life sciences / pharma companies** that need de-identified patient data for research (via Bulk Data Export + de-identification)

## Key Success Metrics

- 5 provider organization tenants onboarded within 6 months
- FHIR R4 validation: 100% of resources pass US Core profile validation
- API uptime: 99.95%
- Response time: p50 under 200ms for single-resource reads, p99 under 2s
- HIPAA compliance: zero audit findings on PHI access controls
- Bulk Data Export: process 100K patient records in under 30 minutes
- Consent enforcement: 100% of data sharing requests checked against patient consent

## Regulatory and Compliance Context

- **HIPAA**: Full compliance with Privacy Rule, Security Rule, and Breach Notification Rule
- **ONC 21st Century Cures Act**: Support information blocking prevention — patients must be able to access all their EHI without delay
- **CMS Interoperability Rules**: FHIR R4 API required for patient access
- **State regulations**: Design for extensible retention policies (state medical record retention varies from 5 to 10+ years)

## Open Questions

- Should we support FHIR R5 resources alongside R4, or strictly R4 for MVP?
- What is the target SLA for consent revocation taking effect — immediate vs. within 24 hours?
- Should Bulk Data Export support Group-level exports (specific patient cohorts) in MVP, or only system-level and Patient-level?
- How should we handle EHR systems that only support FHIR DSTU2 — transform to R4 at ingestion or reject?
