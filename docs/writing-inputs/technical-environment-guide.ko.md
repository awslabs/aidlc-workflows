# 기술 환경 문서 작성 가이드

## 목적

기술 환경 문서(Technical Environment Document)는 프로젝트가 어떻게 구축될지를 지배하는 **기술 도구, 표준, 제약, 선호도**를 정의합니다. 비전 문서의 기술적 대응물이며, AI-DLC의 Construction 단계에서 구속력 있는 레퍼런스로 작동합니다.

이 문서는 코드 생성, 인프라 설계, NFR 결정이 조직 표준, 보안 정책, 팀 역량과 일치하도록 보장합니다. 이것이 없다면 AI-DLC 단계는 빈틈을 메우기 위해 광범위한 명확화 질문을 하거나, 더 나쁘게는 재작업이 필요한 가정을 하게 됩니다.

## 기술 환경 문서를 언제 작성하는가

- 새 프로젝트 시작 전 (그린필드)
- 기술 제약이 바뀐 기존 프로젝트 수정 전 (브라운필드)
- 조직 기술 표준이 업데이트되었을 때
- 클라우드 공급자, 프레임워크, 배포 모델 마이그레이션 시

## 문서 적용 범위

기술 환경 문서는 두 가지 프로젝트 컨텍스트 중 하나를 대상으로 합니다.

| 컨텍스트          | 정의                                                | 주요 차이                                                                                  |
| -------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **그린필드**       | 기존 코드 없음. 처음부터 구축.                       | 모든 선택지가 열려 있음. 문서가 출발점을 정의.                                              |
| **브라운필드**     | 기존 코드베이스. 추가, 수정 또는 마이그레이션.       | 선택지가 이미 존재하는 것에 의해 제약됨. 문서가 유지/변경/회피 사항을 정의.                  |

해당 컨텍스트에 맞게 문서를 구조화하세요. 아래 섹션에는 **(그린필드)**, **(브라운필드)**, **(공통)** 표시가 있어 적용 범위를 나타냅니다.

---

## 문서 구조

### 1. 프로젝트 기술 요약 (공통)

```markdown
## Project Technical Summary

- **Project Name**: [이름]
- **Project Type**: [Greenfield / Brownfield]
- **Primary Runtime Environment**: [Cloud / On-Premises / Hybrid]
- **Cloud Provider**: [AWS / Azure / GCP / 멀티클라우드 / 없음]
- **Target Deployment Model**: [Serverless / Containers / VMs / Hybrid]
- **Team Size**: [개발자 수]
- **Team Experience**: [기술 선택과 관련된 핵심 역량과 경험 수준]
```

---

### 2. 프로그래밍 언어 (공통)

프로젝트가 반드시 사용할/사용 가능한/사용 금지인 언어를 정의합니다.

```markdown
## Programming Languages

### Required Languages
[특정 목적에 반드시 사용해야 하는 언어.]

| 언어 | 버전 | 용도 | 근거 |
|----------|---------|---------|-----------|
| TypeScript | 5.x | 백엔드 서비스, CDK 인프라 | 팀 전문성, 타입 안정성 |
| Python | 3.12+ | 데이터 처리, Lambda 함수 | ML 라이브러리 생태계 |

### Permitted Languages
[정당화되면 사용 가능하지만 필수는 아닌 언어.]

| 언어 | 사용 조건 |
|----------|-------------------|
| Go | 지연이 결정적인 고처리량 마이크로서비스에 한해 승인 |
| Rust | 기술 리드 승인 하에 시스템 수준 컴포넌트에만 승인 |

### Prohibited Languages
[사용해서는 안 되는 언어와 사유.]

| 언어 | 사유 |
|----------|--------|
| PHP | 팀 전문성 없음, 플랫폼 방향과 불일치 |
| Ruby | 조직 표준이 신규 Ruby 서비스 금지 |
```

**브라운필드 추가:**

```markdown
### Existing Language Inventory
[현재 코드베이스에 있는 언어 — 유지 또는 마이그레이션 대상.]

| 언어 | 현재 사용 | 방향 |
|----------|--------------|-----------|
| Java 11 | 핵심 백엔드 서비스 | 유지 (Phase 2에 Java 21 업그레이드) |
| JavaScript | 레거시 프런트엔드 | TypeScript로 마이그레이션 |
```

---

### 3. 프레임워크 및 라이브러리 (공통)

