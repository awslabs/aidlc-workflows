# 생성된 aidlc-docs/ 디렉터리 레퍼런스

AI-DLC 워크플로를 실행하면, 모든 문서 산출물은 작업 공간(workspace) 루트의 `aidlc-docs/` 디렉터리 안에 생성됩니다. 실제로 생성되는 파일은 프로젝트 유형(그린필드 vs 브라운필드), 복잡도, 워크플로가 실행하거나 건너뛰는 단계에 따라 달라집니다.

아래는 모든 단계에 걸쳐 생성될 수 있는 전체 파일 구조입니다. 조건부로 생성되는 파일은 주석으로 표시했습니다.

```text
aidlc-docs/
├── aidlc-state.md                                          # 워크플로 상태 추적기 — 프로젝트 정보, 단계 진행, 현재 상태
├── audit.md                                                # 전체 감사 로그 — 모든 사용자 입력, AI 응답, 승인 (타임스탬프 포함)
│
├── inception/                                              # 🔵 INCEPTION 단계 — 무엇을(WHAT) 왜(WHY) 만들지 결정
│   ├── plans/
│   │   ├── execution-plan.md                               # 워크플로 시각화 및 단계 실행 결정 (항상 생성)
│   │   ├── story-generation-plan.md                        # 스토리 작성 방법론 및 질문 (User Stories 실행 시)
│   │   ├── user-stories-assessment.md                      # 사용자 스토리가 가치가 있는지 평가 (User Stories 실행 시)
│   │   ├── application-design-plan.md                      # 컴포넌트/서비스 설계 계획과 질문 (Application Design 실행 시)
│   │   └── unit-of-work-plan.md                            # 시스템 분해 계획과 질문 (Units Generation 실행 시)
│   │
│   ├── reverse-engineering/                                # 브라운필드(기존 코드베이스 감지) 프로젝트에서만 생성
│   │   ├── business-overview.md                            # 비즈니스 컨텍스트, 트랜잭션, 용어집
│   │   ├── architecture.md                                 # 시스템 아키텍처 다이어그램, 컴포넌트 설명, 데이터 흐름
│   │   ├── code-structure.md                               # 빌드 시스템, 주요 클래스/모듈, 디자인 패턴, 파일 인벤토리
│   │   ├── api-documentation.md                            # REST API, 내부 API, 데이터 모델
│   │   ├── component-inventory.md                          # 유형별(애플리케이션, 인프라, 공유, 테스트) 모든 패키지 목록
│   │   ├── technology-stack.md                             # 언어, 프레임워크, 인프라, 빌드 도구, 테스트 도구
│   │   ├── dependencies.md                                 # 내부/외부 의존성 그래프 및 관계
│   │   ├── code-quality-assessment.md                      # 테스트 커버리지, 코드 품질 지표, 기술 부채, 패턴
│   │   └── reverse-engineering-timestamp.md                # 분석 메타데이터 및 산출물 체크리스트
│   │
│   ├── requirements/
│   │   ├── requirements.md                                 # 기능/비기능 요구사항과 의도 분석 (항상 생성)
│   │   └── requirement-verification-questions.md           # [Answer]: 태그가 포함된 명확화 질문 (항상 생성)
│   │
│   ├── user-stories/                                       # User Stories 단계 실행 시에만 생성
│   │   ├── stories.md                                      # INVEST 기준의 사용자 스토리와 수락 기준
│   │   └── personas.md                                     # 사용자 원형, 특성, 페르소나-스토리 매핑
│   │
│   └── application-design/                                 # Application Design 또는 Units Generation 실행 시에만 생성
│       ├── application-design.md                           # 통합 설계 문서 (Application Design 실행 시)
│       ├── components.md                                   # 컴포넌트 정의, 책임, 인터페이스
│       ├── component-methods.md                            # 메서드 시그니처, 목적, 입출력 타입
│       ├── services.md                                     # 서비스 정의, 책임, 오케스트레이션 패턴
│       ├── component-dependency.md                         # 컴포넌트 간 의존성 매트릭스와 통신 패턴
│       ├── unit-of-work.md                                 # Unit 정의 및 책임 (Units Generation 실행 시)
│       ├── unit-of-work-dependency.md                      # Unit 간 의존성 매트릭스 (Units Generation 실행 시)
│       └── unit-of-work-story-map.md                       # 사용자 스토리를 Unit에 매핑 (Units Generation 실행 시)
│
├── construction/                                           # 🟢 CONSTRUCTION 단계 — 어떻게(HOW) 만들지 결정
│   ├── plans/
│   │   ├── {unit-name}-functional-design-plan.md           # 비즈니스 로직 설계 계획과 질문 (단위별, Functional Design 실행 시)
│   │   ├── {unit-name}-nfr-requirements-plan.md            # NFR 평가 계획과 질문 (단위별, NFR Requirements 실행 시)
│   │   ├── {unit-name}-nfr-design-plan.md                  # NFR 디자인 패턴 계획과 질문 (단위별, NFR Design 실행 시)
│   │   ├── {unit-name}-infrastructure-design-plan.md       # 인프라 매핑 계획과 질문 (단위별, Infrastructure Design 실행 시)
│   │   └── {unit-name}-code-generation-plan.md             # 체크박스 포함 상세 코드 생성 단계 (단위별, 항상 생성)
│   │
│   ├── {unit-name}/                                        # 단위별 산출물 — Unit 마다 하나의 디렉터리
│   │   ├── functional-design/                              # 해당 단위의 Functional Design 실행 시에만 생성
│   │   │   ├── business-logic-model.md                     # 상세 비즈니스 로직 및 알고리즘
│   │   │   ├── business-rules.md                           # 비즈니스 규칙, 검증 로직, 제약사항
│   │   │   ├── domain-entities.md                          # 엔티티 및 관계를 포함한 도메인 모델
│   │   │   └── frontend-components.md                      # UI 컴포넌트 계층, 속성, 상태, 상호작용 (단위에 프런트엔드 존재 시)
│   │   │
│   │   ├── nfr-requirements/                               # 해당 단위의 NFR Requirements 실행 시에만 생성
│   │   │   ├── nfr-requirements.md                         # 확장성, 성능, 가용성, 보안 요구사항
│   │   │   └── tech-stack-decisions.md                     # 기술 선택과 근거
│   │   │
│   │   ├── nfr-design/                                     # 해당 단위의 NFR Design 실행 시에만 생성
│   │   │   ├── nfr-design-patterns.md                      # 복원력, 확장성, 성능, 보안 패턴
│   │   │   └── logical-components.md                       # 논리적 인프라 컴포넌트 (큐, 캐시 등)
│   │   │
│   │   ├── infrastructure-design/                          # 해당 단위의 Infrastructure Design 실행 시에만 생성
│   │   │   ├── infrastructure-design.md                    # 클라우드 서비스 매핑과 인프라 컴포넌트
│   │   │   └── deployment-architecture.md                  # 배포 모델, 네트워킹, 스케일링 구성
│   │   │
│   │   └── code/                                           # 생성된 코드의 마크다운 요약 (단위별 항상 생성)
│   │       └── *.md                                        # 코드 생성 요약 (실제 코드는 작업 공간 루트에 생성)
│   │
│   ├── shared-infrastructure.md                            # 단위 간 공유 인프라 (해당 시)
│   │
│   └── build-and-test/                                     # 모든 Unit의 코드 생성 완료 후 항상 생성
│       ├── build-instructions.md                           # 사전 요구사항, 빌드 단계, 트러블슈팅
│       ├── unit-test-instructions.md                       # 단위 테스트 실행 명령 및 기대 결과
│       ├── integration-test-instructions.md                # 통합 테스트 시나리오, 셋업, 실행
│       ├── performance-test-instructions.md                # 로드/스트레스 테스트 구성 및 실행 (성능 NFR 존재 시)
│       ├── contract-test-instructions.md                   # 서비스 간 API 컨트랙트 검증 (마이크로서비스 시)
│       ├── security-test-instructions.md                   # 취약점 스캔 및 보안 테스트 (보안 NFR 존재 시)
│       ├── e2e-test-instructions.md                        # 종단간 사용자 워크플로 테스트 (해당 시)
│       └── build-and-test-summary.md                       # 전체 빌드 상태, 테스트 결과, 준비도 평가
│
└── operations/                                             # 🟡 OPERATIONS 단계 — 향후 확장을 위한 자리표시자
```

