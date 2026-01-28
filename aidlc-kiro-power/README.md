# AI-DLC Kiro Power

This directory contains the Kiro Power for the AI-DLC (AI-Driven Development Life Cycle) methodology.

## What is AI-DLC?

AI-DLC (AI-Driven Development Life Cycle) is a comprehensive adaptive software development lifecycle that intelligently tailors workflow stages to project complexity and requirements. It guides teams through inception, construction, and operations phases with built-in quality gates and documentation.

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

### Installation Steps

This approach copies the power to your project and installs it through Kiro IDE.

**Important Note**: Kiro Power uses a flattened file structure (all files in one `steering/` directory), while the source repository uses subfolders (`common/`, `inception/`, `construction/`, `operations/`). The installation commands below flatten the structure automatically.

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

## How It Works

### Platform Detection

The AI-DLC methodology automatically detects which platform it's running on:

1. **Workspace Files First**: Checks for `.kiro/aws-aidlc-rule-details/` or `.amazonq/aws-aidlc-rule-details/` directories
   - If found, uses workspace files with subfolder structure
   
2. **Kiro Power Fallback**: If no workspace files exist, uses the installed Kiro Power
   - Loads `kiro-power-file-mapping.md` to translate subfolder paths to flat filenames

### File Structure

**Source Repository** (subfolder structure):
```
aidlc-rules/aws-aidlc-rule-details/
├── common/
│   ├── content-validation.md
│   ├── kiro-power-file-mapping.md
│   └── ...
├── inception/
│   ├── workspace-detection.md
│   └── ...
├── construction/
│   ├── functional-design.md
│   └── ...
└── operations/
    └── operations.md
```

**Kiro Power** (flat structure):
```
.kiro/powers/ai-dlc-methodology/steering/
├── core-workflow.md
├── kiro-power-file-mapping.md
├── content-validation.md
├── workspace-detection.md
├── functional-design.md
└── ...
```

The `core-workflow.md` references files using subfolder paths (e.g., `common/content-validation.md`), and the mapping file translates these to flat filenames for Kiro Power.

## Power Structure

```
ai-dlc-methodology/
├── POWER.md                          # Main power documentation
└── steering/                         # Detailed workflow rules (flattened structure)
    ├── core-workflow.md              # Main workflow orchestration
    ├── kiro-power-file-mapping.md    # Maps subfolder paths to flat filenames
    └── ...                           # Other steering files for phases and common rules
```

**Note**: The power uses a flattened file structure where all steering files are in one directory. The `kiro-power-file-mapping.md` file provides a mapping from the subfolder-based references in `core-workflow.md` to the flat filenames used by Kiro Power.

## Key Features

- **Adaptive Workflow**: Intelligently determines which stages to execute
- **Platform Detection**: Automatically detects whether to use workspace files or Kiro Power
- **Quality Gates**: Built-in approval points for user control
- **Progress Tracking**: Complete audit trail and state management
- **Content Validation**: Ensures all generated content is valid
- **Session Continuity**: Resume interrupted workflows seamlessly
- **Depth Adaptation**: Adjusts detail level based on complexity
- **File Mapping**: Transparent mapping between subfolder structure and flat structure

## Troubleshooting

### Power Not Showing Up

1. Verify installation directory: `ls .kiro/powers/ai-dlc-methodology/`
2. Check POWER.md exists with proper frontmatter
3. Restart Kiro
4. Check Kiro logs for errors

### Missing Steering Files

1. Verify steering directory structure: `ls .kiro/powers/ai-dlc-methodology/steering/`
2. Ensure all files are in a flat structure (no subfolders)
3. Check that `kiro-power-file-mapping.md` exists
4. Re-run the copy commands from installation steps
5. Check file permissions

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
