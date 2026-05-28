@echo off
REM =============================================================================
REM AI-DLC Setup Script (Windows CMD)
REM =============================================================================
REM Automates the platform-specific setup of AI-DLC rules for supported coding
REM agents. Downloads the latest release from GitHub or uses a local path if
REM GitHub is unreachable.
REM =============================================================================
REM Usage: setup.bat
REM =============================================================================

setlocal enabledelayedexpansion

set "REPO=awslabs/aidlc-workflows"
set "PROJECT_ROOT=%CD%"
set "AIDLC_RULES_PATH="
set "TMP_DIR="

echo.
echo   ================================================================
echo            AI-DLC Setup - Automated Installer (CMD)
echo   ================================================================
echo.
echo   [i] This script sets up AI-DLC rules for your coding agent.
echo   [i] Run this from your project root directory.
echo   [i] Project root: %PROJECT_ROOT%
echo.

REM --- Step 1: Obtain Rules ---
echo.
echo   === Step 1: Obtaining AI-DLC Rules ===
echo.
echo   [i] Attempting to download latest release from GitHub...

REM Check if curl is available (Windows 10+ has curl)
where curl >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [!] curl not found. Cannot download from GitHub.
    goto :get_local_path
)

REM Try to download - use PowerShell for JSON parsing since CMD can't do it
set "TMP_DIR=%TEMP%\aidlc-setup-%RANDOM%"
mkdir "%TMP_DIR%" 2>nul

REM Use PowerShell to get the download URL (available on all modern Windows)
where powershell >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   [!] PowerShell not found. Cannot parse GitHub API.
    echo   [!] Consider using setup.ps1 instead for a better experience.
    goto :get_local_path
)

echo   [i] Checking for latest release...
for /f "delims=" %%u in ('powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'https://api.github.com/repos/%REPO%/releases/latest' -TimeoutSec 10; $a = $r.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1; if ($a) { Write-Output $a.browser_download_url } } catch { }"') do set "DOWNLOAD_URL=%%u"

for /f "delims=" %%v in ('powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'https://api.github.com/repos/%REPO%/releases/latest' -TimeoutSec 10; Write-Output $r.tag_name } catch { }"') do set "VERSION=%%v"

if not defined DOWNLOAD_URL (
    echo   [!] Could not reach GitHub or find a release.
    goto :get_local_path
)

echo.
echo   [i] Found latest release: %VERSION%
set /p "DL_CHOICE=  Download from GitHub? [Y/n]: "
if not defined DL_CHOICE set "DL_CHOICE=Y"
if /i not "%DL_CHOICE:~0,1%"=="Y" goto :get_local_path

echo   [i] Downloading...
curl -sL -o "%TMP_DIR%\aidlc-rules.zip" "%DOWNLOAD_URL%"
if %ERRORLEVEL% neq 0 (
    echo   [x] Download failed.
    goto :get_local_path
)

echo   [i] Extracting...
powershell -NoProfile -Command "Expand-Archive -Path '%TMP_DIR%\aidlc-rules.zip' -DestinationPath '%TMP_DIR%' -Force"

REM Find the aidlc-rules directory
for /f "delims=" %%d in ('powershell -NoProfile -Command "$d = Get-ChildItem -Path '%TMP_DIR%' -Recurse -Directory -Filter 'aws-aidlc-rules' | Select-Object -First 1; if ($d) { Write-Output $d.Parent.FullName }"') do set "AIDLC_RULES_PATH=%%d"

if not defined AIDLC_RULES_PATH (
    echo   [x] Could not find aidlc-rules in the downloaded archive.
    echo   [!] Falling back to local path...
    goto :get_local_path
)

if not exist "%AIDLC_RULES_PATH%\aws-aidlc-rules" (
    echo   [x] Could not find aws-aidlc-rules in extracted content.
    goto :get_local_path
)

echo   [+] Downloaded and extracted successfully.
goto :select_agent

:get_local_path
echo.
echo   [i] Please provide the path to the extracted 'aidlc-rules' folder.
echo   [i] This folder should contain 'aws-aidlc-rules\' and 'aws-aidlc-rule-details\'.
echo.

REM Try common locations
if exist "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rules" (
    if exist "%USERPROFILE%\Downloads\aidlc-rules\aws-aidlc-rule-details" (
        echo   [i] Auto-detected: %USERPROFILE%\Downloads\aidlc-rules
        set /p "USE_DETECTED=  Use this path? [Y/n]: "
        if not defined USE_DETECTED set "USE_DETECTED=Y"
        if /i "!USE_DETECTED:~0,1!"=="Y" (
            set "AIDLC_RULES_PATH=%USERPROFILE%\Downloads\aidlc-rules"
            goto :select_agent
        )
    )
)

if exist "%USERPROFILE%\Desktop\aidlc-rules\aws-aidlc-rules" (
    if exist "%USERPROFILE%\Desktop\aidlc-rules\aws-aidlc-rule-details" (
        echo   [i] Auto-detected: %USERPROFILE%\Desktop\aidlc-rules
        set /p "USE_DETECTED=  Use this path? [Y/n]: "
        if not defined USE_DETECTED set "USE_DETECTED=Y"
        if /i "!USE_DETECTED:~0,1!"=="Y" (
            set "AIDLC_RULES_PATH=%USERPROFILE%\Desktop\aidlc-rules"
            goto :select_agent
        )
    )
)

:ask_path
set /p "USER_PATH=  Path to aidlc-rules folder: "
if not exist "%USER_PATH%\aws-aidlc-rules" (
    echo   [x] Invalid path. Expected to find 'aws-aidlc-rules\' and 'aws-aidlc-rule-details\' inside.
    set /p "RETRY=  Try again? [Y/n]: "
    if not defined RETRY set "RETRY=Y"
    if /i "!RETRY:~0,1!"=="Y" goto :ask_path
    echo   [x] Cannot proceed without valid aidlc-rules path.
    goto :end
)
set "AIDLC_RULES_PATH=%USER_PATH%"
echo   [+] Valid path confirmed.

:select_agent
echo.
echo   === Step 2: Select Your Coding Agent ===
echo.
echo   1) Kiro
echo   2) Amazon Q Developer
echo   3) Cursor IDE
echo   4) Cline
echo   5) Claude Code
echo   6) GitHub Copilot
echo   7) OpenAI Codex
echo   8) All agents
echo.
set /p "AGENT_CHOICE=  Select agent [1-8]: "

