#!/usr/bin/env bash
# AI-DLC Starterkit — Project Initializer (v2.0)
# Usage: ./init.sh [target-directory]
# Features: IDE auto-detection, workspace isolation, symlink support

set -euo pipefail

TARGET="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AIDLC_DIR=".aidlc"

# Colors
BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
BLUE="\033[0;34m"
CYAN="\033[0;36m"
RESET="\033[0m"

echo -e "${BOLD}${BLUE}AI-DLC Starterkit v2.0 — Project Initializer${RESET}\n"

# Resolve target
TARGET="$(cd "$TARGET" 2>/dev/null && pwd || echo "")"
if [ -z "$TARGET" ]; then
    echo "Error: Target directory does not exist."
    echo "Usage: ./init.sh [target-directory]"
    exit 1
fi

echo -e "Target: ${BOLD}$TARGET${RESET}"

# --- Phase 1: Project Detection ---

SOURCE_FILES=$(find "$TARGET" -maxdepth 3 \
    \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \
    -o -name "*.py" -o -name "*.rs" -o -name "*.go" -o -name "*.rb" \
    -o -name "*.java" -o -name "*.kt" -o -name "*.swift" \
    -o -name "*.vue" -o -name "*.svelte" -o -name "*.cs" \
    -o -name "*.cpp" -o -name "*.c" -o -name "*.h" \) \
    2>/dev/null | head -5)

HAS_PKG_JSON=""
HAS_CARGO=""
HAS_GOMOD=""
HAS_REQ_TXT=""
[ -f "$TARGET/package.json" ] && HAS_PKG_JSON=1
[ -f "$TARGET/Cargo.toml" ] && HAS_CARGO=1
[ -f "$TARGET/go.mod" ] && HAS_GOMOD=1
[ -f "$TARGET/requirements.txt" ] && HAS_REQ_TXT=1
[ -f "$TARGET/pyproject.toml" ] && HAS_REQ_TXT=1

if [ -z "$SOURCE_FILES" ] && [ -z "$HAS_PKG_JSON" ] && [ -z "$HAS_CARGO" ] && [ -z "$HAS_GOMOD" ] && [ -z "$HAS_REQ_TXT" ]; then
    PROJECT_TYPE="greenfield"
    echo -e "Type: ${GREEN}Greenfield${RESET} (new project)"
else
    PROJECT_TYPE="brownfield"
    echo -e "Type: ${YELLOW}Brownfield${RESET} (existing project)"
fi

# Detect tech stack for brownfield
if [ "$PROJECT_TYPE" = "brownfield" ]; then
    STACK=""
    [ -n "$HAS_PKG_JSON" ] && STACK="$STACK Node.js"
    [ -n "$HAS_CARGO" ] && STACK="$STACK Rust"
    [ -n "$HAS_GOMOD" ] && STACK="$STACK Go"
    [ -n "$HAS_REQ_TXT" ] && STACK="$STACK Python"
    [ -n "$STACK" ] && echo -e "Stack: ${CYAN}$STACK${RESET}"
fi

# --- Phase 2: IDE Detection ---

echo -e "\n${BOLD}Detecting AI IDEs...${RESET}"

DETECTED_IDES=""
EXISTING_CONFIGS=""

# Check for IDE markers and existing configs
check_ide() {
    local marker_dir="$1"
    local config_file="$2"
    local ide_name="$3"
    local ide_id="$4"

    if [ -f "$TARGET/$config_file" ]; then
        EXISTING_CONFIGS="$EXISTING_CONFIGS  - $config_file ($ide_name)\n"
    fi
    if [ -d "$TARGET/$marker_dir" ] || [ -f "$TARGET/$config_file" ]; then
        DETECTED_IDES="$DETECTED_IDES $ide_id"
    fi
}

check_ide ".claude" "CLAUDE.md" "Claude Code" "claude"
check_ide ".cursor" ".cursorrules" "Cursor" "cursor"
check_ide ".windsurf" ".windsurfrules" "Windsurf" "windsurf"
check_ide ".github" ".github/copilot-instructions.md" "GitHub Copilot" "copilot"

