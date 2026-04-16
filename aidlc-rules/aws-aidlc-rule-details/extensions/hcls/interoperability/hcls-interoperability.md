# HCLS Interoperability Rules

## Overview
These healthcare interoperability rules ensure that systems exchanging clinical data follow industry standards for data format, transport, authorization, and terminology. They promote compliance with the ONC 21st Century Cures Act, CMS Interoperability and Patient Access rules, and international interoperability frameworks.

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message to the user.

**Relationship to Other Extensions**: These rules are independent of HCLS Compliance and HCLS Data Handling. They can be enabled standalone (e.g., for a FHIR API project that handles only de-identified data) or alongside the other HCLS extensions for a complete healthcare solution.

### Blocking Interoperability Finding Behavior
A **blocking interoperability finding** means:
1. The finding MUST be listed in the stage completion message under a "HCLS Interoperability Findings" section with the rule ID and description
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the HCLS-INTOP rule ID, description, and stage context

If a rule is not applicable to the current project context (e.g., HCLS-INTOP-05 when the system manages fewer than 1000 patient records), mark it as **N/A** in the compliance summary. This is not a blocking finding.

### Default Enforcement
All rules in this document are **blocking** by default. If any rule's verification criteria are not met, it is a blocking interoperability finding. Follow the blocking finding behavior defined above.

### Partial Enablement
When the user selects **Partial** enablement during opt-in, only the following rules are enforced:
- HCLS-INTOP-01 (FHIR R4 Compliance)
- HCLS-INTOP-04 (Terminology Binding)

All other rules are marked as N/A in compliance summaries.

---

## Rule HCLS-INTOP-01: FHIR R4 Compliance

**Rule**: All healthcare API endpoints that exchange clinical data MUST use HL7 FHIR R4 (v4.0.1) as the primary data format and interaction model.

**Requirements**:
- API endpoints MUST expose FHIR R4 resources (Patient, Observation, Condition, MedicationRequest, etc.) using standard FHIR RESTful interactions (read, search, create, update, delete)
- FHIR resources MUST validate against the base FHIR R4 specification. Invalid resources MUST be rejected with appropriate OperationOutcome responses
- Custom data elements MUST use the FHIR extensibility framework (Extension elements with defined StructureDefinitions). Do NOT add non-FHIR fields to standard resources
- The FHIR CapabilityStatement resource MUST be served at the `/metadata` endpoint, accurately reflecting the server's supported resources, interactions, and search parameters
- FHIR search MUST support at minimum the required search parameters defined by the applicable profiles (US Core, IPS, or base FHIR)
- FHIR Bundle resources MUST be used for batch operations and transaction processing
- Content negotiation MUST support both `application/fhir+json` and `application/fhir+xml` (JSON is the primary format; XML support may be deferred to a later phase if documented)

**Verification**:
- API endpoints use FHIR R4 resource types
- Resource validation is implemented (accept valid, reject invalid with OperationOutcome)
- Custom data uses FHIR extensions, not ad-hoc fields
- `/metadata` endpoint returns a valid CapabilityStatement
- Required search parameters are supported per applicable profiles
- Content-Type headers use `application/fhir+json` or `application/fhir+xml`

**Applicable Stages**: Requirements Analysis, Application Design, Functional Design, Code Generation, Build and Test

---

## Rule HCLS-INTOP-02: SMART on FHIR Authorization

**Rule**: FHIR endpoints MUST support SMART on FHIR (Substitutable Medical Applications, Reusable Technologies) authorization to enable secure third-party application access.

**Requirements**:
- The FHIR server MUST implement the SMART App Launch Framework (v2.0 preferred, v1.0 acceptable) for OAuth 2.0 based authorization
- Supported launch modes MUST include:
  - **EHR Launch**: Application launched from within an EHR context (receives launch context parameters)
  - **Standalone Launch**: Application launches independently and requests authorization
- FHIR access scopes MUST follow the SMART scope syntax:
  - `patient/{ResourceType}.{read|write|*}` (patient-context scopes)
  - `user/{ResourceType}.{read|write|*}` (user-context scopes)
  - `system/{ResourceType}.{read|write|*}` (system-level / backend service scopes)
- The `.well-known/smart-configuration` endpoint MUST be served, documenting the authorization endpoints, supported scopes, and capabilities
- Token introspection or validation MUST occur on every FHIR request, not just at session initiation
- Refresh token support MUST be implemented for long-running sessions
- Backend service authorization (system-to-system) MUST use the SMART Backend Services specification (JWT assertion for client authentication)

**Verification**:
- SMART App Launch is implemented (v1.0 or v2.0)
- Both EHR Launch and Standalone Launch modes are supported (or documented as future phase)
- SMART scopes follow the standard syntax and are enforced
- `.well-known/smart-configuration` endpoint is served and accurate
- Token validation occurs per-request
- Backend service authorization uses JWT assertion
- Refresh token flow is implemented

**Applicable Stages**: Application Design, Functional Design, Code Generation, Build and Test

---

## Rule HCLS-INTOP-03: US Core and IPS Profile Compliance

