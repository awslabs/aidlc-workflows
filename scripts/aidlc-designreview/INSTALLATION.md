# AIDLC Design Review Hook - Installation Guide

⚠️ **EXPERIMENTAL FEATURE**: The Claude Code hook integration is currently in **experimental status**. While functional, it may have limitations and edge cases that have not been fully tested in all production environments. Please use with caution and report any issues you encounter.

Cross-platform installation tool for the AIDLC Design Review Hook.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [Installing Into Existing AIDLC Project](#installing-into-existing-aidlc-project)
  - [macOS](#macos)
  - [Linux](#linux)
  - [Windows PowerShell](#windows-powershell)
  - [Windows Git Bash/WSL](#windows-git-bashwsl)
- [Configuration](#configuration)
- [Validation](#validation)
- [Updating](#updating)
- [Uninstallation](#uninstallation)
- [Troubleshooting](#troubleshooting)

---

## Overview

The AIDLC Design Review Hook is a pre-tool-use hook for Claude Code that automatically reviews design artifacts before code generation. This installation tool sets up the hook in your workspace.

**Features:**

- ✅ Cross-platform support (macOS, Linux, Windows)
- ✅ Fresh installation and update support
- ✅ Automatic backup of existing installations
- ✅ Interactive configuration prompts
- ✅ Dependency checking with helpful instructions
- ✅ Installation validation tests
- ✅ Multi-agent design review (critique + alternatives + gaps)

---

## Prerequisites

### Required

**All Platforms:**

- Bash 4.0 or higher

**Windows:**

- Git Bash (recommended) OR WSL (Windows Subsystem for Linux)
- Download Git Bash: <https://git-scm.com/download/win>

### Optional (for full functionality)

**Configuration Parsing:**

- `yq` v4+ (preferred): <https://github.com/mikefarah/yq#install>
- Python 3 with PyYAML (fallback): `pip install pyyaml`
- If neither available, hook uses hardcoded defaults (still functional)

**Installation Commands:**

**macOS:**

```bash
brew install yq
brew install python3
pip3 install pyyaml
```

**Linux (Ubuntu/Debian):**

```bash
sudo wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64
sudo chmod +x /usr/local/bin/yq
sudo apt-get install python3 python3-pip
pip3 install pyyaml
```

**Windows:**

- Download yq from: <https://github.com/mikefarah/yq/releases>
- Install Python: <https://www.python.org/downloads/>
- Install PyYAML: `pip install pyyaml`

---

## Installation

### Installing Into Existing AIDLC Project

If you already have an AIDLC project and want to add the design review hook capability:

#### Step 1: Obtain the Hook Source Files

You have two options:

**Option A: Clone the design-reviewer repository** (recommended if you want updates):

```bash
# Clone to a temporary location
git clone <design-reviewer-repo-url> /tmp/design-reviewer

# Navigate to your AIDLC project
cd /path/to/your/aidlc-project

# Copy the tool-install directory
cp -r /tmp/design-reviewer/tool-install ./

# Optional: Clean up
rm -rf /tmp/design-reviewer
```

**Option B: Download just the tool-install directory** (if you only need the hook files):

- Download the `tool-install/` directory from the design-reviewer repository
- Place it in the root of your AIDLC project

#### Step 2: Verify Your AIDLC Project Structure

Ensure your project has the standard AIDLC structure:

```text
your-aidlc-project/
├── aidlc-docs/
│   ├── construction/
│   │   └── unit-*/
│   └── audit.md
└── tool-install/        # Just added
```

#### Step 3: Run the Installer

From your AIDLC project root:

**macOS:**

```bash
./tool-install/install-mac.sh
```

**Linux:**

```bash
./tool-install/install-linux.sh
```

**Windows PowerShell:**

```powershell
.\tool-install\install-windows.ps1
```

**Windows Git Bash/WSL:**

```bash
./tool-install/install-windows.sh
```

#### Step 4: Configure for Your Project

After installation, edit `.claude/review-config.yaml` to match your project structure:

```yaml
# Hook behavior
enabled: true
dry_run: false  # Set to true for testing without blocking

# Review depth
review:
  threshold: 3  # Adjust based on your needs (1-4)
  enable_alternatives: true
  enable_gap_analysis: true

# Reporting - verify these paths exist in your project
reports:
  output_dir: reports/design_review  # Create if doesn't exist

# Logging - verify this path exists
logging:
  audit_file: aidlc-docs/audit.md  # Must match your AIDLC structure
  level: info
```

#### Step 5: Create Required Directories

```bash
# Create report directory if it doesn't exist
mkdir -p reports/design_review

# Verify audit file exists
ls -la aidlc-docs/audit.md
```

#### Step 6: Test the Installation

```bash
# Test with mock AI (no AWS credentials needed)
TEST_MODE=1 .claude/hooks/pre-tool-use

# Verify report was generated
ls -la reports/design_review/
```

#### Step 7: Integration Testing

1. **Enable in your Claude Code workflow:**
   - The hook will now automatically run during Claude Code operations
   - Look for design review prompts during code generation stages

2. **Test with real AI** (requires AWS Bedrock access):

   ```bash
   USE_REAL_AI=1 TEST_MODE=1 .claude/hooks/pre-tool-use
   ```

3. **Monitor the first few runs:**
   - Check `aidlc-docs/audit.md` for logged reviews
   - Review generated reports in `reports/design_review/`
   - Adjust threshold and enabled agents in config as needed

#### Troubleshooting Existing Project Installation

**Issue: "aidlc-docs not found"**

- Ensure you're running the installer from the AIDLC project root
- Verify `aidlc-docs/` directory exists with proper structure

**Issue: Hook doesn't detect design artifacts**

- Verify construction units exist: `ls aidlc-docs/construction/unit-*/`
- Check that design markdown files exist in unit subdirectories
- Ensure filenames match expected patterns (see config)

**Issue: Audit logging fails**

- Create audit file if missing: `touch aidlc-docs/audit.md`
- Verify write permissions: `ls -la aidlc-docs/audit.md`
- Check `logging.audit_file` path in `.claude/review-config.yaml`

---

### macOS

1. **Navigate to workspace root:**

   ```bash
   cd /path/to/your/workspace
   ```

2. **Run installer:**

   ```bash
   ./tool-install/install-mac.sh
   ```

3. **Follow prompts:**
   - Enable design review hook? (yes/no) [yes]
   - Enable dry-run mode? (yes/no) [no]
   - Review threshold (1-4) [3]
   - Enable alternative approaches analysis? (yes/no) [yes]
   - Enable gap analysis? (yes/no) [yes]

4. **Verify installation:**

   ```bash
   TEST_MODE=1 .claude/hooks/pre-tool-use
   ```

### Linux

1. **Navigate to workspace root:**

   ```bash
   cd /path/to/your/workspace
   ```

2. **Run installer:**

   ```bash
   ./tool-install/install-linux.sh
   ```

3. **Follow prompts** (same as macOS)

4. **Verify installation:**

   ```bash
   TEST_MODE=1 .claude/hooks/pre-tool-use
   ```

### Windows PowerShell

1. **Open PowerShell as Administrator**

2. **Navigate to workspace root:**

   ```powershell
   cd C:\path\to\your\workspace
   ```

3. **Enable script execution (if needed):**

   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```

4. **Run installer:**

   ```powershell
   .\tool-install\install-windows.ps1
   ```

5. **Follow prompts** (same as macOS)

6. **Verify installation (Git Bash):**

   ```bash
   TEST_MODE=1 ./.claude/hooks/pre-tool-use
   ```

### Windows Git Bash/WSL

1. **Open Git Bash or WSL terminal**

2. **Navigate to workspace root:**

   ```bash
   cd /c/path/to/your/workspace  # Git Bash
   # OR
   cd /mnt/c/path/to/your/workspace  # WSL
   ```

3. **Run installer:**

   ```bash
   ./tool-install/install-windows.sh
   ```

4. **Follow prompts** (same as macOS)

5. **Verify installation:**

   ```bash
   TEST_MODE=1 .claude/hooks/pre-tool-use
   ```

---

## Configuration

After installation, the hook is configured via `.claude/review-config.yaml`.

### Configuration Options

```yaml
# Hook behavior
enabled: true                    # Enable/disable hook
dry_run: false                   # Dry run mode (reports only, no blocking)

# Review depth
review:
  threshold: 3                   # 1=Low, 2=Medium, 3=High, 4=Critical
  enable_alternatives: true      # Alternative approaches analysis
  enable_gap_analysis: true      # Gap analysis

# Reporting
reports:
  output_dir: reports/design_review
  format: markdown

# Performance
performance:
  batch_size: 20                 # Max files per batch
  batch_max_size: 25             # Max batch size (KB)

# Logging
logging:
  audit_file: aidlc-docs/audit.md
  level: info
```

### Review Modes

**Comprehensive Mode (Default):**

- All 3 agents enabled (critique + alternatives + gaps)
- Execution time: ~2-3 minutes with real AI
- Recommended for: Production, critical features

**Fast Mode (Opt-Out):**

```yaml
review:
  enable_alternatives: false
  enable_gap_analysis: false
```

- Critique agent only
- Execution time: ~20 seconds with real AI
- Recommended for: Development, rapid iteration

### Editing Configuration

**macOS/Linux:**

```bash
nano .claude/review-config.yaml
# OR
vim .claude/review-config.yaml
```

**Windows:**

```powershell
notepad .claude\review-config.yaml
```

---

## Validation

The installer automatically runs validation tests. To manually validate:

### Check File Integrity

**macOS/Linux:**

```bash
ls -R .claude/
```

**Windows:**

```powershell
Get-ChildItem -Recurse .claude\
```

**Expected structure:**

```text
.claude/
├── hooks/
│   └── pre-tool-use
├── lib/
│   ├── audit-logger.sh
│   ├── config-defaults.sh
│   ├── config-parser.sh
│   ├── logger.sh
│   ├── report-generator.sh
│   ├── review-executor.sh
│   └── user-interaction.sh
├── templates/
│   └── design-review-report.md
├── review-config.yaml
└── review-config.yaml.example
```

### Run Test Review

**All Platforms:**

```bash
TEST_MODE=1 .claude/hooks/pre-tool-use
```

This will:

- Generate a test report in `reports/design_review/`
- Not block or prompt user
- Validate end-to-end functionality

---

## Updating

To update an existing installation:

1. **Back up your configuration (optional):**

   ```bash
   cp .claude/review-config.yaml .claude/review-config.yaml.backup
   ```

2. **Run installer again:**

   ```bash
   # macOS
   ./tool-install/install-mac.sh

   # Linux
   ./tool-install/install-linux.sh

   # Windows PowerShell
   .\tool-install\install-windows.ps1

   # Windows Git Bash/WSL
   ./tool-install/install-windows.sh
   ```

   - The installer automatically detects existing installation
   - Creates timestamped backup: `.claude.backup.YYYYMMDD_HHMMSS`
   - Prompts for new configuration values

3. **Restore custom config (if needed):**

   ```bash
   cp .claude/review-config.yaml.backup .claude/review-config.yaml
   ```

### Automatic Backup

Installer creates backup before updating:

```text
.claude.backup.20260327_170500/
```

To restore from backup:

```bash
rm -rf .claude
mv .claude.backup.20260327_170500 .claude
```

---

## Uninstallation

To remove the AIDLC Design Review Hook:

**macOS/Linux:**

```bash
rm -rf .claude
rm -rf .claude.backup.*  # Optional: remove backups
```

**Windows PowerShell:**

```powershell
Remove-Item -Recurse -Force .claude
Remove-Item -Recurse -Force .claude.backup.*  # Optional
```

**Note:** This does NOT remove:

- Source files in `tool-install/`
- Generated reports in `reports/design_review/`
- Audit logs in `aidlc-docs/audit.md`

---

## Troubleshooting

### Common Issues

#### 1. "Bash 4.0 required" error

**macOS:**

```bash
# Check version
bash --version

# Upgrade via Homebrew
brew install bash

# Update shell
chsh -s /opt/homebrew/bin/bash  # Apple Silicon
# OR
chsh -s /usr/local/bin/bash     # Intel
```

**Linux:**

```bash
# Check version
bash --version

# Upgrade (Ubuntu/Debian)
sudo apt-get update
sudo apt-get install --only-upgrade bash
```

**Windows:**

- Update Git Bash to latest version
- Or use WSL with recent Ubuntu/Debian distribution

#### 2. "Permission denied" errors

**macOS/Linux:**

```bash
chmod +x tool-install/install-mac.sh         # macOS
chmod +x tool-install/install-linux.sh       # Linux
chmod +x tool-install/install-windows.sh     # Windows (Git Bash/WSL)
```

**Windows PowerShell:**

```powershell
# Run as Administrator
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

#### 3. Hook not executing

**Check hook permissions:**

```bash
ls -l .claude/hooks/pre-tool-use
# Should show: -rwxr-xr-x

# Fix if needed:
chmod +x .claude/hooks/pre-tool-use
```

**Check Claude Code hook configuration:**

- Hook should be automatically detected in `.claude/hooks/`
- No additional configuration required in Claude Code

#### 4. "Command not found: yq" warnings

This is **not an error**. The hook will use Python fallback or defaults.

**To suppress warnings:**

- Install yq: see [Prerequisites](#optional-for-full-functionality)
- OR install Python PyYAML: `pip install pyyaml`

#### 5. YAML parsing errors

**Validate YAML syntax:**

```bash
# With yq
yq eval . .claude/review-config.yaml

# With Python
python3 -c "import yaml; yaml.safe_load(open('.claude/review-config.yaml'))"
```

**Common issues:**

- Incorrect indentation (use spaces, not tabs)
- Missing quotes around string values with special characters
- Trailing commas (not allowed in YAML)

#### 6. Windows line ending issues (Git Bash)

**Symptoms:**

- "bad interpreter: /usr/bin/env: bash^M: no such file or directory"
- Scripts fail with syntax errors

**Fix:**

```bash
# Configure Git to use Unix line endings
git config --global core.autocrlf input

# Reinstall hook (automatically converts line endings)
./tool-install/install-windows.sh
```

#### 7. Report not generated

**Check report directory:**

```bash
ls -la reports/design_review/
```

**Check permissions:**

```bash
# Create directory if missing
mkdir -p reports/design_review

# Fix permissions
chmod 755 reports/design_review
```

**Check configuration:**

```yaml
reports:
  output_dir: reports/design_review  # Correct
  # NOT: /reports/design_review (leading slash)
```

---

## Advanced Configuration

### Environment Variables

**TEST_MODE**: Skip bypass detection and user prompts

```bash
TEST_MODE=1 .claude/hooks/pre-tool-use
```

**USE_REAL_AI**: Use real AWS Bedrock API instead of mock responses

```bash
USE_REAL_AI=1 .claude/hooks/pre-tool-use
```

**LOG_LEVEL**: Override logging level

```bash
LOG_LEVEL=debug .claude/hooks/pre-tool-use
```

### Custom Installation Path

To install to a different location, edit installer scripts before running:

```bash
# Edit installation path
TARGET_DIR="/path/to/custom/location"
```

---

## Support

For issues, questions, or contributions:

- **Documentation**: See `tool-install/README.md` for technical details
- **Source Files**: Located in `tool-install/` directory
- **Configuration Example**: `.claude/review-config.yaml.example`

---

## Version Information

**Version**: 1.0
**Release Date**: 2026-03-27
**License**: MIT License

**Installer Scripts:**

- `install-mac.sh` - macOS installer
- `install-linux.sh` - Linux installer (symlink to macOS version)
- `install-windows.ps1` - Windows PowerShell installer
- `install-windows.sh` - Windows Git Bash/WSL installer

**Source Location**: `tool-install/` directory

---

## What Gets Installed

The installer copies the following to `.claude/`:

1. **Hook Entry Point** (1 file):
   - `hooks/pre-tool-use` - Main hook script

2. **Library Modules** (7 files):
   - `lib/logger.sh` - Logging functions
   - `lib/config-defaults.sh` - Default configuration
   - `lib/config-parser.sh` - YAML parser with fallbacks
   - `lib/user-interaction.sh` - User prompts
   - `lib/review-executor.sh` - Artifact discovery and review
   - `lib/report-generator.sh` - Report parsing and formatting
   - `lib/audit-logger.sh` - Audit trail logging

3. **Templates** (1 file):
   - `templates/design-review-report.md` - Report template

4. **Configuration** (2 files):
   - `review-config.yaml` - Active configuration (generated)
   - `review-config.yaml.example` - Example configuration

**Total**: ~1,210 LOC (lines of code) in bash scripts

---

## License

Copyright (c) 2026 AIDLC Design Reviewer Contributors

Licensed under the MIT License. See LICENSE file for details.
