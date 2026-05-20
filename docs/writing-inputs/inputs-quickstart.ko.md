# AI-DLC 빠른 시작 가이드

AI-DLC(AI 주도 개발 생명주기)는 AI 어시스턴트가 소프트웨어를 계획·설계·구축하도록 안내하는 체계적인 워크플로입니다. 프로젝트를 시작하기 전에 AI에게 **무엇을 만들지(WHAT)** 와 **어떤 도구를 쓸지(TOOLS)** 를 알려주는 두 개의 문서를 제공합니다.

---

## 제공해야 할 것

### 1. 비전(Vision) 문서 — 무엇을(WHAT) 왜(WHY) 만들지

| 섹션                          | 작성 내용                                                                                | 분량                                              |
| --------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Executive Summary**       | 한 단락: 무엇인지, 누구를 위한 것인지, 왜 중요한지                                                       | 3~5문장                                           |
| **Problem Statement**       | 이 프로젝트가 해결하는 구체적인 비즈니스 문제                                                            | 1~2단락                                           |
| **Target Users**            | 누가 사용할 것인지, 사용자 유형별 필요한 것                                                            | 사용자 유형당 한 행씩의 표                                |
| **Success Metrics**         | 프로젝트 성공 여부를 측정하는 방법                                                                  | 측정 가능한 목표 표                                     |
| **Full Scope Vision**       | 제품이 성숙기에 도달할 때 가능한 모든 모습 — 기능 영역별로 구성                                               | 필요한 만큼의 기능 영역                                  |
| **MVP Scope — Features IN** | 첫 릴리스에 포함되는 모든 기능과 근거                                                                | 표. 목록에 없으면 MVP에 포함되지 않습니다.                   |
| **MVP Scope — Features OUT** | MVP에서 의도적으로 제외한 기능 — 이유와 도입 시기 표기                                                    | 표. 범위 확장(Scope Creep) 방지에 사용됩니다.              |
| **Risks and Open Questions** | 잘못될 수 있는 것, 아직 결정되지 않은 것                                                              | 표와 글머리표 목록                                     |

**핵심 원칙**: 전체 비전과 MVP를 분리하세요. 전체 비전은 지향점이며, MVP는 가치를 전달하는 가장 작은 단위입니다.

전체 가이드: [vision-document-guide.md](vision-document-guide.md)
실제 예시: [example-vision-scientific-calculator-api.md](example-vision-scientific-calculator-api.md)

---

### 2. 기술 환경(Technical Environment) 문서 — 어떤 도구를 쓸지

| 섹션                          | 작성 내용                                                                                                                              | 분량                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Languages**               | 필수, 허용, 금지 언어와 버전                                                                                                                | 카테고리별 표                            |
| **Frameworks and Libraries** | 필수, 권장, 금지 — 근거와 대안                                                                                                              | 카테고리별 표                            |
| **Cloud Services**          | 클라우드 서비스 허용 목록 및 금지 목록과 제약                                                                                                       | 목록별 표                              |
| **Architecture and Patterns** | API 스타일, 데이터 패턴, 메시징, 프로젝트 구조                                                                                                    | 표를 포함한 짧은 섹션들                       |
| **Security**                | 인증 방식, 암호화, 입력 검증, 시크릿 관리, 선정한 보안 컴플라이언스 프레임워크 및 카테고리별 통제 문서화                                                                  | 여러 하위 섹션                           |
| **Testing**                 | 테스트 유형, 커버리지 목표, 도구, CI/CD 게이트                                                                                                  | 표                                  |
| **Example Code**            | 엔드포인트, 함수, 테스트, 인프라의 표준 패턴을 보여주는 템플릿 코드                                                                                          | `examples/` 디렉터리에 동작하는 코드 파일       |

**핵심 원칙**: 무엇이 허용되고 무엇이 안 되는지 명시하세요. 허용/금지 목록은 AI가 임의로 가정하는 것을 방지합니다.

전체 가이드: [technical-environment-guide.md](technical-environment-guide.md)
실제 예시: [example-tech-env-scientific-calculator-api.md](example-tech-env-scientific-calculator-api.md)

---

## 최소 입력(Minimum Viable Input)

빠르게 시작하고 세부 사항을 나중에 채우고 싶다면, 최소한 다음을 제공하세요.

### 비전 (최소)

```text
1. 무엇을, 누구를 위해 만드는지 한 단락
2. MVP 기능 목록 (범위 IN)
3. MVP에 포함되지 않는 항목 목록
4. 미해결 질문 — 이미 알고 있는 불확실하거나 미결정된 항목
```

미해결 질문은 선택사항이지만 매우 유용합니다. Requirements Analysis 단계에 사전 선언된 모호성으로 전달되어, AI-DLC가 설계 중간에 갑작스럽게 드러내는 대신 일찍부터 다룰 수 있습니다.

실제 예시는 [example-minimal-vision-scientific-calculator-api.md](example-minimal-vision-scientific-calculator-api.md)를 참고하세요.

### 기술 환경 (최소)

```text
1. 언어 및 버전
2. 패키지 매니저
3. 웹 프레임워크 (해당 시)
4. 클라우드 공급자 및 배포 모델 (혹은 "로컬만")
5. 테스트 프레임워크
6. 금지 라이브러리/서비스 — 표 사용: 금지 | 이유 | 대신 사용할 것
7. 보안 기본 사항 (인증 방식, 입력 검증 접근, 시크릿 관리)
8. 예시 코드 패턴 — 일반적인 엔드포인트, 함수, 테스트 각 하나씩 짧은 예시
```

