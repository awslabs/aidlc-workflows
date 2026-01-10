# Multi-User Parallel Development

## Overview

This workflow enables multiple developers to work on different units simultaneously with automatic branch management, audit isolation, and consolidation.

## User Detection

**MANDATORY**: At workflow start, detect current user:

```bash
CURRENT_USER=$(whoami)
```

Store in `aidlc-docs/session-info.md`:
```markdown
# Session Information
- **User**: ${CURRENT_USER}
- **Session Start**: ${TIMESTAMP}
- **Audit File**: aidlc-docs/audit/user-${CURRENT_USER}-audit.md
```

## Audit File Management

### User-Scoped Audit Files

**MANDATORY**: Replace all `audit.md` references with user-scoped files:

- **Path**: `aidlc-docs/audit/user-${CURRENT_USER}-audit.md`
- **Create directory**: `mkdir -p aidlc-docs/audit/`
- **Always append**: Never use `create` command on audit files

### Audit Index

**MANDATORY**: After each audit entry, update `aidlc-docs/audit/audit-index.md`:

```markdown
# Audit Trail Index

## Active Sessions
- [user-alice](./user-alice-audit.md) - Last updated: 2025-11-05T11:07:00Z
- [user-bob](./user-bob-audit.md) - Last updated: 2025-11-05T10:30:00Z

## Completed Sessions
- [user-charlie](./user-charlie-audit.md) - Completed: 2025-11-04T16:00:00Z
```

## Parallel Unit Development

### Phase: Units Generation Completion

**MANDATORY**: After Units Generation stage approval, execute:

#### Step 1: Create Unit Assignments Manifest

Create `aidlc-docs/construction/unit-assignments.md`:

```markdown
# Unit Assignments

Generated: ${TIMESTAMP}

## Units

| Unit Name | Assigned To | Status | Branch | Started | Completed |
|-----------|-------------|--------|--------|---------|-----------|
${UNIT_ROWS}

## Dependencies

${DEPENDENCY_MAP}

## Instructions

1. Claim a unit by updating "Assigned To" with your username
2. Run: `kiro-cli chat "claim unit ${UNIT_NAME}"`
3. AI will create your branch and set up workspace
4. Work independently in your branch
5. When complete, run: `kiro-cli chat "complete unit ${UNIT_NAME}"`
```

#### Step 2: Commit Inception Artifacts

```bash
git add aidlc-docs/inception/
git add aidlc-docs/construction/unit-assignments.md
git commit -m "AI-DLC: Inception phase complete - ${NUM_UNITS} units ready for parallel development"
git push origin main
```

#### Step 3: Present Assignment Options

**Message to user**:
```
✅ Units Generation Complete

${NUM_UNITS} units are ready for parallel development:
${UNIT_LIST}

**Next Steps**:

A) **Claim a unit now** (you will work on it)
   - Choose unit: ${UNIT_OPTIONS}
   
B) **Let team claim units** (you're done for now)
   - Share: git pull origin main
   - Team members run: kiro-cli chat "claim unit <name>"

C) **Claim multiple units** (sequential work)
   - You'll work on multiple units one by one

Which option? [A/B/C]
```

### Unit Claiming Workflow

**Trigger**: User says "claim unit ${UNIT_NAME}" or chooses option A

#### Step 1: Validate Unit

```bash
# Check unit exists and is available
grep "${UNIT_NAME}" aidlc-docs/construction/unit-assignments.md
# Verify status is "Not Started" or "Assigned To" is empty
```

#### Step 2: Create Unit Branch

```bash
git checkout main
git pull origin main
git checkout -b "unit/${UNIT_NAME}-${CURRENT_USER}"
```

#### Step 3: Update Assignment Manifest

Update `aidlc-docs/construction/unit-assignments.md`:
- Set "Assigned To": ${CURRENT_USER}
- Set "Status": In Progress
- Set "Branch": unit/${UNIT_NAME}-${CURRENT_USER}
- Set "Started": ${TIMESTAMP}

#### Step 4: Commit Assignment

```bash
git add aidlc-docs/construction/unit-assignments.md
git commit -m "AI-DLC: ${CURRENT_USER} claimed unit ${UNIT_NAME}"
git push origin "unit/${UNIT_NAME}-${CURRENT_USER}"
```

