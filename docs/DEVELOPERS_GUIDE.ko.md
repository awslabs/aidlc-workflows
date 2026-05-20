# 개발자 가이드

## CodeBuild 로컬 실행

AWS CodeBuild 빌드를 [CodeBuild 로컬 에이전트](https://docs.aws.amazon.com/codebuild/latest/userguide/use-codebuild-agent.html)로 로컬에서 실행할 수 있습니다. 원격에 푸시하지 않고 buildspec 변경을 테스트할 때 유용합니다.

### 사전 요구사항

- Docker 설치 및 실행 중일 것
- `codebuild_build.sh` 스크립트

### 기본 사용법

1. 셋업

- 로컬 CodeBuild 스크립트를 다운로드하고 실행 권한을 부여
- `GH_TOKEN`(GitHub Personal Access Token, PAT) 환경 변수를 `./.env` 파일로 보내기

```bash
if [ ! -f codebuild_build.sh ]; then
  curl -O https://raw.githubusercontent.com/aws/aws-codebuild-docker-images/master/local_builds/codebuild_build.sh && chmod +x codebuild_build.sh;
fi;
echo "GH_TOKEN=${GH_TOKEN:-ghp_notset}" > "./.env";
```

1. 반복 실행

- _선택적으로 `.github/workflows/codebuild.yml` GitHub 워크플로의 `buildspec-override` 값을 편집_
- 워크플로 내용을 기반으로 `./buildspec.yml`을 로컬 파일로 업데이트
- 머신 아키텍처에 맞는 이미지로 AWS CodeBuild 빌드 로컬 실행

```bash
cat .github/workflows/codebuild.yml \
    | uvx yq -r '.jobs.build.steps[] | select(.id == "codebuild") | .with["buildspec-override"]' \
    > buildspec.yml
./codebuild_build.sh \
  -i "public.ecr.aws/codebuild/amazonlinux-$([ "$(arch)" = "arm64" -o "$(arch)" = "aarch64" ] && echo "aarch64" || echo "x86_64")-standard:$([ "$(arch)" = "arm64" -o "$(arch)" = "aarch64" ] && echo "3.0" || echo "5.0")" \
  -a "./.codebuild/artifacts/" \
  -l "public.ecr.aws/codebuild/local-builds:$([ "$(arch)" = "arm64" -o "$(arch)" = "aarch64" ] && echo "aarch64" || echo "latest")" \
  -c \
  -e "./.env"
```

### 스크립트 옵션 전체

| 플래그           | 필수       | 설명                                                                                                                                                                                           |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-i IMAGE`     | 예         | 고객 빌드 컨테이너 이미지 (예: `aws/codebuild/standard:5.0`)                                                                                                                                          |
| `-a DIR`       | 예         | 아티팩트 출력 디렉터리                                                                                                                                                                                |
| `-b FILE`      | 아니오      | buildspec 오버라이드 파일. 기본값은 소스 디렉터리의 `buildspec.yml`                                                                                                                                  |
| `-s DIR`       | 아니오      | 소스 디렉터리. 첫 `-s`는 주 소스이며, 추가 `-s`는 `<sourceIdentifier>:<sourceLocation>` 형식의 보조 소스. 기본은 현재 작업 디렉터리                                                                            |
| `-l IMAGE`     | 아니오      | 기본 로컬 에이전트 이미지 오버라이드                                                                                                                                                                  |
| `-r DIR`       | 아니오      | 리포트 출력 디렉터리                                                                                                                                                                                |
| `-c`           | 아니오      | 로컬 호스트의 AWS 구성과 자격 증명 사용 (`~/.aws` 및 `AWS_*` 환경 변수)                                                                                                                              |
| `-p PROFILE`   | 아니오      | 사용할 AWS CLI 프로파일 (`-c` 필요)                                                                                                                                                                  |
| `-e FILE`      | 아니오      | 환경 변수가 담긴 파일 (`VAR=VAL` 형식, 한 줄에 하나)                                                                                                                                                |
| `-m`           | 아니오      | 소스 디렉터리를 빌드 컨테이너에 직접 마운트                                                                                                                                                            |
| `-d`           | 아니오      | 빌드 컨테이너를 Docker privileged 모드로 실행                                                                                                                                                       |

## 보안 스캐너

[`security-scanners.yml`](../.github/workflows/security-scanners.yml) 워크플로는 `main` 푸시, `main` 대상 PR, 그리고 일정에 따라 매일 6개의 스캐너를 실행합니다. 각 스캐너는 SARIF 리포트를 GitHub Code Scanning(**Security** 탭에서 확인 가능)과 다운로드 가능한 아티팩트로 업로드합니다.

ClamAV를 제외한 모든 스캐너는 **deferred-failure 패턴**을 사용합니다. 즉, 잡이 실패하더라도 스캔이 항상 끝까지 실행되어 결과를 업로드합니다. 이로써 빌드가 깨졌을 때도 검출 결과가 기록됩니다.

### Bandit — Python SAST

**탐지 대상:** Python 코드의 일반적인 보안 이슈 (예: `subprocess`, `eval`, 하드코딩된 패스워드, 약한 암호화).

**실패 트리거:** **high confidence**의 검출이 있을 경우 (모든 심각도). 정확한 필터는 [`.github/workflows/security-scanners.yml`](../.github/workflows/security-scanners.yml)의 Bandit 구성을 참고하세요.

**범위:** 저장소 내 추적되는 Python 파일을 대상으로 실행. 정확한 include/exclude 패턴은 [`.github/workflows/security-scanners.yml`](../.github/workflows/security-scanners.yml)을 확인하세요.

**검출 결과 검토:**

1. GitHub Security 탭의 **Code Scanning** 경고를 확인하거나 `bandit.sarif` 아티팩트 다운로드
2. 각 검출은 Bandit 규칙 ID(예: `B603`)와 위험 설명을 포함

**조치 방법:**

- **코드 수정** — 권장 방식. Bandit 문서는 각 규칙에 대한 안전한 대안을 제공합니다
- **인라인 억제** — 영향받는 라인에 `# nosec BXXX`(이유 포함) 추가:

  ```python
  subprocess.run(cmd, check=True)  # nosec B603 — cmd is built from validated config, not user input
  ```

- **경로 제외** — `.bandit`의 `exclude` 목록에 추가

### Semgrep — 다중 언어 SAST

**탐지 대상:** 전체 Semgrep Registry(`--config=r/all`)를 이용해 모든 언어의 보안 안티패턴, 위험한 API 사용, 코드 품질 이슈.

**실패 트리거:** 모든 검출. PR에서는 PR 베이스 커밋 대비 **신규** 검출만 실패를 트리거합니다 — 기존 항목은 `--baseline-commit`을 통해 무시됩니다.

**검출 결과 검토:**

1. **Code Scanning** 경고 확인 또는 `semgrep.sarif` 아티팩트 다운로드
2. 각 검출은 규칙 ID(예: `python.lang.security.dangerous-subprocess-use-audit`)와 문서 링크를 포함

**조치 방법:**

- **코드 수정** — Semgrep Registry 문서의 권장 수정 따르기
- **인라인 억제** — 영향받는 라인에 `# nosemgrep: <rule-id>` 추가:

  ```python
  time.sleep(5)  # nosemgrep: arbitrary-sleep — polling for server startup
  ```

  YAML 파일의 경우:

  ```yaml
  run: exit ${{ steps.scan.outputs.exit_code }}  # nosemgrep: yaml.github-actions.security.curl-eval.curl-eval
  ```

- **경로 제외** — `.semgrepignore`에 경로 추가 (참고: `changed-semgrepignore` 감사 규칙이 새 항목을 앱 보안 리뷰 대상으로 표시합니다)

### Grype — 의존성 취약점 스캔 (SCA)

**탐지 대상:** lock 파일, 매니페스트, 컨테이너 이미지를 스캔하여 의존성의 알려진 CVE.

**실패 트리거:** **high 또는 critical** 등급의 모든 취약점 (`.grype.yaml`의 `fail-on-severity: high`). low/medium은 보고되지만 빌드를 실패시키지 않습니다.

**검출 결과 검토:**

1. **Code Scanning** 경고 확인 또는 `grype.sarif` 아티팩트 다운로드
2. 각 검출은 CVE ID, 영향받는 패키지, 설치 버전, 수정된 버전(있는 경우)을 포함

**조치 방법:**

- **의존성 업그레이드** — 권장 방식. 패치된 버전이 존재하는지 확인하고 관련 `pyproject.toml` 또는 lock 파일을 업데이트
- **구성에서 억제** — `.grype.yaml`의 `ignore` 목록에 이유와 함께 추가:

  ```yaml
  ignore:
    - vulnerability: CVE-2024-12345
      reason: "only affects server-side XML parsing which we don't use"
  ```

  특정 패키지로 범위를 좁힐 수 있습니다:

  ```yaml
  ignore:
    - vulnerability: CVE-2024-12345
      package:
        name: "some-package"
        version: "1.2.3"
      reason: "pinned version; affected code path is unreachable"
  ```

> **참고:** Grype는 SCA 스캐너입니다 — 소스 라인이 아닌 의존성을 분석합니다. 억제를 위한 인라인 코드 주석은 없으며, 모든 수용된 위험은 `.grype.yaml`에 들어갑니다.

### Gitleaks — 시크릿 탐지

**탐지 대상:** git 히스토리 어디든 커밋된 시크릿(API 키, 토큰, 비밀번호, 개인 키).

**실패 트리거:** 베이스라인 파일(`.gitleaks-baseline.json`)에 없는 모든 시크릿.

**검출 결과 검토:**

1. `gitleaks.sarif` 아티팩트 다운로드
2. 각 검출은 시크릿 유형(예: `generic-api-key`, `jwt`), 파일, 커밋을 식별

**조치 방법:**

- **즉시 시크릿 회전(rotate)** — 검출된 모든 시크릿은 유출된 것으로 간주
- **히스토리에서 제거** — `git filter-repo` 또는 BFG Repo-Cleaner로 모든 커밋에서 제거
- **베이스라인 추가** — 알려진 false positive(예: 합성된 자격증명을 사용하는 테스트 픽스처)에만 사용. 베이스라인 재생성:

  ```bash
  gitleaks git --config=.gitleaks.toml --report-path=.gitleaks-baseline.json --report-format=json .
  ```

  커밋 전에 업데이트된 베이스라인을 신중히 검토하세요
- **경로 허용** — 의도적으로 시크릿 유사 패턴을 포함하는 파일(예: 테스트 자격증명 스크러버)에 대해 `.gitleaks.toml`의 `[allowlist] paths`에 정규식 추가

### Checkov — IaC 스캔

**탐지 대상:** GitHub Actions 워크플로와 Dockerfile의 잘못된 설정(예: 핀 고정되지 않은 액션, 누락된 보안 설정, 과도하게 넓은 권한).

**범위:** `github_actions`와 `dockerfile` 프레임워크만 스캔 (`.checkov.yaml`에서 설정).

**실패 트리거:** 모든 체크 실패. 단, `skip-check`에 나열된 체크 제외.

**검출 결과 검토:**

1. **Code Scanning** 경고 확인 또는 `checkov.sarif` 아티팩트 다운로드
2. 각 검출은 체크 ID(예: `CKV_GHA_7`, `CKV_DOCKER_2`)와 잘못된 설정에 대한 설명을 포함

**조치 방법:**

- **구성 수정** — 특정 체크 ID에 대한 Checkov 문서를 따름
- **인라인 억제** — 영향받는 라인 위 또는 같은 줄에 코멘트 추가:

  Dockerfile:

  ```dockerfile
  # checkov:skip=CKV_DOCKER_2:healthcheck not needed for build-only image
  FROM python:3.12-slim
  ```

  GitHub Actions 워크플로:

  ```yaml
  # checkov:skip=CKV_GHA_7:buildspec-override requires user parameters
  - uses: aws-actions/aws-codebuild-run-build@v1
  ```

  한 줄에 다중 skip:

  ```yaml
  # checkov:skip=CKV_DOCKER_2,CKV_DOCKER_3:reason for both
  ```

- **저장소 전체 skip** — 체크 ID를 `.checkov.yaml`의 `skip-check` 목록에 이유 주석과 함께 추가

### ClamAV — 멀웨어 스캔

**탐지 대상:** ClamAV 시그니처 데이터베이스를 이용한 저장소 파일 내 멀웨어, 바이러스, 트로이목마.

**실패 트리거:** 멀웨어 탐지가 한 건이라도 있으면 실패 (이진 pass/fail).

**검출 결과 검토:**

1. `clamdscan.txt` 아티팩트 다운로드 — 감염 파일 경로를 포함한 전체 스캔 로그를 포함

> **참고:** ClamAV는 SARIF 출력을 생성하지 않으며 GitHub Code Scanning과 통합되지 않습니다. 결과는 텍스트 로그 아티팩트로만 제공됩니다.

**조치 방법:**

- **감염 파일 제거** 및 어떻게 유입되었는지 조사
- **탐지 검증** — false positive는 드물지만 가능합니다. 알려진 FP DB와 ClamAV 시그니처 이름을 비교 확인

### 실패 기준 요약

| 스캐너     | 실패 조건                          | 심각도 필터              | 설정 파일                                   |
| -------- | -------------------------------- | --------------------- | ------------------------------------------- |
| Bandit   | high confidence 검출이 한 건이라도 | 모든 심각도              | `.bandit`                                   |
| Semgrep  | 모든 검출 (PR은 신규만)             | 모든 심각도              | `.semgrepignore`                            |
| Grype    | high 또는 critical CVE             | low/medium은 실패 아님   | `.grype.yaml`                               |
| Gitleaks | 베이스라인에 없는 시크릿              | 전체                    | `.gitleaks.toml`, `.gitleaks-baseline.json` |
| Checkov  | 모든 체크 실패                       | 전체 (skip 제외)         | `.checkov.yaml`                             |
| ClamAV   | 모든 멀웨어 탐지                     | 이진 pass/fail           | 없음                                        |

### 억제 방법 요약

| 스캐너     | 인라인 주석                  | 설정 수준                       | 베이스라인/디퍼렌셜          |
| -------- | --------------------------- | ----------------------------- | --------------------------- |
| Bandit   | `# nosec BXXX`              | `.bandit` `exclude`           | —                           |
| Semgrep  | `# nosemgrep: rule-id`      | `.semgrepignore`              | PR에서 `--baseline-commit`   |
| Grype    | _(해당 없음 — SCA)_           | `.grype.yaml` `ignore`        | —                           |
| Gitleaks | —                           | `.gitleaks.toml` `allowlist`  | `.gitleaks-baseline.json`   |
| Checkov  | `# checkov:skip=ID:reason`  | `.checkov.yaml` `skip-check`  | —                           |
| ClamAV   | —                           | —                             | —                           |

## GitHub Actions 로컬 실행

_참고: 이 방식은 [`act`](https://github.com/nektos/act) 도구를 사용하며, `us-east-1`의 유효한 AWS CodeBuild 프로젝트 `codebuild-project`에 접근 가능하다고 가정합니다._

```shell
act --platform ubuntu-latest=-self-hosted \
    --job build \
    --workflows .github/workflows/codebuild.yml \
    --env-file .env \
    --var CODEBUILD_PROJECT_NAME=codebuild-project \
    --var AWS_REGION=us-east-1 \
    --var ROLE_DURATION_SECONDS=7200 \
    --artifact-server-path=$PWD/.codebuild/artifacts \
    --cache-server-path=$PWD/.codebuild/artifacts \
    --env ACT_CODEBUILD_DIR=$PWD/.codebuild/downloads \
    --bind
```