```markdown
## Frameworks and Libraries

### Required Frameworks
[해당 도메인에서 반드시 사용해야 하는 프레임워크.]

| 프레임워크/라이브러리 | 버전 | 도메인 | 근거 |
|-------------------|---------|--------|-----------|
| React | 18.x | 프런트엔드 UI | 조직 표준 |
| Express | 4.x | API 계층 | 가벼움, 팀 친숙 |
| AWS CDK | 2.x | IaC | AWS 배포 대상 |
| Jest | 29.x | 단위 테스트 | 프로젝트 간 일관된 테스트 러너 |

### Preferred Libraries
[필요한 역량이 있을 때 사용해야 하지만, 그 역량이 필요하지 않으면 강제는 아닌 라이브러리.]

| 라이브러리 | 용도 | 사용 시점 |
|---------|---------|----------|
| Zod | 런타임 타입 검증 | 외부 데이터 수집 또는 API 입력 |
| Pino | 구조화 로깅 | 로그를 내보내는 모든 서비스 |
| Axios | HTTP 클라이언트 | 서비스의 외부 HTTP 호출 |

### Prohibited Libraries
[사용 금지 라이브러리. 권장 대안 포함.]

| 라이브러리 | 사유 | 대안 |
|---------|--------|-------------|
| Moment.js | 폐기, 큰 번들 크기 | date-fns 또는 Luxon |
| Lodash (전체) | 번들 크기 | 네이티브 JS 또는 특정 임포트에 lodash-es |
| Request | 폐기 | Axios 또는 네이티브 fetch |

### Library Approval Process
[필수/선호 목록에 없는 라이브러리 사용 승인 절차?]

- [절차를 기술. 예: "정당성, 라이선스 점검, 유지보수 상태 평가를 포함한
  기술 리뷰 요청을 아키텍처 팀에 제출."]
```

---

### 4. 클라우드 환경 및 서비스 (공통)

```markdown
## Cloud Environment

### Cloud Provider
- **Primary Provider**: [AWS / Azure / GCP]
- **Account Structure**: [단일 계정 / 멀티 계정 / 조직]
- **Regions**: [주 리전 및 DR 리전]

### Service Allow List
[승인된 서비스 목록. 이 목록에 있는 서비스만 추가 승인 없이 사용 가능.]

| 서비스 | 승인된 사용 사례 | 제약 |
|---------|-------------------|-------------|
| AWS Lambda | 이벤트 기반 컴퓨팅, API 핸들러 | 최대 15분 타임아웃, 10GB 메모리 |
| Amazon DynamoDB | 키-값/문서 저장 | 개발 환경은 온디맨드, 운영은 프로비저닝 |
| Amazon S3 | 객체 저장, 정적 자산 | 버전닝과 암호화 활성화 필수 |
| Amazon SQS | 비동기 메시지 큐 | 표준 큐 선호, 순서 필요 시에만 FIFO |
| Amazon CloudWatch | 모니터링, 로깅, 알람 | 모든 서비스가 구조화 로그 발신 |
| AWS Secrets Manager | 시크릿 저장 | 모든 자격증명과 API 키 |
| Amazon API Gateway | REST 및 HTTP API 노출 | 신규 서비스는 REST보다 HTTP API 선호 |
| Amazon ECR | 컨테이너 이미지 레지스트리 | 모든 컨테이너 기반 서비스에 필수 |
| AWS ECS Fargate | 컨테이너 컴퓨팅 | EC2 기반 ECS보다 선호 |
| Amazon RDS PostgreSQL | 관계형 데이터 저장 | 가변 워크로드는 Aurora Serverless v2 |

### Service Disallow List
[사용 금지 서비스, 사유, 승인된 대안.]

| 서비스 | 사유 | 대안 |
|---------|--------|-------------|
| Amazon EC2 (직접) | 관리형/서버리스 컴퓨팅 선호 | Lambda 또는 ECS Fargate |
| Amazon ElastiCache | 현 규모 대비 비용/운영 부담 | DynamoDB DAX 또는 앱 수준 캐싱 |
| AWS Elastic Beanstalk | IaC 워크플로와 불일치 | CDK + ECS 또는 Lambda |
| Amazon Kinesis | 복잡도가 현 요구를 초과 | SQS 또는 EventBridge |

### Service Approval Process
[허용 목록에 없는 서비스 사용 승인 절차?]

- [절차를 기술. 예: "비즈니스 정당성, 비용 추정, 보안 검토, 운영 계획을
  포함한 Cloud Service Request 제출. 아키텍처 팀 승인 필요."]
```

---

