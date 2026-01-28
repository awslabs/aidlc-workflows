# Kiro Power File Mapping

This file maps the subfolder-based file references in core-workflow.md to the flat structure used by Kiro Power.

When you see a file reference like `common/content-validation.md` in core-workflow.md, use this table to find the actual steering file name for Kiro Power.

## How to Use This Mapping

1. When core-workflow.md says "Load all steps from `common/content-validation.md`"
2. Look up `common/content-validation.md` in the table below
3. Use the corresponding Kiro Power filename: `content-validation.md`
4. Load with: `kiroPowers action: readSteering, powerName: ai-dlc-methodology, steeringFile: content-validation.md`

## File Mapping Table

| Reference in core-workflow.md | Kiro Power Steering File |
|-------------------------------|--------------------------|
| common/ascii-diagram-standards.md | ascii-diagram-standards.md |
| common/content-validation.md | content-validation.md |
| common/depth-levels.md | depth-levels.md |
| common/error-handling.md | error-handling.md |
| common/kiro-power-file-mapping.md | kiro-power-file-mapping.md |
| common/overconfidence-prevention.md | overconfidence-prevention.md |
| common/process-overview.md | process-overview.md |
| common/question-format-guide.md | question-format-guide.md |
| common/session-continuity.md | session-continuity.md |
| common/terminology.md | terminology.md |
| common/welcome-message.md | welcome-message.md |
| common/workflow-changes.md | workflow-changes.md |
| inception/application-design.md | application-design.md |
| inception/requirements-analysis.md | requirements-analysis.md |
| inception/reverse-engineering.md | reverse-engineering.md |
| inception/units-generation.md | units-generation.md |
| inception/user-stories.md | user-stories.md |
| inception/workflow-planning.md | workflow-planning.md |
| inception/workspace-detection.md | workspace-detection.md |
| construction/build-and-test.md | build-and-test.md |
| construction/code-generation.md | code-generation.md |
| construction/functional-design.md | functional-design.md |
| construction/infrastructure-design.md | infrastructure-design.md |
| construction/nfr-design.md | nfr-design.md |
| construction/nfr-requirements.md | nfr-requirements.md |
| operations/operations.md | operations.md |

## Quick Reference by Phase

**Common Rules:**
- All files in `common/` → Use filename without subfolder

**Inception Phase:**
- All files in `inception/` → Use filename without subfolder

**Construction Phase:**
- All files in `construction/` → Use filename without subfolder

**Operations Phase:**
- All files in `operations/` → Use filename without subfolder

## Example Translations

- `common/content-validation.md` → `content-validation.md`
- `inception/workspace-detection.md` → `workspace-detection.md`
- `construction/functional-design.md` → `functional-design.md`
- `operations/operations.md` → `operations.md`
