---
slug: workspace-detection
phase: initialization
execution: ALWAYS
condition: Scans and classifies workspace — auto-proceeds (no approval gate)
lead_agent: orchestrator
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage:
  - workspace-scaffold
sensors: []
scopes:
  - enterprise
  - feature
  - mvp
  - poc
  - bugfix
  - refactor
  - infra
  - security-patch
  - workshop
inputs: none (scans filesystem)
outputs: workspace classification (greenfield/brownfield), technology stack detection
---

# Workspace Detection

Runs deterministically inside `aidlc-utility init`. The detection rules in Step 3 below are the source of truth for the scanner's classification logic.

MANDATORY: Follow stage-protocol.md for state tracking and audit logging.

## Steps

### Step 1: Update State

1. Update `<record>/aidlc-state.md`: set `Current Stage` to `detecting workspace`
2. Mark workspace-detection as `[-]` in progress

### Step 2: Scan Workspace

The scanner walks the project directory one level deep plus known source directories (`src/`, `app/`, `lib/`, `pages/`, `components/`, `tests/`), excluding the harness directories (`.claude/`, `.kiro/`, `.codex/`, `.opencode/`), `aidlc/`, `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `target/`, `vendor/`.

Nested-project fallback: when NO top-level signal fires (the layout that would otherwise classify greenfield), the scanner then descends one level into each arbitrarily-named top-level subdirectory (skipping the excluded directories above, hidden dirs, and symlinks) and re-applies the same signal set rooted at that subdirectory. If any subdirectory looks brownfield, the workspace is classified brownfield and that subdirectory's languages/frameworks/build system are merged into the result. This catches a project whose source lives one container down (e.g. `wordbook/`, `backend/`) instead of at the root. The fallback is depth-1 only and never runs when the root already has a source signal.

Scan signals:
- Directory structure (top-level and key subdirectories)
- Configuration files (package.json, pom.xml, build.gradle, Cargo.toml, pyproject.toml, etc.)
- Build system files (Makefile, Dockerfile, docker-compose, CI/CD configs)
- Package/dependency files (lock files, vendor directories)
- Source code directories and their languages
- Repo metadata (`.gitmodules` submodule declarations)
- Test infrastructure (test directories, test config files, coverage config)
- Documentation (README, docs/, wiki/)

**Exclude from analysis** (framework scaffolding, not application code):
- The harness directory (`.claude/`, `.kiro/`, `.codex/`, or `.opencode/`) — AI-DLC framework files (skills, agents, hooks, tools, knowledge)
- `aidlc/` — AI-DLC workspace root (the space tree at `aidlc/spaces/<space>/...`)
- `node_modules/`, `.git/`

### Step 3: Detect Project Type

Classify based on the scanner's evidence:

Signals are evaluated at the root first; if none fires, the nested-project fallback re-evaluates the same signals one level down (see Step 2).

**Brownfield** — ANY of these indicators present:
- Source code files exist (`.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.java`, `.go`, `.rs`, `.rb`, `.cs`, `.cpp`, `.c`, `.kt`, `.swift`, `.php`)
- Application framework configuration detected (next.config, vite.config, angular.json, etc.)
- Package manifest with application dependencies (package.json with non-dev deps, requirements.txt, Cargo.toml, go.mod, pom.xml, etc.)
- Application source directories exist (src/, app/, lib/, pages/, components/)
- A parseable `.gitmodules` at the workspace root with at least one submodule path entry (repo metadata declares code even when the submodule dirs are not yet initialized)

**Greenfield** — ALL of these must be true:
- No source code files in any recognized language
- No application framework configuration
- No package manifest, OR manifest with only scaffolding/dev tooling
- No application source directories

Does NOT make a project brownfield: README, .gitignore, LICENSE, editor configs, empty directories, CI/CD boilerplate without application code, the harness directory (`.claude/`, `.kiro/`, `.codex/`, or `.opencode/`, AI-DLC framework), `aidlc/` directory (AI-DLC workspace artifacts).

### Step 4: Verify Classification

The deterministic scanner applies the rules in Step 3 directly — no override path is needed in normal operation. If a user believes the classification is wrong (e.g. a `create-next-app` scaffold they intend to treat as greenfield), they can edit `<record>/aidlc-state.md` by hand or re-run with `/aidlc --init --force` after cleaning up.

### Step 5: Identify Technology Stack

From the scan results, identify:
- **Languages**: Primary and secondary languages detected
- **Frameworks**: Web frameworks, libraries, UI toolkits
- **Build Systems**: Build tools, task runners, package managers
- **Test Infrastructure**: Test frameworks, coverage tools, test runners

### Step 6: Update State and Audit

1. Mark workspace-detection as `[x]` completed in `<record>/aidlc-state.md`
2. Update Workspace State section with detected languages, frameworks, build system
3. Append WORKSPACE_SCANNED event to `<record>/audit/<host>-<clone>.md` with scan results and classification

### Step 6a: Relay the Submodule Warning (if present)

When the birth output carries the uninitialized-submodules warning (the scanner
found a `.gitmodules` whose submodule paths are empty/uninitialized), relay it to
the user verbatim and tell them to run `git submodule update --init --recursive`
before proceeding, since reverse-engineering needs the code on disk. Do NOT offer
to run the command yourself, and do NOT block auto-proceed - this is an advisory
relay only.

### Step 7: Auto-Proceed

This stage has NO approval gate — it auto-proceeds to the next stage (state-init).

## Sensors

This stage runs the workspace scanner inside `aidlc-utility init`. It
emits classification state, not agent-authored markdown — so the
frontmatter `sensors:` list is empty.

Forks that customise this stage to write a discovery report can import
`required-sections` and `upstream-coverage` via `sensors:`; the resolver
will populate `sensors_applicable` at the next compile.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → `.aidlc/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.aidlc/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.aidlc/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
