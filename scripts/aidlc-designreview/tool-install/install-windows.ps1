# AIDLC Design Review Hook - Windows PowerShell Installer
# Version: 1.0
# Copyright (c) 2026 AIDLC Design Reviewer Contributors
# Licensed under the MIT License

#Requires -Version 5.1

# Set error action preference
$ErrorActionPreference = "Stop"

# Installation paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceDir = $ScriptDir  # tool-install/ directory

# Find workspace root by walking up directory tree looking for markers
# Prioritizes .git and aidlc-rules over pyproject.toml for monorepo support
function Find-WorkspaceRoot {
    $CurrentDir = $ScriptDir
    $MaxDepth = 10
    $Depth = 0
    $FallbackDir = $null

    while ($CurrentDir -ne "" -and $Depth -lt $MaxDepth) {
        # Check for high-priority workspace markers (definitive)
        if ((Test-Path (Join-Path $CurrentDir ".git")) -or
            (Test-Path (Join-Path $CurrentDir "aidlc-rules"))) {
            return $CurrentDir
        }

        # Check for low-priority marker (remember but keep searching)
        if ((Test-Path (Join-Path $CurrentDir "pyproject.toml")) -and $FallbackDir -eq $null) {
            $FallbackDir = $CurrentDir
        }

        $ParentDir = Split-Path -Parent $CurrentDir
        if ($ParentDir -eq $CurrentDir -or $ParentDir -eq $null) {
            break  # Reached root
        }
        $CurrentDir = $ParentDir
        $Depth++
    }

    # Use fallback if we found pyproject.toml but no .git or aidlc-rules
    if ($FallbackDir -ne $null) {
        return $FallbackDir
    }

    # Final fallback to parent directory (backward compatibility)
    return Split-Path -Parent $ScriptDir
}

$WorkspaceDir = Find-WorkspaceRoot
$TargetDir = Join-Path $WorkspaceDir ".claude"

# Configuration variables (will be set by user prompts)
$ConfigEnabled = $true
$ConfigDryRun = $false
$ConfigReviewThreshold = 3
$ConfigEnableAlternatives = $true
$ConfigEnableGapAnalysis = $true

# ============================================================================
# Helper Functions
# ============================================================================

