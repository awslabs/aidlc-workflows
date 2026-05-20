# 기술 환경 문서: CalcEngine 과학 계산기 API

## 프로젝트 기술 요약

- **Project Name**: CalcEngine
- **Project Type**: Greenfield
- **Primary Runtime Environment**: Cloud
- **Cloud Provider**: AWS
- **Target Deployment Model**: 서버리스 (API Gateway + Lambda)
- **Package Manager**: uv
- **Team Size**: 4명 (백엔드 개발자 2명, 문서 포털용 프런트엔드 개발자 1명, QA 엔지니어 1명)
- **Team Experience**: Python 백엔드 경험 우수, AWS 경험 중간, 수학 라이브러리 개발 경험 없음. FastAPI와 Flask 실무 경험 있음. pytest에 익숙. CDK 경험은 제한적(예시가 필요).

---

## 프로그래밍 언어

### 필수 언어

| 언어         | 버전       | 용도                                                       | 근거                                                                                                                  |
| ----------- | --------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Python      | 3.12+     | API 서비스, 수학 엔진, Lambda 핸들러, CDK 인프라                | 팀의 주 언어. 풍부한 수학 생태계(mpmath, numpy, scipy). uv는 빠르고 신뢰성 있는 의존성 관리 제공.                       |
| HTML/CSS/JS | ES2022+   | 문서 포털 (정적 사이트)                                     | API 문서를 위한 최소한의 프런트엔드. 프레임워크 불필요; Jinja2 템플릿으로 정적 생성.                                  |

### 허용 언어

| 언어        | 사용 조건                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rust       | Python 성능이 부족한 경우 성능 결정적 수학 함수(예: 표현식 파서)에 한해 승인. 도입 전에 프로파일링 근거 필요. PyO3/maturin으로 Python에 노출. |
| TypeScript | 팀이 Python CDK보다 TypeScript CDK를 선호하는 경우 CDK 인프라에 한해 승인. 결정은 프로젝트 중간이 아닌 Construction 시작 전에.                              |

### 금지 언어

| 언어         | 사유                                                                       | 대신 사용할 것                                  |
| ---------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| Java       | 팀 전문성 없음. 운영 복잡도 증가(Lambda의 JVM 콜드 스타트).                  | Python                                        |
| Go         | 팀 전문성 없음. Python이 현재 모든 요구사항을 커버.                          | Python                                        |
| C/C++      | 네이티브 확장 유지보수 부담.                                                  | 네이티브 성능이 필요하면 PyO3 통해 Rust       |

---

## 패키지 및 환경 관리

### 표준 도구로서의 uv

uv는 이 프로젝트의 **유일한 패키지/환경 관리 도구** 입니다. pip, pip-tools, poetry, pipenv, conda를 사용하지 마세요.

### uv 사용 표준

```bash
# 프로젝트 초기화 (이미 완료. 재실행 금지)
uv init calcengine
cd calcengine

# 의존성 추가
uv add fastapi                      # 런타임 의존성 추가
uv add uvicorn[standard]            # extras 포함 추가
uv add --dev pytest pytest-cov      # 개발 의존성 추가
uv add --dev mypy ruff              # 개발 도구 추가

# 의존성 제거
uv remove requests                  # 의존성 제거

# 프로젝트 환경에서 명령 실행
uv run python -m calcengine.main    # 애플리케이션 실행
uv run pytest                       # 테스트 실행
uv run mypy src/                    # 타입 체크
uv run ruff check src/              # 린터 실행

# lockfile에서 환경 동기화
uv sync                             # uv.lock의 모든 의존성 설치
uv sync --dev                       # 개발 의존성 포함

# lockfile 관리
# uv.lock은 자동 생성. 직접 편집 금지.
# uv.lock은 반드시 버전 관리에 커밋.
```

### 의존성 파일 표준

| 파일                | 목적                                                            | Git 커밋  |
| ----------------- | ------------------------------------------------------------- | ----------------- |
| `pyproject.toml`  | 프로젝트 메타데이터, 의존성 선언, 도구 구성                          | 예                |
| `uv.lock`         | 정확한 해결된 버전을 가진 결정적(deterministic) lockfile          | 예                |
| `.python-version` | 프로젝트의 Python 버전 핀(예: `3.12`)                            | 예                |

### pyproject.toml 컨벤션

모든 프로젝트 구성은 `pyproject.toml`에 둡니다. pyproject.toml 구성을 지원하는 도구에 대해 별도 구성 파일을 만들지 마세요.

```toml
[project]
name = "calcengine"
version = "0.1.0"
description = "Scientific calculator REST API"
requires-python = ">=3.12"
dependencies = [
    # uv add로 런타임 의존성이 여기 추가됨
]

[dependency-groups]
dev = [
    # uv add --dev로 개발 의존성이 여기 추가됨
]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-v --tb=short --strict-markers"
markers = [
    "unit: 단위 테스트 (빠름, 외부 의존성 없음)",
    "integration: 통합 테스트 (서비스 필요할 수 있음)",
    "accuracy: 수학적 정확성 검증 테스트",
]

[tool.mypy]
python_version = "3.12"
strict = true
warn_return_any = true
warn_unused_configs = true
disallow_untyped_defs = true

[tool.ruff]
target-version = "py312"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "W", "I", "N", "UP", "B", "A", "SIM", "TCH"]

[tool.coverage.run]
source = ["src/calcengine"]
branch = true

[tool.coverage.report]
fail_under = 90
show_missing = true
```

---

## 프레임워크 및 라이브러리

### 필수 프레임워크

| 프레임워크/라이브러리 | 버전     | 도메인                                            | 근거                                                                                                       |
| ------------------- | --------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| FastAPI             | 0.115+    | REST API 프레임워크                                 | async 지원, 자동 OpenAPI 사양 생성, Pydantic 검증, 강력한 Python 타입 통합                                  |
| Pydantic            | 2.x       | 요청/응답 검증, 설정 관리                            | 타입 안전 데이터 모델, JSON 직렬화, FastAPI에 필수                                                          |
| uvicorn             | 0.30+     | ASGI 서버                                          | FastAPI의 표준 운영 서버. 로컬과 Mangum을 통한 Lambda에서 사용                                              |
| Mangum              | 1.x       | Lambda 어댑터                                      | FastAPI ASGI 앱을 AWS Lambda 핸들러로 래핑. 무설정 어댑터                                                   |
| pytest              | 8.x       | 테스트 프레임워크                                  | 팀 표준. 풍부한 플러그인 생태계                                                                            |
| mypy                | 1.x       | 정적 타입 체크                                     | 런타임 전 타입 오류 포착. strict 모드 적용                                                                  |
| ruff                | 0.8+      | 린팅 및 포매팅                                     | flake8, isort, black을 단일 빠른 도구로 대체                                                                |
| structlog           | 24.x+     | 구조화 JSON 로깅                                   | 모든 Lambda 핸들러와 API 엔드포인트는 구조화 JSON 로그 발신. 공유 모듈에 한 번 구성                          |
| aws-cdk-lib         | 2.x       | IaC                                                | AWS 배포. 모든 인프라에 Python CDK 컨스트럭트                                                              |

### 선호 라이브러리

해당 역량이 필요할 때만 사용하세요. 선제적으로 추가하지 마세요.

| 라이브러리      | 목적                                              | 사용 시점                                                                                                                          |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| mpmath         | 임의 정밀도 산술                                   | Phase 2: 임의 정밀도 모드 구현 시. MVP에서는 불필요(IEEE 754 배정도면 충분).                                                       |
| numpy          | 배열 연산, 선형대수                                | Phase 2: 행렬/벡터 연산 구현 시. 기본 산술에는 사용 금지.                                                                          |
| scipy          | 통계 분포, 수치 적분                                | Phase 2+: 고급 통계와 미적분 구현 시.                                                                                              |
| httpx          | async HTTP 클라이언트                              | 외부 HTTP 호출(예: Phase 3의 환율 조회). async 호환성으로 requests보다 선호.                                                       |
| boto3          | AWS SDK                                          | 배포 시 CDK가 처리하지 않는 AWS 서비스 직접 상호작용(예: 런타임의 DynamoDB 쿼리, Secrets Manager 읽기).                            |
| pytest-cov     | 테스트 커버리지 리포트                              | 항상. 프로젝트 시작부터 dev 의존성 포함.                                                                                            |
| pytest-asyncio | async 테스트 지원                                   | async FastAPI 엔드포인트 또는 async 함수 테스트 시.                                                                                |
| hypothesis     | 속성 기반 테스트                                   | 수학 함수 테스트. 랜덤 입력으로 엣지 케이스를 찾음. 모든 수학 모듈에 강력 권장.                                                    |
| freezegun      | 시간 모킹                                          | 시간 의존 로직(레이트 리밋, 토큰 만료, 감사 타임스탬프) 테스트 시.                                                                  |

