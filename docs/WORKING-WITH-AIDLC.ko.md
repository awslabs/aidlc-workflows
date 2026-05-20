# AIDLC와 함께 일하기

이 가이드는 AI-DLC(AI 주도 개발 생명주기)를 최대한 활용하는 데 도움이 됩니다. 첫 프롬프트부터 동작하는 코드까지 각 단계에서 AI와 효과적으로 상호작용하는 방법을 다룹니다.

각 섹션의 기초부터 시작하세요. 고급 팁은 실제 워크숍 경험에서 추출한 것으로, 기본기를 익힌 팀들이 가장 유용하다고 본 패턴을 다룹니다.

---

## 목차

1. [일반 규칙](#1-일반-규칙)
2. [Inception 단계](#2-inception-단계)
3. [Construction 단계](#3-construction-단계)
4. [절대 바이브 코딩 하지 말 것](#4-절대-바이브-코딩-하지-말-것)

---

## 1. 일반 규칙

### 파일을 변경하지 않고 질문하기

초반에 길러야 할 가장 중요한 습관 중 하나: **모든 질문이 문서 업데이트를 트리거해서는 안 됩니다**.

질문을 보호하지 않고 AI에게 무엇을 물으면, AI가 그것을 변경 요청으로 해석해 즉시 설계 문서를 업데이트할 수 있습니다. 이를 방지하려면, 탐색적 질문에는 변경 금지 지시를 앞에 명확히 붙이세요.

**기본 패턴:**

```text
Do not update any documents. Help me understand why [this decision] was made.
```

```text
Do not update any documents. For [component name], is it reasonable to use [library or technology] here?
```

```text
Do not change anything. Assess the impact of [proposed change].
I want to understand the consequences before we decide.
```

이 패턴들은 AI와 함께 생각을 펼쳐 보고, 옵션을 평가하고, 결정에 도전할 때 어떤 것에도 매이지 않게 해줍니다. 답에 만족하면, 필요 시 의도된 업데이트 지시로 후속 진행하세요.

> **Tip**: 모든 탐색적 메시지를 "Do not update any documents." 로 시작하세요. 행동할 준비가 되면 그 제약을 풀면 됩니다.

---

### 질문 → 문서 → 승인 흐름

AIDLC는 채팅 인라인으로 명확화 질문을 하지 않습니다. 마크다운 파일에 질문을 작성하고, 사용자가 거기에 답을 채워 넣을 때까지 기다립니다. 이렇게 하면 모든 결정에 대한 영속적 기록이 남고, 전체 팀이 쉽게 기여할 수 있습니다.

**1단계 — AIDLC가 질문 파일을 생성**

AI는 `aidlc-docs/inception/requirements/requirement-verification-questions.md` 같은 파일을 만들고 멈춥니다. 답이 채워질 때까지 진행하지 않습니다.

**2단계 — 답변 채우기**

파일을 열고 각 `[Answer]:` 태그를 채웁니다. 질문은 다지선다 형식을 사용합니다.

```markdown
## Question: Deployment model
Where will this service be deployed?

A) AWS Lambda (serverless)
B) AWS ECS Fargate (containerized)
C) Existing on-premises infrastructure
X) Other (please describe after [Answer]: tag below)

[Answer]: B
```

답변 시 다음과 같이 하면 좋습니다.

- **글자와 함께 라벨을 추가하세요.** `C — financial summary and debt service coverage`는 그냥 `C`보다 명확합니다.
- **짧은 근거를 포함하세요.** `A — design-first; generate the OpenAPI spec before writing code`는 의도를 확인시키고 AI가 이어갈 컨텍스트를 제공합니다.
- **둘 다인 경우 옵션을 조합하세요.** `B and C — rate limiting at both API Gateway level and application level (not D)`처럼 명확히.
- **거의 맞을 때 단서를 다세요.** `B — migration is a separate project; however, include a one-time migration into the new data structures.`
- **X를 자유롭게 사용하세요.** 어느 옵션도 맞지 않는다면, 잘못된 선택을 강요하기보다 X가 옳습니다.

**3단계 — 답변이 준비됐다고 AI에게 알리기**

채팅으로 돌아가 말합니다: "We have answered your clarification questions. Please re-read the file and proceed."

팁: AI에게 파일을 *다시 읽으라*고 명시하면, 최근 편집을 반영하지 않을 수 있는 메모리 버전이 아닌 디스크의 답변을 로드합니다.

**4단계 — AIDLC가 검증하고 진행**

AI는 답변을 읽고, 남은 모호성을 표시한 뒤 다음 산출물을 생성합니다.

> **고급 팁**: AI의 질문 중 일부가 이미 문서로 답변되어 있다면 그것을 스스로 해결하도록 지시할 수 있습니다: "Analyze the rationale for each question. If a question has already been answered through the provided documentation, answer it yourself. Only ask me if it is still unclear." 게이트 지점의 불필요한 왕복을 줄여줍니다.

**승인 게이트**

각 단계 종료 시, AIDLC는 두 가지 옵션이 있는 완료 메시지를 표시합니다.

- **Request Changes** — 다음으로 넘어가기 전 수정 요청
- **Approve and Continue** — 출력을 수락하고 진행

승인 전에 생성된 산출물을 읽으세요. 필요하면 팀과 논의하세요. 만족할 때만 승인합니다.

---

### 컨텍스트 관리

컨텍스트는 세션에서 AI의 작업 메모리입니다. AIDLC는 일관된 후속 출력을 생성하기 위해 산출물과 지시문의 전체 사슬을 컨텍스트에 두고 의존합니다. 이를 잘 관리하는 것이 길러야 할 가장 효과적인 습관 중 하나입니다.

**핵심 규칙: 자연스러운 의사결정 지점마다 컨텍스트를 비웁니다.**

AIDLC는 게이트(질문 파일 작성, 문서 승인, 계획 검토 등 AI가 멈추고 사용자에게 묻는 순간)를 중심으로 설계되었습니다. 이 정지점은 단순한 승인 체크포인트가 아닙니다. 다음으로 진행하기 전에 새 컨텍스트를 시작하기 적절한 순간입니다.

게이트에서 컨텍스트를 비우는 것은 리스크가 낮습니다. 현재까지의 작업은 이미 파일로 저장되어 있기 때문입니다. 다음 컨텍스트는 깔끔하게 시작하고, 디스크에서 관련 산출물을 로드하며, 앞 단계들의 누적된 잡음을 끌고 가지 않습니다.

여러 게이트에 걸쳐 컨텍스트가 누적되도록 두면, AI는 이전 지시문과 산출물의 압축되거나 일부 손실된 버전을 기반으로 작업하게 됩니다. 출력 품질이 미세하고 진단하기 어려운 방식으로 저하됩니다.

**실제 적용:**

- AI가 질문 파일에 답하라고 하면 — 질문에 답한 뒤 **새 컨텍스트를 시작**하고 AI에게 파일을 다시 읽고 계속하라고 지시
- AI가 승인용 문서를 제시하면 — 검토 후 **새 컨텍스트를 시작**해 변경 요청 또는 승인·진행
- 워크플로 중간에 도구가 "컨텍스트 압축" 프롬프트를 제공하면 **항상 거절** — 압축은 깨끗한 리셋과 다르며 잃는 것이 더 큽니다

**컨텍스트 리셋 후 재개 방법:**

옵션 1 — 상태 파일 방법 (권장):

```text
Go to aidlc-docs/aidlc-state.md, find the first unchecked item,
then go to the corresponding plan file and resume from that point.
```

옵션 2 — 수동 인계:

```text
I am resuming a previously stopped conversation. Here is the context:
[paste summary of last output or recent change]
Please continue with [next action or section X].
```

> **Tip**: 컨텍스트를 리셋할 때마다 현재 변경 사항을 모두 저장소에 커밋·푸시하세요. 몇 초면 끝나며, 항상 깔끔한 복구점을 가지게 됩니다.

```text
Please commit and push all current changes to the repository.
```

---

### 프롬프트 배칭

모든 프롬프트를 따로 보내야 하는 것은 아닙니다. 워크숍 경험에서 나온 단순한 규칙:

**같은 주제에 긴밀히 결합된 두 변경은 한 프롬프트에 묶고, 무관한 변경은 하나씩 처리하세요.**

지나친 배칭(무관한 변경 결합)은 AI가 집중을 잃고 세부를 놓치게 만듭니다. 너무 잘게 쪼개기(밀접한 것을 따로 처리)는 불필요한 왕복을 늘립니다. 의심스러우면 분리하는 쪽으로 가세요.

---

### 외부 참조 파일 로드

기존 문서 — 스키마, 아키텍처 다이어그램, 데이터 사전, API 사양 — 어떤 것이든 AIDLC에 지정할 수 있고, AI는 그 내용을 현재 단계에 반영합니다.

**기본 패턴:**

```text
Please read [file path or description]. Use it as the basis for [what you want].
```

```text
We have an existing audit table structure. Please add it to the inception documents
and reference it for this service. When we proceed, expect new requirements and
stories related to this service.
```

> **고급 팁**: 시작 단계뿐 아니라 어느 단계에서든 문서를 로드할 수 있습니다. Construction 중 새 제약(업데이트된 보안 정책, 개정된 데이터 모델)이 나타나면 로드하고 영향 평가를 요청한 뒤 진행하세요.
>
> **고급 팁 — 확장으로의 엔터프라이즈 표준**: 모든 프로젝트에 적용해야 할 보안·컴플라이언스·API 가이드라인이 있다면, `aidlc-rules/extensions/`에 마크다운 steering 파일로 추가하세요. AIDLC가 매 단계에 수동 주입 없이 자동으로 로드합니다.

---

### 독립적인 비평 받기

AIDLC는 자신의 이전 결정을 옹호하려는 경향이 있습니다. 산출물에 대해 편향 없는 평가를 원한다면 **새 컨텍스트**에서 비평을 요청하세요 — AI가 그 결정의 이유를 기억하지 못하는 상태에서.

```text
Produce a critique document of [the requirements document / the component design].
Do this in a new context separate from everything else.
```

산출물이 생성된 같은 세션에서 비평을 요청하는 것보다 더 유용하고 객관적인 피드백이 나옵니다.

---

### 깊이 수준 (Depth Levels)

AIDLC는 요청의 복잡도에 따라 각 단계를 얼마나 깊이 실행할지 조정합니다. 이에 영향을 줄 수 있습니다.

```text
Keep this at minimal depth — we just need the basic structure documented.
```

```text
This is a production-critical component. Please run at comprehensive depth.
```

---

## 2. Inception 단계

Inception 단계는 설계나 코드 작업 전에 사용자와 AI가 *무엇을, 왜* 만들지에 합의하는 곳입니다. 여기에서 컨텍스트를 더 많이 제공할수록, Construction 단계에서 명확화 질문과 재작업이 줄어듭니다.

### 시작 전에 입력 문서 준비

AIDLC 킥오프 전에 할 수 있는 가장 효과적인 한 가지: 두 개의 문서를 준비합니다.

1. **비전 문서** — 무엇을 왜 만드는가
2. **기술 환경 문서** — 어떤 도구와 제약이 적용되는가

이 문서들은 AIDLC가 묻게 될 명확화 질문 수를 크게 줄이고, AI가 가정 대신 팀의 실제 컨텍스트에서 시작하도록 합니다.

**어디서 시작할까:**

- [writing-inputs/inputs-quickstart.md](writing-inputs/inputs-quickstart.md) — 그린필드/브라운필드 모두를 위한 빠른 요약
- [writing-inputs/vision-document-guide.md](writing-inputs/vision-document-guide.md) — 템플릿이 있는 비전 전체 가이드
- [writing-inputs/technical-environment-guide.md](writing-inputs/technical-environment-guide.md) — 템플릿이 있는 기술 환경 전체 가이드

**브라운필드 프로젝트**(기존 코드베이스 확장)는 입력이 약간 다릅니다. 비전 문서에는 현재 상태와 "변경하면 안 되는 것"의 명시적 목록이 필요합니다. 기술 환경 문서는 원하는 스택이 아니라 기존 스택을 기술해야 하며, 예시 코드는 실제 기존 파일에서 가져와야 합니다. 브라운필드 최소 입력과 실제 예시는 [writing-inputs/inputs-quickstart.md](writing-inputs/inputs-quickstart.md)를 참고하세요.

빠르게 시작하고 싶다면 **최소 입력**:

비전: 무엇을 누구를 위해 만드는지 한 단락, MVP 기능 목록(범위 IN), 명시적으로 범위 OUT인 기능 목록, 그리고 미해결 질문 — 이미 불확실하다고 알고 있는 항목. 미해결 질문은 Requirements Analysis에 사전 선언된 모호성으로 직결되어 설계 중간에 갑작스럽게 나타나는 대신 일찍 해소됩니다.

기술 환경: 언어와 버전, 패키지 매니저, 웹 프레임워크, 클라우드 공급자와 배포 모델, 테스트 프레임워크, 금지 라이브러리 표(각 항목에 사유와 권장 대안 포함), 보안 기본, 일반적인 엔드포인트·함수·테스트 각 하나씩의 예시.

금지 라이브러리 표가 단순 목록보다 중요합니다 — 사유와 대안 열이 AI-DLC에 *왜* 그 라이브러리가 금지인지 알려주어 더 나은 대체 결정을 가능하게 합니다. 예시 코드 패턴은 기본 사항을 넘어 가장 효과적인 추가물입니다: AI-DLC가 임의로 만드는 대신 코드 생성 중 따를 구체적 패턴을 줍니다.

> **Tip**: 사전에 채우는 모든 빈틈은 Requirements Analysis 중 묻게 될 명확화 질문 하나가 줄어드는 것입니다.

---

### 새 프로젝트 킥오프

입력 문서가 준비되면:

```text
I want to start a new project. Please read [path to vision document] and
[path to technical environment document], then begin the AIDLC workflow.
```

AIDLC가 작업 공간을 스캔하고, 그린필드/브라운필드 여부를 판단한 뒤, 제공된 문서를 주 소스로 Requirements Analysis에 진입합니다 — 문서가 다루지 않는 것만 묻습니다.

브라운필드 프로젝트의 경우 AIDLC는 먼저 Reverse Engineering을 실행하여 기존 코드베이스를 분석하고 아키텍처, 컴포넌트, API 문서를 산출합니다. 이후 모든 작업의 토대가 되므로 신중하게 검토하세요.

---

### 요구사항 질문에 답하기

글자, 라벨, 옵션 조합, X 사용에 대한 전체 가이드는 [Section 1](#질문--문서--승인-흐름)의 답변 팁을 참고하세요. Requirements Analysis에 고유한 몇 가지 추가 포인트:

- **전체 비전과 MVP를 명시적으로 분리.** AIDLC가 포함할 기능을 물으면 이름을 지정하세요. 범위에서 빠지는 것은 그렇게 말하세요 — 모호하게 두지 마세요.
- **의도적인 "No" 결정도 명확히.** `D — no caching required at this time`는 의도를 신호합니다. 빈 답은 AI가 추측적 선택을 하도록 유도합니다.
- **단계적 접근은 인라인으로 기술.** `X — simple role-based workflow now; replace with external workflow engine when available`는 AIDLC가 현재 솔루션을 올바른 확장 포인트로 설계하도록 합니다.

> **고급 팁 — 보안 확장**: Requirements Analysis 중 AIDLC는 보안 확장 규칙 적용 여부를 묻습니다. 운영 등급 애플리케이션이면 Yes, 프로토타입이면 No도 무방합니다. 이 결정은 기록되어 Construction 전반에 강제되므로 의도적으로 선택하세요.

---

### Inception 단계 특화 인터랙션

**중간에 기능 보류:**

```text
We are going to backlog the [feature name] capability for the current release.
Please remove it from the component design and flag the related user stories as backlogged.
```

삭제 대신 백로깅은 현재 빌드에 영향을 주지 않으면서 향후 이터레이션을 위한 작업을 보존합니다.

**기존 데이터 구조 등록:**

```text
We have an existing [schema/structure name]. Please add it to the inception documents
and reference it for this service. When we proceed, expect new requirements and
stories related to this service.
```

**암시적 데이터 소스를 명시적으로:**

```text
For the [service name], add the understanding that [new data source] is also a
data source for this feature, in addition to [existing data source]. Then review
requirements and user stories to ensure this is captured.
```

**설계 변경 후 상류 영향 점검:**

설계 산출물에 의미 있는 변경이 생긴 후, AIDLC에게 이전 문서들이 여전히 일관된지 점검 요청:

```text
Now review the previous steps — user stories and requirements — to ensure
this change does not require updates to any of those documents.
```

> **고급 팁 — 상시 역전파 규칙**: 매번 묻지 말고 단계 시작 시 상시 지시로 설정: "Every time you update a document, check whether the change impacts the requirements document and user stories, and prompt me if it does." 기억할 필요 없이 자동 안전망을 만들어줍니다.

**컴포넌트 설계의 병렬 팀 리뷰:**

여러 컴포넌트를 동시에 분담해 리뷰하는 경우:

```text
Restrict your edits to the files under your team's control. When all teams are done,
we will ask the AI to review all changes and confirm there are no conflicts.
Then we will ask it to review impacts to user stories and requirements.
```

모두 끝나면 충돌 점검 트리거:

```text
We had [N] independent groups editing component design files. Please review all files
and report any conflicts or inconsistencies. Do not edit the files — produce a report
for our review.
```

각 충돌을 번호별로 명시적으로 해결:

```text
For conflict #[number] ([conflict description]):
update [target file] to reflect [your decision].
```

```text
For conflict #[number] ([capability name]):
this capability is backlogged. Update the documentation to clearly mark it as
backlogged so code generation does not attempt to implement it.
```

**오래된 설계 파일 아카이브:**

설계 중 탐색으로 만들어진 더 이상 필요 없는 파일들:

```text
Move the [file descriptions] to an archive folder — do not delete them.
Then confirm whether they are required for code generation.
```

> **고급 팁 — 컴포넌트 크기 제약**: 한 스프린트에서 구현하기 너무 큰 과도한 컴포넌트를 방지하려면 Application Design 단계에서 스토리 포인트 상한을 설정: "At the component design phase, inject the following instruction: no single component should have more than [X] aggregate story points. If a component exceeds this limit, break it down into smaller sub-components."
>
> **고급 팁 — 단계 중간의 컨텍스트 리셋**: 세션이 중단되었을 때 상태 재설정에 사용:
>
> ```text
> Stop. New context. We just completed [description of recent work].
> Please review [upstream artifacts] to assess any impact of the recent change.
> [Paste the change description here.]
> ```

---

## 3. Construction 단계

Construction 단계는 설계가 코드가 되는 곳입니다. 각 작업 단위(unit of work)는 일련의 설계 단계(조건부) 다음에 코드 생성(항상)을 거칩니다. 모든 단위가 끝나면 Build and Test가 마무리합니다.

### 디자인 리뷰 절차

각 작업 단위에서 AIDLC는 코드 생성 전 다음 설계 단계의 일부 또는 전부를 실행할 수 있습니다.

- **Functional Design** — 비즈니스 로직, 도메인 모델, 데이터 스키마
- **NFR Requirements** — 성능, 보안, 확장성, 기술 스택 선택
- **NFR Design** — 설계에 NFR 패턴 적용
- **Infrastructure Design** — 실제 클라우드 서비스로 매핑

각 단계는 `aidlc-docs/construction/{unit-name}/`에 문서를 생성합니다. 각 게이트에서 사용자가 할 일은 문서를 읽고 변경 요청 또는 승인 결정을 하는 것입니다.

**승인 전에 읽으세요.** 설계 문서는 코드 생성의 진실의 출처입니다. 여기서 새어 나간 실수는 나중에 고치기 어렵습니다.

**설계에서 코드로 이행:**

코드 생성 단계로 전환할 준비가 되면, AI에 필요한 구조적 컨텍스트를 사전에 주세요.

```text
We have completed component design review. We are ready for code creation.
Please use the following directory and source code structure:
[reference an existing service or folder structure].
Use this pattern for APIs. For the UI, follow the [Vue.js composables/components/store]
directory structure. Please ask any questions you have before proceeding.
```

생성 시작 전에 질문을 받음으로써 파일 생성 중간이 아닌 계획 단계에서 모호성을 해소합니다.

**타깃 보정 요청:**

요소를 명시하고, 무엇이 잘못되었고 무엇이어야 하는지 명확히:

```text
The [endpoint description] should use [correct parameter], not [incorrect parameter].
Please update the [component name] accordingly.
```

**AI가 제시한 옵션 중 선택:**

```text
Please implement Option B — [option description] — for [feature name].
Update all component design documents accordingly.
```

옵션을 글자 *와* 설명으로 참조하고, 질문이 생긴 한 문서가 아니라 영향을 받는 모든 문서로 업데이트 범위를 명시하세요.

**디자인 패턴 오버라이드:**

```text
We prefer to deviate from [standard pattern] and use [our preferred approach]
to allow [rationale]. Please update the component design documents accordingly.
```

근거가 중요합니다. AIDLC가 후속 단계로 이를 이어가므로, 편차가 조용히 되돌려지는 것을 막습니다.

> **고급 팁 — 커밋 전 영향 평가**: 의미 있는 설계 변경에 대해 행동 전에 평가:
>
> ```text
> Do not change anything. Assess the impact of [proposed change].
> [Describe the proposed change in detail.]
> ```
>
> **고급 팁 — 인라인 코드 문서화**: 인라인 문서화를 모든 단위에 일관 적용하고 싶다면, 각 단위마다 반복하지 말고 Construction 단계 시작 시 상시 규칙으로 추가: "Add inline code documentation as a standard rule for the construction phase."

---

### 코드 생성 절차

코드 생성은 두 부분으로 구분됩니다. 둘 다 명시적 승인이 필요합니다.

**Part 1 — 계획**

AIDLC는 만들거나 수정할 파일별로 번호와 체크박스가 달린 계획을 만듭니다. 승인 전에 검토하세요. 점검 사항:

- 모든 파일이 올바른 위치에 있는가 (애플리케이션 코드는 작업 공간 루트, `aidlc-docs/`에는 절대 두지 않음)
- 설계 문서가 명시한 모든 것을 단계가 다루는가
- 브라운필드 프로젝트는 새 중복이 아닌 수정할 기존 파일이 나열되는가

> **고급 팁 — 내부 라이브러리**: 계획 승인 전에 내부 라이브러리 요구사항을 Q&A 파일 또는 구현 계획에 주입:
>
> ```text
> In addition to my answers, you must use the following libraries from our
> [starter project / building blocks]: [list each library explicitly].
> Explain why and when each should be used, not just what it is.
> ```
>
> 저장소를 가리키기보다 내부 라이브러리를 큐레이션한 마크다운 가이드가 더 잘 작동합니다. 이를 코드 생성 입력으로 만들고 참조하세요.
>
> **고급 팁 — Figma 디자인으로부터의 UI**: Figma 디자인을 스크린샷으로 찍어 비전 지원 모델(예: ChatGPT)에 넣어 프레임워크 코드를 생성한 뒤, 그 결과를 AIDLC의 UI 구현 입력으로 제공하세요. 디자인 도구의 원시 익스포트보다 구체적이고 도구가 읽을 수 있는 사양이 만들어집니다.

**Part 2 — 생성**

AIDLC는 각 단계를 순차적으로 실행하며 완료된 단계를 체크합니다. 모든 단계가 끝나면, 생성된 파일 경로와 함께 완료 메시지를 표시합니다.

승인 전에 생성된 코드를 검토하세요. 문제가 있다면:

```text
Request Changes: [describe specifically what needs to change]
```

> **고급 팁 — 브라운필드 파일 수정**: 기존 코드베이스에 대해 AIDLC는 파일을 제자리 수정합니다. 원본 옆에 `ClassName_modified.java` 또는 `service_new.ts`가 보이면 즉시 표시:
>
> ```text
> I see [ClassName_modified.java] alongside [ClassName.java]. Please merge the changes
> into the original file and delete the duplicate.
> ```

---

### 빌드 및 테스트

모든 단위가 완료된 후 AIDLC는 모든 단위에 대한 빌드/테스트 지시서를 생성합니다. 알아두면 좋은 몇 가지 패턴:

**테스트 도구를 적시에 주입:**

테스트 프레임워크나 테스트 관리 시스템 지시는 프로젝트 시작 시 추가하지 마세요. 코드 생성 시점에 그 세부 사항이 여러 단계에 걸쳐 압축되거나 잃었을 수 있습니다. 적시(JIT)에 주입하세요.

```text
At the functional test generation step, inject the following instruction:
generate functional tests using the [test management system] format described
in this document: [attach specification]. Use this API endpoint to push the
generated test cases to the [test management system] repository: [endpoint details].
```

이 원칙은 도구 고유 지시 전반에 적용됩니다: 프로젝트 시작이 아니라 필요한 단계에서 주입.

**단위 테스트 커버리지 범위:**

```text
When generating unit tests, exclude third-party external dependencies from
code coverage calculations. Require a minimum of 80% coverage on internal
code paths only.
```

---

### 코드 생성 후: 변경 사항 역전파

코드 생성 중 만들어진 변경(작은 설계 결정, 코드 작성 중 발견된 조정)은 설계 문서로 흘러 올라가야 합니다. 임시방편이 아닌, 코드 정리가 끝난 후 의도된 일괄 작업으로 수행하세요.

```text
When you have finished polishing the code, review each unit's final design files
and propagate any changes back up the chain to requirements and user stories.
Make a plan for how to do this step by step before executing.
```

실행 전에 계획을 요청하면 일부만이 아니라 모든 단위에 체계적으로 적용됩니다.

> **고급 팁 — 재사용 가능한 사양 추출**: 완료된 프로젝트 마지막에, 확립된 패턴들을 향후 프로젝트용 재사용 가능 사양 문서로 추출:
>
> ```text
> Create a set of reusable specification documents from the patterns expressed
> in this project: one for API design, one for security, one for UI specifications,
> one for the technology stack, and one for directory structure. Use the completed
> units as the source. I will review and approve each document before it is used
> in future projects.
> ```

---

## 4. 절대 바이브 코딩 하지 말 것

바이브 코딩(Vibe coding)은 빠른 수정이나 실험을 위해 생성된 코드 파일을 직접 편집하여 설계 문서를 완전히 우회하는 것을 말합니다. 순간엔 빨라 보이지만 곧 문제를 만듭니다.

문제는 편집 자체가 아닙니다. AIDLC가 모든 후속 작업에 사용하는 진실의 출처인 설계 문서가 더 이상 코드가 실제로 무엇을 하는지 반영하지 않는다는 것입니다. 다음에 AIDLC가 관련 단위에 대해 코드 생성을 실행하거나, 세션을 재개하거나, 동료가 작업을 이어받을 때, 이 불일치가 혼란과 재작업을 야기합니다.

워크숍에서 한 팀은 다음과 같이 직접 표현했습니다.

> "코드를 직접 고치지 않습니다. 이슈를 발견하면 AIDLC로 돌아가 말합니다: 이슈 X를 발견했어. 설계를 검토하고 수정 계획을 세워. 이게 설계에 영향을 주면 설계를 업데이트하고, 그 다음에 코드를 업데이트해."

**규칙: 설계를 먼저 업데이트하고, 그 다음 코드를 생성합니다.**

---

### 변경하는 올바른 방법

버그를 발견했든, 설계 결정을 바꿨든, 새 요구사항을 받았든 흐름은 같습니다.

**1단계 — 어떤 것도 건드리지 않고 이슈를 기술:**

```text
Do not update any documents yet. I have discovered issue [X].
Review the design and help me understand where this needs to be addressed.
```

**2단계 — 설계 문서 수정:**

```text
Please update [specific design document] to reflect [the fix].
Then check whether any upstream documents — requirements, user stories —
also need to be updated.
```

**3단계 — 영향받는 코드 재생성:**

```text
The design for [unit name] has been updated. Please re-run code generation
for the affected files only.
```

파일을 직접 편집하는 것보다 몇 분 더 걸리지만, 문서가 동기화되고, 감사 로그가 완전하며, 팀이 실제로 만들어진 것에 정렬됩니다.

---

### "그냥 파일을 편집하고 싶다" 충동이 들 때

**"한 줄 수정인데요."**

설계를 우회하는 한 줄 수정도 드리프트를 만듭니다. 관련 설계 문서에 수정 사항을 기록하고 AIDLC가 적용하게 하세요.

```text
In [functional-design.md for unit X], update [method or rule] to [the fix].
Then regenerate [the affected file].
```

**"탐색 중일 뿐, 아직 확정 아닙니다."**

탐색이야말로 "Do not update any documents"가 있는 이유입니다. 채팅에서 자유롭게 탐색하세요. 준비가 됐을 때만 확정합니다.

**"팀을 지금 당장 언블록해야 해요."**

빠르게 움직여야 할 때가 있습니다. 직접 편집했다면 감사 로그가 정확하게 유지되도록 정직하게 기록하세요.

```text
We made a temporary direct edit to [file] to unblock the team.
The fix was [description]. Please update [design document] to reflect this
and verify no other documents are inconsistent.
```

---

### 드리프트를 방지하는 상시 규칙

매번 요청을 기억할 필요 없이 문제를 조기에 잡는 두 가지 상시 지시:

**모든 업데이트마다 역전파:**

```text
Every time you update a document, check whether the change impacts the
requirements document and user stories, and prompt me if it does.
```

**모든 코드 결정에 대해 설계 우선:**

```text
When you make a design decision during code generation, always make sure
the documentation reflects this change before proceeding.
```

Construction 시작 시 한 번 설정하면 단계 전체에 적용됩니다.

---

### 리포트를 aidlc-docs 밖에 두기

실용적 메모: AIDLC에 사람을 위한 리포트(아키텍처 다이어그램, 컴포넌트 요약, 이해관계자 발표 자료)를 만들게 할 때, `aidlc-docs/`에 저장하지 마세요. 그 파일들은 후속 단계에서 산출물로 로드되어 토큰 수를 늘리고 AI가 무엇이 권위 있는 설계 입력인지 혼란스럽게 할 수 있습니다.

별도의 `reports/` 폴더를 사용하고, 더 깨끗한 결과를 위해 전용 리포트 사양 파일을 가진 새 컨텍스트에서 리포트를 생성하세요.

```text
Pause the process. Start a new context. Read [report specification markdown file]
and produce the report based on the current state of the AIDLC artifacts.
Save the output to a reports/ folder, not aidlc-docs/.
```

---

*입력 문서 준비 가이드는 [writing-inputs/inputs-quickstart.md](writing-inputs/inputs-quickstart.md)를 참고하세요.*