if [ -n "$EXISTING_CONFIGS" ]; then
    echo -e "  ${YELLOW}⚠${RESET}  Existing configs:"
    echo -e "$EXISTING_CONFIGS"
fi

# Trim whitespace
DETECTED_IDES=$(echo "$DETECTED_IDES" | xargs)

if [ -n "$DETECTED_IDES" ]; then
    echo -e "  ${GREEN}✓${RESET} Detected: $DETECTED_IDES"
else
    echo -e "  ${CYAN}ℹ${RESET}  No IDE detected — defaulting to Claude Code"
    DETECTED_IDES="claude"
fi

# --- Phase 3: Create .aidlc/ workspace ---

echo -e "\n${BOLD}Setting up workspace...${RESET}"

mkdir -p "$TARGET/$AIDLC_DIR"/{rules,templates,docs,history}

# Copy rules
cp "$SCRIPT_DIR/rules/"*.md "$TARGET/$AIDLC_DIR/rules/"
echo -e "  ${GREEN}✓${RESET} Phase rules → $AIDLC_DIR/rules/"

# Copy templates
cp "$SCRIPT_DIR/templates/"*.md "$TARGET/$AIDLC_DIR/templates/"
echo -e "  ${GREEN}✓${RESET} Templates → $AIDLC_DIR/templates/"

# --- Phase 4: Create master orchestration file ---

cat > "$TARGET/$AIDLC_DIR/CLAUDE.md" << 'MASTER'
# AI-DLC Starterkit — Orchestration (v2.0)

You are an AI coding assistant following the **AI-Driven Development Life Cycle (AI-DLC)** methodology.

## Core Principle

**AI proposes, human decides.** Never jump straight to code. Always follow the phases. Every phase ends with a checkpoint requiring user approval before proceeding.

## Phase Workflow

```
DETECT → REQUIREMENTS → PLAN → IMPLEMENT → VERIFY → AUDIT
```

Track the current phase in `.aidlc/state.md`.

### Quick Reference: Which Phases to Run

| Task Type | Phases |
|-----------|--------|
| New feature / Greenfield | DETECT → REQUIREMENTS → PLAN → IMPLEMENT → VERIFY → AUDIT |
| Feature on existing codebase | DETECT → REQUIREMENTS → PLAN → IMPLEMENT → VERIFY → AUDIT |
| Bug fix | DETECT → PLAN (light) → IMPLEMENT → VERIFY |
| Quick question / Exploration | Direct answer (skip phases) |

### Phase 1: DETECT — Workspace Detection

**Goal:** Understand the project type and state before acting.

1. Check `.aidlc/state.md` — resume from last phase if incomplete
2. Scan project structure: greenfield or brownfield?
3. For brownfield: identify tech stack, entry points, test setup
4. Report findings and confirm before proceeding

**Rule file:** `.aidlc/rules/phase-01-detect.md`

### Phase 2: REQUIREMENTS — Clarify Before Acting

**Goal:** Ensure mutual understanding. Never assume — always ask.

1. Read `.aidlc/docs/requirements.md` if available
2. Ask 2-7 clarification questions
3. Write clarified requirements to `.aidlc/docs/requirements.md`
4. **CHECKPOINT:** User must approve before planning

**Rule file:** `.aidlc/rules/phase-02-requirements.md`

### Phase 3: PLAN — Design Before Coding

**Goal:** Create a detailed execution plan before writing code.

1. Break requirements into concrete implementation steps
2. Identify files to create/modify/delete
3. Handle edge cases, error states, data migration
4. Write plan to `.aidlc/docs/execution-plan.md`
5. **CHECKPOINT:** User must approve before implementation

**Rule file:** `.aidlc/rules/phase-03-plan.md`

### Phase 4: IMPLEMENT — Code with Discipline

**Goal:** Execute the plan step by step.

1. Implement one step at a time
2. Follow existing code patterns (brownfield)
3. Mark completed steps in execution plan
4. **CHECKPOINT:** User reviews before verification

**Rule file:** `.aidlc/rules/phase-04-implement.md`