### 5. 선호 기술 및 패턴 (공통)

```markdown
## Preferred Technologies and Patterns

### Architecture Patterns
| 패턴 | 사용 시점 | 사용 금지 시점 |
|---------|-------------|-----------------|
| Serverless-first | 신규 서비스의 기본값 | 영속 연결 또는 15분 초과 처리가 필요한 워크로드 |
| Event-driven | 비동기 워크플로, 디커플드 서비스 | 후속 영향 없는 단순 CRUD |
| Microservices | 독립 배포 가능한 도메인 | 단일 팀 소유의 작은 프로젝트 |
| Monolith (modular) | 단일 팀 프로젝트, 초기 MVP | 다팀 또는 독립 확장 도메인 |

### API Design Standards
- **Style**: [REST / GraphQL / gRPC] - [각각 사용 시점]
- **Versioning**: [URL 경로 버전(v1/v2) / 헤더 기반]
- **Documentation**: [모든 REST API에 OpenAPI 3.x 사양 필수]
- **Naming Convention**: [URL은 kebab-case, JSON 필드는 camelCase]
- **Pagination**: [커서 기반 선호, 관리자 API에는 오프셋 기반 허용]
- **Error Format**: [표준 오류 응답 구조]

### Data Patterns
- **Primary Data Store**: [서비스 소유 데이터에 DynamoDB]
- **Relational Data**: [관계형 쿼리가 필요할 때 RDS PostgreSQL]
- **Caching Strategy**: [캐싱 접근 기술]
- **Data Ownership**: [각 서비스가 자신의 데이터 소유, 공유 DB 금지]

### Messaging and Events
- **Synchronous**: [요청-응답에 서비스 간 HTTP/REST]
- **Asynchronous**: [태스크 큐는 SQS, 이벤트 분배는 EventBridge]
- **Event Schema**: [이벤트 스키마 표준 기술, 예: CloudEvents 형식]

### Frontend Patterns (해당 시)
- **Component Library**: [예: 내부 디자인 시스템, Material UI, Shadcn]
- **State Management**: [예: 로컬은 React Context, 전역은 Zustand]
- **Routing**: [예: React Router v6]
- **Build Tool**: [예: Vite]
```

---

### 6. 보안 요구사항 (공통)

