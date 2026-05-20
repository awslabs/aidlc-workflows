# AGENTS.md

## 프로젝트 개요

AI-DLC(AI-Driven Development Life Cycle, AI 주도 개발 생명주기)는 AI 코딩 에이전트가 체계적인 소프트웨어 개발 워크플로를 따르도록 안내하는 방법론입니다. 이 저장소에는 핵심 워크플로 규칙, 단계별 상세 규칙, 평가자(evaluator) 프레임워크가 포함되어 있습니다.

배포되는 산출물은 `aidlc-rules/` 디렉터리이며, ZIP으로 묶여 GitHub Releases를 통해 게시됩니다.

## 저장소 구조

```text
aidlc-rules/
├── aws-aidlc-rules/              # 핵심 워크플로 진입점 (이름 변경 금지)
│   └── core-workflow.md
└── aws-aidlc-rule-details/       # 워크플로에서 참조되는 상세 규칙 (이름 변경 금지)
    ├── common/                   # 모든 단계 공통 가이드
    ├── inception/                # 계획 및 아키텍처 규칙
    ├── construction/             # 설계 및 구현 규칙
    ├── extensions/               # 선택적 횡단 제약 규칙
    └── operations/               # 배포 및 모니터링 규칙
scripts/aidlc-evaluator/          # Python 평가 프레임워크 (uv 기반)
docs/
├── ADMINISTRATIVE_GUIDE.md       # CI/CD, 워크플로, 시크릿, 릴리스 절차
├── DEVELOPERS_GUIDE.md           # 로컬 빌드(CodeBuild, act), 보안 스캐너
├── WORKING-WITH-AIDLC.md         # AI-DLC 방법론 사용자 가이드
├── GENERATED_DOCS_REFERENCE.md   # 전체 aidlc-docs/ 디렉터리 레퍼런스
└── writing-inputs/               # 비전/기술 환경 문서 작성 가이드 및 예시
.github/
├── workflows/                    # CI/CD 파이프라인 (8개 워크플로)
├── dependabot.yml                # Dependabot 의존성 업데이트 설정
├── CODEOWNERS                    # PR 리뷰를 위한 코드 오너십 규칙
├── ISSUE_TEMPLATE/               # 이슈 템플릿
├── pull_request_template.md      # 기여자 진술이 포함된 PR 템플릿
└── labeler.yml                   # 자동 라벨링 규칙 (경로 → 라벨 매핑)
.claude/                          # Claude Code 프로젝트 설정
```

## 핵심 문서

- [CONTRIBUTING.md](CONTRIBUTING.md) — 기여 절차 및 규약
- [docs/ADMINISTRATIVE_GUIDE.md](docs/ADMINISTRATIVE_GUIDE.md) — CI/CD 아키텍처,
  보호된 환경, 시크릿, 권한, 릴리스 절차
- [docs/DEVELOPERS_GUIDE.md](docs/DEVELOPERS_GUIDE.md) — 로컬 CodeBuild 실행,
  보안 스캐너 상세 및 조치 가이드
- [docs/WORKING-WITH-AIDLC.md](docs/WORKING-WITH-AIDLC.md) — AI-DLC 방법론
  사용자 가이드 (컨텍스트 관리, 프롬프트 패턴, 단계별 워크스루)
- [docs/GENERATED_DOCS_REFERENCE.md](docs/GENERATED_DOCS_REFERENCE.md) — 워크플로에서
  생성되는 `aidlc-docs/` 디렉터리 구조 완전 레퍼런스
- [docs/writing-inputs/](docs/writing-inputs/) — 비전 및 기술 환경 문서 가이드 및 예시

**작업 유형별로 읽을 문서:**

- CI/CD, 워크플로, 릴리스 → `ADMINISTRATIVE_GUIDE.md`, `DEVELOPERS_GUIDE.md`
- aidlc-rules 콘텐츠 → `WORKING-WITH-AIDLC.md`, `GENERATED_DOCS_REFERENCE.md`
- 비전 또는 기술 환경 문서 → `docs/writing-inputs/`

## 셋업 명령

```bash
# 모든 마크다운 파일 린트
npx markdownlint-cli2 "**/*.md"

# 마크다운 린트 이슈 자동 수정
npx markdownlint-cli2 --fix "**/*.md"

# evaluator 테스트 실행 (scripts/aidlc-evaluator/ 에서)
cd scripts/aidlc-evaluator && uv run pytest
```

## 코드 스타일

