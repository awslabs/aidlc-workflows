# AI-DLC Kiro Power

This directory contains the Kiro Power for the AI-DLC (Adaptive Intelligent Development Lifecycle) methodology.

## What is AI-DLC?

AI-DLC is a comprehensive adaptive software development lifecycle that intelligently tailors workflow stages to project complexity and requirements. It guides teams through inception, construction, and operations phases with built-in quality gates and documentation.

## Installation

### Prerequisites

- Kiro IDE installed
- This repository cloned locally

### Typical Setup Scenario

```
parent-folder/
├── aidlc-workflows/          # This cloned repository
└── my-project/               # Your new project folder
```

### Option 1: Install via Kiro IDE (Recommended)

This approach copies the power to your project and installs it through Kiro IDE.

**Step 1: Copy power files to your project**

From your project directory (e.g., `my-project/`), run:

**Linux/macOS (bash):**
```bash
mkdir -p .kiro/powers/ai-dlc-methodology/steering
cp ../aidlc-workflows/aidlc-kiro-power/POWER.md .kiro/powers/ai-dlc-methodology/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rules/core-workflow.md .kiro/powers/ai-dlc-methodology/steering/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details/common/*.md .kiro/powers/ai-dlc-methodology/steering/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details/inception/*.md .kiro/powers/ai-dlc-methodology/steering/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details/construction/*.md .kiro/powers/ai-dlc-methodology/steering/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details/operations/*.md .kiro/powers/ai-dlc-methodology/steering/
```

**Windows (PowerShell or Command Prompt):**
```powershell
mkdir .kiro\powers\ai-dlc-methodology\steering
copy ..\aidlc-workflows\aidlc-kiro-power\POWER.md .kiro\powers\ai-dlc-methodology\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rules\core-workflow.md .kiro\powers\ai-dlc-methodology\steering\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rule-details\common\*.md .kiro\powers\ai-dlc-methodology\steering\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rule-details\inception\*.md .kiro\powers\ai-dlc-methodology\steering\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rule-details\construction\*.md .kiro\powers\ai-dlc-methodology\steering\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rule-details\operations\*.md .kiro\powers\ai-dlc-methodology\steering\
```

**Step 2: Install via Kiro IDE**

1. Open Kiro IDE
2. Open Powers Panel (Command Palette → "Powers: Manage")
3. Click "Install from Directory"
4. Select `.kiro/powers/ai-dlc-methodology` from your project

**Step 3: Verify**

- Look for "AI-DLC Methodology" in the Powers Panel
- Click to view details and available steering files

### Option 2: Global Installation (Shell Script)

Install globally to make the power available across all projects:

**macOS/Linux:**
```bash
mkdir -p ~/.kiro/powers/ai-dlc-methodology/steering
cp ../aidlc-workflows/aidlc-kiro-power/POWER.md ~/.kiro/powers/ai-dlc-methodology/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rules/core-workflow.md ~/.kiro/powers/ai-dlc-methodology/steering/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details/common/*.md ~/.kiro/powers/ai-dlc-methodology/steering/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details/inception/*.md ~/.kiro/powers/ai-dlc-methodology/steering/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details/construction/*.md ~/.kiro/powers/ai-dlc-methodology/steering/
cp ../aidlc-workflows/aidlc-rules/aws-aidlc-rule-details/operations/*.md ~/.kiro/powers/ai-dlc-methodology/steering/
```

**Windows (PowerShell or Command Prompt):**
```powershell
mkdir %USERPROFILE%\.kiro\powers\ai-dlc-methodology\steering
copy ..\aidlc-workflows\aidlc-kiro-power\POWER.md %USERPROFILE%\.kiro\powers\ai-dlc-methodology\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rules\core-workflow.md %USERPROFILE%\.kiro\powers\ai-dlc-methodology\steering\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rule-details\common\*.md %USERPROFILE%\.kiro\powers\ai-dlc-methodology\steering\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rule-details\inception\*.md %USERPROFILE%\.kiro\powers\ai-dlc-methodology\steering\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rule-details\construction\*.md %USERPROFILE%\.kiro\powers\ai-dlc-methodology\steering\
copy ..\aidlc-workflows\aidlc-rules\aws-aidlc-rule-details\operations\*.md %USERPROFILE%\.kiro\powers\ai-dlc-methodology\steering\
```

Verify in Kiro IDE → Powers Panel → "AI-DLC Methodology"

**Note:** If your repository is in a different location, adjust the `../aidlc-workflows/` path accordingly.

## Verification

After installation, verify the power is available:

1. Open Kiro
2. Open Powers Panel
3. Look for "AI-DLC Methodology" in the installed powers list
4. Click to view details and available steering files

## Usage

Once installed, the AI-DLC methodology will be available to guide your development workflow:

1. Start a software development request in Kiro
2. The methodology will automatically activate
3. Follow the adaptive workflow stages
4. Review and approve at quality gates
5. Track progress in `aidlc-docs/aidlc-state.md`

## Power Structure

```
ai-dlc-methodology/
├── POWER.md                          # Main power documentation
└── steering/                         # Detailed workflow rules (flattened structure)
    ├── core-workflow.md              # Main workflow orchestration
    ├── ascii-diagram-standards.md    # Common rules (always load first)
    ├── content-validation.md
    ├── depth-levels.md
    ├── error-handling.md
    ├── overconfidence-prevention.md
    ├── process-overview.md
    ├── question-format-guide.md
    ├── session-continuity.md
    ├── terminology.md
    ├── welcome-message.md
    ├── workflow-changes.md
    ├── application-design.md         # Inception phase rules
    ├── requirements-analysis.md
    ├── reverse-engineering.md
    ├── units-generation.md
    ├── user-stories.md
    ├── workflow-planning.md
    ├── workspace-detection.md
    ├── build-and-test.md             # Construction phase rules
    ├── code-generation.md
    ├── functional-design.md
    ├── infrastructure-design.md
    ├── nfr-design.md
    ├── nfr-requirements.md
    └── operations.md                 # Operations phase rules
```

## Key Features

- **Adaptive Workflow**: Intelligently determines which stages to execute
- **Quality Gates**: Built-in approval points for user control
- **Progress Tracking**: Complete audit trail and state management
- **Content Validation**: Ensures all generated content is valid
- **Session Continuity**: Resume interrupted workflows seamlessly
- **Depth Adaptation**: Adjusts detail level based on complexity

## Troubleshooting

### Power Not Showing Up

1. Verify installation directory: `ls ~/.kiro/powers/ai-dlc-methodology/`
2. Check POWER.md exists with proper frontmatter
3. Restart Kiro
4. Check Kiro logs for errors

### Missing Steering Files

1. Verify steering directory structure: `ls ~/.kiro/powers/ai-dlc-methodology/steering/`
2. Re-run the copy commands from installation steps
3. Check file permissions

### Workflow Not Activating

1. Ensure you're making a software development request
2. Check that the power is enabled in Powers Panel
3. Review Kiro console for errors

## Support

For issues or questions:
1. Check the POWER.md documentation
2. Review relevant steering files
3. Check the repository issues
4. Consult Kiro documentation

## License

See the main repository LICENSE file.
