# Technical Environment: HealthBridge FHIR Patient Portal API

## Language and Package Manager

- **Java 21** (LTS) with **Spring Boot 3.3+**
- **Gradle 8.x** with Kotlin DSL (`build.gradle.kts`)
- **HAPI FHIR 7.x** for FHIR R4 resource handling, validation, and parsing

## FHIR Framework

- **HAPI FHIR Server** as the FHIR facade (not a full HAPI JPA Server — we use it as a framework, not a data store)
- **HAPI FHIR Validation** for US Core profile validation using the official IG package
- **HAPI FHIR Client** for upstream EHR integrations (Epic, Cerner, Athenahealth)
- Content types: `application/fhir+json` primary, `application/fhir+xml` supported

## Cloud and Deployment

- **AWS**, multi-account strategy:
  - **Workload account**: Application services, API Gateway, compute
  - **Data account**: PHI data stores, encryption keys
  - **Audit account**: CloudTrail logs, compliance audit trail
- **Primary region**: `us-east-1`, **DR region**: `us-west-2`
- **Compute**: ECS Fargate (containerized Spring Boot) — not Lambda (HAPI FHIR cold starts are too slow for Lambda)
- **API Gateway**: Amazon API Gateway (REST API type) with custom authorizer for SMART on FHIR token validation
- **Data stores**:
  - **Amazon HealthLake** for FHIR resource storage and search (BAA-eligible, FHIR-native)
  - **Amazon DynamoDB** for tenant configuration, consent records, and session management
  - **Amazon S3** for Bulk Data Export output (NDJSON files), clinical documents (CCD-A, discharge summaries)
- **Encryption**: AWS KMS with Customer Managed Keys (CMKs) — separate CMK per tenant, separate CMK for audit logs
- **Networking**: Private subnets for all compute and data, VPC endpoints for AWS services, no public internet access for data-plane components
- **Infrastructure as Code**: AWS CDK (TypeScript) for all infrastructure — no manual console changes
- **Container registry**: Amazon ECR with image scanning enabled

## Authentication and Authorization

- **SMART on FHIR** via Spring Security OAuth2 Resource Server
- **Token issuer**: Amazon Cognito (or customer's existing IdP via OIDC federation)
- Scope enforcement: `patient/*.read`, `user/*.read`, `system/*.read`, `system/*.write`
- Backend service auth: SMART Backend Services (JWT assertion with `client_credentials` grant)
- Break-glass: Time-limited admin token with mandatory post-access review logged in audit trail

## Data Handling

- **PHI encryption at rest**: AES-256 via KMS CMK (per-tenant keys), envelope encryption for S3 objects
- **PHI encryption in transit**: TLS 1.2+ enforced everywhere, mTLS between ECS services
- **De-identification**: Safe Harbor method implemented as a streaming transform — runs at export time before writing to the analytics S3 bucket
- **Data residency**: PHI locked to `us-east-1` and `us-west-2` only, enforced via SCPs
- **Backup**: HealthLake automated backups (daily), DynamoDB PITR enabled, S3 versioning + cross-account replication to audit account
- **Log sanitization**: Custom Logback filter strips PHI fields before writing to CloudWatch Logs

## Terminology

- **ICD-10-CM**: Diagnoses (Condition resource)
- **SNOMED CT**: Clinical findings, body structures (Condition, Observation)
- **LOINC**: Lab tests, vital signs, document types (Observation, DocumentReference)
- **RxNorm**: Medications (MedicationRequest)
- **CVX**: Vaccines (Immunization)
- **NUCC**: Provider taxonomy (Practitioner)
- Terminology server: **HAPI FHIR terminology service** backed by ValueSet/CodeSystem resources loaded from the official FHIR package registry

## Testing

- **JUnit 5** with Spring Boot Test
- **HAPI FHIR Validator** for automated US Core profile validation in integration tests
- **Testcontainers** for local DynamoDB and ECS integration testing
- **Touchstone** (HL7 FHIR testing platform) for ONC certification testing
- **JaCoCo** for code coverage (85% line coverage minimum)
- **OWASP Dependency Check** for vulnerability scanning
- **Trivy** for container image scanning

## Monitoring and Observability

- **Amazon CloudWatch** for metrics, logs, and alarms
- **AWS X-Ray** for distributed tracing (FHIR request → ECS → HealthLake → response)
- **Amazon CloudWatch Anomaly Detection** for PHI access pattern monitoring
- **AWS CloudTrail** for API-level audit (data events enabled for HealthLake, S3, DynamoDB)
- **Custom compliance dashboard**: CloudWatch dashboard showing audit log metrics, consent enforcement stats, de-identification pipeline throughput

## Do NOT Use

| Prohibited | Reason | Use Instead |
|---|---|---|
| Lambda for FHIR server | HAPI FHIR cold start too slow (>10s) | ECS Fargate |
| RDS/Aurora for FHIR data | Not FHIR-native, requires manual mapping | Amazon HealthLake |
| Self-managed HAPI JPA Server | Operational overhead for persistence layer | HealthLake + HAPI facade |
| Non-BAA-eligible AWS services for PHI | HIPAA violation | Only BAA-eligible services |
| `System.out.println` for logging | No sanitization, no structured format | SLF4J + Logback with PHI filter |
| Storing PHI in environment variables | Secrets exposure risk | AWS Secrets Manager or SSM Parameter Store (SecureString) |
| Public S3 buckets | PHI exposure risk | Private buckets + pre-signed URLs |
| TLS < 1.2 | Does not meet HIPAA Security Rule | TLS 1.2+ enforced via security policies |

## Example Code Patterns

### FHIR Resource Endpoint

```java
@RestController
@RequestMapping("/fhir/r4")
public class PatientController {

    private final PatientService patientService;
    private final AuditService auditService;
    private final ConsentService consentService;

    @GetMapping("/Patient/{id}")
    public ResponseEntity<String> getPatient(
            @PathVariable String id,
            @AuthenticationPrincipal SmartOnFhirToken token) {

        // Consent check before PHI access
        consentService.assertAccessAllowed(token.getPatientId(), id, "read", "Patient");

        Patient patient = patientService.findById(id, token.getTenantId());

        // Audit log — resource ref only, no PHI in log
        auditService.logAccess(token.getSubject(), "Patient", id, "read",
                "GET /fhir/r4/Patient/" + id);

        String fhirJson = FhirContext.forR4().newJsonParser()
                .encodeResourceToString(patient);

        return ResponseEntity.ok()
                .contentType(MediaType.valueOf("application/fhir+json"))
                .body(fhirJson);
    }
}
```

### PHI Log Sanitization Filter

```java
public class PhiSanitizingFilter extends Filter<ILoggingEvent> {
    private static final Set<String> PHI_PATTERNS = Set.of(
        "ssn", "mrn", "patientName", "dateOfBirth", "address",
        "phoneNumber", "email", "insuranceId"
    );

    @Override
    public FilterReply decide(ILoggingEvent event) {
        // Replace PHI field values with [REDACTED] before log output
        // Implementation: scan structured arguments, mask matching keys
        return FilterReply.NEUTRAL;
    }
}
```
