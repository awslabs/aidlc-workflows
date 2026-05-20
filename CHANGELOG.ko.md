# 변경 이력 (Changelog)

이 프로젝트의 주요 변경 사항을 모두 이 파일에 기록합니다.

> 참고: `CHANGELOG.md`는 git-cliff에 의해 자동 생성됩니다. 이 한글 번역본은 참고용이며, 원본이 정본(正本)입니다.

## [0.1.8] - 2026-04-20

### 버그 수정

- #172 머지에서 누락된 PR 헤드 브랜치 감지 복원 (#173)
- tag-on-merge 워크플로의 태그 생성 절차 수정 (#174)
- CodeBuild 액션 버전 업데이트 및 트리거 추가 (#175)
- 포크 저장소에서는 CodeBuild를 건너뜀 (#178)
- 사용자의 대화 언어로 확장 옵트인 프롬프트 표시 (#177)
- README 미세 업데이트 (#192)

### CI/CD

- markdownlint 인프라 추가 (#159)

### 기능

- 트렌드 리포트 요약을 PR 코멘트로 게시 (#172)
- 보안 스캐너 워크플로 추가 (#161)
- 에이전트 주도 설정 — 수동 단계 제거 (#109)

### 기타

- /scripts/aidlc-evaluator의 cryptography 버전 업 (#179)
- /scripts/aidlc-evaluator의 pytest 버전 업 (#184)
- /scripts/aidlc-evaluator의 pillow 버전 업 (#183)
- 워크플로의 CodeQL 액션 버전 수정 (#191)
- /scripts/aidlc-evaluator의 python-multipart 버전 업 (#186)

## [0.1.7] - 2026-04-02

### 버그 수정

- 필수 GitHub 토큰 환경 변수 추가 (#137)
- 보안 확장 면책 조항 추가 (#134)
- 릴리스 워크플로의 오류 처리 및 PR 생성 리팩터링 (#140)
- 릴리스 워크플로에 대한 PR #140 리뷰 피드백 반영 (#141)
- CodeBuild 워크플로 아티팩트의 retention-days 제한 제거 (#149)
- 읽기 전용 GITHUB_TOKEN을 가진 포크 PR에서 PR 코멘트 단계 건너뜀 (#154)
- label-reminder 코멘트 삭제용 GitHub API 경로 수정 (#157)
- report-bundle CodeBuild 보조 아티팩트 제거 및 --local-run-dir 지원 추가 (#162)
- merge ref 대신 PR 헤드 브랜치를 rules-ref로 사용 (#168)
- CodeBuild 트리거를 위해 릴리스 PR에서 aidlc-rules/VERSION 기록 (#169)

### 문서

- 로컬 CodeBuild 실행 개발자 가이드 추가 (#94)
- working-with-aidlc 인터랙션 가이드 및 writing-inputs 문서 추가 (#121)
- 종합 문서 검토 및 보완 (#113)

### 기능

- 코드 오너 추가 (#112)
- changelog-first 릴리스 흐름 및 드래프트 릴리스 빌드 아티팩트 (#125)
- AIDLC 평가 및 리포팅 프레임워크 추가 (#115)
- PR 린팅 조건 업데이트 (#131)
- 크로스 릴리스 트렌드 리포팅 패키지 추가 (#136)
- CodeBuild 워크플로를 현재 evaluator CLI와 정렬, 트렌드 리포트 파이프라인 추가 (#147)
- 'codebuild' 라벨 + aidlc-rules 경로 기준 CodeBuild 게이팅 (#150)
- aidlc-rules/ 변경 PR에 자동으로 codebuild 라벨 부여 (#158)

### 기타

- /scripts/aidlc-evaluator의 pyjwt 버전 업 (#129)
- /scripts/aidlc-evaluator의 pillow 버전 업 (#130)
- /scripts/aidlc-evaluator의 requests 버전 업 (#146)
- /scripts/aidlc-evaluator의 cryptography 버전 업 (#148)
- /scripts/aidlc-evaluator의 pygments 버전 업 (#151)
- /scripts/aidlc-evaluator의 aiohttp 버전 업 (#163)

## [0.1.6] - 2026-03-05

### 버그 수정

- CodeBuild 캐시 및 다운로드 수정 (#93)
- error-handling.md의 복사-붙여넣기 오류 수정 (#96)

### 기능

- CodeBuild 워크플로 추가 (#92)

### 기타

- GitHub 이슈 템플릿 추가 (#97)

## [0.1.4] - 2026-02-24

### 버그 수정

- GitHub Copilot 지시사항 및 Kiro CLI rule-details 경로 해결 수정 (#82, #84) (#87)

## [0.1.3] - 2026-02-11

### 버그 수정

- 감사(audit) 타임스탬프에 실제 시스템 시간 요구 (#56)

### 문서

- ZIP 다운로드 위치 명확화 및 노트 통합 (#70)

## [0.1.2] - 2026-02-08

### 버그 수정

- core-workflow.md 오타 수정
- 규칙 이름 변경 및 Critical Rules 섹션 하단으로 이동

### 문서

- 사용자가 GitHub Releases로 이동하도록 README 업데이트 (#61)
- Windows CMD 설정 안내 및 ZIP 노트 추가 (#68)

### 기능

- 테스트 자동화 친화적인 코드 생성 규칙 추가
- Construction 단계에 프런트엔드 디자인 범위 추가

## [0.1.1] - 2026-01-22

### 기능

- Claude, OpenCode 등 IDE와 함께 동작하는 AIDLC 스킬 추가
- addin
- leo 파일 추가

### 기타

- 잘못된 파일 제거
- 잘못된 파일 제거

## [0.1.0] - 2026-01-22

### 기능

- Kiro CLI 지원 및 멀티 플랫폼 아키텍처 추가