- 모든 콘텐츠는 Markdown — `.markdownlint-cli2.yaml` 설정을 따릅니다
- MD013 (라인 길이) 비활성화 — 긴 URL, 표, 코드 예시 허용
- MD033 (인라인 HTML) 비활성화 — 스크린샷에 `<img>` 태그 사용
- MD024 (중복 헤딩) 비활성화 — 플랫폼별 가이드에서 섹션명 반복
- MD036 (강조의 헤딩 사용) 비활성화 — 굵은 글씨를 리스트 내 하위 레이블로 사용
- MD060 (표 정렬) 적용 — 표의 파이프(|)는 수직 정렬되어야 함
- MD040 (코드 펜스 언어 지정) 적용 — 코드 펜스에는 항상 언어 명시
- 커밋 메시지는 [Conventional Commits](https://www.conventionalcommits.org/)를 따릅니다
  (예: `feat:`, `fix:`, `docs:`, `chore:`)

## 테스트 안내

- 규칙 변경은 제출 전에 지원 플랫폼 중 최소 하나(Amazon Q Developer, Kiro,
  Cursor, Cline, Claude Code, GitHub Copilot)에서 테스트해 주세요
- 설치 가이드를 추가/업데이트할 때는 macOS, Windows CMD, Windows PowerShell에서 테스트하세요
- 커밋 전에 `npx markdownlint-cli2 "**/*.md"`를 실행해 린트 이슈를 확인하세요
- pre-commit 훅이 설정되어 있다면 markdownlint가 자동 실행됩니다

## PR 안내

- PR 제목은 Conventional Commits 형식을 따라야 합니다 (예: `fix: 설명`)
- 항상 PR 본문 끝에 다음 기여자 진술을 포함하세요:

  > 이 풀 리퀘스트를 제출함으로써, 본인은 [프로젝트 라이선스](https://github.com/awslabs/aidlc-workflows/blob/main/LICENSE)
  > 조건에 따라 본 기여를 사용·수정·복사·재배포하는 데 동의합니다.

- CI에서 강제하는 항목: Conventional Commits 제목, 기여자 진술, markdownlint,
  do-not-merge 라벨 검사
- `.github/pull_request_template.md` 구조를 사용하세요

## 보안 스캐너

`main` 푸시, 모든 PR, 그리고 매일 6개의 스캐너가 실행됩니다. 모든 HIGH 및 CRITICAL
검출은 머지 전에 조치되거나 위험 수용이 문서화되어야 합니다.

| 스캐너     | 탐지 대상                | 실패 조건                       | 설정 파일                                    |
| --------- | ----------------------- | ------------------------------ | ------------------------------------------- |
| Bandit    | Python SAST 이슈        | high confidence 검출            | `.bandit`                                   |
| Semgrep   | 다중 언어 SAST          | 모든 검출(PR은 신규만)          | `.semgrepignore`                            |
| Grype     | 의존성 CVE              | high/critical CVE              | `.grype.yaml`                               |
| Gitleaks  | git 이력 내 시크릿       | baseline에 없는 모든 시크릿     | `.gitleaks.toml`, `.gitleaks-baseline.json` |
| Checkov   | IaC 잘못된 설정         | 모든 검사 실패                  | `.checkov.yaml`                             |
| ClamAV    | 멀웨어                  | 모든 검출                       | 없음                                        |

인라인 억제 패턴:

- Bandit: `# nosec BXXX — 사유`
- Semgrep: `# nosemgrep: rule-id — 사유`
- Checkov: `# checkov:skip=CKV_ID:사유`

완전한 조치 및 억제 가이드는
[docs/DEVELOPERS_GUIDE.md](docs/DEVELOPERS_GUIDE.md#security-scanners) 를 참고하세요.

## 중요 제약 사항

- `aws-aidlc-rules/`, `aws-aidlc-rule-details/` 폴더 이름은 공개 계약의 일부이므로
  이름 변경, 이동, 재구성을 금지합니다
- 규칙 간 콘텐츠 중복 금지 — 공유 가이드는 `common/`에 두고 참조하세요
- 핵심 방법론은 IDE/에이전트/모델에 종속되지 않도록 유지하세요
- 보안 이슈는 공개 GitHub 이슈가 아니라
  [AWS 취약점 신고](http://aws.amazon.com/security/vulnerability-reporting/) 채널로 신고해야 합니다
- `CHANGELOG.md`는 git-cliff에 의해 자동 생성됩니다 — 직접 수정 금지

## 에이전트 실행 스니펫 (Copilot 추가)

에이전트를 위한 간단한 안내: 저장소의 uv 래퍼와 npx 기반 도구를 우선 사용하세요. 어떤 명령을 실행하기 전에 docs/DEVELOPERS_GUIDE.md, docs/ADMINISTRATIVE_GUIDE.md를 읽으세요.

테스트 (uv):

```bash
uv run pytest
uv run pytest --cov --cov-report=term-missing
```

마크다운 린트 (npx):

```bash
npx markdownlint-cli2 "**/*.md"
npx markdownlint-cli2 --fix "**/*.md"
```

도커화된 보안 스캔 (로컬, 크로스 플랫폼 권장):

```bash
# Grype
docker run --rm -v "$PWD:/workspace" anchore/grype:latest grype dir:/workspace -o sarif=grype.sarif
# Gitleaks
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source /repo --report-format sarif --report-path gitleaks.sarif
# Semgrep
docker run --rm -v "$PWD:/src" returntocorp/semgrep semgrep --config=r/all --sarif /src > semgrep.sarif
# Checkov
docker run --rm -v "$PWD:/src" bridgecrew/checkov --directory /src --output-file-path checkov.sarif --output sarif
# Bandit
docker run --rm -v "$PWD:/src" python:3.12-slim bash -c "pip install -q bandit && bandit -r /src -f sarif -o /src/bandit.sarif"
# ClamAV
docker run --rm -v "$PWD:/data" mkodockx/docker-clamav clamscan -r /data --log=/data/clamdscan.txt
```

참고:

- 위 명령은 SARIF/텍스트 아티팩트를 프로젝트 루트에 기록하여 CI/에이전트가 사용할 수 있게 합니다.
- CI에서 이미 스캐너를 실행하므로, 로컬 검증이 필요할 때 Docker가 있다면 활용하세요.
- Docker가 없는 경우 docs/DEVELOPERS_GUIDE.md의 플랫폼별 설치 안내를 따르세요.