### 금지 라이브러리

| 라이브러리                     | 사유                                                                              | 대안                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Flask                       | 프로젝트는 FastAPI 사용. 웹 프레임워크 혼용 금지.                                  | FastAPI                                                                                   |
| Django                      | API 서비스에 과도. ORM 불필요.                                                       | FastAPI + 직접 DynamoDB 접근                                                              |
| requests                    | 동기 전용. FastAPI의 async 이벤트 루프 차단.                                         | httpx                                                                                     |
| sympy                       | MVP 범위에 너무 무거움. 큰 의존성 트리 동반.                                          | 표현식 파서 직접 구현. Phase 3 기호 계산에서 재평가.                                       |
| pandas                      | 불필요. CalcEngine은 데이터프레임이 아닌 개별 계산을 처리.                              | 필요 시 표준 파이썬 또는 numpy 배열 연산.                                                  |
| SQLAlchemy                  | MVP에 관계형 DB 없음. DynamoDB가 데이터 저장소.                                       | boto3 DynamoDB 리소스/클라이언트                                                          |
| celery                      | MVP에 불필요한 복잡도. 모든 계산은 동기이며 빠름(<50ms).                              | Phase 3 배치에서 재평가. 더 일찍 async가 필요하면 SQS + Lambda.                          |
| poetry / pipenv / pip-tools | 프로젝트는 uv 전용. 대체 패키지 매니저 도입 금지.                                       | uv                                                                                        |
| black / isort / flake8      | ruff가 셋을 모두 대체.                                                              | ruff                                                                                      |

### 라이브러리 승인 절차

필수/선호 목록에 없는 라이브러리를 추가하려면:

1. "Dependency Request: [library-name]" 제목의 GitHub 이슈를 엽니다
2. 포함: 목적, 검토한 대안, 라이선스(MIT, Apache 2.0, BSD 중 하나), 유지보수 상태(최근 릴리스일, 열린 이슈 수), 크기 영향
3. 기술 리드가 검토하고 승인/거절
4. 승인 시 `uv add`로 추가하고 본 문서 업데이트

---

## 클라우드 환경

### 클라우드 공급자

- **Primary Provider**: AWS
- **Account Structure**: MVP는 단일 AWS 계정. Phase 2에서 dev/staging/prod 계정 분리.
- **Regions**: `us-east-1`(주). MVP에 DR 리전 없음. Phase 2에 다중 리전 계획.

### 서비스 허용 목록

| 서비스                         | 승인된 사용 사례                                                              | 제약                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| AWS Lambda                    | API 요청 핸들러, 수학 계산                                                   | Python 3.12 런타임. MVP는 최대 256MB 메모리(프로파일링 필요 시 증가). 30초 타임아웃.                              |
| Amazon API Gateway (HTTP API) | 공개 REST API 엔드포인트                                                     | HTTP API 타입(REST API 타입 아님). 커스텀 도메인 + TLS. 레이트 리밋 사용량 플랜.                                  |
| Amazon DynamoDB               | API 키 저장, 사용량 미터링, 레이트 리밋 카운터                                | 온디맨드 용량 모드. 단일 테이블 설계. 레이트 리밋 윈도우에 TTL.                                                   |
| Amazon S3                     | OpenAPI 사양 호스팅, 정적 문서 사이트, Lambda 배포 패키지                       | 버킷 암호화 활성화. 퍼블릭 접근 차단(문서 사이트 버킷 — CloudFront 배포 제외).                                  |
| Amazon CloudFront             | 문서 포털과 API 사양용 CDN                                                  | HTTPS 전용. 정적 자산 캐싱 적극 사용.                                                                          |
| Amazon CloudWatch             | 로깅, 메트릭, 알람, 대시보드                                                  | 모든 Lambda의 구조화 JSON 로그. 계산 카운트, 지연 백분위, 오류율 커스텀 메트릭.                                |
| AWS Secrets Manager           | Stripe API 키, 서명 키                                                        | 지원되는 곳에서 자동 회전. Lambda는 콜드 스타트에서 읽고 메모리에 캐시.                                          |
| AWS Certificate Manager       | 커스텀 도메인 TLS 인증서                                                      | API Gateway와 CloudFront에 사용.                                                                              |
| Amazon Cognito                | 문서 포털과 API 키 관리를 위한 개발자 계정 인증                                  | 개발자 가입/로그인 user pool. API 호출 인증에는 사용 안 함(그건 API 키).                                       |
| Amazon SQS                    | 실패한 비동기 작업의 dead-letter 큐                                          | 표준 큐. 실패한 청구 이벤트와 오류 캡처에 사용. MVP의 계산 요청에는 사용 안 함.                                  |
| AWS CDK                       | IaC 배포                                                                       | Python CDK. 모든 인프라는 CDK 정의. 수동 콘솔 변경 금지.                                                       |
| AWS CloudTrail                | API 감사 로깅                                                                  | 모든 관리 이벤트에 대해 활성화. 운영에서는 S3, Lambda 데이터 이벤트.                                            |
| AWS IAM                       | 서비스 권한                                                                    | Lambda 함수별 최소 권한 정책. 와일드카드 리소스 권한 금지.                                                    |

### 서비스 금지 목록

| 서비스                       | 사유                                                                       | 대안                                                                |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Amazon EC2                 | 운영 부담. 서버리스 모델 선호.                                                | 컴퓨팅에 Lambda.                                                    |
| Amazon ECS / Fargate       | MVP 요청/응답 워크로드에는 과도.                                              | Lambda. 콜드 스타트가 문제되면 재평가.                                |
| Amazon RDS / Aurora        | 관계형 DB 불필요. API 키와 사용량 데이터는 DynamoDB로 충분.                    | DynamoDB.                                                           |
| Amazon ElastiCache / Redis | MVP에 캐싱 레이어 불필요. 계산은 무상태이며 빠름.                              | 필요하면 Lambda 실행 컨텍스트 내 인메모리 캐싱.                         |
| AWS Elastic Beanstalk      | IaC 모델과 불일치.                                                          | CDK + Lambda.                                                       |
| Amazon Kinesis             | 스트리밍 불필요. 모든 계산은 동기 요청/응답.                                   | 비동기 처리가 필요하면 SQS.                                          |
| AWS Step Functions         | MVP에 다단계 오케스트레이션 없음.                                              | 직접 Lambda 호출. Phase 3 배치 처리에서 재평가.                       |
| Amazon SNS                 | MVP에 pub/sub 불필요.                                                       | dead-letter 큐로 SQS.                                                |

### 서비스 승인 절차

허용 목록에 없는 서비스를 사용하려면:

1. "AWS Service Request: [service-name]" 제목의 GitHub 이슈를 엽니다
2. 포함: 사용 사례, 월 비용 추정, 보안 함의, 운영 부담, 허용된 서비스로 해결할 수 없는 이유
3. 기술 리드 검토. PII 접근 또는 네트워크 노출 서비스는 추가 보안 검토 필요.
4. 승인 시 CDK 컨스트럭트 추가 후 본 문서 업데이트

---

## 선호 기술 및 패턴

### 아키텍처 패턴

**서버리스 함수로 배포된 모듈식 모놀리식.**

CalcEngine은 내부 모듈(산술, 삼각법, 통계 등)을 가진 단일 Python 패키지로, 단일 FastAPI 애플리케이션을 통해 노출되며 API Gateway 뒤 AWS Lambda에 배포됩니다. 이는 마이크로서비스 아키텍처가 아닙니다.