echo.
echo   === Step 3: Installing Rules ===

if "%AGENT_CHOICE%"=="1" goto :setup_kiro
if "%AGENT_CHOICE%"=="2" goto :setup_amazonq
if "%AGENT_CHOICE%"=="3" goto :setup_cursor
if "%AGENT_CHOICE%"=="4" goto :setup_cline
if "%AGENT_CHOICE%"=="5" goto :setup_claude
if "%AGENT_CHOICE%"=="6" goto :setup_copilot
if "%AGENT_CHOICE%"=="7" goto :setup_codex
if "%AGENT_CHOICE%"=="8" goto :setup_all
echo   [x] Invalid selection.
goto :select_agent

:setup_kiro
echo.
echo   [i] Setting up for Kiro...
mkdir ".kiro\steering" 2>nul
xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rules" ".kiro\steering\aws-aidlc-rules\" /E /I /Q /Y >nul
xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".kiro\aws-aidlc-rule-details\" /E /I /Q /Y >nul
echo   [+] Kiro setup complete.
echo       -^> .kiro\steering\aws-aidlc-rules\
echo       -^> .kiro\aws-aidlc-rule-details\
if "%AGENT_CHOICE%"=="8" goto :setup_amazonq
goto :done

:setup_amazonq
echo.
echo   [i] Setting up for Amazon Q Developer...
mkdir ".amazonq\rules" 2>nul
xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rules" ".amazonq\rules\aws-aidlc-rules\" /E /I /Q /Y >nul
xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".amazonq\aws-aidlc-rule-details\" /E /I /Q /Y >nul
echo   [+] Amazon Q Developer setup complete.
echo       -^> .amazonq\rules\aws-aidlc-rules\
echo       -^> .amazonq\aws-aidlc-rule-details\
if "%AGENT_CHOICE%"=="8" goto :setup_cursor
goto :done

:setup_cursor
echo.
echo   [i] Cursor IDE has two setup options:
echo       1) Project Rules (.cursor\rules\) - Recommended
echo       2) AGENTS.md (simple alternative)
set /p "CURSOR_OPT=  Select option [1/2]: "
if not defined CURSOR_OPT set "CURSOR_OPT=1"

if "%CURSOR_OPT%"=="2" (
    echo   [i] Setting up Cursor with AGENTS.md...
    copy "%AIDLC_RULES_PATH%\aws-aidlc-rules\core-workflow.md" "AGENTS.md" /Y >nul
    mkdir ".aidlc-rule-details" 2>nul
    xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I /Q /Y >nul
    echo   [+] Cursor setup complete (AGENTS.md^).
) else (
    echo   [i] Setting up Cursor with Project Rules...
    mkdir ".cursor\rules" 2>nul
    (
        echo ---
        echo description: "AI-DLC (AI-Driven Development Life Cycle) adaptive workflow for software development"
        echo alwaysApply: true
        echo ---
        echo.
    ) > ".cursor\rules\ai-dlc-workflow.mdc"
    type "%AIDLC_RULES_PATH%\aws-aidlc-rules\core-workflow.md" >> ".cursor\rules\ai-dlc-workflow.mdc"
    mkdir ".aidlc-rule-details" 2>nul
    xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I /Q /Y >nul
    echo   [+] Cursor setup complete (Project Rules^).
)
if "%AGENT_CHOICE%"=="8" goto :setup_cline
goto :done