#### Step 5: Initialize Unit Workspace

Create `aidlc-docs/construction/plans/${UNIT_NAME}-unit-plan.md`:

```markdown
# Unit: ${UNIT_NAME}

- **Assigned To**: ${CURRENT_USER}
- **Branch**: unit/${UNIT_NAME}-${CURRENT_USER}
- **Status**: In Progress

## Construction Stages

- [ ] Functional Design
- [ ] NFR Requirements
- [ ] NFR Design
- [ ] Infrastructure Design
- [ ] Code Generation

## Audit Trail

See: [User Audit](../../audit/user-${CURRENT_USER}-audit.md)
```

#### Step 6: Log in Audit

Append to `aidlc-docs/audit/user-${CURRENT_USER}-audit.md`:

```markdown
## Unit Claimed: ${UNIT_NAME}

**Timestamp**: ${TIMESTAMP}
**Branch**: unit/${UNIT_NAME}-${CURRENT_USER}
**Action**: Claimed unit for development

---
```

#### Step 7: Begin Construction Phase

**Message to user**:
```
✅ Unit Claimed: ${UNIT_NAME}

Branch created: unit/${UNIT_NAME}-${CURRENT_USER}
Workspace initialized: aidlc-docs/construction/${UNIT_NAME}/

Starting Construction Phase for this unit...
```

Proceed to Construction Phase stages for this unit only.

### Unit Completion Workflow

**Trigger**: User says "complete unit ${UNIT_NAME}" or Construction Phase finishes

#### Step 1: Validate Completion

Check all stages completed in `aidlc-docs/construction/plans/${UNIT_NAME}-unit-plan.md`

#### Step 2: Update Assignment Manifest

Update `aidlc-docs/construction/unit-assignments.md`:
- Set "Status": Completed
- Set "Completed": ${TIMESTAMP}

#### Step 3: Commit Unit Work

```bash
git add aidlc-docs/construction/${UNIT_NAME}/
git add aidlc-docs/construction/plans/${UNIT_NAME}-*.md
git add aidlc-docs/audit/user-${CURRENT_USER}-audit.md
git commit -m "AI-DLC: Completed unit ${UNIT_NAME}"
git push origin "unit/${UNIT_NAME}-${CURRENT_USER}"
```

#### Step 4: Create Pull Request Preparation

Create `aidlc-docs/construction/${UNIT_NAME}/PR-CHECKLIST.md`:

```markdown
# Pull Request Checklist: ${UNIT_NAME}

## Completed Artifacts
- [x] Functional Design
- [x] NFR Requirements
- [x] NFR Design
- [x] Infrastructure Design
- [x] Code Generation

## Files Changed
${FILE_LIST}

## Dependencies
${DEPENDENCY_STATUS}

## Merge Instructions
1. Ensure dependent units are merged first: ${DEPENDENCIES}
2. Merge to main: git merge unit/${UNIT_NAME}-${CURRENT_USER}
3. Run consolidation: kiro-cli chat "consolidate units"
```

#### Step 5: Log Completion

Append to `aidlc-docs/audit/user-${CURRENT_USER}-audit.md`:

```markdown
## Unit Completed: ${UNIT_NAME}

**Timestamp**: ${TIMESTAMP}
**Branch**: unit/${UNIT_NAME}-${CURRENT_USER}
**Action**: Unit development completed, ready for merge

---
```

#### Step 6: Notify User

**Message to user**:
```
✅ Unit Completed: ${UNIT_NAME}

Branch: unit/${UNIT_NAME}-${CURRENT_USER}
PR Checklist: aidlc-docs/construction/${UNIT_NAME}/PR-CHECKLIST.md

**Next Steps**:

A) **Claim another unit** (continue working)
   Available units: ${AVAILABLE_UNITS}
   
B) **Merge this unit** (if you're the lead/integrator)
   Run: kiro-cli chat "merge unit ${UNIT_NAME}"
   
C) **Done for now** (let others continue)
   Your work is pushed and ready for integration

Which option? [A/B/C]
```

## Unit Consolidation Workflow

**Trigger**: User says "consolidate units" or "merge unit ${UNIT_NAME}"