| 결정              | 선택                                                       | 근거                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 아키텍처 스타일   | 모듈식 모놀리식                                            | 소규모 팀(4명), 단일 도메인, MVP에서 모듈별 독립 확장 요건 없음.                                                                                                          |
| 배포 모델         | Mangum을 통해 모든 API 라우트를 서빙하는 단일 Lambda 함수    | 단순성. 단일 배포 산출물. 콜드 스타트가 모든 엔드포인트에 분산.                                                                                                          |
| 모듈 경계         | `src/calcengine/` 내 Python 패키지                            | 별도 서비스 운영 비용 없이 깨끗한 내부 경계. 특정 엔드포인트가 다른 메모리/타임아웃이 필요하면 추후 별도 Lambda로 추출 가능.                                              |

### API 설계 표준

- **Style**: HTTPS상의 REST. JSON 요청/응답 본문.
- **Base URL**: `https://api.calcengine.io/v1/`
- **Versioning**: URL 경로 접두(`/v1/`, `/v2/`). major 버전만. 비파괴 변경은 버전 증가 없음.
- **Documentation**: FastAPI가 자동 생성하는 OpenAPI 3.1 사양. `https://docs.calcengine.io`에서 호스팅.
- **Naming Convention**: JSON 필드명은 snake_case(파이썬 컨벤션). URL 경로는 kebab-case.
- **Content Type**: 모든 요청/응답에 `application/json`. XML 미지원.

**표준 요청 형식:**

```json
{
  "expression": "sin(pi/4) * 2 + sqrt(16)",
  "options": {
    "angle_mode": "radians",
    "precision": 15
  }
}
```

**표준 성공 응답 형식:**

```json
{
  "result": 5.414213562373095,
  "expression": "sin(pi/4) * 2 + sqrt(16)",
  "computation_time_ms": 2.3,
  "engine_version": "0.1.0"
}
```

**표준 오류 응답 형식:**

```json
{
  "error": {
    "code": "DOMAIN_ERROR",
    "message": "Cannot compute logarithm of a negative number",
    "detail": "log(-5) is undefined for real numbers",
    "parameter": "expression",
    "documentation_url": "https://docs.calcengine.io/errors/DOMAIN_ERROR"
  }
}
```

**오류 코드(MVP):**

| 코드                    | HTTP 상태   | 의미                                                              |
| --------------------- | ------------ | --------------------------------------------------------------- |
| `PARSE_ERROR`         | 400          | 표현식 파싱 불가. 잘못된 문법.                                       |
| `DOMAIN_ERROR`        | 422          | 수학적으로 정의되지 않음(log(-1), sqrt(-1), 0 나누기).               |
| `OVERFLOW_ERROR`      | 422          | 결과가 표현 가능 범위 초과.                                          |
| `INVALID_PARAMETER`   | 400          | 요청 파라미터 타입/값이 잘못됨.                                       |
| `EXPRESSION_TOO_LONG` | 400          | 표현식이 최대 허용 길이 초과.                                        |
| `RATE_LIMIT_EXCEEDED` | 429          | API 키가 레이트 리밋 초과.                                          |
| `UNAUTHORIZED`        | 401          | API 키 누락 또는 무효.                                             |
| `INTERNAL_ERROR`      | 500          | 예기치 않은 서버 오류.                                              |

### 데이터 패턴

- **Primary Data Store**: DynamoDB (단일 테이블 설계)
- **DynamoDB의 엔터티**: API 키, 사용량 카운터(키별 월별), 레이트 리밋 윈도우(키별 분별)
- **Access Pattern**: 모든 읽기/쓰기는 기본 키(API 키 ID)로. 스캔 없음. 복잡한 쿼리 없음.
- **Caching**: 외부 캐시 없음. Lambda는 웜 호출 간 DynamoDB 연결 재사용. API 키 검증 결과는 Lambda 메모리에 60초간 캐시.
- **관계형 DB 없음**: 관계형 쿼리가 필요해지면(리포팅, 분석), RDS 추가 전 DynamoDB → S3 → Athena 내보내기를 평가.

### 로깅 패턴

모든 로그 출력은 structlog로 구조화 JSON. 사람이 읽는 콘솔 출력은 로컬 개발만.

```python
import structlog

logger = structlog.get_logger()

# 표준 로그 호출
logger.info(
    "calculation_completed",
    expression=expression,
    result=result,
    computation_time_ms=elapsed,
    api_key_id=api_key_id,
)

# 오류 로그 호출
logger.error(
    "calculation_failed",
    expression=expression,
    error_code="DOMAIN_ERROR",
    error_detail=str(e),
    api_key_id=api_key_id,
)
```

**모든 API 요청에 필요한 로그 필드:**

| 필드           | 설명                                                  |
| ------------- | ----------------------------------------------------- |
| `request_id`  | 요청별 고유 ID (API Gateway 또는 생성)                |
| `api_key_id`  | 해시된 API 키 식별자 (원시 키 절대 로깅 금지)         |
| `endpoint`    | 호출된 API 경로                                       |
| `http_method` | GET, POST 등                                          |
| `http_status` | 응답 상태 코드                                        |
| `duration_ms` | 전체 요청 처리 시간                                   |
| `timestamp`   | ISO 8601 타임스탬프                                  |

---

## 보안 요구사항

### 인증 및 인가

- **API 호출 인증**: `Authorization: Bearer {key}` 헤더의 API 키. 32자 랜덤 문자열이며 DynamoDB에 bcrypt 해시로 저장.
- **개발자 포털 인증**: Amazon Cognito user pool. 이메일 + 비밀번호 가입, 이메일 검증.
- **인가 모델**: 평면(flat). 모든 API 키가 모든 엔드포인트 접근. 등급별 레이트 리밋(free, starter, professional)은 엔드포인트 권한이 아닌 사용량 미터링으로 강제.
- **API 키 관리**: 개발자는 포털을 통해 키 생성·회전·폐기. 계정당 최대 3개 활성 키.

### 데이터 보호

- **저장 시 암호화**: DynamoDB는 AWS 관리 KMS 키로 암호화. S3 버킷은 SSE-S3 암호화.
- **전송 시 암호화**: API Gateway 커스텀 도메인과 CloudFront 배포에 TLS 1.2+ 강제. HTTP(평문) 엔드포인트 없음.
- **PII 처리**: 개발자 계정은 이메일과 해시된 비밀번호 저장. 다른 PII 미수집. 수학 표현식은 PII 아님. 표현식은 디버깅용으로 로깅되지만 영구 저장되지 않음(CloudWatch 로그 보존: 30일).
- **데이터 분류**: API 키 = Confidential. 개발자 이메일 = Internal. 수학 표현식과 결과 = Public.

### 입력 검증

- **표현식 길이 제한**: 최대 4,096자. 초과 시 `EXPRESSION_TOO_LONG`으로 거절.
- **표현식 문자 허용 목록**: 영숫자, 산술 연산자(`+ - * / ^ %`), 괄호, 소수점, 쉼표, 공백, 인식된 함수명. 미인식 문자 거절.
- **코드 실행 금지**: 표현식 파서는 절대 `eval()`, `exec()`, `compile()`, 어떤 동적 코드 실행도 사용 금지. 표현식은 AST로 파싱되어 수학 엔진이 평가.
- **재귀 깊이 제한**: 표현식 파서가 중첩 깊이를 100단계로 제한. `(((((...))))` 같은 깊이 중첩 표현식의 스택 오버플로 방지.
- **수치 범위 검증**: IEEE 754 배정도 범위를 초과하는 결과는 `Infinity` 또는 `NaN` 대신 `OVERFLOW_ERROR` 반환.

### 시크릿 관리

- **Stripe API 키**: AWS Secrets Manager에 저장. Lambda가 콜드 스타트에서 읽어 메모리에 캐시.
- **Cognito Client Secret**: AWS Secrets Manager에 저장.
- **금지 관행**:
  - `pyproject.toml`, 소스코드, Git에 커밋된 `.env`에 시크릿 금지
  - Lambda 환경 변수에 시크릿 금지(런타임에 Secrets Manager 사용)
  - 코드에 AWS 액세스 키 금지(Lambda는 IAM 실행 역할 사용)
  - 로컬 개발용 `.env` 파일만 허용, `.gitignore`에 나열

### 의존성 보안

- **스캔**: Python 의존성에 GitHub Dependabot 활성화. 알려진 취약점에 알림.
- **라이선스 정책**: 허용: MIT, Apache 2.0, BSD(2-clause, 3-clause), PSF, ISC. 금지: GPL, LGPL, AGPL, SSPL, 사유. 새 의존성 추가 전 `uv tree`로 확인.
- **업데이트 정책**: Critical/High CVE는 7일 내 패치. Medium은 30일. Low는 분기별 평가.