:setup_cline
echo.
echo   [i] Cline has two setup options:
echo       1) .clinerules directory - Recommended
echo       2) AGENTS.md (simple alternative)
set /p "CLINE_OPT=  Select option [1/2]: "
if not defined CLINE_OPT set "CLINE_OPT=1"

if "%CLINE_OPT%"=="2" (
    echo   [i] Setting up Cline with AGENTS.md...
    copy "%AIDLC_RULES_PATH%\aws-aidlc-rules\core-workflow.md" "AGENTS.md" /Y >nul
    mkdir ".aidlc-rule-details" 2>nul
    xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I /Q /Y >nul
    echo   [+] Cline setup complete (AGENTS.md^).
) else (
    echo   [i] Setting up Cline with .clinerules...
    mkdir ".clinerules" 2>nul
    copy "%AIDLC_RULES_PATH%\aws-aidlc-rules\core-workflow.md" ".clinerules\" /Y >nul
    mkdir ".aidlc-rule-details" 2>nul
    xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I /Q /Y >nul
    echo   [+] Cline setup complete (.clinerules^).
)
if "%AGENT_CHOICE%"=="8" goto :setup_claude
goto :done

:setup_claude
echo.
echo   [i] Claude Code has two setup options:
echo       1) Project root CLAUDE.md - Recommended
echo       2) .claude\CLAUDE.md directory
set /p "CLAUDE_OPT=  Select option [1/2]: "
if not defined CLAUDE_OPT set "CLAUDE_OPT=1"

if "%CLAUDE_OPT%"=="2" (
    echo   [i] Setting up Claude Code with .claude\CLAUDE.md...
    mkdir ".claude" 2>nul
    copy "%AIDLC_RULES_PATH%\aws-aidlc-rules\core-workflow.md" ".claude\CLAUDE.md" /Y >nul
    mkdir ".aidlc-rule-details" 2>nul
    xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I /Q /Y >nul
    echo   [+] Claude Code setup complete (.claude\CLAUDE.md^).
) else (
    echo   [i] Setting up Claude Code with CLAUDE.md...
    copy "%AIDLC_RULES_PATH%\aws-aidlc-rules\core-workflow.md" "CLAUDE.md" /Y >nul
    mkdir ".aidlc-rule-details" 2>nul
    xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I /Q /Y >nul
    echo   [+] Claude Code setup complete (CLAUDE.md^).
)
if "%AGENT_CHOICE%"=="8" goto :setup_copilot
goto :done

:setup_copilot
echo.
echo   [i] Setting up for GitHub Copilot...
mkdir ".github" 2>nul
copy "%AIDLC_RULES_PATH%\aws-aidlc-rules\core-workflow.md" ".github\copilot-instructions.md" /Y >nul
mkdir ".aidlc-rule-details" 2>nul
xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I /Q /Y >nul
echo   [+] GitHub Copilot setup complete.
echo       -^> .github\copilot-instructions.md
echo       -^> .aidlc-rule-details\
if "%AGENT_CHOICE%"=="8" goto :setup_codex
goto :done

:setup_codex
echo.
echo   [i] Setting up for OpenAI Codex...
copy "%AIDLC_RULES_PATH%\aws-aidlc-rules\core-workflow.md" "AGENTS.md" /Y >nul
mkdir ".aidlc-rule-details" 2>nul
xcopy "%AIDLC_RULES_PATH%\aws-aidlc-rule-details" ".aidlc-rule-details\" /E /I /Q /Y >nul
echo   [+] OpenAI Codex setup complete.
echo       -^> AGENTS.md
echo       -^> .aidlc-rule-details\
goto :done

:setup_all
goto :setup_kiro

:done
echo.
echo   === Setup Complete ===
echo.
echo   [+] AI-DLC rules have been installed successfully.
echo.
echo   [i] Next steps:
echo       1. Open your project in your coding agent
echo       2. Start a chat with: "Using AI-DLC, ..."
echo       3. The workflow will guide you from there
echo.
echo   [i] For verification steps, see:
echo       https://github.com/%REPO%#platform-specific-setup
echo.

REM Cleanup temp directory
if defined TMP_DIR (
    if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%" 2>nul
)

:end
endlocal