## 참고 사항

- `{unit-name}`은 실제 단위명으로 대체됩니다 (예: `api-service`, `frontend-app`, `data-processor`). 단일 단위 프로젝트에서는 보통 `construction/` 아래에 하나의 단위 디렉터리만 존재합니다.
- 더 단순한 단일 단위 프로젝트의 경우, 모델이 명칭을 단순화할 수 있습니다. 예를 들어 `construction/plans/{unit-name}-code-generation-plan.md` 대신 `construction/plans/code-generation-plan.md`로 두거나, `application-design.md`를 통합 파일 하나로만 두고 개별 컴포넌트 파일을 두지 않을 수 있습니다.
- `build-and-test/` 디렉터리에는 항상 `build-and-test-summary.md`가 포함됩니다. 개별 지시서(`build-instructions.md`, `unit-test-instructions.md`, `integration-test-instructions.md` 등)는 프로젝트 복잡도와 테스트 요구에 따라 생성됩니다.
- `inception/plans/`와 `construction/plans/`의 계획서에는 사용자가 입력을 제공하는 `[Answer]:` 태그와, 실행 진행을 추적하는 `[ ]`/`[x]` 체크박스가 포함됩니다.
- 애플리케이션 코드는 절대 `aidlc-docs/` 안에 배치되지 않으며, 작업 공간 루트로 생성됩니다. 여기에는 마크다운 문서만 존재합니다.
- `audit.md`는 append-only(추가 전용)이며, ISO 8601 타임스탬프와 함께 모든 상호작용을 기록합니다.
- `aidlc-state.md`는 어느 단계가 완료/건너뜀/진행 중인지와 확장 구성을 추적합니다.