### OWASP Top 10 컴플라이언스 (2021)

#### A01:2021 - Broken Access Control

| 통제                                       | CalcEngine 구현                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 인가 강제                                   | 라우트 핸들러 실행 전에 FastAPI 미들웨어(`api/middleware/auth.py`)에서 API 키 검증. 유효한 키 없이는 어떤 엔드포인트도 접근 불가.                                                                                                    |
| 기본 거부                                  | API Gateway는 `Authorization` 헤더 없는 요청을 게이트웨이 수준에서 거절(401). Lambda 핸들러는 무효/폐기 키를 거절(401).                                                                                                            |
| 리소스 소유권                              | 각 API 키는 Cognito 계정에 연결. 개발자는 자신의 키만 조회·회전·폐기 가능. DynamoDB 쿼리는 인증된 사용자의 파티션 키로 범위 제한.                                                                                                |
| 레이트 리밋                                 | 미들웨어(`api/middleware/rate_limit.py`)에서 키별 레이트 리밋. Free: 월 10,000 / 초당 10. Starter: 월 1M / 초당 50. Professional: 월 10M / 초당 200. 초과 시 429.                                                                  |
| CORS 정책                                  | API Gateway CORS는 문서 포털 오리진(`https://docs.calcengine.io`)만 허용. 와일드카드 오리진 금지. `GET`, `POST`만.                                                                                                                |
| 디렉터리 트래버설/경로 조작                 | 해당 없음. CalcEngine은 파일을 서빙하지 않고 파일 경로를 입력으로 받지 않음.                                                                                                                                                       |

#### A02:2021 - Cryptographic Failures

| 통제                          | CalcEngine 구현                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 전송 데이터                     | API Gateway 커스텀 도메인과 CloudFront에 TLS 1.2+ 강제. HTTP 엔드포인트 없음. API Gateway는 `SecurityPolicy: TLS_1_2`로 구성.                                                                                |
| 저장 데이터                     | DynamoDB는 AWS 관리 KMS 키로 암호화. S3 버킷은 SSE-S3 암호화. CloudWatch 로그는 서비스 관리 키로 암호화.                                                                                                          |
| 비밀번호/자격증명 저장          | 개발자 포털 비밀번호는 bcrypt 해시(Cognito 관리). API 키는 DynamoDB에 bcrypt 해시로 저장. 원시 API 키는 생성 시 정확히 한 번 반환되며 절대 저장/로깅되지 않음.                                                  |
| 응답의 민감 데이터               | API 응답은 API 키, 계정 자격증명, 내부 식별자를 절대 포함하지 않음. 오류 메시지에 테이블명, ARN, 스택 트레이스 노출 금지.                                                                                          |
| 로그의 민감 데이터               | API 키 ID(해시 식별자, 키 자체 아님)는 로깅. 원시 API 키는 절대 로깅 금지. 개발자 이메일은 계산 로그에 미포함.                                                                                                |

#### A03:2021 - Injection

| 통제                  | CalcEngine 구현                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 표현식 인젝션         | 표현식 파서는 엄격한 문법에서 AST를 구축. `eval()`, `exec()`, `compile()` 또는 어떤 Python 코드 실행 메커니즘도 사용하지 않음. 인식된 토큰(숫자, 연산자, 괄호, 화이트리스트 함수명)만 허용. 미인식 토큰은 `PARSE_ERROR`(400) 발생. |
| 문자 허용 목록         | 표현식 입력은 다음만 허용: 숫자, 소수점, 산술 연산자(`+ - * / ^ %`), 괄호, 쉼표, 공백, 고정된 함수명 집합(`sin`, `cos`, `tan`, `log`, `sqrt` 등). 다른 모든 문자는 파싱 전 거절.                                              |
| NoSQL 인젝션          | DynamoDB 쿼리는 매개변수화된 키 조건과 함께 boto3 SDK 사용. 쿼리 표현식에 사용자 입력 문자열 연결 금지. 파티션 키와 정렬 키는 요청 본문에서 보간이 아닌 프로그래밍 방식으로 설정.                                                                  |
| HTTP 헤더 인젝션      | FastAPI와 Pydantic이 모든 요청 입력을 검증·타입 체크. 응답 헤더는 사용자 입력이 아닌 프레임워크가 프로그래밍 방식으로 설정.                                                                                                       |
| 로그 인젝션           | structlog가 로그 값의 특수 문자를 이스케이프. 사용자 제공 표현식은 로그 형식 문자열에 보간되지 않고 구조화 JSON 필드 내 문자열 값으로 로깅.                                                                                       |

#### A04:2021 - Insecure Design

| 통제                  | CalcEngine 구현                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 위협 모델링           | AIDLC NFR Requirements 단계에서 위협 모델 생성. 새 엔드포인트나 통합 지점 추가 시 검토. 주요 위협: 표현식 인젝션, 자원 고갈, API 키 남용.                                                                                          |
| 심층 방어             | 세 계층에서 검증: (1) API Gateway 요청 검증, (2) FastAPI의 Pydantic 모델 검증, (3) 엔진 함수의 도메인 검증. 각 계층은 독립적으로 거절.                                                                                              |
| 비즈니스 로직 한도    | 표현식 길이 4,096자 제한. 파서 재귀 깊이 100단계 제한. 통계 엔드포인트 최대 배열 크기: 10,000. 정상 사용에 영향 없이 자원 고갈 방지.                                                                                              |
| 남용 사례 테스트       | 테스트 스위트에 negative/abuse 테스트 포함: 과대 표현식, 깊이 중첩 괄호, 느린 평가를 유발하는 표현식, 레이트 리밋 초과 연속 요청, 무효/만료/폐기 API 키.                                                                          |

#### A05:2021 - Security Misconfiguration

