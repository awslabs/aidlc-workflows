# 기여 가이드라인 (Contributing Guidelines)

AI-DLC 프로젝트에 기여해 주셔서 감사합니다. 버그 리포트, 새 규칙, 수정, 또는 문서 개선 등 커뮤니티의 모든 피드백과 기여를 환영합니다.

이슈 또는 풀 리퀘스트(Pull Request)를 제출하기 전에 이 문서를 먼저 읽어주시기 바랍니다.

## 핵심 원칙 (Tenets)

기여하기 전에 먼저 우리의 [핵심 원칙](README.md#tenets)을 숙지해 주세요.

## 규칙 기여하기

AI-DLC 규칙은 `aidlc-rules/aws-aidlc-rule-details/` 디렉터리 아래에 있습니다. 기여 시 다음 사항을 지켜주세요.

- **재현 가능성**: 변경 사항은 테스트 케이스 또는 일련의 단계를 통해 일관되게 재현 가능해야 합니다.
- **단일 정보 출처 (Single source of truth)**: 콘텐츠를 중복하지 마세요. 여러 단계에 동시에 적용되는 가이드는 `common/` 폴더에 두고 참조하도록 합니다.
- **중립성 유지**: 핵심 방법론은 특정 IDE, 에이전트, 모델에 종속되지 않아야 합니다. 도구별 파일은 원본에서 생성됩니다.

### 디렉터리 구조 — 이름 변경 또는 이동 금지

`aidlc-rules/` 아래의 `aws-aidlc-rules/`와 `aws-aidlc-rule-details/` 폴더 이름은 공개 계약(public contract)의 일부입니다. 워크숍, 테스트, `core-workflow.md`의 경로 해결 로직 모두가 정확히 이 이름들에 의존합니다. 평탄화하거나 이름을 변경하거나 재구성하지 마세요.

```text
aidlc-rules/
├── aws-aidlc-rules/            # 핵심 워크플로 진입점
│   └── core-workflow.md
└── aws-aidlc-rule-details/     # 워크플로가 참조하는 상세 규칙
    ├── common/
    ├── inception/
    ├── construction/
    ├── extensions/
    └── operations/
```

### 규칙 구조

규칙은 단계별로 구성되어 있습니다.

- `common/` - 모든 단계에서 공유되는 가이드
- `inception/` - 계획 및 아키텍처 규칙
- `construction/` - 설계 및 구현 규칙
- `operations/` - 배포 및 모니터링 규칙
- `extensions/` - 선택적인 횡단(cross-cutting) 제약 규칙

### 변경 사항 테스트

규칙 변경 사항은 제출 전에 적어도 하나 이상의 지원 플랫폼(Amazon Q Developer, Kiro, 기타 도구)에서 테스트해 주세요. PR에 무엇을 테스트했는지 명시해 주십시오.

설치 가이드를 추가하거나 업데이트한 경우, Mac, Windows CMD, Windows PowerShell 환경에서 모두 테스트하셨는지 확인하세요.

## 버그/기능 요청 보고

GitHub 이슈를 사용해 버그를 보고하거나 기능을 제안하세요. 등록 전에 기존 이슈를 확인하여 중복을 피하세요.

다음 사항을 포함해 주세요.

- 어느 규칙 또는 단계가 영향을 받는지
- 예상 동작과 실제 동작
- 테스트한 플랫폼/모델

## 풀 리퀘스트(PR)를 통한 기여

### 이슈로 먼저 시작하세요

PR을 작업하기 전에 이슈를 먼저 여는 것을 권장합니다. 이렇게 하면 우리와 커뮤니티가 의도를 이해하고, 접근 방식을 논의하며, 코드를 작성하기 전에 범위를 합의할 수 있습니다. 오타나 린트 수정과 같은 작은 수정은 곧바로 PR을 제출하셔도 됩니다.

### AI가 생성한 기여

AI 코딩 에이전트가 만든 PR도 동일한 절차로 환영합니다. 이슈로 시작하고, 범위를 합의하며, 품질 기준을 충족해야 합니다.

### PR 제출 방법

1. 최신 `main` 브랜치를 기준으로 작업합니다
2. 열려 있거나 최근 병합된 PR을 확인합니다
3. 저장소를 포크(Fork)합니다
4. 변경 사항을 작성합니다(범위를 작게 유지하세요)
5. [Conventional Commits](https://www.conventionalcommits.org/) 형식의 명확한 커밋 메시지를 사용하세요 (예: `feat:`, `fix:`, `docs:`)
6. PR을 제출하고 피드백에 응답하세요

### PR 종료

모든 PR을 검토하며 기여가 반영될 수 있도록 돕고자 합니다. 프로젝트 품질 유지를 위해, 범위를 벗어나거나 본 가이드를 따르지 않는 PR은 닫을 수 있습니다. 그런 경우에도 언제든 이슈를 열고 다시 시도하실 수 있습니다.

## 행동 강령

이 프로젝트는 [Amazon 오픈소스 행동 강령](https://aws.github.io/code-of-conduct)을 채택하고 있습니다.

자세한 내용은 [행동 강령 FAQ](https://aws.github.io/code-of-conduct-faq)를 참고하시거나, 추가 문의 사항이 있으시면 <opensource-codeofconduct@amazon.com> 으로 연락해 주세요.

## 보안 이슈 신고

잠재적인 보안 이슈를 발견한 경우, [취약점 신고 페이지](http://aws.amazon.com/security/vulnerability-reporting/)를 통해 AWS/Amazon Security에 알려주세요. 공개 GitHub 이슈를 만들지 마세요.

## 라이선스

프로젝트 라이선스에 관해서는 [LICENSE](LICENSE) 파일을 참고하세요. 기여 시 라이선스 확인을 요청드릴 수 있습니다.