### Phase 5: VERIFY — Test What You Built

**Goal:** Confirm the implementation actually works.

1. Run existing tests for regressions
2. Run the app and verify manually
3. Write new tests if planned
4. Fix issues found
5. **CHECKPOINT:** All tests pass before audit

**Rule file:** `.aidlc/rules/phase-05-verify.md`

### Phase 6: AUDIT — Document Decisions

**Goal:** Record what was done and why.

1. Log decisions and rationale to `.aidlc/audit.md`
2. Update `.aidlc/state.md` with final status
3. Summarize: what was built, what changed, decisions made
4. **CHECKPOINT:** User closes out the task

**Rule file:** `.aidlc/rules/phase-06-audit.md`

## Phase File Loading

Load only the current phase's rule file to save 60-80% tokens. When transitioning phases, read the next phase's rule file. The orchestrator (this file) stays loaded.

## State Tracking

All state is in `.aidlc/state.md`:
```yaml
project: <name>
phase: <current-phase>
task: <task-name>
started: <timestamp>
last_updated: <timestamp>
```

## Human-in-the-Loop Checkpoints

At every checkpoint, present findings clearly. The user can:
- **Approve** → proceed to next phase
- **Revise** → redo current phase with feedback
- **Skip** → jump to a different phase
- **Rollback** → go back to a previous phase
- **Stop** → save state and exit

## Audit Trail

Every significant decision is logged to `.aidlc/audit.md` with:
- **What** was decided
- **Why** that choice was made
- **Alternatives** considered
- **Timestamp** and **phase**

## Rollback Protocol

If a later phase reveals a problem with an earlier phase:
1. User says "rollback to <phase>" or uses `aidlc phase rollback N`
2. Current progress is saved to `.aidlc/history/<timestamp>-snapshot.md`
3. State is updated to the target phase
4. The phase rule is re-loaded
5. Previous decisions are re-evaluated with new context

## When to Skip the Full Workflow

For truly trivial tasks, the user can say "quick" or "direct":
- Single-line fixes (typo, CSS, rename)
- Answering questions without code changes
- Running a pre-specified command

If unsure, default to the full workflow.
MASTER

echo -e "  ${GREEN}✓${RESET} Master orchestration → $AIDLC_DIR/CLAUDE.md"

# --- Phase 5: Create IDE-specific config files ---

echo -e "\n${BOLD}Linking IDE configs...${RESET}"

# Map IDE id to config file and display name
ide_config() {
    case "$1" in
        claude)   echo "CLAUDE.md|Claude Code" ;;
        cursor)   echo ".cursorrules|Cursor" ;;
        windsurf) echo ".windsurfrules|Windsurf" ;;
        copilot)  echo ".github/copilot-instructions.md|GitHub Copilot" ;;
        *)        echo "|" ;;
    esac
}

ide_linked=0
for ide in $DETECTED_IDES; do
    config_info=$(ide_config "$ide")
    target_rel=$(echo "$config_info" | cut -d'|' -f1)
    ide_name=$(echo "$config_info" | cut -d'|' -f2)

    [ -z "$target_rel" ] && continue

    target_file="$TARGET/$target_rel"
    source_file="$AIDLC_DIR/CLAUDE.md"

    # Ensure parent dir exists (e.g., .github/)
    mkdir -p "$(dirname "$target_file")"

    if [ -f "$target_file" ] && [ ! -L "$target_file" ]; then
        echo -e "  ${YELLOW}⚠${RESET}  $target_rel exists (not overwritten)"
        echo -e "     → Add to $target_rel: This project uses AI-DLC. See $AIDLC_DIR/"
        continue
    fi

    # Try symlink first, fall back to copy
    if ln -sf "$source_file" "$target_file" 2>/dev/null; then
        echo -e "  ${GREEN}✓${RESET} $ide_name → $target_rel (symlink)"
    else
        cp "$TARGET/$source_file" "$target_file"
        echo -e "  ${GREEN}✓${RESET} $ide_name → $target_rel (copy)"
    fi
    ide_linked=$((ide_linked + 1))