| 통제                       | CalcEngine 구현                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IaC                    | 모든 인프라는 AWS CDK(Python) 정의. 수동 콘솔 변경 금지. PR에서 CDK diff 검토 후 배포.                                                                                                                                                       |
| 기본 자격증명             | 어떤 환경에도 기본 API 키, 어드민 계정, 하드코딩 비밀번호 없음. Cognito user pool은 이메일 검증 요구.                                                                                                                                                            |
| 오류 메시지             | 운영 오류 응답은 CalcEngine 오류 코드, 사용자 친화 메시지, 문서 URL을 반환. Python 트레이스백, Lambda ARN, DynamoDB 테이블명, 내부 파일 경로 노출 금지. 운영에서 FastAPI `debug=False`.                                                  |
| 불필요한 기능             | 운영 Lambda에 `/docs`/`/redoc` 인터랙티브 엔드포인트 노출 금지. OpenAPI 사양은 정적 문서 사이트에서만. `engine_version` 외의 버전 세부를 드러내는 헬스 체크 금지.                                                                  |
| 보안 헤더                | API Gateway 응답에 다음 포함: `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, API 응답에 `Cache-Control: no-store`. CloudFront가 문서 사이트에 보안 헤더 추가. |
| Lambda 구성              | Lambda는 최소 필수 메모리(256MB) 사용. 타임아웃 30초. 폭주 스케일링 방지를 위한 예약 동시성 구성. 시크릿 포함 환경 변수 금지(런타임 Secrets Manager).                                                                            |

#### A06:2021 - Vulnerable and Outdated Components

| 통제                  | CalcEngine 구현                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 의존성 스캔            | GitHub Dependabot 활성화. `pyproject.toml`과 `uv.lock`에서 알려진 취약점 스캔. 알림이 GitHub 이슈 자동 생성.                                            |
| 패치 SLA              | Critical/High CVE: 7일 내 패치. Medium: 30일. Low: 분기별 평가.                                                                                      |
| 라이선스 컴플라이언스  | 허용: MIT, Apache 2.0, BSD, PSF, ISC. 금지: GPL, LGPL, AGPL, SSPL, 사유. 의존성 추가 전 `uv tree`로 점검.                                |
| Lockfile 무결성       | `uv.lock`을 Git에 커밋하고 CI에서 강제. CI 파이프라인의 `uv sync --locked`는 lockfile이 최신이 아니면 실패. CI에서 즉석 `uv add` 금지.                              |
| 최소 의존성            | 금지 라이브러리 목록이 비대한 의존성 트리 방지(MVP에 pandas, Django, SQLAlchemy, sympy 없음). 각 새 의존성은 정당성 있는 GitHub 이슈 필요. |

#### A07:2021 - Identification and Authentication Failures

| 통제                          | CalcEngine 구현                                                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API 키 해싱                    | API 키는 32자 암호학적 랜덤 문자열(`secrets.token_urlsafe`). bcrypt 해시로 저장. 조회는 키 접두(첫 8자, 평문 저장)로 레코드를 찾은 뒤 bcrypt 검증으로 전체 키를 확인.                                                                                |
| 무차별 대입 방지               | API Gateway 스로틀링: IP당 모든 엔드포인트에 걸쳐 초당 100 요청. 실패한 인증 시도(무효 키)는 `api_key_prefix`와 소스 IP와 함께 로깅. 단일 IP에서 5분 내 50회 실패 시 WAF 규칙으로 임시 IP 차단. |
| 개발자 포털 인증              | Cognito가 강제: 최소 12자 비밀번호, 이메일 검증 필수, 5회 로그인 실패 시 계정 잠금.                                                                                                                                            |
| 키 회전                        | 개발자는 옛 키 폐기 전에 새 키 생성 가능(무중단 회전을 위한 중첩 기간). 계정당 활성 키 3개 제한으로 키 누적 방지.                                                                                              |
| 자격증명 노출                  | API 키는 생성 시 정확히 한 번 반환(HTTP 응답 본문). 어디에도 평문 저장 금지. 이메일에 포함 금지. 생성 후 개발자 포털에 미노출.                                                                                |
| 다중 인증                     | MVP에 미요구. Cognito MFA 지원 가능. 팀/엔터프라이즈 계정이 도입되는 Phase 2에 옵션으로 활성화 예정.                                                                                                                              |

#### A08:2021 - Software and Data Integrity Failures

| 통제                          | CalcEngine 구현                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CI/CD 파이프라인 보안          | GitHub Actions. `main` 브랜치 보호: PR 필요, 1명 이상 리뷰, 모든 CI 검사 통과. `main` 직접 푸시 금지. 배포 워크플로는 `main` 머지 시에만 트리거.                                                                                         |
| 의존성 무결성                  | `uv.lock`은 모든 의존성의 해시 포함. `uv sync --locked`가 설치 시 해시 검증. PR의 lockfile 변경은 명시적으로 검토.                                                                                                          |
| 배포 산출물 무결성             | Lambda 배포 패키지는 CI에서 깨끗한 `uv sync --locked` 설치로 빌드. 로컬 빌드를 운영에 배포 금지. CDK 배포는 개발자 머신이 아닌 CI 파이프라인에서만 실행.                                                                       |
| 역직렬화 안전성               | Pydantic v2 모델이 모든 들어오는 JSON 파싱/검증. `pickle`, `yaml.load()`(안전하지 않은 로더), `marshal` 사용 금지. Pydantic의 JSON 파싱을 통한 `json.loads()`만. Pydantic `model_config`는 예기치 않은 필드 거절(`extra = "forbid"`). |

#### A09:2021 - Security Logging and Monitoring Failures

| 통제                  | CalcEngine 구현                                                                                                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 보안 이벤트 로깅       | 다음 이벤트는 모두 CloudWatch에 구조화 JSON으로 로깅: 인증 실패(무효/만료/폐기 키), 레이트 리밋 초과(429), 입력 검증 실패(400), 인가 이상, 모든 5xx 오류.                                                      |
| 로그 보호              | CloudWatch 로그 30일 보존. 로그 그룹 리소스 정책이 Lambda 실행 역할에 의한 삭제 방지. CloudTrail은 관리 이벤트를 별도 object lock S3 버킷에 로깅.                                                                                        |
| 알림                  | CloudWatch 알람: 5분간 5xx 오류율 > 1%, 분당 인증 실패율 > 100, 단일 API 키가 10배 이상 시도, Lambda 동시 실행이 예약 동시성의 80% 초과. 알람은 SNS로 on-call 이메일/SMS 알림. |
| 모니터링 대시보드     | CloudWatch 대시보드 표시: 요청 수, 오류율(4xx, 5xx), p50/p95/p99 지연, 인증 실패 수, 레이트 리밋 적중 수, Lambda 콜드 스타트 비율, DynamoDB 소비 용량. 주간 검토.                                  |

#### A10:2021 - Server-Side Request Forgery (SSRF)

| 통제                  | CalcEngine 구현                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 적용 가능성            | **MVP에서 낮은 위험.** CalcEngine은 사용자 입력 기반의 외부 HTTP 요청을 하지 않음. 표현식 파서는 수학 표현식을 평가할 뿐, URL 페치, 호스트명 해결, 네트워크 호출을 하지 않음.                                                                                                                                                       |
| 외부 요청              | Lambda의 유일한 외부 네트워크 호출: (1) AWS SDK를 통한 DynamoDB 쿼리(엔드포인트는 AWS 리전으로 결정, 사용자 입력 아님), (2) 콜드 스타트에서 Secrets Manager 읽기(시크릿 이름은 구성에 하드코딩, 사용자 입력 아님).                                                                                                              |
| Phase 3 고려           | 통화 변환 추가(Phase 3) 시, 서비스가 금융 데이터 공급자로부터 환율 조회. 그때: 공급자 URL은 환경 변수(사용자 입력 아님), 요청은 허용된 호스트명 사용, 응답은 사용 전에 기대 스키마로 검증. Phase 3 출시 전 이 섹션 업데이트 필요. |
| 네트워크 분리          | Lambda 함수는 AWS 관리 VPC에서 실행(MVP는 고객 VPC 없음). 공개 엔드포인트로만 AWS 서비스에 접근. 이 구성에서는 Lambda에서 어떤 내부 서비스, 데이터베이스, 메타데이터 엔드포인트도 접근 불가.                                                                            |

---

## 테스트 요구사항

### 테스트 전략 개요

| 테스트 유형                  | 필수             | 커버리지 목표                                   | 도구                                  |
| --------------------------- | ---------------- | ----------------------------------------------- | ------------------------------------- |
| 단위 테스트                 | 예              | 라인 90%, 분기 80%                              | pytest + pytest-cov                   |
| 수학적 정확성 테스트         | 예              | 구현된 모든 함수의 100%                          | pytest + hypothesis                   |
| 통합 테스트                 | 예              | 모든 API 엔드포인트, DynamoDB 상호작용             | pytest + moto (AWS 모킹)             |
| 부하 테스트                 | 예 (출시 전)     | 동시 요청 1,000, p50 < 50ms                       | Locust                                |
| 보안 테스트                 | 예              | 입력 검증, 인젝션 방지                              | pytest (커스텀) + 수동 OWASP 검토 |
| E2E 테스트                  | 조건부          | 배포된 스테이징 대상의 핵심 사용자 여정              | pytest + 라이브 API에 대한 httpx   |

### 단위 테스트 표준

- **커버리지 최소**: 라인 커버리지 90%, 분기 커버리지 80%. `pyproject.toml`의 `fail_under = 90`으로 `pytest-cov`가 강제.
- **모킹 정책**: AWS 서비스(DynamoDB, Secrets Manager)는 moto로 모킹. 시간은 freezegun으로 모킹. 내부 수학 함수는 모킹 금지 — 실제 계산으로 테스트.
- **명명 규칙**: 테스트 파일은 소스를 반영. `src/calcengine/trig.py`는 `tests/unit/test_trig.py`에서 테스트. 테스트 함수명은 `test_<function>_<scenario>` (예: `test_sin_zero_returns_zero`, `test_sin_negative_pi_returns_zero`).
- **테스트 위치**: 별도 `tests/` 디렉터리 트리. 소스와 함께 두지 않음.

```text
tests/
  unit/
    test_arithmetic.py
    test_trig.py
    test_statistics.py
    test_expression_parser.py
    test_error_handling.py
  integration/
    test_api_evaluate.py
    test_api_trig.py
    test_api_keys.py
    test_rate_limiting.py
  accuracy/
    test_trig_accuracy.py
    test_arithmetic_accuracy.py
    test_statistics_accuracy.py
  conftest.py