```markdown
## Security Requirements

### Authentication and Authorization
- **Authentication Method**: [예: Amazon Cognito, OIDC, SAML]
- **Authorization Model**: [예: RBAC, ABAC, 커스텀 정책 엔진]
- **Token Format**: [예: RS256 서명의 JWT]
- **Session Management**: [예: 토큰 만료, 리프레시 토큰 회전]

### Data Protection
- **Encryption at Rest**: [모든 데이터 저장소 필수. KMS 키 관리 명시.]
- **Encryption in Transit**: [모든 통신에 TLS 1.2+ 필수]
- **PII Handling**: [PII 필드 식별, 마스킹 요건, 보존 정책]
- **Data Classification**: [Public / Internal / Confidential / Restricted]

### Network Security
- **VPC Requirements**: [VPC 내에서 실행되어야 하는 서비스]
- **Security Groups**: [최소 권한 규칙, 0.0.0.0/0 인바운드 금지]
- **WAF**: [모든 공개 엔드포인트 필수]
- **Private Endpoints**: [가능한 경우 AWS 서비스 접근에 VPC endpoint 사용]

### Secrets Management
- **Secrets Storage**: [AWS Secrets Manager / Parameter Store]
- **Rotation Policy**: [N일마다 자동 회전]
- **Access Policy**: [서비스별 최소 권한 IAM 정책]
- **Prohibited Practices**:
  - 소스코드, 빌드 시 환경 변수, 구성 파일에 시크릿 금지
  - 서비스 간 공유 자격증명 금지
  - 장기 액세스 키 금지

### Compliance Requirements
- **Standards**: [SOC 2, HIPAA, PCI-DSS, GDPR, FedRAMP 또는 "특정 표준 없음"]
- **Audit Logging**: [모든 API 호출 로깅, CloudTrail 활성화, 로그 보존 기간]
- **Vulnerability Scanning**: [컨테이너 이미지 스캔, 의존성 스캔 도구]

### Dependency Security
- **Dependency Scanning**: [도구와 주기, 예: Dependabot 주간, PR 시 Snyk]
- **License Policy**: [허용 라이선스: MIT, Apache 2.0, BSD. 금지: GPL, AGPL]
- **Update Policy**: [중대 취약점은 N일 내 패치]

### Security Compliance Framework

모든 프로젝트는 보안 위험 프레임워크를 채택하고, 해당 프레임워크의 각 위험 카테고리를
프로젝트가 어떻게 대응하는지 문서화해야 합니다. 프레임워크 선택은 프로젝트의 도메인,
규제 환경, 조직 표준에 따라 달라집니다.

**하나 이상의 프레임워크를 선택하고 카테고리별로 컴플라이언스 문서화:**

- **Framework chosen**: [이름과 버전. 예: OWASP Top 10 (2021),
  NIST 800-53, CIS Controls v8, AWS Well-Architected Security Pillar,
  SANS Top 25 또는 내부 조직 프레임워크]
- **Rationale**: [이 프레임워크 선정 이유. 적용 시 규제 요건, 고객 계약,
  조직 정책 등 인용.]

**컨텍스트별 일반적인 프레임워크:**

| 컨텍스트 | 일반적인 프레임워크 선택 |
|---------|------------------------|
| 웹 애플리케이션/API | OWASP Top 10, OWASP API Security Top 10 |
| 클라우드 네이티브 인프라 | AWS/Azure/GCP Well-Architected Security Pillar, CIS Benchmarks |
| 정부/규제 산업 | NIST 800-53, FedRAMP, ISO 27001 |
| 일반 소프트웨어 | CIS Controls v8, SANS Top 25 |
| 내부/저위험 | 조직 보안 체크리스트(여기 문서화) |

**선정한 프레임워크의 각 위험 카테고리에 대해 다음을 문서화:**

1. **프로젝트가 어떻게 대응하는가** - 위험을 완화하는 구체적인 통제, 패턴, 도구
2. **해당 없음(Not Applicable) 사유** - 적용되지 않는 경우 명시. 카테고리를 비워두지 마세요.
3. **연기 항목** - 통제가 추후 단계로 계획된 경우 현재 갭과 조치 목표 단계 문서화

**상세 컴플라이언스 매트릭스 위치:**

작은 프레임워크(카테고리 10개 이하)의 경우 이 문서의 본 헤딩 아래에 전체 매트릭스 포함.

큰 프레임워크(NIST 800-53, ISO 27001)의 경우 별도 파일을 만들고 여기서 참조:
- `security/[framework-name]-compliance.md`

OWASP Top 10 (2021)을 선정한 완전한 예시는 CalcEngine 예시를 참고하세요.
```

---

### 7. 테스트 요구사항 (공통)

```markdown
## Testing Requirements

### Test Strategy Overview
| 테스트 유형 | 필수 | 커버리지 목표 | 도구 |
|-----------|----------|----------------|---------|
| 단위 테스트 | 예 | 라인 커버리지 80% 이상 | Jest / pytest |
| 통합 테스트 | 예 | 모든 서비스 간 상호작용 | Jest + Testcontainers / pytest |
| 종단간(E2E) 테스트 | 조건부 | 핵심 사용자 여정 | Playwright / Cypress |
| 컨트랙트 테스트 | 조건부 | 모든 서비스 간 API | Pact |
| 성능 테스트 | 조건부 | SLA 목표 정의 시 | k6 / Artillery |
| 보안 테스트 | 예 | 모든 공개 엔드포인트 | OWASP ZAP / Snyk |

### Unit Testing Standards
- **Coverage Minimum**: [라인 80%, 분기 70%]
- **Mocking Policy**: [외부 의존성은 모킹, 내부 비즈니스 로직은 모킹 금지]
- **Naming Convention**: [describe/it 패턴, 예: "describe('OrderService') > it('should calculate total with tax')"]
- **Test Location**: [소스와 동일 위치(예: `__tests__/`) 또는 별도 트리(예: `tests/unit/`)]

### Integration Testing Standards
- **Scope**: [실제 서비스 상호작용, DB 쿼리, API 컨트랙트 테스트]
- **Environment**: [Docker Compose / Testcontainers 로컬 컨테이너]
- **Data Management**: [테스트 픽스처, DB 시딩과 정리 접근]

### End-to-End Testing Standards
- **Scope**: [핵심 사용자 여정에 한정, 포괄적 UI 테스트 아님]
- **Environment**: [배포된 스테이징 환경]
- **Data-testid Requirements**: [모든 인터랙티브 요소에 안정적 data-testid 속성 필요]

### Performance Testing Standards
- **Baseline Requirements**: [SLA 목표 정의: 응답 시간, 처리량, 오류율]
- **Test Scenarios**: [부하 테스트, 스트레스 테스트, 내구성(soak) 테스트]
- **Tooling**: [k6 / Artillery / JMeter]

### CI/CD Testing Gates
[파이프라인 각 단계에서 통과해야 하는 테스트 정의.]

| 파이프라인 단계 | 필수 테스트 | 실패 시 조치 |
|---------------|---------------|----------------|
| 사전 커밋 | 린팅, 타입 체크 | 커밋 차단 |
| 풀 리퀘스트 | 단위 테스트, 통합 테스트 | 머지 차단 |
| 배포 전(스테이징) | E2E 테스트, 컨트랙트 테스트 | 배포 차단 |
| 배포 후(운영) | 스모크 테스트, 헬스 체크 | 자동 롤백 |
```

