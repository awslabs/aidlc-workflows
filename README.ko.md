# AI-DLC (AI 주도 개발 생명주기)

> [!IMPORTANT]
> 생성형 AI는 실수를 할 수 있습니다. 사용 중인 AI 모델과 에이전트형 코딩 어시스턴트가 생성한 모든 출력과 비용을 검토하시기 바랍니다. [AWS 책임 있는 AI 정책](https://aws.amazon.com/ai/responsible-ai/policy/)을 참고하세요.

<!-- TODO: Replace this Amplify URL with a permanent/stable URL when available -->
AI-DLC는 사용자의 요구에 맞춰 적응하고 품질 표준을 유지하며, 사용자가 프로세스를 통제할 수 있게 하는 지능형 소프트웨어 개발 워크플로입니다. AI-DLC 방법론에 대한 자세한 내용은 [블로그](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)와 거기 인용된 [Method Definition Paper](https://prod.d13rzhkk8cj2z0.amplifyapp.com/)를 참고하세요.

## 목차

- [공통](#공통)
- [플랫폼별 설정](#플랫폼별-설정)
- [사용법](#사용법)
- [3단계 적응형 워크플로](#3단계-적응형-워크플로)
- [핵심 기능](#핵심-기능)
- [확장(Extensions)](#확장extensions)
- [부속 도구](#부속-도구)
- [핵심 원칙(Tenets)](#핵심-원칙tenets)
- [사전 요구사항](#사전-요구사항)
- [문제 해결](#문제-해결)
- [버전 관리 권장사항](#버전-관리-권장사항)
- [추가 리소스](#추가-리소스)
- [생성되는 aidlc-docs/ 레퍼런스](#생성되는-aidlc-docs-레퍼런스)
- [실험적: AI 지원 셋업 (릴리스 다운로드)](#실험적-ai-지원-셋업-릴리스-다운로드)
- [기여하기](#기여하기)
- [라이선스](#라이선스)

---

## 공통

1. [Releases 페이지](../../releases/latest)에서 최신 릴리스 zip 파일 `ai-dlc-rules-v<release-number>.zip`을 프로젝트 디렉터리 **밖**의 위치(예: `~/Downloads`)로 다운로드합니다.
2. zip을 압축 해제합니다. `aidlc-rules/` 폴더 안에 두 개의 하위 디렉터리가 있습니다.
   - `aws-aidlc-rules/` — 핵심 AI-DLC 워크플로 규칙
   - `aws-aidlc-rule-details/` — 핵심 규칙이 조건부로 참조하는 상세 규칙
3. 사용하는 코딩 에이전트와 플랫폼에 맞는 설정을 아래에서 따라 진행합니다.

---

## 플랫폼별 설정

- [Kiro](#kiro)
- [Amazon Q Developer IDE 플러그인](#amazon-q-developer-ide-플러그인확장)
- [Cursor IDE](#cursor-ide)
- [Cline](#cline)
- [Claude Code](#claude-code)
- [GitHub Copilot](#github-copilot)

---

### Kiro

AI-DLC는 프로젝트 작업 공간 내 [Kiro Steering Files](https://kiro.dev/docs/cli/steering/)를 사용합니다.

아래 명령은 zip을 `Downloads` 폴더에 압축 해제했다고 가정합니다. 다른 위치를 사용했다면 `Downloads`를 실제 폴더 경로로 바꾸세요.

macOS/Linux:

```bash
mkdir -p .kiro/steering
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rules .kiro/steering/
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details .kiro/
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force -Path ".kiro\steering"
Copy-Item -Recurse "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules" ".kiro\steering\"
Copy-Item -Recurse "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details" ".kiro\"
```

Windows (CMD):

```cmd
mkdir .kiro\steering
xcopy %USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules .kiro\steering\aws-aidlc-rules\ /E /I
xcopy %USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details .kiro\aws-aidlc-rule-details\ /E /I
```

프로젝트 구조는 다음과 같이 되어야 합니다.

```text
<project-root>/
    ├── .kiro/
    │     ├── steering/
    │     │      ├── aws-aidlc-rules/
    │     ├── aws-aidlc-rule-details/
```

규칙이 로드되었는지 확인하려면:

#### Kiro IDE에서 확인

steering files 패널을 열어 아래 스크린샷처럼 `Workspace` 아래에 `core-workflow` 항목이 보이는지 확인합니다.

<img src="./assets/images/kiro-ide-aidlc-rules-loaded.png?raw=true" alt="AI-DLC Rules in Kiro IDE" width="700" height="450">

AI-DLC 워크플로를 실행할 때는 Kiro IDE의 Vibe 모드를 사용합니다. 이 모드에서 AI-DLC 워크플로가 개발 흐름을 안내합니다. Kiro가 spec 모드로 전환을 권유할 때는 `No`를 선택해 Vibe 모드를 유지하세요.

<img src="./assets/images/kiro-sdd-nudge.png?raw=true" alt="Staying in Kiro Vibe mode" width="500" height="175">

#### Kiro CLI에서 확인

`kiro-cli`를 실행한 뒤 `/context show`를 입력하고 `.kiro/steering/aws-aidlc-rules` 항목이 보이는지 확인합니다.

<img src="./assets/images/kiro-cli-aidlc-rules-loaded.png?raw=true" alt="AI-DLC Rules in Kiro CLI" width="700" height="660">

---

### Amazon Q Developer IDE 플러그인/확장

AI-DLC는 프로젝트 작업 공간 내 [Amazon Q Rules](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/context-project-rules.html)를 사용합니다.

아래 명령은 zip을 `Downloads` 폴더에 압축 해제했다고 가정합니다. 다른 위치를 사용했다면 `Downloads`를 실제 폴더 경로로 바꾸세요.

macOS/Linux:

```bash
mkdir -p .amazonq/rules
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rules .amazonq/rules/
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details .amazonq/
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force -Path ".amazonq\rules"
Copy-Item -Recurse "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules" ".amazonq\rules\"
Copy-Item -Recurse "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details" ".amazonq\"
```

Windows (CMD):

```cmd
mkdir .amazonq\rules
xcopy %USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules .amazonq\rules\aws-aidlc-rules\ /E /I
xcopy %USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details .amazonq\aws-aidlc-rule-details\ /E /I
```

프로젝트 구조는 다음과 같이 되어야 합니다.

```text
<project-root>/
    ├── .amazonq/
    │     ├── rules/
    │     │     ├── aws-aidlc-rules/
    │     ├── aws-aidlc-rule-details/
```

규칙이 로드되었는지 확인하려면:

1. Amazon Q 채팅 창의 우측 하단에서 `Rules` 버튼을 클릭합니다.
2. `.amazonq/rules/aws-aidlc-rules` 항목이 보이는지 확인합니다.

<img src="./assets/images/q-ide-aidlc-rules-loaded.png?raw=true" alt="AI-DLC Rules in Q Developer IDE plugin" width="700" height="400">

---

### Cursor IDE

AI-DLC는 지능형 워크플로 구현을 위해 [Cursor Rules](https://cursor.com/docs/context/rules)를 사용합니다.

아래 명령은 zip을 `Downloads` 폴더에 압축 해제했다고 가정합니다. 다른 위치를 사용했다면 `Downloads`를 실제 폴더 경로로 바꾸세요.

#### 옵션 1: 프로젝트 규칙 (권장)

**Unix/Linux/macOS:**

```bash
mkdir -p .cursor/rules

cat > .cursor/rules/ai-dlc-workflow.mdc << 'EOF'
---
description: "AI-DLC (AI-Driven Development Life Cycle) adaptive workflow for software development"
alwaysApply: true
---

EOF
cat ~/Downloads/aidlc-rules/aws-aidlc-rules/core-workflow.md >> .cursor/rules/ai-dlc-workflow.mdc

mkdir -p .aidlc-rule-details
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details/* .aidlc-rule-details/
```

**Windows PowerShell:**

```powershell
New-Item -ItemType Directory -Force -Path ".cursor\rules"

$frontmatter = @"
---
description: "AI-DLC (AI-Driven Development Life Cycle) adaptive workflow for software development"
alwaysApply: true
---

"@
$frontmatter | Out-File -FilePath ".cursor\rules\ai-dlc-workflow.mdc" -Encoding utf8

Get-Content "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" | Add-Content ".cursor\rules\ai-dlc-workflow.mdc"

New-Item -ItemType Directory -Force -Path ".aidlc-rule-details"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details\*" ".aidlc-rule-details\" -Recurse
```

**Windows CMD:**

```cmd
mkdir .cursor\rules

(
echo ---
echo description: "AI-DLC (AI-Driven Development Life Cycle) adaptive workflow for software development"
echo alwaysApply: true
echo ---
echo.
) > .cursor\rules\ai-dlc-workflow.mdc

type "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" >> .cursor\rules\ai-dlc-workflow.mdc

mkdir .aidlc-rule-details
xcopy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I
```

#### 옵션 2: AGENTS.md (간단한 대안)

**Unix/Linux/macOS:**

```bash
cp ~/Downloads/aidlc-rules/aws-aidlc-rules/core-workflow.md ./AGENTS.md
mkdir -p .aidlc-rule-details
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details/* .aidlc-rule-details/
```

**Windows PowerShell:**

```powershell
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".\AGENTS.md"
New-Item -ItemType Directory -Force -Path ".aidlc-rule-details"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details\*" ".aidlc-rule-details\" -Recurse
```

**Windows CMD:**

```cmd
copy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".\AGENTS.md"
mkdir .aidlc-rule-details
xcopy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I
```

**설치 확인:**

1. **Cursor Settings → Rules, Commands** 열기
2. **Project Rules** 아래에 `ai-dlc-workflow`가 나열되어야 합니다
3. `AGENTS.md`의 경우 자동으로 감지·적용됩니다

![AI-DLC Rules in Cursor](./assets/images/cursor-ide-aidlc-rules-loaded.png?raw=true "AI-DLC Rules in Cursor")

**디렉터리 구조 (옵션 1):**

```text
<my-project>/
├── .cursor/
│   └── rules/
│       └── ai-dlc-workflow.mdc
└── .aidlc-rule-details/
    ├── common/
    ├── inception/
    ├── construction/
    ├── extensions/
    └── operations/
```

---

### Cline

AI-DLC는 지능형 워크플로 구현을 위해 Cline Rules를 사용합니다.

아래 명령은 zip을 `Downloads` 폴더에 압축 해제했다고 가정합니다. 다른 위치를 사용했다면 `Downloads`를 실제 폴더 경로로 바꾸세요.

#### 옵션 1: .clinerules 디렉터리 (권장)

**Unix/Linux/macOS:**

```bash
mkdir -p .clinerules
cp ~/Downloads/aidlc-rules/aws-aidlc-rules/core-workflow.md .clinerules/
mkdir -p .aidlc-rule-details
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details/* .aidlc-rule-details/
```

**Windows PowerShell:**

```powershell
New-Item -ItemType Directory -Force -Path ".clinerules"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".clinerules\"
New-Item -ItemType Directory -Force -Path ".aidlc-rule-details"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details\*" ".aidlc-rule-details\" -Recurse
```

**Windows CMD:**

```cmd
mkdir .clinerules
copy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".clinerules\"
mkdir .aidlc-rule-details
xcopy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I
```

#### 옵션 2: AGENTS.md (대안)

**Unix/Linux/macOS:**

```bash
cp ~/Downloads/aidlc-rules/aws-aidlc-rules/core-workflow.md ./AGENTS.md
mkdir -p .aidlc-rule-details
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details/* .aidlc-rule-details/
```

**Windows PowerShell:**

```powershell
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".\AGENTS.md"
New-Item -ItemType Directory -Force -Path ".aidlc-rule-details"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details\*" ".aidlc-rule-details\" -Recurse
```

**Windows CMD:**

```cmd
copy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".\AGENTS.md"
mkdir .aidlc-rule-details
xcopy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I
```

**설치 확인:**

1. Cline 채팅 인터페이스에서 채팅 입력란 아래의 Rules popover를 확인합니다
2. `core-workflow.md`가 활성 상태로 나열되는지 확인합니다
3. 필요에 따라 popover UI에서 규칙 파일을 토글할 수 있습니다

![AI-DLC Rules in Cline](./assets/images/cline-ide-aidlc-rules-loaded.png?raw=true "AI-DLC Rules in Cline")

**디렉터리 구조 (옵션 1):**

```text
<my-project>/
├── .clinerules/
│   └── core-workflow.md
└── .aidlc-rule-details/
    ├── common/
    ├── inception/
    ├── construction/
    ├── extensions/
    └── operations/
```

---

### Claude Code

AI-DLC는 지능형 워크플로 구현을 위해 Claude Code의 프로젝트 메모리 파일(`CLAUDE.md`)을 사용합니다.

아래 명령은 zip을 `Downloads` 폴더에 압축 해제했다고 가정합니다. 다른 위치를 사용했다면 `Downloads`를 실제 폴더 경로로 바꾸세요.

#### 옵션 1: 프로젝트 루트 (권장)

**Unix/Linux/macOS:**

```bash
cp ~/Downloads/aidlc-rules/aws-aidlc-rules/core-workflow.md ./CLAUDE.md
mkdir -p .aidlc-rule-details
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details/* .aidlc-rule-details/
```

**Windows PowerShell:**

```powershell
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".\CLAUDE.md"
New-Item -ItemType Directory -Force -Path ".aidlc-rule-details"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details\*" ".aidlc-rule-details\" -Recurse
```

**Windows CMD:**

```cmd
copy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".\CLAUDE.md"
mkdir .aidlc-rule-details
xcopy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I
```

#### 옵션 2: .claude 디렉터리

**Unix/Linux/macOS:**

```bash
mkdir -p .claude
cp ~/Downloads/aidlc-rules/aws-aidlc-rules/core-workflow.md .claude/CLAUDE.md
mkdir -p .aidlc-rule-details
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details/* .aidlc-rule-details/
```

**Windows PowerShell:**

```powershell
New-Item -ItemType Directory -Force -Path ".claude"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".claude\CLAUDE.md"
New-Item -ItemType Directory -Force -Path ".aidlc-rule-details"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details\*" ".aidlc-rule-details\" -Recurse
```

**Windows CMD:**

```cmd
mkdir .claude
copy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".claude\CLAUDE.md"
mkdir .aidlc-rule-details
xcopy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I
```

**설치 확인:**

1. 프로젝트 디렉터리에서 Claude Code를 시작합니다 (CLI: `claude` 또는 VS Code 확장)
2. `/config` 명령으로 현재 구성을 확인합니다
3. Claude에게 물어봅니다: "What instructions are currently active in this project?"

**디렉터리 구조 (옵션 1):**

```text
<my-project>/
├── CLAUDE.md
└── .aidlc-rule-details/
    ├── common/
    ├── inception/
    ├── construction/
    ├── extensions/
    └── operations/
```

---

### GitHub Copilot

AI-DLC는 지능형 워크플로 구현을 위해 [GitHub Copilot custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)를 사용합니다. `.github/copilot-instructions.md` 파일은 자동으로 감지되어 작업 공간의 모든 채팅 요청에 적용됩니다.

아래 명령은 zip을 `Downloads` 폴더에 압축 해제했다고 가정합니다. 다른 위치를 사용했다면 `Downloads`를 실제 폴더 경로로 바꾸세요.

**Unix/Linux/macOS:**

```bash
mkdir -p .github
cp ~/Downloads/aidlc-rules/aws-aidlc-rules/core-workflow.md .github/copilot-instructions.md
mkdir -p .aidlc-rule-details
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details/* .aidlc-rule-details/
```

**Windows PowerShell:**

```powershell
New-Item -ItemType Directory -Force -Path ".github"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".github\copilot-instructions.md"
New-Item -ItemType Directory -Force -Path ".aidlc-rule-details"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details\*" ".aidlc-rule-details\" -Recurse
```

**Windows CMD:**

```cmd
mkdir .github
copy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".github\copilot-instructions.md"
mkdir .aidlc-rule-details
xcopy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I
```

**설치 확인:**

1. VS Code에서 프로젝트 폴더를 엽니다
2. Copilot Chat 패널을 엽니다 (Cmd/Ctrl+Shift+I)
3. **Configure Chat**(톱니바퀴 아이콘) > **Chat Instructions**에서 `copilot-instructions`가 나열되는지 확인합니다
4. 또는 채팅 입력란에 `/instructions`를 입력해 활성 지시문을 확인합니다

**디렉터리 구조:**

```text
<my-project>/
├── .github/
│   └── copilot-instructions.md
└── .aidlc-rule-details/
    ├── common/
    ├── inception/
    ├── construction/
    ├── extensions/
    └── operations/
```

---

### OpenAI Codex

AI-DLC는 [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md) 컨벤션을 사용해 OpenAI Codex를 지원합니다. Codex는 세션 시작 시 프로젝트 루트의 `AGENTS.md`를 자동 감지하고 로드합니다.

아래 명령은 zip을 `Downloads` 폴더에 압축 해제했다고 가정합니다. 다른 위치를 사용했다면 `Downloads`를 실제 폴더 경로로 바꾸세요.

**Unix/Linux/macOS:**

```bash
cp ~/Downloads/aidlc-rules/aws-aidlc-rules/core-workflow.md ./AGENTS.md
mkdir -p .aidlc-rule-details
cp -R ~/Downloads/aidlc-rules/aws-aidlc-rule-details/* .aidlc-rule-details/
```

**Windows PowerShell:**

```powershell
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".\AGENTS.md"
New-Item -ItemType Directory -Force -Path ".aidlc-rule-details"
Copy-Item "$env:USERPROFILE\Downloads\aidlc-rules\aws-aidlc-rule-details\*" ".aidlc-rule-details\" -Recurse
```

**Windows CMD:**

```cmd
copy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules\core-workflow.md" ".\AGENTS.md"
mkdir .aidlc-rule-details
xcopy "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I
```

**설치 확인:**

1. 프로젝트 디렉터리에서 Codex 세션 시작
2. Codex에 물어봅니다: 기존 프로젝트라면 "Using AIDLC analyze the project?", 새 프로젝트라면 "Using Aidlc what workflow do you see"
3. Codex가 AI-DLC의 3단계 워크플로(Inception → Construction → Operations)를 설명해야 합니다

> [!NOTE]
> `AGENTS.md` 파일은 기본 설정에서 Codex의 instruction budget에 들어맞도록 설계되었습니다. 프로젝트 고유 내용을 많이 추가했고 Codex가 프로젝트 문서가 instruction 한도를 초과한다고 보고하면, Codex 구성에서 한도를 늘릴 수 있습니다 (예: `config.toml`의 `project_doc_max_bytes` 조정):
>
> ```toml
> project_doc_max_bytes = 65536  # 예시 값; 프로젝트에 적절한 한도를 선택하세요
> ```

**디렉터리 구조:**

```text
<my-project>/
├── AGENTS.md
└── .aidlc-rule-details/
    ├── common/
    ├── inception/
    ├── construction/
    ├── extensions/
    └── operations/
```

---

### 기타 에이전트

AI-DLC는 프로젝트 수준 규칙 또는 steering 파일을 지원하는 모든 코딩 에이전트와 함께 동작합니다. 일반적인 접근:

1. 에이전트가 프로젝트 규칙을 읽는 위치(에이전트 문서 참고)에 `aws-aidlc-rules/`를 배치합니다.
2. 규칙이 참조할 수 있도록 동일 레벨에 `aws-aidlc-rule-details/`를 배치합니다.

규칙 파일 컨벤션이 없는 에이전트라면, 두 폴더를 프로젝트 루트에 두고 `aws-aidlc-rules/`를 에이전트의 규칙 디렉터리로 지정합니다.

---

## 사용법

1. 채팅에서 **"Using AI-DLC, ..."** 문구로 시작하여 소프트웨어 개발 의도를 밝히세요
2. AI-DLC 워크플로가 자동으로 활성화되어 안내를 시작합니다
3. AI-DLC가 묻는 구조화된 질문에 답합니다
4. AI가 생성하는 모든 계획을 신중하게 검토하고 감독·검증을 제공합니다
5. 실행 계획을 검토해 어느 단계가 실행될지 확인합니다
6. 산출물을 신중하게 검토하고 각 단계를 승인하여 통제를 유지합니다
7. 모든 산출물은 `aidlc-docs/` 디렉터리에 생성됩니다

---

## 3단계 적응형 워크플로

AI-DLC는 프로젝트 복잡도에 맞춰 적응하는 3단계 구조를 따릅니다.

### 🔵 INCEPTION (착수) 단계

**무엇을(WHAT)** 만들지, **왜(WHY)** 만들지 결정

- 요구사항 분석 및 검증
- 사용자 스토리 작성 (해당 시)
- 애플리케이션 설계와 병렬 개발을 위한 작업 단위(Unit of Work) 생성
- 리스크 평가 및 복잡도 평가

### 🟢 CONSTRUCTION (구축) 단계

**어떻게(HOW)** 만들지 결정

- 상세 컴포넌트 설계
- 코드 생성 및 구현
- 빌드 구성 및 테스트 전략
- 품질 보증 및 검증

### 🟡 OPERATIONS (운영) 단계

배포 및 모니터링 (향후)

- 배포 자동화 및 인프라
- 모니터링/관측성 셋업
- 운영 준비도 검증

---

## 핵심 기능

| 기능                       | 설명                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **적응형 지능**            | 사용자의 요청에 가치를 더하는 단계만 실행                                                                  |
| **컨텍스트 인지**           | 기존 코드베이스와 복잡도 요구를 분석                                                                       |
| **위험 기반**              | 복잡한 변경은 포괄적 처리, 단순한 변경은 효율적으로 유지                                                    |
| **질문 주도**              | 채팅이 아닌 파일 내 구조화된 다지선다 질문                                                                  |
| **항상 사용자 통제**         | 실행 계획 검토 및 각 단계 승인                                                                            |
| **확장 가능**              | 보안, 컴플라이언스, 조직 고유 규칙 등 커스텀 규칙을 핵심 워크플로 위에 계층화                              |

---

## 확장(Extensions)

AI-DLC는 핵심 워크플로 위에 추가 규칙을 얹을 수 있는 확장 시스템을 지원합니다. 확장은 `aws-aidlc-rule-details/extensions/` 아래에 카테고리별(예: `security/`, `testing/`)로 정리된 마크다운 파일입니다.

### 확장 동작 방식

각 확장은 동일 디렉터리에 두 파일로 구성됩니다.

- **규칙 파일**(예: `security-baseline.md`) — 확장의 규칙을 포함.
- **opt-in 파일**(예: `security-baseline.opt-in.md`) — Requirements Analysis 동안 사용자에게 제시되는 구조화된 다지선다 질문 포함.

워크플로 시작 시 AI-DLC가 `extensions/` 디렉터리를 스캔해 `*.opt-in.md` 파일만 로드합니다. Requirements Analysis 중 각 opt-in 프롬프트를 사용자에게 제시합니다. 사용자가 opt-in하면 대응되는 규칙 파일이 로드됩니다(명명 규칙: `.opt-in.md` 제거 후 `.md` 추가). opt-out하면 규칙 파일은 절대 로드되지 않습니다. `*.opt-in.md` 가 없는 확장은 항상 강제됩니다.

활성화된 확장 규칙은 차단 제약(blocking constraint)입니다 — 각 단계에서 모델이 컴플라이언스를 검증한 뒤 단계 진행을 허용합니다.

### 내장 확장

`extensions/` 디렉터리에는 다음이 포함됩니다 (시간에 따라 확장이 추가될 수 있음):

```text
aws-aidlc-rule-details/
└── extensions/
    ├── security/                      # 확장 카테고리
    │   └── baseline/
    │       ├── security-baseline.md          # 베이스라인 보안 규칙
    │       └── security-baseline.opt-in.md   # opt-in 프롬프트
    └── testing/                       # 확장 카테고리
        └── property-based/
            ├── property-based-testing.md          # 속성 기반 테스트 규칙
            └── property-based-testing.opt-in.md   # opt-in 프롬프트
```

> [!IMPORTANT]
> 보안 확장 규칙은 AI-DLC 워크플로 내에서 효과적인 보안 규칙을 구축하기 위한 방향성 레퍼런스로 제공됩니다. 각 조직은 운영 워크플로에 배포하기 전에 자체 보안 규칙을 구축·맞춤화·철저히 테스트해야 합니다.

### 직접 확장 추가

기존 카테고리를 확장하거나 완전히 새로운 카테고리를 만들 수 있습니다.

1. `extensions/` 아래에 디렉터리를 만듭니다 (예: `security/compliance/` 또는 `performance/baseline/`).
2. **규칙 파일**(예: `compliance.md`)을 추가합니다. `security-baseline.md`와 동일한 구조를 따릅니다.
   - 각 규칙은 `## Rule <PREFIX-NN>: <Title>` 형식의 헤딩으로 정의합니다. PREFIX는 짧은 카테고리 식별자, NN은 일련번호입니다 (예: `COMPLIANCE-01`, `COMPLIANCE-02`). 이 ID는 감사 로그와 컴플라이언스 요약에서 참조되므로 로드된 모든 확장에 걸쳐 고유해야 합니다.
   - 요구 사항을 기술하는 **Rule** 섹션을 포함합니다.
   - 모델이 평가해야 할 구체적 점검을 담은 **Verification** 섹션을 포함합니다.
3. 명명 규칙에 따라 일치하는 **opt-in 파일**을 추가합니다 (`<name>.opt-in.md`, 예: `compliance.opt-in.md`). 기대 형식은 `security-baseline.opt-in.md`를 참고하세요. 이 파일을 생략하면 확장은 사용자 opt-out 없이 항상 강제됩니다.
4. 규칙은 기본적으로 차단형이며, 검증 기준이 충족되지 않으면 해당 단계는 검출 사항이 해결될 때까지 진행할 수 없습니다.

---

## 부속 도구

`scripts/` 디렉터리에는 AI-DLC 워크플로를 보완하는 도구가 포함되어 있습니다.

### AIDLC Evaluator

**위치:** [`scripts/aidlc-evaluator/`](scripts/aidlc-evaluator/)

AI-DLC 워크플로 변경을 검증하기 위한 자동 테스트/리포팅 프레임워크입니다. 다음을 제공합니다.

- **골든 테스트 케이스** — 검증용 큐레이션된 베이스라인 테스트 케이스
- **실행 프레임워크** — 평가 파이프라인을 통한 테스트 케이스 실행 오케스트레이션
- **시맨틱 평가** — 출력의 정확성/완전성에 대한 AI 기반 평가
- **코드 평가** — 정적 분석 (린팅, 보안 스캔, 중복 탐지)
- **NFR 평가** — 비기능 요구사항 테스트 (토큰 사용량, 실행 시간, 모델 간 일관성)
- **CI/CD 통합** — PR 검증을 위한 자동 파이프라인

**빠른 시작:**

```bash
cd scripts/aidlc-evaluator
uv sync
uv run python run.py test
```

**문서:** [scripts/aidlc-evaluator/README.md](scripts/aidlc-evaluator/README.md) 참고

---

### AIDLC Design Reviewer

**위치:** [`scripts/aidlc-designreview/`](scripts/aidlc-designreview/)

⚠️ **실험적 기능** — AWS Bedrock의 Claude 모델을 통해 AIDLC 설계 산출물을 분석하는 AI 기반 디자인 리뷰 도구.

**기능:**

- **멀티 에이전트 리뷰** — 3개의 전문 AI 에이전트 (Critique, Alternatives, Gap Analysis)
- **품질 스코어링** — 가중 심각도 분석과 실행 가능한 권고
- **두 가지 배포 모드:**
  - **CLI 도구** — CI/CD 파이프라인용 온디맨드 리뷰
  - **Claude Code 훅** — 개발 중 실시간 리뷰 (실험적)

**설치 (CLI 도구):**

```bash
cd scripts/aidlc-designreview
uv sync --extra test
source .venv/bin/activate  # Linux/Mac
design-reviewer --aidlc-docs /path/to/aidlc-docs
```

**설치 (Claude Code 훅):**

```bash
# 작업 공간 루트에서
./scripts/aidlc-designreview/tool-install/install-linux.sh      # Linux
./scripts/aidlc-designreview/tool-install/install-mac.sh        # macOS
.\scripts\aidlc-designreview\tool-install\install-windows.ps1   # Windows PowerShell
```

설치 스크립트가 작업 공간 루트를 자동 감지하여 `.claude/`에 훅을 설치합니다.

**문서:**

- [scripts/aidlc-designreview/README.md](scripts/aidlc-designreview/README.md) — 메인 문서
- [scripts/aidlc-designreview/INSTALLATION.md](scripts/aidlc-designreview/INSTALLATION.md) — 훅 설치 가이드

---

## 핵심 원칙(Tenets)

다음은 의사결정의 지침이 되는 핵심 원칙입니다.

- **중복 금지(No duplication)**. 진실의 출처는 한 곳에 있습니다. 특정 파일이 필요한 새 도구/형식 지원을 추가하더라도 원본을 유지하면서 그로부터 생성하지, 별도 사본을 유지하지 않습니다.

- **방법론 우선(Methodology first)**. AI-DLC는 본질적으로 도구가 아닌 방법론입니다. 사용자가 시작하기 위해 무엇을 설치할 필요가 없어야 합니다. 다만, 사용자가 방법론을 채택·확장하는 데 도움이 된다면 편의 도구(스크립트, CLI)는 향후 열어둡니다.

- **재현 가능성(Reproducible)**. 규칙은 서로 다른 모델이 유사한 결과를 내도록 충분히 명확해야 합니다. 모델별 행동 차이를 인정하지만, 방법론은 명시적 지침으로 편차를 최소화해야 합니다.

- **중립성(Agnostic)**. 방법론은 어떤 IDE, 에이전트, 모델에도 종속되지 않고 작동합니다. 특정 도구/공급자에 묶이지 않습니다.

- **사용자 개입(Human in the loop)**. 결정적 결정에는 명시적인 사용자 확인이 필요합니다. 에이전트는 제안하고, 사람이 승인합니다.

---

## 사전 요구사항

지원되는 AI 어시스턴스 코딩 플랫폼/도구 중 하나가 설치되어 있어야 합니다.

| 플랫폼                          | 설치 링크                                                                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kiro                          | [설치](https://kiro.dev/)                                                                                                                                       |
| Kiro CLI                      | [설치](https://kiro.dev/cli/)                                                                                                                                   |
| Amazon Q Developer IDE Plugin | [설치](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-in-IDE.html)                                                                                  |
| Cursor IDE                    | [설치](https://cursor.com/)                                                                                                                                     |
| Cline VS Code Extension       | [설치](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev)                                                                              |
| Claude Code CLI               | [설치](https://github.com/anthropics/claude-code)                                                                                                               |
| GitHub Copilot                | [설치](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) + [Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat)    |

---

## 문제 해결

### 일반 이슈

| 문제                        | 해결책                                                  |
| ---------------------------- | ----------------------------------------------------------- |
| 규칙이 로드되지 않음           | 사용하는 플랫폼의 올바른 위치에 파일이 있는지 확인              |
| 파일 인코딩 이슈              | 파일이 UTF-8 인코딩인지 확인                                  |
| 세션에 규칙이 적용되지 않음     | 파일 변경 후 새 채팅 세션 시작                                 |
| 규칙 상세가 로드되지 않음      | `.aidlc-rule-details/` 와 하위 디렉터리 존재 확인              |

### 플랫폼별 이슈

#### Amazon Q Developer / Kiro

- `/context show`로 규칙 로드 확인
- `.amazonq/rules/` 또는 `.kiro/steering/` 디렉터리 구조 확인

#### Cursor

- "Apply Intelligently"를 사용하려면 frontmatter에 description 정의 필요
- **Cursor Settings → Rules**에서 규칙 활성화 여부 확인
- 규칙이 너무 큰 경우(>500줄) 초점이 명확한 여러 규칙으로 분할

#### Cline

- 채팅 입력란 아래 Rules popover 확인
- popover UI로 규칙 파일을 필요에 따라 토글

#### Claude Code

- `/config` 명령으로 현재 구성 확인
- "What instructions are currently active in this project?" 라고 질문

#### GitHub Copilot

- **Configure Chat**(톱니바퀴 아이콘) > **Chat Instructions**에서 지시문 로드 여부 확인
- 채팅 입력란에 `/instructions`를 입력해 활성 지시문 파일 확인
- 작업 공간 루트에 `.github/copilot-instructions.md`가 존재하는지 확인

### Windows의 파일 경로 이슈

- 마크다운 파일 내 경로는 슬래시 `/`를 사용
- 백슬래시가 포함된 Windows 경로는 정상 동작하지 않을 수 있음

---

## 버전 관리 권장사항

**저장소에 커밋:**

```gitignore
# 다음 파일들은 버전 관리 대상
CLAUDE.md
AGENTS.md
.amazonq/rules/
.amazonq/aws-aidlc-rule-details/
.kiro/steering/
.kiro/aws-aidlc-rule-details/
.cursor/rules/
.clinerules/
.github/copilot-instructions.md
.aidlc-rule-details/
```

**선택사항 - 필요 시 `.gitignore`에 추가:**

```gitignore
# 로컬 전용 설정
.claude/settings.local.json
```

---

## 생성되는 aidlc-docs/ 레퍼런스

AI-DLC 워크플로가 생성하는 모든 문서 산출물의 완전한 레퍼런스는 [docs/GENERATED_DOCS_REFERENCE.md](docs/GENERATED_DOCS_REFERENCE.md)를 참고하세요.

---

## 실험적: AI 지원 셋업 (릴리스 다운로드)

| 리소스                                              | 링크                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| AI-DLC Method Definition Paper                      | [Paper](https://prod.d13rzhkk8cj2z0.amplifyapp.com/)                                                                          |
| AI-DLC Methodology Blog                             | [AWS Blog](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)                                             |
| AI-DLC Open-source Launch Blog                      | [AWS Blog](https://aws.amazon.com/blogs/devops/open-sourcing-adaptive-workflows-for-ai-driven-development-life-cycle-ai-dlc/) |
| AI-DLC Example Walkthrough Blog                     | [AWS Blog](https://aws.amazon.com/blogs/devops/building-with-ai-dlc-using-amazon-q-developer/)                                |
| Amazon Q Developer Documentation                    | [Docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-in-IDE.html)                                                |
| Kiro CLI Documentation                              | [Docs](https://kiro.dev/docs/cli/steering/)                                                                                   |
| Cursor Rules Documentation                          | [Docs](https://cursor.com/docs/context/rules)                                                                                 |
| Claude Code Documentation                           | [GitHub](https://github.com/anthropics/claude-code)                                                                           |
| GitHub Copilot Documentation                        | [Docs](https://docs.github.com/en/copilot)                                                                                    |
| Working with AI-DLC (인터랙션 패턴과 팁)             | [docs/WORKING-WITH-AIDLC.md](docs/WORKING-WITH-AIDLC.md)                                                                      |
| 기여 가이드                                          | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                                            |
| 행동 강령                                            | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)                                                                                      |

---

## 추가 리소스

<!-- TODO: Replace this Amplify URL with a permanent/stable URL when available -->
| 리소스                                              | 링크                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| AI-DLC Method Definition Paper                      | [Paper](https://prod.d13rzhkk8cj2z0.amplifyapp.com/)                                                                          |
| AI-DLC Methodology Blog                             | [AWS Blog](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)                                             |
| AI-DLC Open-source Launch Blog                      | [AWS Blog](https://aws.amazon.com/blogs/devops/open-sourcing-adaptive-workflows-for-ai-driven-development-life-cycle-ai-dlc/) |
| AI-DLC Example Walkthrough Blog                     | [AWS Blog](https://aws.amazon.com/blogs/devops/building-with-ai-dlc-using-amazon-q-developer/)                                |
| Amazon Q Developer Documentation                    | [Docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-in-IDE.html)                                                |
| Kiro CLI Documentation                              | [Docs](https://kiro.dev/docs/cli/steering/)                                                                                   |
| Cursor Rules Documentation                          | [Docs](https://cursor.com/docs/context/rules)                                                                                 |
| Claude Code Documentation                           | [GitHub](https://github.com/anthropics/claude-code)                                                                           |
| GitHub Copilot Documentation                        | [Docs](https://docs.github.com/en/copilot)                                                                                    |
| Working with AI-DLC (인터랙션 패턴과 팁)             | [docs/WORKING-WITH-AIDLC.md](docs/WORKING-WITH-AIDLC.md)                                                                      |
| 기여 가이드                                          | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                                            |
| 행동 강령                                            | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)                                                                                      |

---

## 기여하기

자세한 내용은 [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications)를 참고하세요.

## 라이선스

이 라이브러리는 MIT-0 라이선스를 따릅니다. [LICENSE](LICENSE) 파일을 참고하세요.