```

### 수학적 정확성 테스트

CalcEngine 고유 테스트 카테고리로, 대부분의 프로젝트에는 없습니다.

- **참조 구현**: 모든 수학 함수는 Python `math` 모듈, `mpmath` 라이브러리(고정밀), 또는 공개된 수학 표 대비 테스트.
- **hypothesis로 속성 기반 테스트**: hypothesis로 유효한 랜덤 입력을 생성하고 속성이 유지되는지 검증(예: `sin(x)^2 + cos(x)^2 == 1`, `log(a*b) == log(a) + log(b)`).
- **엣지 케이스**: 모든 함수에 다음에 대한 명시 테스트 필요: 0, 음의 0, 매우 작은 수(epsilon 근처), 매우 큰 수, 도메인 경계(예: asin(1), asin(1.0000001)), 특수값(pi, e, 삼각함수의 pi/2 배수).
- **허용 오차**: 기본 함수는 결과가 1 ULP 이내로 참조값과 일치. 더 넓은 허용 오차를 수용하는 함수는 사유와 함께 문서화.

**정확성 테스트 패턴 예:**

```python
import math
import pytest
from hypothesis import given, strategies as st
from calcengine.trig import sin, cos

class TestSinAccuracy:
    """math.sin과 알려진 정확값에 대한 sin() 정확성 검증."""

    @pytest.mark.accuracy
    @pytest.mark.parametrize("input_val, expected", [
        (0, 0.0),
        (math.pi / 6, 0.5),
        (math.pi / 4, math.sqrt(2) / 2),
        (math.pi / 2, 1.0),
        (math.pi, 0.0),
        (3 * math.pi / 2, -1.0),
        (2 * math.pi, 0.0),
        (-math.pi / 2, -1.0),
    ])
    def test_sin_known_values(self, input_val: float, expected: float) -> None:
        result = sin(input_val)
        assert result == pytest.approx(expected, abs=1e-15)

    @pytest.mark.accuracy
    @given(st.floats(min_value=-1e6, max_value=1e6, allow_nan=False, allow_infinity=False))
    def test_sin_matches_stdlib(self, x: float) -> None:
        assert sin(x) == pytest.approx(math.sin(x), rel=1e-15)

    @pytest.mark.accuracy
    @given(st.floats(min_value=-1e6, max_value=1e6, allow_nan=False, allow_infinity=False))
    def test_pythagorean_identity(self, x: float) -> None:
        assert sin(x) ** 2 + cos(x) ** 2 == pytest.approx(1.0, abs=1e-14)
```

### 통합 테스트 표준

- **범위**: FastAPI 테스트 클라이언트로 전체 API 요청/응답 사이클 테스트. moto로 DynamoDB 상호작용 테스트.
- **환경**: 로컬. 배포된 서비스 불필요. `moto`가 모든 AWS 서비스 모킹.
- **데이터 관리**: 각 테스트가 자체 DynamoDB 테이블을 moto fixture로 만들고 종료 시 정리. 공유 테스트 상태 없음.

### CI/CD 테스트 게이트

| 파이프라인 단계         | 필수 테스트                                                          | 도구                              | 실패 시 조치                                  |
| ------------------------ | ------------------------------------------------------------- | ------------------------------- | --------------------------------------------- |
| 사전 커밋               | ruff check, ruff format --check, mypy                         | ruff, mypy via pre-commit hooks | 커밋 차단                                     |
| 풀 리퀘스트             | 단위, 정확성, 통합 테스트, 커버리지 검사                                 | pytest, GitHub Actions          | 머지 차단                                     |
| 배포 전(스테이징)        | 모든 PR 테스트 + 부하 테스트(동시 100, 60초)                              | pytest + Locust, GitHub Actions | 배포 차단                                     |
| 배포 후(운영)            | 스모크 테스트(라이브 API에 대표 계산 10개)                                 | pytest + httpx                  | on-call 알림. 50% 초과 실패 시 자동 롤백.    |

### 로컬에서 테스트 실행

```bash
# 모든 테스트 실행
uv run pytest

# 단위 테스트만 실행
uv run pytest tests/unit/ -m unit

# 정확성 테스트만 실행
uv run pytest tests/accuracy/ -m accuracy

# 커버리지 리포트와 함께 실행
uv run pytest --cov --cov-report=term-missing

# 타입 체크 실행
uv run mypy src/

# 린터 실행
uv run ruff check src/ tests/

# 포매터 체크 (변경 없음)
uv run ruff format --check src/ tests/

# 포매터 적용
uv run ruff format src/ tests/
```

---

## 프로젝트 구조

```text
calcengine/
  .github/
    workflows/
      ci.yml                         # GitHub Actions: PR 시 린트, 타입 체크, 테스트
      deploy.yml                     # GitHub Actions: main 머지 시 CDK 배포
  src/
    calcengine/
      __init__.py
      main.py                        # FastAPI 앱 생성, Mangum 핸들러
      config.py                      # Pydantic BaseSettings를 통한 설정
      api/
        __init__.py
        router.py                    # 상위 API 라우터
        endpoints/
          __init__.py
          evaluate.py                # POST /v1/evaluate (표현식 평가)
          arithmetic.py              # POST /v1/arithmetic/{operation}
          trigonometry.py            # POST /v1/trigonometry/{function}
          statistics.py              # POST /v1/statistics/{function}
          constants.py               # GET  /v1/constants/{name}
        middleware/
          __init__.py
          auth.py                    # API 키 검증 미들웨어
          rate_limit.py              # 레이트 리밋 미들웨어
          request_logging.py         # 구조화 요청/응답 로깅
        models/
          __init__.py
          requests.py                # Pydantic 요청 모델
          responses.py               # Pydantic 응답 모델
          errors.py                  # 오류 응답 모델과 오류 코드
      engine/
        __init__.py
        expression_parser.py         # 토크나이저, AST 빌더, 평가기
        arithmetic.py                # 기본 수학 연산
        trigonometry.py              # 도메인 검증이 있는 삼각 함수
        statistics.py                # 기술 통계 함수
        constants.py                 # 수학 상수
        combinatorics.py             # 팩토리얼, 순열, 조합
        logarithmic.py               # log, ln, exp 함수
        validation.py                # 입력 검증, 도메인 체크
        errors.py                    # 수학 도메인 예외 타입
      storage/
        __init__.py
        dynamodb.py                  # DynamoDB 클라이언트, 테이블 연산
        api_keys.py                  # API 키 CRUD, 검증, 해싱
        usage.py                     # 사용량 미터링, 레이트 리밋 카운터
      logging.py                     # structlog 구성
  infrastructure/
    app.py                           # CDK 앱 엔트리포인트
    stacks/
      __init__.py
      api_stack.py                   # Lambda, API Gateway, 커스텀 도메인
      data_stack.py                  # DynamoDB 테이블
      monitoring_stack.py            # CloudWatch 대시보드, 알람
      auth_stack.py                  # Cognito user pool
      docs_stack.py                  # 문서 사이트용 S3 + CloudFront
  tests/
    unit/
      test_arithmetic.py
      test_trig.py
      test_statistics.py
      test_expression_parser.py
      test_combinatorics.py
      test_logarithmic.py
      test_validation.py
      test_api_keys.py
    integration/
      test_api_evaluate.py
      test_api_arithmetic.py
      test_api_trig.py
      test_api_statistics.py
      test_api_auth.py
      test_api_rate_limiting.py
    accuracy/
      test_trig_accuracy.py
      test_arithmetic_accuracy.py
      test_statistics_accuracy.py
      test_logarithmic_accuracy.py
      test_expression_parser_accuracy.py
    conftest.py                      # 공유 fixture (FastAPI 테스트 클라이언트, moto 모킹)
  examples/
    api-endpoint/
      README.md
      example_endpoint.py
      test_example_endpoint.py
    math-function/
      README.md
      example_function.py
      test_example_function.py
    cdk-construct/
      README.md
      example_stack.py
  docs/
    static/                          # 문서 포털 소스 (Jinja2 템플릿)
  pyproject.toml
  uv.lock
  .python-version                    # 내용: 3.12
  .gitignore
  .pre-commit-config.yaml
  README.md