---

### 8. 예시 및 템플릿 코드 가이드 (공통)

이 섹션은 AI-DLC와 개발 팀이 프로젝트 컨벤션을 확립하는 예시/템플릿 코드를 어떻게 제공·사용·유지보수할지 안내합니다.

````markdown
## Example and Template Code Guidance

### Purpose of Example Code
예시 코드는 프로젝트의 **표준 패턴**을 확립합니다. AI-DLC가 코드를 생성할 때
새로운 방식을 임의로 만들기보다 이 패턴을 따라야 합니다. 개발자가 코드를 쓸 때
일관성을 위해 이 예시를 참조합니다.

### When to Provide Example Code
다음 중 어떤 것에든 예시/템플릿 코드를 제공하세요.

- **프로젝트 구조 셋업** - 디렉터리 레이아웃, 파일 명명, 모듈 구성
- **API 엔드포인트 패턴** - 라우트부터 응답까지의 표준 엔드포인트 구조
- **데이터베이스 접근 패턴** - 쿼리, 트랜잭션, 연결 처리 방식
- **오류 처리 패턴** - 표준 오류 타입, 오류 응답 형식, 로깅
- **인증/인가 통합** - 엔드포인트에 auth 적용 방식
- **테스트 패턴** - 표준 단위 테스트와 통합 테스트 구조
- **로깅 패턴** - 구조화 로그 형식, 레벨별 로그 내용
- **구성 패턴** - 환경별 구성 로드 방식
- **IaC 패턴** - 표준 CDK 컨스트럭트 또는 Terraform 모듈 모습

### How to Structure Example Code

#### Location
AI-DLC와 개발자가 참조할 수 있도록 전용 디렉터리에 예시 코드를 저장합니다.

```
project-root/
  examples/                        # 또는 선호 시 "templates/"
    api-endpoint/
      handler.ts                   # 예시 API 핸들러
      handler.test.ts              # 대응 테스트
      README.md                    # 패턴 설명과 사용 시점
    database-access/
      repository.ts                # 예시 리포지토리 패턴
      repository.test.ts
      README.md
    infrastructure/
      standard-lambda-stack.ts     # 예시 CDK 스택
      README.md
```

#### Structure of Each Example
모든 예시에 포함되어야 할 것:

1. **동작하는 코드** - 의사 코드 금지. 컴파일/실행 가능해야 함.
2. **대응 테스트** - 패턴을 어떻게 테스트하는지 보여줌.
3. **README.md** - 다음을 설명:
   - 어떤 패턴을 시연하는가
   - 언제 사용하는가
   - 언제 사용하지 않는가
   - 커스터마이즈 가능한 부분 vs 그대로 유지할 부분
   - 본 기술 환경 문서의 관련 표준 링크

#### Example README Template

```
# [패턴 이름] 예시

## What This Demonstrates
[패턴을 설명하는 한 단락.]

## When to Use
- [조건 1]
- [조건 2]

## When Not to Use
- [조건 1 - 대안 참조 포함]

## File Inventory
| 파일              | 목적                    |
| --------------- | ---------------------- |
| handler.ts      | 예시 구현                |
| handler.test.ts | 테스트 패턴              |

## Customization Guide
| 요소                       | 커스터마이즈?  | 비고                              |
| ------------------------ | ----------- | -------------------------------- |
| 오류 처리 구조             | 아니오       | 프로젝트 표준을 반드시 따를 것      |
| 비즈니스 로직             | 예           | 실제 도메인 로직으로 교체           |
| 라우트 경로               | 예           | API 명명 규칙 준수                |
| 로깅 호출                | 아니오       | 구조화 로깅 형식 유지              |

## Related Standards
- [API Design Standards 섹션 링크]
- [Error Handling 패턴 링크]
```