function Write-Header {
    Write-Host ""
    Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Blue
    Write-Host "║                                                                ║" -ForegroundColor Blue
    Write-Host "║       AIDLC Design Review Hook - Installation Tool            ║" -ForegroundColor Blue
    Write-Host "║                   Version 1.0                                  ║" -ForegroundColor Blue
    Write-Host "║                                                                ║" -ForegroundColor Blue
    Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Blue
    Write-Host ""
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-ErrorMsg {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Write-Warning-Msg {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Write-Info {
    param([string]$Message)
    Write-Host "ℹ $Message" -ForegroundColor Blue
}

# ============================================================================
# Dependency Checks
# ============================================================================

function Test-Dependencies {
    Write-Info "Checking dependencies..."
    Write-Host ""

    $allOk = $true

    # Check PowerShell version
    $psVersion = $PSVersionTable.PSVersion
    if ($psVersion.Major -lt 5) {
        Write-ErrorMsg "PowerShell 5.1 or higher required (found $psVersion)"
        $allOk = $false
    } else {
        Write-Success "PowerShell $psVersion - OK"
    }

    # Check for Git Bash (for running bash scripts)
    $gitBashPaths = @(
        "C:\Program Files\Git\bin\bash.exe",
        "C:\Program Files (x86)\Git\bin\bash.exe",
        "${env:ProgramFiles}\Git\bin\bash.exe",
        "${env:ProgramFiles(x86)}\Git\bin\bash.exe"
    )

    $gitBashFound = $false
    foreach ($path in $gitBashPaths) {
        if (Test-Path $path) {
            Write-Success "Git Bash found - $path"
            $gitBashFound = $true
            break
        }
    }

    if (-not $gitBashFound) {
        Write-Warning-Msg "Git Bash not found (required to run bash hook)"
        Write-Host "  Download from: https://git-scm.com/download/win"
        $allOk = $false
    }

    # Check for WSL (alternative to Git Bash)
    $wslInstalled = $false
    try {
        $wslCheck = wsl --status 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Success "WSL installed - OK"
            $wslInstalled = $true
        }
    } catch {
        Write-Warning-Msg "WSL not found (alternative to Git Bash)"
    }

    if (-not $gitBashFound -and -not $wslInstalled) {
        Write-ErrorMsg "Either Git Bash or WSL is required"
        $allOk = $false
    }

    # Check for yq (optional)
    try {
        $yqVersion = yq --version 2>&1
        Write-Success "yq installed - $yqVersion"
    } catch {
        Write-Warning-Msg "yq not found (optional - will use Python fallback)"
        Write-Host "  To install: https://github.com/mikefarah/yq#install"
    }

    # Check for Python 3 (optional)
    try {
        $pythonVersion = python --version 2>&1
        if ($pythonVersion -match "Python 3") {
            Write-Success "$pythonVersion - OK"

            # Check for PyYAML
            try {
                python -c "import yaml" 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Python PyYAML module - OK"
                } else {
                    Write-Warning-Msg "Python PyYAML not found (optional)"
                    Write-Host "  To install: pip install pyyaml"
                }
            } catch {
                Write-Warning-Msg "Python PyYAML not found (optional)"
            }
        } else {
            Write-Warning-Msg "Python 3 not found (optional)"
        }
    } catch {
        Write-Warning-Msg "Python not found (optional - will use defaults)"
    }

    Write-Host ""

    if (-not $allOk) {
        Write-ErrorMsg "Critical dependencies missing. Please install required software and try again."
        exit 1
    }

    Write-Success "Dependency check complete"
    Write-Host ""
}

# ============================================================================
# Installation Type Detection
# ============================================================================

function Get-InstallationType {
    if (Test-Path $TargetDir) {
        return "update"
    } else {
        return "fresh"
    }
}

# ============================================================================
# Backup Existing Installation
# ============================================================================

function Backup-Existing {
    if (Test-Path $TargetDir) {
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $backupDir = "$TargetDir.backup.$timestamp"

        Write-Info "Backing up existing installation to $(Split-Path -Leaf $backupDir)"
        Copy-Item -Recurse $TargetDir $backupDir
        Write-Success "Backup created"
        Write-Host ""
        return $backupDir
    }
    return $null
}

# ============================================================================
# Configuration Prompts
# ============================================================================

function Get-UserConfiguration {
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Blue
    Write-Host "  Configuration Setup" -ForegroundColor Blue
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Blue
    Write-Host ""

    # Enabled (default: true)
    $response = Read-Host "Enable design review hook? (yes/no) [yes]"
    $response = if ([string]::IsNullOrWhiteSpace($response)) { "yes" } else { $response }
    $script:ConfigEnabled = $response -match "^(yes|y|true)$"

    # Dry run (default: false)
    $response = Read-Host "Enable dry-run mode (no blocking, only reports)? (yes/no) [no]"
    $response = if ([string]::IsNullOrWhiteSpace($response)) { "no" } else { $response }
    $script:ConfigDryRun = $response -match "^(yes|y|true)$"

    # Review threshold (default: 3)
    $response = Read-Host "Review threshold (1=Low, 2=Medium, 3=High, 4=Critical) [3]"
    $script:ConfigReviewThreshold = if ([string]::IsNullOrWhiteSpace($response)) { 3 } else { [int]$response }

    # Enable alternatives (default: true)
    $response = Read-Host "Enable alternative approaches analysis? (yes/no) [yes]"
    $response = if ([string]::IsNullOrWhiteSpace($response)) { "yes" } else { $response }
    $script:ConfigEnableAlternatives = $response -match "^(yes|y|true)$"

    # Enable gap analysis (default: true)
    $response = Read-Host "Enable gap analysis? (yes/no) [yes]"
    $response = if ([string]::IsNullOrWhiteSpace($response)) { "yes" } else { $response }
    $script:ConfigEnableGapAnalysis = $response -match "^(yes|y|true)$"

    Write-Host ""
    Write-Success "Configuration captured"
    Write-Host ""
}

# ============================================================================
# Create Configuration File
# ============================================================================

function New-ConfigFile {
    $configFile = Join-Path $TargetDir "review-config.yaml"
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ" -AsUTC

    Write-Info "Creating configuration file: $configFile"

    $configContent = @"
# AIDLC Design Review Hook Configuration
# Generated: $timestamp

# Hook behavior
enabled: $($ConfigEnabled.ToString().ToLower())
dry_run: $($ConfigDryRun.ToString().ToLower())

# Review depth
review:
  # Severity threshold (1=Low, 2=Medium, 3=High, 4=Critical)
  threshold: $ConfigReviewThreshold

  # Enable alternative approaches analysis (default: true)
  enable_alternatives: $($ConfigEnableAlternatives.ToString().ToLower())

  # Enable gap analysis (default: true)
  enable_gap_analysis: $($ConfigEnableGapAnalysis.ToString().ToLower())

# Reporting
reports:
  # Directory for storing review reports (relative to workspace root)
  output_dir: reports/design_review

  # Report format (markdown or both)
  format: markdown

# Performance
performance:
  # Maximum files per batch (for large projects)
  batch_size: 20

  # Maximum total size per batch in KB
  batch_max_size: 25

# Logging
logging:
  # Audit trail file (relative to workspace root)
  audit_file: aidlc-docs/audit.md

  # Log level (debug, info, warn, error)
  level: info
"@

    Set-Content -Path $configFile -Value $configContent -Encoding UTF8
    Write-Success "Configuration file created"
    Write-Host ""
}

# ============================================================================
# Install Files
# ============================================================================

function Install-Files {
    Write-Info "Installing AIDLC Design Review Hook..."
    Write-Host ""

    # Create directory structure
    New-Item -ItemType Directory -Force -Path "$TargetDir\lib" | Out-Null
    New-Item -ItemType Directory -Force -Path "$TargetDir\hooks" | Out-Null
    New-Item -ItemType Directory -Force -Path "$TargetDir\templates" | Out-Null
    Write-Success "Created directory structure"

    # Copy library files
    Write-Info "Copying library files..."
    Copy-Item "$SourceDir\lib\*.sh" -Destination "$TargetDir\lib\" -Force
    Write-Success "Copied 6 library files"

    # Copy hook file
    Write-Info "Copying hook file..."
    Copy-Item "$SourceDir\hooks\pre-tool-use" -Destination "$TargetDir\hooks\" -Force
    Write-Success "Copied hook file"

    # Copy template
    Write-Info "Copying report template..."
    Copy-Item "$SourceDir\templates\design-review-report.md" -Destination "$TargetDir\templates\" -Force
    Write-Success "Copied report template"

    # Copy example config (keep for reference)
    Copy-Item "$SourceDir\review-config.yaml.example" -Destination "$TargetDir\" -Force
    Write-Success "Copied example configuration"

    Write-Host ""
    Write-Success "All files installed successfully"
    Write-Host ""
}

# ============================================================================
# Validation Test
# ============================================================================

function Test-Installation {
    Write-Info "Running installation validation test..."
    Write-Host ""

    $validationPassed = $true

    # Test 1: Check all required files exist
    Write-Info "Test 1: Checking file integrity..."
    $requiredFiles = @(
        "hooks\pre-tool-use",
        "lib\logger.sh",
        "lib\config-defaults.sh",
        "lib\config-parser.sh",
        "lib\user-interaction.sh",
        "lib\review-executor.sh",
        "lib\report-generator.sh",
        "lib\audit-logger.sh",
        "templates\design-review-report.md",
        "review-config.yaml"
    )

    $missingFiles = @()
    foreach ($file in $requiredFiles) {
        $fullPath = Join-Path $TargetDir $file
        if (-not (Test-Path $fullPath)) {
            $missingFiles += $file
        }
    }

    if ($missingFiles.Count -eq 0) {
        Write-Success "All required files present"
    } else {
        Write-ErrorMsg "Missing files: $($missingFiles -join ', ')"
        $validationPassed = $false
    }

    # Test 2: Check config file is valid YAML
    Write-Info "Test 2: Validating configuration file..."
    $configFile = Join-Path $TargetDir "review-config.yaml"

    try {
        if (Get-Command yq -ErrorAction SilentlyContinue) {
            yq eval . $configFile | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Configuration file is valid YAML"
            } else {
                Write-ErrorMsg "Configuration file has YAML syntax errors"
                $validationPassed = $false
            }
        } elseif (Get-Command python -ErrorAction SilentlyContinue) {
            python -c "import yaml; yaml.safe_load(open('$configFile'))" 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Configuration file is valid YAML"
            } else {
                Write-ErrorMsg "Configuration file has YAML syntax errors"
                $validationPassed = $false
            }
        } else {
            Write-Warning-Msg "Cannot validate YAML (yq or Python not available)"
        }
    } catch {
        Write-Warning-Msg "YAML validation skipped"
    }

    # Test 3: Check bash availability (Git Bash or WSL)
    Write-Info "Test 3: Checking bash availability..."
    $bashAvailable = $false

    # Check Git Bash
    $gitBashPaths = @(
        "C:\Program Files\Git\bin\bash.exe",
        "C:\Program Files (x86)\Git\bin\bash.exe"
    )

    foreach ($path in $gitBashPaths) {
        if (Test-Path $path) {
            Write-Success "Git Bash available - $path"
            $bashAvailable = $true
            break
        }
    }

    # Check WSL
    if (-not $bashAvailable) {
        try {
            wsl --status 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "WSL available"
                $bashAvailable = $true
            }
        } catch {}
    }

    if (-not $bashAvailable) {
        Write-ErrorMsg "No bash environment found (Git Bash or WSL required)"
        $validationPassed = $false
    }

    Write-Host ""

    if ($validationPassed) {
        Write-Success "✓ Installation validation passed"
    } else {
        Write-ErrorMsg "✗ Installation validation failed"
    }

    Write-Host ""
    return $validationPassed
}

