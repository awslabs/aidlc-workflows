# Workspace Detection

**Purpose**: Determine workspace state, capture feature name, and check for existing AI-DLC projects

## Step 1: Check for Existing AI-DLC Projects

Scan `aidlc-docs/` for existing feature folders:

**IF `aidlc-docs/` contains one or more subdirectories with `aidlc-state.md`**:
- **Single feature folder found**: Auto-select it, confirm with user, resume from last phase
- **Multiple feature folders found**: Present list of features for user to choose which to resume, or start a new feature
- **Legacy flat structure** (aidlc-state.md directly in aidlc-docs/ with no feature subfolder): Offer to migrate into a named feature folder

**IF no existing projects found**: Continue with new project assessment (Step 2)

## Step 2: Capture Feature Name (New Workflows)

**MANDATORY for new workflows**: Prompt the user for a short, descriptive feature name.

**Prompt**:
```markdown
What is the name of the feature you're working on? This will be used to organize all documentation for this feature.

Example: "User Authentication", "Payment Processing", "Search API"
```

**Sanitization rules**:
- Convert to lowercase
- Replace spaces and special characters with hyphens
- Remove leading/trailing hyphens
- Allow only alphanumeric characters and hyphens
- Maximum 50 characters
- Example: "User Authentication" → `user-authentication`

**Store the feature name** — all subsequent `aidlc-docs/` paths resolve to `aidlc-docs/{feature-name}/` per the Global Path Resolution Rule in core-workflow.md.

## Step 3: Scan Workspace for Existing Code

**Determine if workspace has existing code:**
- Scan workspace for source code files (.java, .py, .js, .ts, .jsx, .tsx, .kt, .kts, .scala, .groovy, .go, .rs, .rb, .php, .c, .h, .cpp, .hpp, .cc, .cs, .fs, etc.)
- Check for build files (pom.xml, package.json, build.gradle, etc.)
- Look for project structure indicators
- Identify workspace root directory (NOT aidlc-docs/)

**Record findings:**
```markdown
## Workspace State
- **Existing Code**: [Yes/No]
- **Programming Languages**: [List if found]
- **Build System**: [Maven/Gradle/npm/etc. if found]
- **Project Structure**: [Monolith/Microservices/Library/Empty]
- **Workspace Root**: [Absolute path]
```

## Step 4: Determine Next Phase

**IF workspace is empty (no existing code)**:
- Set flag: `brownfield = false`
- Next phase: Requirements Analysis

**IF workspace has existing code**:
- Set flag: `brownfield = true`
- Check for existing reverse engineering artifacts in `aidlc-docs/{feature-name}/inception/reverse-engineering/`
- **IF reverse engineering artifacts exist**:
    - Check if artifacts are stale (compare artifact timestamps against codebase's last significant modification)
    - **IF artifacts are current**: Load them, skip to Requirements Analysis
    - **IF artifacts are stale**: Next phase is Reverse Engineering (rerun to refresh artifacts)
    - **IF user explicitly requests rerun**: Next phase is Reverse Engineering regardless of staleness
- **IF no reverse engineering artifacts**: Next phase is Reverse Engineering

## Step 5: Create Initial State File

Create `aidlc-docs/{feature-name}/aidlc-state.md`:

```markdown
# AI-DLC State Tracking

## Project Information
- **Feature Name**: [{feature-name}]
- **Project Type**: [Greenfield/Brownfield]
- **Start Date**: [ISO timestamp]
- **Current Stage**: INCEPTION - Workspace Detection

## Workspace State
- **Existing Code**: [Yes/No]
- **Reverse Engineering Needed**: [Yes/No]
- **Workspace Root**: [Absolute path]

## Code Location Rules
- **Application Code**: Workspace root (NEVER in aidlc-docs/)
- **Documentation**: aidlc-docs/{feature-name}/ only
- **Structure patterns**: See code-generation.md Critical Rules

## Stage Progress
[Will be populated as workflow progresses]
```

## Step 6: Present Completion Message

**For Brownfield Projects:**
```markdown
# 🔍 Workspace Detection Complete

Workspace analysis findings:
• **Feature**: {feature-name}
• **Project Type**: Brownfield project
• [AI-generated summary of workspace findings in bullet points]
• **Next Step**: Proceeding to **Reverse Engineering** to analyze existing codebase...
```

**For Greenfield Projects:**
```markdown
# 🔍 Workspace Detection Complete

Workspace analysis findings:
• **Feature**: {feature-name}
• **Project Type**: Greenfield project
• **Next Step**: Proceeding to **Requirements Analysis**...
```

## Step 7: Automatically Proceed

- **No user approval required** - this is informational only
- Automatically proceed to next phase:
  - **Brownfield**: Reverse Engineering (if no existing artifacts) or Requirements Analysis (if artifacts exist)
  - **Greenfield**: Requirements Analysis
