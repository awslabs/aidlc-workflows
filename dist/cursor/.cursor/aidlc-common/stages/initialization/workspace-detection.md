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
  - classic
  - workshop
  - express
inputs: none (scans filesystem)
outputs: workspace classification (greenfield/brownfield), technology stack detection
---

# Workspace Detection

Runs deterministically inside `aidlc-utility init`. The detection rules in Step 3 below are the source of truth for the scanner's classification logic.

## Steps

### Step 1: Update State

1. Update `<record>/aidlc-state.md`: set `Current Stage` to `detecting workspace`
2. Mark workspace-detection as `[-]` in progress

### Step 2: Scan Workspace

The scanner checks top-level files plus known source directories (`src/`, `app/`, `lib/`, `pages/`, `components/`, `tests/`), excluding the harness directories (`.claude/`, `.kiro/`, `.codex/`, `.opencode/`, `.aidlc/`, `.cursor/`), `aidlc/`, `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `target/`, `vendor/`.

Nested-project fallback: when NO top-level signal fires (the layout that would otherwise classify greenfield), the scanner performs a deterministic recursive walk of arbitrarily-named container directories, capped at three levels below the workspace root. At every level it skips the excluded directories above, sample/documentation directories, known source-directory names, hidden dirs, symlinks, and non-directories, then re-applies the same signal set at each visited directory (including that directory's own known-source-dir recursion). Every brownfield hit within the cap has its languages/frameworks/build system merged into the result and its slash-joined relative path recorded as the nested root; the walker does not descend below a hit. This catches layouts such as `services/api/src/main.py` while avoiding duplicate file counts. The fallback never runs when the root already has a source signal.

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
- The harness directory (`.claude/`, `.kiro/`, `.codex/`, `.opencode/`, `.aidlc/`, or `.cursor/`) — AI-DLC framework files (skills, agents, hooks, tools, knowledge)
- `aidlc/` — AI-DLC workspace root (the space tree at `aidlc/spaces/<space>/...`)
- `node_modules/`, `.git/`

### Step 3: Detect Project Type

Classify based on the scanner's evidence:

Signals are evaluated at the root first; if none fires, the nested-project fallback re-evaluates the same signals in candidate container directories up to three levels below the root (see Step 2).

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

Does NOT make a project brownfield: README, .gitignore, LICENSE, editor configs, empty directories, CI/CD boilerplate without application code, the harness directory (`.claude/`, `.kiro/`, `.codex/`, `.opencode/`, `.aidlc/`, or `.cursor/`, AI-DLC framework), `aidlc/` directory (AI-DLC workspace artifacts).

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

When the creation output carries the uninitialized-submodules warning (the scanner
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

Imports: none.

A customised discovery report should import the relevant manifests here.

## Learn

Follow stage-protocol.md §13 by maintaining
`<record>/<phase>/<stage>/memory.md` under the four standard headings; the
memory file stays in the artefact directory and the stage file remains
immutable. This auto-proceeding bootstrap stage (`gate: false`) has no
approval gate, so skip surfacing and persisting learnings and the mandatory
"Anything to add for next time?" question; the gate-bound ritual begins with
the first post-initialization stage.
