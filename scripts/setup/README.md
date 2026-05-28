# AI-DLC Automated Setup Scripts

One-command setup for AI-DLC rules across all supported coding agents.

## What These Scripts Do

1. **Download** the latest AI-DLC rules from GitHub releases (or use a local path if GitHub is blocked)
2. **Auto-detect** common locations where the rules might already be extracted
3. **Ask** which coding agent you want to configure
4. **Install** the rules in the correct directory structure for your chosen agent

## Quick Start

### macOS / Linux

```bash
# Navigate to your project root
cd /path/to/your/project

# Run the setup script (one of these):
bash <(curl -sL https://raw.githubusercontent.com/awslabs/aidlc-workflows/main/scripts/setup/setup.sh)

# Or if you have the repo cloned:
bash /path/to/aidlc-workflows/scripts/setup/setup.sh
```

### Windows (PowerShell)

```powershell
# Navigate to your project root
cd C:\path\to\your\project

# Run the setup script:
powershell -ExecutionPolicy Bypass -File C:\path\to\aidlc-workflows\scripts\setup\setup.ps1
```

### Windows (CMD)

```cmd
REM Navigate to your project root
cd C:\path\to\your\project

REM Run the setup script:
C:\path\to\aidlc-workflows\scripts\setup\setup.bat
```

## Supported Agents

| #   | Agent              | Rules Location                                      |
| --- | ------------------ | --------------------------------------------------- |
| 1   | Kiro               | `.kiro/steering/aws-aidlc-rules/`                   |
| 2   | Amazon Q Developer | `.amazonq/rules/aws-aidlc-rules/`                   |
| 3   | Cursor IDE         | `.cursor/rules/ai-dlc-workflow.mdc` or `AGENTS.md`  |
| 4   | Cline              | `.clinerules/core-workflow.md` or `AGENTS.md`       |
| 5   | Claude Code        | `CLAUDE.md` or `.claude/CLAUDE.md`                  |
| 6   | GitHub Copilot     | `.github/copilot-instructions.md`                   |
| 7   | OpenAI Codex       | `AGENTS.md`                                         |
| 8   | All agents         | Installs for all of the above                       |

## How It Works

```text
┌─────────────────────────────────────────────────────┐
│  Step 1: Obtain Rules                               │
│  ┌───────────────┐    ┌──────────────────────────┐  │
│  │ Try GitHub    │───▶│ Download & extract latest │  │
│  │ API download  │    │ release zip              │  │
│  └───────┬───────┘    └──────────────────────────┘  │
│          │ (if blocked)                             │
│          ▼                                          │
│  ┌───────────────┐    ┌──────────────────────────┐  │
│  │ Auto-detect   │───▶│ ~/Downloads/aidlc-rules  │  │
│  │ common paths  │    │ ~/Desktop/aidlc-rules    │  │
│  └───────┬───────┘    └──────────────────────────┘  │
│          │ (if not found)                           │
│          ▼                                          │
│  ┌───────────────────────────────────────────────┐  │
│  │ Ask user for path                             │  │
│  └───────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│  Step 2: Select Agent (interactive menu)            │
├─────────────────────────────────────────────────────┤
│  Step 3: Install rules to correct locations         │
└─────────────────────────────────────────────────────┘
```

## Offline / Air-Gapped Usage

If GitHub is not accessible from your network:

1. Download the release zip from another machine
2. Transfer it to your target machine and extract it
3. Run the setup script — it will ask for the local path to the `aidlc-rules` folder

## Requirements

### macOS / Linux

- `bash` (pre-installed)
- `curl` or `wget` (for GitHub download; optional if using local path)
- `unzip` (for extracting the release; optional if using local path)

### Windows (PowerShell)

- PowerShell 5.1+ (pre-installed on Windows 10+)
- Internet access (optional, for GitHub download)

### Windows (CMD)

- Windows 10+ (uses built-in `curl` and `powershell` for JSON parsing)
- Internet access (optional, for GitHub download)