### Auto-Consolidation Process

#### Step 1: Check Dependencies

```bash
# Parse unit-assignments.md for dependency graph
# Verify all dependencies are completed before merging
```

#### Step 2: Merge Unit Branch

```bash
git checkout main
git pull origin main
git merge --no-ff "unit/${UNIT_NAME}-${CURRENT_USER}" -m "AI-DLC: Integrate unit ${UNIT_NAME}"
```

#### Step 3: Update Consolidated Index

Create/update `aidlc-docs/construction/consolidated-index.md`:

```markdown
# Consolidated Construction Artifacts

Last updated: ${TIMESTAMP}

## Integrated Units

### ${UNIT_NAME} (by ${CURRENT_USER})
- **Merged**: ${TIMESTAMP}
- **Branch**: unit/${UNIT_NAME}-${CURRENT_USER}
- **Artifacts**: [View](${UNIT_NAME}/)
- **Audit**: [View](../audit/user-${CURRENT_USER}-audit.md)

## Pending Units

${PENDING_UNITS_LIST}

## Build and Test Status

After all units integrated, proceed to Build and Test phase.
```

#### Step 4: Commit Consolidation

```bash
git add aidlc-docs/construction/consolidated-index.md
git add aidlc-docs/construction/unit-assignments.md
git commit -m "AI-DLC: Consolidated unit ${UNIT_NAME} into main"
git push origin main
```

#### Step 5: Check All Units Complete

```bash
# Count completed units vs total units
if [ ${COMPLETED_UNITS} -eq ${TOTAL_UNITS} ]; then
  # Trigger Build and Test phase
fi
```

#### Step 6: Notify User

**If more units pending**:
```
✅ Unit Merged: ${UNIT_NAME}

Progress: ${COMPLETED_UNITS}/${TOTAL_UNITS} units completed

Pending units:
${PENDING_LIST}

Waiting for team to complete remaining units...
```

**If all units complete**:
```
✅ All Units Integrated!

${TOTAL_UNITS}/${TOTAL_UNITS} units completed and merged.

**Ready for Build and Test Phase**

Proceed? [Yes/No]
```

## Audit Consolidation

### Consolidated Audit View

**MANDATORY**: After each unit merge, update `aidlc-docs/audit/consolidated-audit.md`:

```markdown
# Consolidated Audit Trail

Project: ${PROJECT_NAME}
Generated: ${TIMESTAMP}

## Inception Phase
- **Lead**: ${INCEPTION_USER}
- **Completed**: ${INCEPTION_DATE}
- **Audit**: [View](user-${INCEPTION_USER}-audit.md)

## Construction Phase

### Unit: ${UNIT_NAME}
- **Developer**: ${DEVELOPER}
- **Started**: ${START_DATE}
- **Completed**: ${COMPLETE_DATE}
- **Audit**: [View](user-${DEVELOPER}-audit.md)

### Unit: ${UNIT_NAME_2}
- **Developer**: ${DEVELOPER_2}
- **Started**: ${START_DATE_2}
- **Completed**: ${COMPLETE_DATE_2}
- **Audit**: [View](user-${DEVELOPER_2}-audit.md)

## Build and Test Phase
- **Lead**: ${BUILD_USER}
- **Status**: ${BUILD_STATUS}
- **Audit**: [View](user-${BUILD_USER}-audit.md)
```

## Key Principles

1. **User Isolation**: Each developer has their own audit trail
2. **Branch Isolation**: Each unit developed in separate branch
3. **Automatic Tracking**: All assignments and completions logged automatically
4. **Dependency Awareness**: System prevents merging units with incomplete dependencies
5. **Consolidated View**: Automatic indexing provides project-wide visibility
6. **Git-Native**: Uses standard git workflows familiar to developers

## Integration with Existing Workflow

### Modified Stages

**Units Generation Stage**: Add consolidation setup after approval
**Construction Phase**: Execute per-unit in claimed branches
**Build and Test**: Execute only after all units consolidated

### File Path Updates

Replace all instances of:
- `aidlc-docs/audit.md` → `aidlc-docs/audit/user-${CURRENT_USER}-audit.md`
- Add branch creation after unit assignment
- Add consolidation after unit completion