done

# Also provide IDE-agnostic instructions file for manual setup
cat > "$TARGET/$AIDLC_DIR/IDE-SETUP.md" << 'IDEHELP'
# AI-DLC IDE Setup

This file helps you link AI-DLC to any AI coding IDE.

## Auto-detected & linked
The init script creates configs for detected IDEs automatically.

## Manual setup for other IDEs

| IDE | Config File | How to Link |
|-----|------------|-------------|
| Claude Code | `CLAUDE.md` | `ln -sf .aidlc/CLAUDE.md CLAUDE.md` |
| Cursor | `.cursorrules` | `ln -sf .aidlc/CLAUDE.md .cursorrules` |
| Windsurf | `.windsurfrules` | `ln -sf .aidlc/CLAUDE.md .windsurfrules` |
| GitHub Copilot | `.github/copilot-instructions.md` | `ln -sf ../.aidlc/CLAUDE.md .github/copilot-instructions.md` |
| Continue.dev | `.continuerc.json` | Add `"systemMessage": ".aidlc/CLAUDE.md"` |
| Aider | `.aider.conf.yml` | Add system prompt from `.aidlc/CLAUDE.md` |

## Verification
Run `aidlc status` to verify the setup is active.
IDEHELP

echo -e "  ${CYAN}ℹ${RESET}  IDE setup guide → $AIDLC_DIR/IDE-SETUP.md"

# --- Phase 6: Create state file ---

cat > "$TARGET/$AIDLC_DIR/state.md" << STATE
# AI-DLC State

project: $(basename "$TARGET")
phase: detect
started: $(date -u +%Y-%m-%dT%H:%M:%SZ)
last_updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
STATE
echo -e "  ${GREEN}✓${RESET} State file → $AIDLC_DIR/state.md"

# --- Phase 7: Initialize docs ---
touch "$TARGET/$AIDLC_DIR/docs/.gitkeep"
echo -e "  ${GREEN}✓${RESET} Docs directory → $AIDLC_DIR/docs/"

# --- Phase 8: .gitignore ---
GITIGNORE_ENTRIES=(
    "# AI-DLC working files"
    ".aidlc/state.md"
    ".aidlc/history/"
)
if [ -f "$TARGET/.gitignore" ]; then
    if ! grep -q ".aidlc/" "$TARGET/.gitignore" 2>/dev/null; then
        echo "" >> "$TARGET/.gitignore"
        for entry in "${GITIGNORE_ENTRIES[@]}"; do
            echo "$entry" >> "$TARGET/.gitignore"
        done
        echo -e "  ${GREEN}✓${RESET} Updated .gitignore"
    fi
else
    for entry in "${GITIGNORE_ENTRIES[@]}"; do
        echo "$entry" >> "$TARGET/.gitignore"
    done
    echo -e "  ${GREEN}✓${RESET} Created .gitignore"
fi

# --- Summary ---
echo ""
echo -e "${BOLD}${GREEN}AI-DLC v2.0 initialized!${RESET}\n"
echo -e "Project:     ${BOLD}$(basename "$TARGET")${RESET} (${PROJECT_TYPE})"
echo -e "Workspace:   ${BOLD}$AIDLC_DIR/${RESET}"
echo -e "IDE configs: ${BOLD}${DETECTED_IDES[*]}${RESET}"
echo ""
echo -e "${BOLD}Structure:${RESET}"
echo "  .aidlc/"
echo "  ├── CLAUDE.md           ← Master orchestration"
echo "  ├── state.md            ← Current phase"
echo "  ├── audit.md            ← Decision log"
echo "  ├── docs/               ← Requirements & plans"
echo "  ├── rules/              ← Phase-specific rules"
echo "  ├── templates/          ← Document templates"
echo "  └── history/            ← Rollback snapshots"
echo ""
echo -e "${BOLD}Quick start:${RESET}"
echo "  aidlc status             Check current phase"
echo "  aidlc phase plan         Jump to planning phase"
echo "  aidlc phase rollback 2   Go back to requirements"
echo ""
echo "Start coding — AI-DLC is active."
