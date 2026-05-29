# AI-DLC Starterkit

AI-Driven Development Life Cycle — a structured prompt-engineering framework that turns AI coding assistants into disciplined junior developers.

**Core principle: AI proposes, human decides.**

## Why AI-DLC?

Ad-hoc AI prompting leads to misunderstood requirements, wasted context, and inconsistent results. AI-DLC enforces:

- **Clarify before coding** — 2-7 clarification questions per task, never guess
- **Plan before implementing** — detailed execution plan, user-approved
- **Phase-gated checkpoints** — human approves at every stage
- **Audit trail** — every decision logged with rationale
- **60-80% token savings** — phase rules loaded on demand, not all at once

## Quick Start

### Option A: Use the init script

```bash
# Initialize AI-DLC in an existing project
./init.sh /path/to/your-project

# Or run from anywhere
export AIDLC_STARTERKIT=/path/to/ai-dlc-starterkit
./bin/aidlc init /path/to/your-project
```

### Option B: Install the CLI globally

```bash
# Add to PATH
export PATH="$PATH:/path/to/ai-dlc-starterkit/bin"

# Then use from any project
cd my-project
aidlc init       # Set up AI-DLC
aidlc status     # Check current phase
aidlc phase plan # Jump to a phase
aidlc docs       # List documents
```

## How It Works

### Phase Workflow

```
DETECT → REQUIREMENTS → PLAN → IMPLEMENT → VERIFY → AUDIT
```

| Phase | What Happens | Output |
|-------|-------------|--------|
| **DETECT** | Workspace detection (greenfield vs brownfield) | State assessment |
| **REQUIREMENTS** | Clarification questions, scope agreement | `requirements.md` |
| **PLAN** | Architecture design, step-by-step plan | `execution-plan.md` |
| **IMPLEMENT** | Execute plan, one step at a time | Code changes |
| **VERIFY** | Run tests, manual verification | Test report |
| **AUDIT** | Log decisions, update state | `audit.md` |

### Human-in-the-Loop

At every phase checkpoint, you can:
- **Approve** → proceed
- **Revise** → redo with feedback
- **Skip** → jump ahead
- **Stop** → save state and resume later

### For Trivial Tasks

Say "quick" or "direct" to bypass phases for:
- Single-line fixes (typo, CSS, rename)
- Answering questions without code changes
- Running a pre-specified command

## Project Structure

```
your-project/
├── CLAUDE.md                  # AI-DLC orchestration (always loaded)
├── .aidlc/
│   ├── state.md               # Current phase tracking
│   ├── rules/                 # Phase-specific rule files
│   │   ├── phase-01-detect.md
│   │   ├── phase-02-requirements.md
│   │   ├── phase-03-plan.md
│   │   ├── phase-04-implement.md
│   │   ├── phase-05-verify.md
│   │   └── phase-06-audit.md
│   └── templates/             # Document templates
│       ├── requirements-template.md
│       ├── execution-plan-template.md
│       ├── audit-template.md
│       └── state-template.md
├── requirements.md            # Current task requirements
├── execution-plan.md          # Current task plan
└── audit.md                   # Decision log
```

## Greenfield vs Brownfield

**Greenfield** (new projects): Full workflow from scratch. AI helps set up project structure and conventions.

**Brownfield** (existing code): Skips scaffolding. AI analyzes existing patterns, handles data migration, and maintains backwards compatibility.

## Customization

Edit `.aidlc/rules/` to customize phase behavior for your project's specific needs (e.g., add compliance rules for fintech, security rules for auth features).

## Requirements

- Claude Code (or any AI coding assistant that reads CLAUDE.md)
- Bash 4+ (for init script and CLI)

## Credits

Based on the AI-DLC methodology published by AWS as open source.