**Rule**: FHIR resources MUST validate against the appropriate implementation guide profiles based on the target market and use case.

**Requirements**:
- **US Market**: Resources MUST validate against [US Core Implementation Guide](http://hl7.org/fhir/us/core/) (latest published version). At minimum, the following US Core profiles MUST be supported:
  - Patient, AllergyIntolerance, Condition, DiagnosticReport, DocumentReference, Encounter, Immunization, MedicationRequest, Observation (vital signs, lab results, social history, smoking status), Procedure, CarePlan, CareTeam, Goal
- **International/Cross-border**: Resources MUST validate against the [International Patient Summary (IPS)](http://hl7.org/fhir/uv/ips/) profiles
- **Must Support elements**: All elements marked as `mustSupport` in the applicable profile MUST be populated when data is available and MUST be accepted when received
- Profile validation MUST be automated. Use a FHIR validation library (e.g., HAPI FHIR Validator, Firely .NET SDK, or AWS HealthLake built-in validation) as part of the API pipeline or CI/CD
- Non-compliant resources MUST be rejected with OperationOutcome detailing which profile constraints failed

**Verification**:
- Target market profiles are identified (US Core, IPS, or both)
- Required resource profiles are implemented per the applicable IG
- mustSupport elements are handled correctly (populated when available, accepted when received)
- Automated profile validation is integrated into the API pipeline or CI/CD
- Non-compliant resources return OperationOutcome with profile violation details

**Applicable Stages**: Requirements Analysis, Application Design, Functional Design, Code Generation, Build and Test

---

## Rule HCLS-INTOP-04: Terminology Binding

**Rule**: Clinical data fields MUST use standard healthcare terminologies with proper CodeSystem and ValueSet bindings as defined by FHIR and applicable implementation guides.

**Requirements**:
- The following standard terminologies MUST be used where applicable:
  - **ICD-10-CM/PCS**: Diagnoses and procedures (US)
  - **ICD-11**: Diagnoses (international, where adopted)
  - **SNOMED CT**: Clinical findings, procedures, body structures, substances
  - **LOINC**: Laboratory tests and observations, vital signs, document types
  - **RxNorm**: Medications (US)
  - **CPT/HCPCS**: Procedures and services (US billing)
  - **CVX**: Vaccines
  - **NUCC**: Provider taxonomy/specialty
- CodeableConcept fields MUST include:
  - `system`: The canonical URL for the terminology (e.g., `http://snomed.info/sct`, `http://loinc.org`)
  - `code`: The specific code from that system
  - `display`: The human-readable display text
- ValueSet bindings defined in the applicable profiles (US Core, IPS) MUST be respected. Required bindings are blocking, extensible bindings should use the defined ValueSet when a suitable code exists
- Terminology validation MUST be implemented. Codes must be valid within their declared CodeSystem
- When local/proprietary codes are necessary, they MUST be included as an additional coding alongside the standard terminology code (never as a replacement)

**Verification**:
- Standard terminologies are used for clinical data fields
- CodeableConcept fields include system, code, and display
- ValueSet bindings from applicable profiles are respected
- Terminology validation is implemented (codes are valid within their CodeSystem)
- Local codes supplement (not replace) standard terminology codes

**Applicable Stages**: Application Design, Functional Design, Code Generation, Build and Test

---

## Rule HCLS-INTOP-05: Bulk Data Export

**Rule**: Systems managing clinical data for more than 1,000 patients MUST support the FHIR Bulk Data Access specification (Flat FHIR) for population-level data export.

**Requirements**:
- The system MUST implement the [FHIR Bulk Data Access IG](http://hl7.org/fhir/uv/bulkdata/) (v2.0 preferred)
- Supported export operations:
  - `GET [fhir-base]/$export`: system-level export (all data)
  - `GET [fhir-base]/Group/[id]/$export`: group-level export (specific patient cohort)
  - `GET [fhir-base]/Patient/$export`: all patient data
- Export format MUST be NDJSON (Newline Delimited JSON) with one FHIR resource per line
- Export MUST support the `_since` parameter for incremental exports (only resources modified since a given timestamp)
- Export MUST support the `_type` parameter to filter by resource type
- Export status MUST be trackable via the async request pattern (202 Accepted → polling URL → completed with download links)
- Export files MUST be served from a secure, time-limited download URL (pre-signed S3 URL or equivalent)
- Bulk data export MUST respect the same access controls and consent rules as individual FHIR requests. No bypass of authorization for bulk operations
- Export operations MUST be logged in the audit trail (if HCLS Compliance is enabled)

**Verification**:
- Bulk Data Access endpoints are implemented (system, group, and/or patient level)
- Export format is NDJSON
- `_since` and `_type` parameters are supported
- Async request pattern is implemented (202 → polling → download)
- Download URLs are secure and time-limited
- Bulk export respects access controls and consent
- Export operations are audited (if HCLS Compliance is enabled)

**Applicable Stages**: Requirements Analysis, Application Design, Functional Design, Code Generation, Build and Test