```

### 디렉터리 규칙

| 디렉터리                    | 포함                                  | 규칙                                                                                                          |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/calcengine/`         | 모든 애플리케이션 소스 코드            | Python만. 구성 파일, 테스트, 문서 금지.                                                                          |
| `src/calcengine/engine/`  | 순수 수학 함수                          | AWS 임포트 금지. HTTP 임포트 금지. 부작용 금지. 순수 함수만. 모킹 없이 테스트 가능해야 함.                          |
| `src/calcengine/api/`     | FastAPI 라우트, 미들웨어, 모델          | HTTP 계층만. 엔진 함수 호출. 수학 로직 포함 금지.                                                                |
| `src/calcengine/storage/` | DynamoDB 접근 계층                     | 모든 AWS 데이터 접근을 여기에 격리. 비즈니스 로직 금지.                                                          |
| `infrastructure/`         | CDK 스택                              | Python CDK만. 애플리케이션 코드 금지.                                                                          |
| `tests/`                  | 모든 테스트                            | `src/` 구조 반영. `unit/`, `integration/`, `accuracy/` 별도 디렉터리.                                        |
| `examples/`               | 패턴을 위한 템플릿 코드                  | 동작 코드 + 테스트 + README. 표준 변경 시 업데이트.                                                          |

---

## 예시 및 템플릿 코드

### Example 1: API Endpoint Pattern

`examples/api-endpoint/README.md`:

```markdown
# API Endpoint Pattern

## What This Demonstrates
CalcEngine에 새 계산 엔드포인트를 추가하는 표준 패턴.
보여주는 것: 라우트 정의, Pydantic 모델, 엔진 호출, 오류 처리, 로깅.

## When to Use
- 새 계산 엔드포인트 추가
- API에 새 HTTP 라우트 추가

## When Not to Use
- 내부 엔진 함수 (math-function 예시 참고)
- 인프라 변경 (cdk-construct 예시 참고)

## Customization Guide
| 요소 | 커스터마이즈? | 비고 |
|---------|-----------|-------|
| 라우트 경로/메서드 | 예 | /v1/{category}/{function} 컨벤션 |
| 요청/응답 모델 | 예 | 엔드포인트별 Pydantic 모델 정의 |
| 엔진 함수 호출 | 예 | 적절한 엔진 모듈 함수 호출 |
| 오류 처리 구조 | 아니오 | 항상 CalcEngineError 계층과 error_response() 사용 |
| 로깅 호출 | 아니오 | 항상 request_id, api_key_id, duration_ms 로깅 |
| 응답 봉투 | 아니오 | 항상 {"result": ..., "expression": ..., "computation_time_ms": ..., "engine_version": ...} 반환 |
```

`examples/api-endpoint/example_endpoint.py`:

```python
"""Example: CalcEngine 표준 API 엔드포인트 패턴."""

import time

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from calcengine.api.middleware.auth import get_api_key_id
from calcengine.api.models.errors import error_response
from calcengine.api.models.responses import CalculationResponse
from calcengine.engine.errors import CalcEngineError
from calcengine.engine.trigonometry import sin

logger = structlog.get_logger()

router = APIRouter()


class SinRequest(BaseModel):
    """사인 계산 요청 모델."""

    value: float = Field(..., description="입력 각도")
    angle_mode: str = Field(
        default="radians",
        pattern="^(radians|degrees)$",
        description="각도 단위: 'radians' 또는 'degrees'",
    )


@router.post("/v1/trigonometry/sin", response_model=CalculationResponse)
async def calculate_sin(
    request: SinRequest,
    api_key_id: str = Depends(get_api_key_id),
) -> CalculationResponse | dict:
    """주어진 값의 사인을 계산."""
    start = time.perf_counter()

    try:
        result = sin(request.value, angle_mode=request.angle_mode)
        elapsed = (time.perf_counter() - start) * 1000

        logger.info(
            "calculation_completed",
            endpoint="/v1/trigonometry/sin",
            input_value=request.value,
            angle_mode=request.angle_mode,
            result=result,
            computation_time_ms=round(elapsed, 3),
            api_key_id=api_key_id,
        )

        return CalculationResponse(
            result=result,
            expression=f"sin({request.value})",
            computation_time_ms=round(elapsed, 3),
        )

    except CalcEngineError as e:
        elapsed = (time.perf_counter() - start) * 1000
        logger.warning(
            "calculation_failed",
            endpoint="/v1/trigonometry/sin",
            input_value=request.value,
            error_code=e.code,
            error_detail=str(e),
            computation_time_ms=round(elapsed, 3),
            api_key_id=api_key_id,
        )
        return error_response(e)
```

`examples/api-endpoint/test_example_endpoint.py`:

```python
"""Example: CalcEngine API 엔드포인트의 표준 테스트 패턴."""

import math

import pytest
from fastapi.testclient import TestClient

from calcengine.main import app


@pytest.fixture
def client() -> TestClient:
    """모킹된 API 키가 포함된 테스트 클라이언트 생성."""
    return TestClient(app)


class TestSinEndpoint:
    """POST /v1/trigonometry/sin 테스트."""

    @pytest.mark.unit
    def test_sin_zero_radians(self, client: TestClient) -> None:
        response = client.post(
            "/v1/trigonometry/sin",
            json={"value": 0, "angle_mode": "radians"},
            headers={"Authorization": "Bearer test-api-key"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["result"] == pytest.approx(0.0)
        assert "computation_time_ms" in data

    @pytest.mark.unit
    def test_sin_pi_over_2_radians(self, client: TestClient) -> None:
        response = client.post(
            "/v1/trigonometry/sin",
            json={"value": math.pi / 2, "angle_mode": "radians"},
            headers={"Authorization": "Bearer test-api-key"},
        )
        assert response.status_code == 200
        assert response.json()["result"] == pytest.approx(1.0)

    @pytest.mark.unit
    def test_sin_90_degrees(self, client: TestClient) -> None:
        response = client.post(
            "/v1/trigonometry/sin",
            json={"value": 90, "angle_mode": "degrees"},
            headers={"Authorization": "Bearer test-api-key"},
        )
        assert response.status_code == 200
        assert response.json()["result"] == pytest.approx(1.0)

    @pytest.mark.unit
    def test_sin_invalid_angle_mode(self, client: TestClient) -> None:
        response = client.post(
            "/v1/trigonometry/sin",
            json={"value": 1.0, "angle_mode": "gradians"},
            headers={"Authorization": "Bearer test-api-key"},
        )
        assert response.status_code == 422  # Pydantic 검증 오류

    @pytest.mark.unit
    def test_sin_missing_auth(self, client: TestClient) -> None:
        response = client.post(
            "/v1/trigonometry/sin",
            json={"value": 0},
        )
        assert response.status_code == 401
```

### Example 2: Pure Math Function Pattern

`examples/math-function/README.md`:

```markdown
# Math Function Pattern

## What This Demonstrates
엔진 계층의 순수 수학 함수 구현 표준 패턴.
보여주는 것: 함수 시그니처, 타입 힌트, 도메인 검증, 오류 발생, docstring 형식.

## When to Use
- src/calcengine/engine/ 에 새 수학 함수 추가

## When Not to Use
- API 엔드포인트 (api-endpoint 예시 참고)
- AWS 또는 HTTP 접근이 필요한 함수 (api/ 또는 storage/ 에 위치)

## Key Rules
- api/, storage/, 외부 서비스 임포트 금지
- 순수 함수만: 동일 입력은 항상 동일 출력
- 도메인 오류는 CalcEngineError 하위 클래스로 발생, None 또는 NaN 반환 금지
- 모든 파라미터/반환에 타입 힌트
```

`examples/math-function/example_function.py`:

```python
"""Example: CalcEngine 엔진 계층 순수 수학 함수 표준 패턴."""

import math

from calcengine.engine.errors import DomainError


def log_base(value: float, base: float = 10.0) -> float:
    """주어진 밑으로 값의 로그를 계산한다.

    Args:
        value: 로그를 계산할 값. 양수여야 함.
        base: 로그의 밑. 양수이며 1이 아니어야 함.
              기본 10 (상용로그).

    Returns:
        주어진 밑에서의 value의 로그.

    Raises:
        DomainError: value <= 0, base <= 0, 또는 base == 1 일 때.
    """
    if value <= 0:
        raise DomainError(
            code="DOMAIN_ERROR",
            message=f"Cannot compute logarithm of {value}",
            detail="Logarithm is only defined for positive numbers",
            parameter="value",
        )

    if base <= 0:
        raise DomainError(
            code="DOMAIN_ERROR",
            message=f"Cannot use {base} as logarithm base",
            detail="Logarithm base must be positive",
            parameter="base",
        )

    if base == 1.0:
        raise DomainError(
            code="DOMAIN_ERROR",
            message="Cannot use 1 as logarithm base",
            detail="Logarithm base 1 is undefined (division by zero in change-of-base)",
            parameter="base",
        )

    return math.log(value) / math.log(base)
```

