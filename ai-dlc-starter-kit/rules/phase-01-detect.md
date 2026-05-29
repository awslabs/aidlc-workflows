# Phase 1: Workspace Detection (DETECT)

## Objective

Understand the project before acting. Determine if this is a new (greenfield) or existing (brownfield) project.

## Instructions

### Step 1: Check for State File

Read `.aidlc/state.md`. If a previous task is incomplete (phase != complete), offer to resume from where it left off.

If the user says "rollback to <phase>", follow the rollback protocol:
1. Save current state to `.aidlc/history/<timestamp>-snapshot.md`
2. Update `.aidlc/state.md` phase to the target
3. Re-load the target phase's rule file
4. Re-evaluate decisions from the snapshot context

### Step 2: Classify Project Type

Scan the project root and key directories:

**Greenfield indicators:**
- Empty directory or only scaffold files (README, .gitignore)
- No source code files
- No package.json / Cargo.toml / go.mod / requirements.txt

**Brownfield indicators:**
- Existing source code directories
- Package manager files with dependencies
- Git history with prior commits
- Configuration files for frameworks

### Step 3: For Brownfield — Deep Scan

If the project has existing code, gather:
- Tech stack (language, framework, build system)
- Directory structure and conventions
- Testing setup (framework, coverage)
- CI/CD configuration
- Recent changes (`git log --oneline -10` if available)
- Existing architectural patterns

### Step 4: Report Findings

```
## Workspace Detection Report

**Project Type:** [Greenfield | Brownfield]
**Tech Stack:** [language, framework, tools]
**Current State:** Resume from phase: [phase] | New task

### For Brownfield:
- **Key directories:** ...
- **Entry points:** ...
- **Test setup:** ...
- **Recent activity:** ...

### Recommendation:
- Starting phase: DETECT | REQUIREMENTS | PLAN
- Complexity: simple | moderate | complex
```

### Step 5: Checkpoint

Present findings. Ask: "Does this assessment look correct? Proceed to Requirements phase?"

Do NOT proceed until user confirms.