### How AI-DLC Uses Example Code

코드 생성 중 AI-DLC는 다음을 해야 합니다.

1. **먼저 예시 읽기** - 코드 생성 전에 examples/ 디렉터리의 관련 예시를 읽음
2. **확립된 패턴 따르기** - 예시에 나타난 구조, 명명, 오류 처리, 테스트 패턴을 일치
3. **대안 임의 생성 금지** - 패턴에 대한 예시가 존재하면 그것을 사용. 예시가 명시적으로
   적용되지 않을 때를 제외하고는 다른 접근을 만들지 않음.
4. **계획에서 예시 참조** - 코드 생성 계획서는 각 단계에 어떤 예시가 적용되는지 참조

### Maintaining Example Code

- **표준 변경 시 예시 업데이트** - 예시는 본 기술 환경 문서와 항상 일치해야 함
- **온보딩 시 예시 검토** - 신규 팀원은 코드 기여 전 모든 예시를 읽어야 함
- **프로젝트와 함께 예시 버전 관리** - 예시는 같은 저장소에 살며 운영 코드와 같은 리뷰
  프로세스를 거침
- **폐기된 예시 표시** - 패턴이 대체되면 디렉터리 이름에 "deprecated-" 접두를 붙이고
  대체본을 가리키는 노트 추가
````

---

### 9. 브라운필드 전용 섹션

브라운필드 프로젝트에만 포함하세요.

```markdown
## Brownfield: Existing Technical Inventory

### Current State Assessment
[가능하면 Reverse Engineering 산출물을 참조하거나, 현재 기술 상태의 요약을 제공.]

- **Current Languages**: [버전 포함 목록]
- **Current Frameworks**: [버전 포함 목록]
- **Current Infrastructure**: [클라우드 서비스, 배포 모델]
- **Current Test Coverage**: [퍼센트 또는 정성 평가]
- **Known Technical Debt**: [주요 항목]

### Migration and Modernization Rules

#### What to Keep
[유지해야 할 기술과 패턴.]

| 기술 | 유지 사유 |
|-----------|---------------|
| [기술] | [근거] |

#### What to Migrate
[교체할 기술 — 목표와 일정.]

| 현재 | 목표 | 우선순위 | 접근 방식 |
|---------|--------|----------|----------|
| JavaScript | TypeScript | 높음 | 파일 단위 점진적 마이그레이션 |
| REST API v1 | REST API v2 | 중간 | 신규 엔드포인트는 v2, 기존은 Phase 2 마이그레이션 |

#### What to Remove
[제거할 기술/패턴/의존성.]

| 항목 | 사유 | 제거 일정 |
|------|--------|-----------------|
| [폐기 라이브러리] | [보안/유지보수 우려] | [시점] |

### Coexistence Rules
[구 패턴과 신 패턴이 공존해야 할 때 규칙 정의.]

- **API versioning during migration**: [v1과 v2의 공존 방식]
- **Database schema migration**: [기존 데이터와 함께 스키마 변경 관리 방식]
- **Feature flags**: [전환 중 신규 기능 게이팅 방식]
- **Dependency conflicts**: [충돌하는 라이브러리 버전 관리 방식]
```

---

## 이 문서가 AI-DLC에 어떻게 연결되는가

| 기술 환경 섹션                       | AI-DLC 단계                              | 활용 방식                                          |
| ----------------------------------- | -------------------------------------- | -------------------------------------------------- |
| Project Technical Summary           | Workspace Detection                    | 프로젝트 분류 컨텍스트                              |
| Programming Languages               | Code Generation                        | 언어 선택, 버전 제약                                |
| Frameworks and Libraries            | Code Generation, NFR Design            | 의존성 선택, 금지 라이브러리 검사                    |
| Cloud Services Allow/Disallow Lists | Infrastructure Design                  | 서비스 선택 경계                                    |
| Preferred Patterns                  | Application Design, Functional Design  | 아키텍처/디자인 패턴 결정                            |
| Security Requirements               | NFR Requirements, NFR Design           | 보안 패턴 선택, 컴플라이언스 검사                   |
| Testing Requirements                | Code Generation, Build and Test        | 테스트 전략, 도구, 커버리지 목표                    |
| Example Code                        | Code Generation                        | 코드 생성 시 패턴 참조                              |
| Brownfield Inventory                | Reverse Engineering, Workflow Planning | 마이그레이션 결정과 공존 규칙                        |
