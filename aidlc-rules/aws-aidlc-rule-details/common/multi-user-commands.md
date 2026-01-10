# Multi-User Workflow Commands

## Command Recognition

The AI MUST recognize and execute these commands automatically:

### Unit Management Commands

- `claim unit <unit-name>` - Claim a unit for development
- `complete unit <unit-name>` - Mark unit as complete and ready for merge
- `merge unit <unit-name>` - Merge completed unit into main
- `consolidate units` - Merge all completed units
- `list units` - Show unit assignment status
- `unit status <unit-name>` - Show detailed unit status

### Audit Commands

- `show audit` - Display current user's audit trail
- `show all audits` - Display consolidated audit index
- `audit summary` - Generate summary of all activities

## Command Implementations

### claim unit <unit-name>

**Execution Steps**:
1. Detect current user: `CURRENT_USER=$(whoami)`
2. Validate unit exists and is available
3. Create branch: `git checkout -b unit/<unit-name>-${CURRENT_USER}`
4. Update unit-assignments.md
5. Commit and push assignment
6. Initialize unit workspace
7. Log in user audit file
8. Begin Construction Phase for this unit

**Output**:
```
✅ Unit Claimed: <unit-name>
Branch: unit/<unit-name>-<user>
Starting Construction Phase...
```

### complete unit <unit-name>

**Execution Steps**:
1. Validate all construction stages completed
2. Update unit-assignments.md status to "Completed"
3. Commit all unit artifacts
4. Push branch
5. Create PR checklist
6. Log completion in audit
7. Offer next actions (claim another, merge, done)

**Output**:
```
✅ Unit Completed: <unit-name>
Ready for merge. Next action? [A/B/C]
```

### merge unit <unit-name>

**Execution Steps**:
1. Check dependencies are satisfied
2. Switch to main: `git checkout main && git pull`
3. Merge unit branch: `git merge --no-ff unit/<unit-name>-<user>`
4. Update consolidated-index.md
5. Commit consolidation
6. Push to main
7. Check if all units complete
8. Trigger Build and Test if ready

**Output**:
```
✅ Unit Merged: <unit-name>
Progress: X/Y units completed
```

### consolidate units

**Execution Steps**:
1. Parse unit-assignments.md for completed units
2. Sort by dependencies (topological sort)
3. Merge each unit in dependency order
4. Update consolidated-index.md
5. Generate consolidated-audit.md
6. Trigger Build and Test phase

**Output**:
```
✅ All Units Consolidated
X/X units merged successfully
Ready for Build and Test Phase
```

### list units

**Execution Steps**:
1. Read unit-assignments.md
2. Format table with current status
3. Highlight available units
4. Show dependencies

**Output**:
```
Unit Assignments:

✅ user-service (alice) - Completed
🔄 payment-service (bob) - In Progress  
⭐ notification-service - Available
⏳ reporting-service - Blocked (depends on payment-service)
```

### unit status <unit-name>

**Execution Steps**:
1. Read unit plan file
2. Show stage completion
3. Show assigned developer
4. Show dependencies
5. Link to audit trail

**Output**:
```
Unit: payment-service
Assigned: bob
Branch: unit/payment-service-bob
Status: In Progress

Construction Stages:
✅ Functional Design
✅ NFR Requirements
🔄 NFR Design (current)
⏳ Infrastructure Design
⏳ Code Generation

Dependencies: user-service (✅ completed)
Audit: aidlc-docs/audit/user-bob-audit.md
```

### show audit

**Execution Steps**:
1. Detect current user
2. Read user-specific audit file
3. Display formatted content
4. Show recent entries first

**Output**:
```
Audit Trail: user-alice

Recent Activity:
- 2025-11-05 11:07 - Claimed unit: user-service
- 2025-11-05 10:30 - Completed Requirements Analysis
- 2025-11-05 09:15 - Started Inception Phase

Full audit: aidlc-docs/audit/user-alice-audit.md
```

### show all audits

**Execution Steps**:
1. Read audit-index.md
2. Display all active sessions
3. Show last activity per user
4. Link to individual audits

**Output**:
```
All Audit Trails:

Active Sessions:
- alice: Last activity 2025-11-05 11:07 (user-service)
- bob: Last activity 2025-11-05 10:45 (payment-service)

Completed Sessions:
- charlie: Completed 2025-11-04 16:00 (notification-service)

Index: aidlc-docs/audit/audit-index.md
```

### audit summary

**Execution Steps**:
1. Parse all user audit files
2. Extract key milestones
3. Generate timeline
4. Create consolidated-audit.md

**Output**:
```
Project Audit Summary:

Inception Phase:
- Lead: alice
- Duration: 2 hours
- Completed: 2025-11-05 10:00

Construction Phase:
- Units: 3
- Developers: alice, bob, charlie
- In Progress: 2
- Completed: 1

Timeline: aidlc-docs/audit/consolidated-audit.md
```

## Automatic Command Detection

**MANDATORY**: The AI MUST detect these patterns in user input:

```
User says: "I want to work on the user service"
→ Execute: claim unit user-service

User says: "I'm done with payment service"
→ Execute: complete unit payment-service

User says: "merge the notification service"
→ Execute: merge unit notification-service

User says: "what units are available?"
→ Execute: list units

User says: "how is bob doing on payment service?"
→ Execute: unit status payment-service

User says: "show me what I've done"
→ Execute: show audit

User says: "integrate everything"
→ Execute: consolidate units
```

## Integration Points

### Units Generation Stage

After user approves units, automatically:
1. Create unit-assignments.md
2. Commit inception artifacts
3. Present claiming options
4. Wait for "claim unit" command or team assignment

### Construction Phase

Only execute for claimed unit in current branch:
1. Check current branch matches unit assignment
2. Execute stages for this unit only
3. Update unit plan checkboxes
4. Log in user-specific audit

### Build and Test Phase

Only execute after consolidation:
1. Verify all units merged to main
2. Check consolidated-index.md shows all units
3. Execute build and test across all units
4. Generate integration test results

## Error Handling

### Unit Already Claimed
```
❌ Unit already claimed by <other-user>
Available units: <list>
```

### Dependency Not Met
```
❌ Cannot merge: dependency not satisfied
<unit-name> depends on: <dependency> (status: <status>)
```

### Not in Unit Branch
```
❌ Not in unit branch
Current branch: <branch>
Expected: unit/<unit-name>-<user>
Run: git checkout unit/<unit-name>-<user>
```

### Unit Not Complete
```
❌ Unit not complete
Pending stages:
- Infrastructure Design
- Code Generation

Complete these stages first.
```