`examples/math-function/test_example_function.py`:

```python
"""Example: 순수 수학 함수의 표준 테스트 패턴."""

import math

import pytest
from hypothesis import given, strategies as st

from calcengine.engine.errors import DomainError
from calcengine.engine.logarithmic import log_base


class TestLogBase:
    """log_base 함수에 대한 테스트."""

    # --- 알려진 값 ---

    @pytest.mark.unit
    def test_log10_of_100(self) -> None:
        assert log_base(100, 10) == pytest.approx(2.0)

    @pytest.mark.unit
    def test_log2_of_8(self) -> None:
        assert log_base(8, 2) == pytest.approx(3.0)

    @pytest.mark.unit
    def test_ln_of_e(self) -> None:
        assert log_base(math.e, math.e) == pytest.approx(1.0)

    @pytest.mark.unit
    def test_log_of_1_any_base(self) -> None:
        assert log_base(1, 10) == pytest.approx(0.0)
        assert log_base(1, 2) == pytest.approx(0.0)
        assert log_base(1, math.e) == pytest.approx(0.0)

    # --- 기본 밑 ---

    @pytest.mark.unit
    def test_default_base_is_10(self) -> None:
        assert log_base(1000) == pytest.approx(3.0)

    # --- 도메인 오류 ---

    @pytest.mark.unit
    def test_log_of_zero_raises_domain_error(self) -> None:
        with pytest.raises(DomainError, match="Cannot compute logarithm"):
            log_base(0)

    @pytest.mark.unit
    def test_log_of_negative_raises_domain_error(self) -> None:
        with pytest.raises(DomainError, match="Cannot compute logarithm"):
            log_base(-5)

    @pytest.mark.unit
    def test_log_base_zero_raises_domain_error(self) -> None:
        with pytest.raises(DomainError, match="Cannot use 0"):
            log_base(10, 0)

    @pytest.mark.unit
    def test_log_base_one_raises_domain_error(self) -> None:
        with pytest.raises(DomainError, match="Cannot use 1"):
            log_base(10, 1)

    @pytest.mark.unit
    def test_log_base_negative_raises_domain_error(self) -> None:
        with pytest.raises(DomainError, match="Cannot use -2"):
            log_base(10, -2)

    # --- 속성 기반: 표준 라이브러리와의 정확성 ---

    @pytest.mark.accuracy
    @given(
        st.floats(min_value=1e-300, max_value=1e300, allow_nan=False, allow_infinity=False),
    )
    def test_log10_matches_stdlib(self, x: float) -> None:
        assert log_base(x, 10) == pytest.approx(math.log10(x), rel=1e-14)

    @pytest.mark.accuracy
    @given(
        st.floats(min_value=1e-300, max_value=1e300, allow_nan=False, allow_infinity=False),
    )
    def test_log2_matches_stdlib(self, x: float) -> None:
        assert log_base(x, 2) == pytest.approx(math.log2(x), rel=1e-14)

    # --- 속성 기반: 수학적 항등식 ---

    @pytest.mark.accuracy
    @given(
        a=st.floats(min_value=1e-100, max_value=1e100, allow_nan=False, allow_infinity=False),
        b=st.floats(min_value=1e-100, max_value=1e100, allow_nan=False, allow_infinity=False),
    )
    def test_log_product_identity(self, a: float, b: float) -> None:
        """log(a * b)는 log(a) + log(b)와 같아야 한다."""
        if a * b > 0:
            assert log_base(a * b, 10) == pytest.approx(
                log_base(a, 10) + log_base(b, 10), rel=1e-10
            )
```

### Example 3: CDK Construct Pattern

`examples/cdk-construct/README.md`:

```markdown
# CDK Construct Pattern

## What This Demonstrates
CalcEngine 인프라용 CDK 스택 정의의 표준 패턴.
보여주는 것: Lambda 함수, API Gateway 통합, DynamoDB 테이블, IAM 권한.

## When to Use
- 프로젝트에 새 인프라 리소스 추가

## Key Rules
- 모든 인프라는 infrastructure/stacks/ 디렉터리에
- 논리적 그룹당 하나의 스택 (api, data, monitoring, auth, docs)
- CDK 컨텍스트의 환경 변수 사용, 하드코딩 금지
- 최소 권한 IAM: 각 Lambda는 필요한 권한만 부여
```

`examples/cdk-construct/example_stack.py`:

```python
"""Example: CalcEngine 표준 CDK 스택 패턴."""

from aws_cdk import Duration, Stack
from aws_cdk import aws_apigatewayv2 as apigwv2
from aws_cdk import aws_dynamodb as dynamodb
from aws_cdk import aws_lambda as lambda_
from aws_cdk import aws_logs as logs
from aws_cdk.aws_apigatewayv2_integrations import HttpLambdaIntegration
from constructs import Construct


class ExampleApiStack(Stack):
    """Lambda + API Gateway + DynamoDB 패턴을 보여주는 예시 스택."""

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        # DynamoDB 테이블 - 단일 테이블 설계
        table = dynamodb.Table(
            self,
            "ExampleTable",
            partition_key=dynamodb.Attribute(
                name="PK", type=dynamodb.AttributeType.STRING
            ),
            sort_key=dynamodb.Attribute(
                name="SK", type=dynamodb.AttributeType.STRING
            ),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            encryption=dynamodb.TableEncryption.AWS_MANAGED,
            point_in_time_recovery=True,
        )

        # Lambda 함수
        handler = lambda_.Function(
            self,
            "ExampleHandler",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="calcengine.main.handler",
            code=lambda_.Code.from_asset("src/"),
            memory_size=256,
            timeout=Duration.seconds(30),
            environment={
                "TABLE_NAME": table.table_name,
                "LOG_LEVEL": "INFO",
            },
            log_retention=logs.RetentionDays.ONE_MONTH,
        )

        # Lambda에 DynamoDB 읽기/쓰기 권한 부여 (최소 권한)
        table.grant_read_write_data(handler)

        # Lambda 통합이 있는 HTTP API Gateway
        api = apigwv2.HttpApi(
            self,
            "ExampleHttpApi",
            api_name="calcengine-api",
            default_integration=HttpLambdaIntegration(
                "LambdaIntegration",
                handler,
            ),
        )
```

---

## 이 문서가 AI-DLC에 어떻게 연결되는가

| 섹션                          | AI-DLC 단계                          | 활용 방식                                                                |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| Project Technical Summary     | Workspace Detection                | 그린필드 분류, 팀 컨텍스트                                                |
| Programming Languages         | Code Generation                    | Python 3.12 강제, 승인 없이 다른 언어 금지                                |
| uv Standards                  | Code Generation                    | 모든 의존성 작업은 uv 사용, pyproject.toml이 단일 구성 출처                  |
| Frameworks and Libraries      | Code Generation, NFR Design        | FastAPI + Pydantic + Mangum 스택, 금지 라이브러리 강제                     |
| Cloud Services Allow/Disallow | Infrastructure Design              | MVP는 Lambda + API Gateway + DynamoDB만                                  |
| Architecture Pattern          | Application Design                 | 모듈식 모놀리식, engine/ vs api/ vs storage/ 모듈 경계                     |
| API Design Standards          | Functional Design, Code Generation | 엔드포인트 컨벤션, 오류 코드, 응답 형식                                    |
| Security Requirements         | NFR Requirements, NFR Design       | 입력 검증 규칙, eval() 금지, API 키 인증 패턴                              |
| Testing Requirements          | Code Generation, Build and Test    | pytest + hypothesis, 90% 커버리지, 정확성 테스트 필수                      |
| Project Structure             | Code Generation                    | 정확한 디렉터리 레이아웃과 파일 배치 규칙                                  |
| Example Code                  | Code Generation                    | 엔드포인트, 엔진 함수, CDK 스택의 표준 패턴                                |