# ============================================================================
# Post-Installation Instructions
# ============================================================================

function Show-Instructions {
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Blue
    Write-Host "  Installation Complete!" -ForegroundColor Blue
    Write-Host "═══════════════════════════════════════════════════════════════" -ForegroundColor Blue
    Write-Host ""

    Write-Success "AIDLC Design Review Hook is now installed"
    Write-Host ""

    Write-Host "Next Steps:" -ForegroundColor Blue
    Write-Host ""
    Write-Host "1. The hook is now active in this workspace"
    Write-Host "2. Design artifacts in aidlc-docs/construction/ will be reviewed automatically"
    Write-Host "3. Reports will be generated in reports/design_review/"
    Write-Host ""

    Write-Host "Configuration:" -ForegroundColor Blue
    Write-Host "  File: $TargetDir\review-config.yaml"
    Write-Host "  Edit this file to customize hook behavior"
    Write-Host ""

    Write-Host "Testing:" -ForegroundColor Blue
    Write-Host "  Git Bash: TEST_MODE=1 ./.claude/hooks/pre-tool-use"
    Write-Host "  WSL:      wsl TEST_MODE=1 ./.claude/hooks/pre-tool-use"
    Write-Host "  This will generate a test report without blocking"
    Write-Host ""

    Write-Host "Documentation:" -ForegroundColor Blue
    Write-Host "  Example config: $TargetDir\review-config.yaml.example"
    Write-Host "  Source files: $SourceDir\"
    Write-Host ""

    Write-Host "Installation successful!" -ForegroundColor Green
    Write-Host ""
}