**6번 항목에 대해**: 이유와 권장 대안을 포함하는 것이 중요합니다. 이게 빠지면 AI-DLC는 금지 사항을 지키되 의도를 충분히 이해하지 못해 좋은 대체 결정을 내리기 어렵습니다.

**8번 항목에 대해**: 한두 개의 짧은 예시만 있어도 AI-DLC가 코드 생성 시 임의로 만드는 대신 구체적인 패턴을 따를 수 있습니다. 기본 사항을 넘어선 추가 항목 중 가장 효과가 큰 것입니다.

두 문서의 실제 예시는 [example-minimal-tech-env-scientific-calculator-api.md](example-minimal-tech-env-scientific-calculator-api.md)를 참고하세요.

나머지는 Inception 단계에서 AI-DLC의 명확화 질문을 통해 답할 수 있습니다. 미리 제공하는 정보가 많을수록 AI가 질문할 양이 줄어듭니다.

---

## 브라운필드(Brownfield) 프로젝트

기존 코드베이스에 기능을 추가하거나 수정하는 경우, 입력 문서는 다른 종류의 질문에 답해야 합니다. 전체 가이드에서 브라운필드를 상세히 다루지만, 최소한은 다음과 같습니다.

### 비전 (브라운필드 최소)

```text
1. 현재 상태 — 시스템이 오늘날 무엇을 하는지 한 단락
2. 우리가 추가하거나 변경하려는 것 — 변경 사항의 명확한 설명
3. 이번 이터레이션의 범위 IN 기능
4. 이번 이터레이션의 범위 OUT 기능
5. 변경되어서는 안 되는 것 — 새 작업이 건드리면 안 되는 기존 컴포넌트, API, 데이터
6. 미해결 질문
```

"변경되면 안 되는 것" 섹션은 매우 중요합니다. AI-DLC는 기존 코드베이스 분석을 위해 Reverse Engineering 단계를 수행하지만, 경계를 명시함으로써 정상 동작 중인 시스템 부분을 불안정하게 만들 만한 변경을 제안하지 않게 됩니다.

실제 예시는 [example-minimal-vision-brownfield.md](example-minimal-vision-brownfield.md)를 참고하세요.

### 기술 환경 (브라운필드 최소)

```text
1. 기존 스택 — 언어, 프레임워크, 데이터베이스, 인프라와 버전
2. 추가할 것 (새 서비스, 테이블, 컴포넌트)
3. 그대로 유지해야 할 것 — 건드리면 안 되는 서비스, 스키마, 컨트랙트, 설정
4. 금지 패턴 — 기존 코드베이스와 충돌하는 라이브러리나 접근
5. 보안 기본 — 기존 시스템에서 인증과 시크릿이 어떻게 동작하는지
6. 기존 코드베이스의 예시 코드 패턴
```

브라운필드에서는 예시 코드 패턴이 특히 중요합니다. AI-DLC가 기존 코드베이스에 자연스럽게 어울리는 코드를 생성하고, 기존 컨벤션 옆에 새로운 컨벤션을 도입하지 않도록 해야 합니다. 예시는 실제 기존 파일에서 가져오세요.

실제 예시는 [example-minimal-tech-env-brownfield.md](example-minimal-tech-env-brownfield.md)를 참고하세요.

---

## 입력 문서를 제공한 후 일어나는 일

AI-DLC는 두 가지 주요 단계로 진행됩니다.

**Inception** — 이해하고 계획

1. 작업 공간 감지 (새 프로젝트 또는 기존 코드)
2. 요구사항 분석 (불명확한 부분이 있으면 명확화 질문)
3. 사용자 스토리 생성 (필요한 경우)
4. 실행 계획 수립 (어떤 단계를 실행하고 어떤 단계를 건너뛸지)
5. 컴포넌트 및 작업 단위(Unit of Work) 설계 (복잡도가 요구하는 경우)

**Construction** — 설계하고 빌드 (작업 단위별)

1. 기능 설계 (비즈니스 로직, 도메인 모델)
2. NFR 요구사항 및 설계 (성능, 보안, 확장성)
3. 인프라 설계 (실제 클라우드 서비스로 매핑)
4. 코드 생성 (코드, 테스트, 배포 산출물 작성)
5. 빌드 및 테스트 (빌드 지시서, 테스트 실행, 검증)

모든 단계는 진행 전에 사용자의 승인을 받아야 합니다. 모든 게이트에서 변경 요청, 건너뛴 단계 추가, 방향 전환이 가능합니다.

---

## 파일 개요

```text
docs/writing-inputs/
  inputs-quickstart.md                               <-- 지금 이 파일
  vision-document-guide.md                           <-- 비전 문서 작성 가이드
  technical-environment-guide.md                     <-- 기술 환경 문서 작성 가이드

  -- 그린필드 예시 (신규 프로젝트) --
  example-vision-scientific-calculator-api.md        <-- 전체 예시: CalcEngine 비전
  example-tech-env-scientific-calculator-api.md      <-- 전체 예시: CalcEngine 기술 환경
  example-minimal-vision-scientific-calculator-api.md<-- 최소 예시: CalcEngine 비전
  example-minimal-tech-env-scientific-calculator-api.md<-- 최소 예시: CalcEngine 기술 환경

  -- 브라운필드 예시 (기존 시스템 확장) --
  example-minimal-vision-brownfield.md               <-- 최소 예시: 기존 플랫폼에 returns 모듈 추가
  example-minimal-tech-env-brownfield.md             <-- 최소 예시: 기존 플랫폼에 returns 모듈 추가
```
