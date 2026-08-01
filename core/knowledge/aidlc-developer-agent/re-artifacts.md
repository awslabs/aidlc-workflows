# Reverse Engineering Artifact Templates

## Output Structure

All RE artifacts are created under `aidlc/spaces/<active-space>/codekb/<repo>/` — the durable per-repo code knowledge base shared across intents (the space-level directory the `codekb-path --repo <repo>` tool resolves).

### Required Artifacts

1. **business-overview.md** — Business domain context, purpose, key functionality
2. **architecture.md** — System architecture, patterns, component relationships, Mermaid diagrams
3. **code-structure.md** — Package/module organization, file classification, code patterns
4. **api-documentation.md** — External and internal API surfaces, endpoints, contracts
5. **component-inventory.md** — Complete component list with responsibilities and dependencies
6. **technology-stack.md** — Languages, frameworks, libraries with versions
7. **dependencies.md** — External dependencies, internal cross-package dependencies
8. **code-quality-assessment.md** — Test coverage, linting, CI/CD, documentation quality, tech debt
9. **reverse-engineering-timestamp.md** - Records when reverse engineering was performed (date, commit hash if available) plus the structured Scope of Analysis block (template below). The scope block is machine-read by `codekb-scope-diff` on the next rerun, so its accuracy decides whether a future intent is warned before overwriting this run's knowledge.

### Developer Code Scan Template

```markdown
## Developer Code Scan Results

### Scan Coverage
- **Analyzed deeply**: [repo-relative dirs/files actually read and understood, one per line]
- **Skimmed only**: [areas noted at directory granularity without deep reading]

### Packages Found
- [package name] — [type] — [language] — [purpose]

### Build System
- **Type**: [build system]
- **Config Files**: [list]
- **Build Dependencies**: [package → package relationships]

### APIs Discovered
- [API type] — [location] — [endpoints/methods count]

### Frameworks & Libraries
- [name] — [version] — [purpose]

### Test Coverage
- **Test Directories**: [list]
- **Test Frameworks**: [list]
- **Coverage Config**: [present/absent]

### Code Quality Indicators
- **Linting**: [tool and config location]
- **CI/CD**: [pipeline files found]
- **Documentation**: [README presence, doc comments quality]

### Technical Debt Signals
- [signal description and location]
```

### Architecture Synthesis Template

```markdown
## Architecture Analysis

### System Overview
[High-level description of the system]

### Architectural Style
[Monolithic / Microservices / Serverless / Hybrid — with evidence]

### Component Relationships
[Mermaid diagram showing component interactions]

### Data Flow
[How data moves through the system]

### Key Design Decisions
[Notable architectural choices and their implications]

### Improvement Opportunities
[Areas where the architecture could be strengthened]
```

### Scope of Analysis Block (reverse-engineering-timestamp.md)

End reverse-engineering-timestamp.md with exactly this fenced block, filled
honestly from the Scan Coverage the developer reported - record what the run
ACTUALLY covered deeply, not what the stage aspired to cover:

````markdown
## Scope of Analysis

```yaml
scope_version: 1
kind: partial
intent: [active intent slug]
fingerprint: [output of the mint command in stage Step 3 - verbatim; it prints "unknown" when not computable]
analyzed:
  paths:
    - [repo-relative dir (trailing slash) or file analyzed deeply, one per line]
  components:
    - [component names exactly as they appear in component-inventory.md]
shallow:
  paths:
    - [areas only skimmed]
```
````

Rules:
- `kind: full` only when the scan genuinely covered the whole repo deeply; `analyzed.paths` MUST include the repo root (`./`). Anything less is `kind: partial`.
- `analyzed.paths` entries are repo-relative, directories end with `/`, no glob characters.
- Component names must match `component-inventory.md` headings verbatim - the rerun guard compares them literally.