# ============================================================================
# Main Installation Flow
# ============================================================================

function Main {
    Write-Header

    # Display detected workspace directory
    Write-Info "Detected workspace directory: $WorkspaceDir"
    Write-Info "Installation target: $TargetDir"
    Write-Host ""

    # Check if source files exist
    if (-not (Test-Path "$SourceDir\hooks\pre-tool-use")) {
        Write-ErrorMsg "Source files not found in: $SourceDir"
        Write-ErrorMsg "Please run this script from tool-install\ directory"
        Write-ErrorMsg "Example: .\tool-install\install-windows.ps1"
        exit 1
    }

    # Detect installation type
    $installType = Get-InstallationType

    if ($installType -eq "update") {
        Write-Info "Existing installation detected - will update"
        Write-Host ""
    } else {
        Write-Info "Fresh installation"
        Write-Host ""
    }

    # Check dependencies
    Test-Dependencies

    # Backup if updating
    $backupDir = $null
    if ($installType -eq "update") {
        $backupDir = Backup-Existing
    }

    # Prompt for configuration
    Get-UserConfiguration

    # Install files
    Install-Files

    # Create configuration file
    New-ConfigFile

    # Run validation
    if (-not (Test-Installation)) {
        Write-ErrorMsg "Installation validation failed"
        Write-Warning-Msg "Hook may not work correctly"
        Write-Host ""

        if ($backupDir) {
            $restore = Read-Host "Restore from backup? (yes/no)"
            if ($restore -match "^(yes|y)$") {
                Remove-Item -Recurse -Force $TargetDir
                Move-Item $backupDir $TargetDir
                Write-Success "Restored from backup"
            }
        }

        exit 1
    }

    # Show post-installation instructions
    Show-Instructions
}

# Run main installation
Main
